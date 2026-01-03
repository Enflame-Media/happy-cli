#!/usr/bin/env node

/**
 * CLI entry point for happy command
 *
 * Simple argument parsing without any CLI framework dependencies
 */

import chalk from 'chalk'
import packageJson from '../package.json'

// Capture startup time as early as possible (before any imports)
// This measures total CLI initialization time for performance monitoring
const startupStart = Date.now()

// Export version to avoid "empty chunk" bundler warnings
// This export is not used by the CLI itself but makes the package usable as a library
export const VERSION = packageJson.version
import { runClaude } from '@/claude/runClaude'
import { parseCliArgs } from '@/parsers/cliArgs'
import { validateEnv } from '@/utils/validateEnv'
import { logger } from './ui/logger'
import { authAndSetupMachineIfNeeded } from './ui/auth'
import { isDaemonRunningCurrentlyInstalledHappyVersion } from './daemon/controlClient'
import { executeCommand } from './commands/router'
import { generateMainHelp, EXIT_CODES } from './commands/registry'
import { spawnHappyCLI } from './utils/spawnHappyCLI'
import { claudeCliPath } from './claude/claudeLocal'
import { execFileSync } from 'node:child_process'
import { checkForUpdatesAndNotify } from './utils/checkForUpdates'
import { initializeTelemetry, showTelemetryNoticeIfNeeded, trackMetric, setTag, addBreadcrumb, shutdownTelemetry } from './telemetry'


(async () => {
  // Validate environment variables early (logs warnings for unusual configs)
  validateEnv()

  // Initialize telemetry early (non-blocking, respects user preferences)
  // This sets up error reporting and usage tracking if enabled
  void initializeTelemetry()

  // Non-blocking version check - runs in background without blocking startup
  // Uses 5-second timeout and silently handles network errors (HAP-134)
  void checkForUpdatesAndNotify()

  const args = process.argv.slice(2)
  const subcommand = args[0]

  // Track startup timing and set initial tags for observability (HAP-522)
  // This runs after telemetry init to ensure sender is ready
  trackMetric('startup_time', Date.now() - startupStart, {
    command: subcommand || 'default',
    platform: process.platform
  })
  setTag('cli.command', subcommand || 'default')
  addBreadcrumb({ category: 'cli', message: `CLI started: ${subcommand || 'default'}`, level: 'info' })

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!args.includes('--version')) {
    logger.debug('Starting happy CLI with args: ', process.argv)
  }

  // Try to route to a specific command handler
  if (subcommand && await executeCommand(subcommand, args)) {
    return
  }

  // Default command flow (no subcommand or unrecognized command)
  // Parse command line arguments
  const { options, showHelp, showVersion, verbose } = parseCliArgs(args)

  // Enable verbose output if --verbose flag is present
  // This sets DEBUG=1 which enables detailed logging throughout the codebase
  if (verbose) {
    process.env.DEBUG = '1'
  }

  // Show help
  if (showHelp) {
    // Use auto-generated help text from command registry
    console.log(generateMainHelp())

    // Run claude --help and display its output
    // Use execFileSync with the current Node executable for cross-platform compatibility
    try {
      const claudeHelp = execFileSync(process.execPath, [claudeCliPath, '--help'], { encoding: 'utf8' })
      console.log(claudeHelp)
    } catch {
      console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'))
    }

    process.exit(EXIT_CODES.SUCCESS.code)
  }

  // Show version
  if (showVersion) {
    console.log(`happy version: ${packageJson.version}`)
    // Don't exit - continue to pass --version to Claude Code
  }

  // Normal flow - auth and machine setup
  const { credentials } = await authAndSetupMachineIfNeeded()

  // Show telemetry opt-in notice once (non-blocking, informational only)
  await showTelemetryNoticeIfNeeded()

  // Always auto-start daemon for simplicity
  logger.debug('Ensuring Happy background service is running & matches our version...')

  if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
    logger.debug('Starting Happy background service...')

    // Use the built binary to spawn daemon
    const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env
    })
    daemonProcess.unref()

    // Give daemon a moment to write PID & port file
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  // Start the CLI with session tracking (HAP-522)
  setTag('cli.mode', 'interactive')
  addBreadcrumb({ category: 'session', message: 'Starting Claude session', level: 'info' })
  try {
    await runClaude(credentials, options)
    // Ensure telemetry is flushed before exit
    await shutdownTelemetry()
  } catch (error) {
    await shutdownTelemetry()
    logger.errorAndExit('Claude session failed', error)
  }
})()
