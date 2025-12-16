/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 *
 * @see HAP-261 - Migrated from Socket.io to native WebSocket
 */

import { AppError, ErrorCodes } from '@/utils/errors';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { HappyWebSocket } from './HappyWebSocket';
import type { MetadataUpdateResponse, DaemonStateUpdateResponse } from './socketUtils';

// Keep-alive timing configuration (prevents thundering herd on reconnection)
const KEEP_ALIVE_BASE_INTERVAL_MS = 20000; // 20 seconds base interval
const KEEP_ALIVE_JITTER_MAX_MS = 5000; // 0-5 seconds random jitter

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    requestShutdown: () => void;
}

export class ApiMachineClient {
    private socket!: HappyWebSocket;
    private keepAliveInterval: NodeJS.Timeout | null = null;

    private isShuttingDown = false;
    private rpcHandlerManager: RpcHandlerManager;

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

        registerCommonHandlers(this.rpcHandlerManager);
    }

    setRPCHandlers({
        spawnSession,
        stopSession,
        requestShutdown
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
        this.rpcHandlerManager.registerHandler<SpawnSessionParams, { type: string; sessionId?: string; message?: string; directory?: string }>('spawn-happy-session', async (params, _signal) => {
            const { directory, sessionId, machineId, approvedNewDirectoryCreation, agent, token } = params ?? {};
            logger.debug(`[API MACHINE] Spawning session with params: ${JSON.stringify(params)}`);

            if (!directory) {
                throw new AppError(ErrorCodes.DIRECTORY_REQUIRED, 'Directory is required');
            }

            const result = await spawnSession({ directory, sessionId, machineId, approvedNewDirectoryCreation, agent, token });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}${result.message ? ` (${result.message})` : ''}`);
                    return { type: 'success', sessionId: result.sessionId, message: result.message };

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

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to server');

            // Update daemon state to running
            // We need to override previous state because the daemon (this process)
            // has restarted with new PID & port
            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            }));


            // Register all handlers
            this.rpcHandlerManager.onWebSocketConnect(this.socket);

            // Start keep-alive
            this.startKeepAlive();
        });

        this.socket.on('disconnect', () => {
            logger.debug('[API MACHINE] Disconnected from server');
            this.rpcHandlerManager.onWebSocketDisconnect();
            this.stopKeepAlive();
        });

        // Single consolidated RPC handler
        this.socket.onRpcRequest(async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        // Handle update events from server
        this.socket.on<Update>('update', (data: Update) => {
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
            } else if (updateType === 'new-session' || updateType === 'update-session' || updateType === 'new-message') {
                // Silently ignore session-scoped updates (handled by session clients, not machine client)
                return;
            } else if (updateType === 'update-account') {
                // Silently ignore account updates (not relevant to machine daemon)
                return;
            } else {
                // Log truly unknown update types for debugging
                logger.debug(`[API MACHINE] Received unhandled update type: ${updateType}`);
            }
        });

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${(error as Error).message}`);
        });

        this.socket.on('error', (error: Error) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });

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
}
