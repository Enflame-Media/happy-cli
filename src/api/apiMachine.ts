/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 *
 * @see HAP-261 - Migrated from Socket.io to native WebSocket
 */

import { AppError, ErrorCodes } from '@/utils/errors';
import { getSessionIdFromEphemeral, getMachineIdFromEphemeral, type SessionIdEphemeral, type MachineIdEphemeral } from '@happy/protocol';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { EphemeralUpdate, MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { HappyWebSocket, WebSocketMetrics } from './HappyWebSocket';
import type { MetadataUpdateResponse, DaemonStateUpdateResponse } from './socketUtils';
import { buildMcpSyncState } from '@/mcp/config';

// Keep-alive timing configuration (prevents thundering herd on reconnection)
const KEEP_ALIVE_BASE_INTERVAL_MS = 20000; // 20 seconds base interval
const KEEP_ALIVE_JITTER_MAX_MS = 5000; // 0-5 seconds random jitter

import type { GetSessionStatusResponse } from '@/daemon/types';
import { isValidSessionId, normalizeSessionId } from '@/claude/utils/sessionValidation';

/**
 * RPC handlers provided by the daemon to the machine client
 */
type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    requestShutdown: () => void;
    /**
     * Get the status of a session by ID
     * @see HAP-642 - Added to allow mobile app to check session status before calling session-specific RPC methods
     */
    getSessionStatus: (sessionId: string) => GetSessionStatusResponse;
}

export class ApiMachineClient {
    private socket!: HappyWebSocket;
    private keepAliveInterval: NodeJS.Timeout | null = null;

    private isShuttingDown = false;
    private rpcHandlerManager: RpcHandlerManager;

    /**
     * Socket event handlers - stored as class properties to prevent GC (HAP-363)
     * WeakRef-based HappyWebSocket requires handlers to be retained by the caller.
     */
    private onSocketConnect!: () => void;
    private onSocketDisconnect!: () => void;
    private onSocketUpdate!: (data: Update) => void;
    private onSocketEphemeral!: (data: EphemeralUpdate) => void;
    private onSocketConnectError!: (error: unknown) => void;
    private onSocketError!: (error: { message: string }) => void;

    constructor(
        private token: string,
        private machine: Machine
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        registerCommonHandlers(this.rpcHandlerManager, process.cwd());
    }

    setRPCHandlers({
        spawnSession,
        stopSession,
        requestShutdown,
        getSessionStatus
    }: MachineRpcHandlers) {
        // Register spawn session handler
        type SpawnSessionParams = {
            directory?: string;
            sessionId?: string;
            machineId?: string;
            approvedNewDirectoryCreation?: boolean;
            agent?: 'claude' | 'codex';
            token?: string;
        };
        this.rpcHandlerManager.registerHandler<SpawnSessionParams, { type: string; sessionId?: string; resumedFrom?: string; message?: string; directory?: string }>('spawn-happy-session', async (params, _signal) => {
            const { directory, sessionId, machineId, approvedNewDirectoryCreation, agent, token } = params ?? {};
            logger.debug(`[API MACHINE] Spawning session with params: ${JSON.stringify(params)}`);

            if (!directory) {
                throw new AppError(ErrorCodes.DIRECTORY_REQUIRED, 'Directory is required');
            }

            const result = await spawnSession({ directory, sessionId, machineId, approvedNewDirectoryCreation, agent, token });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}${result.resumedFrom ? ` (resumed from ${result.resumedFrom})` : ''}${result.message ? ` (${result.message})` : ''}`);
                    // HAP-691: Include resumedFrom to allow app to link old and new sessions
                    return { type: 'success', sessionId: result.sessionId, resumedFrom: result.resumedFrom, message: result.message };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    throw new AppError(ErrorCodes.OPERATION_FAILED, result.errorMessage);
            }
        });

        // Register stop session handler
        type StopSessionParams = { sessionId?: string };
        this.rpcHandlerManager.registerHandler<StopSessionParams, { message: string }>('stop-session', (params, _signal) => {
            const { sessionId } = params ?? {};

            if (!sessionId) {
                throw new AppError(ErrorCodes.INVALID_INPUT, 'Session ID is required');
            }

            const success = stopSession(sessionId);
            if (!success) {
                throw new AppError(ErrorCodes.SESSION_NOT_FOUND, 'Session not found or failed to stop');
            }

            logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
            return { message: 'Session stopped' };
        });

        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', (_params, _signal) => {
            logger.debug('[API MACHINE] Received stop-daemon RPC request');

            // Trigger shutdown callback after a delay
            setTimeout(() => {
                logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);

            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });

        // Register get-session-status handler
        // HAP-642: Machine-level handler to check session status before calling session-specific RPC methods
        // This allows the mobile app to determine if a session is active, stopped, or unknown
        type GetSessionStatusParams = { sessionId?: string };
        this.rpcHandlerManager.registerHandler<GetSessionStatusParams, GetSessionStatusResponse>('get-session-status', (params, _signal) => {
            const { sessionId } = params ?? {};

            if (!sessionId) {
                throw new AppError(ErrorCodes.INVALID_INPUT, 'Session ID is required');
            }

            // Validate session ID format (accepts both UUID and hex)
            if (!isValidSessionId(sessionId)) {
                throw new AppError(ErrorCodes.INVALID_INPUT, `Invalid session ID format: expected UUID or hex (32 chars), got "${sessionId.substring(0, 50)}"`);
            }

            // Normalize to UUID format for consistent comparison
            const normalizedId = normalizeSessionId(sessionId);
            const result = getSessionStatus(normalizedId);

            logger.debug(`[API MACHINE] get-session-status: ${sessionId} -> ${result.status}`);
            return result;
        });
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata);

            const answer = await this.socket.emitWithAck<MetadataUpdateResponse>('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
            });

            if (answer.result === 'success') {
                const decryptedMetadata = decrypt<MachineMetadata>(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                if (decryptedMetadata === null) {
                    logger.debug('[API MACHINE] [ERROR] Failed to decrypt metadata response - keeping local state');
                } else {
                    this.machine.metadata = decryptedMetadata;
                    this.machine.metadataVersion = answer.version;
                    logger.debug('[API MACHINE] Metadata updated successfully');
                }
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    const decryptedMetadata = decrypt<MachineMetadata>(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                    if (decryptedMetadata === null) {
                        logger.debug('[API MACHINE] [ERROR] Failed to decrypt metadata on version-mismatch - keeping local state');
                    } else {
                        this.machine.metadataVersion = answer.version;
                        this.machine.metadata = decryptedMetadata;
                    }
                }
                throw new AppError(ErrorCodes.VERSION_MISMATCH, 'Metadata version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState);

            const answer = await this.socket.emitWithAck<DaemonStateUpdateResponse>('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });

            if (answer.result === 'success') {
                const decryptedState = decrypt<DaemonState>(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                if (decryptedState === null) {
                    logger.debug('[API MACHINE] [ERROR] Failed to decrypt daemon state response - keeping local state');
                } else {
                    this.machine.daemonState = decryptedState;
                    this.machine.daemonStateVersion = answer.version;
                    logger.debug('[API MACHINE] Daemon state updated successfully');
                }
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    const decryptedState = decrypt<DaemonState>(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                    if (decryptedState === null) {
                        logger.debug('[API MACHINE] [ERROR] Failed to decrypt daemon state on version-mismatch - keeping local state');
                    } else {
                        this.machine.daemonStateVersion = answer.version;
                        this.machine.daemonState = decryptedState;
                    }
                }
                throw new AppError(ErrorCodes.VERSION_MISMATCH, 'Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    connect() {
        logger.debug(`[API MACHINE] Connecting to ${configuration.serverUrl}`);

        //
        // Create WebSocket with optimized connection options
        //
        // @see HAP-261 - Migrated from Socket.io to native WebSocket
        //

        this.socket = new HappyWebSocket(
            configuration.serverUrl,
            {
                token: this.token,
                clientType: 'machine-scoped',
                machineId: this.machine.id
            },
            {
                // Reconnection settings
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000,
                randomizationFactor: 0.5, // Add randomization to prevent thundering herd
                maxReconnectionAttempts: Infinity,
                timeout: 20000,
                ackTimeout: 5000
            }
        );

        // Handlers - stored as class properties to prevent GC (HAP-363)
        this.onSocketConnect = () => {
            logger.debug('[API MACHINE] Connected to server');

            // Update daemon state to running
            // We need to override previous state because the daemon (this process)
            // has restarted with new PID & port
            // @see HAP-608 - Include MCP config in daemon state sync
            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now(),
                mcpConfig: buildMcpSyncState()
            }));


            // Register all handlers
            this.rpcHandlerManager.onWebSocketConnect(this.socket);

            // Start keep-alive
            this.startKeepAlive();
        };
        this.socket.on('connect', this.onSocketConnect);

        this.onSocketDisconnect = () => {
            logger.debug('[API MACHINE] Disconnected from server');
            this.rpcHandlerManager.onWebSocketDisconnect();
            this.stopKeepAlive();
        };
        this.socket.on('disconnect', this.onSocketDisconnect);

        // Single consolidated RPC handler
        this.socket.onRpcRequest(async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        // Handle update events from server
        this.onSocketUpdate = (data: Update) => {
            const updateType = data.body.t;

            // Machine clients should only care about machine updates for this specific machine
            if (updateType === 'update-machine') {
                const update = data.body as UpdateMachineBody;

                // Only process updates for this machine
                if (update.machineId !== this.machine.id) {
                    // Silently ignore updates for other machines
                    return;
                }

                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    const decryptedMetadata = decrypt<MachineMetadata>(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    if (decryptedMetadata === null) {
                        logger.debug('[API MACHINE] [ERROR] Failed to decrypt external metadata update - skipping');
                    } else {
                        this.machine.metadata = decryptedMetadata;
                        this.machine.metadataVersion = update.metadata.version;
                    }
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    const decryptedState = decrypt<DaemonState>(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    if (decryptedState === null) {
                        logger.debug('[API MACHINE] [ERROR] Failed to decrypt external daemon state update - skipping');
                    } else {
                        this.machine.daemonState = decryptedState;
                        this.machine.daemonStateVersion = update.daemonState.version;
                    }
                }
            } else if (updateType === 'new-machine') {
                // Silently ignore new machine registrations (not relevant to this daemon)
                return;
            } else if (updateType === 'new-session' || updateType === 'update-session' || updateType === 'new-message' || updateType === 'delete-session') {
                // Silently ignore session-scoped updates (handled by session clients, not machine client)
                return;
            } else if (updateType === 'update-account') {
                // Silently ignore account updates (not relevant to machine daemon)
                return;
            } else if (updateType === 'new-artifact' || updateType === 'update-artifact' || updateType === 'delete-artifact') {
                // Silently ignore artifact updates (handled by app, not machine daemon)
                return;
            } else if (updateType === 'relationship-updated' || updateType === 'new-feed-post') {
                // Silently ignore social/feed updates (handled by app, not machine daemon)
                return;
            } else if (updateType === 'kv-batch-update') {
                // Silently ignore KV settings updates (handled by app, not machine daemon)
                return;
            } else {
                // Log truly unknown update types for debugging
                logger.debug(`[API MACHINE] Received unhandled update type: ${updateType}`);
            }
        };
        this.socket.onServer('update', this.onSocketUpdate);

        // Ephemeral events - real-time status updates from server (HAP-357)
        this.onSocketEphemeral = (data: EphemeralUpdate) => {
            switch (data.type) {
                case 'activity':
                    // Session activity - machine daemon doesn't track individual sessions
                    // Silently ignore (session clients handle this)
                    break;
                case 'usage': {
                    // Real-time usage/cost update - informational for daemon
                    const sessionId = getSessionIdFromEphemeral(data as SessionIdEphemeral);
                    logger.debug(`[API MACHINE] [EPHEMERAL] Usage: session ${sessionId} cost=$${data.cost.total.toFixed(4)}`);
                    break;
                }
                case 'machine-activity': {
                    // Other machine/daemon activity - track peers for awareness
                    const machineId = getMachineIdFromEphemeral(data as MachineIdEphemeral);
                    if (machineId !== this.machine.id) {
                        logger.debug(`[API MACHINE] [EPHEMERAL] Peer daemon ${machineId} active=${data.active}`);
                    }
                    break;
                }
                default:
                    // Unknown ephemeral type - log but don't crash (forward compatibility)
                    logger.debug(`[API MACHINE] [EPHEMERAL] Unknown type: ${(data as { type: string }).type}`);
            }
        };
        this.socket.onServer('ephemeral', this.onSocketEphemeral);

        this.onSocketConnectError = (error) => {
            logger.debug(`[API MACHINE] Connection error: ${(error as Error).message}`);
        };
        this.socket.on('connect_error', this.onSocketConnectError);

        this.onSocketError = (error: { message: string }) => {
            logger.debug('[API MACHINE] Socket error:', error);
        };
        this.socket.onServer('error', this.onSocketError);

        // Connect to server
        this.socket.connect();
    }

    private startKeepAlive() {
        // Double-check and clear any existing interval to prevent leaks
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Cleared existing keep-alive before starting new one');
        }

        // Add random jitter to prevent thundering herd when multiple clients reconnect
        // Each client will have a unique interval, spreading out the load
        const jitter = Math.random() * KEEP_ALIVE_JITTER_MAX_MS;
        const interval = KEEP_ALIVE_BASE_INTERVAL_MS + jitter;

        this.keepAliveInterval = setInterval(() => {
            // Prevent keep-alive after shutdown
            if (this.isShuttingDown) {
                logger.debug('[API MACHINE] Skipping keep-alive: shutting down');
                return;
            }
            // Skip if socket is not connected (prevents errors during reconnection)
            if (!this.socket?.connected) {
                logger.debug('[API MACHINE] Socket not connected, skipping keep-alive');
                return;
            }

            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) { // too verbose for production
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
        }, interval);
        logger.debug(`[API MACHINE] Keep-alive started (${Math.round(interval / 1000)}s interval with jitter)`);
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    shutdown() {
        // Ensure shutdown is idempotent - safe to call multiple times
        if (this.isShuttingDown) {
            logger.debug('[API MACHINE] Shutdown already in progress, skipping');
            return;
        }
        this.isShuttingDown = true;

        logger.debug('[API MACHINE] Shutting down');
        this.stopKeepAlive();
        if (this.socket) {
            // Remove all socket event listeners before closing
            this.socket.removeAllListeners();
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }


    /**
     * Called during memory pressure to clean up non-essential state. (HAP-353)
     * Delegates to the underlying socket's memory pressure handler.
     */
    onMemoryPressure(): void {
        if (this.socket && !this.isShuttingDown) {
            this.socket.onMemoryPressure();
        }
    }

    /**
     * Get WebSocket metrics for observability (HAP-362)
     *
     * Returns null if socket is not initialized or shutting down.
     * Combines point-in-time statistics with cumulative counters for
     * tracking WebSocket health over time.
     */
    getSocketMetrics(): WebSocketMetrics | null {
        if (!this.socket || this.isShuttingDown) {
            return null;
        }
        return this.socket.getMetrics();
    }
}
