"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserMessageSchema = void 0;
var zod_1 = require("zod");
var protocol_1 = require("@happy/protocol");
/**
 * Machine metadata - static information (rarely changes)
 */
var MachineMetadataSchema = zod_1.z.object({
    host: zod_1.z.string(),
    platform: zod_1.z.string(),
    happyCliVersion: zod_1.z.string(),
    homeDir: zod_1.z.string(),
    happyHomeDir: zod_1.z.string(),
    happyLibDir: zod_1.z.string()
});
/**
 * Daemon state - dynamic runtime information (frequently updated)
 *
 * Includes optional mcpConfig for syncing MCP server state to the mobile app.
 * @see HAP-608 - CLI Sync: Include MCP Config in daemonState
 */
var DaemonStateSchema = zod_1.z.object({
    status: zod_1.z.union([
        zod_1.z.enum(['running', 'shutting-down']),
        zod_1.z.string() // Forward compatibility
    ]),
    pid: zod_1.z.number().optional(),
    httpPort: zod_1.z.number().optional(),
    startedAt: zod_1.z.number().optional(),
    shutdownRequestedAt: zod_1.z.number().optional(),
    shutdownSource: zod_1.z.union([
        zod_1.z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']),
        zod_1.z.string() // Forward compatibility
    ]).optional(),
    /** MCP configuration state for app display - synced from ~/.happy/config/mcp.json */
    mcpConfig: protocol_1.McpSyncStateSchema.optional()
});
// =============================================================================
// CLI-SPECIFIC MESSAGE TYPES
// =============================================================================
// These schemas handle message parsing for the CLI, including user input
// from mobile app and agent responses.
/**
 * Message metadata schema
 */
var MessageMetaSchema = zod_1.z.object({
    sentFrom: zod_1.z.string().optional(), // Source identifier
    permissionMode: zod_1.z.string().optional(), // Permission mode for this message
    model: zod_1.z.string().nullable().optional(), // Model name for this message (null = reset)
    fallbackModel: zod_1.z.string().nullable().optional(), // Fallback model for this message (null = reset)
    customSystemPrompt: zod_1.z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
    appendSystemPrompt: zod_1.z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
    allowedTools: zod_1.z.array(zod_1.z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
    disallowedTools: zod_1.z.array(zod_1.z.string()).nullable().optional() // Disallowed tools for this message (null = reset)
});
/**
 * API response types
 */
var CreateSessionResponseSchema = zod_1.z.object({
    session: zod_1.z.object({
        id: zod_1.z.string(),
        tag: zod_1.z.string(),
        seq: zod_1.z.number(),
        createdAt: zod_1.z.number(),
        updatedAt: zod_1.z.number(),
        metadata: zod_1.z.string(),
        metadataVersion: zod_1.z.number(),
        agentState: zod_1.z.string().nullable(),
        agentStateVersion: zod_1.z.number()
    })
});
exports.UserMessageSchema = zod_1.z.object({
    role: zod_1.z.literal('user'),
    content: zod_1.z.object({
        type: zod_1.z.literal('text'),
        text: zod_1.z.string()
    }),
    localKey: zod_1.z.string().optional(), // Mobile messages include this
    meta: MessageMetaSchema.optional()
});
var AgentMessageSchema = zod_1.z.object({
    role: zod_1.z.literal('agent'),
    content: zod_1.z.object({
        type: zod_1.z.literal('output'),
        data: zod_1.z.unknown() // Claude SDK message data - structure varies by message type
    }),
    meta: MessageMetaSchema.optional()
});
var MessageContentSchema = zod_1.z.union([exports.UserMessageSchema, AgentMessageSchema]);
