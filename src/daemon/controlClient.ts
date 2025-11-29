/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { projectPath } from '@/projectPath';
import { readFileSync } from 'fs';
import { join } from 'path';
import { configuration } from '@/configuration';
import { validateTimeout } from '@/utils/validators';

/**
 * Result envelope type for daemon communication.
 * Provides consistent, type-safe error handling across all daemon HTTP calls.
 *
 * Use discriminated union to force callers to check success before accessing data:
 * ```typescript
 * const result = await daemonPost<MyData>('/endpoint');
 * if (!result.success) {
 *   console.error(result.error);
 *   return;
 * }
 * // TypeScript knows result.data is MyData here
 * ```
 */
export type DaemonResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Response type for /list endpoint
 */
export interface ListSessionsResponse {
  children: Array<{
    startedBy: string;
    happySessionId: string;
    pid: number;
  }>;
}

/**
 * Response type for /stop-session endpoint
 */
export interface StopSessionResponse {
  success: boolean;
}

/**
 * Response type for /spawn-session endpoint (success case)
 */
export interface SpawnSessionResponse {
  success: boolean;
  sessionId?: string;
  approvedNewDirectoryCreation?: boolean;
  // Error fields for non-200 responses
  requiresUserApproval?: boolean;
  actionRequired?: string;
  directory?: string;
  error?: string;
}

/**
 * Response type for /session-started endpoint
 */
export interface SessionStartedResponse {
  status: 'ok';
}

/**
 * Response type for /stop endpoint
 */
export interface StopDaemonResponse {
  status: string;
}

/**
 * Read daemon auth token from file
 * Returns null if file doesn't exist or can't be read
 */
function readDaemonAuthToken(): string | null {
  try {
    return readFileSync(configuration.daemonAuthTokenFile, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Make a POST request to the daemon HTTP server.
 * Always returns a consistent DaemonResponse envelope for type safety.
 */
async function daemonPost<T>(path: string, body?: unknown): Promise<DaemonResponse<T>> {
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return { success: false, error: errorMessage };
  }

  try {
    process.kill(state.pid, 0);
  } catch {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return { success: false, error: errorMessage };
  }

  const authToken = readDaemonAuthToken();
  if (!authToken) {
    const errorMessage = 'No daemon auth token found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return { success: false, error: errorMessage };
  }

  try {
    const timeout = validateTimeout(
      process.env.HAPPY_DAEMON_HTTP_TIMEOUT,
      'HAPPY_DAEMON_HTTP_TIMEOUT',
      { defaultValue: 10_000, min: 100, max: 300_000 }
    );
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Daemon-Auth': authToken
      },
      body: JSON.stringify(body ?? {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });

    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return { success: false, error: errorMessage };
    }

    const data = await response.json() as T;
    return { success: true, data };
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

/**
 * Notify daemon that a session has started.
 * Called by CLI sessions to register themselves with the daemon.
 */
export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata
): Promise<DaemonResponse<SessionStartedResponse>> {
  return daemonPost<SessionStartedResponse>('/session-started', {
    sessionId,
    metadata
  });
}

/**
 * List all sessions tracked by the daemon.
 * Returns the full DaemonResponse envelope for proper error handling.
 */
export async function listDaemonSessions(): Promise<DaemonResponse<ListSessionsResponse>> {
  return daemonPost<ListSessionsResponse>('/list');
}

/**
 * Stop a specific session by its happy session ID.
 * Returns the full DaemonResponse envelope for proper error handling.
 */
export async function stopDaemonSession(sessionId: string): Promise<DaemonResponse<StopSessionResponse>> {
  return daemonPost<StopSessionResponse>('/stop-session', { sessionId });
}

/**
 * Spawn a new session in the specified directory.
 * Returns the full DaemonResponse envelope for proper error handling.
 */
export async function spawnDaemonSession(
  directory: string,
  sessionId?: string
): Promise<DaemonResponse<SpawnSessionResponse>> {
  return daemonPost<SpawnSessionResponse>('/spawn-session', { directory, sessionId });
}

/**
 * Request the daemon to stop via HTTP.
 * Returns the full DaemonResponse envelope for proper error handling.
 */
export async function stopDaemonHttp(): Promise<DaemonResponse<StopDaemonResponse>> {
  return daemonPost<StopDaemonResponse>('/stop');
}

/**
 * The version check is still quite naive.
 * For instance we are not handling the case where we upgraded happy,
 * the daemon is still running, and it recieves a new message to spawn a new session.
 * This is a tough case - we need to somehow figure out to restart ourselves,
 * yet still handle the original request.
 * 
 * Options:
 * 1. Periodically check during the health checks whether our version is the same as CLIs version. If not - restart.
 * 2. Wait for a command from the machine session, or any other signal to
 * check for version & restart.
 *   a. Handle the request first
 *   b. Let the request fail, restart and rely on the client retrying the request
 * 
 * I like option 1 a little better.
 * Maybe we can ... wait for it ... have another daemon to make sure 
 * our daemon is always alive and running the latest version.
 * 
 * That seems like an overkill and yet another process to manage - lets not do this :D
 * 
 * TODO: This function should return a state object with
 * clear state - if it is running / or errored out or something else.
 * Not just a boolean.
 * 
 * We can destructure the response on the caller for richer output.
 * For instance when running `happy daemon status` we can show more information.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) {
    return false;
  }

  // Check if the daemon is running
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
    await cleanupDaemonState();
    return false;
  }
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledHappyVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon state found, returning false');
    return false;
  }
  
  try {
    // Read package.json on demand from disk - so we are guaranteed to get the latest version
    const packageJsonPath = join(projectPath(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const currentCliVersion = packageJson.version;
    
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`);
    return currentCliVersion === state.startedWithCliVersion;
    
    // PREVIOUS IMPLEMENTATION - Keeping this commented in case we need it
    // Kirill does not understand how the upgrade of npm packages happen and whether 
    // we will get a new path or not when happy-coder is upgraded globally.
    // If reading package.json doesn't work correctly after npm upgrades, 
    // we can revert to spawning a process (but should add timeout and cleanup!)
    /*
    const { spawnHappyCLI } = await import('@/utils/spawnHappyCLI');
    const happyProcess = spawnHappyCLI(['--version'], { stdio: 'pipe' });
    let version: string | null = null;
    happyProcess.stdout?.on('data', (data) => {
      version = data.toString().trim();
    });
    await new Promise(resolve => happyProcess.stdout?.on('close', resolve));
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${version}, Daemon started with version: ${state.startedWithCliVersion}`);
    return version === state.startedWithCliVersion;
    */
  } catch (error) {
    logger.debug('[DAEMON CONTROL] Error checking daemon version', error);
    return false;
  }
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    logger.debug('[DAEMON RUN] Daemon state file removed');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function stopDaemon(): Promise<void> {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    const result = await stopDaemonHttp();
    if (result.success) {
      // Wait for daemon to die
      try {
        await waitForProcessDeath(state.pid, 2000);
        logger.debug('Daemon stopped gracefully via HTTP');
        return;
      } catch {
        logger.debug('Daemon did not die after HTTP stop, will force kill');
      }
    } else {
      logger.debug(`HTTP stop failed: ${result.error}, will force kill`);
    }

    // Force kill
    try {
      process.kill(state.pid, 'SIGKILL');
      logger.debug('Force killed daemon');
    } catch {
      logger.debug('Daemon already dead');
    }
  } catch (error) {
    logger.debug('Error stopping daemon', error);
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}