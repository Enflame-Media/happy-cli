import { z } from 'zod'
import { UsageSchema } from '@/claude/types'
import { PermissionMode } from '@/claude/loop'

// =============================================================================
// RE-EXPORTS FROM @happy/protocol (shared package)
// =============================================================================
// These re-exports maintain backward compatibility for existing code that
// imports from @/api/types instead of directly from @happy/protocol.
//
// Using direct re-export syntax to avoid "imported but never used" bundler warnings.

// Update schemas
export {
  ApiUpdateSchema,
  ApiUpdateContainerSchema,
  ApiUpdateNewMessageSchema,
  ApiDeleteSessionSchema,
  ApiUpdateNewSessionSchema,
  ApiNewMachineSchema,
  ApiNewArtifactSchema,
  ApiUpdateArtifactSchema,
  ApiDeleteArtifactSchema,
  ApiRelationshipUpdatedSchema,
  ApiNewFeedPostSchema,
  ApiKvBatchUpdateSchema,
  ApiUpdateMachineStateSchema,
  ApiUpdateSessionStateSchema,
  // Common schemas
  EncryptedContentSchema,
  VersionedValueSchema,
  NullableVersionedValueSchema,
  // Ephemeral schemas
  ApiEphemeralUpdateSchema,
  ApiEphemeralActivityUpdateSchema,
  ApiEphemeralUsageUpdateSchema,
  ApiEphemeralMachineActivityUpdateSchema,
} from '@happy/protocol'

// Type re-exports
export type {
  ApiUpdate,
  ApiUpdateContainer,
  ApiUpdateNewMessage,
  ApiDeleteSession,
  ApiUpdateNewSession,
  ApiNewMachine,
  ApiNewArtifact,
  ApiUpdateArtifact,
  ApiDeleteArtifact,
  ApiRelationshipUpdated,
  ApiNewFeedPost,
  ApiKvBatchUpdate,
  ApiUpdateMachineState,
  ApiUpdateSessionState,
  ApiEphemeralUpdate,
  ApiEphemeralActivityUpdate,
  ApiEphemeralUsageUpdate,
  ApiEphemeralMachineActivityUpdate,
  GitHubProfile,
  EncryptedContent,
  VersionedValue,
  NullableVersionedValue,
} from '@happy/protocol'

// Import only what's used locally for aliases
import {
  ApiUpdateContainerSchema,
  type ApiUpdateContainer,
  type ApiDeleteSession,
  type ApiNewArtifact,
  type ApiUpdateArtifact,
  type ApiDeleteArtifact,
  type ApiRelationshipUpdated,
  type ApiNewFeedPost,
  type ApiKvBatchUpdate,
  type ApiUpdateMachineState,
  type ApiEphemeralActivityUpdate,
  type ApiEphemeralUsageUpdate,
  type ApiEphemeralMachineActivityUpdate,
  type ApiEphemeralUpdate,
} from '@happy/protocol'

// =============================================================================
// LEGACY TYPE ALIASES (Deprecated - use Api* versions)
// =============================================================================
// These aliases maintain backward compatibility with code using the old naming.
// New code should use the Api* prefixed versions from @happy/protocol.

/** @deprecated Use ApiUpdateContainer from @happy/protocol */
export const UpdateSchema: typeof ApiUpdateContainerSchema = ApiUpdateContainerSchema

/** @deprecated Use ApiUpdateContainer from @happy/protocol */
export type Update = ApiUpdateContainer

/** @deprecated Use ApiDeleteSession from @happy/protocol */
export type DeleteSessionBody = ApiDeleteSession

/** @deprecated Use ApiNewArtifact from @happy/protocol */
export type NewArtifactBody = ApiNewArtifact

/** @deprecated Use ApiUpdateArtifact from @happy/protocol */
export type UpdateArtifactBody = ApiUpdateArtifact

/** @deprecated Use ApiDeleteArtifact from @happy/protocol */
export type DeleteArtifactBody = ApiDeleteArtifact

/** @deprecated Use ApiRelationshipUpdated from @happy/protocol */
export type RelationshipUpdatedBody = ApiRelationshipUpdated

/** @deprecated Use ApiNewFeedPost from @happy/protocol */
export type NewFeedPostBody = ApiNewFeedPost

/** @deprecated Use ApiKvBatchUpdate from @happy/protocol */
export type KvBatchUpdateBody = ApiKvBatchUpdate

/** @deprecated Use ApiUpdateMachineState from @happy/protocol */
export type UpdateMachineBody = ApiUpdateMachineState

// =============================================================================
// EPHEMERAL TYPE ALIASES (Deprecated - use Api* versions)
// =============================================================================

/** @deprecated Use ApiEphemeralActivityUpdate from @happy/protocol */
export type EphemeralActivityUpdate = ApiEphemeralActivityUpdate

/** @deprecated Use ApiEphemeralUsageUpdate from @happy/protocol */
export type EphemeralUsageUpdate = ApiEphemeralUsageUpdate

/** @deprecated Use ApiEphemeralMachineActivityUpdate from @happy/protocol */
export type EphemeralMachineActivityUpdate = ApiEphemeralMachineActivityUpdate

/** @deprecated Use ApiEphemeralUpdate from @happy/protocol */
export type EphemeralUpdate = ApiEphemeralUpdate

// =============================================================================
// GITHUB PROFILE (CLI-specific version with passthrough)
// =============================================================================
// CLI uses a more lenient version that allows additional fields from GitHub API.
// This is kept local because the shared version is stricter.

/**
 * GitHub profile data from OAuth
 * Note: Uses passthrough to allow additional fields from GitHub API
 */
export const GitHubProfileSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  avatar_url: z.string().optional(),
}).passthrough()

// Note: GitHubProfile type is re-exported from @happy/protocol at the top of this file

// =============================================================================
// USAGE DATA TYPE FROM CLAUDE
// =============================================================================

/**
 * Usage data type from Claude
 */
export type Usage = z.infer<typeof UsageSchema>

// =============================================================================
// SOCKET EVENT INTERFACES (CLI-SPECIFIC)
// =============================================================================
// These interfaces define the WebSocket events for CLI-server communication.
// They include CLI-specific callback signatures and must remain local.

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
}

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
export const MachineMetadataSchema = z.object({
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
 */
export const DaemonStateSchema = z.object({
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
    ]).optional()
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
