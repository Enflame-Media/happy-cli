/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.happy/ or local .happy/
 */

import { FileHandle } from 'node:fs/promises'
import { readFile, writeFile, mkdir, open, unlink, rename, stat } from 'node:fs/promises'
import { existsSync, writeFileSync, readFileSync, unlinkSync, statSync, renameSync } from 'node:fs'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { configuration } from '@/configuration'
import * as z from 'zod';
import { encodeBase64 } from '@/api/encryption';
import { logger } from '@/ui/logger';
import { withRetry } from '@/utils/retry';
import { safeParseWithError } from '@/utils/zodErrors';
import { AppError, ErrorCodes } from '@/utils/errors';
import type { TelemetryConfig } from '@/telemetry/types';

interface Settings {
  onboardingCompleted: boolean
  // This ID is used as the actual database ID on the server
  // All machine operations use this ID
  machineId?: string
  machineIdConfirmedByServer?: boolean
  daemonAutoStartWhenRunningHappy?: boolean
  /**
   * Telemetry configuration for privacy-first data collection.
   * When undefined, defaults to telemetry disabled.
   * Can be overridden via HAPPY_TELEMETRY environment variable.
   */
  telemetry?: TelemetryConfig
  /**
   * Whether we've shown the telemetry opt-in notice to the user.
   * This is shown once on first run to inform about telemetry options.
   */
  telemetryNoticeShown?: boolean
}

const defaultSettings: Settings = {
  onboardingCompleted: false
}

/**
 * Zod schema for daemon state validation
 * Ensures corrupted state files are detected and removed gracefully
 */
const DaemonStateSchema = z.object({
  pid: z.number(),
  httpPort: z.number(),
  startTime: z.string(),
  startedWithCliVersion: z.string(),
  lastHeartbeat: z.string().optional(),
  daemonLogPath: z.string().optional(),
  caffeinatePid: z.number().optional(),
  /** Paths to Codex temp directories containing auth.json (for orphan cleanup on daemon restart) */
  codexTempDirs: z.array(z.string()).optional(),
});

/**
 * Daemon state persisted locally (different from API DaemonState)
 * This is written to disk by the daemon to track its local process state
 */
export type DaemonLocallyPersistedState = z.infer<typeof DaemonStateSchema>;

/**
 * Atomically write content to a file using temp file + rename pattern.
 * This ensures the target file is never left in a corrupted state,
 * even during crashes or concurrent writes.
 *
 * @param filePath The target file path
 * @param content The content to write
 */
async function atomicWriteFile(filePath: string, content: string, options?: { mode?: number }): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, content, options)
    await rename(tempPath, filePath)
  } catch (error) {
    // Clean up temp file on error
    try {
      if (existsSync(tempPath)) {
        await unlink(tempPath)
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error
  }
}

/**
 * Synchronously and atomically write content to a file using temp file + rename pattern.
 * This ensures the target file is never left in a corrupted state,
 * even during crashes or concurrent writes.
 *
 * @param filePath The target file path
 * @param content The content to write
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, content, 'utf-8')
    renameSync(tempPath, filePath)
  } catch (error) {
    // Clean up temp file on error
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath)
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error
  }
}

export async function readSettings(): Promise<Settings> {
  if (!existsSync(configuration.settingsFile)) {
    return { ...defaultSettings }
  }

  try {
    const content = await withRetry(() => readFile(configuration.settingsFile, 'utf8'))
    return JSON.parse(content)
  } catch {
    return { ...defaultSettings }
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await withRetry(() => mkdir(configuration.happyHomeDir, { recursive: true }))
  }

  await withRetry(() => atomicWriteFile(configuration.settingsFile, JSON.stringify(settings, null, 2)))
}

/**
 * Atomically update settings with multi-process safety via file locking
 * @param updater Function that takes current settings and returns updated settings
 * @returns The updated settings
 */
export async function updateSettings(
  updater: (current: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
  // Timing constants
  const LOCK_RETRY_INTERVAL_MS = 100;  // How long to wait between lock attempts
  const MAX_LOCK_ATTEMPTS = 50;        // Maximum number of attempts (5 seconds total)
  const STALE_LOCK_TIMEOUT_MS = 10000; // Consider lock stale after 10 seconds

  const lockFile = configuration.settingsFile + '.lock';
  const tmpFile = configuration.settingsFile + '.tmp';
  
  // Declare fileHandle outside try block so finally can access it
  // This ensures cleanup even if process crashes during lock acquisition
  let fileHandle: FileHandle | null = null;
  let attempts = 0;

  try {
    // Acquire exclusive lock with retries - now inside try block for proper crash cleanup
    while (attempts < MAX_LOCK_ATTEMPTS) {
      try {
        // O_CREAT | O_EXCL | O_WRONLY = create exclusively, fail if exists
        fileHandle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        break;
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // Lock file exists, wait and retry
          attempts++;
          await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));

          // Check for stale lock
          try {
            const stats = await withRetry(() => stat(lockFile));
            if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
              await withRetry(() => unlink(lockFile)).catch(() => { });
            }
          } catch { }
        } else {
          throw err;
        }
      }
    }

    if (!fileHandle) {
      throw new AppError(ErrorCodes.LOCK_ACQUISITION_FAILED, `Failed to acquire settings lock after ${MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS / 1000} seconds`);
    }

    // Read current settings with defaults
    const current = await readSettings() || { ...defaultSettings };

    // Apply update
    const updated = await updater(current);

    // Ensure directory exists
    if (!existsSync(configuration.happyHomeDir)) {
      await withRetry(() => mkdir(configuration.happyHomeDir, { recursive: true }));
    }

    // Write atomically using rename
    await withRetry(() => writeFile(tmpFile, JSON.stringify(updated, null, 2)));
    await withRetry(() => rename(tmpFile, configuration.settingsFile)); // Atomic on POSIX

    return updated;
  } finally {
    // Release lock - this now runs even if crash occurs during lock acquisition
    if (fileHandle) {
      await fileHandle.close();
      // Only unlink if we successfully acquired the lock (fileHandle exists)
      await withRetry(() => unlink(lockFile)).catch(() => { });
    }
  }
}

//
// Authentication
//

const credentialsSchema = z.object({
  token: z.string(),
  secret: z.string().base64().nullish(), // Legacy
  encryption: z.object({
    publicKey: z.string().base64(),
    machineKey: z.string().base64()
  }).nullish()
})

export type Credentials = {
  token: string,
  encryption: {
    type: 'legacy', secret: Uint8Array
  } | {
    type: 'dataKey', publicKey: Uint8Array, machineKey: Uint8Array
  }
}

export async function readCredentials(): Promise<Credentials | null> {
  if (!existsSync(configuration.privateKeyFile)) {
    return null
  }
  try {
    const keyBase64 = (await withRetry(() => readFile(configuration.privateKeyFile, 'utf8')));
    const parsed = JSON.parse(keyBase64);
    const result = safeParseWithError(credentialsSchema, parsed, 'credentials');
    if (!result.success) {
      // Log validation error for debugging but don't expose sensitive details
      logger.errorTechnical(`[PERSISTENCE] Credentials validation failed: ${result.error}`);
      return null;
    }
    const credentials = result.data;
    if (credentials.secret) {
      return {
        token: credentials.token,
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(Buffer.from(credentials.secret, 'base64'))
        }
      };
    } else if (credentials.encryption) {
      return {
        token: credentials.token,
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(Buffer.from(credentials.encryption.publicKey, 'base64')),
          machineKey: new Uint8Array(Buffer.from(credentials.encryption.machineKey, 'base64'))
        }
      }
    }
  } catch {
    return null
  }
  return null
}

export async function writeCredentialsLegacy(credentials: { secret: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await withRetry(() => mkdir(configuration.happyHomeDir, { recursive: true }))
  }
  await withRetry(() => atomicWriteFile(configuration.privateKeyFile, JSON.stringify({
    secret: encodeBase64(credentials.secret),
    token: credentials.token
  }, null, 2), { mode: 0o600 }));
}

export async function writeCredentialsDataKey(credentials: { publicKey: Uint8Array, machineKey: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await withRetry(() => mkdir(configuration.happyHomeDir, { recursive: true }))
  }
  await withRetry(() => atomicWriteFile(configuration.privateKeyFile, JSON.stringify({
    encryption: { publicKey: encodeBase64(credentials.publicKey), machineKey: encodeBase64(credentials.machineKey) },
    token: credentials.token
  }, null, 2), { mode: 0o600 }));
}

export async function clearCredentials(): Promise<void> {
  if (existsSync(configuration.privateKeyFile)) {
    await withRetry(() => unlink(configuration.privateKeyFile));
  }
}

export async function clearMachineId(): Promise<void> {
  await updateSettings(settings => ({
    ...settings,
    machineId: undefined
  }));
}

/**
 * Read daemon state from local file with Zod schema validation.
 * Automatically removes corrupted state files to prevent crashes.
 */
export async function readDaemonState(): Promise<DaemonLocallyPersistedState | null> {
  if (!existsSync(configuration.daemonStateFile)) {
    return null;
  }

  try {
    const content = await withRetry(() => readFile(configuration.daemonStateFile, 'utf-8'));
    const parsed = JSON.parse(content);
    const validated = DaemonStateSchema.safeParse(parsed);

    if (!validated.success) {
      logger.errorTechnical(`[PERSISTENCE] Daemon state validation failed: ${validated.error.message}`);
      logger.debug(`[PERSISTENCE] Removing corrupted state file: ${configuration.daemonStateFile}`);
      await unlink(configuration.daemonStateFile);
      return null;
    }

    return validated.data;
  } catch (error) {
    // JSON parse error or file read error - remove corrupted file
    logger.errorTechnical(`[PERSISTENCE] Daemon state file corrupted: ${configuration.daemonStateFile}`, error);
    try {
      if (existsSync(configuration.daemonStateFile)) {
        await unlink(configuration.daemonStateFile);
        logger.debug(`[PERSISTENCE] Removed corrupted state file`);
      }
    } catch {
      // Ignore cleanup errors - file might already be gone
    }
    return null;
  }
}

/**
 * Write daemon state to local file using atomic write pattern.
 * Uses synchronous operations for reliable process lifecycle management.
 */
export function writeDaemonState(state: DaemonLocallyPersistedState): void {
  // Assumes configuration.ensureSetup() has already been called to create the directory
  atomicWriteFileSync(configuration.daemonStateFile, JSON.stringify(state, null, 2));
}

/**
 * Clean up daemon state file and lock file
 */
export async function clearDaemonState(): Promise<void> {
  if (existsSync(configuration.daemonStateFile)) {
    await withRetry(() => unlink(configuration.daemonStateFile));
  }
  // Also clean up lock file if it exists (for stale cleanup)
  if (existsSync(configuration.daemonLockFile)) {
    try {
      await withRetry(() => unlink(configuration.daemonLockFile));
    } catch {
      // Lock file might be held by running daemon, ignore error
    }
  }
}

/**
 * Lock file data format (JSON)
 * Supports backwards compatibility with legacy plain-PID format
 */
interface LockFileData {
  pid: number;
  timestamp: number;
}

/** Lock files older than this are considered stale and automatically removed */
const STALE_LOCK_AGE_MS = 60_000; // 1 minute

/**
 * Parse lock file content, supporting both new JSON format and legacy plain-PID format
 * @returns parsed data with pid, or null if unparseable
 */
function parseLockFileContent(content: string): { pid: number; timestamp?: number } | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  // Try JSON format first (new format: {pid, timestamp})
  try {
    const parsed = JSON.parse(trimmed) as LockFileData;
    // Validate pid is a positive integer
    if (typeof parsed.pid === 'number' && !isNaN(parsed.pid) &&
        parsed.pid > 0 && Number.isInteger(parsed.pid)) {
      // Validate timestamp if present
      const timestamp = parsed.timestamp;
      if (timestamp !== undefined) {
        if (typeof timestamp === 'number' && !isNaN(timestamp) && timestamp > 0) {
          return { pid: parsed.pid, timestamp };
        }
        // Invalid timestamp - treat as corrupted
        return null;
      }
      return { pid: parsed.pid };
    }
  } catch {
    // Not JSON, try legacy plain-PID format
  }

  // Try legacy plain-PID format
  const pid = Number(trimmed);
  if (!isNaN(pid) && pid > 0 && Number.isInteger(pid)) {
    return { pid };
  }

  return null;
}

/**
 * Check if a process with the given PID is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to remove a stale lock file.
 * A lock is considered stale if:
 * 1. The lock file is empty or corrupted
 * 2. The process that created the lock is no longer running
 * 3. The lock file is older than STALE_LOCK_AGE_MS (timestamp-based)
 *
 * Process liveness is checked first for better UX (immediate recovery if daemon crashed).
 * File age is checked last as a fallback safety mechanism.
 *
 * @returns true if lock was removed, false if lock is valid (held by running process)
 */
function tryRemoveStaleLock(): boolean {
  const lockPath = configuration.daemonLockFile;

  try {
    // Read and parse lock content first
    let content: string;
    try {
      content = readFileSync(lockPath, 'utf-8');
    } catch (readError: any) {
      // Can't read file - might be permission issue or race condition
      logger.debug(`[PERSISTENCE] Cannot read lock file: ${readError.message}`);
      return false;
    }

    const lockData = parseLockFileContent(content);

    if (!lockData) {
      // Empty or corrupted lock file - remove it immediately
      logger.debug('[PERSISTENCE] Lock file is empty or corrupted, removing');
      unlinkSync(lockPath);
      return true;
    }

    // Check if the process is still running (fastest check for crashed daemons)
    if (!isProcessRunning(lockData.pid)) {
      logger.debug(`[PERSISTENCE] Lock held by dead process (PID ${lockData.pid}), removing stale lock`);
      unlinkSync(lockPath);
      return true;
    }

    // Process is running, but check if lock file is very old (safety check)
    const stats = statSync(lockPath);
    const lockAge = Date.now() - stats.mtimeMs;

    if (lockAge > STALE_LOCK_AGE_MS) {
      logger.debug(`[PERSISTENCE] Lock file is ${Math.round(lockAge / 1000)}s old but process ${lockData.pid} still running, removing stale lock`);
      unlinkSync(lockPath);
      return true;
    }

    // Lock is valid - held by a running process and not too old
    logger.debug(`[PERSISTENCE] Lock held by running process (PID ${lockData.pid})`);
    return false;

  } catch (err: any) {
    // Lock file might have been removed by another process
    if (err.code === 'ENOENT') {
      return true; // File doesn't exist, can retry acquisition
    }
    logger.debug(`[PERSISTENCE] Error checking lock file: ${err.message}`);
    return false;
  }
}

/**
 * Acquire an exclusive lock file for the daemon.
 * The lock file proves the daemon is running and prevents multiple instances.
 * Returns the file handle to hold for the daemon's lifetime, or null if locked.
 *
 * Handles stale lock scenarios:
 * - Empty/corrupted lock files are automatically removed
 * - Lock files older than 1 minute are considered stale
 * - Lock files for dead processes are automatically removed
 */
export async function acquireDaemonLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200
): Promise<FileHandle | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // O_EXCL ensures we only create if it doesn't exist (atomic lock acquisition)
      const fileHandle = await open(
        configuration.daemonLockFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      );
      // Write PID and timestamp to lock file (JSON format)
      const lockData: LockFileData = {
        pid: process.pid,
        timestamp: Date.now()
      };
      await fileHandle.writeFile(JSON.stringify(lockData));
      return fileHandle;
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // Lock file exists - check if it's stale or held by dead process
        const removed = tryRemoveStaleLock();
        if (removed) {
          continue; // Retry acquisition immediately
        }
      }

      if (attempt === maxAttempts) {
        logger.debug(`[PERSISTENCE] Failed to acquire daemon lock after ${maxAttempts} attempts`);
        return null;
      }
      const delayMs = attempt * delayIncrementMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

