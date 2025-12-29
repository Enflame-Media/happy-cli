/**
 * Converter from SDK message types to log format (RawJSONLines)
 * Transforms Claude SDK messages into the format expected by session logs
 */

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

/** Timeout for git commands (5 seconds - git is fast) */
const GIT_COMMAND_TIMEOUT_MS = 5000
import type {
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage
} from '@/claude/sdk'
import type { RawJSONLines } from '@/claude/types'

/**
 * Permission mode type used throughout the converter
 */
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

/**
 * Extended properties added during SDK-to-log conversion
 * These are passthrough properties not in the base RawJSONLines schema
 */
interface ExtendedLogFields {
    mode?: PermissionMode
    requestId?: string
    toolUseResult?: unknown
    parentUuid?: string | null
    isSidechain?: boolean
    userType?: 'external'
    cwd?: string
    sessionId?: string
    version?: string
    gitBranch?: string
    timestamp?: string
    subtype?: string
    model?: string
    tools?: string[]
}

/**
 * Extended RawJSONLines type with additional passthrough properties
 */
type ExtendedRawJSONLines = RawJSONLines & ExtendedLogFields

/**
 * SDK tool result message shape (not typed in base SDK types)
 */
interface SDKToolResultMessage extends SDKMessage {
    type: 'tool_result'
    tool_use_id?: string
    content?: unknown
}

/**
 * Context for converting SDK messages to log format
 */
export interface ConversionContext {
    sessionId: string
    cwd: string
    version?: string
    gitBranch?: string
    parentUuid?: string | null
}

/**
 * Get current git branch for the working directory
 */
function getGitBranch(cwd: string): string | undefined {
    try {
        // Use execFileSync for security (no shell expansion) and add timeout to prevent hangs
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: GIT_COMMAND_TIMEOUT_MS,
        }).trim()
        return branch || undefined
    } catch {
        // git command failed or timed out
        return undefined
    }
}

/**
 * SDK to Log converter class
 * Maintains state for parent-child relationships between messages
 */
export class SDKToLogConverter {
    private lastUuid: string | null = null
    private context: ConversionContext
    private responses?: Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>
    private sidechainLastUUID = new Map<string, string>();

    constructor(
        context: Omit<ConversionContext, 'parentUuid'>,
        responses?: Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>
    ) {
        this.context = {
            ...context,
            gitBranch: context.gitBranch ?? getGitBranch(context.cwd),
            version: context.version ?? process.env.npm_package_version ?? '0.0.0',
            parentUuid: null
        }
        this.responses = responses
    }

    /**
     * Update session ID (for when session changes during resume)
     */
    updateSessionId(sessionId: string): void {
        this.context.sessionId = sessionId
    }

    /**
     * Reset parent chain (useful when starting new conversation)
     */
    resetParentChain(): void {
        this.lastUuid = null
        this.context.parentUuid = null
    }

    /**
     * Convert SDK message to log format
     */
    convert(sdkMessage: SDKMessage): RawJSONLines | null {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        let parentUuid = this.lastUuid;
        let isSidechain = false;
        const parentToolUseId = sdkMessage.parent_tool_use_id
        if (typeof parentToolUseId === 'string') {
            isSidechain = true;
            parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? null;
            this.sidechainLastUUID.set(parentToolUseId, uuid);
        }
        const baseFields = {
            parentUuid: parentUuid,
            isSidechain: isSidechain,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            uuid,
            timestamp
        }

        let logMessage: RawJSONLines | null = null

        switch (sdkMessage.type) {
            case 'user': {
                const userMsg = sdkMessage as SDKUserMessage
                const userLogMessage: ExtendedRawJSONLines = {
                    ...baseFields,
                    type: 'user',
                    message: userMsg.message
                }

                // Check if this is a tool result and add mode if available
                if (Array.isArray(userMsg.message.content)) {
                    for (const content of userMsg.message.content) {
                        if (content.type === 'tool_result' && content.tool_use_id && this.responses?.has(content.tool_use_id)) {
                            const response = this.responses.get(content.tool_use_id)
                            if (response?.mode) {
                                userLogMessage.mode = response.mode
                            }
                        }
                    }
                }
                logMessage = userLogMessage
                break
            }

            case 'assistant': {
                const assistantMsg = sdkMessage as SDKAssistantMessage
                // Extract requestId from SDK message if present (passthrough property)
                const requestId = assistantMsg.requestId
                logMessage = {
                    ...baseFields,
                    type: 'assistant',
                    message: assistantMsg.message,
                    // Assistant messages often have additional fields
                    ...(typeof requestId === 'string' ? { requestId } : {})
                } as ExtendedRawJSONLines
                break
            }

            case 'system': {
                const systemMsg = sdkMessage as SDKSystemMessage

                // System messages with subtype 'init' might update session ID
                if (systemMsg.subtype === 'init' && systemMsg.session_id) {
                    this.updateSessionId(systemMsg.session_id)
                }

                // System messages are typically not sent to logs
                // but we can convert them if needed
                // Spread the SDK message to preserve passthrough fields
                const { type: _type, ...restSystemFields } = systemMsg
                logMessage = {
                    ...baseFields,
                    ...restSystemFields,
                    type: 'system',
                    subtype: systemMsg.subtype,
                    model: systemMsg.model,
                    tools: systemMsg.tools,
                } as ExtendedRawJSONLines
                break
            }

            case 'result': {
                // Result messages are not converted to log messages
                // They're SDK-specific messages that indicate session completion
                // Not part of the actual conversation log
                break
            }

            // Handle tool use results (often comes as user messages)
            case 'tool_result': {
                const toolMsg = sdkMessage as SDKToolResultMessage
                const toolUseId = toolMsg.tool_use_id
                const toolContent = toolMsg.content
                const toolLogMessage: ExtendedRawJSONLines = {
                    ...baseFields,
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: toolUseId,
                            content: toolContent
                        }]
                    },
                    toolUseResult: toolContent
                }

                // Add mode if available from responses
                if (typeof toolUseId === 'string' && this.responses?.has(toolUseId)) {
                    const response = this.responses.get(toolUseId)
                    if (response?.mode) {
                        toolLogMessage.mode = response.mode
                    }
                }

                logMessage = toolLogMessage
                break
            }

            default: {
                // Unknown message type - pass through with all fields
                // sdkMessage.type is guaranteed to be a string from SDKMessage interface
                const { type: messageType, ...restFields } = sdkMessage
                logMessage = {
                    ...baseFields,
                    ...restFields,
                    // The type is unknown but must be user|assistant|system|summary for RawJSONLines
                    // For unknown types, we preserve the original type as a passthrough
                    type: messageType as 'user' | 'assistant' | 'system' | 'summary'
                } as ExtendedRawJSONLines
                break
            }
        }

        // Update last UUID for parent tracking
        if (logMessage && logMessage.type !== 'summary') {
            this.lastUuid = uuid
        }

        return logMessage
    }

    /**
     * Convert multiple SDK messages to log format
     */
    convertMany(sdkMessages: SDKMessage[]): RawJSONLines[] {
        return sdkMessages
            .map(msg => this.convert(msg))
            .filter((msg): msg is RawJSONLines => msg !== null)
    }

    /**
     * Convert a simple string content to a sidechain user message
     * Used for Task tool sub-agent prompts
     */
    convertSidechainUserMessage(toolUseId: string, content: string): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        this.sidechainLastUUID.set(toolUseId, uuid);
        return {
            parentUuid: null,
            isSidechain: true,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            type: 'user',
            message: {
                role: 'user',
                content: content
            },
            uuid,
            timestamp
        }
    }

    /**
     * Generate an interrupted tool result message
     * Used when a tool call is interrupted by the user
     * @param toolUseId - The ID of the tool that was interrupted
     * @param parentToolUseId - Optional parent tool ID if this is a sidechain tool
     */
    generateInterruptedToolResult(toolUseId: string, parentToolUseId?: string | null): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        const errorMessage = "[Request interrupted by user for tool use]"
        
        // Determine if this is a sidechain and get parent UUID
        let isSidechain = false
        let parentUuid: string | null = this.lastUuid
        
        if (parentToolUseId) {
            isSidechain = true
            // Look up the parent tool's UUID
            parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? null
            // Track this tool in the sidechain map
            this.sidechainLastUUID.set(parentToolUseId, uuid)
        }
        
        const logMessage: ExtendedRawJSONLines = {
            type: 'user',
            isSidechain: isSidechain,
            uuid,
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        content: errorMessage,
                        is_error: true,
                        tool_use_id: toolUseId
                    }
                ]
            },
            parentUuid: parentUuid,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            timestamp,
            toolUseResult: `Error: ${errorMessage}`
        }
        
        // Update last UUID for tracking
        this.lastUuid = uuid
        
        return logMessage
    }
}

/**
 * Convenience function for one-off conversions
 */
export function convertSDKToLog(
    sdkMessage: SDKMessage,
    context: Omit<ConversionContext, 'parentUuid'>,
    responses?: Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>
): RawJSONLines | null {
    const converter = new SDKToLogConverter(context, responses)
    return converter.convert(sdkMessage)
}