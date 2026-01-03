/**
 * Command Router
 *
 * Maps command names to their handler functions using a registry pattern.
 * This replaces the if-else chain in the main entry point.
 */

import { handleAuthCommand } from '@/commands/auth'
import { handleConnectCommand } from '@/commands/connect'
import { handleCompletionCommand } from '@/commands/completion'
import { handleDoctorCommand } from '@/commands/doctor'
import { handleCodexCommand } from '@/commands/codex'
import { handleGeminiCommand } from '@/commands/gemini'
import { handleLogoutCommand } from '@/commands/logout'
import { handleNotifyCommand } from '@/commands/notify'
import { handleMcpCommand } from '@/commands/mcp'
import { handleDaemonCommand } from '@/commands/daemon'
import { addBreadcrumb, trackMetric } from '@/telemetry'
import { logger } from '@/ui/logger'

/**
 * Command handler function signature
 *
 * All command handlers follow this consistent signature:
 * - Takes args array (remaining args after the command name)
 * - Returns Promise<void>
 */
export type CommandHandler = (args: string[]) => Promise<void>

/**
 * Command handler configuration
 */
interface CommandConfig {
  handler: CommandHandler
  /** Enable command timing via telemetry */
  timed?: boolean
  /** Override command name for telemetry */
  telemetryName?: string
}

/**
 * Command handlers map
 *
 * Maps command names to their handler functions.
 * Each handler receives args.slice(1) (args after the command name).
 */
const commandHandlers: Record<string, CommandConfig> = {
  doctor: { handler: handleDoctorCommand },
  auth: { handler: handleAuthCommand, timed: true },
  connect: { handler: handleConnectCommand, timed: true },
  codex: { handler: handleCodexCommand },
  gemini: { handler: handleGeminiCommand },
  logout: { handler: handleLogoutCommand },
  completion: { handler: handleCompletionCommand },
  notify: { handler: handleNotifyCommand },
  mcp: { handler: handleMcpCommand },
  daemon: { handler: handleDaemonCommand }
}

/**
 * Execute a command by name
 *
 * @param command - The command name
 * @param args - Command arguments (includes the command name as first element)
 * @returns true if command was found and executed, false otherwise
 */
export async function executeCommand(command: string, args: string[]): Promise<boolean> {
  const config = commandHandlers[command]

  if (!config) {
    return false
  }

  // Get remaining args after command name
  const commandArgs = args.slice(1)

  if (config.timed) {
    const commandStart = Date.now()
    const telemetryName = config.telemetryName || command
    addBreadcrumb({ category: 'command', message: `Starting ${telemetryName} command`, level: 'info' })

    try {
      await config.handler(commandArgs)
      trackMetric('command_duration', Date.now() - commandStart, { command: telemetryName, success: true })
    } catch (error) {
      trackMetric('command_duration', Date.now() - commandStart, { command: telemetryName, success: false })
      logger.errorAndExit(`${command} command failed`, error)
    }
  } else {
    try {
      await config.handler(commandArgs)
    } catch (error) {
      logger.errorAndExit(`${command} command failed`, error)
    }
  }

  return true
}

/**
 * Check if a command exists
 *
 * @param command - The command name to check
 * @returns true if command exists
 */
export function hasCommand(command: string): boolean {
  return command in commandHandlers
}

/**
 * Get all registered command names
 *
 * @returns Array of command names
 */
export function getCommandNames(): string[] {
  return Object.keys(commandHandlers)
}
