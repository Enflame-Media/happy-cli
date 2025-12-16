import { z } from 'zod'
import { UsageSchema } from '@/claude/types'
import { PermissionMode } from '@/claude/loop'

/**
 * Usage data type from Claude
 */
export type Usage = z.infer<typeof UsageSchema>

/**
 * Base message content structure for encrypted messages
 */
const SessionMessageContentSchema = z.object({
  c: z.string(), // Base64 encoded encrypted content
  t: z.literal('encrypted')
})

/**
 * Update body for new messages
 */
const UpdateBodySchema = z.object({
  message: z.object({
    id: z.string(),
    seq: z.number(),
    content: SessionMessageContentSchema
  }),
  sid: z.string(), // Session ID
  t: z.literal('new-message')
})

const UpdateSessionBodySchema = z.object({
  t: z.literal('update-session'),
  sid: z.string(),
  metadata: z.object({
    version: z.number(),
    value: z.string()
  }).nullish(),
  agentState: z.object({
    version: z.number(),
    value: z.string()
  }).nullish()
})

/**
 * Update body for machine updates
 */
const UpdateMachineBodySchema = z.object({
  t: z.literal('update-machine'),
  machineId: z.string(),
  metadata: z.object({
    version: z.number(),
    value: z.string()
  }).nullish(),
  daemonState: z.object({
    version: z.number(),
    value: z.string()
  }).nullish()
})

export type UpdateMachineBody = z.infer<typeof UpdateMachineBodySchema>

/**
 * Update body for new session creation
 */
const NewSessionBodySchema = z.object({
  t: z.literal('new-session'),
  id: z.string(),
  seq: z.number(),
  metadata: z.string(),
  metadataVersion: z.number(),
  agentState: z.string().nullable(),
  agentStateVersion: z.number(),
  dataEncryptionKey: z.string().nullable(),
  active: z.boolean(),
  activeAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number()
})

/**
 * GitHub profile data from OAuth
 */
const GitHubProfileSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  avatar_url: z.string().optional(),
}).passthrough(); // Allow additional fields from GitHub API

/**
 * Update body for account changes
 */
const UpdateAccountBodySchema = z.object({
  t: z.literal('update-account'),
  id: z.string(),
  settings: z.object({
    value: z.string().nullable(),
    version: z.number()
  }).nullish(),
  github: GitHubProfileSchema.nullish()
})

/**
 * Update body for new machine registration
 */
const NewMachineBodySchema = z.object({
  t: z.literal('new-machine'),
  machineId: z.string(),
  seq: z.number(),
  metadata: z.string(),
  metadataVersion: z.number(),
  daemonState: z.string().nullable(),
  daemonStateVersion: z.number(),
  dataEncryptionKey: z.string().nullable(),
  active: z.boolean(),
  activeAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number()
})

/**
 * Update body for session deletion (from mobile app archival)
 */
const DeleteSessionBodySchema = z.object({
  t: z.literal('delete-session'),
  sid: z.string()
})

/**
 * Update body for new artifact creation
 */
const NewArtifactBodySchema = z.object({
  t: z.literal('new-artifact'),
  artifactId: z.string(),
  header: z.string(),
  headerVersion: z.number(),
  body: z.string().optional(),
  bodyVersion: z.number().optional(),
  dataEncryptionKey: z.string(),
  seq: z.number(),
  createdAt: z.number(),
  updatedAt: z.number()
})

/**
 * Update body for artifact updates
 */
const UpdateArtifactBodySchema = z.object({
  t: z.literal('update-artifact'),
  artifactId: z.string(),
  header: z.object({
    value: z.string(),
    version: z.number()
  }).optional(),
  body: z.object({
    value: z.string(),
    version: z.number()
  }).optional()
})

/**
 * Update body for artifact deletion
 */
const DeleteArtifactBodySchema = z.object({
  t: z.literal('delete-artifact'),
  artifactId: z.string()
})

/**
 * Update body for relationship changes (friend/social features)
 * Note: CLI doesn't use social features, but schema needed for type completeness
 */
const RelationshipUpdatedBodySchema = z.object({
  t: z.literal('relationship-updated'),
  fromUserId: z.string(),
  toUserId: z.string(),
  status: z.enum(['none', 'requested', 'pending', 'friend', 'rejected']),
  action: z.enum(['created', 'updated', 'deleted']),
  fromUser: z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    avatar: z.object({
      path: z.string(),
      url: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      thumbhash: z.string().optional()
    }).nullable(),
    username: z.string(),
    bio: z.string().nullable(),
    status: z.enum(['none', 'requested', 'pending', 'friend', 'rejected'])
  }).optional(),
  toUser: z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    avatar: z.object({
      path: z.string(),
      url: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      thumbhash: z.string().optional()
    }).nullable(),
    username: z.string(),
    bio: z.string().nullable(),
    status: z.enum(['none', 'requested', 'pending', 'friend', 'rejected'])
  }).optional(),
  timestamp: z.number()
})

/**
 * Update body for new feed posts (activity feed)
 * Note: CLI doesn't display activity feed, but schema needed for type completeness
 */
const NewFeedPostBodySchema = z.object({
  t: z.literal('new-feed-post'),
  id: z.string(),
  body: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('friend_request'), uid: z.string() }),
    z.object({ kind: z.literal('friend_accepted'), uid: z.string() }),
    z.object({ kind: z.literal('text'), text: z.string() })
  ]),
  cursor: z.string(),
  createdAt: z.number(),
  repeatKey: z.string().nullable()
})

/**
 * Update body for KV batch updates (settings sync)
 */
const KvBatchUpdateBodySchema = z.object({
  t: z.literal('kv-batch-update'),
  changes: z.array(z.object({
    key: z.string(),
    value: z.string().nullable(),
    version: z.number()
  }))
})

/**
 * Update event from server
 */
const UpdateSchema = z.object({
  id: z.string(),
  seq: z.number(),
  body: z.union([
    UpdateBodySchema,
    UpdateSessionBodySchema,
    UpdateMachineBodySchema,
    NewSessionBodySchema,
    UpdateAccountBodySchema,
    NewMachineBodySchema,
    DeleteSessionBodySchema,
    NewArtifactBodySchema,
    UpdateArtifactBodySchema,
    DeleteArtifactBodySchema,
    RelationshipUpdatedBodySchema,
    NewFeedPostBodySchema,
    KvBatchUpdateBodySchema,
  ]),
  createdAt: z.number()
})

export type Update = z.infer<typeof UpdateSchema>

/** Type exports for update body schemas */
export type DeleteSessionBody = z.infer<typeof DeleteSessionBodySchema>
export type NewArtifactBody = z.infer<typeof NewArtifactBodySchema>
export type UpdateArtifactBody = z.infer<typeof UpdateArtifactBodySchema>
export type DeleteArtifactBody = z.infer<typeof DeleteArtifactBodySchema>
export type RelationshipUpdatedBody = z.infer<typeof RelationshipUpdatedBodySchema>
export type NewFeedPostBody = z.infer<typeof NewFeedPostBodySchema>
export type KvBatchUpdateBody = z.infer<typeof KvBatchUpdateBodySchema>

/**
 * Ephemeral activity update - real-time session activity status
 */
export type EphemeralActivityUpdate = {
  type: 'activity'
  id: string
  active: boolean
  activeAt: number
  thinking: boolean
}

/**
 * Ephemeral usage update - real-time cost/token tracking
 */
export type EphemeralUsageUpdate = {
  type: 'usage'
  id: string
  key: string
  timestamp: number
  tokens: {
    total: number
    input: number
    output: number
    cache_creation: number
    cache_read: number
  }
  cost: {
    total: number
    input: number
    output: number
  }
}

/**
 * Ephemeral machine activity update - daemon status sync
 */
export type EphemeralMachineActivityUpdate = {
  type: 'machine-activity'
  id: string
  active: boolean
  activeAt: number
}

/**
 * Union of all ephemeral update types
 */
export type EphemeralUpdate = EphemeralActivityUpdate | EphemeralUsageUpdate | EphemeralMachineActivityUpdate

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

/**
 * Session information
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
    ]).optional()
})

export type DaemonState = z.infer<typeof DaemonStateSchema>

export type Machine = {
  id: string,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: MachineMetadata,
  metadataVersion: number,
  daemonState: DaemonState | null,
  daemonStateVersion: number,
}

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
