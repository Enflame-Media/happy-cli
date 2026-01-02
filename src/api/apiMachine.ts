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
import { RpcHandlerManager, RPC_ERROR_CODES, type SessionRevivalResult } from './rpc/RpcHandlerManager';
import { HappyWebSocket, WebSocketMetrics } from './HappyWebSocket';
import type { MetadataUpdateResponse, DaemonStateUpdateResponse } from './socketUtils';
import { buildMcpSyncState } from '@/mcp/config';

// Keep-alive timing configuration (prevents thundering herd on reconnection)
const KEEP_ALIVE_BASE_INTERVAL_MS = 20000; // 20 seconds base interval
const KEEP_ALIVE_JITTER_MAX_MS = 5000; // 0-5 seconds random jitter

// Session revival configuration (HAP-733)
const SESSION_REVIVAL_TIMEOUT_MS = parseInt(process.env.HAPPY_SESSION_REVIVAL_TIMEOUT || '60000', 10);

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
     * Track sessions currently being revived to prevent concurrent revival attempts.
     * Maps session ID -> Promise that resolves when revival completes.
     *
     * @see HAP-733 - Automatic session revival
     */
    private revivingSessionIds: Map<string, Promise<SessionRevivalResult>> = new Map();

    /**
     * RPC handlers provided by daemon - stored for revival access
     * @see HAP-733
     */
    private rpcHandlers: MachineRpcHandlers | null = null;

    /**
     * Telemetry counters for session revival
     * @see HAP-733
     */
    private revivalMetrics = {
        attempted: 0,
        succeeded: 0,
        failed: 0,
    };

    /**
     * Per-session revival attempt tracking to prevent infinite loops.
     * Maps session ID -> number of revival attempts for that session.
     * Cleared when revival succeeds or when session is no longer referenced.
     *
     * @see HAP-744 - Fix session revival race condition causing infinite loop
     */
    private sessionRevivalAttempts: Map<string, number> = new Map();
    private readonly MAX_REVIVAL_ATTEMPTS_PER_SESSION = 3;

    /**
     * Global revival cooldown tracking to prevent cascade failures.
     * Tracks timestamps of recent revival failures in a sliding window.
     *
     * @see HAP-744 - Fix session revival race condition causing infinite loop
     */
    private revivalFailureTimestamps: number[] = [];
    private revivalCooldownUntil: number = 0;
    private readonly COOLDOWN_WINDOW_MS = 30000; // 30 seconds
    private readonly COOLDOWN_FAILURE_THRESHOLD = 10; // 10 failures in window
    private readonly COOLDOWN_DURATION_MS = 60000; // 60 second cooldown

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
        // Store handlers for revival access (HAP-733)
        this.rpcHandlers = { spawnSession, stopSession, requestShutdown, getSessionStatus };

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
     * Check if global revival cooldown is active.
     * Cooldown is triggered when too many failures occur in a short window.
     *
     * @see HAP-744 - Fix session revival race condition causing infinite loop
     */
    private isRevivalCooldownActive(): boolean {
        const now = Date.now();

        // Check if we're in an active cooldown period
        if (this.revivalCooldownUntil > now) {
            return true;
        }

        // Clean up old timestamps outside the sliding window
        this.revivalFailureTimestamps = this.revivalFailureTimestamps.filter(
            ts => now - ts < this.COOLDOWN_WINDOW_MS
        );

        return false;
    }

    /**
     * Record a revival failure and potentially trigger cooldown.
     *
     * @see HAP-744 - Fix session revival race condition causing infinite loop
     */
    private recordRevivalFailure(): void {
        const now = Date.now();
        this.revivalFailureTimestamps.push(now);

        // Clean up old timestamps
        this.revivalFailureTimestamps = this.revivalFailureTimestamps.filter(
            ts => now - ts < this.COOLDOWN_WINDOW_MS
        );

        // Check if we've exceeded the threshold
        if (this.revivalFailureTimestamps.length >= this.COOLDOWN_FAILURE_THRESHOLD) {
            this.revivalCooldownUntil = now + this.COOLDOWN_DURATION_MS;
            logger.debug(`[API MACHINE] [REVIVAL] Circuit breaker triggered: ${this.revivalFailureTimestamps.length} failures in ${this.COOLDOWN_WINDOW_MS}ms window, pausing revivals for ${this.COOLDOWN_DURATION_MS}ms`);
        }
    }

    /**
     * Attempt to revive a stopped session by spawning a new session with --resume.
     * This method is called when an RPC request fails with SESSION_NOT_ACTIVE.
     *
     * Revival Flow:
     * 1. Check circuit breaker limits (HAP-744)
     * 2. Check if session is archived (don't revive archived sessions)
     * 3. Spawn new session with --resume flag pointing to stopped session
     * 4. Wait for new session to be ready
     * 5. Return result with new session ID
     *
     * @param sessionId - The stopped session ID to revive
     * @param directory - Working directory for the session
     * @returns Result of the revival attempt
     *
     * @see HAP-733 - Automatic session revival on "Method not found" RPC errors
     * @see HAP-744 - Fix session revival race condition causing infinite loop
     */
    private async tryReviveSession(sessionId: string, directory: string): Promise<SessionRevivalResult> {
        // HAP-744: Check global cooldown first
        if (this.isRevivalCooldownActive()) {
            const remainingMs = this.revivalCooldownUntil - Date.now();
            logger.debug(`[API MACHINE] [REVIVAL] Global cooldown active, ${remainingMs}ms remaining. Rejecting revival for ${sessionId.substring(0, 8)}...`);
            return {
                revived: false,
                originalSessionId: sessionId,
                error: `Revival paused: circuit breaker active (${Math.ceil(remainingMs / 1000)}s remaining)`
            };
        }

        // HAP-744: Check per-session attempt limit
        const attempts = this.sessionRevivalAttempts.get(sessionId) || 0;
        if (attempts >= this.MAX_REVIVAL_ATTEMPTS_PER_SESSION) {
            logger.debug(`[API MACHINE] [REVIVAL] Max attempts (${this.MAX_REVIVAL_ATTEMPTS_PER_SESSION}) exceeded for session ${sessionId.substring(0, 8)}...`);
            return {
                revived: false,
                originalSessionId: sessionId,
                error: `Max revival attempts (${this.MAX_REVIVAL_ATTEMPTS_PER_SESSION}) exceeded for this session`
            };
        }

        // Check if revival is already in progress for this session
        const existingRevival = this.revivingSessionIds.get(sessionId);
        if (existingRevival) {
            logger.debug(`[API MACHINE] [REVIVAL] Session ${sessionId.substring(0, 8)}... revival already in progress, waiting`);
            return existingRevival;
        }

        // Ensure handlers are available
        if (!this.rpcHandlers) {
            return {
                revived: false,
                originalSessionId: sessionId,
                error: 'RPC handlers not initialized'
            };
        }

        // HAP-744: Increment per-session attempt counter
        this.sessionRevivalAttempts.set(sessionId, attempts + 1);

        this.revivalMetrics.attempted++;
        logger.debug(`[API MACHINE] [REVIVAL] Attempting revival for session ${sessionId.substring(0, 8)}... (attempt #${attempts + 1}/${this.MAX_REVIVAL_ATTEMPTS_PER_SESSION}, global #${this.revivalMetrics.attempted})`);

        // Create the revival promise
        const revivalPromise = this.executeSessionRevival(sessionId, directory);

        // Track it to prevent concurrent attempts
        this.revivingSessionIds.set(sessionId, revivalPromise);

        try {
            const result = await revivalPromise;

            // Update metrics
            if (result.revived) {
                this.revivalMetrics.succeeded++;
                // HAP-744: Clear attempt counter on success
                this.sessionRevivalAttempts.delete(sessionId);
                logger.debug(`[API MACHINE] [REVIVAL] Session ${sessionId.substring(0, 8)}... revived successfully -> ${result.newSessionId?.substring(0, 8)}...`);
            } else {
                this.revivalMetrics.failed++;
                // HAP-744: Record failure for circuit breaker
                this.recordRevivalFailure();
                logger.debug(`[API MACHINE] [REVIVAL] Session ${sessionId.substring(0, 8)}... revival failed: ${result.error}`);
            }

            return result;
        } finally {
            // Always clean up tracking
            this.revivingSessionIds.delete(sessionId);
        }
    }

    /**
     * Execute the actual session revival logic.
     * Separated from tryReviveSession for cleaner code organization.
     *
     * @see HAP-733
     */
    private async executeSessionRevival(sessionId: string, directory: string): Promise<SessionRevivalResult> {
        // Step 1: Check if session is archived (don't revive archived sessions)
        try {
            const statusResult = this.rpcHandlers!.getSessionStatus(sessionId);

            // Only revive sessions that are truly stopped, not archived
            // Note: Currently getSessionStatus only returns 'active' or 'unknown'
            // 'unknown' means the session is not currently running, which is what we want to revive
            if (statusResult.status === 'active') {
                // Session is actually active - shouldn't be trying to revive
                return {
                    revived: false,
                    originalSessionId: sessionId,
                    error: 'Session is already active'
                };
            }

            // If we had 'archived' status tracking, we would check here:
            // if (statusResult.status === 'archived') {
            //     return { revived: false, originalSessionId: sessionId, error: 'Cannot revive archived session' };
            // }
        } catch (error) {
            logger.debug(`[API MACHINE] [REVIVAL] Failed to check session status: ${error instanceof Error ? error.message : 'Unknown error'}`);
            // Continue with revival attempt even if status check fails
        }

        // Step 2: Spawn new session with --resume flag
        try {
            // Create a timeout promise
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Revival timeout after ${SESSION_REVIVAL_TIMEOUT_MS}ms`));
                }, SESSION_REVIVAL_TIMEOUT_MS);
            });

            // Race between spawn and timeout
            const spawnPromise = this.rpcHandlers!.spawnSession({
                directory,
                sessionId, // Pass the old session ID for --resume
            });

            const spawnResult = await Promise.race([spawnPromise, timeoutPromise]);

            if (spawnResult.type === 'success') {
                // Step 3: Broadcast session:updated event to connected clients
                // Note: The mobile app will receive this via the WebSocket connection
                // and should update its session reference accordingly
                if (this.socket?.connected && spawnResult.sessionId !== sessionId) {
                    this.socket.emitClient('session-revived', {
                        originalSessionId: sessionId,
                        newSessionId: spawnResult.sessionId,
                        machineId: this.machine.id
                    });
                    logger.debug(`[API MACHINE] [REVIVAL] Broadcast session-revived event`);
                }

                return {
                    revived: true,
                    newSessionId: spawnResult.sessionId,
                    originalSessionId: sessionId,
                    commandReplayed: false // Command replay happens in handleRpcWithRevival
                };
            } else if (spawnResult.type === 'requestToApproveDirectoryCreation') {
                return {
                    revived: false,
                    originalSessionId: sessionId,
                    error: `Directory creation required but not approved: ${spawnResult.directory}`
                };
            } else {
                return {
                    revived: false,
                    originalSessionId: sessionId,
                    error: spawnResult.errorMessage
                };
            }
        } catch (error) {
            return {
                revived: false,
                originalSessionId: sessionId,
                error: error instanceof Error ? error.message : 'Unknown error during revival'
            };
        }
    }

    /**
     * Handle an RPC request with automatic session revival on SESSION_NOT_ACTIVE errors.
     *
     * This wraps the standard RPC handling flow to:
     * 1. Try the original RPC request
     * 2. If it fails with SESSION_NOT_ACTIVE, attempt to revive the session
     * 3. If revival succeeds, replay the original request
     * 4. Return appropriate response (success, revival info, or error)
     *
     * @param request - The RPC request data
     * @returns Encrypted response string
     *
     * @see HAP-733 - Automatic session revival on "Method not found" RPC errors
     */
    private async handleRpcWithRevival(request: { method: string; params: string }): Promise<string> {
        // First, try the standard RPC handling
        const initialResponse = await this.rpcHandlerManager.handleRequest(request);

        // Check if the response indicates a stopped session
        // We need to decrypt and inspect the response
        try {
            const decryptedResponse = decrypt<{
                error?: string;
                code?: string;
            }>(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(initialResponse));

            // If not an error or not SESSION_NOT_ACTIVE, return original response
            if (!decryptedResponse || !decryptedResponse.code || decryptedResponse.code !== RPC_ERROR_CODES.SESSION_NOT_ACTIVE) {
                return initialResponse;
            }

            // Extract session ID from the method name (format: {sessionId}:{methodName})
            const methodParts = request.method.split(':');
            if (methodParts.length !== 2) {
                // Not a session-scoped method, return original error
                return initialResponse;
            }

            const sessionId = methodParts[0];
            const methodName = methodParts[1];

            // Validate session ID format
            if (!isValidSessionId(sessionId)) {
                logger.debug(`[API MACHINE] [REVIVAL] Invalid session ID format in method: ${request.method}`);
                return initialResponse;
            }

            logger.debug(`[API MACHINE] [REVIVAL] Detected SESSION_NOT_ACTIVE for ${sessionId.substring(0, 8)}...:${methodName}`);

            // Attempt to revive the session
            // TODO: Get directory from session metadata or a registry
            // For now, use current working directory as fallback
            const directory = process.cwd();
            const revivalResult = await this.tryReviveSession(sessionId, directory);

            if (!revivalResult.revived) {
                // Revival failed - return error response with SESSION_REVIVAL_FAILED code
                const errorResponse = {
                    error: `Session revival failed: ${revivalResult.error}`,
                    code: RPC_ERROR_CODES.SESSION_REVIVAL_FAILED,
                    originalSessionId: sessionId,
                    revivalResult
                };
                return encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, errorResponse));
            }

            // Revival succeeded - replay the original command with the NEW session ID
            // Update the method name to use the new session ID
            const newMethod = `${revivalResult.newSessionId}:${methodName}`;
            logger.debug(`[API MACHINE] [REVIVAL] Replaying command: ${methodName} on revived session ${revivalResult.newSessionId?.substring(0, 8)}...`);

            // HAP-744: Wait for the new session's handlers to be registered using polling
            // instead of a fixed delay. The spawn-happy-session RPC waits for the session
            // webhook, but handlers may take longer to register.
            const POLL_INTERVAL_MS = 100;
            const MAX_WAIT_MS = 5000;
            let waited = 0;
            let handlerReady = false;

            while (waited < MAX_WAIT_MS) {
                // Check if the new session's handlers are registered
                // by attempting to get its status from the handler manager
                try {
                    const status = this.rpcHandlers?.getSessionStatus(revivalResult.newSessionId!);
                    if (status?.status === 'active') {
                        handlerReady = true;
                        logger.debug(`[API MACHINE] [REVIVAL] Handler ready after ${waited}ms`);
                        break;
                    }
                } catch {
                    // Handler not ready yet, continue polling
                }

                await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
                waited += POLL_INTERVAL_MS;
            }

            if (!handlerReady) {
                logger.debug(`[API MACHINE] [REVIVAL] Handler not ready after ${MAX_WAIT_MS}ms, proceeding anyway`);
            }

            // Replay the original request with the new session ID
            const replayResponse = await this.rpcHandlerManager.handleRequest({
                ...request,
                method: newMethod
            });

            // Check if replay succeeded
            const decryptedReplayResponse = decrypt<{
                error?: string;
                code?: string;
            }>(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(replayResponse));

            if (decryptedReplayResponse && !decryptedReplayResponse.error) {
                // Replay succeeded - include revival metadata in response
                // Note: We can't easily modify the encrypted response, so we return it as-is
                // The client should receive the session-revived event separately
                logger.debug(`[API MACHINE] [REVIVAL] Command replay succeeded`);
                return replayResponse;
            }

            // Replay failed - log and return the replay response (which contains the error)
            logger.debug(`[API MACHINE] [REVIVAL] Command replay failed: ${decryptedReplayResponse?.error || 'Unknown error'}`);
            return replayResponse;

        } catch (error) {
            // Decryption or processing error - return original response
            logger.debug(`[API MACHINE] [REVIVAL] Error processing response: ${error instanceof Error ? error.message : 'Unknown'}`);
            return initialResponse;
        }
    }

    /**
     * Get session revival metrics for observability.
     *
     * @returns Object with attempted, succeeded, and failed counts
     * @see HAP-733
     */
    getRevivalMetrics(): { attempted: number; succeeded: number; failed: number } {
        return { ...this.revivalMetrics };
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

        // Single consolidated RPC handler with session revival support (HAP-733)
        this.socket.onRpcRequest(async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            // Use handleRpcWithRevival to automatically revive stopped sessions
            callback(await this.handleRpcWithRevival(data));
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
