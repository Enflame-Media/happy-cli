/**
 * Unit tests for ApiMachineClient session revival logic
 *
 * Tests the session revival flow implemented in HAP-733:
 * - tryReviveSession() - Concurrent revival prevention, metrics tracking, cleanup
 * - executeSessionRevival() - Status check, spawn with --resume, broadcast, error handling
 * - handleRpcWithRevival() - SESSION_NOT_ACTIVE detection, revival trigger, command replay
 *
 * These tests complement apiMachine.circuitBreaker.test.ts which focuses on
 * rate limiting and circuit breaker logic (HAP-744).
 *
 * @see HAP-733 - Automatic session revival on "Method not found" RPC errors
 * @see HAP-739 - Add unit tests for session revival (this file)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock logger before importing ApiMachineClient
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debugLargeJson: vi.fn(),
    },
}));

// Mock configuration
vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'ws://localhost:3000',
    },
}));

// Mock claudeCheckSession for session validation
const mockClaudeCheckSession = vi.fn();
vi.mock('@/claude/utils/claudeCheckSession', () => ({
    claudeCheckSession: (...args: unknown[]) => mockClaudeCheckSession(...args),
}));

// Mock encryption - simulates encrypt/decrypt without actual crypto
vi.mock('@/api/encryption', () => ({
    encrypt: vi.fn((_key, _variant, data) => {
        return new TextEncoder().encode(JSON.stringify(data));
    }),
    decrypt: vi.fn((_key, _variant, data) => {
        try {
            return JSON.parse(new TextDecoder().decode(data));
        } catch {
            return null;
        }
    }),
    encodeBase64: vi.fn((data) => {
        return Buffer.from(data).toString('base64');
    }),
    decodeBase64: vi.fn((data) => {
        return new Uint8Array(Buffer.from(data, 'base64'));
    }),
}));

// Mock common handlers (not relevant to revival tests)
vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn(),
}));

// Mock MCP config
vi.mock('@/mcp/config', () => ({
    buildMcpSyncState: vi.fn(() => ({})),
}));

// Mock telemetry
const mockTrackEvent = vi.fn();
vi.mock('@/telemetry', () => ({
    trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

// Create a mock socket for testing
const createMockSocket = () => ({
    on: vi.fn(),
    off: vi.fn(),
    onServer: vi.fn(),
    onRpcRequest: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
    removeAllListeners: vi.fn(),
    connected: true,
    emit: vi.fn(),
    emitWithAck: vi.fn().mockResolvedValue({ result: 'success' }),
    emitClient: vi.fn(),
});

// Mock HappyWebSocket
vi.mock('./HappyWebSocket', () => {
    return {
        HappyWebSocket: vi.fn().mockImplementation(() => createMockSocket()),
    };
});

// Import RPC error codes
import { RPC_ERROR_CODES } from './rpc/RpcHandlerManager';

import { ApiMachineClient } from './apiMachine';

// Helper to create a base64-encoded encrypted response
function encryptedResponse(data: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(data)).toString('base64');
}

// Helper to create a mock machine object
function createMockMachine(id: string = 'test-machine-id') {
    return {
        id,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey' as const,
        metadata: {
            host: 'test-host',
            platform: 'darwin',
            happyCliVersion: '0.12.0',
            homeDir: '/home/test',
            happyHomeDir: '/home/test/.happy',
            happyLibDir: '/home/test/.happy/lib',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

describe('ApiMachineClient Session Revival', () => {
    let client: ApiMachineClient;
    const mockToken = 'test-token';
    const testSessionId = 'bb6ca0a4-5734-4204-ada7-7aa2c27473c5';
    const testDirectory = '/test/directory';
    const newSessionId = 'cc7db1b5-6845-5315-beb8-8bb3d38584d6';

    // Mock RPC handlers
    const mockSpawnSession = vi.fn();
    const mockStopSession = vi.fn();
    const mockRequestShutdown = vi.fn();
    const mockGetSessionStatus = vi.fn();
    const mockGetSessionDirectory = vi.fn();
    const mockOnMachineDisconnected = vi.fn();

    // Mock socket stored for assertions
    let mockSocket: ReturnType<typeof createMockSocket>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();

        // Reset claudeCheckSession mock
        mockClaudeCheckSession.mockReturnValue(true);

        client = new ApiMachineClient(mockToken, createMockMachine());

        // Set up default RPC handlers
        mockSpawnSession.mockResolvedValue({
            type: 'success',
            sessionId: newSessionId,
        });
        mockGetSessionStatus.mockReturnValue({ status: 'unknown' });
        mockGetSessionDirectory.mockReturnValue(testDirectory);

        client.setRPCHandlers({
            spawnSession: mockSpawnSession,
            stopSession: mockStopSession,
            requestShutdown: mockRequestShutdown,
            getSessionStatus: mockGetSessionStatus,
            getSessionDirectory: mockGetSessionDirectory,
            onMachineDisconnected: mockOnMachineDisconnected,
        });

        // Create and inject mock socket
        mockSocket = createMockSocket();
        const clientAny = client as unknown as { socket: typeof mockSocket };
        clientAny.socket = mockSocket;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('tryReviveSession()', () => {
        it('should return cached promise when revival already in progress for same session', async () => {
            const clientAny = client as unknown as {
                tryReviveSession: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string; newSessionId?: string; error?: string }>;
                revivingSessionIds: Map<string, Promise<unknown>>;
                rpcHandlers: unknown;
            };

            // Create a deferred promise for controlling spawn completion timing
            const deferred = (() => {
                let resolve: (value: { type: string; sessionId: string }) => void = () => {};
                const promise = new Promise<{ type: string; sessionId: string }>((res) => {
                    resolve = res;
                });
                return { promise, resolve };
            })();
            mockSpawnSession.mockImplementation(() => deferred.promise);

            // Start first revival - this begins but doesn't complete until we resolve the deferred
            const promise1 = clientAny.tryReviveSession(testSessionId, testDirectory);

            // Start second revival for same session - should reuse the ongoing revival
            // Note: Due to async function wrapping, the promises themselves won't be identical,
            // but the underlying revival should be reused (spawnSession called once)
            const promise2 = clientAny.tryReviveSession(testSessionId, testDirectory);

            // spawnSession should only be called once due to deduplication
            expect(mockSpawnSession).toHaveBeenCalledTimes(1);

            // Complete the spawn via the deferred
            deferred.resolve({ type: 'success', sessionId: newSessionId });
            await vi.runAllTimersAsync();

            // Both promises should resolve with same result
            const result1 = await promise1;
            const result2 = await promise2;
            expect(result1).toEqual(result2);
            expect(result1.revived).toBe(true);
        });

        it('should return error when RPC handlers not initialized', async () => {
            // Create fresh client without setting RPC handlers
            const freshClient = new ApiMachineClient(mockToken, createMockMachine());
            const clientAny = freshClient as unknown as {
                tryReviveSession: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string; error?: string }>;
            };

            const result = await clientAny.tryReviveSession(testSessionId, testDirectory);

            expect(result.revived).toBe(false);
            expect(result.originalSessionId).toBe(testSessionId);
            expect(result.error).toBe('RPC handlers not initialized');
        });

        it('should update metrics on success', async () => {
            const clientAny = client as unknown as {
                tryReviveSession: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string }>;
                revivalMetrics: { attempted: number; succeeded: number; failed: number };
            };

            // Verify initial metrics
            expect(clientAny.revivalMetrics.attempted).toBe(0);
            expect(clientAny.revivalMetrics.succeeded).toBe(0);
            expect(clientAny.revivalMetrics.failed).toBe(0);

            // Perform revival
            await clientAny.tryReviveSession(testSessionId, testDirectory);

            // Verify metrics updated
            expect(clientAny.revivalMetrics.attempted).toBe(1);
            expect(clientAny.revivalMetrics.succeeded).toBe(1);
            expect(clientAny.revivalMetrics.failed).toBe(0);
        });

        it('should update metrics on failure', async () => {
            const clientAny = client as unknown as {
                tryReviveSession: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string }>;
                revivalMetrics: { attempted: number; succeeded: number; failed: number };
            };

            // Make spawnSession fail
            mockSpawnSession.mockResolvedValue({
                type: 'error',
                errorMessage: 'Session spawn failed',
            });

            // Perform revival
            await clientAny.tryReviveSession(testSessionId, testDirectory);

            // Verify metrics updated
            expect(clientAny.revivalMetrics.attempted).toBe(1);
            expect(clientAny.revivalMetrics.succeeded).toBe(0);
            expect(clientAny.revivalMetrics.failed).toBe(1);
        });

        it('should clean up tracking map in finally block', async () => {
            const clientAny = client as unknown as {
                tryReviveSession: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string }>;
                revivingSessionIds: Map<string, Promise<unknown>>;
            };

            // Verify initial state
            expect(clientAny.revivingSessionIds.size).toBe(0);

            // Perform revival
            await clientAny.tryReviveSession(testSessionId, testDirectory);

            // Tracking should be cleaned up after completion
            expect(clientAny.revivingSessionIds.size).toBe(0);
        });

        it('should clean up tracking map even on failure', async () => {
            const clientAny = client as unknown as {
                tryReviveSession: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string }>;
                revivingSessionIds: Map<string, Promise<unknown>>;
            };

            // Make spawnSession throw an error
            mockSpawnSession.mockRejectedValue(new Error('Spawn crashed'));

            // Perform revival - should not throw
            const result = await clientAny.tryReviveSession(testSessionId, testDirectory);

            expect(result.revived).toBe(false);
            // Tracking should be cleaned up after failure
            expect(clientAny.revivingSessionIds.size).toBe(0);
        });

        it('should clear per-session attempt counter on success', async () => {
            const clientAny = client as unknown as {
                tryReviveSession: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string }>;
                sessionRevivalAttempts: Map<string, number>;
            };

            // Set some prior attempts
            clientAny.sessionRevivalAttempts.set(testSessionId, 1);

            // Perform successful revival
            await clientAny.tryReviveSession(testSessionId, testDirectory);

            // Attempt counter should be cleared on success
            expect(clientAny.sessionRevivalAttempts.has(testSessionId)).toBe(false);
        });
    });

    describe('executeSessionRevival()', () => {
        it('should return error when session is already active', async () => {
            const clientAny = client as unknown as {
                executeSessionRevival: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string; error?: string }>;
            };

            // Session is active
            mockGetSessionStatus.mockReturnValue({ status: 'active' });

            const result = await clientAny.executeSessionRevival(testSessionId, testDirectory);

            expect(result.revived).toBe(false);
            expect(result.originalSessionId).toBe(testSessionId);
            expect(result.error).toBe('Session is already active');

            // spawnSession should not have been called
            expect(mockSpawnSession).not.toHaveBeenCalled();
        });

        it('should broadcast session-revived event on successful spawn', async () => {
            const clientAny = client as unknown as {
                executeSessionRevival: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string; newSessionId?: string }>;
            };

            const result = await clientAny.executeSessionRevival(testSessionId, testDirectory);

            expect(result.revived).toBe(true);
            expect(result.newSessionId).toBe(newSessionId);

            // Should have broadcast the event
            expect(mockSocket.emitClient).toHaveBeenCalledWith('session-revived', {
                originalSessionId: testSessionId,
                newSessionId: newSessionId,
                machineId: 'test-machine-id',
            });
        });

        it('should not broadcast if socket is not connected', async () => {
            const clientAny = client as unknown as {
                executeSessionRevival: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string; newSessionId?: string }>;
            };

            // Socket not connected
            mockSocket.connected = false;

            const result = await clientAny.executeSessionRevival(testSessionId, testDirectory);

            expect(result.revived).toBe(true);
            // Should NOT have broadcast the event
            expect(mockSocket.emitClient).not.toHaveBeenCalled();
        });

        it('should not broadcast if new session ID is same as original', async () => {
            const clientAny = client as unknown as {
                executeSessionRevival: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string; newSessionId?: string }>;
            };

            // spawnSession returns same ID (unusual but possible)
            mockSpawnSession.mockResolvedValue({
                type: 'success',
                sessionId: testSessionId, // Same as original
            });

            const result = await clientAny.executeSessionRevival(testSessionId, testDirectory);

            expect(result.revived).toBe(true);
            // Should NOT broadcast when session ID unchanged
            expect(mockSocket.emitClient).not.toHaveBeenCalled();
        });

        it('should handle requestToApproveDirectoryCreation response', async () => {
            const clientAny = client as unknown as {
                executeSessionRevival: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string; error?: string }>;
            };

            mockSpawnSession.mockResolvedValue({
                type: 'requestToApproveDirectoryCreation',
                directory: '/new/directory',
            });

            const result = await clientAny.executeSessionRevival(testSessionId, testDirectory);

            expect(result.revived).toBe(false);
            expect(result.error).toBe('Directory creation required but not approved: /new/directory');
        });

        it('should handle spawn error response', async () => {
            const clientAny = client as unknown as {
                executeSessionRevival: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string; error?: string }>;
            };

            mockSpawnSession.mockResolvedValue({
                type: 'error',
                errorMessage: 'Claude process crashed',
            });

            const result = await clientAny.executeSessionRevival(testSessionId, testDirectory);

            expect(result.revived).toBe(false);
            expect(result.error).toBe('Claude process crashed');
        });

        it('should handle timeout correctly', async () => {
            const clientAny = client as unknown as {
                executeSessionRevival: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string; error?: string }>;
            };

            // Make spawnSession never resolve
            mockSpawnSession.mockImplementation(() => new Promise(() => {}));

            // Start revival
            const resultPromise = clientAny.executeSessionRevival(testSessionId, testDirectory);

            // Advance timer past the timeout (60 seconds default)
            await vi.advanceTimersByTimeAsync(61000);

            const result = await resultPromise;

            expect(result.revived).toBe(false);
            expect(result.error).toContain('timeout');
        });

        it('should continue revival if status check fails', async () => {
            const clientAny = client as unknown as {
                executeSessionRevival: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string; newSessionId?: string }>;
            };

            // Make status check throw
            mockGetSessionStatus.mockImplementation(() => {
                throw new Error('Status check failed');
            });

            const result = await clientAny.executeSessionRevival(testSessionId, testDirectory);

            // Should still attempt revival despite status check failure
            expect(mockSpawnSession).toHaveBeenCalled();
            expect(result.revived).toBe(true);
        });

        it('should continue revival if claudeCheckSession returns false', async () => {
            const clientAny = client as unknown as {
                executeSessionRevival: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string; newSessionId?: string }>;
            };

            // Session file does not exist
            mockClaudeCheckSession.mockReturnValue(false);

            const result = await clientAny.executeSessionRevival(testSessionId, testDirectory);

            // Should still attempt revival - spawnSession handles missing session files gracefully
            expect(mockSpawnSession).toHaveBeenCalled();
            expect(result.revived).toBe(true);
        });
    });

    describe('handleRpcWithRevival()', () => {
        it('should return original response if not SESSION_NOT_ACTIVE error', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                };
            };

            // Mock a successful response
            const successResponse = encryptedResponse({ result: 'success', data: 'test' });
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockResolvedValue(successResponse);

            const result = await clientAny.handleRpcWithRevival({
                method: `${testSessionId}:testMethod`,
                params: 'encrypted-params',
            });

            // Should return original response unchanged
            expect(result).toBe(successResponse);
            // spawnSession should not have been called
            expect(mockSpawnSession).not.toHaveBeenCalled();
        });

        it('should return original response for non-session-scoped method format', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                };
            };

            // Mock a SESSION_NOT_ACTIVE error for a non-session-scoped method
            const errorResponse = encryptedResponse({
                error: 'Session not active',
                code: RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
            });
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockResolvedValue(errorResponse);

            // Method without session ID prefix (just "methodName" or "short:method")
            const result = await clientAny.handleRpcWithRevival({
                method: 'shortprefix:testMethod', // Not a valid session ID format
                params: 'encrypted-params',
            });

            // Should return original response - no revival attempt
            expect(result).toBe(errorResponse);
            expect(mockSpawnSession).not.toHaveBeenCalled();
        });

        it('should detect SESSION_NOT_ACTIVE and trigger revival', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                    registerHandler: (method: string, handler: unknown) => void;
                };
            };

            // First call returns SESSION_NOT_ACTIVE
            const errorResponse = encryptedResponse({
                error: 'Session not active',
                code: RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
            });
            // After revival, return success
            const successResponse = encryptedResponse({ result: 'success' });

            let callCount = 0;
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve(errorResponse);
                }
                return Promise.resolve(successResponse);
            });

            // Mock getSessionStatus to return active after revival
            mockGetSessionStatus.mockImplementation((sessionId) => {
                // First call for the stopped session
                if (sessionId === testSessionId) {
                    return { status: 'unknown' };
                }
                // After revival, new session is active
                return { status: 'active' };
            });

            await clientAny.handleRpcWithRevival({
                method: `${testSessionId}:testMethod`,
                params: 'encrypted-params',
            });

            // Should have triggered revival
            expect(mockSpawnSession).toHaveBeenCalledWith({
                directory: testDirectory,
                sessionId: testSessionId,
            });
        });

        it('should return SESSION_REVIVAL_FAILED on failed revival', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                };
            };

            // Return SESSION_NOT_ACTIVE error
            const errorResponse = encryptedResponse({
                error: 'Session not active',
                code: RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
            });
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockResolvedValue(errorResponse);

            // Make revival fail
            mockSpawnSession.mockResolvedValue({
                type: 'error',
                errorMessage: 'Revival failed due to timeout',
            });

            const result = await clientAny.handleRpcWithRevival({
                method: `${testSessionId}:testMethod`,
                params: 'encrypted-params',
            });

            // Parse the response
            const decoded = JSON.parse(Buffer.from(result, 'base64').toString());

            expect(decoded.code).toBe(RPC_ERROR_CODES.SESSION_REVIVAL_FAILED);
            expect(decoded.error).toContain('Session revival failed');
            expect(decoded.originalSessionId).toBe(testSessionId);
        });

        it('should replay command on successful revival', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                };
            };

            // First call returns SESSION_NOT_ACTIVE
            const errorResponse = encryptedResponse({
                error: 'Session not active',
                code: RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
            });
            // Replay returns success
            const successResponse = encryptedResponse({ result: 'success', replayed: true });

            let callCount = 0;
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockImplementation((request: { method: string }) => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve(errorResponse);
                }
                // Second call should use the new session ID
                expect(request.method).toBe(`${newSessionId}:testMethod`);
                return Promise.resolve(successResponse);
            });

            // Return 'unknown' for original session (so executeSessionRevival proceeds),
            // then 'active' for new session (so handler-ready check passes)
            let statusCallCount = 0;
            mockGetSessionStatus.mockImplementation((sessionId: string) => {
                statusCallCount++;
                // Original session check in executeSessionRevival returns 'unknown'
                if (sessionId === testSessionId) {
                    return { status: 'unknown' };
                }
                // New session check in handleRpcWithRevival returns 'active'
                return { status: 'active' };
            });

            const result = await clientAny.handleRpcWithRevival({
                method: `${testSessionId}:testMethod`,
                params: 'encrypted-params',
            });

            // Should have replayed with new session ID
            expect(result).toBe(successResponse);
            expect(clientAny.rpcHandlerManager.handleRequest).toHaveBeenCalledTimes(2);
        });

        it('should handle decryption errors gracefully', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                };
            };

            // Return clearly invalid base64 (% and spaces are never valid in any base64 variant)
            const malformedResponse = '%invalid base64%';
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockResolvedValue(malformedResponse);

            const result = await clientAny.handleRpcWithRevival({
                method: `${testSessionId}:testMethod`,
                params: 'encrypted-params',
            });

            // Should return original response on decryption failure
            expect(result).toBe(malformedResponse);
            // Should not attempt revival
            expect(mockSpawnSession).not.toHaveBeenCalled();
        });

        it('should skip revival for killSession method', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                };
            };

            // Return SESSION_NOT_ACTIVE error
            const errorResponse = encryptedResponse({
                error: 'Session not active',
                code: RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
            });
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockResolvedValue(errorResponse);

            const result = await clientAny.handleRpcWithRevival({
                method: `${testSessionId}:killSession`,
                params: 'encrypted-params',
            });

            // Should return original error - no revival for kill requests
            expect(result).toBe(errorResponse);
            expect(mockSpawnSession).not.toHaveBeenCalled();
        });

        it('should skip revival for archived sessions', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                };
                archivedSessionIds: Set<string>;
            };

            // Mark session as archived (normalizeSessionId returns lowercase UUID with hyphens)
            clientAny.archivedSessionIds.add(testSessionId.toLowerCase());

            // Return SESSION_NOT_ACTIVE error
            const errorResponse = encryptedResponse({
                error: 'Session not active',
                code: RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
            });
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockResolvedValue(errorResponse);

            const result = await clientAny.handleRpcWithRevival({
                method: `${testSessionId}:testMethod`,
                params: 'encrypted-params',
            });

            // Should return original error - no revival for archived sessions
            expect(result).toBe(errorResponse);
            expect(mockSpawnSession).not.toHaveBeenCalled();
        });

        it('should use stored directory from getSessionDirectory', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                };
            };

            // Return SESSION_NOT_ACTIVE error
            const errorResponse = encryptedResponse({
                error: 'Session not active',
                code: RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
            });
            const successResponse = encryptedResponse({ result: 'success' });

            let callCount = 0;
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockImplementation(() => {
                callCount++;
                return callCount === 1 ? Promise.resolve(errorResponse) : Promise.resolve(successResponse);
            });

            // Set specific stored directory
            const storedDir = '/custom/stored/directory';
            mockGetSessionDirectory.mockReturnValue(storedDir);
            // Return 'unknown' for original session so executeSessionRevival proceeds,
            // then 'active' for new session so handler-ready check passes
            mockGetSessionStatus.mockImplementation((sessionId: string) => {
                if (sessionId === testSessionId) {
                    return { status: 'unknown' };
                }
                return { status: 'active' };
            });

            await clientAny.handleRpcWithRevival({
                method: `${testSessionId}:testMethod`,
                params: 'encrypted-params',
            });

            // Should have used the stored directory
            expect(mockSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
                directory: storedDir,
            }));
        });

        it('should fall back to cwd when no stored directory', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                };
            };

            // Return SESSION_NOT_ACTIVE error
            const errorResponse = encryptedResponse({
                error: 'Session not active',
                code: RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
            });
            const successResponse = encryptedResponse({ result: 'success' });

            let callCount = 0;
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockImplementation(() => {
                callCount++;
                return callCount === 1 ? Promise.resolve(errorResponse) : Promise.resolve(successResponse);
            });

            // No stored directory
            mockGetSessionDirectory.mockReturnValue(undefined);
            // Return 'unknown' for original session so executeSessionRevival proceeds,
            // then 'active' for new session so handler-ready check passes
            mockGetSessionStatus.mockImplementation((sessionId: string) => {
                if (sessionId === testSessionId) {
                    return { status: 'unknown' };
                }
                return { status: 'active' };
            });

            await clientAny.handleRpcWithRevival({
                method: `${testSessionId}:testMethod`,
                params: 'encrypted-params',
            });

            // Should have used process.cwd() as fallback
            expect(mockSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
                directory: process.cwd(),
            }));
        });
    });

    describe('Integration scenarios', () => {
        it('should handle multiple concurrent RPC calls to stopped session', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                };
            };

            // Return SESSION_NOT_ACTIVE for initial calls, success after revival
            const errorResponse = encryptedResponse({
                error: 'Session not active',
                code: RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
            });
            const successResponse = encryptedResponse({ result: 'success' });

            let callCount = 0;
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockImplementation((request: { method: string }) => {
                callCount++;
                // First 3 calls are for the stopped session
                if (callCount <= 3 && request.method.startsWith(testSessionId)) {
                    return Promise.resolve(errorResponse);
                }
                // After revival, success
                return Promise.resolve(successResponse);
            });

            // Return 'unknown' for original session so executeSessionRevival proceeds,
            // then 'active' for new session so handler-ready check passes
            mockGetSessionStatus.mockImplementation((sessionId: string) => {
                if (sessionId === testSessionId) {
                    return { status: 'unknown' };
                }
                return { status: 'active' };
            });

            // Start 3 concurrent RPC calls
            const promises = [
                clientAny.handleRpcWithRevival({ method: `${testSessionId}:method1`, params: 'p1' }),
                clientAny.handleRpcWithRevival({ method: `${testSessionId}:method2`, params: 'p2' }),
                clientAny.handleRpcWithRevival({ method: `${testSessionId}:method3`, params: 'p3' }),
            ];

            // Let them all run
            await vi.runAllTimersAsync();
            await Promise.all(promises);

            // spawnSession should only be called ONCE due to concurrent revival prevention
            expect(mockSpawnSession).toHaveBeenCalledTimes(1);
        });

        it('should emit telemetry events during revival flow', async () => {
            const clientAny = client as unknown as {
                tryReviveSession: (sessionId: string, directory: string) => Promise<{ revived: boolean; originalSessionId: string }>;
            };

            mockTrackEvent.mockClear();

            // Perform successful revival
            await clientAny.tryReviveSession(testSessionId, testDirectory);

            // Should have emitted attempt and success events
            expect(mockTrackEvent).toHaveBeenCalledWith('session_revival_attempt', expect.anything());
            expect(mockTrackEvent).toHaveBeenCalledWith('session_revival_success', expect.anything());
        });

        it('should wait for handler to be ready before replaying command', async () => {
            const clientAny = client as unknown as {
                handleRpcWithRevival: (request: { method: string; params: string }) => Promise<string>;
                rpcHandlerManager: {
                    handleRequest: (request: { method: string; params: string }) => Promise<string>;
                };
            };

            // Return SESSION_NOT_ACTIVE for initial call
            const errorResponse = encryptedResponse({
                error: 'Session not active',
                code: RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
            });
            const successResponse = encryptedResponse({ result: 'success' });

            let callCount = 0;
            clientAny.rpcHandlerManager.handleRequest = vi.fn().mockImplementation(() => {
                callCount++;
                return callCount === 1 ? Promise.resolve(errorResponse) : Promise.resolve(successResponse);
            });

            // Simulate handler not ready initially, then ready after 2 polls
            let statusCallCount = 0;
            mockGetSessionStatus.mockImplementation(() => {
                statusCallCount++;
                // After revival starts, first few checks show unknown
                if (statusCallCount <= 2) {
                    return { status: 'unknown' };
                }
                // Eventually active
                return { status: 'active' };
            });

            const resultPromise = clientAny.handleRpcWithRevival({
                method: `${testSessionId}:testMethod`,
                params: 'encrypted-params',
            });

            // Run timers to allow polling
            await vi.runAllTimersAsync();

            const result = await resultPromise;

            // Should have succeeded after waiting for handler
            expect(result).toBe(successResponse);
            // Should have polled for handler readiness
            expect(statusCallCount).toBeGreaterThan(1);
        });
    });
});
