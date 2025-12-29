import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';

import { ApiClient } from '@/api/api';
import { EXIT_CODES } from '@/commands/registry';
import type { ApiMachineClient } from '@/api/apiMachine';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate, getCaffeinatePid } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { killOrphanedCaffeinate, cleanupOrphanedCodexTempDirs } from './doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState, acquireDaemonLock } from '@/persistence';
import { withRetry } from '@/utils/retry';
import { AppError, ErrorCodes } from '@/utils/errors';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { buildMcpSyncState } from '@/mcp/config';
import { readFileSync, watch, type FSWatcher } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { validateHeartbeatInterval } from '@/utils/validators';
import { createDefaultMemoryMonitor, MemoryMonitorHandle } from './memoryMonitor';
import { clearGlobalDeduplicator } from '@/utils/requestDeduplication';
import { addBreadcrumb, setTag, trackMetric, shutdownTelemetry } from '@/telemetry';
import { isValidSessionId, normalizeSessionId } from '@/claude/utils/sessionValidation';

// Version cache for package.json (HAP-354)
// Eliminates repetitive disk I/O during heartbeat checks
let cachedProjectVersion: string | null = null;
let packageJsonWatcher: FSWatcher | null = null;

/**
 * Gets the project version from package.json with caching and file watching.
 * On first call, reads the version and sets up a file watcher for changes.
 * Subsequent calls return the cached value until the file changes.
 *
 * @returns The current package.json version string
 */
function getProjectVersion(): string {
  if (cachedProjectVersion === null) {
    const packageJsonPath = join(projectPath(), 'package.json');

    // Initial read
    const version = JSON.parse(readFileSync(packageJsonPath, 'utf-8')).version as string;
    cachedProjectVersion = version;
    logger.debug(`[DAEMON RUN] Cached project version: ${cachedProjectVersion}`);

    // Watch for changes (npm upgrade scenario)
    packageJsonWatcher = watch(packageJsonPath, (eventType) => {
      if (eventType === 'change') {
        logger.debug('[DAEMON RUN] package.json changed, refreshing version cache');
        try {
          const newVersion = JSON.parse(readFileSync(packageJsonPath, 'utf-8')).version as string;
          cachedProjectVersion = newVersion;
          logger.debug(`[DAEMON RUN] Updated cached version: ${cachedProjectVersion}`);
        } catch (error) {
          // Keep existing cached value on error (corrupted JSON, file deleted)
          logger.debug('[DAEMON RUN] Failed to refresh version cache:', error);
        }
      }
    });
  }

  // At this point cachedProjectVersion is guaranteed to be non-null
  // (either set above or in a previous call)
  return cachedProjectVersion!;
}

/**
 * Cleans up the package.json file watcher.
 * Should be called during daemon shutdown.
 */
function cleanupVersionWatcher(): void {
  if (packageJsonWatcher) {
    packageJsonWatcher.close();
    packageJsonWatcher = null;
    logger.debug('[DAEMON RUN] Version watcher closed');
  }
}

// HAP-610: MCP config hash tracking for change detection during heartbeat
// Tracks the last synced MCP config hash to avoid unnecessary network traffic
let lastMcpConfigHash: string | null = null;

/**
 * Recursively sorts object keys for stable JSON serialization.
 * Handles nested objects and arrays.
 */
function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Computes a stable hash of the MCP sync state for change detection.
 * Uses a simple string hash algorithm (fast, no crypto overhead needed).
 *
 * @param mcpConfig - The MCP sync state to hash
 * @returns Hash string in hex format, or null if no config exists
 *
 * @example
 * ```typescript
 * const hash = computeMcpConfigHash(buildMcpSyncState());
 * if (hash !== lastMcpConfigHash) {
 *     // Config changed, sync to server
 * }
 * ```
 */
export function computeMcpConfigHash(mcpConfig: ReturnType<typeof buildMcpSyncState>): string | null {
  if (!mcpConfig) return null;

  // Recursively sort all object keys for stable serialization
  // This ensures the same config always produces the same hash regardless of key order
  const stable = JSON.stringify(sortObjectKeys(mcpConfig));

  // Simple hash using string hashCode algorithm (fast, no crypto needed)
  // djb2 variant - good distribution, fast computation
  let hash = 5381;
  for (let i = 0; i < stable.length; i++) {
    const char = stable.charCodeAt(i);
    hash = ((hash << 5) + hash) ^ char; // hash * 33 ^ char
  }

  // Convert to unsigned 32-bit and return as hex
  return (hash >>> 0).toString(16);
}

// Prepare initial metadata
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname(),
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath()
};

export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(EXIT_CODES.GENERAL_ERROR.code);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    // Report any logger write errors that occurred during daemon operation
    // Note: In detached daemon mode, this output may not be visible to users
    // but it serves as a best-effort report and helps when debugging
    logger.reportWriteErrorsIfAny();
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');

  // Tag telemetry for daemon mode (HAP-522)
  setTag('cli.mode', 'daemon')
  addBreadcrumb({ category: 'daemon', message: 'Daemon starting', level: 'info' })

  // Ensure configuration directories exist before any file operations
  configuration.ensureSetup();

  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(EXIT_CODES.SUCCESS.code);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    console.log('Another daemon instance is already running (lock file held)');
    process.exit(EXIT_CODES.SUCCESS.code);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Clean up orphaned caffeinate from previous crash (HAP-184)
    // This handles cases where daemon was killed with SIGKILL or system crashed
    const orphanResult = await killOrphanedCaffeinate();
    if (orphanResult.killed) {
      logger.debug('[DAEMON RUN] Cleaned up orphaned caffeinate from previous crash');
    }

    // Clean up orphaned Codex temp directories from previous crash (HAP-225)
    // These directories may contain auth.json with OAuth tokens
    const tempDirCleanupResult = await cleanupOrphanedCodexTempDirs();
    if (tempDirCleanupResult.cleaned > 0) {
      logger.debug(`[DAEMON RUN] Cleaned up ${tempDirCleanupResult.cleaned} orphaned Codex temp directories from previous crash`);
    }
    if (tempDirCleanupResult.errors.length > 0) {
      logger.debug(`[DAEMON RUN] Errors cleaning up orphaned Codex temp dirs: ${tempDirCleanupResult.errors.join(', ')}`);
    }

    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Get current Codex temp directory paths for daemon state persistence (HAP-225)
    // This enables cleanup of orphaned temp dirs if daemon crashes
    const getCodexTempDirPaths = (): string[] => {
      const paths: string[] = [];
      for (const session of pidToTrackedSession.values()) {
        if (session.codexTempDir?.name) {
          paths.push(session.codexTempDir.name);
        }
      }
      return paths;
    };

    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);

      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        // Note: When using --resume, this happySessionId will be the NEW forked session ID,
        // not the original sessionId passed to --resume (Claude creates a new session when forking)
        existingSession.happySessionId = sessionId;
        existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }
    };

    // Spawn a new session (sessionId enables --resume for continuing existing Claude sessions)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[DAEMON RUN] Spawning session', options);

      const { directory, machineId: _machineId, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch {
        logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

        try {
          await withRetry(() => fs.mkdir(directory, { recursive: true }));
          logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
          directoryCreated = true;
        } catch (mkdirError: any) {
          let errorMessage = `Unable to create directory at '${directory}'. `;

          // Provide more helpful error messages based on the error code
          if (mkdirError.code === 'EACCES') {
            errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
          } else if (mkdirError.code === 'ENOTDIR') {
            errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
          } else if (mkdirError.code === 'ENOSPC') {
            errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
          } else if (mkdirError.code === 'EROFS') {
            errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
          } else {
            errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
          }

          logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }
      }

      try {

        // Resolve authentication token if provided
        let extraEnv: Record<string, string> = {};
        let codexTempDir: tmp.DirResult | undefined;
        if (options.token) {
          const token = options.token; // Assign to local variable for readability
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex with cleanup callback
            // unsafeCleanup: true allows removing non-empty directories
            codexTempDir = tmp.dirSync({ unsafeCleanup: true });

            // Write the OAuth token to the temporary directory with secure permissions
            // Security: mode 0o600 restricts file to owner-only read/write (no group/other access)
            // This prevents other processes on the system from reading the sensitive token
            await withRetry(() => fs.writeFile(join(codexTempDir!.name, 'auth.json'), token, { mode: 0o600 }));

            // Set the environment variable for Codex
            extraEnv = {
              CODEX_HOME: codexTempDir.name
            };
          } else { // Assuming claude
            extraEnv = {
              CLAUDE_CODE_OAUTH_TOKEN: token
            };
          }
        }

        // Construct arguments for the CLI
        let agentCommand: string;
        switch (options.agent) {
          case 'claude':
          case undefined:
            agentCommand = 'claude';
            break;
          case 'codex':
            agentCommand = 'codex';
            break;
          case 'gemini':
            agentCommand = 'gemini';
            break;
          default:
            return {
              type: 'error',
              errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
            };
        }
        const args = [
          agentCommand,
          '--happy-starting-mode', 'remote',
          '--started-by', 'daemon'
        ];

        // Add --resume flag to continue an existing session (Claude only - Codex doesn't support this)
        // When sessionId is provided, Claude will fork the session, creating a new session ID
        // with the full conversation history from the original session
        if (options.sessionId) {
          if (options.agent === 'codex') {
            logger.debug(`[DAEMON RUN] Ignoring sessionId for Codex (resume not supported)`);
          } else {
            // Validate session ID format (accepts both UUID and hex formats)
            // Claude Code uses hex format (32 chars), Happy uses UUID format (36 chars with hyphens)
            if (!isValidSessionId(options.sessionId)) {
              logger.debug(`[DAEMON RUN] Invalid sessionId format: ${options.sessionId}`);
              return {
                type: 'error',
                errorMessage: `Invalid session ID format. Expected UUID (36 chars) or hex (32 chars), got: ${options.sessionId}`
              };
            }

            // Normalize to UUID format for Claude's --resume flag
            const normalizedSessionId = normalizeSessionId(options.sessionId);
            args.push('--resume', normalizedSessionId);
            logger.debug(`[DAEMON RUN] Resuming session with --resume ${normalizedSessionId}${normalizedSessionId !== options.sessionId ? ` (normalized from ${options.sessionId})` : ''}`);
          }
        }

        const happyProcess = spawnHappyCLI(args, {
          cwd: directory,
          detached: true,  // Sessions stay alive when daemon stops
          stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
          env: {
            ...process.env,
            ...extraEnv
          }
        });

        // Log child process output to file for debugging
        happyProcess.stdout?.on('data', (data) => {
          logger.debug(`[DAEMON RUN] Child stdout: ${data.toString()}`);
        });
        happyProcess.stderr?.on('data', (data) => {
          logger.debug(`[DAEMON RUN] Child stderr: ${data.toString()}`);
        });

        if (!happyProcess.pid) {
          logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
          return {
            type: 'error',
            errorMessage: 'Failed to spawn Happy process - no PID returned'
          };
        }

        logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);

        const trackedSession: TrackedSession = {
          startedBy: 'daemon',
          pid: happyProcess.pid,
          childProcess: happyProcess,
          directoryCreated,
          message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
          codexTempDir
        };

        pidToTrackedSession.set(happyProcess.pid, trackedSession);

        happyProcess.on('exit', (code, signal) => {
          logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
          if (happyProcess.pid) {
            onChildExited(happyProcess.pid);
          }
        });

        happyProcess.on('error', (error) => {
          logger.debug(`[DAEMON RUN] Child process error:`, error);
          if (happyProcess.pid) {
            onChildExited(happyProcess.pid);
          }
        });

        // Wait for webhook to populate session with happySessionId
        logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);

        return new Promise((resolve) => {
          // Set timeout for webhook - configurable via env var, default 30s
          // Slow systems may need more time for cold start + auth + network
          const timeoutMs = parseInt(process.env.HAPPY_SESSION_SPAWN_TIMEOUT || '30000', 10);
          const effectiveTimeout = Number.isNaN(timeoutMs) || timeoutMs < 1000 ? 30000 : timeoutMs;

          const timeout = setTimeout(() => {
            pidToAwaiter.delete(happyProcess.pid!);
            logger.debug(`[DAEMON RUN] Session spawn timeout after ${effectiveTimeout}ms for PID ${happyProcess.pid}`);

            // Graceful handling: return success with PID-based session ID
            // The session may still complete - this prevents false "timeout" errors
            resolve({
              type: 'success',
              sessionId: `PID-${happyProcess.pid}`,
              message: 'Session starting slowly. Check daemon logs for status.'
            });
          }, effectiveTimeout);

          // Register awaiter
          pidToAwaiter.set(happyProcess.pid!, (completedSession) => {
            clearTimeout(timeout);
            logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
            resolve({
              type: 'success',
              sessionId: completedSession.happySessionId!
            });
          });
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          if (session.startedBy === 'daemon' && session.childProcess) {
            try {
              session.childProcess.kill('SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${sessionId}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              process.kill(pid, 'SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
            }
          }

          // Clean up Codex temp directory before removing from tracking
          // (onChildExited may not fire if we delete from map first)
          if (session.codexTempDir) {
            try {
              session.codexTempDir.removeCallback();
              logger.debug(`[DAEMON RUN] Cleaned up Codex temp directory for stopped session ${sessionId}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to cleanup Codex temp dir for session ${sessionId}:`, error);
            }
          }

          pidToTrackedSession.delete(pid);
          logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          return true;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Handle child process exit
    const onChildExited = (pid: number) => {
      logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);

      // Clean up Codex temp directory if it exists (contains auth.json with sensitive token)
      const session = pidToTrackedSession.get(pid);
      if (session?.codexTempDir) {
        try {
          session.codexTempDir.removeCallback();
          logger.debug(`[DAEMON RUN] Cleaned up Codex temp directory for PID ${pid}`);
        } catch (error) {
          logger.debug(`[DAEMON RUN] Failed to cleanup Codex temp dir for PID ${pid}:`, error);
        }
      }

      pidToTrackedSession.delete(pid);
    };

    // Generate and write auth token for control server authentication
    const daemonAuthToken = randomBytes(32).toString('hex');
    await fs.writeFile(configuration.daemonAuthTokenFile, daemonAuthToken, { mode: 0o600 });
    logger.debug('[DAEMON RUN] Auth token generated and written to file with restricted permissions');

    // Record daemon start time for health endpoint uptime calculation
    const daemonStartTime = Date.now();

    // HAP-362: Late-binding reference for WebSocket metrics
    // This allows the health endpoint to access metrics after apiMachine is initialized
    let apiMachineRef: ApiMachineClient | null = null;
    const getWebSocketMetrics = () => apiMachineRef?.getSocketMetrics() ?? null;

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook,
      authToken: daemonAuthToken,
      startTime: daemonStartTime,
      getWebSocketMetrics
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath,
      caffeinatePid: getCaffeinatePid(),
      codexTempDirs: [] // Empty initially, populated during heartbeat when sessions are active
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Prepare initial daemon state (including MCP config if available)
    // @see HAP-608 - CLI Sync: Include MCP Config in daemonState
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now(),
      mcpConfig: buildMcpSyncState()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Get or create machine
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: initialMachineMetadata,
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // HAP-610: Initialize MCP config hash after first sync
    // This establishes the baseline for change detection during heartbeat
    lastMcpConfigHash = computeMcpConfigHash(initialDaemonState.mcpConfig);
    logger.debug(`[DAEMON RUN] Initial MCP config hash: ${lastMcpConfigHash ?? 'null (no config)'}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);
    apiMachineRef = apiMachine; // HAP-362: Set late-binding ref for health endpoint metrics

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      stopSession,
      requestShutdown: () => requestShutdown('happy-app')
    });

    // Connect to server
    apiMachine.connect();

    // Heartbeat scheduling using setTimeout to prevent overlapping executions (HAP-70)
    // Using setTimeout instead of setInterval ensures next heartbeat only schedules
    // after current completes, preventing state corruption if heartbeat takes >60s.
    //
    // Every heartbeat:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat state
    const heartbeatIntervalMs = validateHeartbeatInterval(
      process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL,
      'HAPPY_DAEMON_HEARTBEAT_INTERVAL',
      { defaultValue: 60_000, min: 1000, max: 3600_000 }
    );

    // Track timeout handle for cleanup, and guard as defense-in-depth
    let heartbeatTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let heartbeatRunning = false;

    // Run a single heartbeat iteration
    const runHeartbeat = async (): Promise<boolean> => {
      // Guard prevents concurrent execution (defense-in-depth, should not happen with setTimeout)
      if (heartbeatRunning) {
        logger.debug('[DAEMON RUN] Previous heartbeat still running, skipping');
        return true; // Continue scheduling
      }
      heartbeatRunning = true;

      try {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);

        // Prune stale sessions - use centralized cleanup to ensure temp directories are cleaned
        for (const [pid, _] of pidToTrackedSession.entries()) {
          try {
            // Check if process is still alive (signal 0 doesn't kill, just checks)
            process.kill(pid, 0);
          } catch {
            // Process is dead - use centralized cleanup which handles temp directories
            logger.debug(`[DAEMON RUN] Removing stale session PID ${pid}`);
            onChildExited(pid);
          }
        }

        // Check if daemon needs update
        // If version on disk is different from the one in package.json - we need to restart
        // Uses cached version with file watcher for efficient I/O (HAP-354)
        const projectVersion = getProjectVersion();
        if (projectVersion !== configuration.currentCliVersion) {
          logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version');

          // Clear the timeout handle to prevent any further heartbeats
          if (heartbeatTimeoutHandle) {
            clearTimeout(heartbeatTimeoutHandle);
            heartbeatTimeoutHandle = null;
          }

          // Spawn new daemon through the CLI
          // We do not need to clean ourselves up - we will be killed by
          // the CLI start command.
          // 1. It will first check if daemon is running (yes in this case)
          // 2. If the version is stale (it will read daemon.state.json file and check startedWithCliVersion) & compare it to its own version
          // 3. Next it will start a new daemon with the latest version with daemon-sync :D
          // Done!
          try {
            spawnHappyCLI(['daemon', 'start'], {
              detached: true,
              stdio: 'ignore'
            });
          } catch (error) {
            logger.debug('[DAEMON RUN] Failed to spawn new daemon during version update', error);

            // If the binary is missing (npm uninstall scenario), shut down gracefully
            // instead of hanging and exiting abruptly. This ensures the daemon state file
            // is properly cleaned up and the API is notified of the shutdown.
            if (AppError.isAppError(error) && error.code === ErrorCodes.RESOURCE_NOT_FOUND) {
              logger.debug('[DAEMON RUN] Binary missing - installation appears uninstalled. Initiating graceful shutdown.');
              requestShutdown('exception', 'Installation uninstalled - binary missing');
              return false; // Stop heartbeat scheduling
            }

            // For other spawn errors, continue with the original behavior
            logger.debug('[DAEMON RUN] Spawn failed but not due to missing binary, continuing with hang behavior');
          }

          // So we can just hang forever - waiting for the new daemon to kill us
          logger.debug('[DAEMON RUN] Hanging for a bit - waiting for CLI to kill us because we are running outdated version of the code');
          await new Promise(resolve => setTimeout(resolve, 10_000));
          process.exit(EXIT_CODES.SUCCESS.code);
        }

        // Don't check state file PID - lock file is the authority (HAP-51)
        // If we hold the lock, we own the daemon state
        // State file is just informational for CLI tools
        // The previous check-then-act pattern was a TOCTOU race condition
        try {
          // HAP-362: Log WebSocket metrics during heartbeat for observability
          const socketMetrics = apiMachine.getSocketMetrics();
          if (socketMetrics) {
            logger.debug(`[DAEMON RUN] WebSocket metrics: handlers=${socketMetrics.totalHandlers}, events=${socketMetrics.eventTypes}, pendingAcks=${socketMetrics.pendingAcks}, memoryPressure=${socketMetrics.memoryPressureCount}, acksCleanedTotal=${socketMetrics.acksCleanedTotal}, handlersRejectedTotal=${socketMetrics.handlersRejectedTotal}`);
          }

          // HAP-610: Periodic MCP config sync
          // Check if MCP config has changed since last sync
          if (!process.env.HAPPY_DAEMON_MCP_SYNC_DISABLED) {
            try {
              const currentMcpConfig = buildMcpSyncState();
              const currentHash = computeMcpConfigHash(currentMcpConfig);

              if (currentHash !== lastMcpConfigHash) {
                logger.debug(`[DAEMON RUN] MCP config changed (${lastMcpConfigHash ?? 'null'} -> ${currentHash ?? 'null'}), syncing to server`);

                await apiMachine.updateDaemonState((state) => ({
                  ...state,
                  // Preserve existing status or default to 'running' if state is null
                  status: state?.status ?? 'running',
                  mcpConfig: currentMcpConfig
                }));

                lastMcpConfigHash = currentHash;
                logger.debug('[DAEMON RUN] MCP config sync complete');
              }
            } catch (error) {
              // Log but don't fail heartbeat for MCP sync errors
              logger.debug('[DAEMON RUN] MCP config sync failed (non-fatal)', error);
            }
          }

          const updatedState: DaemonLocallyPersistedState = {
            pid: process.pid,
            httpPort: controlPort,
            startTime: fileState.startTime,
            startedWithCliVersion: packageJson.version,
            lastHeartbeat: new Date().toLocaleString(),
            daemonLogPath: fileState.daemonLogPath,
            caffeinatePid: getCaffeinatePid(),
            codexTempDirs: getCodexTempDirPaths() // Track temp dirs for orphan cleanup on crash (HAP-225)
          };
          writeDaemonState(updatedState);
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        } catch (error) {
          // If we can't write state, something is very wrong
          logger.debug('[DAEMON RUN] Failed to write heartbeat - shutting down', error);
          requestShutdown('exception', 'Lost ability to write daemon state');
          return false; // Stop scheduling
        }

        return true; // Continue scheduling
      } finally {
        heartbeatRunning = false;
      }
    };

    // Schedule the next heartbeat after current completes (prevents overlapping)
    const scheduleNextHeartbeat = () => {
      heartbeatTimeoutHandle = setTimeout(async () => {
        const shouldContinue = await runHeartbeat();
        if (shouldContinue) {
          scheduleNextHeartbeat();
        }
      }, heartbeatIntervalMs);
    };

    // Start the heartbeat cycle
    scheduleNextHeartbeat();

    // Start memory pressure monitoring
    // Monitors heap usage and triggers cleanup when threshold exceeded
    const memoryMonitor: MemoryMonitorHandle = createDefaultMemoryMonitor(() => {
      // Clear non-essential caches under memory pressure
      logger.debug('[DAEMON RUN] Memory pressure: clearing caches');

      // Clear global request deduplication cache
      clearGlobalDeduplicator();

      // Clear stale session awaiters (shouldn't have many, but safety cleanup)
      for (const [pid] of pidToAwaiter.entries()) {
        try {
          process.kill(pid, 0);
        } catch {
          // Process is dead, remove stale awaiter
          pidToAwaiter.delete(pid);
        }
      }

      // Clean up WebSocket handlers and stale acks (HAP-353)
      apiMachine.onMemoryPressure();
    });

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Track daemon uptime and session count before shutdown (HAP-522)
      const daemonUptime = Date.now() - daemonStartTime
      const sessionsHandled = pidToTrackedSession.size
      trackMetric('command_duration', daemonUptime, {
        command: 'daemon',
        success: source !== 'exception',
        shutdownSource: source,
        sessionsHandled
      })
      addBreadcrumb({ category: 'daemon', message: `Daemon shutting down: ${source}`, level: 'info' })

      // Clear heartbeat timeout (HAP-70: using setTimeout instead of setInterval)
      if (heartbeatTimeoutHandle) {
        clearTimeout(heartbeatTimeoutHandle);
        heartbeatTimeoutHandle = null;
        logger.debug('[DAEMON RUN] Health check timeout cleared');
      }

      // Close version watcher (HAP-354: cached package.json version)
      cleanupVersionWatcher();

      // Stop memory monitor
      memoryMonitor.stop();

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();

      // Remove auth token file
      try {
        await fs.unlink(configuration.daemonAuthTokenFile);
        logger.debug('[DAEMON RUN] Auth token file removed');
      } catch {
        // Ignore if file doesn't exist
      }

      // Flush telemetry before exit (HAP-522)
      await shutdownTelemetry()

      // Don't release lock manually - let OS clean it up on process.exit()
      // This prevents a race window where another daemon could acquire the lock
      // while this process is still running between releaseDaemonLock() and process.exit()
      // The lock file will remain with our PID; new daemons will detect the stale lock
      // (dead PID) and clean it up atomically before acquiring their own lock.
      logger.debug('[DAEMON RUN] Cleanup completed, exiting process (lock released by OS on exit)');
      process.exit(EXIT_CODES.SUCCESS.code);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(EXIT_CODES.GENERAL_ERROR.code);
  }
}
