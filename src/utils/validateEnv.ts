/**
 * Environment variable validation for happy-cli
 *
 * Unlike the server, the CLI has sensible defaults for all environment variables.
 * This module provides validation and documentation of available configuration options.
 */

interface EnvConfig {
  /** Variable name */
  name: string
  /** Description shown in warnings and documentation */
  description: string
  /** Default value if not set */
  defaultValue?: string
  /** Category for grouping */
  category: 'server' | 'directories' | 'features' | 'debug' | 'tuning' | 'claude' | 'codex'
}

const envConfig: EnvConfig[] = [
  // Server
  {
    name: 'HAPPY_SERVER_URL',
    description: 'Happy server URL for syncing sessions',
    defaultValue: 'https://happy-api.enflamemedia.com',
    category: 'server',
  },
  {
    name: 'HAPPY_WEBAPP_URL',
    description: 'Happy web application URL',
    defaultValue: 'https://happy.enflamemedia.com',
    category: 'server',
  },

  // Directories
  {
    name: 'HAPPY_HOME_DIR',
    description: 'Directory for happy data and logs (supports ~ expansion)',
    defaultValue: '~/.enfm-happy',
    category: 'directories',
  },
  {
    name: 'HAPPY_PROJECT_ROOT',
    description: 'Project root directory for session context',
    category: 'directories',
  },

  // Features
  {
    name: 'HAPPY_EXPERIMENTAL',
    description: 'Enable experimental features (true/1/yes)',
    defaultValue: 'false',
    category: 'features',
  },
  {
    name: 'HAPPY_DISABLE_CAFFEINATE',
    description: 'Disable caffeinate (prevent sleep) on macOS (true/1/yes)',
    defaultValue: 'false',
    category: 'features',
  },

  // Debug
  {
    name: 'DEBUG',
    description: 'Enable debug output and verbose logging',
    category: 'debug',
  },
  {
    name: 'DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING',
    description: 'Send logs to server for debugging (dangerous - exposes session data)',
    category: 'debug',
  },
  {
    name: 'CI',
    description: 'Indicates running in CI environment',
    category: 'debug',
  },
  {
    name: 'HEADLESS',
    description: 'Run in headless mode (no browser opening)',
    category: 'debug',
  },

  // Tuning
  {
    name: 'HAPPY_MEMORY_THRESHOLD_MB',
    description: 'Memory threshold in MB for daemon monitoring',
    category: 'tuning',
  },
  {
    name: 'HAPPY_MEMORY_CHECK_INTERVAL_MS',
    description: 'Interval in ms for memory checks',
    category: 'tuning',
  },
  {
    name: 'HAPPY_SESSION_SPAWN_TIMEOUT',
    description: 'Timeout in ms for session spawning',
    defaultValue: '30000',
    category: 'tuning',
  },
  {
    name: 'HAPPY_DAEMON_HEARTBEAT_INTERVAL',
    description: 'Interval in ms for daemon heartbeat',
    category: 'tuning',
  },
  {
    name: 'HAPPY_DAEMON_HTTP_TIMEOUT',
    description: 'HTTP timeout in ms for daemon control requests',
    category: 'tuning',
  },

  // Claude-specific
  {
    name: 'CLAUDE_CONFIG_DIR',
    description: 'Directory for Claude configuration',
    defaultValue: '~/.claude',
    category: 'claude',
  },
  {
    name: 'CLAUDE_CODE_ENTRYPOINT',
    description: 'Claude Code SDK entrypoint identifier',
    category: 'claude',
  },
  {
    name: 'CLAUDE_SDK_MCP_SERVERS',
    description: 'MCP servers configuration for Claude SDK',
    category: 'claude',
  },

  // Codex-specific
  {
    name: 'CODEX_HOME',
    description: 'Directory for Codex data',
    defaultValue: '~/.codex',
    category: 'codex',
  },
  {
    name: 'HAPPY_HTTP_MCP_URL',
    description: 'HTTP MCP URL for Codex integration',
    category: 'codex',
  },
]

interface ValidationResult {
  warnings: string[]
  configured: string[]
  usingDefaults: string[]
}

/**
 * Result of validating a remote logging URL (HAP-830)
 */
export interface RemoteLoggingUrlValidation {
  /** Whether the URL is valid for remote logging */
  valid: boolean
  /** The validated URL (only set if valid is true) */
  url?: string
  /** Error message explaining why the URL is invalid (only set if valid is false) */
  error?: string
}

/**
 * Validates a URL for remote logging to ensure secure transport (HAP-830)
 *
 * Security requirements:
 * - HTTPS is required for non-local URLs to prevent log data interception
 * - HTTP is allowed only for localhost/127.0.0.1 to support local development
 * - Invalid URLs are rejected with clear error messages
 *
 * @param url - The URL to validate
 * @returns Validation result with either the validated URL or an error message
 *
 * @example
 * ```typescript
 * const result = validateRemoteLoggingUrl('https://api.example.com');
 * if (result.valid) {
 *   console.log('Using:', result.url);
 * } else {
 *   console.error('Invalid:', result.error);
 * }
 * ```
 */
export function validateRemoteLoggingUrl(url: string): RemoteLoggingUrlValidation {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {
      valid: false,
      error: `Invalid URL format: "${url}". Please provide a valid URL (e.g., https://api.example.com).`,
    }
  }

  const protocol = parsed.protocol.toLowerCase()
  const hostname = parsed.hostname.toLowerCase()

  // HTTPS is always allowed
  if (protocol === 'https:') {
    return { valid: true, url }
  }

  // HTTP is only allowed for localhost (local development)
  if (protocol === 'http:') {
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    if (isLocalhost) {
      return { valid: true, url }
    }

    return {
      valid: false,
      error:
        `Remote logging URL "${url}" uses HTTP which is insecure for non-local hosts. ` +
        `Use HTTPS to protect log data in transit (e.g., https://${parsed.host}${parsed.pathname}). ` +
        `HTTP is only allowed for localhost/127.0.0.1 during local development.`,
    }
  }

  // Unknown protocol
  return {
    valid: false,
    error:
      `Remote logging URL "${url}" uses unsupported protocol "${protocol}". ` +
      `Only HTTPS (and HTTP for localhost) are supported.`,
  }
}

/**
 * Checks environment variables and returns configuration status.
 * Unlike the server, CLI env vars are all optional with sensible defaults.
 */
export function checkEnv(): ValidationResult {
  const warnings: string[] = []
  const configured: string[] = []
  const usingDefaults: string[] = []

  for (const config of envConfig) {
    const value = process.env[config.name]
    const isSet = value !== undefined && value !== ''

    if (isSet) {
      configured.push(config.name)
    } else if (config.defaultValue) {
      usingDefaults.push(config.name)
    }
  }

  // Remote logging requires explicit DEBUG opt-in (HAP-829)
  // This prevents accidental data exposure from misconfigured environments
  if (
    process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING &&
    !process.env.DEBUG
  ) {
    warnings.push(
      'Remote logging blocked: DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING requires DEBUG=1 to be set explicitly. ' +
      'This is a safety measure to prevent accidental data exposure. ' +
      'To enable remote logging, set DEBUG=1 in your environment.'
    )
  }

  // Check for mismatched server URLs
  if (process.env.HAPPY_SERVER_URL && !process.env.HAPPY_WEBAPP_URL) {
    warnings.push(
      'HAPPY_SERVER_URL is set but HAPPY_WEBAPP_URL is not - you may be using a custom server with the wrong webapp URL'
    )
  }

  return { warnings, configured, usingDefaults }
}

/**
 * Validates environment and logs warnings.
 * Does not exit - CLI has sensible defaults for everything.
 */
export function validateEnv(verbose = false): void {
  const result = checkEnv()

  for (const warning of result.warnings) {
    console.warn(`[WARN] ${warning}`)
  }

  if (verbose && process.env.DEBUG) {
    console.log('\nEnvironment configuration:')
    console.log(`  Configured: ${result.configured.length} variables`)
    console.log(`  Using defaults: ${result.usingDefaults.length} variables`)
    if (result.configured.length > 0) {
      console.log(`  Custom: ${result.configured.join(', ')}`)
    }
  }
}
