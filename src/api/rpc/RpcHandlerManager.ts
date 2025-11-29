/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration, encryption/decryption, and handler execution
 * Supports request cancellation via AbortController
 */

import { logger as defaultLogger } from '@/ui/logger';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import {
    RpcHandler,
    RpcHandlerMap,
    RpcRequest,
    RpcHandlerConfig,
    RpcCancelRequest,
} from './types';
import { Socket } from 'socket.io-client';

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map();
    private readonly scopePrefix: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private readonly logger: (message: string, data?: any) => void;
    private socket: Socket | null = null;

    // Track pending requests for cancellation support
    private pendingRequests: Map<string, AbortController> = new Map();

    // Store cancel handler reference for cleanup
    private cancelHandler: ((data: RpcCancelRequest) => void) | null = null;

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.encryptionKey = config.encryptionKey;
        this.encryptionVariant = config.encryptionVariant;
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data));
    }

    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    registerHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const prefixedMethod = this.getPrefixedMethod(method);

        // Store the handler
        this.handlers.set(prefixedMethod, handler);

        if (this.socket) {
            this.socket.emit('rpc-register', { method: prefixedMethod });
        }
    }

    /**
     * Handle an incoming RPC request
     * @param request - The RPC request data
     */
    async handleRequest(
        request: RpcRequest,
    ): Promise<any> {
        const requestId = request.requestId;
        let abortController: AbortController | undefined;

        // Track the request if it has a requestId
        if (requestId) {
            abortController = new AbortController();
            this.pendingRequests.set(requestId, abortController);
        }

        try {
            const handler = this.handlers.get(request.method);

            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method });
                const errorResponse = { error: 'Method not found', cancelled: false };
                const encryptedError = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, errorResponse));
                return encryptedError;
            }

            // Check if already cancelled before starting
            if (abortController?.signal.aborted) {
                throw new Error('Request cancelled');
            }

            // Decrypt the incoming params
            const decryptedParams = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(request.params));

            // Call the handler with abort signal
            // Use a noop signal if no abortController (for backwards compatibility with non-cancellable requests)
            const signal = abortController?.signal ?? new AbortController().signal;
            const result = await handler(decryptedParams, signal);

            // Check if cancelled during execution
            if (abortController?.signal.aborted) {
                throw new Error('Request cancelled');
            }

            // Encrypt and return the response
            const encryptedResponse = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, result));
            return encryptedResponse;
        } catch (error) {
            const isCancelled = abortController?.signal.aborted ?? false;
            const errorMessage = isCancelled ? 'Request cancelled' : (error instanceof Error ? error.message : 'Unknown error');

            this.logger('[RPC] [ERROR] Error handling request', { error: errorMessage, cancelled: isCancelled });
            const errorResponse = {
                error: errorMessage,
                cancelled: isCancelled
            };
            return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, errorResponse));
        } finally {
            // Clean up tracking
            if (requestId) {
                this.pendingRequests.delete(requestId);
            }
        }
    }

    /**
     * Handle a cancellation request from the server
     * @param cancel - The cancellation request data
     */
    handleCancellation(cancel: RpcCancelRequest): void {
        // Validate cancellation request
        if (!cancel.requestId || typeof cancel.requestId !== 'string') {
            this.logger('[RPC] [ERROR] Invalid cancellation request - missing or invalid requestId');
            return;
        }

        const controller = this.pendingRequests.get(cancel.requestId);
        if (controller) {
            this.logger('[RPC] Cancelling request', { requestId: cancel.requestId, method: cancel.method });
            controller.abort();
            // Note: Don't delete here - handleRequest's finally block handles cleanup
            // Deleting here would cause a race condition if the handler is still running
        } else {
            // Request may have already completed or was never tracked
            this.logger('[RPC] Cancellation request for unknown or completed request', { requestId: cancel.requestId });
        }
    }

    /**
     * Get the number of pending requests
     */
    getPendingRequestCount(): number {
        return this.pendingRequests.size;
    }

    /**
     * Cancel all pending requests (e.g., on disconnect)
     */
    cancelAllPendingRequests(): void {
        for (const [requestId, controller] of this.pendingRequests) {
            this.logger('[RPC] Cancelling request due to disconnect', { requestId });
            controller.abort();
        }
        this.pendingRequests.clear();
    }

    onSocketConnect(socket: Socket): void {
        this.socket = socket;
        for (const [prefixedMethod] of this.handlers) {
            socket.emit('rpc-register', { method: prefixedMethod });
        }

        // Listen for cancellation events from the server
        // Store the bound handler so we can remove it later
        if (!this.cancelHandler) {
            this.cancelHandler = (data: RpcCancelRequest) => {
                this.handleCancellation(data);
            };
        }
        socket.on('rpc-cancel', this.cancelHandler);
    }

    onSocketDisconnect(): void {
        // Remove the cancellation listener to prevent memory leaks
        if (this.socket && this.cancelHandler) {
            this.socket.off('rpc-cancel', this.cancelHandler);
        }

        this.socket = null;
        // Cancel all pending requests on disconnect
        this.cancelAllPendingRequests();
    }

    /**
     * Get the number of registered handlers
     */
    getHandlerCount(): number {
        return this.handlers.size;
    }

    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    hasHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear();
        this.logger('Cleared all RPC handlers');
    }

    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`;
    }
}

/**
 * Factory function to create an RPC handler manager
 */
export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config);
}