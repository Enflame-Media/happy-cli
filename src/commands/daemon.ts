/**
 * Daemon command handler
 *
 * Manages the Happy background daemon service.
 */

import chalk from 'chalk'
import { readDaemonState } from '@/persistence'
import { startDaemon } from '@/daemon/run'
import {
  checkIfDaemonRunningAndCleanupStaleState,
  stopDaemon,
  listDaemonSessions,
  stopDaemonSession,
  getDaemonHealth
} from '@/daemon/controlClient'
import { getLatestDaemonLog } from '@/ui/logger'
import { install } from '@/daemon/install'
import { uninstall } from '@/daemon/uninstall'
import { runDoctorCommand, getDaemonStatusJson } from '@/ui/doctor'
import { isValidSessionId } from '@/claude/utils/sessionValidation'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { generateCommandHelp, EXIT_CODES } from '@/commands/registry'
import { logger } from '@/ui/logger'

/**
 * Handle daemon command
 *
 * @param args - Command arguments
 */
export async function handleDaemonCommand(args: string[]): Promise<void> {
  const daemonSubcommand = args[0]

  if (daemonSubcommand === 'list') {
    await handleDaemonList()
    return
  }

  if (daemonSubcommand === 'stop-session') {
    await handleStopSession(args[1])
    return
  }

  if (daemonSubcommand === 'start') {
    await handleDaemonStart()
    return
  }

  if (daemonSubcommand === 'start-sync') {
    await startDaemon()
    process.exit(EXIT_CODES.SUCCESS.code)
  }

  if (daemonSubcommand === 'stop') {
    await stopDaemon()
    process.exit(EXIT_CODES.SUCCESS.code)
  }

  if (daemonSubcommand === 'restart') {
    await handleDaemonRestart()
    return
  }

  if (daemonSubcommand === 'status') {
    await handleDaemonStatus(args.slice(1))
    return
  }

  if (daemonSubcommand === 'health') {
    await handleDaemonHealth(args.slice(1))
    return
  }

  if (daemonSubcommand === 'logs') {
    await handleDaemonLogs()
    return
  }

  if (daemonSubcommand === 'install') {
    try {
      await install()
    } catch (error) {
      logger.errorAndExit('Daemon install failed', error)
    }
    return
  }

  if (daemonSubcommand === 'uninstall') {
    try {
      await uninstall()
    } catch (error) {
      logger.errorAndExit('Daemon uninstall failed', error)
    }
    return
  }

  // Show help for unknown subcommand or no subcommand
  const help = generateCommandHelp('daemon')
  if (help) {
    console.log(help)
  } else {
    console.error(chalk.red('Error: Help text not available for daemon command'))
  }
}

async function handleDaemonList(): Promise<void> {
  const result = await listDaemonSessions()

  if (!result.success) {
    console.log(chalk.yellow(`Cannot list sessions: ${result.error}`))
    return
  }

  const sessions = result.data.children
  if (sessions.length === 0) {
    console.log('No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)')
  } else {
    console.log('Active sessions:')
    console.log(JSON.stringify(sessions, null, 2))
  }
}

async function handleStopSession(sessionId: string | undefined): Promise<void> {
  if (!sessionId) {
    console.error(chalk.red('Error: Session ID required'))
    console.log(chalk.gray('Usage: happy daemon stop-session <session-id>'))
    console.log(chalk.gray('List active sessions with: happy daemon list'))
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }

  // Validate session ID format (accepts both UUID and hex formats)
  if (!isValidSessionId(sessionId)) {
    console.error(chalk.red(`Error: Invalid session ID format: ${sessionId}`))
    console.log(chalk.gray('Expected format: UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) or hex (32 characters)'))
    console.log(chalk.gray('List active sessions with: happy daemon list'))
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }

  const result = await stopDaemonSession(sessionId)
  if (!result.success) {
    console.error(chalk.red(`✗ Cannot stop session: ${result.error}`))
    console.log(chalk.gray('Is the daemon running? Start with: happy daemon start'))
  } else if (result.data.success) {
    console.log(chalk.green(`✓ Session ${sessionId} stopped`))
  } else {
    console.error(chalk.red(`✗ Failed to stop session ${sessionId}`))
    console.log(chalk.gray('Session may have already stopped'))
  }
}

async function handleDaemonStart(): Promise<void> {
  // Pre-start validation: check if daemon is already running
  const daemonCheck = await checkIfDaemonRunningAndCleanupStaleState()

  if (daemonCheck.status === 'running') {
    console.error(chalk.red('✗ Daemon is already running'))
    console.log(chalk.gray(`  PID: ${daemonCheck.pid}`))
    console.log(chalk.gray(`  Port: ${daemonCheck.httpPort}`))
    if (daemonCheck.version) {
      console.log(chalk.gray(`  Version: ${daemonCheck.version}`))
    }
    console.log()
    console.log(chalk.yellow('To restart the daemon:'))
    console.log(chalk.gray('  happy daemon restart'))
    console.log()
    console.log(chalk.yellow('To stop the daemon:'))
    console.log(chalk.gray('  happy daemon stop'))
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }

  // If status is 'stale', the check function already cleaned it up
  // If status is 'stopped' or 'error', we can proceed with starting

  // Spawn detached daemon process
  const child = spawnHappyCLI(['daemon', 'start-sync'], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  })
  child.unref()

  // Wait for daemon to write state file (up to 5 seconds)
  let started = false
  const maxAttempts = 50
  for (let i = 0; i < maxAttempts; i++) {
    const daemonCheck = await checkIfDaemonRunningAndCleanupStaleState()
    if (daemonCheck.status === 'running') {
      started = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  if (started) {
    console.log(chalk.green('✓ Daemon started successfully'))
    console.log(chalk.gray('  Check status: happy daemon status'))
  } else {
    console.error(chalk.red('✗ Daemon did not start within 5 seconds'))

    // Try to get logs for debugging
    const latestLog = await getLatestDaemonLog()
    if (latestLog) {
      console.log(chalk.yellow('Check logs for details:'))
      console.log(chalk.gray(`  ${latestLog.path}`))
    }

    // Check if process exists but is slow to initialize
    const state = await readDaemonState()
    if (state?.pid) {
      try {
        process.kill(state.pid, 0)
        console.log(chalk.yellow('Daemon process exists but is taking longer to initialize'))
        console.log(chalk.gray('Wait and check: happy daemon status'))
        process.exit(EXIT_CODES.SUCCESS.code)
      } catch {
        // Process doesn't exist, true failure
      }
    }

    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }
  process.exit(EXIT_CODES.SUCCESS.code)
}

async function handleDaemonRestart(): Promise<void> {
  // Check current daemon state
  const daemonCheck = await checkIfDaemonRunningAndCleanupStaleState()

  if (daemonCheck.status === 'running') {
    console.log(chalk.yellow('Stopping daemon...'))
    await stopDaemon()
    console.log(chalk.green('✓ Daemon stopped'))
  } else if (daemonCheck.status === 'stale') {
    // Stale state was already cleaned up by the check function
    console.log(chalk.gray('Cleaned up stale daemon state'))
  }
  // For 'stopped' or 'error' status, we just proceed to start

  console.log(chalk.yellow('Starting daemon...'))

  // Spawn detached daemon process (same logic as handleDaemonStart)
  const child = spawnHappyCLI(['daemon', 'start-sync'], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  })
  child.unref()

  // Wait for daemon to write state file (up to 5 seconds)
  let started = false
  const maxAttempts = 50
  for (let i = 0; i < maxAttempts; i++) {
    const checkResult = await checkIfDaemonRunningAndCleanupStaleState()
    if (checkResult.status === 'running') {
      started = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  if (started) {
    console.log(chalk.green('✓ Daemon restarted successfully'))
    console.log(chalk.gray('  Check status: happy daemon status'))
  } else {
    console.error(chalk.red('✗ Daemon did not start within 5 seconds'))

    // Try to get logs for debugging
    const latestLog = await getLatestDaemonLog()
    if (latestLog) {
      console.log(chalk.yellow('Check logs for details:'))
      console.log(chalk.gray(`  ${latestLog.path}`))
    }

    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }
  process.exit(EXIT_CODES.SUCCESS.code)
}

async function handleDaemonStatus(args: string[]): Promise<void> {
  // Check for --json flag
  const useJson = args.includes('--json')

  if (useJson) {
    // Machine-readable JSON output with appropriate exit codes
    const { status, exitCode } = await getDaemonStatusJson()
    console.log(JSON.stringify(status, null, 2))
    process.exit(exitCode)
  } else {
    // Human-readable output (existing behavior)
    await runDoctorCommand('daemon')
    process.exit(EXIT_CODES.SUCCESS.code)
  }
}

async function handleDaemonHealth(args: string[]): Promise<void> {
  // Check for --json flag
  const useJson = args.includes('--json')

  const result = await getDaemonHealth()

  if (!result.success) {
    if (useJson) {
      console.log(JSON.stringify({ status: 'error', error: result.error }, null, 2))
    } else {
      console.log(chalk.red('✗ Daemon is not running'))
      console.log(chalk.gray(`  ${result.error}`))
      console.log(chalk.gray('  Start with: happy daemon start'))
    }
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }

  const health = result.data

  if (useJson) {
    console.log(JSON.stringify(health, null, 2))
  } else {
    // Format uptime as human-readable
    const uptimeMs = health.uptime
    const hours = Math.floor(uptimeMs / 3600000)
    const minutes = Math.floor((uptimeMs % 3600000) / 60000)
    const seconds = Math.floor((uptimeMs % 60000) / 1000)
    const uptimeStr = hours > 0
      ? `${hours}h ${minutes}m ${seconds}s`
      : minutes > 0
        ? `${minutes}m ${seconds}s`
        : `${seconds}s`

    // Format memory in MB
    const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
    const heapPercent = ((health.memory.heapUsed / health.memory.heapTotal) * 100).toFixed(1)

    // Status with color and symbol
    const statusColor = health.status === 'healthy'
      ? chalk.green
      : health.status === 'degraded'
        ? chalk.yellow
        : chalk.red
    const statusSymbol = health.status === 'healthy' ? '✓' : health.status === 'degraded' ? '⚠' : '✗'

    console.log(`
${chalk.bold('🏥 Daemon Health Status')}

${chalk.bold('Status:')}     ${statusColor(`${health.status} ${statusSymbol}`)}
${chalk.bold('Uptime:')}     ${uptimeStr}
${chalk.bold('Sessions:')}   ${health.sessions} active
${chalk.bold('Memory:')}
  RSS:      ${formatMB(health.memory.rss)} MB
  Heap:     ${formatMB(health.memory.heapUsed)} MB / ${formatMB(health.memory.heapTotal)} MB (${heapPercent}%)
  External: ${formatMB(health.memory.external)} MB

${chalk.gray(`Last checked: ${new Date(health.timestamp).toLocaleString()}`)}
`)
  }

  // Exit codes: SUCCESS for healthy, GENERAL_ERROR for degraded, UNHEALTHY for unhealthy
  const exitCode = health.status === 'healthy'
    ? EXIT_CODES.SUCCESS.code
    : health.status === 'degraded'
      ? EXIT_CODES.GENERAL_ERROR.code
      : EXIT_CODES.UNHEALTHY.code
  process.exit(exitCode)
}

async function handleDaemonLogs(): Promise<void> {
  // Simply print the path to the latest daemon log file
  const latest = await getLatestDaemonLog()
  if (!latest) {
    console.log('No daemon logs found')
  } else {
    console.log(latest.path)
  }
  process.exit(EXIT_CODES.SUCCESS.code)
}
