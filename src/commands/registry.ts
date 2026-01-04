/**
 * Command Registry - Centralized command definitions for auto-generated help
 *
 * This module provides typed command definitions that are used to:
 * 1. Generate consistent help text automatically
 * 2. Document all available commands, options, and examples
 * 3. Ensure help text stays in sync with actual functionality
 */

import chalk from 'chalk'
import { z } from 'zod'

/**
 * Padding widths for consistent help text formatting
 */
const PADDING = {
  COMMAND_NAME: 18,
  OPTION_FLAGS: 22,
  SUBCOMMAND_USAGE: 40,
  SUBCOMMAND_OPTION_FLAGS: 20
} as const

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

/**
 * Zod schema for command-line options
 * Validates that flags start with - or -- and descriptions are non-empty
 */
const CommandOptionSchema = z.object({
  flags: z.string()
    .min(1, 'Option flags cannot be empty')
    .regex(/^-/, 'Option flags must start with - or --'),
  description: z.string().min(1, 'Option description cannot be empty')
})

/**
 * Zod schema for subcommands
 * Allows alphanumeric names with special characters for parameters like <name> or [optional]
 */
const SubCommandSchema = z.object({
  name: z.string()
    .min(1, 'Subcommand name cannot be empty')
    .regex(/^[a-z0-9-()<>[\] ]+$/i, 'Subcommand name contains invalid characters'),
  description: z.string().min(1, 'Subcommand description cannot be empty'),
  options: z.array(CommandOptionSchema).optional()
})

/**
 * Zod schema for command definitions
 * Enforces CLI naming conventions and documentation requirements
 */
const CommandDefinitionSchema = z.object({
  name: z.string()
    .regex(/^[a-z0-9-]*$/, 'Command name must be lowercase alphanumeric with hyphens (or empty for default)'),
  description: z.string()
    .min(1, 'Command description cannot be empty')
    .max(100, 'Command description too long (max 100 chars)'),
  detailedDescription: z.string().optional(),
  subcommands: z.array(SubCommandSchema).optional(),
  options: z.array(CommandOptionSchema).optional(),
  examples: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  deprecated: z.boolean().optional(),
  deprecationMessage: z.string().optional()
}).refine(
  (data) => !data.deprecated || data.deprecationMessage,
  { message: 'Deprecated commands must have a deprecationMessage' }
)

// ============================================================================

/**
 * Represents a command-line option with its description
 */
export interface CommandOption {
  /** The option flag(s), e.g., "--force" or "-p <message>" */
  flags: string
  /** Description of what the option does */
  description: string
}

/**
 * Represents a subcommand within a parent command
 */
export interface SubCommand {
  /** Subcommand name */
  name: string
  /** Brief description */
  description: string
  /** Options specific to this subcommand */
  options?: CommandOption[]
}

/**
 * Represents a CLI command with all its metadata
 */
export interface CommandDefinition {
  /** Command name (e.g., "auth", "daemon") */
  name: string
  /** Brief description shown in main help */
  description: string
  /** Detailed description for command-specific help */
  detailedDescription?: string
  /** Available subcommands */
  subcommands?: SubCommand[]
  /** Command-level options */
  options?: CommandOption[]
  /** Usage examples */
  examples?: string[]
  /** Additional notes shown at the end of help */
  notes?: string[]
  /** Whether this command is deprecated */
  deprecated?: boolean
  /** Deprecation message if deprecated */
  deprecationMessage?: string
}

/**
 * All CLI commands with their complete definitions
 *
 * This registry is the single source of truth for command metadata.
 * The command router validates that all commands here have handlers.
 */
export const commands: Record<string, CommandDefinition> = {
  auth: {
    name: 'auth',
    description: 'Manage authentication',
    detailedDescription: 'Authentication management for Happy services',
    subcommands: [
      { name: 'login', description: 'Authenticate with Happy', options: [{ flags: '--force', description: 'Clear credentials, machine ID, and stop daemon before re-auth' }] },
      { name: 'logout', description: 'Remove authentication and machine data' },
      { name: 'status', description: 'Show authentication status', options: [{ flags: '--show-token', description: 'Display the full auth token (use with caution)' }] },
      { name: 'help', description: 'Show help message' },
    ],
    examples: [
      'happy auth login',
      'happy auth login --force',
      'happy auth status',
      'happy auth logout',
    ],
  },

  codex: {
    name: 'codex',
    description: 'Start Codex mode',
    detailedDescription: 'Start an interactive Codex session with mobile control',
    options: [
      { flags: '--started-by <mode>', description: 'Specify how session was started (daemon|terminal)' },
    ],
    examples: [
      'happy codex',
    ],
  },

  gemini: {
    name: 'gemini',
    description: 'Start Gemini mode',
    detailedDescription: 'Start an interactive Gemini session with mobile control',
    subcommands: [
      { name: 'model set <model>', description: 'Set the default Gemini model' },
      { name: 'model get', description: 'Show the current Gemini model' },
    ],
    options: [
      { flags: '--started-by <mode>', description: 'Specify how session was started (daemon|terminal)' },
    ],
    examples: [
      'happy gemini',
      'happy gemini model set gemini-2.5-pro',
      'happy gemini model get',
    ],
    notes: [
      'Available models: gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite',
    ],
  },

  connect: {
    name: 'connect',
    description: 'Connect AI vendor API keys',
    detailedDescription: 'Store your AI vendor API keys securely in Happy cloud',
    subcommands: [
      { name: 'codex', description: 'Store your OpenAI API key in Happy cloud' },
      { name: 'claude', description: 'Store your Anthropic API key in Happy cloud' },
      { name: 'gemini', description: 'Store your Gemini API key in Happy cloud' },
      { name: 'help', description: 'Show help message' },
    ],
    examples: [
      'happy connect codex',
      'happy connect claude',
      'happy connect gemini',
    ],
    notes: [
      'You must be authenticated first (run \'happy auth login\')',
      'API keys are encrypted and stored securely in Happy cloud',
      'Manage your stored keys at happy.enflamemedia.com',
    ],
  },

  notify: {
    name: 'notify',
    description: 'Send push notification',
    detailedDescription: 'Send a push notification to your connected mobile devices',
    options: [
      { flags: '-p <message>', description: 'Notification message (required)' },
      { flags: '-t <title>', description: 'Notification title (optional, defaults to "Happy")' },
      { flags: '-h, --help', description: 'Show help message' },
    ],
    examples: [
      'happy notify -p "Deployment complete!"',
      'happy notify -p "System update complete" -t "Server Status"',
      'happy notify -t "Alert" -p "Database connection restored"',
    ],
  },

  daemon: {
    name: 'daemon',
    description: 'Manage background service',
    detailedDescription: 'Manage the Happy background service that enables spawning new sessions remotely',
    subcommands: [
      { name: 'start', description: 'Start the daemon (detached)' },
      { name: 'stop', description: 'Stop the daemon (sessions stay alive)' },
      { name: 'restart', description: 'Stop running daemon and start new instance' },
      { name: 'status', description: 'Show daemon status', options: [{ flags: '--json', description: 'Output in JSON format for scripting' }] },
      { name: 'health', description: 'Show daemon health metrics', options: [{ flags: '--json', description: 'Output in JSON format for scripting' }] },
      { name: 'list', description: 'List active sessions' },
      { name: 'stop-session <session-id>', description: 'Stop a specific session by UUID' },
      { name: 'logs', description: 'Show path to latest daemon log file' },
      { name: 'install', description: 'Install daemon as system service' },
      { name: 'uninstall', description: 'Uninstall daemon system service' },
    ],
    examples: [
      'happy daemon start',
      'happy daemon stop',
      'happy daemon restart',
      'happy daemon status',
      'happy daemon status --json',
      'happy daemon health',
      'happy daemon list',
      'happy daemon stop-session <session-id>',
      'happy daemon logs',
    ],
    notes: [
      'Exit codes for "daemon status --json": 0=running, 1=not running, 2=stale state',
      'Exit codes for "daemon health": 0=healthy, 1=degraded, 2=unhealthy',
      'To clean up runaway processes: happy doctor clean',
    ],
  },

  doctor: {
    name: 'doctor',
    description: 'System diagnostics & troubleshooting',
    detailedDescription: 'Run system diagnostics and troubleshoot Happy installation',
    subcommands: [
      { name: '(no subcommand)', description: 'Run full system diagnostics' },
      { name: 'clean', description: 'Kill runaway Happy processes and orphaned caffeinate' },
    ],
    examples: [
      'happy doctor',
      'happy doctor clean',
    ],
  },

  logout: {
    name: 'logout',
    description: 'Remove authentication (deprecated)',
    deprecated: true,
    deprecationMessage: 'Use "happy auth logout" instead',
    examples: [
      'happy auth logout',
    ],
  },

  completion: {
    name: 'completion',
    description: 'Generate shell completion scripts',
    detailedDescription: 'Generate shell completion scripts for bash, zsh, or fish',
    subcommands: [
      { name: 'bash', description: 'Generate bash completion script' },
      { name: 'zsh', description: 'Generate zsh completion script' },
      { name: 'fish', description: 'Generate fish completion script' },
    ],
    examples: [
      'happy completion bash > /etc/bash_completion.d/happy',
      'happy completion zsh > ~/.zfunc/_happy',
      'happy completion fish > ~/.config/fish/completions/happy.fish',
    ],
    notes: [
      'For bash, source the script or add to /etc/bash_completion.d/',
      'For zsh, add the directory to fpath before compinit',
      'For fish, place in ~/.config/fish/completions/',
    ],
  },

  mcp: {
    name: 'mcp',
    description: 'Manage MCP servers and tools',
    detailedDescription: 'Manage Model Context Protocol (MCP) servers for AI agent tool integration',
    subcommands: [
      { name: 'list', description: 'List all configured MCP servers' },
      { name: 'add <name>', description: 'Add a new MCP server', options: [{ flags: '--scope <scope>', description: 'Config scope (user|project)' }, { flags: '--env <env...>', description: 'Environment variables (KEY=VALUE)' }] },
      { name: 'remove <name>', description: 'Remove an MCP server' },
      { name: 'enable <name>', description: 'Enable a disabled MCP server' },
      { name: 'disable <name>', description: 'Disable an MCP server without removing it' },
      { name: 'validate [name]', description: 'Validate MCP server configuration and connectivity' },
    ],
    examples: [
      'happy mcp list',
      'happy mcp add github npx -y @modelcontextprotocol/server-github',
      'happy mcp add fs npx -y @modelcontextprotocol/server-filesystem',
      'happy mcp disable github',
      'happy mcp validate',
    ],
    notes: [
      'MCP servers extend Claude Code with additional tools and capabilities',
      'Use --scope project to store configuration in project .claude.json',
      'Environment variables are securely stored in the configuration',
    ],
  },
}

/**
 * Default command (when no subcommand is specified)
 */
const defaultCommand: CommandDefinition = {
  name: '',
  description: 'Start Claude with mobile control',
  detailedDescription: 'Start an interactive Claude session with Happy mobile control enabled',
  options: [
    { flags: '--yolo', description: 'Bypass permissions (sugar for --dangerously-skip-permissions)' },
    { flags: '--resume [session]', description: 'Resume a previous session' },
    { flags: '--verbose', description: 'Enable verbose output (equivalent to DEBUG=1)' },
    { flags: '--version', description: 'Show version information' },
    { flags: '--help, -h', description: 'Show help message' },
  ],
  examples: [
    'happy',
    'happy --yolo',
    'happy --resume',
  ],
  notes: [
    'Happy supports ALL Claude Code options!',
    'Use any claude flag with happy as you would with claude.',
  ],
}

// ============================================================================
// Runtime Validation
// ============================================================================

/**
 * Validate all command definitions at module load
 *
 * This function runs once when the module is imported to catch malformed
 * command definitions early. It validates:
 * - All commands in the registry against CommandDefinitionSchema
 * - The defaultCommand against the same schema
 * - That command names within the registry are unique
 *
 * @throws Error with detailed validation failures if any command is malformed
 */
function validateCommandRegistry(): void {
  const commandsSchema = z.record(z.string(), CommandDefinitionSchema)

  try {
    // Validate all commands
    commandsSchema.parse(commands)

    // Validate default command
    CommandDefinitionSchema.parse(defaultCommand)

    // Additional validation: Check for duplicate command names
    const commandNames = Object.values(commands).map(cmd => cmd.name)
    const duplicates = commandNames.filter((name, index) =>
      commandNames.indexOf(name) !== index
    )
    if (duplicates.length > 0) {
      throw new Error(`Duplicate command names found: ${duplicates.join(', ')}`)
    }

  } catch (error) {
    if (error instanceof z.ZodError) {
      const formattedErrors = error.issues.map((issue: z.ZodIssue) =>
        `  - ${issue.path.join('.')}: ${issue.message}`
      ).join('\n')

      throw new Error(
        `Command registry validation failed:\n${formattedErrors}\n\n` +
        `Please fix the command definitions in src/commands/registry.ts`
      )
    }
    throw error
  }
}

// Run validation at module load
validateCommandRegistry()

// ============================================================================

/**
 * Exit code definitions for CLI commands.
 * These are used in the help text to document program exit behavior.
 */
export const EXIT_CODES = {
  SUCCESS: { code: 0, description: 'Command completed successfully' },
  GENERAL_ERROR: { code: 1, description: 'General error or command failed' },
  UNHEALTHY: { code: 2, description: 'Daemon is unhealthy or state is stale' },
} as const

/**
 * Error behavior documentation for help output
 */
const errorBehavior: string[] = [
  'Exit Codes:',
  '  0    Success - command completed without errors',
  '  1    Error - command failed or daemon not running',
  '  2    Unhealthy - daemon is degraded/stale (daemon health/status only)',
  '',
  'Error Handling:',
  '  • Network errors auto-retry with exponential backoff (3 attempts)',
  '  • Authentication errors require re-running "happy auth login"',
  '  • Daemon errors can be diagnosed with "happy doctor"',
  '',
  'Troubleshooting:',
  '  • Run "happy doctor" for system diagnostics',
  '  • Run "happy doctor clean" to kill stuck processes',
  '  • Check daemon logs: happy daemon logs',
  '  • Enable verbose mode: happy --verbose',
  '  • See docs: https://github.com/Enflame-Media/happy-shared/blob/main/docs/errors/',
]

/**
 * Generate the main help text from command definitions
 *
 * Creates formatted help output showing all available commands, options, and examples.
 * The help text is divided into sections:
 * - Usage: Basic command syntax
 * - Commands: All available subcommands (excluding deprecated ones)
 * - Options: Flags available for the default command
 * - Examples: Common usage patterns from the registry
 * - Notes: Special compatibility information about Claude options
 *
 * @returns Formatted help text ready for console output
 */
export function generateMainHelp(): string {
  const lines: string[] = []

  // Header
  lines.push('')
  lines.push(`${chalk.bold('happy')} - Claude Code On the Go`)
  lines.push('')

  // Usage section
  lines.push(`${chalk.bold('Usage:')}`)
  lines.push('  happy [options]         Start Claude with mobile control')

  // Commands section - only non-deprecated commands
  const visibleCommands = Object.values(commands).filter(cmd => !cmd.deprecated)
  for (const cmd of visibleCommands) {
    const paddedName = cmd.name.padEnd(PADDING.COMMAND_NAME)
    lines.push(`  happy ${paddedName}${cmd.description}`)
  }
  lines.push('')

  // Default options
  lines.push(`${chalk.bold('Options:')}`)
  for (const opt of defaultCommand.options ?? []) {
    const paddedFlags = opt.flags.padEnd(PADDING.OPTION_FLAGS)
    lines.push(`  ${paddedFlags}${opt.description}`)
  }
  lines.push('')

  // Examples - use examples from registry
  lines.push(`${chalk.bold('Examples:')}`)
  for (const example of defaultCommand.examples ?? []) {
    lines.push(`  ${example}`)
  }
  // Add a few popular command examples
  lines.push('  happy auth login --force Authenticate')
  lines.push('  happy doctor             Run diagnostics')
  lines.push('')

  // Notes
  if (defaultCommand.notes && defaultCommand.notes.length > 0) {
    for (const note of defaultCommand.notes) {
      lines.push(`${chalk.bold(note)}`)
    }
    lines.push('  Use any claude flag with happy as you would with claude. Our favorite:')
    lines.push('')
    lines.push('  happy --resume')
    lines.push('')
  }

  // Error behavior section
  lines.push(chalk.gray('─'.repeat(60)))
  lines.push(`${chalk.bold.cyan('Error Behavior:')}`)
  lines.push('')
  for (const line of errorBehavior) {
    lines.push(`  ${line}`)
  }
  lines.push('')

  // Separator for Claude help
  lines.push(chalk.gray('─'.repeat(60)))
  lines.push(`${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}`)

  return lines.join('\n')
}

/**
 * Generate help text for a specific command
 *
 * Creates formatted help output for a single command including:
 * - Header with command name and description
 * - Usage patterns for all subcommands
 * - Available options with descriptions
 * - Examples of common usage
 * - Important notes and caveats
 * - Deprecation warnings if applicable
 *
 * The function handles different command structures:
 * - Commands with subcommands (e.g., auth, daemon)
 * - Commands with options only (e.g., notify)
 * - Simple commands with no options
 *
 * @param commandName - The name of the command to generate help for
 * @returns Formatted help text, or null if command not found
 */
export function generateCommandHelp(commandName: string): string | null {
  const cmd = commands[commandName]
  if (!cmd) return null

  const lines: string[] = []

  // Header
  lines.push('')
  lines.push(`${chalk.bold(`happy ${cmd.name}`)} - ${cmd.detailedDescription ?? cmd.description}`)
  lines.push('')

  // Usage section
  lines.push(`${chalk.bold('Usage:')}`)
  if (cmd.subcommands && cmd.subcommands.length > 0) {
    for (const sub of cmd.subcommands) {
      const subOptions = sub.options?.map(o => ` [${o.flags}]`).join('') ?? ''
      const paddedUsage = `happy ${cmd.name} ${sub.name}${subOptions}`.padEnd(PADDING.SUBCOMMAND_USAGE)
      lines.push(`  ${paddedUsage}${sub.description}`)
    }
  } else if (cmd.options && cmd.options.length > 0) {
    lines.push(`  happy ${cmd.name} [options]`)
  } else {
    lines.push(`  happy ${cmd.name}`)
  }
  lines.push('')

  // Options section (command-level options)
  if (cmd.options && cmd.options.length > 0) {
    lines.push(`${chalk.bold('Options:')}`)
    for (const opt of cmd.options) {
      const paddedFlags = opt.flags.padEnd(PADDING.SUBCOMMAND_OPTION_FLAGS)
      lines.push(`  ${paddedFlags}${opt.description}`)
    }
    lines.push('')
  }

  // Examples section
  if (cmd.examples && cmd.examples.length > 0) {
    lines.push(`${chalk.bold('Examples:')}`)
    for (const example of cmd.examples) {
      lines.push(`  ${example}`)
    }
    lines.push('')
  }

  // Notes section
  if (cmd.notes && cmd.notes.length > 0) {
    lines.push(`${chalk.bold('Notes:')}`)
    for (const note of cmd.notes) {
      lines.push(`  • ${note}`)
    }
    lines.push('')
  }

  // Deprecation warning
  if (cmd.deprecated && cmd.deprecationMessage) {
    lines.push(chalk.yellow(`Note: "${cmd.name}" is deprecated. ${cmd.deprecationMessage}`))
    lines.push('')
  }

  return lines.join('\n')
}
