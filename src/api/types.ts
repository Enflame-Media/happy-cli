import { z } from 'zod'
import { UsageSchema } from '@/claude/types'
import { PermissionMode } from '@/claude/loop'

// =============================================================================
// TYPE IMPORTS FROM @happy/protocol (shared package)
// =============================================================================
// Import only what's actually used locally for type aliases and internal use.

import type {
  ApiUpdateContainer,
  ApiDeleteSession,
  ApiNewArtifact,
  ApiUpdateArtifact,
  ApiDeleteArtifact,
  ApiRelationshipUpdated,
  ApiNewFeedPost,
  ApiKvBatchUpdate,
  ApiUpdateMachineState,
  ApiEphemeralActivityUpdate,
  ApiEphemeralUsageUpdate,
  ApiEphemeralMachineActivityUpdate,
  ApiEphemeralUpdate,
} from '@happy/protocol'

import { McpSyncStateSchema } from '@happy/protocol'

// =============================================================================
// TYPE ALIASES (For internal use)
// =============================================================================

/** Alias for ApiUpdateContainer */
export type Update = ApiUpdateContainer

/** Alias for ApiDeleteSession */
export type DeleteSessionBody = ApiDeleteSession

/** Alias for ApiNewArtifact */
export type NewArtifactBody = ApiNewArtifact

/** Alias for ApiUpdateArtifact */
export type UpdateArtifactBody = ApiUpdateArtifact

/** Alias for ApiDeleteArtifact */
export type DeleteArtifactBody = ApiDeleteArtifact

/** Alias for ApiRelationshipUpdated */
export type RelationshipUpdatedBody = ApiRelationshipUpdated

/** Alias for ApiNewFeedPost */
export type NewFeedPostBody = ApiNewFeedPost

/** Alias for ApiKvBatchUpdate */
export type KvBatchUpdateBody = ApiKvBatchUpdate

/** Alias for ApiUpdateMachineState */
export type UpdateMachineBody = ApiUpdateMachineState

/** Alias for ApiEphemeralActivityUpdate */
export type EphemeralActivityUpdate = ApiEphemeralActivityUpdate

/** Alias for ApiEphemeralUsageUpdate */
export type EphemeralUsageUpdate = ApiEphemeralUsageUpdate

/** Alias for ApiEphemeralMachineActivityUpdate */
export type EphemeralMachineActivityUpdate = ApiEphemeralMachineActivityUpdate

/** Alias for ApiEphemeralUpdate */
export type EphemeralUpdate = ApiEphemeralUpdate

// =============================================================================
// SOCKET EVENT INTERFACES (CLI-SPECIFIC)
// =============================================================================
// These interfaces define the WebSocket events for CLI-server communication.
// They include CLI-specific callback signatures and must remain local.
//
// Type-safe event handling is available via HappyWebSocket methods:
// - socket.onServer('event', handler)  - Register typed server event handlers
// - socket.emitClient('event', data)   - Emit typed client events
// @see HAP-520 - Type-safe event handling implementation

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
  'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void
  'rpc-registered': (data: { method: string }) => void
  'rpc-unregistered': (data: { method: string }) => void
  'rpc-error': (data: { type: string, error: string }) => void
  ephemeral: (data: EphemeralUpdate) => void
  auth: (data: { success: boolean, user: string }) => void
  error: (data: { message: string }) => void
}

/**
 * Socket events from client to server
 */
export interface ClientToServerEvents {
  message: (data: { sid: string, message: string }) => void // Base64-encoded encrypted message
  'session-alive': (data: {
    sid: string;
    time: number;
    thinking: boolean;
    mode?: 'local' | 'remote';
  }) => void
  'session-end': (data: { sid: string, time: number }) => void,
  'update-metadata': (data: { sid: string, expectedVersion: number, metadata: string }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    metadata: string
  } | {
    result: 'success',
    version: number,
    metadata: string
  }) => void) => void,
  'update-state': (data: { sid: string, expectedVersion: number, agentState: string | null }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    agentState: string | null
  } | {
    result: 'success',
    version: number,
    agentState: string | null
  }) => void) => void,
  'ping': (callback: () => void) => void
  'rpc-register': (data: { method: string }) => void
  'rpc-unregister': (data: { method: string }) => void
  'rpc-call': (data: { method: string, params: string }, callback: (response: {
    ok: boolean
    result?: string
    error?: string
  }) => void) => void
  'usage-report': (data: {
    key: string
    sessionId: string
    tokens: {
      total: number
      [key: string]: number
    }
    cost: {
      total: number
      [key: string]: number
    }
  }) => void
  /**
   * Session revival event - emitted when a stopped session is automatically revived.
   * Mobile app should update its session reference when receiving this event.
   *
   * @see HAP-733 - Automatic session revival on "Method not found" RPC errors
   */
  'session-revived': (data: {
    originalSessionId: string
    newSessionId: string
    machineId: string
  }) => void
}

// =============================================================================
// USAGE DATA TYPE FROM CLAUDE
// =============================================================================

/**
 * Usage data type from Claude
 */
export type Usage = z.infer<typeof UsageSchema>


// =============================================================================
// CLI-SPECIFIC DOMAIN TYPES
// =============================================================================
// These types are specific to the CLI and include encryption-related fields
// that are not part of the shared protocol.

/**
 * Session information (CLI-specific with encryption fields)
 */
export type Session = {
  id: string,
  seq: number,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: Metadata,
  metadataVersion: number,
  agentState: AgentState | null,
  agentStateVersion: number,
}

/**
 * Machine metadata - static information (rarely changes)
 */
const MachineMetadataSchema = z.object({
  host: z.string(),
  platform: z.string(),
  happyCliVersion: z.string(),
  homeDir: z.string(),
  happyHomeDir: z.string(),
  happyLibDir: z.string()
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

/**
 * Daemon state - dynamic runtime information (frequently updated)
 *
 * Includes optional mcpConfig for syncing MCP server state to the mobile app.
 * @see HAP-608 - CLI Sync: Include MCP Config in daemonState
 */
const DaemonStateSchema = z.object({
  status: z.union([
    z.enum(['running', 'shutting-down']),
    z.string() // Forward compatibility
  ]),
  pid: z.number().optional(),
  httpPort: z.number().optional(),
  startedAt: z.number().optional(),
  shutdownRequestedAt: z.number().optional(),
  shutdownSource:
    z.union([
      z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']),
      z.string() // Forward compatibility
    ]).optional(),
  /** MCP configuration state for app display - synced from ~/.happy/config/mcp.json */
  mcpConfig: McpSyncStateSchema.optional()
})

export type DaemonState = z.infer<typeof DaemonStateSchema>

/**
 * Machine information (CLI-specific with encryption fields)
 */
export type Machine = {
  id: string,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: MachineMetadata,
  metadataVersion: number,
  daemonState: DaemonState | null,
  daemonStateVersion: number,
}

// =============================================================================
// CLI-SPECIFIC MESSAGE TYPES
// =============================================================================
// These schemas handle message parsing for the CLI, including user input
// from mobile app and agent responses.

/**
 * Message metadata schema
 */
const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(), // Source identifier
  permissionMode: z.string().optional(), // Permission mode for this message
  model: z.string().nullable().optional(), // Model name for this message (null = reset)
  fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
  customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
  appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
  allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
  disallowedTools: z.array(z.string()).nullable().optional() // Disallowed tools for this message (null = reset)
})

/**
 * API response types
 */
const CreateSessionResponseSchema = z.object({
  session: z.object({
    id: z.string(),
    tag: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number()
  })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.object({
    type: z.literal('text'),
    text: z.string()
  }),
  localKey: z.string().optional(), // Mobile messages include this
  meta: MessageMetaSchema.optional()
})

export type UserMessage = z.infer<typeof UserMessageSchema>

const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z.object({
    type: z.literal('output'),
    data: z.unknown() // Claude SDK message data - structure varies by message type
  }),
  meta: MessageMetaSchema.optional()
})

const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

/**
 * Session metadata - CLI-specific fields for session context
 */
export type Metadata = {
  path: string,
  host: string,
  version?: string,
  name?: string,
  os?: string,
  summary?: {
    text: string,
    updatedAt: number
  },
  machineId?: string,
  claudeSessionId?: string, // Claude Code session ID
  tools?: string[],
  slashCommands?: string[],
  homeDir: string,
  happyHomeDir: string,
  happyLibDir: string,
  happyToolsDir: string,
  startedFromDaemon?: boolean,
  hostPid?: number,
  startedBy?: 'daemon' | 'terminal',
  // Lifecycle state management
  lifecycleState?: 'running' | 'archiveRequested' | 'archived' | string,
  lifecycleStateSince?: number,
  archivedBy?: string,
  archiveReason?: string,
  flavor?: string
};

/**
 * Tool arguments type - JSON-serializable object
 */
export type ToolArguments = Record<string, unknown>;

/**
 * Agent state - tracks permission requests and their outcomes
 */
export type AgentState = {
  controlledByUser?: boolean | null | undefined
  requests?: {
    [id: string]: {
      tool: string,
      arguments: ToolArguments,
      createdAt: number
    }
  }
  completedRequests?: {
    [id: string]: {
      tool: string,
      arguments: ToolArguments,
      createdAt: number,
      completedAt: number,
      status: 'canceled' | 'denied' | 'approved' | 'timeout',
      reason?: string,
      mode?: PermissionMode,
      decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
      allowTools?: string[]
    }
  }
}
