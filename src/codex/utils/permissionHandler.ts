/**
 * Permission Handler for Codex tool approval integration
 *
 * Handles tool permission requests and responses for Codex sessions.
 * Simpler than Claude's permission handler since we get tool IDs directly.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { AgentState } from "@/api/types";

/**
 * Default permission request timeout in milliseconds (30 seconds)
 */
const DEFAULT_PERMISSION_TIMEOUT = 30000;

interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

export class CodexPermissionHandler {
    private pendingRequests = new Map<string, PendingRequest>();
    private session: ApiSessionClient;
    private onPermissionTimeoutCallback?: (requestId: string, toolName: string) => void;
    private permissionTimeout: number = DEFAULT_PERMISSION_TIMEOUT;

    constructor(session: ApiSessionClient) {
        this.session = session;
        this.setupRpcHandler();
    }

    /**
     * Set callback to trigger when permission request times out.
     * This allows UI components to be notified and display appropriate feedback.
     */
    setOnPermissionTimeout(callback: (requestId: string, toolName: string) => void): void {
        this.onPermissionTimeoutCallback = callback;
    }

    /**
     * Set the permission request timeout in milliseconds.
     * Default is 30000ms (30 seconds).
     * @param timeoutMs Timeout value in milliseconds
     */
    setPermissionTimeout(timeoutMs: number): void {
        this.permissionTimeout = timeoutMs;
    }

    /**
     * Get the current permission timeout value in milliseconds.
     */
    getPermissionTimeout(): number {
        return this.permissionTimeout;
    }

    /**
     * Handle a tool permission request with timeout support.
     *
     * If no response is received within the configured timeout period,
     * the request will be automatically denied with a 'timeout' status.
     *
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

            // Cleanup function to clear timeout
            const cleanup = () => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                }
            };

            // Timeout handler - triggers when permission request times out
            const timeoutHandler = () => {
                // Prevent further handling
                this.pendingRequests.delete(toolCallId);
                cleanup();

                const timeoutMessage = `Permission request timed out after ${this.permissionTimeout / 1000} seconds`;
                logger.debug(`[Codex] Permission timeout for tool: ${toolName} (${toolCallId})`);

                // Update agent state to move request to completedRequests with timeout status
                this.session.updateAgentState((currentState) => {
                    const request = currentState.requests?.[toolCallId];
                    if (!request) return currentState;

                    const { [toolCallId]: _, ...remainingRequests } = currentState.requests || {};

                    return {
                        ...currentState,
                        requests: remainingRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [toolCallId]: {
                                ...request,
                                completedAt: Date.now(),
                                status: 'timeout',
                                reason: timeoutMessage
                            }
                        }
                    } satisfies AgentState;
                });

                // Trigger timeout callback for UI feedback
                if (this.onPermissionTimeoutCallback) {
                    this.onPermissionTimeoutCallback(toolCallId, toolName);
                }

                // Resolve with denied decision on timeout
                resolve({ decision: 'denied' });
            };

            // Set up timeout
            timeoutHandle = setTimeout(timeoutHandler, this.permissionTimeout);

            // Store the pending request with cleanup on resolve/reject
            this.pendingRequests.set(toolCallId, {
                resolve: (result: PermissionResult) => {
                    cleanup();
                    resolve(result);
                },
                reject: (error: Error) => {
                    cleanup();
                    reject(error);
                },
                toolName,
                input
            });

            // Send push notification
            // this.session.api.push().sendToAllDevices(
            //     'Permission Request',
            //     `Codex wants to use ${toolName}`,
            //     {
            //         sessionId: this.session.sessionId,
            //         requestId: toolCallId,
            //         tool: toolName,
            //         type: 'permission_request'
            //     }
            // );

            // Update agent state with pending request
            this.session.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now()
                    }
                }
            }));

            logger.debug(`[Codex] Permission request sent for tool: ${toolName} (${toolCallId}) (timeout: ${this.permissionTimeout}ms)`);
        });
    }

    /**
     * Setup RPC handler for permission responses
     */
    private setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            async (response, signal) => {
                // console.log(`[Codex] Permission response received:`, response);

                const pending = this.pendingRequests.get(response.id);
                if (!pending) {
                    logger.debug('[Codex] Permission request not found or already resolved');
                    return;
                }

                // Remove from pending
                this.pendingRequests.delete(response.id);

                // Resolve the permission request
                const result: PermissionResult = response.approved
                    ? { decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved' }
                    : { decision: response.decision === 'denied' ? 'denied' : 'abort' };

                pending.resolve(result);

                // Move request to completed in agent state
                this.session.updateAgentState((currentState) => {
                    const request = currentState.requests?.[response.id];
                    if (!request) return currentState;

                    // console.log(`[Codex] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);

                    const { [response.id]: _, ...remainingRequests } = currentState.requests || {};

                    let res = {
                        ...currentState,
                        requests: remainingRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [response.id]: {
                                ...request,
                                completedAt: Date.now(),
                                status: response.approved ? 'approved' : 'denied',
                                decision: result.decision
                            }
                        }
                    } satisfies AgentState;
                    // console.log(`[Codex] Updated agent state:`, res);
                    return res;
                });

                logger.debug(`[Codex] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
            }
        );
    }

    /**
     * Reset state for new sessions
     */
    reset(): void {
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        // Clear requests in agent state
        this.session.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move all pending to completed as canceled
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: 'Session reset'
                };
            }

            return {
                ...currentState,
                requests: {},
                completedRequests
            };
        });

        logger.debug('[Codex] Permission handler reset');
    }
}