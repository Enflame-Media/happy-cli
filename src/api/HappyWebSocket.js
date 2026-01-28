"use strict";
/**
 * Native WebSocket client for Happy CLI
 *
 * Replaces Socket.io-client with a lighter-weight native WebSocket implementation
 * that is compatible with Cloudflare Workers Durable Objects.
 *
 * Features:
 * - Auto-reconnection with exponential backoff
 * - Event-based messaging similar to Socket.io API
 * - Acknowledgement system for request-response patterns
 * - Proper connection state management
 * - WeakRef-based event handlers for GC-friendly memory management (HAP-361)
 *
 * @see HAP-261 - Migration from Socket.io to native WebSocket
 * @see HAP-361 - WeakRef implementation for event handlers
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
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
exports.HappyWebSocket = void 0;
var logger_1 = require("@/ui/logger");
var ws_1 = require("ws");
var node_crypto_1 = require("node:crypto");
var correlationId_1 = require("@/utils/correlationId");
/**
 * Error thrown when a WebSocket acknowledgment times out
 */
var WebSocketAckTimeoutError = /** @class */ (function (_super) {
    __extends(WebSocketAckTimeoutError, _super);
    function WebSocketAckTimeoutError(event, timeoutMs) {
        var _this = _super.call(this, "WebSocket ack timeout for event '".concat(event, "' after ").concat(timeoutMs, "ms")) || this;
        _this.name = 'WebSocketAckTimeoutError';
        return _this;
    }
    return WebSocketAckTimeoutError;
}(Error));
/**
 * Error thrown when attempting to send on a disconnected WebSocket
 */
var WebSocketDisconnectedError = /** @class */ (function (_super) {
    __extends(WebSocketDisconnectedError, _super);
    function WebSocketDisconnectedError(operation) {
        if (operation === void 0) { operation = 'send message'; }
        var _this = _super.call(this, "WebSocket not connected: cannot ".concat(operation)) || this;
        _this.name = 'WebSocketDisconnectedError';
        return _this;
    }
    return WebSocketDisconnectedError;
}(Error));
/**
 * Native WebSocket client with auto-reconnection and Socket.io-like API
 */
var HappyWebSocket = /** @class */ (function () {
    function HappyWebSocket(baseUrl, auth, config, path) {
        if (config === void 0) { config = {}; }
        if (path === void 0) { path = '/v1/updates'; }
        var _this = this;
        var _a, _b, _c, _d, _e, _f;
        this.ws = null;
        // Connection state
        this._connected = false;
        this.reconnectAttempts = 0;
        this.reconnectTimeout = null;
        this.isManualClose = false;
        this.connectionPromise = null;
        this.connectionResolve = null;
        this.connectionReject = null;
        /**
         * Event handlers with WeakRef for GC-friendly memory management (HAP-361)
         *
         * IMPORTANT BEHAVIORAL CHANGE: Handlers are stored as WeakRefs, meaning they
         * will be garbage collected if the caller doesn't retain a reference.
         *
         * Example (handler persists):
         *   const handler = (data) => console.log(data);
         *   socket.on('message', handler);  // handler retained by caller
         *
         * Example (handler may be GC'd):
         *   socket.on('message', (data) => console.log(data));  // inline, no external ref
         *
         * This change prevents memory leaks from orphaned handlers in long-running
         * daemon sessions. See HAP-353 for bounds enforcement context.
         */
        this.eventHandlers = new Map();
        /**
         * O(1) lookup for .off() - maps original callback to its WeakRef (HAP-361)
         * Uses WeakMap so the lookup itself doesn't prevent callback GC
         */
        this.callbackToWeakRef = new WeakMap();
        this.rpcHandler = null;
        // Acknowledgement tracking
        this.pendingAcks = new Map();
        // Metrics counters for observability (HAP-362)
        // These are cumulative counters that persist across the socket lifetime
        this.memoryPressureCount = 0;
        this.acksCleanedTotal = 0;
        this.handlersRejectedTotal = 0;
        this.baseUrl = baseUrl;
        this.path = path;
        this.auth = auth;
        // Apply default configuration
        this.config = {
            reconnectionDelay: (_a = config.reconnectionDelay) !== null && _a !== void 0 ? _a : 1000,
            reconnectionDelayMax: (_b = config.reconnectionDelayMax) !== null && _b !== void 0 ? _b : 30000,
            randomizationFactor: (_c = config.randomizationFactor) !== null && _c !== void 0 ? _c : 0.5,
            timeout: (_d = config.timeout) !== null && _d !== void 0 ? _d : 20000,
            maxReconnectionAttempts: (_e = config.maxReconnectionAttempts) !== null && _e !== void 0 ? _e : Infinity,
            ackTimeout: (_f = config.ackTimeout) !== null && _f !== void 0 ? _f : 5000,
        };
        // Initialize FinalizationRegistry for automatic handler cleanup (HAP-361)
        // When a callback is garbage collected, this removes its WeakRef from the Set
        this.handlerRegistry = new FinalizationRegistry(function (metadata) {
            var handlers = _this.eventHandlers.get(metadata.event);
            if (handlers) {
                handlers.delete(metadata.weakRef);
                logger_1.logger.debug("[HappyWebSocket] Handler for '".concat(metadata.event, "' was garbage collected"));
            }
        });
    }
    Object.defineProperty(HappyWebSocket.prototype, "connected", {
        /**
         * Whether the WebSocket is currently connected
         */
        get: function () {
            return this._connected;
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Connect to the WebSocket server
     */
    HappyWebSocket.prototype.connect = function () {
        var _this = this;
        if (this.connectionPromise) {
            return this.connectionPromise;
        }
        this.isManualClose = false;
        this.connectionPromise = new Promise(function (resolve, reject) {
            _this.connectionResolve = resolve;
            _this.connectionReject = reject;
            _this.doConnect();
        });
        return this.connectionPromise;
    };
    /**
     * Internal connection logic
     */
    HappyWebSocket.prototype.doConnect = function () {
        var _this = this;
        // Build WebSocket URL without auth in query string (security: avoid URL logging)
        var wsUrl = new URL(this.path, this.baseUrl);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        // Build auth headers for secure transmission
        // Server-side parseHandshake() supports Authorization header as fallback
        var headers = {
            'Authorization': "Bearer ".concat(this.auth.token),
            'X-Client-Type': this.auth.clientType,
            'X-Correlation-ID': (0, correlationId_1.getCorrelationId)(),
        };
        if (this.auth.sessionId) {
            headers['X-Session-Id'] = this.auth.sessionId;
        }
        if (this.auth.machineId) {
            headers['X-Machine-Id'] = this.auth.machineId;
        }
        logger_1.logger.debug("[HappyWebSocket] Connecting to ".concat(wsUrl.toString()));
        // Set connection timeout
        var connectionTimer = setTimeout(function () {
            if (!_this._connected && _this.ws) {
                logger_1.logger.debug('[HappyWebSocket] Connection timeout');
                _this.ws.terminate();
                _this.handleConnectionError(new Error('Connection timeout'));
            }
        }, this.config.timeout);
        try {
            // Pass auth via headers instead of URL query params for security
            // This prevents token exposure in server logs, proxy logs, and browser history
            this.ws = new ws_1.default(wsUrl.toString(), { headers: headers });
            this.ws.on('open', function () {
                clearTimeout(connectionTimer);
                _this._connected = true;
                _this.reconnectAttempts = 0;
                logger_1.logger.debug('[HappyWebSocket] Connected');
                // Resolve connection promise
                if (_this.connectionResolve) {
                    _this.connectionResolve();
                    _this.connectionResolve = null;
                    _this.connectionReject = null;
                }
                // Emit connect event
                _this.emitInternal('connect', undefined);
            });
            this.ws.on('message', function (data) {
                _this.handleMessage(data);
            });
            this.ws.on('close', function (code, reason) {
                clearTimeout(connectionTimer);
                var wasConnected = _this._connected;
                _this._connected = false;
                logger_1.logger.debug("[HappyWebSocket] Disconnected: code=".concat(code, ", reason=").concat(reason.toString()));
                // Reject any pending acks
                _this.rejectAllPendingAcks(new WebSocketDisconnectedError('connection closed'));
                // Emit disconnect event
                if (wasConnected) {
                    _this.emitInternal('disconnect', _this.getDisconnectReason(code));
                }
                // Attempt reconnection if not manually closed
                if (!_this.isManualClose) {
                    _this.scheduleReconnect();
                }
            });
            this.ws.on('error', function (error) {
                clearTimeout(connectionTimer);
                logger_1.logger.debug("[HappyWebSocket] Error: ".concat(error.message));
                _this.emitInternal('connect_error', error);
                // If not connected yet, this is a connection error
                if (!_this._connected) {
                    _this.handleConnectionError(error);
                }
            });
        }
        catch (error) {
            clearTimeout(connectionTimer);
            this.handleConnectionError(error);
        }
    };
    /**
     * Handle connection errors
     */
    HappyWebSocket.prototype.handleConnectionError = function (error) {
        // Reject connection promise on first attempt
        if (this.connectionReject && this.reconnectAttempts === 0) {
            this.connectionReject(error);
            this.connectionReject = null;
            this.connectionResolve = null;
            this.connectionPromise = null;
        }
        // Schedule reconnection
        if (!this.isManualClose) {
            this.scheduleReconnect();
        }
    };
    /**
     * Schedule a reconnection attempt with exponential backoff and jitter.
     *
     * Jitter Algorithm (HAP-477):
     * Uses "centered jitter" to spread reconnection times both above and below
     * the base delay, preventing thundering herd when many clients reconnect
     * after a server outage.
     *
     * With randomizationFactor=0.5:
     * - Base delay: 1000ms * 2^attempt (capped at max)
     * - Jitter range: ±50% of base delay
     * - Actual delay: 500ms to 1500ms for first attempt
     *
     * Formula: delay = base * (1 - factor + random * factor * 2)
     * This centers the distribution around the base delay rather than
     * always adding extra time (which would still cause clustering).
     */
    HappyWebSocket.prototype.scheduleReconnect = function () {
        var _this = this;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        if (this.reconnectAttempts >= this.config.maxReconnectionAttempts) {
            logger_1.logger.debug('[HappyWebSocket] Max reconnection attempts reached');
            this.emitInternal('reconnect_failed', undefined);
            return;
        }
        // Calculate delay with exponential backoff and centered jitter (HAP-477)
        var baseDelay = Math.min(this.config.reconnectionDelay * Math.pow(2, this.reconnectAttempts), this.config.reconnectionDelayMax);
        // Centered jitter: spreads delay ±factor around base, not just +factor
        // With factor=0.5: delay ranges from base*0.5 to base*1.5
        var jitterMultiplier = 1 - this.config.randomizationFactor + (Math.random() * this.config.randomizationFactor * 2);
        var delay = Math.max(100, baseDelay * jitterMultiplier); // Minimum 100ms floor
        this.reconnectAttempts++;
        logger_1.logger.debug("[HappyWebSocket] Scheduling reconnection in ".concat(Math.round(delay), "ms (attempt ").concat(this.reconnectAttempts, ", base ").concat(Math.round(baseDelay), "ms)"));
        this.reconnectTimeout = setTimeout(function () {
            _this.reconnectTimeout = null;
            _this.emitInternal('reconnect_attempt', _this.reconnectAttempts);
            _this.doConnect();
        }, delay);
    };
    /**
     * Map WebSocket close codes to disconnect reasons
     */
    HappyWebSocket.prototype.getDisconnectReason = function (code) {
        switch (code) {
            case 1000: return 'io client disconnect';
            case 1001: return 'transport close';
            case 1006: return 'transport error';
            case 4000: return 'io server disconnect';
            default: return "transport close (code: ".concat(code, ")");
        }
    };
    /**
     * Handle incoming WebSocket messages
     */
    HappyWebSocket.prototype.handleMessage = function (data) {
        var _this = this;
        try {
            var message_1 = JSON.parse(data.toString());
            // Handle acknowledgement responses
            if (message_1.ackId && message_1.ack !== undefined) {
                var pending = this.pendingAcks.get(message_1.ackId);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingAcks.delete(message_1.ackId);
                    pending.resolve(message_1.ack);
                }
                return;
            }
            // Handle RPC requests (special case with callback)
            if (message_1.event === 'rpc-request' && message_1.ackId && this.rpcHandler) {
                var callback = function (response) {
                    _this.sendRaw({
                        event: 'rpc-response',
                        ackId: message_1.ackId,
                        ack: response
                    });
                };
                this.rpcHandler(message_1.data, callback);
                return;
            }
            // Handle regular events
            this.emitInternal(message_1.event, message_1.data);
        }
        catch (error) {
            logger_1.logger.debug("[HappyWebSocket] Failed to parse message: ".concat(error));
        }
    };
    /**
     * Register an event handler
     *
     * IMPORTANT (HAP-361): Handlers are stored as WeakRefs. The handler will be
     * garbage collected if the caller doesn't retain a reference to the callback.
     * Store the callback in a variable to ensure it persists.
     */
    HappyWebSocket.prototype.on = function (event, callback) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }
        var handlers = this.eventHandlers.get(event);
        var typedCallback = callback;
        // Check if callback already registered (via WeakMap lookup)
        var existingWeakRef = this.callbackToWeakRef.get(typedCallback);
        if (existingWeakRef && handlers.has(existingWeakRef)) {
            return this; // Already registered
        }
        // Bounds enforcement: count only live handlers (HAP-353)
        var liveCount = this.countLiveHandlers(handlers);
        if (liveCount >= HappyWebSocket.MAX_HANDLERS_PER_EVENT) {
            logger_1.logger.warn("[HappyWebSocket] Max handlers (".concat(HappyWebSocket.MAX_HANDLERS_PER_EVENT, ") reached for event '").concat(event, "'. Rejecting new handler."));
            this.handlersRejectedTotal++; // HAP-362: Track rejection for metrics
            return this;
        }
        // Warning at threshold
        if (liveCount === HappyWebSocket.HANDLER_WARNING_THRESHOLD) {
            logger_1.logger.warn("[HappyWebSocket] Handler count approaching limit (".concat(liveCount, "/").concat(HappyWebSocket.MAX_HANDLERS_PER_EVENT, ") for event '").concat(event, "'"));
        }
        // Create WeakRef and store (HAP-361)
        var weakRef = new WeakRef(typedCallback);
        handlers.add(weakRef);
        this.callbackToWeakRef.set(typedCallback, weakRef);
        // Register for cleanup notification when callback is GC'd
        this.handlerRegistry.register(typedCallback, { event: event, weakRef: weakRef }, typedCallback);
        return this;
    };
    /**
     * Register the RPC request handler (special case with callback)
     */
    HappyWebSocket.prototype.onRpcRequest = function (handler) {
        this.rpcHandler = handler;
        return this;
    };
    // =========================================================================
    // TYPE-SAFE EVENT METHODS (HAP-520)
    // =========================================================================
    // These methods provide compile-time type safety for WebSocket events.
    // Use these instead of the generic on()/emit() for better IDE support
    // and protection against event name typos.
    //
    // @see ServerToClientEvents - For available server event names
    // @see ClientToServerEvents - For available client event names
    // =========================================================================
    /**
     * Register a type-safe handler for server-to-client events.
     *
     * Provides compile-time validation of:
     * - Event names (autocomplete + error on typos)
     * - Callback parameter types (inferred from interface)
     *
     * IMPORTANT (HAP-361): Handlers are stored as WeakRefs. The handler will be
     * garbage collected if the caller doesn't retain a reference to the callback.
     * Store the callback in a variable to ensure it persists.
     *
     * @example
     * // ✅ Type-safe - callback receives typed Update
     * const updateHandler = (data) => console.log(data.body);
     * socket.onServer('update', updateHandler);
     *
     * // ❌ Compile error - 'invalid-event' is not a valid event name
     * socket.onServer('invalid-event', handler);
     *
     * @param event - Server event name (autocomplete available)
     * @param callback - Type-safe callback matching the event's signature
     * @returns this for chaining
     * @see HAP-520 - Type-safe event handling implementation
     */
    HappyWebSocket.prototype.onServer = function (event, callback) {
        // Cast to EventCallback for internal storage while preserving external type safety
        return this.on(event, callback);
    };
    /**
     * Remove a type-safe handler for server-to-client events.
     *
     * @param event - Server event name
     * @param callback - The same callback reference passed to onServer()
     * @returns this for chaining
     */
    HappyWebSocket.prototype.offServer = function (event, callback) {
        return this.off(event, callback);
    };
    /**
     * Emit a type-safe event to the server.
     *
     * Provides compile-time validation of:
     * - Event names (autocomplete + error on typos)
     * - Event payload types (inferred from interface)
     *
     * @example
     * // ✅ Type-safe - payload shape is validated
     * socket.emitClient('message', { sid: 'abc', message: 'encrypted...' });
     *
     * // ❌ Compile error - missing required 'message' property
     * socket.emitClient('message', { sid: 'abc' });
     *
     * // ❌ Compile error - 'invalid-event' is not a valid event name
     * socket.emitClient('invalid-event', data);
     *
     * @param event - Client event name (autocomplete available)
     * @param data - Type-safe payload matching the event's expected data type
     * @throws WebSocketDisconnectedError if not connected
     * @see HAP-520 - Type-safe event handling implementation
     */
    HappyWebSocket.prototype.emitClient = function (event, data) {
        this.emit(event, data);
    };
    /**
     * Emit a volatile (fire-and-forget) type-safe event to the server.
     * Does not throw if disconnected - the message is silently dropped.
     *
     * Useful for non-critical events like heartbeats where missing a few
     * messages is acceptable.
     *
     * @param event - Client event name (autocomplete available)
     * @param data - Type-safe payload matching the event's expected data type
     * @see HAP-520 - Type-safe event handling implementation
     */
    HappyWebSocket.prototype.emitClientVolatile = function (event, data) {
        this.volatile.emit(event, data);
    };
    /**
     * Emit a type-safe event to the server and wait for acknowledgement.
     *
     * Use this for events that require a response, like state updates.
     *
     * @param event - Client event name
     * @param data - Type-safe payload
     * @param timeout - Optional timeout in milliseconds (defaults to config.ackTimeout)
     * @returns Promise resolving to the acknowledgement response
     * @throws WebSocketAckTimeoutError if acknowledgement times out
     * @throws WebSocketDisconnectedError if not connected
     * @see HAP-520 - Type-safe event handling implementation
     */
    HappyWebSocket.prototype.emitClientWithAck = function (event, data, timeout) {
        return this.emitWithAck(event, data, timeout);
    };
    /**
     * Remove an event handler
     */
    HappyWebSocket.prototype.off = function (event, callback) {
        var handlers = this.eventHandlers.get(event);
        if (handlers) {
            var typedCallback = callback;
            var weakRef = this.callbackToWeakRef.get(typedCallback);
            if (weakRef) {
                handlers.delete(weakRef);
                this.callbackToWeakRef.delete(typedCallback);
                // Unregister from FinalizationRegistry to prevent stale cleanup
                this.handlerRegistry.unregister(typedCallback);
            }
        }
        return this;
    };
    /**
     * Remove all event handlers
     */
    HappyWebSocket.prototype.removeAllListeners = function (event) {
        if (event) {
            var handlers = this.eventHandlers.get(event);
            if (handlers) {
                // Unregister all handlers for this event from FinalizationRegistry
                for (var _i = 0, handlers_1 = handlers; _i < handlers_1.length; _i++) {
                    var weakRef = handlers_1[_i];
                    var callback = weakRef.deref();
                    if (callback) {
                        this.handlerRegistry.unregister(callback);
                        this.callbackToWeakRef.delete(callback);
                    }
                }
            }
            this.eventHandlers.delete(event);
            if (event === 'rpc-request') {
                this.rpcHandler = null;
            }
        }
        else {
            // Unregister all handlers from FinalizationRegistry
            for (var _a = 0, _b = this.eventHandlers.values(); _a < _b.length; _a++) {
                var handlers = _b[_a];
                for (var _c = 0, handlers_2 = handlers; _c < handlers_2.length; _c++) {
                    var weakRef = handlers_2[_c];
                    var callback = weakRef.deref();
                    if (callback) {
                        this.handlerRegistry.unregister(callback);
                        this.callbackToWeakRef.delete(callback);
                    }
                }
            }
            this.eventHandlers.clear();
            this.rpcHandler = null;
        }
        return this;
    };
    /**
     * Internal event emission
     *
     * WeakRef iteration (HAP-361): Dereferences each WeakRef and cleans up
     * dead references during iteration for efficiency.
     */
    HappyWebSocket.prototype.emitInternal = function (event, data) {
        var handlers = this.eventHandlers.get(event);
        if (handlers) {
            var deadRefs = [];
            for (var _i = 0, handlers_3 = handlers; _i < handlers_3.length; _i++) {
                var weakRef = handlers_3[_i];
                var handler = weakRef.deref();
                if (handler) {
                    try {
                        handler(data);
                    }
                    catch (error) {
                        logger_1.logger.debug("[HappyWebSocket] Error in event handler for '".concat(event, "': ").concat(error));
                    }
                }
                else {
                    // Collect dead refs for cleanup
                    deadRefs.push(weakRef);
                }
            }
            // Cleanup dead refs after iteration
            for (var _a = 0, deadRefs_1 = deadRefs; _a < deadRefs_1.length; _a++) {
                var deadRef = deadRefs_1[_a];
                handlers.delete(deadRef);
            }
        }
    };
    /**
     * Send raw message without acknowledgement
     */
    HappyWebSocket.prototype.sendRaw = function (message) {
        if (this.ws && this._connected) {
            this.ws.send(JSON.stringify(message));
        }
    };
    /**
     * Emit an event without expecting acknowledgement
     */
    HappyWebSocket.prototype.emit = function (event, data) {
        if (!this._connected) {
            throw new WebSocketDisconnectedError("emit '".concat(event, "'"));
        }
        this.sendRaw({ event: event, data: data });
    };
    Object.defineProperty(HappyWebSocket.prototype, "volatile", {
        /**
         * Emit a volatile event (fire-and-forget, no error if disconnected)
         */
        get: function () {
            var _this = this;
            return {
                emit: function (event, data) {
                    if (_this._connected) {
                        _this.sendRaw({ event: event, data: data });
                    }
                }
            };
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Emit an event and wait for acknowledgement
     */
    HappyWebSocket.prototype.emitWithAck = function (event, data, timeout) {
        return __awaiter(this, void 0, void 0, function () {
            var ackId, ackTimeout;
            var _this = this;
            return __generator(this, function (_a) {
                if (!this._connected) {
                    throw new WebSocketDisconnectedError("emitWithAck '".concat(event, "'"));
                }
                ackId = (0, node_crypto_1.randomUUID)();
                ackTimeout = timeout !== null && timeout !== void 0 ? timeout : this.config.ackTimeout;
                return [2 /*return*/, new Promise(function (resolve, reject) {
                        var timer = setTimeout(function () {
                            _this.pendingAcks.delete(ackId);
                            reject(new WebSocketAckTimeoutError(event, ackTimeout));
                        }, ackTimeout);
                        _this.pendingAcks.set(ackId, { resolve: resolve, reject: reject, timer: timer });
                        _this.sendRaw({ event: event, data: data, ackId: ackId });
                    })];
            });
        });
    };
    /**
     * Reject all pending acknowledgements
     */
    HappyWebSocket.prototype.rejectAllPendingAcks = function (error) {
        for (var _i = 0, _a = this.pendingAcks; _i < _a.length; _i++) {
            var _b = _a[_i], _ackId = _b[0], pending = _b[1];
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingAcks.clear();
    };
    /**
     * Clean up stale acknowledgement entries that may have orphaned timers.
     * Called during memory pressure events or periodic maintenance. (HAP-353)
     *
     * @returns Number of stale entries removed
     */
    HappyWebSocket.prototype.cleanupStaleAcks = function () {
        var cleaned = 0;
        for (var _i = 0, _a = this.pendingAcks; _i < _a.length; _i++) {
            var _b = _a[_i], ackId = _b[0], pending = _b[1];
            // If timer is somehow null/undefined but entry exists, it's orphaned
            if (!pending.timer) {
                this.pendingAcks.delete(ackId);
                cleaned++;
                logger_1.logger.debug("[HappyWebSocket] Cleaned up orphaned ack entry: ".concat(ackId));
            }
        }
        if (cleaned > 0) {
            logger_1.logger.debug("[HappyWebSocket] Cleaned up ".concat(cleaned, " stale ack entries"));
        }
        return cleaned;
    };
    /**
     * Get current handler and ack counts for monitoring/diagnostics.
     * Useful for tracking memory pressure and debugging. (HAP-353)
     */
    HappyWebSocket.prototype.getStats = function () {
        var totalHandlers = 0;
        for (var _i = 0, _a = this.eventHandlers.values(); _i < _a.length; _i++) {
            var handlers = _a[_i];
            // Count only live handlers (HAP-361)
            totalHandlers += this.countLiveHandlers(handlers);
        }
        return {
            totalHandlers: totalHandlers,
            eventTypes: this.eventHandlers.size,
            pendingAcks: this.pendingAcks.size
        };
    };
    /**
     * Get comprehensive WebSocket metrics for observability (HAP-362)
     *
     * Combines point-in-time statistics (gauges) with cumulative counters
     * for tracking WebSocket handler map health over time.
     *
     * @returns WebSocketMetrics with both gauges and counters
     */
    HappyWebSocket.prototype.getMetrics = function () {
        var stats = this.getStats();
        return {
            // Gauges from getStats()
            totalHandlers: stats.totalHandlers,
            eventTypes: stats.eventTypes,
            pendingAcks: stats.pendingAcks,
            // Counters
            memoryPressureCount: this.memoryPressureCount,
            acksCleanedTotal: this.acksCleanedTotal,
            handlersRejectedTotal: this.handlersRejectedTotal
        };
    };
    /**
     * Count live handlers in a Set of WeakRefs (HAP-361)
     * Iterates through WeakRefs and counts only those that haven't been GC'd
     */
    HappyWebSocket.prototype.countLiveHandlers = function (handlers) {
        var count = 0;
        for (var _i = 0, handlers_4 = handlers; _i < handlers_4.length; _i++) {
            var weakRef = handlers_4[_i];
            if (weakRef.deref()) {
                count++;
            }
        }
        return count;
    };
    /**
     * Called during memory pressure to clean up non-essential state. (HAP-353)
     * Removes orphaned acks and reports stats for diagnostics.
     * Increments metrics counters for observability (HAP-362).
     */
    HappyWebSocket.prototype.onMemoryPressure = function () {
        var statsBefore = this.getStats();
        var acksCleanedUp = this.cleanupStaleAcks();
        // HAP-362: Increment metrics counters
        this.memoryPressureCount++;
        this.acksCleanedTotal += acksCleanedUp;
        logger_1.logger.debug("[HappyWebSocket] Memory pressure cleanup: ".concat(acksCleanedUp, " acks cleaned. Stats: handlers=").concat(statsBefore.totalHandlers, ", events=").concat(statsBefore.eventTypes, ", pendingAcks=").concat(statsBefore.pendingAcks));
    };
    /**
     * Close the WebSocket connection
     */
    HappyWebSocket.prototype.close = function () {
        this.isManualClose = true;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.rejectAllPendingAcks(new WebSocketDisconnectedError('connection closed'));
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this._connected = false;
        this.connectionPromise = null;
        this.connectionResolve = null;
        this.connectionReject = null;
    };
    // Event handlers
    HappyWebSocket.MAX_HANDLERS_PER_EVENT = 100;
    HappyWebSocket.HANDLER_WARNING_THRESHOLD = 90;
    return HappyWebSocket;
}());
exports.HappyWebSocket = HappyWebSocket;
