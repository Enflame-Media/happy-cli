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
 *
 * @see HAP-261 - Migration from Socket.io to native WebSocket
 */

import { logger } from '@/ui/logger';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

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
 * Pending acknowledgement tracking
 */
interface PendingAck<T = unknown> {
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
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
 * Error thrown when a WebSocket acknowledgment times out
 */
export class WebSocketAckTimeoutError extends Error {
    constructor(event: string, timeoutMs: number) {
        super(`WebSocket ack timeout for event '${event}' after ${timeoutMs}ms`);
        this.name = 'WebSocketAckTimeoutError';
    }
}

/**
 * Error thrown when attempting to send on a disconnected WebSocket
 */
export class WebSocketDisconnectedError extends Error {
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
    private eventHandlers: Map<string, Set<EventCallback>> = new Map();
    private rpcHandler: RpcCallback | null = null;

    // Acknowledgement tracking
    private pendingAcks: Map<string, PendingAck> = new Map();

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
        // Build WebSocket URL with auth params
        const wsUrl = new URL(this.path, this.baseUrl);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

        // Add auth as query parameters (similar to Socket.io handshake)
        wsUrl.searchParams.set('token', this.auth.token);
        wsUrl.searchParams.set('clientType', this.auth.clientType);
        if (this.auth.sessionId) {
            wsUrl.searchParams.set('sessionId', this.auth.sessionId);
        }
        if (this.auth.machineId) {
            wsUrl.searchParams.set('machineId', this.auth.machineId);
        }

        logger.debug(`[HappyWebSocket] Connecting to ${wsUrl.toString().replace(/token=[^&]+/, 'token=***')}`);

        // Set connection timeout
        const connectionTimer = setTimeout(() => {
            if (!this._connected && this.ws) {
                logger.debug('[HappyWebSocket] Connection timeout');
                this.ws.terminate();
                this.handleConnectionError(new Error('Connection timeout'));
            }
        }, this.config.timeout);

        try {
            this.ws = new WebSocket(wsUrl.toString());

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
     * Schedule a reconnection attempt with exponential backoff
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

        // Calculate delay with exponential backoff and jitter
        const baseDelay = Math.min(
            this.config.reconnectionDelay * Math.pow(2, this.reconnectAttempts),
            this.config.reconnectionDelayMax
        );
        const jitter = baseDelay * this.config.randomizationFactor * Math.random();
        const delay = baseDelay + jitter;

        this.reconnectAttempts++;
        logger.debug(`[HappyWebSocket] Scheduling reconnection in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);

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
     */
    on<T = unknown>(event: string, callback: EventCallback<T>): this {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }
        this.eventHandlers.get(event)!.add(callback as EventCallback);
        return this;
    }

    /**
     * Register the RPC request handler (special case with callback)
     */
    onRpcRequest(handler: RpcCallback): this {
        this.rpcHandler = handler;
        return this;
    }

    /**
     * Remove an event handler
     */
    off<T = unknown>(event: string, callback: EventCallback<T>): this {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            handlers.delete(callback as EventCallback);
        }
        return this;
    }

    /**
     * Remove all event handlers
     */
    removeAllListeners(event?: string): this {
        if (event) {
            this.eventHandlers.delete(event);
            if (event === 'rpc-request') {
                this.rpcHandler = null;
            }
        } else {
            this.eventHandlers.clear();
            this.rpcHandler = null;
        }
        return this;
    }

    /**
     * Internal event emission
     */
    private emitInternal(event: string, data: unknown): void {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            for (const handler of handlers) {
                try {
                    handler(data);
                } catch (error) {
                    logger.debug(`[HappyWebSocket] Error in event handler for '${event}': ${error}`);
                }
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
