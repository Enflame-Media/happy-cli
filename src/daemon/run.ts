import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate, getCaffeinatePid } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState, acquireDaemonLock } from '@/persistence';
import { withRetry } from '@/utils/retry';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { readFileSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { validateHeartbeatInterval } from '@/utils/validators';
import { createDefaultMemoryMonitor, MemoryMonitorHandle } from './memoryMonitor';
import { clearGlobalDeduplicator } from '@/utils/requestDeduplication';

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

        process.exit(1);
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
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    console.log('Another daemon instance is already running (lock file held)');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
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

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[DAEMON RUN] Spawning session', options);

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
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

            // Write the token to the temporary directory
            await withRetry(() => fs.writeFile(join(codexTempDir!.name, 'auth.json'), token));

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
        const args = [
          options.agent === 'claude' ? 'claude' : 'codex',
          '--happy-starting-mode', 'remote',
          '--started-by', 'daemon'
        ];

        // TODO: In future, sessionId could be used with --resume to continue existing sessions
        // For now, we ignore it - each spawn creates a new session
        const happyProcess = spawnHappyCLI(args, {
          cwd: directory,
          detached: true,  // Sessions stay alive when daemon stops
          stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
          env: {
            ...process.env,
            ...extraEnv
          }
        });

        // Log output for debugging
        if (process.env.DEBUG) {
          happyProcess.stdout?.on('data', (data) => {
            logger.debug(`[DAEMON RUN] Child stdout: ${data.toString()}`);
          });
          happyProcess.stderr?.on('data', (data) => {
            logger.debug(`[DAEMON RUN] Child stderr: ${data.toString()}`);
          });
        }

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

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook,
      authToken: daemonAuthToken
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath,
      caffeinatePid: getCaffeinatePid()
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
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

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      stopSession,
      requestShutdown: () => requestShutdown('happy-app')
    });

    // Connect to server
    apiMachine.connect();

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = validateHeartbeatInterval(
      process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL,
      'HAPPY_DAEMON_HEARTBEAT_INTERVAL',
      { defaultValue: 60_000, min: 1000, max: 3600_000 }
    );
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, session] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Process is dead, clean up resources and remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);

          // Clean up Codex temp directory if it exists
          if (session.codexTempDir) {
            try {
              session.codexTempDir.removeCallback();
              logger.debug(`[DAEMON RUN] Cleaned up Codex temp directory for stale session PID ${pid}`);
            } catch (cleanupError) {
              logger.debug(`[DAEMON RUN] Failed to cleanup Codex temp dir for stale PID ${pid}:`, cleanupError);
            }
          }

          pidToTrackedSession.delete(pid);
        }
      }

      // Check if daemon needs update
      // If version on disk is different from the one in package.json - we need to restart
      // BIG if - does this get updated from underneath us on npm upgrade?
      const projectVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;
      if (projectVersion !== configuration.currentCliVersion) {
        logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version, clearing heartbeat interval');

        clearInterval(restartOnStaleVersionAndHeartbeat);

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
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        // So we can just hang forever
        logger.debug('[DAEMON RUN] Hanging for a bit - waiting for CLI to kill us because we are running outdated version of the code');
        await new Promise(resolve => setTimeout(resolve, 10_000));
        process.exit(0);
      }

      // Don't check state file PID - lock file is the authority (HAP-51)
      // If we hold the lock, we own the daemon state
      // State file is just informational for CLI tools
      // The previous check-then-act pattern was a TOCTOU race condition
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath,
          caffeinatePid: getCaffeinatePid()
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        // If we can't write state, something is very wrong
        logger.debug('[DAEMON RUN] Failed to write heartbeat - shutting down', error);
        requestShutdown('exception', 'Lost ability to write daemon state');
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

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
    });

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

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

      // Don't release lock manually - let OS clean it up on process.exit()
      // This prevents a race window where another daemon could acquire the lock
      // while this process is still running between releaseDaemonLock() and process.exit()
      // The lock file will remain with our PID; new daemons will detect the stale lock
      // (dead PID) and clean it up atomically before acquiring their own lock.
      logger.debug('[DAEMON RUN] Cleanup completed, exiting process (lock released by OS on exit)');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
