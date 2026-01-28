"use strict";
/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 *
 * @see HAP-261 - Migrated from Socket.io to native WebSocket
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
exports.ApiMachineClient = void 0;
var errors_1 = require("@/utils/errors");
var protocol_1 = require("@happy/protocol");
var logger_1 = require("@/ui/logger");
var configuration_1 = require("@/configuration");
var registerCommonHandlers_1 = require("../modules/common/registerCommonHandlers");
var encryption_1 = require("./encryption");
var time_1 = require("@/utils/time");
var RpcHandlerManager_1 = require("./rpc/RpcHandlerManager");
var HappyWebSocket_1 = require("./HappyWebSocket");
var config_1 = require("@/mcp/config");
var telemetry_1 = require("@/telemetry");
// Keep-alive timing configuration (prevents thundering herd on reconnection)
var KEEP_ALIVE_BASE_INTERVAL_MS = 20000; // 20 seconds base interval
var KEEP_ALIVE_JITTER_MAX_MS = 5000; // 0-5 seconds random jitter
// Session revival configuration (HAP-733, HAP-782)
var SESSION_REVIVAL_TIMEOUT_MS = parseInt(process.env.HAPPY_SESSION_REVIVAL_TIMEOUT || '60000', 10);
var SESSION_REVIVAL_MAX_ATTEMPTS = (function () {
    var value = parseInt(process.env.HAPPY_SESSION_REVIVAL_MAX_ATTEMPTS || '3', 10);
    if (Number.isNaN(value) || value < 1) {
        return 3; // Default to 3 if invalid
    }
    return value;
})();
var sessionValidation_1 = require("@/claude/utils/sessionValidation");
var claudeCheckSession_1 = require("@/claude/utils/claudeCheckSession");
var ApiMachineClient = /** @class */ (function () {
    function ApiMachineClient(token, machine) {
        this.token = token;
        this.machine = machine;
        this.keepAliveInterval = null;
        this.isShuttingDown = false;
        /**
         * Track sessions currently being revived to prevent concurrent revival attempts.
         * Maps session ID -> Promise that resolves when revival completes.
         *
         * @see HAP-733 - Automatic session revival
         */
        this.revivingSessionIds = new Map();
        /**
         * RPC handlers provided by daemon - stored for revival access
         * @see HAP-733
         */
        this.rpcHandlers = null;
        /**
         * Telemetry counters for session revival
         * @see HAP-733
         */
        this.revivalMetrics = {
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
         * @see HAP-782 - Made configurable via HAPPY_SESSION_REVIVAL_MAX_ATTEMPTS
         */
        this.sessionRevivalAttempts = new Map();
        this.MAX_REVIVAL_ATTEMPTS_PER_SESSION = SESSION_REVIVAL_MAX_ATTEMPTS;
        /**
         * Global revival cooldown tracking to prevent cascade failures.
         * Tracks timestamps of recent revival failures in a sliding window.
         *
         * @see HAP-744 - Fix session revival race condition causing infinite loop
         */
        this.revivalFailureTimestamps = [];
        this.revivalCooldownUntil = 0;
        this.COOLDOWN_WINDOW_MS = 30000; // 30 seconds
        this.COOLDOWN_FAILURE_THRESHOLD = 10; // 10 failures in window
        this.COOLDOWN_DURATION_MS = 60000; // 60 second cooldown
        /**
         * Tracks sessions that were archived remotely to prevent revival attempts.
         */
        this.archivedSessionIds = new Set();
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager_1.RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: function (msg, data) { return logger_1.logger.debug(msg, data); }
        });
        (0, registerCommonHandlers_1.registerCommonHandlers)(this.rpcHandlerManager, process.cwd());
    }
    ApiMachineClient.prototype.setRPCHandlers = function (_a) {
        var _this = this;
        var spawnSession = _a.spawnSession, stopSession = _a.stopSession, requestShutdown = _a.requestShutdown, getSessionStatus = _a.getSessionStatus, getSessionDirectory = _a.getSessionDirectory, onMachineDisconnected = _a.onMachineDisconnected;
        // Store handlers for revival access (HAP-733, HAP-740, HAP-781)
        this.rpcHandlers = { spawnSession: spawnSession, stopSession: stopSession, requestShutdown: requestShutdown, getSessionStatus: getSessionStatus, getSessionDirectory: getSessionDirectory, onMachineDisconnected: onMachineDisconnected };
        this.rpcHandlerManager.registerHandler('spawn-happy-session', function (params, _signal) { return __awaiter(_this, void 0, void 0, function () {
            var _a, directory, sessionId, machineId, approvedNewDirectoryCreation, agent, token, result;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _a = params !== null && params !== void 0 ? params : {}, directory = _a.directory, sessionId = _a.sessionId, machineId = _a.machineId, approvedNewDirectoryCreation = _a.approvedNewDirectoryCreation, agent = _a.agent, token = _a.token;
                        logger_1.logger.debug("[API MACHINE] Spawning session with params: ".concat(JSON.stringify(params)));
                        if (!directory) {
                            throw new errors_1.AppError(errors_1.ErrorCodes.DIRECTORY_REQUIRED, 'Directory is required');
                        }
                        return [4 /*yield*/, spawnSession({ directory: directory, sessionId: sessionId, machineId: machineId, approvedNewDirectoryCreation: approvedNewDirectoryCreation, agent: agent, token: token })];
                    case 1:
                        result = _b.sent();
                        switch (result.type) {
                            case 'success':
                                logger_1.logger.debug("[API MACHINE] Spawned session ".concat(result.sessionId).concat(result.resumedFrom ? " (resumed from ".concat(result.resumedFrom, ")") : '').concat(result.message ? " (".concat(result.message, ")") : ''));
                                // HAP-691: Include resumedFrom to allow app to link old and new sessions
                                return [2 /*return*/, { type: 'success', sessionId: result.sessionId, resumedFrom: result.resumedFrom, message: result.message }];
                            case 'requestToApproveDirectoryCreation':
                                logger_1.logger.debug("[API MACHINE] Requesting directory creation approval for: ".concat(result.directory));
                                return [2 /*return*/, { type: 'requestToApproveDirectoryCreation', directory: result.directory }];
                            case 'error':
                                throw new errors_1.AppError(errors_1.ErrorCodes.OPERATION_FAILED, result.errorMessage);
                        }
                        return [2 /*return*/];
                }
            });
        }); });
        this.rpcHandlerManager.registerHandler('stop-session', function (params, _signal) {
            var sessionId = (params !== null && params !== void 0 ? params : {}).sessionId;
            if (!sessionId) {
                throw new errors_1.AppError(errors_1.ErrorCodes.INVALID_INPUT, 'Session ID is required');
            }
            var success = stopSession(sessionId);
            if (!success) {
                throw new errors_1.AppError(errors_1.ErrorCodes.SESSION_NOT_FOUND, 'Session not found or failed to stop');
            }
            logger_1.logger.debug("[API MACHINE] Stopped session ".concat(sessionId));
            return { message: 'Session stopped' };
        });
        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', function (_params, _signal) {
            logger_1.logger.debug('[API MACHINE] Received stop-daemon RPC request');
            // Trigger shutdown callback after a delay
            setTimeout(function () {
                logger_1.logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);
            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });
        this.rpcHandlerManager.registerHandler('get-session-status', function (params, _signal) {
            var sessionId = (params !== null && params !== void 0 ? params : {}).sessionId;
            if (!sessionId) {
                throw new errors_1.AppError(errors_1.ErrorCodes.INVALID_INPUT, 'Session ID is required');
            }
            // Validate session ID format (accepts both UUID and hex)
            if (!(0, sessionValidation_1.isValidSessionId)(sessionId)) {
                throw new errors_1.AppError(errors_1.ErrorCodes.INVALID_INPUT, "Invalid session ID format: expected UUID or hex (32 chars), got \"".concat(sessionId.substring(0, 50), "\""));
            }
            // Normalize to UUID format for consistent comparison
            var normalizedId = (0, sessionValidation_1.normalizeSessionId)(sessionId);
            var result = getSessionStatus(normalizedId);
            logger_1.logger.debug("[API MACHINE] get-session-status: ".concat(sessionId, " -> ").concat(result.status));
            return result;
        });
    };
    /**
     * Check if global revival cooldown is active.
     * Cooldown is triggered when too many failures occur in a short window.
     *
     * @see HAP-744 - Fix session revival race condition causing infinite loop
     */
    ApiMachineClient.prototype.isRevivalCooldownActive = function () {
        var _this = this;
        var now = Date.now();
        // Check if we're in an active cooldown period
        if (this.revivalCooldownUntil > now) {
            return true;
        }
        // Clean up old timestamps outside the sliding window
        this.revivalFailureTimestamps = this.revivalFailureTimestamps.filter(function (ts) { return now - ts < _this.COOLDOWN_WINDOW_MS; });
        return false;
    };
    /**
     * Record a revival failure and potentially trigger cooldown.
     *
     * @see HAP-744 - Fix session revival race condition causing infinite loop
     * @see HAP-783 - Add telemetry emission when circuit breaker trips
     */
    ApiMachineClient.prototype.recordRevivalFailure = function () {
        var _this = this;
        var now = Date.now();
        this.revivalFailureTimestamps.push(now);
        // Clean up old timestamps
        this.revivalFailureTimestamps = this.revivalFailureTimestamps.filter(function (ts) { return now - ts < _this.COOLDOWN_WINDOW_MS; });
        // Check if we've exceeded the threshold
        if (this.revivalFailureTimestamps.length >= this.COOLDOWN_FAILURE_THRESHOLD) {
            this.revivalCooldownUntil = now + this.COOLDOWN_DURATION_MS;
            logger_1.logger.debug("[API MACHINE] [REVIVAL] Circuit breaker triggered: ".concat(this.revivalFailureTimestamps.length, " failures in ").concat(this.COOLDOWN_WINDOW_MS, "ms window, pausing revivals for ").concat(this.COOLDOWN_DURATION_MS, "ms"));
            // HAP-783: Emit telemetry when global cooldown triggers
            (0, telemetry_1.trackEvent)('session_revival_cooldown_triggered', {
                failureCount: this.revivalFailureTimestamps.length,
                cooldownDurationMs: this.COOLDOWN_DURATION_MS,
                windowMs: this.COOLDOWN_WINDOW_MS,
                threshold: this.COOLDOWN_FAILURE_THRESHOLD,
            });
        }
    };
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
    ApiMachineClient.prototype.tryReviveSession = function (sessionId, directory) {
        return __awaiter(this, void 0, void 0, function () {
            var remainingMs, attempts, existingRevival, revivalPromise, result;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        // HAP-744: Check global cooldown first
                        if (this.isRevivalCooldownActive()) {
                            remainingMs = this.revivalCooldownUntil - Date.now();
                            logger_1.logger.debug("[API MACHINE] [REVIVAL] Global cooldown active, ".concat(remainingMs, "ms remaining. Rejecting revival for ").concat(sessionId.substring(0, 8), "..."));
                            // HAP-784: Notify mobile app about cooldown state
                            if ((_a = this.socket) === null || _a === void 0 ? void 0 : _a.connected) {
                                this.socket.emitClient('session-revival-paused', {
                                    reason: 'circuit_breaker',
                                    remainingMs: remainingMs,
                                    resumesAt: this.revivalCooldownUntil,
                                    machineId: this.machine.id
                                });
                                logger_1.logger.debug("[API MACHINE] [REVIVAL] Broadcast session-revival-paused event");
                            }
                            return [2 /*return*/, {
                                    revived: false,
                                    originalSessionId: sessionId,
                                    error: "Revival paused: circuit breaker active (".concat(Math.ceil(remainingMs / 1000), "s remaining)")
                                }];
                        }
                        attempts = this.sessionRevivalAttempts.get(sessionId) || 0;
                        if (attempts >= this.MAX_REVIVAL_ATTEMPTS_PER_SESSION) {
                            logger_1.logger.debug("[API MACHINE] [REVIVAL] Max attempts (".concat(this.MAX_REVIVAL_ATTEMPTS_PER_SESSION, ") exceeded for session ").concat(sessionId.substring(0, 8), "..."));
                            // HAP-783: Emit telemetry when per-session limit exceeded
                            (0, telemetry_1.trackEvent)('session_revival_limit_exceeded', {
                                attempts: attempts,
                                maxAttempts: this.MAX_REVIVAL_ATTEMPTS_PER_SESSION,
                            });
                            return [2 /*return*/, {
                                    revived: false,
                                    originalSessionId: sessionId,
                                    error: "Max revival attempts (".concat(this.MAX_REVIVAL_ATTEMPTS_PER_SESSION, ") exceeded for this session")
                                }];
                        }
                        existingRevival = this.revivingSessionIds.get(sessionId);
                        if (existingRevival) {
                            logger_1.logger.debug("[API MACHINE] [REVIVAL] Session ".concat(sessionId.substring(0, 8), "... revival already in progress, waiting"));
                            return [2 /*return*/, existingRevival];
                        }
                        // Ensure handlers are available
                        if (!this.rpcHandlers) {
                            return [2 /*return*/, {
                                    revived: false,
                                    originalSessionId: sessionId,
                                    error: 'RPC handlers not initialized'
                                }];
                        }
                        // HAP-744: Increment per-session attempt counter
                        this.sessionRevivalAttempts.set(sessionId, attempts + 1);
                        this.revivalMetrics.attempted++;
                        logger_1.logger.debug("[API MACHINE] [REVIVAL] Attempting revival for session ".concat(sessionId.substring(0, 8), "... (attempt #").concat(attempts + 1, "/").concat(this.MAX_REVIVAL_ATTEMPTS_PER_SESSION, ", global #").concat(this.revivalMetrics.attempted, ")"));
                        // HAP-783: Emit telemetry for revival attempt
                        (0, telemetry_1.trackEvent)('session_revival_attempt', {
                            attemptNumber: attempts + 1,
                            maxAttempts: this.MAX_REVIVAL_ATTEMPTS_PER_SESSION,
                            globalAttemptCount: this.revivalMetrics.attempted,
                        });
                        revivalPromise = this.executeSessionRevival(sessionId, directory);
                        // Track it to prevent concurrent attempts
                        this.revivingSessionIds.set(sessionId, revivalPromise);
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, , 3, 4]);
                        return [4 /*yield*/, revivalPromise];
                    case 2:
                        result = _c.sent();
                        // Update metrics
                        if (result.revived) {
                            this.revivalMetrics.succeeded++;
                            // HAP-744: Clear attempt counter on success
                            this.sessionRevivalAttempts.delete(sessionId);
                            logger_1.logger.debug("[API MACHINE] [REVIVAL] Session ".concat(sessionId.substring(0, 8), "... revived successfully -> ").concat((_b = result.newSessionId) === null || _b === void 0 ? void 0 : _b.substring(0, 8), "..."));
                            // HAP-783: Emit telemetry for successful revival
                            (0, telemetry_1.trackEvent)('session_revival_success', {
                                successCount: this.revivalMetrics.succeeded,
                                totalAttempts: this.revivalMetrics.attempted,
                                successRate: this.revivalMetrics.attempted > 0
                                    ? this.revivalMetrics.succeeded / this.revivalMetrics.attempted
                                    : 0,
                            });
                        }
                        else {
                            this.revivalMetrics.failed++;
                            // HAP-744: Record failure for circuit breaker
                            this.recordRevivalFailure();
                            logger_1.logger.debug("[API MACHINE] [REVIVAL] Session ".concat(sessionId.substring(0, 8), "... revival failed: ").concat(result.error));
                            // HAP-783: Emit telemetry for failed revival
                            (0, telemetry_1.trackEvent)('session_revival_failure', {
                                failureCount: this.revivalMetrics.failed,
                                totalAttempts: this.revivalMetrics.attempted,
                                failureRate: this.revivalMetrics.attempted > 0
                                    ? this.revivalMetrics.failed / this.revivalMetrics.attempted
                                    : 0,
                                reason: result.error,
                            });
                        }
                        return [2 /*return*/, result];
                    case 3:
                        // Always clean up tracking
                        this.revivingSessionIds.delete(sessionId);
                        return [7 /*endfinally*/];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Execute the actual session revival logic.
     * Separated from tryReviveSession for cleaner code organization.
     *
     * @see HAP-733
     */
    ApiMachineClient.prototype.executeSessionRevival = function (sessionId, directory) {
        return __awaiter(this, void 0, void 0, function () {
            var statusResult, hasValidContent, timeoutPromise, spawnPromise, spawnResult, error_1;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        // Step 1: Check if session is archived (don't revive archived sessions)
                        try {
                            statusResult = this.rpcHandlers.getSessionStatus(sessionId);
                            // Only revive sessions that are truly stopped, not archived
                            // Note: Currently getSessionStatus only returns 'active' or 'unknown'
                            // 'unknown' means the session is not currently running, which is what we want to revive
                            if (statusResult.status === 'active') {
                                // Session is actually active - shouldn't be trying to revive
                                return [2 /*return*/, {
                                        revived: false,
                                        originalSessionId: sessionId,
                                        error: 'Session is already active'
                                    }];
                            }
                            // If we had 'archived' status tracking, we would check here:
                            // if (statusResult.status === 'archived') {
                            //     return { revived: false, originalSessionId: sessionId, error: 'Cannot revive archived session' };
                            // }
                        }
                        catch (error) {
                            logger_1.logger.debug("[API MACHINE] [REVIVAL] Failed to check session status: ".concat(error instanceof Error ? error.message : 'Unknown error'));
                            // Continue with revival attempt even if status check fails
                        }
                        // Step 2: Check if session has valid content for informational logging
                        // Note: spawnSession now handles the case where session file doesn't exist gracefully
                        // by starting a new session without --resume. We just log here for debugging.
                        try {
                            hasValidContent = (0, claudeCheckSession_1.claudeCheckSession)(sessionId, directory);
                            if (!hasValidContent) {
                                logger_1.logger.warn("[API MACHINE] [REVIVAL] Session ".concat(sessionId.substring(0, 8), "... file not found locally, will start a new session"));
                                // Continue with revival - spawnSession will handle this gracefully
                            }
                            else {
                                logger_1.logger.debug("[API MACHINE] [REVIVAL] Session ".concat(sessionId.substring(0, 8), "... has valid content, proceeding with revival"));
                            }
                        }
                        catch (error) {
                            logger_1.logger.warn("[API MACHINE] [REVIVAL] Failed to validate session content: ".concat(error instanceof Error ? error.message : 'Unknown error'));
                            // Continue with revival attempt - spawnSession will handle any issues
                        }
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, , 4]);
                        timeoutPromise = new Promise(function (_, reject) {
                            setTimeout(function () {
                                reject(new Error("Revival timeout after ".concat(SESSION_REVIVAL_TIMEOUT_MS, "ms")));
                            }, SESSION_REVIVAL_TIMEOUT_MS);
                        });
                        spawnPromise = this.rpcHandlers.spawnSession({
                            directory: directory,
                            sessionId: sessionId,
                        });
                        return [4 /*yield*/, Promise.race([spawnPromise, timeoutPromise])];
                    case 2:
                        spawnResult = _b.sent();
                        if (spawnResult.type === 'success') {
                            // Step 4: Broadcast session:updated event to connected clients
                            // Note: The mobile app will receive this via the WebSocket connection
                            // and should update its session reference accordingly
                            if (((_a = this.socket) === null || _a === void 0 ? void 0 : _a.connected) && spawnResult.sessionId !== sessionId) {
                                this.socket.emitClient('session-revived', {
                                    originalSessionId: sessionId,
                                    newSessionId: spawnResult.sessionId,
                                    machineId: this.machine.id
                                });
                                logger_1.logger.debug("[API MACHINE] [REVIVAL] Broadcast session-revived event");
                            }
                            return [2 /*return*/, {
                                    revived: true,
                                    newSessionId: spawnResult.sessionId,
                                    originalSessionId: sessionId,
                                    commandReplayed: false // Command replay happens in handleRpcWithRevival
                                }];
                        }
                        else if (spawnResult.type === 'requestToApproveDirectoryCreation') {
                            return [2 /*return*/, {
                                    revived: false,
                                    originalSessionId: sessionId,
                                    error: "Directory creation required but not approved: ".concat(spawnResult.directory)
                                }];
                        }
                        else {
                            return [2 /*return*/, {
                                    revived: false,
                                    originalSessionId: sessionId,
                                    error: spawnResult.errorMessage
                                }];
                        }
                        return [3 /*break*/, 4];
                    case 3:
                        error_1 = _b.sent();
                        return [2 /*return*/, {
                                revived: false,
                                originalSessionId: sessionId,
                                error: error_1 instanceof Error ? error_1.message : 'Unknown error during revival'
                            }];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
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
    ApiMachineClient.prototype.handleRpcWithRevival = function (request) {
        return __awaiter(this, void 0, void 0, function () {
            var initialResponse, decryptedResponse, methodParts, sessionId, methodName, normalizedSessionId, storedDirectory, directory, revivalResult, errorResponse, newMethod, POLL_INTERVAL_MS_1, MAX_WAIT_MS, waited, handlerReady, status_1, replayResponse, decryptedReplayResponse, error_2;
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0: return [4 /*yield*/, this.rpcHandlerManager.handleRequest(request)];
                    case 1:
                        initialResponse = _d.sent();
                        _d.label = 2;
                    case 2:
                        _d.trys.push([2, 8, , 9]);
                        decryptedResponse = (0, encryption_1.decrypt)(this.machine.encryptionKey, this.machine.encryptionVariant, (0, encryption_1.decodeBase64)(initialResponse));
                        // If not an error or not SESSION_NOT_ACTIVE, return original response
                        if (!decryptedResponse || !decryptedResponse.code || decryptedResponse.code !== RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_NOT_ACTIVE) {
                            return [2 /*return*/, initialResponse];
                        }
                        methodParts = request.method.split(':');
                        if (methodParts.length !== 2) {
                            // Not a session-scoped method, return original error
                            return [2 /*return*/, initialResponse];
                        }
                        sessionId = methodParts[0];
                        methodName = methodParts[1];
                        // Validate session ID format
                        if (!(0, sessionValidation_1.isValidSessionId)(sessionId)) {
                            logger_1.logger.debug("[API MACHINE] [REVIVAL] Invalid session ID format in method: ".concat(request.method));
                            return [2 /*return*/, initialResponse];
                        }
                        normalizedSessionId = (0, sessionValidation_1.normalizeSessionId)(sessionId);
                        // Never revive sessions on explicit archive/kill requests
                        if (methodName === 'killSession') {
                            return [2 /*return*/, initialResponse];
                        }
                        // Skip revival if the session has been archived remotely
                        if (this.archivedSessionIds.has(normalizedSessionId)) {
                            return [2 /*return*/, initialResponse];
                        }
                        logger_1.logger.debug("[API MACHINE] [REVIVAL] Detected SESSION_NOT_ACTIVE for ".concat(sessionId.substring(0, 8), "...:").concat(methodName));
                        storedDirectory = (_a = this.rpcHandlers) === null || _a === void 0 ? void 0 : _a.getSessionDirectory(sessionId);
                        directory = storedDirectory !== null && storedDirectory !== void 0 ? storedDirectory : process.cwd();
                        if (storedDirectory) {
                            logger_1.logger.debug("[API MACHINE] [REVIVAL] Using stored directory: ".concat(storedDirectory));
                        }
                        else {
                            logger_1.logger.debug("[API MACHINE] [REVIVAL] No stored directory, using fallback: ".concat(directory));
                        }
                        return [4 /*yield*/, this.tryReviveSession(sessionId, directory)];
                    case 3:
                        revivalResult = _d.sent();
                        if (!revivalResult.revived) {
                            errorResponse = {
                                error: "Session revival failed: ".concat(revivalResult.error),
                                code: RpcHandlerManager_1.RPC_ERROR_CODES.SESSION_REVIVAL_FAILED,
                                originalSessionId: sessionId,
                                revivalResult: revivalResult
                            };
                            return [2 /*return*/, (0, encryption_1.encodeBase64)((0, encryption_1.encrypt)(this.machine.encryptionKey, this.machine.encryptionVariant, errorResponse))];
                        }
                        newMethod = "".concat(revivalResult.newSessionId, ":").concat(methodName);
                        logger_1.logger.debug("[API MACHINE] [REVIVAL] Replaying command: ".concat(methodName, " on revived session ").concat((_b = revivalResult.newSessionId) === null || _b === void 0 ? void 0 : _b.substring(0, 8), "..."));
                        POLL_INTERVAL_MS_1 = 100;
                        MAX_WAIT_MS = 5000;
                        waited = 0;
                        handlerReady = false;
                        _d.label = 4;
                    case 4:
                        if (!(waited < MAX_WAIT_MS)) return [3 /*break*/, 6];
                        // Check if the new session's handlers are registered
                        // by attempting to get its status from the handler manager
                        try {
                            status_1 = (_c = this.rpcHandlers) === null || _c === void 0 ? void 0 : _c.getSessionStatus(revivalResult.newSessionId);
                            if ((status_1 === null || status_1 === void 0 ? void 0 : status_1.status) === 'active') {
                                handlerReady = true;
                                logger_1.logger.debug("[API MACHINE] [REVIVAL] Handler ready after ".concat(waited, "ms"));
                                return [3 /*break*/, 6];
                            }
                        }
                        catch (_e) {
                            // Handler not ready yet, continue polling
                        }
                        return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, POLL_INTERVAL_MS_1); })];
                    case 5:
                        _d.sent();
                        waited += POLL_INTERVAL_MS_1;
                        return [3 /*break*/, 4];
                    case 6:
                        if (!handlerReady) {
                            logger_1.logger.debug("[API MACHINE] [REVIVAL] Handler not ready after ".concat(MAX_WAIT_MS, "ms, proceeding anyway"));
                        }
                        return [4 /*yield*/, this.rpcHandlerManager.handleRequest(__assign(__assign({}, request), { method: newMethod }))];
                    case 7:
                        replayResponse = _d.sent();
                        decryptedReplayResponse = (0, encryption_1.decrypt)(this.machine.encryptionKey, this.machine.encryptionVariant, (0, encryption_1.decodeBase64)(replayResponse));
                        if (decryptedReplayResponse && !decryptedReplayResponse.error) {
                            // Replay succeeded - include revival metadata in response
                            // Note: We can't easily modify the encrypted response, so we return it as-is
                            // The client should receive the session-revived event separately
                            logger_1.logger.debug("[API MACHINE] [REVIVAL] Command replay succeeded");
                            return [2 /*return*/, replayResponse];
                        }
                        // Replay failed - log and return the replay response (which contains the error)
                        logger_1.logger.debug("[API MACHINE] [REVIVAL] Command replay failed: ".concat((decryptedReplayResponse === null || decryptedReplayResponse === void 0 ? void 0 : decryptedReplayResponse.error) || 'Unknown error'));
                        return [2 /*return*/, replayResponse];
                    case 8:
                        error_2 = _d.sent();
                        // Decryption or processing error - return original response
                        logger_1.logger.debug("[API MACHINE] [REVIVAL] Error processing response: ".concat(error_2 instanceof Error ? error_2.message : 'Unknown'));
                        return [2 /*return*/, initialResponse];
                    case 9: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get session revival metrics for observability.
     *
     * @returns Object with attempted, succeeded, and failed counts
     * @see HAP-733
     */
    ApiMachineClient.prototype.getRevivalMetrics = function () {
        return __assign({}, this.revivalMetrics);
    };
    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    ApiMachineClient.prototype.updateMachineMetadata = function (handler) {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, (0, time_1.backoff)(function () { return __awaiter(_this, void 0, void 0, function () {
                            var updated, answer, decryptedMetadata, decryptedMetadata;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        updated = handler(this.machine.metadata);
                                        return [4 /*yield*/, this.socket.emitWithAck('machine-update-metadata', {
                                                machineId: this.machine.id,
                                                metadata: (0, encryption_1.encodeBase64)((0, encryption_1.encrypt)(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                                                expectedVersion: this.machine.metadataVersion
                                            })];
                                    case 1:
                                        answer = _a.sent();
                                        if (answer.result === 'success') {
                                            decryptedMetadata = (0, encryption_1.decrypt)(this.machine.encryptionKey, this.machine.encryptionVariant, (0, encryption_1.decodeBase64)(answer.metadata));
                                            if (decryptedMetadata === null) {
                                                logger_1.logger.debug('[API MACHINE] [ERROR] Failed to decrypt metadata response - keeping local state');
                                            }
                                            else {
                                                this.machine.metadata = decryptedMetadata;
                                                this.machine.metadataVersion = answer.version;
                                                logger_1.logger.debug('[API MACHINE] Metadata updated successfully');
                                            }
                                        }
                                        else if (answer.result === 'version-mismatch') {
                                            if (answer.version > this.machine.metadataVersion) {
                                                decryptedMetadata = (0, encryption_1.decrypt)(this.machine.encryptionKey, this.machine.encryptionVariant, (0, encryption_1.decodeBase64)(answer.metadata));
                                                if (decryptedMetadata === null) {
                                                    logger_1.logger.debug('[API MACHINE] [ERROR] Failed to decrypt metadata on version-mismatch - keeping local state');
                                                }
                                                else {
                                                    this.machine.metadataVersion = answer.version;
                                                    this.machine.metadata = decryptedMetadata;
                                                }
                                            }
                                            throw new errors_1.AppError(errors_1.ErrorCodes.VERSION_MISMATCH, 'Metadata version mismatch'); // Triggers retry
                                        }
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    ApiMachineClient.prototype.updateDaemonState = function (handler) {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, (0, time_1.backoff)(function () { return __awaiter(_this, void 0, void 0, function () {
                            var updated, answer, decryptedState, decryptedState;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        updated = handler(this.machine.daemonState);
                                        return [4 /*yield*/, this.socket.emitWithAck('machine-update-state', {
                                                machineId: this.machine.id,
                                                daemonState: (0, encryption_1.encodeBase64)((0, encryption_1.encrypt)(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                                                expectedVersion: this.machine.daemonStateVersion
                                            })];
                                    case 1:
                                        answer = _a.sent();
                                        if (answer.result === 'success') {
                                            decryptedState = (0, encryption_1.decrypt)(this.machine.encryptionKey, this.machine.encryptionVariant, (0, encryption_1.decodeBase64)(answer.daemonState));
                                            if (decryptedState === null) {
                                                logger_1.logger.debug('[API MACHINE] [ERROR] Failed to decrypt daemon state response - keeping local state');
                                            }
                                            else {
                                                this.machine.daemonState = decryptedState;
                                                this.machine.daemonStateVersion = answer.version;
                                                logger_1.logger.debug('[API MACHINE] Daemon state updated successfully');
                                            }
                                        }
                                        else if (answer.result === 'version-mismatch') {
                                            if (answer.version > this.machine.daemonStateVersion) {
                                                decryptedState = (0, encryption_1.decrypt)(this.machine.encryptionKey, this.machine.encryptionVariant, (0, encryption_1.decodeBase64)(answer.daemonState));
                                                if (decryptedState === null) {
                                                    logger_1.logger.debug('[API MACHINE] [ERROR] Failed to decrypt daemon state on version-mismatch - keeping local state');
                                                }
                                                else {
                                                    this.machine.daemonStateVersion = answer.version;
                                                    this.machine.daemonState = decryptedState;
                                                }
                                            }
                                            throw new errors_1.AppError(errors_1.ErrorCodes.VERSION_MISMATCH, 'Daemon state version mismatch'); // Triggers retry
                                        }
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    ApiMachineClient.prototype.connect = function () {
        var _this = this;
        logger_1.logger.debug("[API MACHINE] Connecting to ".concat(configuration_1.configuration.serverUrl));
        //
        // Create WebSocket with optimized connection options
        //
        // @see HAP-261 - Migrated from Socket.io to native WebSocket
        //
        this.socket = new HappyWebSocket_1.HappyWebSocket(configuration_1.configuration.serverUrl, {
            token: this.token,
            clientType: 'machine-scoped',
            machineId: this.machine.id
        }, {
            // Reconnection settings
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            randomizationFactor: 0.5, // Add randomization to prevent thundering herd
            maxReconnectionAttempts: Infinity,
            timeout: 20000,
            ackTimeout: 5000
        });
        // Handlers - stored as class properties to prevent GC (HAP-363)
        this.onSocketConnect = function () {
            logger_1.logger.debug('[API MACHINE] Connected to server');
            // Update daemon state to running
            // We need to override previous state because the daemon (this process)
            // has restarted with new PID & port
            // @see HAP-608 - Include MCP config in daemon state sync
            _this.updateDaemonState(function (state) {
                var _a;
                return (__assign(__assign({}, state), { status: 'running', pid: process.pid, httpPort: (_a = _this.machine.daemonState) === null || _a === void 0 ? void 0 : _a.httpPort, startedAt: Date.now(), mcpConfig: (0, config_1.buildMcpSyncState)() }));
            });
            // Register all handlers
            _this.rpcHandlerManager.onWebSocketConnect(_this.socket);
            // Start keep-alive
            _this.startKeepAlive();
        };
        this.socket.on('connect', this.onSocketConnect);
        this.onSocketDisconnect = function () {
            logger_1.logger.debug('[API MACHINE] Disconnected from server');
            _this.rpcHandlerManager.onWebSocketDisconnect();
            _this.stopKeepAlive();
        };
        this.socket.on('disconnect', this.onSocketDisconnect);
        // Single consolidated RPC handler with session revival support (HAP-733)
        this.socket.onRpcRequest(function (data, callback) { return __awaiter(_this, void 0, void 0, function () {
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        logger_1.logger.debugLargeJson("[API MACHINE] Received RPC request:", data);
                        // Use handleRpcWithRevival to automatically revive stopped sessions
                        _a = callback;
                        return [4 /*yield*/, this.handleRpcWithRevival(data)];
                    case 1:
                        // Use handleRpcWithRevival to automatically revive stopped sessions
                        _a.apply(void 0, [_b.sent()]);
                        return [2 /*return*/];
                }
            });
        }); });
        // Handle update events from server
        this.onSocketUpdate = function (data) {
            var _a;
            var updateType = data.body.t;
            // Machine clients should only care about machine updates for this specific machine
            if (updateType === 'update-machine') {
                var update = data.body;
                // Only process updates for this machine
                if (update.machineId !== _this.machine.id) {
                    // Silently ignore updates for other machines
                    return;
                }
                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                if (update.metadata) {
                    logger_1.logger.debug('[API MACHINE] Received external metadata update');
                    var decryptedMetadata = (0, encryption_1.decrypt)(_this.machine.encryptionKey, _this.machine.encryptionVariant, (0, encryption_1.decodeBase64)(update.metadata.value));
                    if (decryptedMetadata === null) {
                        logger_1.logger.debug('[API MACHINE] [ERROR] Failed to decrypt external metadata update - skipping');
                    }
                    else {
                        _this.machine.metadata = decryptedMetadata;
                        _this.machine.metadataVersion = update.metadata.version;
                    }
                }
                if (update.daemonState) {
                    logger_1.logger.debug('[API MACHINE] Received external daemon state update');
                    var decryptedState = (0, encryption_1.decrypt)(_this.machine.encryptionKey, _this.machine.encryptionVariant, (0, encryption_1.decodeBase64)(update.daemonState.value));
                    if (decryptedState === null) {
                        logger_1.logger.debug('[API MACHINE] [ERROR] Failed to decrypt external daemon state update - skipping');
                    }
                    else {
                        _this.machine.daemonState = decryptedState;
                        _this.machine.daemonStateVersion = update.daemonState.version;
                    }
                }
            }
            else if (updateType === 'new-machine') {
                // Silently ignore new machine registrations (not relevant to this daemon)
                return;
            }
            else if (updateType === 'delete-machine') {
                // HAP-781: Machine deleted/disconnected from account via server broadcast
                // Parse using protocol schema for type safety
                var parseResult = protocol_1.ApiDeleteMachineSchema.safeParse(data.body);
                if (!parseResult.success) {
                    logger_1.logger.debug("[API MACHINE] Received malformed delete-machine update, ignoring");
                    return;
                }
                var deletedMachineId = parseResult.data.machineId;
                // Only respond if this is for our machine ID
                if (deletedMachineId === _this.machine.id) {
                    logger_1.logger.debug("[API MACHINE] [UPDATE] Machine ".concat(deletedMachineId, " deleted from account"));
                    // Notify the daemon to shut down gracefully
                    if ((_a = _this.rpcHandlers) === null || _a === void 0 ? void 0 : _a.onMachineDisconnected) {
                        _this.rpcHandlers.onMachineDisconnected('Machine was disconnected from your account');
                    }
                }
                // Silently ignore delete events for other machines
                return;
            }
            else if (updateType === 'delete-session') {
                // Track archived sessions to prevent revival attempts
                var deletedSessionId = (0, sessionValidation_1.normalizeSessionId)((0, protocol_1.getSessionId)(data.body));
                _this.archivedSessionIds.add(deletedSessionId);
                return;
            }
            else if (updateType === 'new-session' || updateType === 'update-session' || updateType === 'new-message') {
                // Silently ignore session-scoped updates (handled by session clients, not machine client)
                return;
            }
            else if (updateType === 'update-account') {
                // Silently ignore account updates (not relevant to machine daemon)
                return;
            }
            else if (updateType === 'new-artifact' || updateType === 'update-artifact' || updateType === 'delete-artifact') {
                // Silently ignore artifact updates (handled by app, not machine daemon)
                return;
            }
            else if (updateType === 'relationship-updated' || updateType === 'new-feed-post') {
                // Silently ignore social/feed updates (handled by app, not machine daemon)
                return;
            }
            else if (updateType === 'kv-batch-update') {
                // Silently ignore KV settings updates (handled by app, not machine daemon)
                return;
            }
            else {
                // Log truly unknown update types for debugging
                logger_1.logger.debug("[API MACHINE] Received unhandled update type: ".concat(updateType));
            }
        };
        this.socket.onServer('update', this.onSocketUpdate);
        // Ephemeral events - real-time status updates from server (HAP-357)
        this.onSocketEphemeral = function (data) {
            var _a;
            switch (data.type) {
                case 'activity':
                    // Session activity - machine daemon doesn't track individual sessions
                    // Silently ignore (session clients handle this)
                    break;
                case 'usage': {
                    // Real-time usage/cost update - informational for daemon
                    var sessionId = (0, protocol_1.getSessionIdFromEphemeral)(data);
                    logger_1.logger.debug("[API MACHINE] [EPHEMERAL] Usage: session ".concat(sessionId, " cost=$").concat(data.cost.total.toFixed(4)));
                    break;
                }
                case 'machine-activity': {
                    // Other machine/daemon activity - track peers for awareness
                    var machineId = (0, protocol_1.getMachineIdFromEphemeral)(data);
                    if (machineId !== _this.machine.id) {
                        logger_1.logger.debug("[API MACHINE] [EPHEMERAL] Peer daemon ".concat(machineId, " active=").concat(data.active));
                    }
                    break;
                }
                case 'machine-disconnected': {
                    // HAP-780/HAP-781: Machine disconnected from account via ephemeral event
                    // The server broadcasts this when a machine is removed from the account
                    var disconnectedMachineId = (0, protocol_1.getMachineIdFromEphemeral)(data);
                    if (disconnectedMachineId === _this.machine.id) {
                        logger_1.logger.debug("[API MACHINE] [EPHEMERAL] Machine ".concat(disconnectedMachineId, " disconnected from account"));
                        // Extract reason if provided in the event
                        var reason = data.reason || 'Machine was disconnected from your account';
                        if ((_a = _this.rpcHandlers) === null || _a === void 0 ? void 0 : _a.onMachineDisconnected) {
                            _this.rpcHandlers.onMachineDisconnected(reason);
                        }
                    }
                    // Silently ignore disconnect events for other machines
                    break;
                }
                default:
                    // Unknown ephemeral type - log but don't crash (forward compatibility)
                    logger_1.logger.debug("[API MACHINE] [EPHEMERAL] Unknown type: ".concat(data.type));
            }
        };
        this.socket.onServer('ephemeral', this.onSocketEphemeral);
        this.onSocketConnectError = function (error) {
            logger_1.logger.debug("[API MACHINE] Connection error: ".concat(error.message));
        };
        this.socket.on('connect_error', this.onSocketConnectError);
        this.onSocketError = function (error) {
            logger_1.logger.debug('[API MACHINE] Socket error:', error);
        };
        this.socket.onServer('error', this.onSocketError);
        // Connect to server
        this.socket.connect();
    };
    ApiMachineClient.prototype.startKeepAlive = function () {
        var _this = this;
        // Double-check and clear any existing interval to prevent leaks
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger_1.logger.debug('[API MACHINE] Cleared existing keep-alive before starting new one');
        }
        // Add random jitter to prevent thundering herd when multiple clients reconnect
        // Each client will have a unique interval, spreading out the load
        var jitter = Math.random() * KEEP_ALIVE_JITTER_MAX_MS;
        var interval = KEEP_ALIVE_BASE_INTERVAL_MS + jitter;
        this.keepAliveInterval = setInterval(function () {
            var _a;
            // Prevent keep-alive after shutdown
            if (_this.isShuttingDown) {
                logger_1.logger.debug('[API MACHINE] Skipping keep-alive: shutting down');
                return;
            }
            // Skip if socket is not connected (prevents errors during reconnection)
            if (!((_a = _this.socket) === null || _a === void 0 ? void 0 : _a.connected)) {
                logger_1.logger.debug('[API MACHINE] Socket not connected, skipping keep-alive');
                return;
            }
            var payload = {
                machineId: _this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) { // too verbose for production
                logger_1.logger.debugLargeJson("[API MACHINE] Emitting machine-alive", payload);
            }
            _this.socket.emit('machine-alive', payload);
        }, interval);
        logger_1.logger.debug("[API MACHINE] Keep-alive started (".concat(Math.round(interval / 1000), "s interval with jitter)"));
    };
    ApiMachineClient.prototype.stopKeepAlive = function () {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger_1.logger.debug('[API MACHINE] Keep-alive stopped');
        }
    };
    ApiMachineClient.prototype.shutdown = function () {
        // Ensure shutdown is idempotent - safe to call multiple times
        if (this.isShuttingDown) {
            logger_1.logger.debug('[API MACHINE] Shutdown already in progress, skipping');
            return;
        }
        this.isShuttingDown = true;
        logger_1.logger.debug('[API MACHINE] Shutting down');
        this.stopKeepAlive();
        if (this.socket) {
            // Remove all socket event listeners before closing
            this.socket.removeAllListeners();
            this.socket.close();
            logger_1.logger.debug('[API MACHINE] Socket closed');
        }
    };
    /**
     * Called during memory pressure to clean up non-essential state. (HAP-353)
     * Delegates to the underlying socket's memory pressure handler.
     */
    ApiMachineClient.prototype.onMemoryPressure = function () {
        if (this.socket && !this.isShuttingDown) {
            this.socket.onMemoryPressure();
        }
    };
    /**
     * Get WebSocket metrics for observability (HAP-362)
     *
     * Returns null if socket is not initialized or shutting down.
     * Combines point-in-time statistics with cumulative counters for
     * tracking WebSocket health over time.
     */
    ApiMachineClient.prototype.getSocketMetrics = function () {
        if (!this.socket || this.isShuttingDown) {
            return null;
        }
        return this.socket.getMetrics();
    };
    return ApiMachineClient;
}());
exports.ApiMachineClient = ApiMachineClient;
