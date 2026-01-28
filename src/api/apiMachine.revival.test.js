"use strict";
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var vitest_1 = require("vitest");
// Mock logger before importing ApiMachineClient
vitest_1.vi.mock('@/ui/logger', function () { return ({
    logger: {
        debug: vitest_1.vi.fn(),
        info: vitest_1.vi.fn(),
        warn: vitest_1.vi.fn(),
        error: vitest_1.vi.fn(),
        debugLargeJson: vitest_1.vi.fn(),
    },
}); });
// Mock configuration
vitest_1.vi.mock('@/configuration', function () { return ({
    configuration: {
        serverUrl: 'ws://localhost:3000',
    },
}); });
// Mock claudeCheckSession for session validation
var mockClaudeCheckSession = vitest_1.vi.fn();
vitest_1.vi.mock('@/claude/utils/claudeCheckSession', function () { return ({
    claudeCheckSession: function () {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        return mockClaudeCheckSession.apply(void 0, args);
    },
}); });
// Mock encryption - simulates encrypt/decrypt without actual crypto
vitest_1.vi.mock('@/api/encryption', function () { return ({
    encrypt: vitest_1.vi.fn(function (_key, _variant, data) {
        return new TextEncoder().encode(JSON.stringify(data));
    }),
    decrypt: vitest_1.vi.fn(function (_key, _variant, data) {
        try {
            return JSON.parse(new TextDecoder().decode(data));
        }
        catch (_a) {
            return null;
        }
    }),
    encodeBase64: vitest_1.vi.fn(function (data) {
        return Buffer.from(data).toString('base64');
    }),
    decodeBase64: vitest_1.vi.fn(function (data) {
        return new Uint8Array(Buffer.from(data, 'base64'));
    }),
}); });
// Mock common handlers (not relevant to revival tests)
vitest_1.vi.mock('@/modules/common/registerCommonHandlers', function () { return ({
    registerCommonHandlers: vitest_1.vi.fn(),
}); });
// Mock MCP config
vitest_1.vi.mock('@/mcp/config', function () { return ({
    buildMcpSyncState: vitest_1.vi.fn(function () { return ({}); }),
}); });
// Mock telemetry
var mockTrackEvent = vitest_1.vi.fn();
vitest_1.vi.mock('@/telemetry', function () { return ({
    trackEvent: function () {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        return mockTrackEvent.apply(void 0, args);
    },
}); });
// Create a mock socket for testing
var createMockSocket = function () { return ({
    on: vitest_1.vi.fn(),
    off: vitest_1.vi.fn(),
    onServer: vitest_1.vi.fn(),
    onRpcRequest: vitest_1.vi.fn(),
    connect: vitest_1.vi.fn(),
    close: vitest_1.vi.fn(),
    removeAllListeners: vitest_1.vi.fn(),
    connected: true,
    emit: vitest_1.vi.fn(),
    emitWithAck: vitest_1.vi.fn().mockResolvedValue({ result: 'success' }),
    emitClient: vitest_1.vi.fn(),
}); };
// Mock HappyWebSocket
vitest_1.vi.mock('./HappyWebSocket', function () {
    return {
        HappyWebSocket: vitest_1.vi.fn().mockImplementation(function () { return createMockSocket(); }),
    };
});
// Import RPC error codes
var RpcHandlerManager_1 = require("./rpc/RpcHandlerManager");
var apiMachine_1 = require("./apiMachine");
// Helper to create a base64-encoded encrypted response
function encryptedResponse(data) {
    return Buffer.from(JSON.stringify(data)).toString('base64');
}
// Helper to create a mock machine object
function createMockMachine(id) {
    if (id === void 0) { id = 'test-machine-id'; }
    return {
        id: id,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
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
(0, vitest_1.describe)('ApiMachineClient Session Revival', function () {
    var client;
    var mockToken = 'test-token';
    var testSessionId = 'bb6ca0a4-5734-4204-ada7-7aa2c27473c5';
    var testDirectory = '/test/directory';
    var newSessionId = 'cc7db1b5-6845-5315-beb8-8bb3d38584d6';
    // Mock RPC handlers
    var mockSpawnSession = vitest_1.vi.fn();
    var mockStopSession = vitest_1.vi.fn();
    var mockRequestShutdown = vitest_1.vi.fn();
    var mockGetSessionStatus = vitest_1.vi.fn();
    var mockGetSessionDirectory = vitest_1.vi.fn();
    var mockOnMachineDisconnected = vitest_1.vi.fn();
    // Mock socket stored for assertions
    var mockSocket;
    (0, vitest_1.beforeEach)(function () {
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.useFakeTimers();
        // Reset claudeCheckSession mock
        mockClaudeCheckSession.mockReturnValue(true);
        client = new apiMachine_1.ApiMachineClient(mockToken, createMockMachine());
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
        var clientAny = client;
        clientAny.socket = mockSocket;
    });
    (0, vitest_1.afterEach)(function () {
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.describe)('tryReviveSession()', function () {
        (0, vitest_1.it)('should return cached promise when revival already in progress for same session', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, deferred, promise1, promise2, result1, result2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        deferred = (function () {
                            var resolve = function () { };
                            var promise = new Promise(function (res) {
                                resolve = res;
                            });
                            return { promise: promise, resolve: resolve };
                        })();
                        mockSpawnSession.mockImplementation(function () { return deferred.promise; });
                        promise1 = clientAny.tryReviveSession(testSessionId, testDirectory);
                        promise2 = clientAny.tryReviveSession(testSessionId, testDirectory);
                        // spawnSession should only be called once due to deduplication
                        (0, vitest_1.expect)(mockSpawnSession).toHaveBeenCalledTimes(1);
                        // Complete the spawn via the deferred
                        deferred.resolve({ type: 'success', sessionId: newSessionId });
                        return [4 /*yield*/, vitest_1.vi.runAllTimersAsync()];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, promise1];
                    case 2:
                        result1 = _a.sent();
                        return [4 /*yield*/, promise2];
                    case 3:
                        result2 = _a.sent();
                        (0, vitest_1.expect)(result1).toEqual(result2);
                        (0, vitest_1.expect)(result1.revived).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should return error when RPC handlers not initialized', function () { return __awaiter(void 0, void 0, void 0, function () {
            var freshClient, clientAny, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        freshClient = new apiMachine_1.ApiMachineClient(mockToken, createMockMachine());
                        clientAny = freshClient;
                        return [4 /*yield*/, clientAny.tryReviveSession(testSessionId, testDirectory)];
                    case 1:
                        result = _a.sent();
                        (0, vitest_1.expect)(result.revived).toBe(false);
                        (0, vitest_1.expect)(result.originalSessionId).toBe(testSessionId);
                        (0, vitest_1.expect)(result.error).toBe('RPC handlers not initialized');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should update metrics on success', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // Verify initial metrics
                        (0, vitest_1.expect)(clientAny.revivalMetrics.attempted).toBe(0);
                        (0, vitest_1.expect)(clientAny.revivalMetrics.succeeded).toBe(0);
                        (0, vitest_1.expect)(clientAny.revivalMetrics.failed).toBe(0);
                        // Perform revival
                        return [4 /*yield*/, clientAny.tryReviveSession(testSessionId, testDirectory)];
                    case 1:
                        // Perform revival
                        _a.sent();
                        // Verify metrics updated
                        (0, vitest_1.expect)(clientAny.revivalMetrics.attempted).toBe(1);
                        (0, vitest_1.expect)(clientAny.revivalMetrics.succeeded).toBe(1);
                        (0, vitest_1.expect)(clientAny.revivalMetrics.failed).toBe(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should update metrics on failure', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // Make spawnSession fail
                        mockSpawnSession.mockResolvedValue({
                            type: 'error',
                            errorMessage: 'Session spawn failed',
                        });
                        // Perform revival
                        return [4 /*yield*/, clientAny.tryReviveSession(testSessionId, testDirectory)];
                    case 1:
                        // Perform revival
                        _a.sent();
                        // Verify metrics updated
                        (0, vitest_1.expect)(clientAny.revivalMetrics.attempted).toBe(1);
                        (0, vitest_1.expect)(clientAny.revivalMetrics.succeeded).toBe(0);
                        (0, vitest_1.expect)(clientAny.revivalMetrics.failed).toBe(1);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should clean up tracking map in finally block', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // Verify initial state
                        (0, vitest_1.expect)(clientAny.revivingSessionIds.size).toBe(0);
                        // Perform revival
                        return [4 /*yield*/, clientAny.tryReviveSession(testSessionId, testDirectory)];
                    case 1:
                        // Perform revival
                        _a.sent();
                        // Tracking should be cleaned up after completion
                        (0, vitest_1.expect)(clientAny.revivingSessionIds.size).toBe(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should clean up tracking map even on failure', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // Make spawnSession throw an error
                        mockSpawnSession.mockRejectedValue(new Error('Spawn crashed'));
                        return [4 /*yield*/, clientAny.tryReviveSession(testSessionId, testDirectory)];
                    case 1:
                        result = _a.sent();
                        (0, vitest_1.expect)(result.revived).toBe(false);
                        // Tracking should be cleaned up after failure
                        (0, vitest_1.expect)(clientAny.revivingSessionIds.size).toBe(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should clear per-session attempt counter on success', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // Set some prior attempts
                        clientAny.sessionRevivalAttempts.set(testSessionId, 1);
                        // Perform successful revival
                        return [4 /*yield*/, clientAny.tryReviveSession(testSessionId, testDirectory)];
                    case 1:
                        // Perform successful revival
                        _a.sent();
                        // Attempt counter should be cleared on success
                        (0, vitest_1.expect)(clientAny.sessionRevivalAttempts.has(testSessionId)).toBe(false);
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, vitest_1.describe)('executeSessionRevival()', function () {
        (0, vitest_1.it)('should return error when session is already active', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // Session is active
                        mockGetSessionStatus.mockReturnValue({ status: 'active' });
                        return [4 /*yield*/, clientAny.executeSessionRevival(testSessionId, testDirectory)];
                    case 1:
                        result = _a.sent();
                        (0, vitest_1.expect)(result.revived).toBe(false);
                        (0, vitest_1.expect)(result.originalSessionId).toBe(testSessionId);
                        (0, vitest_1.expect)(result.error).toBe('Session is already active');
                        // spawnSession should not have been called
                        (0, vitest_1.expect)(mockSpawnSession).not.toHaveBeenCalled();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should broadcast session-revived event on successful spawn', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        return [4 /*yield*/, clientAny.executeSessionRevival(testSessionId, testDirectory)];
                    case 1:
                        result = _a.sent();
                        (0, vitest_1.expect)(result.revived).toBe(true);
                        (0, vitest_1.expect)(result.newSessionId).toBe(newSessionId);
                        // Should have broadcast the event
                        (0, vitest_1.expect)(mockSocket.emitClient).toHaveBeenCalledWith('session-revived', {
                            originalSessionId: testSessionId,
                            newSessionId: newSessionId,
                            machineId: 'test-machine-id',
                        });
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should not broadcast if socket is not connected', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // Socket not connected
                        mockSocket.connected = false;
                        return [4 /*yield*/, clientAny.executeSessionRevival(testSessionId, testDirectory)];
                    case 1:
                        result = _a.sent();
                        (0, vitest_1.expect)(result.revived).toBe(true);
                        // Should NOT have broadcast the event
                        (0, vitest_1.expect)(mockSocket.emitClient).not.toHaveBeenCalled();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should not broadcast if new session ID is same as original', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // spawnSession returns same ID (unusual but possible)
                        mockSpawnSession.mockResolvedValue({
                            type: 'success',
                            sessionId: testSessionId, // Same as original
                        });
                        return [4 /*yield*/, clientAny.executeSessionRevival(testSessionId, testDirectory)];
                    case 1:
                        result = _a.sent();
                        (0, vitest_1.expect)(result.revived).toBe(true);
                        // Should NOT broadcast when session ID unchanged
                        (0, vitest_1.expect)(mockSocket.emitClient).not.toHaveBeenCalled();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should handle requestToApproveDirectoryCreation response', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        mockSpawnSession.mockResolvedValue({
                            type: 'requestToApproveDirectoryCreation',
                            directory: '/new/directory',
                        });
                        return [4 /*yield*/, clientAny.executeSessionRevival(testSessionId, testDirectory)];
                    case 1:
                        result = _a.sent();
                        (0, vitest_1.expect)(result.revived).toBe(false);
                        (0, vitest_1.expect)(result.error).toBe('Directory creation required but not approved: /new/directory');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should handle spawn error response', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        mockSpawnSession.mockResolvedValue({
                            type: 'error',
                            errorMessage: 'Claude process crashed',
                        });
                        return [4 /*yield*/, clientAny.executeSessionRevival(testSessionId, testDirectory)];
                    case 1:
                        result = _a.sent();
                        (0, vitest_1.expect)(result.revived).toBe(false);
                        (0, vitest_1.expect)(result.error).toBe('Claude process crashed');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should handle timeout correctly', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, resultPromise, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // Make spawnSession never resolve
                        mockSpawnSession.mockImplementation(function () { return new Promise(function () { }); });
                        resultPromise = clientAny.executeSessionRevival(testSessionId, testDirectory);
                        // Advance timer past the timeout (60 seconds default)
                        return [4 /*yield*/, vitest_1.vi.advanceTimersByTimeAsync(61000)];
                    case 1:
                        // Advance timer past the timeout (60 seconds default)
                        _a.sent();
                        return [4 /*yield*/, resultPromise];
                    case 2:
                        result = _a.sent();
                        (0, vitest_1.expect)(result.revived).toBe(false);
                        (0, vitest_1.expect)(result.error).toContain('timeout');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should continue revival if status check fails', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // Make status check throw
                        mockGetSessionStatus.mockImplementation(function () {
                            throw new Error('Status check failed');
                        });
                        return [4 /*yield*/, clientAny.executeSessionRevival(testSessionId, testDirectory)];
                    case 1:
                        result = _a.sent();
                        // Should still attempt revival despite status check failure
                        (0, vitest_1.expect)(mockSpawnSession).toHaveBeenCalled();
                        (0, vitest_1.expect)(result.revived).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should continue revival if claudeCheckSession returns false', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // Session file does not exist
                        mockClaudeCheckSession.mockReturnValue(false);
                        return [4 /*yield*/, clientAny.executeSessionRevival(testSessionId, testDirectory)];
                    case 1:
                        result = _a.sent();
                        // Should still attempt revival - spawnSession handles missing session files gracefully
                        (0, vitest_1.expect)(mockSpawnSession).toHaveBeenCalled();
                        (0, vitest_1.expect)(result.revived).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, vitest_1.describe)('handleRpcWithRevival()', function () {
        (0, vitest_1.it)('should return original response if not SESSION_NOT_ACTIVE error', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, successResponse, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        successResponse = encryptedResponse({ result: 'success', data: 'test' });
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockResolvedValue(successResponse);
                        return [4 /*yield*/, clientAny.handleRpcWithRevival({
                                method: "".concat(testSessionId, ":testMethod"),
                                params: 'encrypted-params',
                            })];
                    case 1:
                        result = _a.sent();
                        // Should return original response unchanged
                        (0, vitest_1.expect)(result).toBe(successResponse);
                        // spawnSession should not have been called
                        (0, vitest_1.expect)(mockSpawnSession).not.toHaveBeenCalled();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should return original response for non-session-scoped method format', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, errorResponse, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        errorResponse = encryptedResponse({
                            error: 'Session not active',
                            code: RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
                        });
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockResolvedValue(errorResponse);
                        return [4 /*yield*/, clientAny.handleRpcWithRevival({
                                method: 'shortprefix:testMethod', // Not a valid session ID format
                                params: 'encrypted-params',
                            })];
                    case 1:
                        result = _a.sent();
                        // Should return original response - no revival attempt
                        (0, vitest_1.expect)(result).toBe(errorResponse);
                        (0, vitest_1.expect)(mockSpawnSession).not.toHaveBeenCalled();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should detect SESSION_NOT_ACTIVE and trigger revival', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, errorResponse, successResponse, callCount;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        errorResponse = encryptedResponse({
                            error: 'Session not active',
                            code: RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
                        });
                        successResponse = encryptedResponse({ result: 'success' });
                        callCount = 0;
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockImplementation(function () {
                            callCount++;
                            if (callCount === 1) {
                                return Promise.resolve(errorResponse);
                            }
                            return Promise.resolve(successResponse);
                        });
                        // Mock getSessionStatus to return active after revival
                        mockGetSessionStatus.mockImplementation(function (sessionId) {
                            // First call for the stopped session
                            if (sessionId === testSessionId) {
                                return { status: 'unknown' };
                            }
                            // After revival, new session is active
                            return { status: 'active' };
                        });
                        return [4 /*yield*/, clientAny.handleRpcWithRevival({
                                method: "".concat(testSessionId, ":testMethod"),
                                params: 'encrypted-params',
                            })];
                    case 1:
                        _a.sent();
                        // Should have triggered revival
                        (0, vitest_1.expect)(mockSpawnSession).toHaveBeenCalledWith({
                            directory: testDirectory,
                            sessionId: testSessionId,
                        });
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should return SESSION_REVIVAL_FAILED on failed revival', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, errorResponse, result, decoded;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        errorResponse = encryptedResponse({
                            error: 'Session not active',
                            code: RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
                        });
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockResolvedValue(errorResponse);
                        // Make revival fail
                        mockSpawnSession.mockResolvedValue({
                            type: 'error',
                            errorMessage: 'Revival failed due to timeout',
                        });
                        return [4 /*yield*/, clientAny.handleRpcWithRevival({
                                method: "".concat(testSessionId, ":testMethod"),
                                params: 'encrypted-params',
                            })];
                    case 1:
                        result = _a.sent();
                        decoded = JSON.parse(Buffer.from(result, 'base64').toString());
                        (0, vitest_1.expect)(decoded.code).toBe(RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_REVIVAL_FAILED);
                        (0, vitest_1.expect)(decoded.error).toContain('Session revival failed');
                        (0, vitest_1.expect)(decoded.originalSessionId).toBe(testSessionId);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should replay command on successful revival', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, errorResponse, successResponse, callCount, statusCallCount, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        errorResponse = encryptedResponse({
                            error: 'Session not active',
                            code: RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
                        });
                        successResponse = encryptedResponse({ result: 'success', replayed: true });
                        callCount = 0;
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockImplementation(function (request) {
                            callCount++;
                            if (callCount === 1) {
                                return Promise.resolve(errorResponse);
                            }
                            // Second call should use the new session ID
                            (0, vitest_1.expect)(request.method).toBe("".concat(newSessionId, ":testMethod"));
                            return Promise.resolve(successResponse);
                        });
                        statusCallCount = 0;
                        mockGetSessionStatus.mockImplementation(function (sessionId) {
                            statusCallCount++;
                            // Original session check in executeSessionRevival returns 'unknown'
                            if (sessionId === testSessionId) {
                                return { status: 'unknown' };
                            }
                            // New session check in handleRpcWithRevival returns 'active'
                            return { status: 'active' };
                        });
                        return [4 /*yield*/, clientAny.handleRpcWithRevival({
                                method: "".concat(testSessionId, ":testMethod"),
                                params: 'encrypted-params',
                            })];
                    case 1:
                        result = _a.sent();
                        // Should have replayed with new session ID
                        (0, vitest_1.expect)(result).toBe(successResponse);
                        (0, vitest_1.expect)(clientAny.rpcHandlerManager.handleRequest).toHaveBeenCalledTimes(2);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should handle decryption errors gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, malformedResponse, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        malformedResponse = 'not-valid-base64!!!';
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockResolvedValue(malformedResponse);
                        return [4 /*yield*/, clientAny.handleRpcWithRevival({
                                method: "".concat(testSessionId, ":testMethod"),
                                params: 'encrypted-params',
                            })];
                    case 1:
                        result = _a.sent();
                        // Should return original response on decryption failure
                        (0, vitest_1.expect)(result).toBe(malformedResponse);
                        // Should not attempt revival
                        (0, vitest_1.expect)(mockSpawnSession).not.toHaveBeenCalled();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should skip revival for killSession method', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, errorResponse, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        errorResponse = encryptedResponse({
                            error: 'Session not active',
                            code: RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
                        });
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockResolvedValue(errorResponse);
                        return [4 /*yield*/, clientAny.handleRpcWithRevival({
                                method: "".concat(testSessionId, ":killSession"),
                                params: 'encrypted-params',
                            })];
                    case 1:
                        result = _a.sent();
                        // Should return original error - no revival for kill requests
                        (0, vitest_1.expect)(result).toBe(errorResponse);
                        (0, vitest_1.expect)(mockSpawnSession).not.toHaveBeenCalled();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should skip revival for archived sessions', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, errorResponse, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        // Mark session as archived (normalizeSessionId returns lowercase UUID with hyphens)
                        clientAny.archivedSessionIds.add(testSessionId.toLowerCase());
                        errorResponse = encryptedResponse({
                            error: 'Session not active',
                            code: RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
                        });
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockResolvedValue(errorResponse);
                        return [4 /*yield*/, clientAny.handleRpcWithRevival({
                                method: "".concat(testSessionId, ":testMethod"),
                                params: 'encrypted-params',
                            })];
                    case 1:
                        result = _a.sent();
                        // Should return original error - no revival for archived sessions
                        (0, vitest_1.expect)(result).toBe(errorResponse);
                        (0, vitest_1.expect)(mockSpawnSession).not.toHaveBeenCalled();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should use stored directory from getSessionDirectory', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, errorResponse, successResponse, callCount, storedDir;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        errorResponse = encryptedResponse({
                            error: 'Session not active',
                            code: RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
                        });
                        successResponse = encryptedResponse({ result: 'success' });
                        callCount = 0;
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockImplementation(function () {
                            callCount++;
                            return callCount === 1 ? Promise.resolve(errorResponse) : Promise.resolve(successResponse);
                        });
                        storedDir = '/custom/stored/directory';
                        mockGetSessionDirectory.mockReturnValue(storedDir);
                        // Return 'unknown' for original session so executeSessionRevival proceeds,
                        // then 'active' for new session so handler-ready check passes
                        mockGetSessionStatus.mockImplementation(function (sessionId) {
                            if (sessionId === testSessionId) {
                                return { status: 'unknown' };
                            }
                            return { status: 'active' };
                        });
                        return [4 /*yield*/, clientAny.handleRpcWithRevival({
                                method: "".concat(testSessionId, ":testMethod"),
                                params: 'encrypted-params',
                            })];
                    case 1:
                        _a.sent();
                        // Should have used the stored directory
                        (0, vitest_1.expect)(mockSpawnSession).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
                            directory: storedDir,
                        }));
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should fall back to cwd when no stored directory', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, errorResponse, successResponse, callCount;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        errorResponse = encryptedResponse({
                            error: 'Session not active',
                            code: RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
                        });
                        successResponse = encryptedResponse({ result: 'success' });
                        callCount = 0;
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockImplementation(function () {
                            callCount++;
                            return callCount === 1 ? Promise.resolve(errorResponse) : Promise.resolve(successResponse);
                        });
                        // No stored directory
                        mockGetSessionDirectory.mockReturnValue(undefined);
                        // Return 'unknown' for original session so executeSessionRevival proceeds,
                        // then 'active' for new session so handler-ready check passes
                        mockGetSessionStatus.mockImplementation(function (sessionId) {
                            if (sessionId === testSessionId) {
                                return { status: 'unknown' };
                            }
                            return { status: 'active' };
                        });
                        return [4 /*yield*/, clientAny.handleRpcWithRevival({
                                method: "".concat(testSessionId, ":testMethod"),
                                params: 'encrypted-params',
                            })];
                    case 1:
                        _a.sent();
                        // Should have used process.cwd() as fallback
                        (0, vitest_1.expect)(mockSpawnSession).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
                            directory: process.cwd(),
                        }));
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, vitest_1.describe)('Integration scenarios', function () {
        (0, vitest_1.it)('should handle multiple concurrent RPC calls to stopped session', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, errorResponse, successResponse, callCount, promises;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        errorResponse = encryptedResponse({
                            error: 'Session not active',
                            code: RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
                        });
                        successResponse = encryptedResponse({ result: 'success' });
                        callCount = 0;
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockImplementation(function (request) {
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
                        mockGetSessionStatus.mockImplementation(function (sessionId) {
                            if (sessionId === testSessionId) {
                                return { status: 'unknown' };
                            }
                            return { status: 'active' };
                        });
                        promises = [
                            clientAny.handleRpcWithRevival({ method: "".concat(testSessionId, ":method1"), params: 'p1' }),
                            clientAny.handleRpcWithRevival({ method: "".concat(testSessionId, ":method2"), params: 'p2' }),
                            clientAny.handleRpcWithRevival({ method: "".concat(testSessionId, ":method3"), params: 'p3' }),
                        ];
                        // Let them all run
                        return [4 /*yield*/, vitest_1.vi.runAllTimersAsync()];
                    case 1:
                        // Let them all run
                        _a.sent();
                        return [4 /*yield*/, Promise.all(promises)];
                    case 2:
                        _a.sent();
                        // spawnSession should only be called ONCE due to concurrent revival prevention
                        (0, vitest_1.expect)(mockSpawnSession).toHaveBeenCalledTimes(1);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should emit telemetry events during revival flow', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        mockTrackEvent.mockClear();
                        // Perform successful revival
                        return [4 /*yield*/, clientAny.tryReviveSession(testSessionId, testDirectory)];
                    case 1:
                        // Perform successful revival
                        _a.sent();
                        // Should have emitted attempt and success events
                        (0, vitest_1.expect)(mockTrackEvent).toHaveBeenCalledWith('session_revival_attempt', vitest_1.expect.anything());
                        (0, vitest_1.expect)(mockTrackEvent).toHaveBeenCalledWith('session_revival_success', vitest_1.expect.anything());
                        return [2 /*return*/];
                }
            });
        }); });
        (0, vitest_1.it)('should wait for handler to be ready before replaying command', function () { return __awaiter(void 0, void 0, void 0, function () {
            var clientAny, errorResponse, successResponse, callCount, statusCallCount, resultPromise, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        clientAny = client;
                        errorResponse = encryptedResponse({
                            error: 'Session not active',
                            code: RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
                        });
                        successResponse = encryptedResponse({ result: 'success' });
                        callCount = 0;
                        clientAny.rpcHandlerManager.handleRequest = vitest_1.vi.fn().mockImplementation(function () {
                            callCount++;
                            return callCount === 1 ? Promise.resolve(errorResponse) : Promise.resolve(successResponse);
                        });
                        statusCallCount = 0;
                        mockGetSessionStatus.mockImplementation(function () {
                            statusCallCount++;
                            // After revival starts, first few checks show unknown
                            if (statusCallCount <= 2) {
                                return { status: 'unknown' };
                            }
                            // Eventually active
                            return { status: 'active' };
                        });
                        resultPromise = clientAny.handleRpcWithRevival({
                            method: "".concat(testSessionId, ":testMethod"),
                            params: 'encrypted-params',
                        });
                        // Run timers to allow polling
                        return [4 /*yield*/, vitest_1.vi.runAllTimersAsync()];
                    case 1:
                        // Run timers to allow polling
                        _a.sent();
                        return [4 /*yield*/, resultPromise];
                    case 2:
                        result = _a.sent();
                        // Should have succeeded after waiting for handler
                        (0, vitest_1.expect)(result).toBe(successResponse);
                        // Should have polled for handler readiness
                        (0, vitest_1.expect)(statusCallCount).toBeGreaterThan(1);
                        return [2 /*return*/];
                }
            });
        }); });
    });
});
