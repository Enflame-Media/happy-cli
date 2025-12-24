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

import { logger } from '@/ui/logger';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { ServerToClientEvents, ClientToServerEvents } from './types';

/**
 * Configuration for WebSocket connection behavior
 */
export interface HappyWebSocketConfig {
    /** Base reconnection delay in milliseconds (default: 1000) */
    reconnectionDelay?: number;
    /** Maximum reconnection delay in milliseconds (default: 30000) */
    reconnectionDelayMax?: number;
    /** Randomization factor for jitter (0-1, default: 0.5) */
    randomizationFactor?: number;
    /** Connection timeout in milliseconds (default: 20000) */
    timeout?: number;
    /** Maximum reconnection attempts (default: Infinity) */
    maxReconnectionAttempts?: number;
    /** Default acknowledgment timeout in milliseconds (default: 5000) */
    ackTimeout?: number;
}

/**
 * Authentication data sent with WebSocket connection
 */
export interface HappyWebSocketAuth {
    token: string;
    clientType: 'session-scoped' | 'machine-scoped';
    sessionId?: string;
    machineId?: string;
}

/**
 * Typed event map for WebSocket events
 */
type EventCallback<T = unknown> = (data: T) => void | Promise<void>;
type RpcCallback = (data: { method: string; params: string }, callback: (response: string) => void) => void | Promise<void>;

/**
 * Type aliases for typed event handling (HAP-520)
 * @see ServerToClientEvents - Events received from server
 * @see ClientToServerEvents - Events sent to server
 */
type ServerEventName = keyof ServerToClientEvents;
type ClientEventName = keyof ClientToServerEvents;

/**
 * Pending acknowledgement tracking
 */
interface PendingAck<T = unknown> {
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

/**
 * Metadata for FinalizationRegistry cleanup (HAP-361)
 * Stores the event name and WeakRef so dead handlers can be removed from Sets
 */
interface HandlerMetadata {
    event: string;
    weakRef: WeakRef<EventCallback>;
}

/**
 * WebSocket message format for the Happy protocol
 *
 * Messages are JSON-encoded with the following structure:
 * - event: The event name (e.g., 'message', 'update-metadata')
 * - data: The payload for the event
 * - ackId: Optional acknowledgement ID for request-response patterns
 * - ack: If present, this is an acknowledgement response
 */
interface HappyMessage {
    event: string;
    data?: unknown;
    ackId?: string;
    ack?: unknown;
}

/**
 * WebSocket metrics for observability (HAP-362)
 *
 * Combines point-in-time statistics (gauges) with cumulative counters
 * for tracking WebSocket handler map health over time.
 */
export interface WebSocketMetrics {
    // Gauges - point-in-time values
    /** Total handlers across all events */
    totalHandlers: number;
    /** Number of distinct event types with registered handlers */
    eventTypes: number;
    /** Current pending acknowledgements awaiting response */
    pendingAcks: number;

    // Counters - cumulative values
    /** Times memory pressure cleanup has been triggered */
    memoryPressureCount: number;
    /** Total stale acks removed by memory pressure cleanup */
    acksCleanedTotal: number;
    /** Total handlers rejected due to MAX_HANDLERS_PER_EVENT limit */
    handlersRejectedTotal: number;
}

/**
 * Error thrown when a WebSocket acknowledgment times out
 */
class WebSocketAckTimeoutError extends Error {
    constructor(event: string, timeoutMs: number) {
        super(`WebSocket ack timeout for event '${event}' after ${timeoutMs}ms`);
        this.name = 'WebSocketAckTimeoutError';
    }
}

/**
 * Error thrown when attempting to send on a disconnected WebSocket
 */
class WebSocketDisconnectedError extends Error {
    constructor(operation: string = 'send message') {
        super(`WebSocket not connected: cannot ${operation}`);
        this.name = 'WebSocketDisconnectedError';
    }
}

/**
 * Native WebSocket client with auto-reconnection and Socket.io-like API
 */
export class HappyWebSocket {
    private ws: WebSocket | null = null;
    private readonly baseUrl: string;
    private readonly path: string;
    private readonly auth: HappyWebSocketAuth;
    private readonly config: Required<HappyWebSocketConfig>;

    // Connection state
    private _connected = false;
    private reconnectAttempts = 0;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private isManualClose = false;
    private connectionPromise: Promise<void> | null = null;
    private connectionResolve: (() => void) | null = null;
    private connectionReject: ((error: Error) => void) | null = null;

    // Event handlers
    private static readonly MAX_HANDLERS_PER_EVENT = 100;
    private static readonly HANDLER_WARNING_THRESHOLD = 90;

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
    private eventHandlers: Map<string, Set<WeakRef<EventCallback>>> = new Map();

    /**
     * O(1) lookup for .off() - maps original callback to its WeakRef (HAP-361)
     * Uses WeakMap so the lookup itself doesn't prevent callback GC
     */
    private callbackToWeakRef: WeakMap<EventCallback, WeakRef<EventCallback>> = new WeakMap();

    /**
     * FinalizationRegistry for automatic cleanup when callbacks are GC'd (HAP-361)
     * When a callback is garbage collected, removes its WeakRef from eventHandlers
     */
    private readonly handlerRegistry: FinalizationRegistry<HandlerMetadata>;

    private rpcHandler: RpcCallback | null = null;

    // Acknowledgement tracking
    private pendingAcks: Map<string, PendingAck> = new Map();

    // Metrics counters for observability (HAP-362)
    // These are cumulative counters that persist across the socket lifetime
    private memoryPressureCount = 0;
    private acksCleanedTotal = 0;
    private handlersRejectedTotal = 0;

    constructor(
        baseUrl: string,
        auth: HappyWebSocketAuth,
        config: HappyWebSocketConfig = {},
        path: string = '/v1/updates'
    ) {
        this.baseUrl = baseUrl;
        this.path = path;
        this.auth = auth;

        // Apply default configuration
        this.config = {
            reconnectionDelay: config.reconnectionDelay ?? 1000,
            reconnectionDelayMax: config.reconnectionDelayMax ?? 30000,
            randomizationFactor: config.randomizationFactor ?? 0.5,
            timeout: config.timeout ?? 20000,
            maxReconnectionAttempts: config.maxReconnectionAttempts ?? Infinity,
            ackTimeout: config.ackTimeout ?? 5000,
        };

        // Initialize FinalizationRegistry for automatic handler cleanup (HAP-361)
        // When a callback is garbage collected, this removes its WeakRef from the Set
        this.handlerRegistry = new FinalizationRegistry((metadata: HandlerMetadata) => {
            const handlers = this.eventHandlers.get(metadata.event);
            if (handlers) {
                handlers.delete(metadata.weakRef);
                logger.debug(`[HappyWebSocket] Handler for '${metadata.event}' was garbage collected`);
            }
        });
    }

    /**
     * Whether the WebSocket is currently connected
     */
    get connected(): boolean {
        return this._connected;
    }

    /**
     * Connect to the WebSocket server
     */
    connect(): Promise<void> {
        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        this.isManualClose = false;
        this.connectionPromise = new Promise((resolve, reject) => {
            this.connectionResolve = resolve;
            this.connectionReject = reject;
            this.doConnect();
        });

        return this.connectionPromise;
    }

    /**
     * Internal connection logic
     */
    private doConnect(): void {
        // Build WebSocket URL without auth in query string (security: avoid URL logging)
        const wsUrl = new URL(this.path, this.baseUrl);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

        // Build auth headers for secure transmission
        // Server-side parseHandshake() supports Authorization header as fallback
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.auth.token}`,
            'X-Client-Type': this.auth.clientType,
        };
        if (this.auth.sessionId) {
            headers['X-Session-Id'] = this.auth.sessionId;
        }
        if (this.auth.machineId) {
            headers['X-Machine-Id'] = this.auth.machineId;
        }

        logger.debug(`[HappyWebSocket] Connecting to ${wsUrl.toString()}`);

        // Set connection timeout
        const connectionTimer = setTimeout(() => {
            if (!this._connected && this.ws) {
                logger.debug('[HappyWebSocket] Connection timeout');
                this.ws.terminate();
                this.handleConnectionError(new Error('Connection timeout'));
            }
        }, this.config.timeout);

        try {
            // Pass auth via headers instead of URL query params for security
            // This prevents token exposure in server logs, proxy logs, and browser history
            this.ws = new WebSocket(wsUrl.toString(), { headers });

            this.ws.on('open', () => {
                clearTimeout(connectionTimer);
                this._connected = true;
                this.reconnectAttempts = 0;
                logger.debug('[HappyWebSocket] Connected');

                // Resolve connection promise
                if (this.connectionResolve) {
                    this.connectionResolve();
                    this.connectionResolve = null;
                    this.connectionReject = null;
                }

                // Emit connect event
                this.emitInternal('connect', undefined);
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                this.handleMessage(data);
            });

            this.ws.on('close', (code: number, reason: Buffer) => {
                clearTimeout(connectionTimer);
                const wasConnected = this._connected;
                this._connected = false;

                logger.debug(`[HappyWebSocket] Disconnected: code=${code}, reason=${reason.toString()}`);

                // Reject any pending acks
                this.rejectAllPendingAcks(new WebSocketDisconnectedError('connection closed'));

                // Emit disconnect event
                if (wasConnected) {
                    this.emitInternal('disconnect', this.getDisconnectReason(code));
                }

                // Attempt reconnection if not manually closed
                if (!this.isManualClose) {
                    this.scheduleReconnect();
                }
            });

            this.ws.on('error', (error: Error) => {
                clearTimeout(connectionTimer);
                logger.debug(`[HappyWebSocket] Error: ${error.message}`);
                this.emitInternal('connect_error', error);

                // If not connected yet, this is a connection error
                if (!this._connected) {
                    this.handleConnectionError(error);
                }
            });
        } catch (error) {
            clearTimeout(connectionTimer);
            this.handleConnectionError(error as Error);
        }
    }

    /**
     * Handle connection errors
     */
    private handleConnectionError(error: Error): void {
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
    }

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
    private scheduleReconnect(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        if (this.reconnectAttempts >= this.config.maxReconnectionAttempts) {
            logger.debug('[HappyWebSocket] Max reconnection attempts reached');
            this.emitInternal('reconnect_failed', undefined);
            return;
        }

        // Calculate delay with exponential backoff and centered jitter (HAP-477)
        const baseDelay = Math.min(
            this.config.reconnectionDelay * Math.pow(2, this.reconnectAttempts),
            this.config.reconnectionDelayMax
        );
        // Centered jitter: spreads delay ±factor around base, not just +factor
        // With factor=0.5: delay ranges from base*0.5 to base*1.5
        const jitterMultiplier = 1 - this.config.randomizationFactor + (Math.random() * this.config.randomizationFactor * 2);
        const delay = Math.max(100, baseDelay * jitterMultiplier); // Minimum 100ms floor

        this.reconnectAttempts++;
        logger.debug(`[HappyWebSocket] Scheduling reconnection in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}, base ${Math.round(baseDelay)}ms)`);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.emitInternal('reconnect_attempt', this.reconnectAttempts);
            this.doConnect();
        }, delay);
    }

    /**
     * Map WebSocket close codes to disconnect reasons
     */
    private getDisconnectReason(code: number): string {
        switch (code) {
            case 1000: return 'io client disconnect';
            case 1001: return 'transport close';
            case 1006: return 'transport error';
            case 4000: return 'io server disconnect';
            default: return `transport close (code: ${code})`;
        }
    }

    /**
     * Handle incoming WebSocket messages
     */
    private handleMessage(data: WebSocket.Data): void {
        try {
            const message = JSON.parse(data.toString()) as HappyMessage;

            // Handle acknowledgement responses
            if (message.ackId && message.ack !== undefined) {
                const pending = this.pendingAcks.get(message.ackId);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingAcks.delete(message.ackId);
                    pending.resolve(message.ack);
                }
                return;
            }

            // Handle RPC requests (special case with callback)
            if (message.event === 'rpc-request' && message.ackId && this.rpcHandler) {
                const callback = (response: string) => {
                    this.sendRaw({
                        event: 'rpc-response',
                        ackId: message.ackId,
                        ack: response
                    });
                };
                this.rpcHandler(message.data as { method: string; params: string }, callback);
                return;
            }

            // Handle regular events
            this.emitInternal(message.event, message.data);
        } catch (error) {
            logger.debug(`[HappyWebSocket] Failed to parse message: ${error}`);
        }
    }

    /**
     * Register an event handler
     *
     * IMPORTANT (HAP-361): Handlers are stored as WeakRefs. The handler will be
     * garbage collected if the caller doesn't retain a reference to the callback.
     * Store the callback in a variable to ensure it persists.
     */
    on<T = unknown>(event: string, callback: EventCallback<T>): this {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }

        const handlers = this.eventHandlers.get(event)!;
        const typedCallback = callback as EventCallback;

        // Check if callback already registered (via WeakMap lookup)
        const existingWeakRef = this.callbackToWeakRef.get(typedCallback);
        if (existingWeakRef && handlers.has(existingWeakRef)) {
            return this; // Already registered
        }

        // Bounds enforcement: count only live handlers (HAP-353)
        const liveCount = this.countLiveHandlers(handlers);
        if (liveCount >= HappyWebSocket.MAX_HANDLERS_PER_EVENT) {
            logger.warn(`[HappyWebSocket] Max handlers (${HappyWebSocket.MAX_HANDLERS_PER_EVENT}) reached for event '${event}'. Rejecting new handler.`);
            this.handlersRejectedTotal++; // HAP-362: Track rejection for metrics
            return this;
        }

        // Warning at threshold
        if (liveCount === HappyWebSocket.HANDLER_WARNING_THRESHOLD) {
            logger.warn(`[HappyWebSocket] Handler count approaching limit (${liveCount}/${HappyWebSocket.MAX_HANDLERS_PER_EVENT}) for event '${event}'`);
        }

        // Create WeakRef and store (HAP-361)
        const weakRef = new WeakRef(typedCallback);
        handlers.add(weakRef);
        this.callbackToWeakRef.set(typedCallback, weakRef);

        // Register for cleanup notification when callback is GC'd
        this.handlerRegistry.register(typedCallback, { event, weakRef }, typedCallback);

        return this;
    }

    /**
     * Register the RPC request handler (special case with callback)
     */
    onRpcRequest(handler: RpcCallback): this {
        this.rpcHandler = handler;
        return this;
    }

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
    onServer<K extends ServerEventName>(
        event: K,
        callback: ServerToClientEvents[K]
    ): this {
        // Cast to EventCallback for internal storage while preserving external type safety
        return this.on(event, callback as EventCallback);
    }

    /**
     * Remove a type-safe handler for server-to-client events.
     *
     * @param event - Server event name
     * @param callback - The same callback reference passed to onServer()
     * @returns this for chaining
     */
    offServer<K extends ServerEventName>(
        event: K,
        callback: ServerToClientEvents[K]
    ): this {
        return this.off(event, callback as EventCallback);
    }

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
    emitClient<K extends ClientEventName>(
        event: K,
        data: Parameters<ClientToServerEvents[K]>[0]
    ): void {
        this.emit(event, data);
    }

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
    emitClientVolatile<K extends ClientEventName>(
        event: K,
        data: Parameters<ClientToServerEvents[K]>[0]
    ): void {
        this.volatile.emit(event, data);
    }

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
    emitClientWithAck<K extends ClientEventName, R = unknown>(
        event: K,
        data: Parameters<ClientToServerEvents[K]>[0],
        timeout?: number
    ): Promise<R> {
        return this.emitWithAck<R>(event, data, timeout);
    }

    /**
     * Remove an event handler
     */
    off<T = unknown>(event: string, callback: EventCallback<T>): this {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            const typedCallback = callback as EventCallback;
            const weakRef = this.callbackToWeakRef.get(typedCallback);
            if (weakRef) {
                handlers.delete(weakRef);
                this.callbackToWeakRef.delete(typedCallback);
                // Unregister from FinalizationRegistry to prevent stale cleanup
                this.handlerRegistry.unregister(typedCallback);
            }
        }
        return this;
    }

    /**
     * Remove all event handlers
     */
    removeAllListeners(event?: string): this {
        if (event) {
            const handlers = this.eventHandlers.get(event);
            if (handlers) {
                // Unregister all handlers for this event from FinalizationRegistry
                for (const weakRef of handlers) {
                    const callback = weakRef.deref();
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
        } else {
            // Unregister all handlers from FinalizationRegistry
            for (const handlers of this.eventHandlers.values()) {
                for (const weakRef of handlers) {
                    const callback = weakRef.deref();
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
    }

    /**
     * Internal event emission
     *
     * WeakRef iteration (HAP-361): Dereferences each WeakRef and cleans up
     * dead references during iteration for efficiency.
     */
    private emitInternal(event: string, data: unknown): void {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            const deadRefs: WeakRef<EventCallback>[] = [];

            for (const weakRef of handlers) {
                const handler = weakRef.deref();
                if (handler) {
                    try {
                        handler(data);
                    } catch (error) {
                        logger.debug(`[HappyWebSocket] Error in event handler for '${event}': ${error}`);
                    }
                } else {
                    // Collect dead refs for cleanup
                    deadRefs.push(weakRef);
                }
            }

            // Cleanup dead refs after iteration
            for (const deadRef of deadRefs) {
                handlers.delete(deadRef);
            }
        }
    }

    /**
     * Send raw message without acknowledgement
     */
    private sendRaw(message: HappyMessage): void {
        if (this.ws && this._connected) {
            this.ws.send(JSON.stringify(message));
        }
    }

    /**
     * Emit an event without expecting acknowledgement
     */
    emit(event: string, data: unknown): void {
        if (!this._connected) {
            throw new WebSocketDisconnectedError(`emit '${event}'`);
        }

        this.sendRaw({ event, data });
    }

    /**
     * Emit a volatile event (fire-and-forget, no error if disconnected)
     */
    get volatile(): { emit: (event: string, data: unknown) => void } {
        return {
            emit: (event: string, data: unknown) => {
                if (this._connected) {
                    this.sendRaw({ event, data });
                }
            }
        };
    }

    /**
     * Emit an event and wait for acknowledgement
     */
    async emitWithAck<T = unknown>(event: string, data: unknown, timeout?: number): Promise<T> {
        if (!this._connected) {
            throw new WebSocketDisconnectedError(`emitWithAck '${event}'`);
        }

        const ackId = randomUUID();
        const ackTimeout = timeout ?? this.config.ackTimeout;

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingAcks.delete(ackId);
                reject(new WebSocketAckTimeoutError(event, ackTimeout));
            }, ackTimeout);

            this.pendingAcks.set(ackId, { resolve: resolve as (value: unknown) => void, reject, timer });

            this.sendRaw({ event, data, ackId });
        });
    }

    /**
     * Reject all pending acknowledgements
     */
    private rejectAllPendingAcks(error: Error): void {
        for (const [_ackId, pending] of this.pendingAcks) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingAcks.clear();
    }

    /**
     * Clean up stale acknowledgement entries that may have orphaned timers.
     * Called during memory pressure events or periodic maintenance. (HAP-353)
     *
     * @returns Number of stale entries removed
     */
    cleanupStaleAcks(): number {
        let cleaned = 0;
        for (const [ackId, pending] of this.pendingAcks) {
            // If timer is somehow null/undefined but entry exists, it's orphaned
            if (!pending.timer) {
                this.pendingAcks.delete(ackId);
                cleaned++;
                logger.debug(`[HappyWebSocket] Cleaned up orphaned ack entry: ${ackId}`);
            }
        }
        if (cleaned > 0) {
            logger.debug(`[HappyWebSocket] Cleaned up ${cleaned} stale ack entries`);
        }
        return cleaned;
    }

    /**
     * Get current handler and ack counts for monitoring/diagnostics.
     * Useful for tracking memory pressure and debugging. (HAP-353)
     */
    getStats(): { totalHandlers: number; eventTypes: number; pendingAcks: number } {
        let totalHandlers = 0;
        for (const handlers of this.eventHandlers.values()) {
            // Count only live handlers (HAP-361)
            totalHandlers += this.countLiveHandlers(handlers);
        }
        return {
            totalHandlers,
            eventTypes: this.eventHandlers.size,
            pendingAcks: this.pendingAcks.size
        };
    }

    /**
     * Get comprehensive WebSocket metrics for observability (HAP-362)
     *
     * Combines point-in-time statistics (gauges) with cumulative counters
     * for tracking WebSocket handler map health over time.
     *
     * @returns WebSocketMetrics with both gauges and counters
     */
    getMetrics(): WebSocketMetrics {
        const stats = this.getStats();
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
    }

    /**
     * Count live handlers in a Set of WeakRefs (HAP-361)
     * Iterates through WeakRefs and counts only those that haven't been GC'd
     */
    private countLiveHandlers(handlers: Set<WeakRef<EventCallback>>): number {
        let count = 0;
        for (const weakRef of handlers) {
            if (weakRef.deref()) {
                count++;
            }
        }
        return count;
    }

    /**
     * Called during memory pressure to clean up non-essential state. (HAP-353)
     * Removes orphaned acks and reports stats for diagnostics.
     * Increments metrics counters for observability (HAP-362).
     */
    onMemoryPressure(): void {
        const statsBefore = this.getStats();
        const acksCleanedUp = this.cleanupStaleAcks();

        // HAP-362: Increment metrics counters
        this.memoryPressureCount++;
        this.acksCleanedTotal += acksCleanedUp;

        logger.debug(`[HappyWebSocket] Memory pressure cleanup: ${acksCleanedUp} acks cleaned. Stats: handlers=${statsBefore.totalHandlers}, events=${statsBefore.eventTypes}, pendingAcks=${statsBefore.pendingAcks}`);
    }

    /**
     * Close the WebSocket connection
     */
    close(): void {
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
    }
}
