import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, MessageContent, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';

/**
 * Event types emitted by ApiSessionClient
 */
export interface ApiSessionClientEvents {
    /** Emitted when state is reconciled after reconnection */
    stateReconciled: (details: { source: 'server' | 'local', agentStateUpdated: boolean, metadataUpdated: boolean }) => void;
    /** Emitted when a message is received */
    message: (data: unknown) => void;
}

/**
 * Typed EventEmitter for ApiSessionClient
 * Provides type-safe event emission and handling
 */
interface TypedEventEmitter {
    on<K extends keyof ApiSessionClientEvents>(event: K, listener: ApiSessionClientEvents[K]): this;
    emit<K extends keyof ApiSessionClientEvents>(event: K, ...args: Parameters<ApiSessionClientEvents[K]>): boolean;
    removeAllListeners(event?: keyof ApiSessionClientEvents): this;
}

export class ApiSessionClient extends EventEmitter implements TypedEventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    /** Tracks if we've connected before to detect reconnections */
    private hasConnectedBefore = false;

    constructor(token: string, session: Session) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });
        registerCommonHandlers(this.rpcHandlerManager);

        //
        // Create socket with optimized connection options
        //
        // Socket.IO Configuration Rationale:
        // - WebSocket-only transport: Preferred for real-time bidirectional session sync.
        //   Polling fallback would introduce latency that breaks the real-time experience.
        // - Aggressive reconnection: Sessions are long-lived and must survive network hiccups.
        // - Randomization factor: Prevents "thundering herd" when many clients reconnect
        //   simultaneously after server restart.
        // - Extended max delay: For mobile/unstable networks, prevents battery drain from
        //   aggressive reconnection attempts.
        // - Binary transport (msgpack): Not implemented - would require server-side changes
        //   and cross-project dependency coordination. Current JSON transport is sufficient
        //   given that messages are already encrypted (binary overhead minimal).
        //

        this.socket = io(configuration.serverUrl, {
            // Authentication - passed on every connection/reconnection
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId
            },

            // Server endpoint path
            path: '/v1/updates',

            // Reconnection settings - tuned for long-lived session connections
            reconnection: true,              // Enable automatic reconnection
            reconnectionAttempts: Infinity,  // Never give up - sessions are critical
            reconnectionDelay: 1000,         // Start with 1 second delay
            reconnectionDelayMax: 30000,     // Cap at 30 seconds for poor networks
            randomizationFactor: 0.5,        // Add jitter (0.5-1.5x) to prevent thundering herd

            // Connection timeout - time to wait for initial connection
            timeout: 20000,                  // 20 seconds - generous for slow networks

            // Transport options - WebSocket only for real-time performance
            transports: ['websocket'],       // No polling fallback - latency unacceptable

            // Credentials for cross-origin requests
            withCredentials: true,

            // Manual connection control - we connect after setting up handlers
            autoConnect: false
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            this.rpcHandlerManager.onSocketConnect(this.socket);

            // On reconnection, request state sync to reconcile any changes that occurred during disconnection
            if (this.hasConnectedBefore) {
                logger.debug('[API] Reconnected - requesting state reconciliation');
                this.requestStateSync().catch((error) => {
                    logger.debug('[API] State reconciliation failed:', error);
                });
            }
            this.hasConnectedBefore = true;
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason);
            this.rpcHandlerManager.onSocketDisconnect();
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error);
            this.rpcHandlerManager.onSocketDisconnect();
        })

        // Server events
        // Note: async callback is intentional - Socket.IO ignores the returned Promise
        // but we need async to properly serialize state updates with locks
        this.socket.on('update', async (data: Update) => {
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message' && data.body.message.content.t === 'encrypted') {
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));

                    if (body === null) {
                        logger.debug('[SOCKET] [UPDATE] [ERROR] Failed to decrypt message - skipping');
                        return;
                    }

                    logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', body)

                    // Try to parse as user message first
                    const userResult = UserMessageSchema.safeParse(body);
                    if (userResult.success) {
                        // Server already filtered to only our session
                        if (this.pendingMessageCallback) {
                            this.pendingMessageCallback(userResult.data);
                        } else {
                            this.pendingMessages.push(userResult.data);
                        }
                    } else {
                        // If not a user message, it might be a permission response or other message type
                        this.emit('message', body);
                    }
                } else if (data.body.t === 'update-session') {
                    // Acquire locks to prevent race conditions with client-initiated updates
                    // Use double-check pattern: check version before AND inside lock
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        await this.metadataLock.inLock(async () => {
                            // Re-check version inside lock to avoid stale updates
                            if (data.body.t === 'update-session' && data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                                const decryptedMetadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                                if (decryptedMetadata === null) {
                                    logger.debug('[SOCKET] [UPDATE] [ERROR] Failed to decrypt metadata - skipping update');
                                    return;
                                }
                                this.metadata = decryptedMetadata;
                                this.metadataVersion = data.body.metadata.version;
                            }
                        });
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        await this.agentStateLock.inLock(async () => {
                            // Re-check version inside lock to avoid stale updates
                            if (data.body.t === 'update-session' && data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                                if (data.body.agentState.value) {
                                    const decryptedAgentState = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value));
                                    if (decryptedAgentState === null) {
                                        logger.debug('[SOCKET] [UPDATE] [ERROR] Failed to decrypt agent state - skipping update');
                                        return;
                                    }
                                    this.agentState = decryptedAgentState;
                                } else {
                                    this.agentState = null;
                                }
                                this.agentStateVersion = data.body.agentState.version;
                            }
                        });
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
            }
        });

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', error);
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        this.pendingMessageCallback = callback;
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!);
        }
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        let content: MessageContent;

        // Check if body is already a MessageContent (has role property)
        if (body.type === 'user' && typeof body.message.content === 'string' && body.isSidechain !== true && body.isMeta !== true) {
            content = {
                role: 'user',
                content: {
                    type: 'text',
                    text: body.message.content
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        } else {
            // Wrap Claude messages in the expected format
            content = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: body  // This wraps the entire Claude message
                },
                meta: {
                    sentFrom: 'cli'
                }
            };
        }

        logger.debugLargeJson('[SOCKET] Sending message through socket:', content)

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });

        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message.usage) {
            try {
                this.sendUsageData(body.message.usage);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    sendCodexMessage(body: any) {
        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body  // This wraps the entire Claude message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });
    }

    sendSessionEvent(event: {
        type: 'switch', mode: 'local' | 'remote'
    } | {
        type: 'message', message: string
    } | {
        type: 'permission-mode-changed', mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    } | {
        type: 'ready'
    }, id?: string) {
        let content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                // TODO: Calculate actual costs based on pricing
                // For now, using placeholder values
                total: 0,
                input: 0,
                output: 0
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata): Promise<void> {
        return this.metadataLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.metadata!); // Weird state if metadata is null - should never happen but here we are
                const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) });
                if (answer.result === 'success') {
                    const decryptedMetadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    if (decryptedMetadata === null) {
                        logger.debug('[API] [UPDATE-METADATA] [ERROR] Failed to decrypt metadata response - keeping local state');
                    } else {
                        this.metadata = decryptedMetadata;
                        this.metadataVersion = answer.version;
                    }
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        const decryptedMetadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                        if (decryptedMetadata === null) {
                            logger.debug('[API] [UPDATE-METADATA] [ERROR] Failed to decrypt metadata on version-mismatch - keeping local state');
                        } else {
                            this.metadataVersion = answer.version;
                            this.metadata = decryptedMetadata;
                        }
                    }
                    throw new Error('Metadata version mismatch');
                } else if (answer.result === 'error') {
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState): Promise<void> {
        logger.debugLargeJson('Updating agent state', this.agentState);
        return this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.agentState || {});
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null });
                if (answer.result === 'success') {
                    if (answer.agentState) {
                        const decryptedState = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState));
                        if (decryptedState === null) {
                            logger.debug('[API] [UPDATE-STATE] [ERROR] Failed to decrypt agent state response - keeping local state');
                        } else {
                            this.agentState = decryptedState;
                            this.agentStateVersion = answer.version;
                            logger.debug('Agent state updated', this.agentState);
                        }
                    } else {
                        this.agentState = null;
                        this.agentStateVersion = answer.version;
                        logger.debug('Agent state updated', this.agentState);
                    }
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        if (answer.agentState) {
                            const decryptedState = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState));
                            if (decryptedState === null) {
                                logger.debug('[API] [UPDATE-STATE] [ERROR] Failed to decrypt agent state on version-mismatch - keeping local state');
                            } else {
                                this.agentStateVersion = answer.version;
                                this.agentState = decryptedState;
                            }
                        } else {
                            this.agentStateVersion = answer.version;
                            this.agentState = null;
                        }
                    }
                    throw new Error('Agent state version mismatch');
                } else if (answer.result === 'error') {
                    // console.error('Agent state update error', answer);
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
    }

    /**
     * Request state synchronization with the server after reconnection.
     *
     * This method compares local state versions with server state and applies
     * any updates that occurred while the client was disconnected.
     *
     * Conflict resolution strategy: Last-write-wins based on version numbers.
     * The server is the source of truth - if server version is higher, we apply
     * the server's state. This ensures consistency across all clients.
     *
     * Edge cases handled:
     * - Socket disconnection during sync: Operations fail gracefully, sync retried on next reconnection
     * - Concurrent updates: Locks prevent race conditions with ongoing state updates
     * - Version rollback prevention: Only applies server state if version is strictly greater
     * - Partial sync failure: Each state type (agent/metadata) syncs independently
     *
     * @emits stateReconciled - When state changes are applied from server
     * @throws Never throws - all errors are logged and handled internally
     */
    async requestStateSync(): Promise<void> {
        if (!this.socket.connected) {
            logger.debug('[API] Cannot sync state - socket not connected');
            return;
        }

        logger.debug('[API] Requesting state sync', {
            localAgentStateVersion: this.agentStateVersion,
            localMetadataVersion: this.metadataVersion
        });

        let agentStateUpdated = false;
        let metadataUpdated = false;

        // Sync agent state by sending current state with current version
        // If version mismatch, server returns current state
        try {
            await this.agentStateLock.inLock(async () => {
                // Check connection again inside lock (could have disconnected while waiting)
                if (!this.socket.connected) {
                    logger.debug('[API] Socket disconnected during agent state sync - aborting');
                    return;
                }

                const currentState = this.agentState;
                const encryptedState = currentState
                    ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, currentState))
                    : null;

                const answer = await this.socket.emitWithAck('update-state', {
                    sid: this.sessionId,
                    expectedVersion: this.agentStateVersion,
                    agentState: encryptedState
                });

                if (answer.result === 'version-mismatch') {
                    // Server has newer state - apply it
                    if (answer.version > this.agentStateVersion) {
                        const previousVersion = this.agentStateVersion;
                        if (answer.agentState) {
                            const decryptedState = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState));
                            if (decryptedState === null) {
                                logger.debug('[API] [RECONCILE] [ERROR] Failed to decrypt agent state from server - skipping reconciliation');
                            } else {
                                this.agentStateVersion = answer.version;
                                this.agentState = decryptedState;
                                agentStateUpdated = true;
                                logger.debug('[API] Agent state reconciled from server', {
                                    previousVersion,
                                    newVersion: answer.version
                                });
                            }
                        } else {
                            this.agentStateVersion = answer.version;
                            this.agentState = null;
                            agentStateUpdated = true;
                            logger.debug('[API] Agent state reconciled from server (null)', {
                                previousVersion,
                                newVersion: answer.version
                            });
                        }
                    } else {
                        logger.debug('[API] Server version not newer, skipping agent state update', {
                            localVersion: this.agentStateVersion,
                            serverVersion: answer.version
                        });
                    }
                } else if (answer.result === 'success') {
                    // Local state matches server or was updated - sync version
                    this.agentStateVersion = answer.version;
                    logger.debug('[API] Agent state in sync with server', { version: answer.version });
                } else if (answer.result === 'error') {
                    logger.debug('[API] Server error during agent state sync');
                }
            });
        } catch (error) {
            logger.debug('[API] Failed to sync agent state:', error);
            // Continue to metadata sync even if agent state sync fails
        }

        // Sync metadata by sending current metadata with current version
        try {
            await this.metadataLock.inLock(async () => {
                // Check connection again inside lock (could have disconnected while waiting)
                if (!this.socket.connected) {
                    logger.debug('[API] Socket disconnected during metadata sync - aborting');
                    return;
                }

                const currentMetadata = this.metadata;
                if (!currentMetadata) {
                    logger.debug('[API] No metadata to sync');
                    return;
                }

                const answer = await this.socket.emitWithAck('update-metadata', {
                    sid: this.sessionId,
                    expectedVersion: this.metadataVersion,
                    metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, currentMetadata))
                });

                if (answer.result === 'version-mismatch') {
                    // Server has newer metadata - apply it
                    if (answer.version > this.metadataVersion) {
                        const previousVersion = this.metadataVersion;
                        const decryptedMetadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                        if (decryptedMetadata === null) {
                            logger.debug('[API] [RECONCILE] [ERROR] Failed to decrypt metadata from server - skipping reconciliation');
                        } else {
                            this.metadataVersion = answer.version;
                            this.metadata = decryptedMetadata;
                            metadataUpdated = true;
                            logger.debug('[API] Metadata reconciled from server', {
                                previousVersion,
                                newVersion: answer.version
                            });
                        }
                    } else {
                        logger.debug('[API] Server version not newer, skipping metadata update', {
                            localVersion: this.metadataVersion,
                            serverVersion: answer.version
                        });
                    }
                } else if (answer.result === 'success') {
                    // Local metadata matches server or was updated - sync version
                    this.metadataVersion = answer.version;
                    logger.debug('[API] Metadata in sync with server', { version: answer.version });
                } else if (answer.result === 'error') {
                    logger.debug('[API] Server error during metadata sync');
                }
            });
        } catch (error) {
            logger.debug('[API] Failed to sync metadata:', error);
        }

        // Emit event if any state was updated from server
        if (agentStateUpdated || metadataUpdated) {
            this.emit('stateReconciled', {
                source: 'server' as const,
                agentStateUpdated,
                metadataUpdated
            });
            logger.debug('[API] State reconciliation complete - changes applied', {
                agentStateUpdated,
                metadataUpdated
            });
        } else {
            logger.debug('[API] State reconciliation complete - no changes needed');
        }
    }

    async close() {
        logger.debug('[API] socket.close() called');

        // Cancel all pending RPC requests before closing
        this.rpcHandlerManager.cancelAllPendingRequests();

        // Remove all socket event listeners before closing to prevent memory leaks
        this.socket.removeAllListeners();

        // Close socket
        this.socket.close();

        // Clean up EventEmitter listeners (inherited from EventEmitter)
        this.removeAllListeners();

        // Clear pending messages
        this.pendingMessages = [];
        this.pendingMessageCallback = null;
    }
}
