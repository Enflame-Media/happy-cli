/**
 * WebSocket utility functions for the Happy CLI
 * Provides timeout wrappers and error types for WebSocket operations
 *
 * @see HAP-261 - Migrated from Socket.io to native WebSocket
 */

/**
 * Response type for 'update-metadata' and 'machine-update-metadata' events
 */
export type MetadataUpdateResponse = {
    result: 'error'
} | {
    result: 'version-mismatch';
    version: number;
    metadata: string;
} | {
    result: 'success';
    version: number;
    metadata: string;
};

/**
 * Response type for 'update-state' event (session agent state)
 */
export type StateUpdateResponse = {
    result: 'error'
} | {
    result: 'version-mismatch';
    version: number;
    agentState: string | null;
} | {
    result: 'success';
    version: number;
    agentState: string | null;
};

/**
 * Response type for 'machine-update-state' event (daemon state)
 */
export type DaemonStateUpdateResponse = {
    result: 'error'
} | {
    result: 'version-mismatch';
    version: number;
    daemonState: string;
} | {
    result: 'success';
    version: number;
    daemonState: string;
};

/**
 * Error thrown when a WebSocket acknowledgment times out
 */
export class SocketAckTimeoutError extends Error {
    constructor(event: string, timeoutMs: number) {
        super(`Socket ack timeout for event '${event}' after ${timeoutMs}ms`);
        this.name = 'SocketAckTimeoutError';
    }
}


/**
 * Error thrown when attempting to send a message on a disconnected WebSocket.
 * Callers should catch this error and handle gracefully (e.g., display
 * "Disconnected from server" message and terminate session cleanly).
 */
export class SocketDisconnectedError extends Error {
    constructor(operation: string = 'send message') {
        super(`Socket not connected: cannot ${operation}`);
        this.name = 'SocketDisconnectedError';
    }
}
