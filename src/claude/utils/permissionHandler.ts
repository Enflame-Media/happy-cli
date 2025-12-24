/**
 * Permission Handler for canCallTool integration
 *
 * This module implements a thread-safe permission request/response system for Claude tool calls.
 * It replaces the MCP permission server with direct SDK integration, handling tool permission
 * requests, responses, and state management.
 *
 * ## Permission Flow
 *
 * ```
 * ┌──────────────┐    ┌─────────────────────┐    ┌───────────────┐
 * │ Claude SDK   │───►│  PermissionHandler  │───►│  Mobile App   │
 * │ (tool_use)   │    │                     │    │  (approval)   │
 * └──────────────┘    └─────────────────────┘    └───────────────┘
 *       │                      │                        │
 *       │ 1. canCallTool()     │ 2. handleToolCall()    │
 *       │    with toolName     │    resolves toolCallId │
 *       │    and input         │                        │
 *       │                      │ 3. Creates pending     │
 *       │                      │    request with        │
 *       │                      │    unique ID           │
 *       │                      │                        │
 *       │                      │ 4. Sends push          │
 *       │                      │    notification ───────┼────►
 *       │                      │                        │
 *       │                      │                        │ 5. User approves/
 *       │                      │ 6. RPC 'permission'    │    denies
 *       │                      │    response with ID ◄──┤
 *       │                      │                        │
 *       │ 7. Promise resolves  │ handlePermissionResponse()
 *       │    with result ◄─────┤                        │
 *       │                      │                        │
 * ```
 *
 * ## Concurrency Safety
 *
 * The handler uses several mechanisms to ensure thread-safe operation:
 *
 * 1. **Unique Request ID Correlation**: Each tool call from Claude has a unique `id` in the
 *    `tool_use` content block. This ID is used as the key in `pendingRequests` Map, ensuring
 *    atomic request-response matching even with multiple concurrent requests.
 *
 * 2. **Request Timeout with Cleanup**: Each pending request has an associated timeout. When
 *    the timeout fires, the request is automatically cleaned up:
 *    - Removed from `pendingRequests` Map
 *    - Moved to `completedRequests` in agent state with 'timeout' status
 *    - Promise resolved with deny behavior
 *
 * 3. **Abort Signal Handling**: Each request respects an AbortSignal for cancellation. When
 *    aborted, cleanup is performed and the promise is rejected.
 *
 * 4. **LRU Eviction**: Both `responses` Map and `toolCalls` array have size limits with
 *    automatic eviction of oldest entries to prevent memory leaks.
 *
 * 5. **Session Reset**: The `reset()` method cancels all pending requests and clears state
 *    when switching sessions or modes.
 *
 * ## Race Condition Handling
 *
 * - **Timeout vs Response Race**: The `cleanup()` function clears the timeout handler and
 *   removes event listeners. The first resolution (timeout or response) wins; subsequent
 *   attempts to resolve find the request already removed from `pendingRequests`.
 *
 * - **Identical Tool Calls**: Tool calls with the same name and input are distinguished by
 *   their unique `id` from Claude. The `resolveToolCallId` method marks matched tool calls
 *   as `used` to prevent double-matching.
 *
 * @module permissionHandler
 * @see HAP-467 - Concurrent permission responses may race in MCP server
 */

import { logger } from "@/lib";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "../sdk";
import { PermissionResult } from "../sdk/types";
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from "../sdk/prompts";
import { Session } from "../session";
import { deepEqual } from "@/utils/deepEqual";
import { getToolName } from "./getToolName";
import { EnhancedMode, PermissionMode } from "../loop";
import { getToolDescriptor } from "./getToolDescriptor";
import { delay } from "@/utils/time";
import { AppError, ErrorCodes } from "@/utils/errors";

/**
 * Default permission request timeout in milliseconds (30 seconds)
 */
const DEFAULT_PERMISSION_TIMEOUT = 30000;

/**
 * Response from the mobile app for a permission request.
 *
 * @property id - The unique tool call ID that correlates request to response
 * @property approved - Whether the user approved the tool call
 * @property reason - Optional reason for denial (shown to Claude)
 * @property mode - Optional mode change (e.g., switch to acceptEdits)
 * @property allowTools - Optional list of tools to auto-approve in future
 * @property receivedAt - Timestamp when response was received (for LRU eviction)
 */
interface PermissionResponse {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    receivedAt?: number;
}


/**
 * Represents a pending permission request awaiting user response.
 *
 * Each pending request is stored in `pendingRequests` Map with the tool call ID as key.
 * This enables atomic request-response correlation - when a response arrives, we look up
 * the pending request by ID and resolve/reject its promise.
 *
 * @property resolve - Resolves the permission promise with allow/deny result
 * @property reject - Rejects the permission promise (on abort/reset)
 * @property toolName - The name of the tool being requested
 * @property input - The input arguments for the tool call
 */
interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

/**
 * Manages tool permission requests for Claude Code SDK integration.
 *
 * This class coordinates between Claude's tool calls and user approval via mobile app.
 * It implements atomic request-response correlation using unique tool call IDs, with
 * timeout handling and cleanup to prevent orphaned requests.
 *
 * ## Thread Safety
 *
 * While JavaScript is single-threaded, async operations can interleave. This class
 * ensures correctness through:
 * - Using Map with unique IDs for O(1) lookup and atomic key-based operations
 * - First-resolution-wins pattern for timeout vs response races
 * - Cleanup functions that remove listeners and clear timeouts
 *
 * ## Memory Management
 *
 * - `MAX_RESPONSES` (1000): Limits stored permission responses with LRU eviction
 * - `MAX_TOOL_CALLS` (1000): Limits tracked tool calls with FIFO eviction
 * - Pending requests are removed on resolution, timeout, or abort
 *
 * @example
 * ```typescript
 * const handler = new PermissionHandler(session);
 *
 * // Set callbacks
 * handler.setOnPermissionRequest((id) => console.log('Awaiting:', id));
 * handler.setOnPermissionTimeout((id, tool) => console.log('Timed out:', tool));
 *
 * // Used by SDK as canCallTool callback
 * const result = await handler.handleToolCall('Edit', input, 'agent', { signal });
 * ```
 */
export class PermissionHandler {
    /** Maximum number of permission responses to cache (LRU eviction) */
    private static readonly MAX_RESPONSES = 1000;

    /** Maximum number of tool calls to track (FIFO eviction) */
    private static readonly MAX_TOOL_CALLS = 1000;

    private toolCalls: { id: string, name: string, input: unknown, used: boolean }[] = [];
    private responses = new Map<string, PermissionResponse>();
    private pendingRequests = new Map<string, PendingRequest>();
    private session: Session;
    private allowedTools = new Set<string>();
    private allowedBashLiterals = new Set<string>();
    private allowedBashPrefixes = new Set<string>();
    private permissionMode: PermissionMode = 'default';
    private onPermissionRequestCallback?: (toolCallId: string) => void;
    private onPermissionTimeoutCallback?: (requestId: string, toolName: string) => void;
    private permissionTimeout: number = DEFAULT_PERMISSION_TIMEOUT;

    constructor(session: Session) {
        this.session = session;
        this.setupClientHandler();
    }
    
    /**
     * Set callback to trigger when permission request is made
     */
    setOnPermissionRequest(callback: (toolCallId: string) => void): void {
        this.onPermissionRequestCallback = callback;
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

    handleModeChange(mode: PermissionMode): void {
        this.permissionMode = mode;
    }

    /**
     * Handler response
     */
    private handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingRequest
    ): void {

        // Update allowed tools
        if (response.allowTools && response.allowTools.length > 0) {
            response.allowTools.forEach(tool => {
                if (tool.startsWith('Bash(') || tool === 'Bash') {
                    this.parseBashPermission(tool);
                } else {
                    this.allowedTools.add(tool);
                }
            });
        }

        // Update permission mode
        if (response.mode) {
            this.permissionMode = response.mode;
        }

        // Handle 
        if (pending.toolName === 'exit_plan_mode' || pending.toolName === 'ExitPlanMode') {
            // Handle exit_plan_mode specially
            logger.debug('Plan mode result received', response);
            if (response.approved) {
                logger.debug('Plan approved - injecting PLAN_FAKE_RESTART');
                // Inject the approval message at the beginning of the queue
                if (response.mode && ['default', 'acceptEdits', 'bypassPermissions'].includes(response.mode)) {
                    this.session.queue.unshift(PLAN_FAKE_RESTART, { permissionMode: response.mode });
                } else {
                    this.session.queue.unshift(PLAN_FAKE_RESTART, { permissionMode: 'default' });
                }
                pending.resolve({ behavior: 'deny', message: PLAN_FAKE_REJECT });
            } else {
                pending.resolve({ behavior: 'deny', message: response.reason || 'Plan rejected' });
            }
        } else {
            // Handle default case for all other tools
            const result: PermissionResult = response.approved
                ? { behavior: 'allow', updatedInput: (pending.input as Record<string, unknown>) || {} }
                : { behavior: 'deny', message: response.reason || `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.` };

            pending.resolve(result);
        }
    }

    /**
     * Creates the canCallTool callback for the SDK
     */
    handleToolCall = async (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }): Promise<PermissionResult> => {

        // Check if tool is explicitly allowed
        if (toolName === 'Bash') {
            const inputObj = input as { command?: string };
            if (inputObj?.command) {
                // Check literal matches
                if (this.allowedBashLiterals.has(inputObj.command)) {
                    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                }
                // Check prefix matches
                for (const prefix of this.allowedBashPrefixes) {
                    if (inputObj.command.startsWith(prefix)) {
                        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                    }
                }
            }
        } else if (this.allowedTools.has(toolName)) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        // Calculate descriptor
        const descriptor = getToolDescriptor(toolName);

        //
        // Handle special cases
        //

        if (this.permissionMode === 'bypassPermissions') {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        if (this.permissionMode === 'acceptEdits' && descriptor.edit) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        //
        // Approval flow with exponential backoff for tool call ID resolution
        //

        let toolCallId = this.resolveToolCallId(toolName, input);
        if (!toolCallId) {
            const maxAttempts = 7;
            const baseDelay = 100;

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const delayMs = baseDelay * Math.pow(2, attempt);
                await delay(delayMs);
                toolCallId = this.resolveToolCallId(toolName, input);
                if (toolCallId) break;

                logger.debug(`Waiting for tool call ID, attempt ${attempt + 1}/${maxAttempts} (waited ${delayMs}ms)`);
            }

            if (!toolCallId) {
                throw new AppError(ErrorCodes.OPERATION_FAILED, `Could not resolve tool call ID for ${toolName} after ${maxAttempts} attempts`);
            }
        }
        return this.handlePermissionRequest(toolCallId, toolName, input, options.signal);
    }

    /**
     * Handles individual permission requests with timeout support.
     *
     * If no response is received within the configured timeout period,
     * the request will be automatically denied with a 'timeout' status
     * and the mobile app will be notified.
     */
    private async handlePermissionRequest(
        id: string,
        toolName: string,
        input: unknown,
        signal: AbortSignal
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

            // Cleanup function to clear timeout and remove listeners
            const cleanup = () => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                }
                signal.removeEventListener('abort', abortHandler);
            };

            // Timeout handler - triggers when permission request times out
            const timeoutHandler = () => {
                // Prevent further handling
                this.pendingRequests.delete(id);
                cleanup();

                const timeoutMessage = `Permission request timed out after ${this.permissionTimeout / 1000} seconds`;
                logger.debug(`Permission timeout for tool call ${id}: ${toolName}`);

                // Update agent state to move request to completedRequests with timeout status
                this.session.client.updateAgentState((currentState) => {
                    const request = currentState.requests?.[id];
                    if (!request) return currentState;

                    const updatedRequests = { ...currentState.requests };
                    delete updatedRequests[id];

                    return {
                        ...currentState,
                        requests: updatedRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [id]: {
                                ...request,
                                completedAt: Date.now(),
                                status: 'timeout',
                                reason: timeoutMessage
                            }
                        }
                    };
                });

                // Send push notification about timeout (fire-and-forget in daemon context)
                this.session.api.push().sendToAllDevices(
                    'Permission Timeout',
                    `Permission request for ${getToolName(toolName)} timed out`,
                    {
                        sessionId: this.session.client.sessionId,
                        requestId: id,
                        tool: toolName,
                        type: 'permission_timeout'
                    }
                ).catch((error) => {
                    logger.debug('[PermissionHandler] Failed to send timeout push notification:', error);
                });

                // Trigger timeout callback for UI feedback
                if (this.onPermissionTimeoutCallback) {
                    this.onPermissionTimeoutCallback(id, toolName);
                }

                // Resolve with deny and explicit timeout reason
                resolve({
                    behavior: 'deny',
                    message: timeoutMessage
                });
            };

            // Set up abort signal handling
            const abortHandler = () => {
                this.pendingRequests.delete(id);
                cleanup();

                // Update agent state to move request to completedRequests with canceled status
                this.session.client.updateAgentState((currentState) => {
                    const request = currentState.requests?.[id];
                    if (!request) return currentState;

                    const updatedRequests = { ...currentState.requests };
                    delete updatedRequests[id];

                    return {
                        ...currentState,
                        requests: updatedRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [id]: {
                                ...request,
                                completedAt: Date.now(),
                                status: 'canceled',
                                reason: 'Aborted by signal'
                            }
                        }
                    };
                });

                reject(new Error('Permission request aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });

            // Set up timeout
            timeoutHandle = setTimeout(timeoutHandler, this.permissionTimeout);

            // Store the pending request
            this.pendingRequests.set(id, {
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

            // Trigger callback to send delayed messages immediately
            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(id);
            }

            // Send push notification (fire-and-forget in daemon context)
            this.session.api.push().sendToAllDevices(
                'Permission Request',
                `Claude wants to ${getToolName(toolName)}`,
                {
                    sessionId: this.session.client.sessionId,
                    requestId: id,
                    tool: toolName,
                    type: 'permission_request'
                }
            ).catch((error) => {
                logger.debug('[PermissionHandler] Failed to send permission request push notification:', error);
            });

            // Update agent state
            this.session.client.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [id]: {
                        tool: toolName,
                        arguments: (input as Record<string, unknown>) ?? {},
                        createdAt: Date.now()
                    }
                }
            }));

            logger.debug(`Permission request sent for tool call ${id}: ${toolName} (timeout: ${this.permissionTimeout}ms)`);
        });
    }


    /**
     * Parses Bash permission strings into literal and prefix sets
     */
    private parseBashPermission(permission: string): void {
        // Ignore plain "Bash"
        if (permission === 'Bash') {
            return;
        }

        // Match Bash(command) or Bash(command:*)
        const bashPattern = /^Bash\((.+?)\)$/;
        const match = permission.match(bashPattern);
        
        if (!match) {
            return;
        }

        const command = match[1];
        
        // Check if it's a prefix pattern (ends with :*)
        if (command.endsWith(':*')) {
            const prefix = command.slice(0, -2); // Remove :*
            this.allowedBashPrefixes.add(prefix);
        } else {
            // Literal match
            this.allowedBashLiterals.add(command);
        }
    }

    /**
     * Resolves tool call ID based on tool name and input
     */
    private resolveToolCallId(name: string, args: unknown): string | null {
        // Search in reverse (most recent first)
        for (let i = this.toolCalls.length - 1; i >= 0; i--) {
            const call = this.toolCalls[i];
            if (call.name === name && deepEqual(call.input, args)) {
                if (call.used) {
                    return null;
                }
                // Found unused match - mark as used and return
                call.used = true;
                return call.id;
            }
        }

        return null;
    }

    /**
     * Handles messages to track tool calls
     */
    onMessage(message: SDKMessage): void {
        if (message.type === 'assistant') {
            const assistantMsg = message as SDKAssistantMessage;
            if (assistantMsg.message && assistantMsg.message.content) {
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'tool_use') {
                        this.toolCalls.push({
                            id: block.id!,
                            name: block.name!,
                            input: block.input,
                            used: false
                        });
                    }
                }
                this.evictOldToolCalls();
            }
        }
        if (message.type === 'user') {
            const userMsg = message as SDKUserMessage;
            if (userMsg.message && userMsg.message.content && Array.isArray(userMsg.message.content)) {
                for (const block of userMsg.message.content) {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const toolCall = this.toolCalls.find(tc => tc.id === block.tool_use_id);
                        if (toolCall && !toolCall.used) {
                            toolCall.used = true;
                        }
                    }
                }
            }
        }
    }

    /**
     * Checks if a tool call is rejected
     */
    isAborted(toolCallId: string): boolean {

        // If tool not approved, it's aborted
        if (this.responses.get(toolCallId)?.approved === false) {
            return true;
        }

        // Always abort exit_plan_mode
        const toolCall = this.toolCalls.find(tc => tc.id === toolCallId);
        if (toolCall && (toolCall.name === 'exit_plan_mode' || toolCall.name === 'ExitPlanMode')) {
            return true;
        }

        // Tool call is not aborted
        return false;
    }

    /**
     * Resets all state for new sessions
     */
    reset(): void {
        this.toolCalls = [];
        this.responses.clear();
        this.allowedTools.clear();
        this.allowedBashLiterals.clear();
        this.allowedBashPrefixes.clear();

        // Cancel all pending requests
        for (const [, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        // Move all pending requests to completedRequests with canceled status
        this.session.client.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move each pending request to completed with canceled status
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: 'Session switched to local mode'
                };
            }

            return {
                ...currentState,
                requests: {}, // Clear all pending requests
                completedRequests
            };
        });
    }

    /**
     * Evicts the oldest responses when the map exceeds MAX_RESPONSES.
     * Uses LRU (Least Recently Used) eviction based on receivedAt timestamp.
     */
    private evictOldResponses(): void {
        if (this.responses.size <= PermissionHandler.MAX_RESPONSES) {
            return;
        }

        const entries = Array.from(this.responses.entries())
            .sort((a, b) => (a[1].receivedAt || 0) - (b[1].receivedAt || 0));

        const entriesToDelete = entries.length - PermissionHandler.MAX_RESPONSES;
        for (let i = 0; i < entriesToDelete; i++) {
            this.responses.delete(entries[i][0]);
        }
    }


    /**
     * Evict oldest tool calls when the array exceeds MAX_TOOL_CALLS.
     * Since tool calls are stored in insertion order, we remove from the beginning.
     */
    private evictOldToolCalls(): void {
        if (this.toolCalls.length <= PermissionHandler.MAX_TOOL_CALLS) {
            return;
        }

        const toRemove = this.toolCalls.length - PermissionHandler.MAX_TOOL_CALLS;
        this.toolCalls.splice(0, toRemove);
    }

    /**
     * Sets up the client handler for permission responses
     */
    private setupClientHandler(): void {
        this.session.client.rpcHandlerManager.registerHandler<PermissionResponse, void>('permission', async (message) => {
            logger.debug(`Permission response: ${JSON.stringify(message)}`);

            const id = message.id;
            const pending = this.pendingRequests.get(id);

            if (!pending) {
                logger.debug('Permission request not found or already resolved');
                return;
            }

            // Store the response with timestamp and evict old entries if needed
            this.responses.set(id, { ...message, receivedAt: Date.now() });
            this.evictOldResponses();
            this.pendingRequests.delete(id);

            // Handle the permission response based on tool type
            this.handlePermissionResponse(message, pending);

            // Move processed request to completedRequests
            this.session.client.updateAgentState((currentState) => {
                const request = currentState.requests?.[id];
                if (!request) return currentState;
                let r = { ...currentState.requests };
                delete r[id];
                return {
                    ...currentState,
                    requests: r,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [id]: {
                            ...request,
                            completedAt: Date.now(),
                            status: message.approved ? 'approved' : 'denied',
                            reason: message.reason,
                            mode: message.mode,
                            allowTools: message.allowTools
                        }
                    }
                };
            });
        });
    }

    /**
     * Gets the responses map (for compatibility with existing code)
     */
    getResponses(): Map<string, PermissionResponse> {
        return this.responses;
    }
}