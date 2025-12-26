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
import { validateStartedBy } from '@/utils/validators'
import { validateEnv } from '@/utils/validateEnv'
import { logger } from './ui/logger'
import { readCredentials, readDaemonState } from './persistence'
import { authAndSetupMachineIfNeeded } from './ui/auth'
import { startDaemon } from './daemon/run'
import { checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './daemon/controlClient'
import { getLatestDaemonLog } from './ui/logger'
import { killRunawayHappyProcesses, killOrphanedCaffeinate } from './daemon/doctor'
import { install } from './daemon/install'
import { uninstall } from './daemon/uninstall'
import { ApiClient } from './api/api'
import { runDoctorCommand, getDaemonStatusJson } from './ui/doctor'
import { listDaemonSessions, stopDaemonSession, getDaemonHealth } from './daemon/controlClient'
import { handleAuthCommand } from './commands/auth'
import { handleConnectCommand } from './commands/connect'
import { handleCompletionCommand } from './commands/completion'
import { generateMainHelp, generateCommandHelp, EXIT_CODES } from './commands/registry'
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

  // Process subcommands
  if (subcommand === 'doctor') {
    // Check for clean subcommand
    if (args[1] === 'clean') {
      const result = await killRunawayHappyProcesses()
      console.log(`Cleaned up ${result.killed} runaway processes`)
      if (result.errors.length > 0) {
        console.log('Errors:', result.errors)
      }

      // Also clean up orphaned caffeinate process if any
      const caffeinateResult = await killOrphanedCaffeinate()
      if (caffeinateResult.killed) {
        console.log('Cleaned up orphaned caffeinate process')
      }
      if (caffeinateResult.error) {
        console.log('Caffeinate cleanup error:', caffeinateResult.error)
      }

      process.exit(EXIT_CODES.SUCCESS.code)
    }
    await runDoctorCommand();
    return;
  } else if (subcommand === 'auth') {
    // Handle auth subcommands with timing (HAP-522)
    const commandStart = Date.now()
    addBreadcrumb({ category: 'command', message: 'Starting auth command', level: 'info' })
    try {
      await handleAuthCommand(args.slice(1));
      trackMetric('command_duration', Date.now() - commandStart, { command: 'auth', success: true })
    } catch (error) {
      trackMetric('command_duration', Date.now() - commandStart, { command: 'auth', success: false })
      logger.errorAndExit('Authentication command failed', error)
    }
    return;
  } else if (subcommand === 'connect') {
    // Handle connect subcommands with timing (HAP-522)
    const commandStart = Date.now()
    addBreadcrumb({ category: 'command', message: 'Starting connect command', level: 'info' })
    try {
      await handleConnectCommand(args.slice(1));
      trackMetric('command_duration', Date.now() - commandStart, { command: 'connect', success: true })
    } catch (error) {
      trackMetric('command_duration', Date.now() - commandStart, { command: 'connect', success: false })
      logger.errorAndExit('Connect command failed', error)
    }
    return;
  } else if (subcommand === 'codex') {
    // Handle codex command with timing (HAP-534)
    const commandStart = Date.now()
    addBreadcrumb({ category: 'command', message: 'Starting codex command', level: 'info' })
    try {
      const { runCodex } = await import('@/codex/runCodex');

      // Parse startedBy argument
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = validateStartedBy(args[++i]);
        }
      }

      const {
        credentials
      } = await authAndSetupMachineIfNeeded();
      await runCodex({credentials, startedBy});
      trackMetric('command_duration', Date.now() - commandStart, { command: 'codex', success: true })
      // Do not force exit here; allow instrumentation to show lingering handles
    } catch (error) {
      trackMetric('command_duration', Date.now() - commandStart, { command: 'codex', success: false })
      logger.errorAndExit('Codex command failed', error)
    }
    return;
  } else if (subcommand === 'gemini') {
    // Handle gemini subcommands
    const geminiSubcommand = args[1];
    
    // Handle "happy gemini model set <model>" command
    if (geminiSubcommand === 'model' && args[2] === 'set' && args[3]) {
      const modelName = args[3];
      const validModels = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
      
      if (!validModels.includes(modelName)) {
        console.error(`Invalid model: ${modelName}`);
        console.error(`Available models: ${validModels.join(', ')}`);
        process.exit(EXIT_CODES.GENERAL_ERROR.code);
      }
      
      try {
        const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
        const { join } = require('path');
        const { homedir } = require('os');
        
        const configDir = join(homedir(), '.gemini');
        const configPath = join(configDir, 'config.json');
        
        // Create directory if it doesn't exist
        if (!existsSync(configDir)) {
          mkdirSync(configDir, { recursive: true });
        }
        
        // Read existing config or create new one
        let config: any = {};
        if (existsSync(configPath)) {
          try {
            config = JSON.parse(readFileSync(configPath, 'utf-8'));
          } catch (error) {
            // Ignore parse errors, start fresh
            config = {};
          }
        }
        
        // Update model in config
        config.model = modelName;
        
        // Write config back
        writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        console.log(`✓ Model set to: ${modelName}`);
        console.log(`  Config saved to: ${configPath}`);
        console.log(`  This model will be used in future sessions.`);
        process.exit(EXIT_CODES.SUCCESS.code);
      } catch (error) {
        console.error('Failed to save model configuration:', error);
        process.exit(EXIT_CODES.GENERAL_ERROR.code);
      }
    }
    
    // Handle "happy gemini model get" command
    if (geminiSubcommand === 'model' && args[2] === 'get') {
      try {
        const { existsSync, readFileSync } = require('fs');
        const { join } = require('path');
        const { homedir } = require('os');
        
        const configPaths = [
          join(homedir(), '.gemini', 'config.json'),
          join(homedir(), '.config', 'gemini', 'config.json'),
        ];
        
        let model: string | null = null;
        for (const configPath of configPaths) {
          if (existsSync(configPath)) {
            try {
              const config = JSON.parse(readFileSync(configPath, 'utf-8'));
              model = config.model || config.GEMINI_MODEL || null;
              if (model) break;
            } catch (error) {
              // Ignore parse errors
            }
          }
        }
        
        if (model) {
          console.log(`Current model: ${model}`);
        } else if (process.env.GEMINI_MODEL) {
          console.log(`Current model: ${process.env.GEMINI_MODEL} (from GEMINI_MODEL env var)`);
        } else {
          console.log('Current model: gemini-2.5-pro (default)');
        }
        process.exit(EXIT_CODES.SUCCESS.code);
      } catch (error) {
        console.error('Failed to read model configuration:', error);
        process.exit(EXIT_CODES.GENERAL_ERROR.code);
      }
    }
    
    // Handle gemini command (ACP-based agent)
    try {
      const { runGemini } = await import('@/gemini/runGemini');
      
      // Parse startedBy argument
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        }
      }
      
      const {
        credentials
      } = await authAndSetupMachineIfNeeded();

      // Auto-start daemon for gemini (same as claude)
      logger.debug('Ensuring Happy background service is running & matches our version...');
      if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
        logger.debug('Starting Happy background service...');
        const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
          detached: true,
          stdio: 'ignore',
          env: process.env
        });
        daemonProcess.unref();
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      await runGemini({credentials, startedBy});
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(EXIT_CODES.GENERAL_ERROR.code)
    }
    return;
  } else if (subcommand === 'logout') {
    // Keep for backward compatibility - redirect to auth logout
    console.log(chalk.yellow('Note: "happy logout" is deprecated. Use "happy auth logout" instead.\n'));
    try {
      await handleAuthCommand(['logout']);
    } catch (error) {
      logger.errorAndExit('Logout command failed', error)
    }
    return;
  } else if (subcommand === 'completion') {
    // Handle completion subcommand for shell autocomplete scripts
    try {
      await handleCompletionCommand(args.slice(1));
    } catch (error) {
      logger.errorAndExit('Completion command failed', error)
    }
    return;
  } else if (subcommand === 'notify') {
    // Handle notification command
    try {
      await handleNotifyCommand(args.slice(1));
    } catch (error) {
      logger.errorAndExit('Notification command failed', error)
    }
    return;
  } else if (subcommand === 'daemon') {
    // Show daemon management help
    const daemonSubcommand = args[1]

    if (daemonSubcommand === 'list') {
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
      return

    } else if (daemonSubcommand === 'stop-session') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error(chalk.red('Error: Session ID required'))
        console.log(chalk.gray('Usage: happy daemon stop-session <session-id>'))
        console.log(chalk.gray('List active sessions with: happy daemon list'))
        process.exit(EXIT_CODES.GENERAL_ERROR.code)
      }

      // Validate UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!uuidRegex.test(sessionId)) {
        console.error(chalk.red(`Error: Invalid session ID format: ${sessionId}`))
        console.log(chalk.gray('Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'))
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
      return

    } else if (daemonSubcommand === 'start') {
      // Spawn detached daemon process
      const child = spawnHappyCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      });
      child.unref();

      // Wait for daemon to write state file (up to 5 seconds)
      let started = false;
      const maxAttempts = 50;
      for (let i = 0; i < maxAttempts; i++) {
        const daemonCheck = await checkIfDaemonRunningAndCleanupStaleState();
        if (daemonCheck.status === 'running') {
          started = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (started) {
        console.log(chalk.green('✓ Daemon started successfully'));
        console.log(chalk.gray('  Check status: happy daemon status'));
      } else {
        console.error(chalk.red('✗ Daemon did not start within 5 seconds'));

        // Try to get logs for debugging
        const latestLog = await getLatestDaemonLog();
        if (latestLog) {
          console.log(chalk.yellow('Check logs for details:'));
          console.log(chalk.gray(`  ${latestLog.path}`));
        }

        // Check if process exists but is slow to initialize
        const state = await readDaemonState();
        if (state?.pid) {
          try {
            process.kill(state.pid, 0);
            console.log(chalk.yellow('Daemon process exists but is taking longer to initialize'));
            console.log(chalk.gray('Wait and check: happy daemon status'));
            process.exit(EXIT_CODES.SUCCESS.code);
          } catch {
            // Process doesn't exist, true failure
          }
        }

        process.exit(EXIT_CODES.GENERAL_ERROR.code);
      }
      process.exit(EXIT_CODES.SUCCESS.code);
    } else if (daemonSubcommand === 'start-sync') {
      await startDaemon()
      process.exit(EXIT_CODES.SUCCESS.code)
    } else if (daemonSubcommand === 'stop') {
      await stopDaemon()
      process.exit(EXIT_CODES.SUCCESS.code)
    } else if (daemonSubcommand === 'status') {
      // Check for --json flag (can appear as args[2] or anywhere in remaining args)
      const useJson = args.slice(2).includes('--json');

      if (useJson) {
        // Machine-readable JSON output with appropriate exit codes
        const { status, exitCode } = await getDaemonStatusJson();
        console.log(JSON.stringify(status, null, 2));
        process.exit(exitCode);
      } else {
        // Human-readable output (existing behavior)
        await runDoctorCommand('daemon');
        process.exit(EXIT_CODES.SUCCESS.code);
      }
    } else if (daemonSubcommand === 'health') {
      // Check for --json flag
      const useJson = args.slice(2).includes('--json');

      const result = await getDaemonHealth();

      if (!result.success) {
        if (useJson) {
          console.log(JSON.stringify({ status: 'error', error: result.error }, null, 2));
        } else {
          console.log(chalk.red('✗ Daemon is not running'));
          console.log(chalk.gray(`  ${result.error}`));
          console.log(chalk.gray('  Start with: happy daemon start'));
        }
        process.exit(EXIT_CODES.GENERAL_ERROR.code);
      }

      const health = result.data;

      if (useJson) {
        console.log(JSON.stringify(health, null, 2));
      } else {
        // Format uptime as human-readable
        const uptimeMs = health.uptime;
        const hours = Math.floor(uptimeMs / 3600000);
        const minutes = Math.floor((uptimeMs % 3600000) / 60000);
        const seconds = Math.floor((uptimeMs % 60000) / 1000);
        const uptimeStr = hours > 0
          ? `${hours}h ${minutes}m ${seconds}s`
          : minutes > 0
            ? `${minutes}m ${seconds}s`
            : `${seconds}s`;

        // Format memory in MB
        const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
        const heapPercent = ((health.memory.heapUsed / health.memory.heapTotal) * 100).toFixed(1);

        // Status with color and symbol
        const statusColor = health.status === 'healthy'
          ? chalk.green
          : health.status === 'degraded'
            ? chalk.yellow
            : chalk.red;
        const statusSymbol = health.status === 'healthy' ? '✓' : health.status === 'degraded' ? '⚠' : '✗';

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
`);
      }

      // Exit codes: SUCCESS for healthy, GENERAL_ERROR for degraded, UNHEALTHY for unhealthy
      const exitCode = health.status === 'healthy'
        ? EXIT_CODES.SUCCESS.code
        : health.status === 'degraded'
          ? EXIT_CODES.GENERAL_ERROR.code
          : EXIT_CODES.UNHEALTHY.code;
      process.exit(exitCode);
    } else if (daemonSubcommand === 'logs') {
      // Simply print the path to the latest daemon log file
      const latest = await getLatestDaemonLog()
      if (!latest) {
        console.log('No daemon logs found')
      } else {
        console.log(latest.path)
      }
      process.exit(EXIT_CODES.SUCCESS.code)
    } else if (daemonSubcommand === 'install') {
      try {
        await install()
      } catch (error) {
        logger.errorAndExit('Daemon install failed', error)
      }
    } else if (daemonSubcommand === 'uninstall') {
      try {
        await uninstall()
      } catch (error) {
        logger.errorAndExit('Daemon uninstall failed', error)
      }
    } else {
      const help = generateCommandHelp('daemon')
      if (help) {
        console.log(help)
      } else {
        console.error(chalk.red('Error: Help text not available for daemon command'))
      }
    }
    return;
  } else {

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
    const {
      credentials
    } = await authAndSetupMachineIfNeeded();

    // Show telemetry opt-in notice once (non-blocking, informational only)
    await showTelemetryNoticeIfNeeded()

    // Always auto-start daemon for simplicity
    logger.debug('Ensuring Happy background service is running & matches our version...');

    if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
      logger.debug('Starting Happy background service...');

      // Use the built binary to spawn daemon
      const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
      daemonProcess.unref();

      // Give daemon a moment to write PID & port file
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Start the CLI with session tracking (HAP-522)
    setTag('cli.mode', 'interactive')
    addBreadcrumb({ category: 'session', message: 'Starting Claude session', level: 'info' })
    try {
      await runClaude(credentials, options);
      // Ensure telemetry is flushed before exit
      await shutdownTelemetry()
    } catch (error) {
      await shutdownTelemetry()
      logger.errorAndExit('Claude session failed', error)
    }
  }
})();


/**
 * Handle notification command
 */
async function handleNotifyCommand(args: string[]): Promise<void> {
  let message = ''
  let title = ''
  let showHelp = false

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-p' && i + 1 < args.length) {
      message = args[++i]
    } else if (arg === '-t' && i + 1 < args.length) {
      title = args[++i]
    } else if (arg === '-h' || arg === '--help') {
      showHelp = true
    } else {
      console.error(chalk.red(`Unknown argument for notify command: ${arg}`))
      process.exit(EXIT_CODES.GENERAL_ERROR.code)
    }
  }

  if (showHelp) {
    const help = generateCommandHelp('notify')
    if (help) {
      console.log(help)
    } else {
      console.error(chalk.red('Error: Help text not available for notify command'))
    }
    return
  }

  if (!message) {
    console.error(chalk.red('Error: Message is required. Use -p "your message" to specify the notification text.'))
    console.log(chalk.gray('Run "happy notify --help" for usage information.'))
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }

  // Load credentials
  let credentials = await readCredentials()
  if (!credentials) {
    console.error(chalk.red('Error: Not authenticated. Please run "happy auth login" first.'))
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }

  console.log(chalk.blue('📱 Sending push notification...'))

  try {
    // Create API client and send push notification
    const api = await ApiClient.create(credentials);

    // Use custom title or default to "Happy"
    const notificationTitle = title || 'Happy'

    // Send the push notification and await completion
    await api.push().sendToAllDevices(
      notificationTitle,
      message,
      {
        source: 'cli',
        timestamp: Date.now()
      }
    )

    console.log(chalk.green('✓ Push notification sent successfully!'))
    console.log(chalk.gray(`  Title: ${notificationTitle}`))
    console.log(chalk.gray(`  Message: ${message}`))
    console.log(chalk.gray('  Check your mobile device for the notification.'))

  } catch (error) {
    console.error(chalk.red('✗ Failed to send push notification'))
    throw error
  }
}
