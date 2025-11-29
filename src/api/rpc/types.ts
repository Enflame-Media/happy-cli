/**
 * Common RPC types and interfaces for both session and machine clients
 */

/**
 * Generic RPC handler function type
 * @template TRequest - The request data type
 * @template TResponse - The response data type
 *
 * Handlers receive:
 * - data: The decrypted request parameters
 * - signal: AbortSignal that can be checked via signal.aborted or listened to via signal.addEventListener('abort', ...)
 *
 * For long-running operations, handlers should:
 * 1. Check signal.aborted before starting work
 * 2. Periodically check signal.aborted during execution
 * 3. Listen to signal.addEventListener('abort', ...) to stop async operations
 * 4. Throw an error or return early if aborted
 */
export type RpcHandler<TRequest = any, TResponse = any> = (
    data: TRequest,
    signal: AbortSignal
) => TResponse | Promise<TResponse>;

/**
 * Map of method names to their handlers
 */
export type RpcHandlerMap = Map<string, RpcHandler>;

/**
 * RPC request data from server
 */
export interface RpcRequest {
    method: string;
    params: string; // Base64 encoded encrypted params
    requestId?: string; // Unique request ID for cancellation tracking
}

/**
 * RPC cancellation data from server
 */
export interface RpcCancelRequest {
    requestId: string;
    method: string;
}

/**
 * RPC response callback
 */
export type RpcResponseCallback = (response: string) => void;

/**
 * Configuration for RPC handler manager
 */
export interface RpcHandlerConfig {
    scopePrefix: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    logger?: (message: string, data?: any) => void;
}

/**
 * Result of RPC handler execution
 */
export type RpcHandlerResult<T = any> =
    | { success: true; data: T }
    | { success: false; error: string };