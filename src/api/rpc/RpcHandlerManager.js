"use strict";
/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration, encryption/decryption, and handler execution
 * Supports request cancellation via AbortController
 *
 * @see HAP-261 - Updated to support both Socket.io and native WebSocket
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
exports.RpcHandlerManager = exports.RPC_ERROR_CODES = void 0;
var logger_1 = require("@/ui/logger");
var encryption_1 = require("@/api/encryption");
var errors_1 = require("@/utils/errors");
/**
 * Possible RPC error codes returned in error responses
 * These help clients distinguish between different failure modes
 */
exports.RPC_ERROR_CODES = {
    /** Method handler not found - may be stopped session or truly missing method */
    METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
    /** Session is not active (stopped, archived, or unknown) */
    SESSION_NOT_ACTIVE: 'SESSION_NOT_ACTIVE',
    /** Request was cancelled */
    OPERATION_CANCELLED: 'OPERATION_CANCELLED',
    /** Failed to decrypt request parameters */
    DECRYPTION_FAILED: 'DECRYPTION_FAILED',
    /** Internal handler error */
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    /** Session revival was attempted but failed */
    SESSION_REVIVAL_FAILED: 'SESSION_REVIVAL_FAILED',
    /** Session revival succeeded, command was replayed */
    SESSION_REVIVED: 'SESSION_REVIVED',
};
var RpcHandlerManager = /** @class */ (function () {
    function RpcHandlerManager(config) {
        this.handlers = new Map();
        this.socket = null;
        // Track pending requests for cancellation support
        this.pendingRequests = new Map();
        // Store cancel handler reference for cleanup
        this.cancelHandler = null;
        this.scopePrefix = config.scopePrefix;
        this.encryptionKey = config.encryptionKey;
        this.encryptionVariant = config.encryptionVariant;
        this.logger = config.logger || (function (msg, data) { return logger_1.logger.debug(msg, data); });
    }
    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    RpcHandlerManager.prototype.registerHandler = function (method, handler) {
        var prefixedMethod = this.getPrefixedMethod(method);
        // Store the handler (cast needed due to Map type variance)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.handlers.set(prefixedMethod, handler);
        if (this.socket) {
            this.socket.emitClient('rpc-register', { method: prefixedMethod });
        }
    };
    /**
     * Handle an incoming RPC request
     * @param request - The RPC request data
     * @returns Encrypted response string
     *
     * @see HAP-642 - Improved error handling for stopped sessions
     */
    RpcHandlerManager.prototype.handleRequest = function (request) {
        return __awaiter(this, void 0, void 0, function () {
            var requestId, abortController, handler, methodParts, isSessionScoped, errorResponse_1, errorResponse, decryptedParams, errorResponse, signal, result, encryptedResponse, error_1, isCancelled, errorMessage, errorResponse;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        requestId = request.requestId;
                        // Track the request if it has a requestId
                        if (requestId) {
                            abortController = new AbortController();
                            this.pendingRequests.set(requestId, abortController);
                        }
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, 3, 4, 5]);
                        handler = this.handlers.get(request.method);
                        if (!handler) {
                            methodParts = request.method.split(':');
                            isSessionScoped = methodParts.length === 2 && methodParts[0].length >= 32;
                            if (isSessionScoped) {
                                // This is likely a session-scoped method where the session has stopped
                                // Log at DEBUG level since this is expected behavior when sessions end
                                this.logger('[RPC] [DEBUG] Method not found for session (session may have stopped)', {
                                    method: request.method,
                                    sessionPrefix: methodParts[0].substring(0, 8) + '...'
                                });
                                errorResponse_1 = {
                                    error: 'Session not active',
                                    code: exports.RPC_ERROR_CODES.SESSION_NOT_ACTIVE,
                                    message: 'The session this method belongs to is no longer active. It may have been stopped, archived, or disconnected.',
                                    method: methodParts[1],
                                    cancelled: false
                                };
                                return [2 /*return*/, (0, encryption_1.encodeBase64)((0, encryption_1.encrypt)(this.encryptionKey, this.encryptionVariant, errorResponse_1))];
                            }
                            // Non-session-scoped method - this is unexpected
                            // Log at ERROR level as this indicates a real issue
                            this.logger('[RPC] [ERROR] Method not found', { method: request.method });
                            errorResponse = {
                                error: 'Method not found',
                                code: exports.RPC_ERROR_CODES.METHOD_NOT_FOUND,
                                cancelled: false
                            };
                            return [2 /*return*/, (0, encryption_1.encodeBase64)((0, encryption_1.encrypt)(this.encryptionKey, this.encryptionVariant, errorResponse))];
                        }
                        // Check if already cancelled before starting
                        if (abortController === null || abortController === void 0 ? void 0 : abortController.signal.aborted) {
                            throw new errors_1.AppError(errors_1.ErrorCodes.OPERATION_CANCELLED, 'Request cancelled');
                        }
                        decryptedParams = (0, encryption_1.decrypt)(this.encryptionKey, this.encryptionVariant, (0, encryption_1.decodeBase64)(request.params));
                        // Fail closed: reject requests with invalid encryption
                        if (decryptedParams === null) {
                            this.logger('[RPC] [ERROR] Failed to decrypt RPC params - rejecting request');
                            errorResponse = {
                                error: exports.RPC_ERROR_CODES.DECRYPTION_FAILED,
                                code: exports.RPC_ERROR_CODES.DECRYPTION_FAILED,
                                message: 'Failed to decrypt request parameters'
                            };
                            return [2 /*return*/, (0, encryption_1.encodeBase64)((0, encryption_1.encrypt)(this.encryptionKey, this.encryptionVariant, errorResponse))];
                        }
                        signal = (_a = abortController === null || abortController === void 0 ? void 0 : abortController.signal) !== null && _a !== void 0 ? _a : new AbortController().signal;
                        return [4 /*yield*/, handler(decryptedParams, signal)];
                    case 2:
                        result = _c.sent();
                        // Check if cancelled during execution
                        if (abortController === null || abortController === void 0 ? void 0 : abortController.signal.aborted) {
                            throw new errors_1.AppError(errors_1.ErrorCodes.OPERATION_CANCELLED, 'Request cancelled');
                        }
                        encryptedResponse = (0, encryption_1.encodeBase64)((0, encryption_1.encrypt)(this.encryptionKey, this.encryptionVariant, result));
                        return [2 /*return*/, encryptedResponse];
                    case 3:
                        error_1 = _c.sent();
                        isCancelled = (_b = abortController === null || abortController === void 0 ? void 0 : abortController.signal.aborted) !== null && _b !== void 0 ? _b : false;
                        errorMessage = isCancelled ? 'Request cancelled' : (error_1 instanceof Error ? error_1.message : 'Unknown error');
                        this.logger('[RPC] [ERROR] Error handling request', {
                            error: errorMessage,
                            cancelled: isCancelled,
                            stack: error_1 instanceof Error ? error_1.stack : undefined
                        });
                        errorResponse = {
                            error: errorMessage,
                            code: isCancelled ? exports.RPC_ERROR_CODES.OPERATION_CANCELLED : exports.RPC_ERROR_CODES.INTERNAL_ERROR,
                            cancelled: isCancelled
                        };
                        return [2 /*return*/, (0, encryption_1.encodeBase64)((0, encryption_1.encrypt)(this.encryptionKey, this.encryptionVariant, errorResponse))];
                    case 4:
                        // Clean up tracking
                        if (requestId) {
                            this.pendingRequests.delete(requestId);
                        }
                        return [7 /*endfinally*/];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Handle a cancellation request from the server
     * @param cancel - The cancellation request data
     */
    RpcHandlerManager.prototype.handleCancellation = function (cancel) {
        // Validate cancellation request
        if (!cancel.requestId || typeof cancel.requestId !== 'string') {
            this.logger('[RPC] [ERROR] Invalid cancellation request - missing or invalid requestId');
            return;
        }
        var controller = this.pendingRequests.get(cancel.requestId);
        if (controller) {
            this.logger('[RPC] Cancelling request', { requestId: cancel.requestId, method: cancel.method });
            controller.abort();
            // Note: Don't delete here - handleRequest's finally block handles cleanup
            // Deleting here would cause a race condition if the handler is still running
        }
        else {
            // Request may have already completed or was never tracked
            this.logger('[RPC] Cancellation request for unknown or completed request', { requestId: cancel.requestId });
        }
    };
    /**
     * Get the number of pending requests
     */
    RpcHandlerManager.prototype.getPendingRequestCount = function () {
        return this.pendingRequests.size;
    };
    /**
     * Cancel all pending requests (e.g., on disconnect)
     */
    RpcHandlerManager.prototype.cancelAllPendingRequests = function () {
        for (var _i = 0, _a = this.pendingRequests; _i < _a.length; _i++) {
            var _b = _a[_i], requestId = _b[0], controller = _b[1];
            this.logger('[RPC] Cancelling request due to disconnect', { requestId: requestId });
            controller.abort();
        }
        this.pendingRequests.clear();
    };
    /**
     * Called when native WebSocket connects
     * @see HAP-261 - New method for native WebSocket support
     */
    RpcHandlerManager.prototype.onWebSocketConnect = function (socket) {
        var _this = this;
        // Cast to RpcSocket interface - HappyWebSocket implements emit/on/off
        this.socket = socket;
        for (var _i = 0, _a = this.handlers; _i < _a.length; _i++) {
            var prefixedMethod = _a[_i][0];
            socket.emitClient('rpc-register', { method: prefixedMethod });
        }
        // Listen for cancellation events from the server
        // Store the bound handler so we can remove it later
        if (!this.cancelHandler) {
            this.cancelHandler = function (data) {
                _this.handleCancellation(data);
            };
        }
        // Remove existing listener before adding to prevent accumulation on reconnection
        // This is defensive - onWebSocketDisconnect should have removed it, but timing issues
        // can cause listener accumulation
        socket.off('rpc-cancel', this.cancelHandler);
        socket.on('rpc-cancel', this.cancelHandler);
    };
    /**
     * Called when native WebSocket disconnects
     * @see HAP-261 - New method for native WebSocket support
     */
    RpcHandlerManager.prototype.onWebSocketDisconnect = function () {
        // Remove the cancellation listener to prevent memory leaks
        if (this.socket && this.cancelHandler) {
            this.socket.off('rpc-cancel', this.cancelHandler);
        }
        this.socket = null;
        // Cancel all pending requests on disconnect
        this.cancelAllPendingRequests();
    };
    /**
     * Get the number of registered handlers
     */
    RpcHandlerManager.prototype.getHandlerCount = function () {
        return this.handlers.size;
    };
    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    RpcHandlerManager.prototype.hasHandler = function (method) {
        var prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    };
    /**
     * Clear all handlers
     */
    RpcHandlerManager.prototype.clearHandlers = function () {
        this.handlers.clear();
        this.logger('Cleared all RPC handlers');
    };
    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    RpcHandlerManager.prototype.getPrefixedMethod = function (method) {
        return "".concat(this.scopePrefix, ":").concat(method);
    };
    return RpcHandlerManager;
}());
exports.RpcHandlerManager = RpcHandlerManager;
