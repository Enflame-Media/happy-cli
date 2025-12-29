import { logger } from '@/ui/logger'
import { AppError, ErrorCodes } from '@/utils/errors'
import { EventEmitter } from 'node:events'
import { HappyWebSocket } from './HappyWebSocket'
import { AgentState, EphemeralUpdate, MessageContent, Metadata, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { calculateCost } from './pricing'
import { decodeBase64, decrypt, encodeBase64, encrypt, JsonSerializable } from './encryption';
import { backoff } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { SocketDisconnectedError } from './socketUtils';
import { extractErrorType, SyncMetrics, SyncMetricsCollector, SyncOutcome } from './syncMetrics';
import type { MetadataUpdateResponse, StateUpdateResponse } from './socketUtils';
import { ContextNotificationService, type UsageData } from './contextNotifications';

/**
 * Event types emitted by ApiSessionClient
 */
export interface ApiSessionClientEvents {
    /** Emitted when state is reconciled after reconnection */
    stateReconciled: (details: { source: 'server' | 'local', agentStateUpdated: boolean, metadataUpdated: boolean }) => void;
    /** Emitted when a message is received */
    message: (data: unknown) => void;
    /**
     * Emitted after each sync operation completes with current metrics snapshot.
     * Use this for external telemetry collection or monitoring.
     * @see HAP-166 for metrics details
     */
    syncMetrics: (metrics: SyncMetrics) => void;
    /**
     * Emitted when a session is deleted remotely (e.g., archived from mobile app)
     * @see HAP-352 for type schema alignment
     */
    sessionDeleted: (sessionId: string) => void;
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
    private socket: HappyWebSocket;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    /** Tracks if we've connected before to detect reconnections */
    private hasConnectedBefore = false;
    /** Tracks if we've shown a disconnection warning to avoid spam */
    private hasShownDisconnectWarning = false;
    /** Collects telemetry metrics for sync operations @see HAP-166 */
    private readonly syncMetricsCollector = new SyncMetricsCollector();
    /** Optional context notification service for push notifications on high context usage @see HAP-343 */
    private contextNotificationService: ContextNotificationService | null = null;

    /**
     * Socket event handlers - stored as class properties to prevent GC (HAP-363)
     * WeakRef-based HappyWebSocket requires handlers to be retained by the caller.
     */
    private readonly onSocketConnect: () => void;
    private readonly onSocketDisconnect: (reason: string) => void;
    private readonly onSocketConnectError: (error: unknown) => void;
    private readonly onSocketUpdate: (data: Update) => Promise<void>;
    private readonly onSocketEphemeral: (data: EphemeralUpdate) => void;
    private readonly onSocketError: (error: { message: string }) => void;

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
        registerCommonHandlers(this.rpcHandlerManager, this.metadata?.path ?? process.cwd());

        //
        // Create WebSocket with optimized connection options
        //
        // WebSocket Configuration Rationale:
        // - Native WebSocket transport: Compatible with Cloudflare Workers Durable Objects.
        // - Aggressive reconnection: Sessions are long-lived and must survive network hiccups.
        // - Randomization factor: Prevents "thundering herd" when many clients reconnect
        //   simultaneously after server restart.
        // - Extended max delay: For mobile/unstable networks, prevents battery drain from
        //   aggressive reconnection attempts.
        //
        // @see HAP-261 - Migrated from Socket.io to native WebSocket
        //

        this.socket = new HappyWebSocket(
            configuration.serverUrl,
            {
                token: this.token,
                clientType: 'session-scoped',
                sessionId: this.sessionId
            },
            {
                // Reconnection settings - tuned for long-lived session connections
                reconnectionDelay: 1000,         // Start with 1 second delay
                reconnectionDelayMax: 30000,     // Cap at 30 seconds for poor networks
                randomizationFactor: 0.5,        // Add jitter (0.5-1.5x) to prevent thundering herd
                maxReconnectionAttempts: Infinity,  // Never give up - sessions are critical
                timeout: 20000,                  // 20 seconds - generous for slow networks
                ackTimeout: 5000                 // 5 second ack timeout
            }
        );

        //
        // Handlers - stored as class properties to prevent GC (HAP-363)
        //

        this.onSocketConnect = () => {
            logger.debug('Socket connected successfully');
            this.rpcHandlerManager.onWebSocketConnect(this.socket);

            // On reconnection, request state sync to reconcile any changes that occurred during disconnection
            if (this.hasConnectedBefore) {
                // Record reconnection for metrics before triggering sync
                this.syncMetricsCollector.recordReconnect();

                logger.debug('[API] Reconnected - requesting state reconciliation');
                // Notify user of successful reconnection (only if we had warned about disconnect)
                if (this.hasShownDisconnectWarning) {
                    logger.info('[Happy] Reconnected to server');
                    this.hasShownDisconnectWarning = false;
                }
                this.requestStateSync(true).catch((error) => {
                    logger.debug('[API] State reconciliation failed:', error);
                });
            }
            this.hasConnectedBefore = true;
        };
        this.socket.on('connect', this.onSocketConnect);

        // Set up global RPC request handler
        this.socket.onRpcRequest(async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.onSocketDisconnect = (reason) => {
            logger.debug('[API] Socket disconnected:', reason);
            this.rpcHandlerManager.onWebSocketDisconnect();
            // Record disconnection for metrics
            this.syncMetricsCollector.recordDisconnect();
            // Notify user of disconnection (only once, avoid spam during reconnection attempts)
            if (!this.hasShownDisconnectWarning && this.hasConnectedBefore) {
                logger.warn('[Happy] Disconnected from server, reconnecting...');
                this.hasShownDisconnectWarning = true;
            }
        };
        this.socket.on('disconnect', this.onSocketDisconnect);

        this.onSocketConnectError = (error) => {
            logger.debug('[API] Socket connection error:', error);
            this.rpcHandlerManager.onWebSocketDisconnect();
        };
        this.socket.on('connect_error', this.onSocketConnectError);

        // Server events
        // Note: async callback is intentional - we need async to properly serialize state updates with locks
        this.onSocketUpdate = async (data: Update) => {
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message' && data.body.message.content.t === 'encrypted') {
                    const body = decrypt<MessageContent>(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));

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
                                // Null value means metadata was cleared - this shouldn't happen for sessions but handle gracefully
                                if (!data.body.metadata.value) {
                                    logger.debug('[SOCKET] [UPDATE] Received null metadata value - skipping update');
                                    return;
                                }
                                const decryptedMetadata = decrypt<Metadata>(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
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
                                    const decryptedAgentState = decrypt<AgentState>(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value));
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
                } else if (data.body.t === 'delete-session') {
                    // Session deleted remotely (e.g., archived from mobile app)
                    logger.debug(`[SOCKET] Session ${data.body.sid} deleted remotely`);
                    this.emit('sessionDeleted', data.body.sid);
                } else if (data.body.t === 'new-artifact' || data.body.t === 'update-artifact' || data.body.t === 'delete-artifact') {
                    // Artifact events - CLI doesn't manage artifacts, log and ignore
                    logger.debug(`[SOCKET] Received artifact event ${data.body.t} - ignoring (CLI doesn't manage artifacts)`);
                } else if (data.body.t === 'relationship-updated' || data.body.t === 'new-feed-post') {
                    // Social/feed events - CLI doesn't use social features, silently ignore
                    logger.debug(`[SOCKET] Received social event ${data.body.t} - ignoring (CLI doesn't use social features)`);
                } else if (data.body.t === 'kv-batch-update') {
                    // KV batch updates - settings sync from mobile (HAP-411)
                    // Process each change and apply CLI-relevant settings
                    this.handleKvBatchUpdate(data.body.changes);
                } else {
                    // Unknown event type - log for debugging but don't crash
                    logger.debug(`[SOCKET] Received unknown update type: ${(data.body as { t: string }).t}`);
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
            }
        };
        this.socket.onServer('update', this.onSocketUpdate);

        // Ephemeral events - real-time status updates from server (HAP-357)
        this.onSocketEphemeral = (data: EphemeralUpdate) => {
            switch (data.type) {
                case 'activity':
                    // Session activity update - currently handled elsewhere via keep-alive
                    logger.debug(`[EPHEMERAL] Activity: session ${data.sid} active=${data.active} thinking=${data.thinking}`);
                    break;
                case 'usage':
                    // Real-time usage/cost update from server
                    logger.debug(`[EPHEMERAL] Usage: session ${data.sid} cost=$${data.cost.total.toFixed(4)} tokens=${data.tokens.total}`);
                    break;
                case 'machine-activity':
                    // Machine/daemon activity update - track other daemons coming online/offline
                    logger.debug(`[EPHEMERAL] Machine activity: ${data.machineId} active=${data.active}`);
                    break;
                default:
                    // Unknown ephemeral type - log but don't crash (forward compatibility)
                    logger.debug(`[EPHEMERAL] Unknown type: ${(data as { type: string }).type}`);
            }
        };
        this.socket.onServer('ephemeral', this.onSocketEphemeral);

        // DEATH
        this.onSocketError = (error: { message: string }) => {
            logger.debug('[API] Socket error:', error);
        };
        this.socket.onServer('error', this.onSocketError);

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
        if (!this.socket.connected) {
            logger.debug('[SOCKET] Cannot send message - not connected');
            throw new SocketDisconnectedError('send Claude session message');
        }

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
        this.socket.emitClient('message', {
            sid: this.sessionId,
            message: encrypted
        });

        // Track usage from assistant messages
        // Note: message is optional to support synthetic/error formats
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                // Extract model from message if available (model is passed through by zod's .passthrough())
                const model = (body.message as Record<string, unknown>).model as string | undefined;
                this.sendUsageData(body.message.usage, model);
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

    /**
     * Send Codex message to session
     * @param body - Codex message content (JSON-serializable)
     */
    sendCodexMessage(body: JsonSerializable) {
        if (!this.socket.connected) {
            logger.debug('[SOCKET] Cannot send Codex message - not connected');
            throw new SocketDisconnectedError('send Codex message');
        }

        const content = {
            role: 'agent' as const,
            content: {
                type: 'codex' as const,
                data: body  // This wraps the entire Codex message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emitClient('message', {
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
        if (!this.socket.connected) {
            logger.debug('[SOCKET] Cannot send session event - not connected');
            throw new SocketDisconnectedError('send session event');
        }

        const content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emitClient('message', {
            sid: this.sessionId,
            message: encrypted
        });
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (!this.socket.connected) {
            logger.debug('[API] Skipping keep alive - not connected');
            return;
        }

        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.emitClientVolatile('session-alive', {
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
        if (!this.socket.connected) {
            logger.warn('[SOCKET] Cannot send session death - not connected (best-effort notification skipped)');
            return;
        }

        this.socket.emitClient('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model: string | undefined) {
        if (!this.socket.connected) {
            logger.debug('[SOCKET] Skipping usage data - not connected');
            return;
        }

        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        // Calculate actual costs based on model pricing
        const costs = calculateCost(usage, model);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            model: model || 'unknown',
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output,
                cache_creation: costs.cacheCreation,
                cache_read: costs.cacheRead
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emitClient('usage-report', usageReport);

        // Check for context threshold crossing and send push notification if needed
        if (this.contextNotificationService) {
            // Fire and forget - don't block on notification sending
            this.contextNotificationService.checkUsageAndNotify(usage as UsageData).catch(error => {
                logger.debug('[SOCKET] Context notification check failed:', error);
            });
        }
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata): Promise<void> {
        return this.metadataLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.metadata!); // Weird state if metadata is null - should never happen but here we are
                const answer = await this.socket.emitClientWithAck<'update-metadata', MetadataUpdateResponse>('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) });
                if (answer.result === 'success') {
                    const decryptedMetadata = decrypt<Metadata>(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    if (decryptedMetadata === null) {
                        logger.debug('[API] [UPDATE-METADATA] [ERROR] Failed to decrypt metadata response - keeping local state');
                    } else {
                        this.metadata = decryptedMetadata;
                        this.metadataVersion = answer.version;
                    }
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        const decryptedMetadata = decrypt<Metadata>(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                        if (decryptedMetadata === null) {
                            logger.debug('[API] [UPDATE-METADATA] [ERROR] Failed to decrypt metadata on version-mismatch - keeping local state');
                        } else {
                            this.metadataVersion = answer.version;
                            this.metadata = decryptedMetadata;
                        }
                    }
                    throw new AppError(ErrorCodes.VERSION_MISMATCH, 'Metadata version mismatch');
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
                const answer = await this.socket.emitClientWithAck<'update-state', StateUpdateResponse>('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null });
                if (answer.result === 'success') {
                    if (answer.agentState) {
                        const decryptedState = decrypt<AgentState>(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState));
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
                            const decryptedState = decrypt<AgentState>(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState));
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
                    throw new AppError(ErrorCodes.VERSION_MISMATCH, 'Agent state version mismatch');
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
            // With native WebSocket, we just resolve after a small delay
            // since there's no explicit buffer tracking like Socket.io
            setTimeout(() => {
                resolve();
            }, 100);
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
     * @param isReconnectionSync Whether this sync was triggered by a reconnection event (for metrics)
     * @emits stateReconciled - When state changes are applied from server
     * @emits syncMetrics - After sync completes with current metrics snapshot
     * @throws Never throws - all errors are logged and handled internally
     */
    async requestStateSync(isReconnectionSync = false): Promise<void> {
        // Start metrics tracking
        this.syncMetricsCollector.recordSyncStart(isReconnectionSync);

        // Track outcomes for metrics
        let syncOutcome: SyncOutcome = 'success';
        let agentStateMismatch = false;
        let metadataMismatch = false;
        let errorType: string | undefined;

        if (!this.socket.connected) {
            logger.debug('[API] Cannot sync state - socket not connected');
            syncOutcome = 'aborted';
            this.syncMetricsCollector.recordSyncComplete(syncOutcome, agentStateMismatch, metadataMismatch, 'socket-not-connected');
            this.emitSyncMetrics();
            return;
        }

        logger.debug('[API] Requesting state sync', {
            localAgentStateVersion: this.agentStateVersion,
            localMetadataVersion: this.metadataVersion,
            isReconnectionSync
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

                const answer = await this.socket.emitClientWithAck<'update-state', StateUpdateResponse>('update-state', {
                    sid: this.sessionId,
                    expectedVersion: this.agentStateVersion,
                    agentState: encryptedState
                });

                if (answer.result === 'version-mismatch') {
                    // Track version mismatch for metrics
                    agentStateMismatch = true;
                    // Server has newer state - apply it
                    if (answer.version > this.agentStateVersion) {
                        const previousVersion = this.agentStateVersion;
                        if (answer.agentState) {
                            const decryptedState = decrypt<AgentState>(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState));
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
                    syncOutcome = 'error';
                    errorType = 'agent-state-server-error';
                }
            });
        } catch (error) {
            logger.debug('[API] Failed to sync agent state:', error);
            syncOutcome = 'error';
            errorType = extractErrorType(error, 'agent-state-sync-error');
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

                const answer = await this.socket.emitClientWithAck<'update-metadata', MetadataUpdateResponse>('update-metadata', {
                    sid: this.sessionId,
                    expectedVersion: this.metadataVersion,
                    metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, currentMetadata))
                });

                if (answer.result === 'version-mismatch') {
                    // Track version mismatch for metrics
                    metadataMismatch = true;
                    // Server has newer metadata - apply it
                    if (answer.version > this.metadataVersion) {
                        const previousVersion = this.metadataVersion;
                        const decryptedMetadata = decrypt<Metadata>(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
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
                    syncOutcome = 'error';
                    errorType = 'metadata-server-error';
                }
            });
        } catch (error) {
            logger.debug('[API] Failed to sync metadata:', error);
            syncOutcome = 'error';
            errorType = extractErrorType(error, 'metadata-sync-error');
        }

        // Determine final sync outcome based on version mismatches
        if (syncOutcome === 'success' && (agentStateMismatch || metadataMismatch)) {
            syncOutcome = 'version-mismatch';
        }

        // Record sync completion for metrics
        this.syncMetricsCollector.recordSyncComplete(syncOutcome, agentStateMismatch, metadataMismatch, errorType);

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

        // Emit metrics after sync completion
        this.emitSyncMetrics();
    }

    /**
     * Emit current sync metrics snapshot.
     * Only emits if there are listeners to avoid unnecessary computation.
     * @private
     */
    private emitSyncMetrics(): void {
        // Only compute and emit metrics if there are listeners (zero-cost when not consumed)
        if (this.listenerCount('syncMetrics') > 0) {
            const metrics = this.syncMetricsCollector.getMetrics();
            this.emit('syncMetrics', metrics);
            logger.debug('[API] Sync metrics emitted', {
                totalSyncs: metrics.totalSyncs,
                syncSuccesses: metrics.syncSuccesses,
                syncFailures: metrics.syncFailures,
                averageSyncDurationMs: metrics.averageSyncDurationMs
            });
        }
    }

    /**
     * Get current sync metrics snapshot.
     * Use this for external telemetry collection or monitoring.
     * @see HAP-166
     */
    getSyncMetrics(): SyncMetrics {
        return this.syncMetricsCollector.getMetrics();
    }

    /**
     * Reset sync metrics to initial state.
     * Useful for testing or when starting a new logical session.
     */
    resetSyncMetrics(): void {
        this.syncMetricsCollector.reset();
    }

    /**
     * Set the context notification service for push notifications on high context usage.
     * When set, push notifications will be sent when context usage crosses 80% or 95% thresholds.
     *
     * @param service - The context notification service, or null to disable
     * @see HAP-343
     */
    /**
     * Set the context notification service for push notifications on high context usage.
     * When set, push notifications will be sent when context usage crosses 80% or 95% thresholds.
     * Also registers an RPC handler to allow mobile app to control notification settings.
     *
     * @param service - The context notification service, or null to disable
     * @see HAP-343
     * @see HAP-358 - Added RPC handler for respecting user's notification settings
     */
    setContextNotificationService(service: ContextNotificationService | null): void {
        this.contextNotificationService = service;
        if (service) {
            logger.debug('[API] Context notification service enabled');

            // Register RPC handler for mobile app to control notification settings
            // This allows the user's contextNotificationsEnabled setting to be respected
            this.rpcHandlerManager.registerHandler<{ enabled: boolean }, { ok: boolean }>(
                'setContextNotificationsEnabled',
                async (data, _signal) => {
                    logger.debug('[API] setContextNotificationsEnabled RPC received:', data);
                    if (this.contextNotificationService) {
                        this.contextNotificationService.setEnabled(data.enabled);
                        return { ok: true };
                    }
                    return { ok: false };
                }
            );
        }
    }

    /**
     * Handle KV batch updates from mobile settings sync.
     *
     * The KV store contains user settings that may affect CLI behavior.
     * Currently CLI-relevant settings:
     * - contextNotificationsEnabled: Controls push notifications for context usage (80%, 95% thresholds)
     *
     * Other mobile settings (viewInline, expandTodos, showLineNumbers, etc.) are UI-specific
     * and are explicitly ignored by the CLI.
     *
     * @param changes - Array of key-value changes from kv-batch-update event
     * @see HAP-411 for implementation details
     */
    private handleKvBatchUpdate(changes: Array<{ key: string; value: string | null; version: number }>): void {
        // Define CLI-relevant settings
        const CLI_RELEVANT_SETTINGS = new Set(['contextNotificationsEnabled']);

        for (const change of changes) {
            try {
                if (CLI_RELEVANT_SETTINGS.has(change.key)) {
                    // Handle CLI-relevant settings
                    this.applyKvSetting(change.key, change.value);
                    logger.debug(`[KV-SYNC] Applied setting: ${change.key} = ${change.value} (v${change.version})`);
                } else {
                    // Log but ignore UI-specific settings
                    logger.debug(`[KV-SYNC] Ignored non-CLI setting: ${change.key} (v${change.version})`);
                }
            } catch (error) {
                // Defensive: Log but don't crash on malformed payloads
                logger.debug(`[KV-SYNC] Error processing setting ${change.key}:`, error);
            }
        }
    }

    /**
     * Apply a single KV setting to the CLI.
     *
     * @param key - Setting key
     * @param value - Setting value (JSON string or null for deletion)
     */
    private applyKvSetting(key: string, value: string | null): void {
        switch (key) {
            case 'contextNotificationsEnabled': {
                // Parse boolean value (JSON encoded)
                if (value === null) {
                    // Key deleted - reset to default (enabled)
                    if (this.contextNotificationService) {
                        this.contextNotificationService.setEnabled(true);
                    }
                } else {
                    // Parse JSON boolean value
                    try {
                        const enabled = JSON.parse(value);
                        if (typeof enabled === 'boolean' && this.contextNotificationService) {
                            this.contextNotificationService.setEnabled(enabled);
                        }
                    } catch {
                        logger.debug(`[KV-SYNC] Invalid JSON value for ${key}: ${value}`);
                    }
                }
                break;
            }
            // Add future CLI-relevant settings here
            default:
                // This shouldn't happen as we filter in handleKvBatchUpdate, but defensive
                logger.debug(`[KV-SYNC] Unknown CLI setting: ${key}`);
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
