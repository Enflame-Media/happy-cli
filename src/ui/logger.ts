/**
 * Design decisions:
 * - Logging should be done only through file for debugging, otherwise we might disturb the claude session when in interactive mode
 * - Use info for logs that are useful to the user - this is our UI
 * - File output location: ~/.handy/logs/<date time in local timezone>.log
 */

import chalk from 'chalk'
import { appendFileSync, renameSync } from 'fs'
import { configuration } from '@/configuration'
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { AppError, getHelpfulMessage, getAppErrorDocUrl } from '@/utils/errors'
import { validateRemoteLoggingUrl } from '@/utils/validateEnv'
// Note: readDaemonState is imported dynamically in listDaemonLogFiles() to avoid
// circular dependency: logger.ts -> persistence.ts -> logger.ts

/**
 * Configure chalk color output for non-interactive environments.
 *
 * Chalk v5+ already handles:
 * - NO_COLOR env var: disables colors when set (any value)
 * - FORCE_COLOR env var: forces colors when set (0-3 for levels)
 * - TTY detection: disables colors when stdout is not a TTY (piped output)
 *
 * We additionally handle:
 * - CI env var: disables colors in CI environments unless FORCE_COLOR is set
 *
 * Priority order (highest first):
 * 1. FORCE_COLOR - explicitly enables colors (overrides everything)
 * 2. NO_COLOR - explicitly disables colors (chalk handles this)
 * 3. CI - disables colors in CI environments
 * 4. TTY detection - chalk's default behavior
 */
if (process.env.CI && !process.env.FORCE_COLOR) {
  chalk.level = 0
}

/**
 * Log rotation configuration
 * - MAX_LOG_SIZE: Rotate when file exceeds this size (default 10MB)
 * - MAX_LOG_FILES: Keep this many rotated files before deleting (default 5)
 */
const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_LOG_FILES = 5

/**
 * Type guard for Node.js system errors with error codes
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && typeof (error as NodeJS.ErrnoException).code === 'string'
}

/**
 * Consistent date/time formatting functions
 */
function createTimestampForFilename(date: Date = new Date()): string {
  return date.toLocaleString('sv-SE', { 
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(/[: ]/g, '-').replace(/,/g, '') + '-pid-' + process.pid
}

function createTimestampForLogEntry(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-US', { 
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
}

function getSessionLogPath(): string {
  const timestamp = createTimestampForFilename()
  const filename = configuration.isDaemonProcess ? `${timestamp}-daemon.log` : `${timestamp}.log`
  return join(configuration.logsDir, filename)
}

/**
 * Default list of sensitive key patterns to redact from logs.
 * Keys containing any of these substrings (case-insensitive) will be redacted.
 */
const DEFAULT_SENSITIVE_KEYS = [
  'key',
  'secret',
  'token',
  'password',
  'auth',
  'credential',
  'private',
  'apikey',
  'accesstoken',
  'refreshtoken',
]

/**
 * Gets the list of sensitive key patterns to redact.
 * Can be overridden via HAPPY_SENSITIVE_LOG_KEYS environment variable (comma-separated).
 */
function getSensitiveKeys(): string[] {
  const envKeys = process.env.HAPPY_SENSITIVE_LOG_KEYS
  if (envKeys) {
    return envKeys.split(',').map(k => k.trim().toLowerCase())
  }
  return DEFAULT_SENSITIVE_KEYS
}

/**
 * Sanitizes data for logging by redacting sensitive fields.
 * Recursively processes objects and arrays, replacing values of sensitive keys with '[REDACTED]'.
 * Handles circular references safely.
 *
 * @param data - The data to sanitize (can be any type)
 * @param seen - WeakSet to track circular references (internal use)
 * @returns Sanitized copy of the data with sensitive fields redacted
 */
export function sanitizeForLogging(data: unknown, seen = new WeakSet<object>()): unknown {
  // Primitives pass through unchanged
  if (data === null || data === undefined) return data
  if (typeof data !== 'object') return data

  // Handle circular references
  if (seen.has(data as object)) return '[Circular]'
  seen.add(data as object)

  // Arrays - sanitize each element
  if (Array.isArray(data)) {
    return data.map(item => sanitizeForLogging(item, seen))
  }

  // Date objects - return as-is
  if (data instanceof Date) return data

  // Error objects - extract safe properties
  if (data instanceof Error) {
    return { message: data.message, name: data.name, stack: data.stack }
  }

  // Plain objects - check each key against sensitive patterns
  const sanitized: Record<string, unknown> = {}
  const sensitiveKeys = getSensitiveKeys()

  for (const [key, value] of Object.entries(data)) {
    const keyLower = key.toLowerCase()
    // Redact if the key contains any sensitive pattern (substring matching)
    const isSensitive = sensitiveKeys.some(sensitiveKey => keyLower.includes(sensitiveKey))
    if (isSensitive) {
      sanitized[key] = '[REDACTED]'
    } else {
      sanitized[key] = sanitizeForLogging(value, seen)
    }
  }

  return sanitized
}

class Logger {
  private dangerouslyUnencryptedServerLoggingUrl: string | undefined
  private fileLoggingEnabled: boolean = true
  private fileLoggingWarningShown: boolean = false
  private currentLogSize: number = 0
  private isRotating: boolean = false
  private pendingWrites: string[] = []

  /**
   * Tracks write errors that occurred during file logging.
   * In production, write failures are silent to avoid disturbing Claude sessions,
   * but we still want to be able to report them at session end for debugging.
   */
  private logWriteErrors: { timestamp: Date; error: Error; context?: string }[] = []

  constructor(
    public readonly logFilePath = getSessionLogPath()
  ) {
    // Remote logging requires explicit opt-in via DEBUG=1 (HAP-829)
    // This is a safety measure to prevent accidental data exposure.
    // All four conditions must be met:
    // 1. DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING is set
    // 2. HAPPY_SERVER_URL is set
    // 3. DEBUG=1 is explicitly set (explicit opt-in)
    // 4. URL must use HTTPS (or HTTP for localhost only) (HAP-830)
    if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING
      && process.env.HAPPY_SERVER_URL
      && process.env.DEBUG) {
      // Validate URL uses secure transport (HAP-830)
      const urlValidation = validateRemoteLoggingUrl(process.env.HAPPY_SERVER_URL)
      if (urlValidation.valid) {
        this.dangerouslyUnencryptedServerLoggingUrl = urlValidation.url
        console.error(chalk.yellow('[REMOTE LOGGING] Sending logs to server for AI debugging'))
        console.error(chalk.yellow('[REMOTE LOGGING] WARNING: This sends unencrypted session data to the server!'))
      } else {
        // URL failed security validation - block remote logging
        console.error(chalk.red('[REMOTE LOGGING BLOCKED] ' + urlValidation.error))
      }
    } else if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING
      && process.env.HAPPY_SERVER_URL
      && !process.env.DEBUG) {
      // User attempted to enable remote logging without DEBUG - show explicit warning
      console.error(chalk.red('[REMOTE LOGGING BLOCKED] Remote logging requires DEBUG=1 to be set explicitly.'))
      console.error(chalk.red('[REMOTE LOGGING BLOCKED] This is a safety measure to prevent accidental data exposure.'))
      console.error(chalk.yellow('To enable remote logging, run with: DEBUG=1 ./bin/happy.mjs ...'))
    }

    // Attempt to initialize log directory
    this.tryInitializeLogDirectory()

    // Initialize current log size from existing file
    this.initializeLogSize()
  }

  /**
   * Initializes the currentLogSize from an existing log file, if present.
   * Called during construction to ensure accurate size tracking from the start.
   */
  private initializeLogSize(): void {
    try {
      if (existsSync(this.logFilePath)) {
        const stats = statSync(this.logFilePath)
        this.currentLogSize = stats.size
      }
    } catch {
      // If we can't read the size, start from 0 - rotation will still work
      this.currentLogSize = 0
    }
  }

  /**
   * Attempts to create the log directory and verify write access.
   * If this fails (permission denied, disk full, etc.), file logging is disabled
   * and the logger falls back to console-only mode for errors.
   *
   * Common failure scenarios:
   * - EACCES/EPERM: No write permissions to parent directory
   * - ENOSPC/EDQUOT: Disk full or quota exceeded
   * - EROFS: Read-only file system
   * - EEXIST: Race condition with another process
   */
  private tryInitializeLogDirectory(): void {
    try {
      const logDir = dirname(this.logFilePath)

      // Attempt to create directory if it doesn't exist
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true })
      }

      // Verify we can write to the directory by attempting a test write
      // This catches permission issues even when directory exists
      const testPath = join(logDir, '.write-test')
      try {
        writeFileSync(testPath, '')
        unlinkSync(testPath)
      } catch (cleanupErr) {
        // If write succeeded but cleanup failed, try to remove anyway
        // This handles edge cases where file was created but unlinkSync throws
        try {
          if (existsSync(testPath)) {
            unlinkSync(testPath)
          }
        } catch {
          // Ignore cleanup errors - the write test succeeded which is what matters
        }

        // Re-throw the original error if write failed
        if (isNodeError(cleanupErr) &&
            (cleanupErr.code === 'EACCES' || cleanupErr.code === 'EPERM' ||
             cleanupErr.code === 'ENOSPC' || cleanupErr.code === 'EDQUOT')) {
          throw cleanupErr
        }
      }

      // Initialization successful - fileLoggingEnabled already true from initialization
    } catch (err) {
      this.fileLoggingEnabled = false
      this.warnFileLoggingDisabled(err)
    }
  }

  /**
   * Shows a one-time warning when file logging is disabled.
   * Includes error code information if available for better diagnostics.
   */
  private warnFileLoggingDisabled(err: unknown): void {
    if (this.fileLoggingWarningShown) return
    this.fileLoggingWarningShown = true

    let errorMessage: string
    if (isNodeError(err)) {
      errorMessage = `${err.code}: ${err.message}`
    } else if (err instanceof Error) {
      errorMessage = err.message
    } else {
      errorMessage = String(err)
    }

    console.error(
      chalk.yellow('[WARNING] Unable to initialize log directory, logging to console only:'),
      chalk.gray(errorMessage)
    )
  }

  /**
   * Rotates log files when the current log exceeds MAX_LOG_SIZE.
   *
   * Rotation strategy (atomic to prevent log loss):
   * 1. Set isRotating flag to buffer incoming writes
   * 2. Delete the oldest rotated file if at MAX_LOG_FILES
   * 3. Rename files in reverse order: .4 -> .5, .3 -> .4, .2 -> .3, .1 -> .2
   * 4. Rename current log to .1
   * 5. Reset currentLogSize to 0 (new file will be created on next write)
   * 6. Flush any buffered writes
   * 7. Clear isRotating flag
   *
   * File naming: logfile.log -> logfile.log.1, logfile.log.2, etc.
   */
  private rotateLogsIfNeeded(): void {
    if (this.currentLogSize <= MAX_LOG_SIZE) {
      return
    }

    if (this.isRotating) {
      return // Prevent re-entrant rotation
    }

    this.isRotating = true

    try {
      const basePath = this.logFilePath

      // Delete oldest file if we're at the limit
      const oldestPath = `${basePath}.${MAX_LOG_FILES}`
      if (existsSync(oldestPath)) {
        try {
          unlinkSync(oldestPath)
        } catch (err) {
          if (isNodeError(err) && err.code === 'ENOENT') {
            // File does not exist, not an error
          } else if (process.env.DEBUG) {
            console.error('[DEV] Failed to delete oldest log file:', err)
          }
        }
      }

      // Rotate existing numbered files in reverse order
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const fromPath = `${basePath}.${i}`
        const toPath = `${basePath}.${i + 1}`
        if (existsSync(fromPath)) {
          renameSync(fromPath, toPath)
        }
      }

      // Rename current log file to .1
      if (existsSync(basePath)) {
        renameSync(basePath, `${basePath}.1`)
      }

      // Reset size counter - new file will be created on next appendFileSync
      this.currentLogSize = 0

      // Flush any pending writes that accumulated during rotation
      const pendingWrites = this.pendingWrites
      this.pendingWrites = []

      for (const logLine of pendingWrites) {
        try {
          appendFileSync(this.logFilePath, logLine)
          this.currentLogSize += Buffer.byteLength(logLine, 'utf8')
        } catch {
          // If write fails during flush, the writes are lost but logger continues
        }
      }
    } catch (err) {
      // Rotation failed - log continues to the same file
      // This is acceptable: we'd rather have oversized logs than lose entries
      if (process.env.DEBUG) {
        console.error('[DEV] Log rotation failed:', err)
      }
    } finally {
      this.isRotating = false
    }
  }

  // Use local timezone for simplicity of locating the logs,
  // in practice you will not need absolute timestamps
  localTimezoneTimestamp(): string {
    return createTimestampForLogEntry()
  }

  debug(message: string, ...args: unknown[]): void {
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, ...args)

    // NOTE: @kirill does not think its a good ideas,
    // as it will break us using claude in interactive mode.
    // Instead simply open the debug file in a new editor window.
    //
    // Also log to console in development mode
    // if (process.env.DEBUG) {
    //   this.logToConsole('debug', '', message, ...args)
    // }
  }

  debugLargeJson(
    message: string,
    object: unknown,
    maxStringLength: number = 100,
    maxArrayLength: number = 10,
  ): void {
    if (!process.env.DEBUG) {
      this.debug(`In production, skipping message inspection`)
    }

    // Some of our messages are huge, but we still want to show them in the logs
    const truncateStrings = (obj: unknown): unknown => {
      if (typeof obj === 'string') {
        return obj.length > maxStringLength 
          ? obj.substring(0, maxStringLength) + '... [truncated for logs]'
          : obj
      }
      
      if (Array.isArray(obj)) {
        const truncatedArray = obj.map(item => truncateStrings(item)).slice(0, maxArrayLength)
        if (obj.length > maxArrayLength) {
          truncatedArray.push(`... [truncated array for logs up to ${maxArrayLength} items]` as unknown)
        }
        return truncatedArray
      }
      
      if (obj && typeof obj === 'object') {
        const result: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === 'usage') {
            // Drop usage, not generally useful for debugging
            continue
          }
          result[key] = truncateStrings(value)
        }
        return result
      }
      
      return obj
    }

    // Sanitize sensitive data first, then truncate for size
    const sanitizedObject = sanitizeForLogging(object)
    const truncatedObject = truncateStrings(sanitizedObject)
    const json = JSON.stringify(truncatedObject, null, 2)
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, '\n', json)
  }
  
  info(message: string, ...args: unknown[]): void {
    this.logToConsole('info', '', message, ...args)
    this.debug(message, args)
  }
  
  infoDeveloper(message: string, ...args: unknown[]): void {
    // Always write to debug
    this.debug(message, ...args)
    
    // Write to info if DEBUG mode is on
    if (process.env.DEBUG) {
      this.logToConsole('info', '[DEV]', message, ...args)
    }
  }
  
  warn(message: string, ...args: unknown[]): void {
    this.logToConsole('warn', '', message, ...args)
    this.debug(`[WARN] ${message}`, ...args)
  }
  
  getLogPath(): string {
    return this.logFilePath
  }

  /**
   * Returns whether file logging is currently enabled.
   * File logging may be disabled if:
   * - The log directory couldn't be created (EACCES, EPERM)
   * - Write permissions are not available (EACCES, EPERM, EROFS)
   * - Disk is full or quota exceeded (ENOSPC, EDQUOT)
   * - A write operation failed during runtime
   */
  isFileLoggingEnabled(): boolean {
    return this.fileLoggingEnabled
  }

  /**
   * Returns write errors that occurred during file logging operations.
   * These errors are silently captured in production to avoid disturbing Claude sessions,
   * but can be retrieved at session end to diagnose logging issues.
   *
   * @returns Array of write errors with timestamp and optional context
   */
  getLogWriteErrors(): ReadonlyArray<{ timestamp: Date; error: Error; context?: string }> {
    return this.logWriteErrors
  }

  /**
   * Returns true if any write errors occurred during this session.
   * Useful for quick checks at session end to determine if error reporting is needed.
   */
  hasLogWriteErrors(): boolean {
    return this.logWriteErrors.length > 0
  }

  /**
   * Clears accumulated write errors.
   * Typically called after errors have been reported to avoid duplicate reporting.
   */
  clearLogWriteErrors(): void {
    this.logWriteErrors = []
  }

  /**
   * Reports write errors that occurred during the session.
   * Call this at session end to inform the user of any logging issues.
   *
   * @returns true if errors were reported, false if no errors occurred
   */
  reportWriteErrorsIfAny(): boolean {
    if (!this.hasLogWriteErrors()) {
      return false
    }

    const errors = this.getLogWriteErrors()
    console.error(chalk.yellow(`\n[Logger] ${errors.length} write error(s) occurred during this session:`))

    for (const { timestamp, error, context } of errors) {
      const timeStr = timestamp.toLocaleTimeString('en-US', { hour12: false })
      const contextStr = context ? ` (while logging: "${context}...")` : ''
      console.error(chalk.gray(`  [${timeStr}] ${error.message}${contextStr}`))
    }

    console.error(chalk.gray(`  Log file: ${this.logFilePath}`))
    console.error(chalk.gray(`  Some log entries may have been lost. Check disk space and permissions.\n`))

    return true
  }

  /**
   * Reports an error to the user with improved messaging.
   * 
   * Key behaviors:
   * - Always shows user-friendly message to console
   * - Always logs full error details (stack trace, etc.) to file
   * - Shows actionable suggestions when provided
   * - In DEBUG mode, shows full stack trace to console
   * 
   * @param message - User-friendly error message
   * @param error - The error object (optional)
   * @param options - Additional options for error display
   */
  error(
    message: string,
    error?: Error | unknown,
    options: {
      /** Whether to suggest running with DEBUG=1 for more details (default: true) */
      suggestDebug?: boolean;
      /** Whether to show stack trace even without DEBUG (default: false) */
      showStack?: boolean;
      /** Optional hint for user action */
      actionHint?: string;
      /** Whether this is a technical/internal error (default: false) */
      technical?: boolean;
    } = {}
  ): void {
    const { suggestDebug = true, showStack = false, actionHint, technical = false } = options
    
    // Extract error details
    const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined
    const errorStack = error instanceof Error ? error.stack : undefined
    
    // Always log full details to file
    this.logToFile(
      `[${this.localTimezoneTimestamp()}] [ERROR]`,
      message,
      errorMessage ? `\nError: ${errorMessage}` : '',
      errorStack ? `\nStack: ${errorStack}` : ''
    )
    
    // For technical errors, only show in DEBUG mode
    if (technical) {
      if (process.env.DEBUG) {
        console.error(chalk.gray('[DEBUG]'), chalk.red(message))
        if (errorMessage) {
          console.error(chalk.gray('  →'), errorMessage)
        }
      }
      return
    }
    
    // Show user-friendly error to console
    console.error(chalk.red('Error:'), message)
    
    // Show error message if different from the main message
    if (errorMessage && errorMessage !== message) {
      console.error(chalk.gray('  →'), errorMessage)
    }
    
    // Show stack trace if DEBUG mode or explicitly requested
    if (showStack || process.env.DEBUG) {
      if (errorStack) {
        console.error(chalk.gray(errorStack))
      }
    }
    
    // Show action hint if provided
    if (actionHint) {
      console.error(chalk.gray(`  ${actionHint}`))
    }
    
    // Suggest DEBUG mode if appropriate and not already in DEBUG
    if (suggestDebug && !process.env.DEBUG && !showStack) {
      console.error(chalk.gray(`  Run with --verbose or DEBUG=1 for more details. Logs: ${this.logFilePath}`))
    }
  }

  /**
   * Reports an error and exits the process.
   *
   * This is a convenience method for the common pattern of:
   * - Log error to user
   * - Exit with error code
   *
   * For AppError instances, displays documentation URL for self-service debugging.
   *
   * @param message - User-friendly error message
   * @param error - The error object (optional)
   * @param exitCode - Exit code (default: 1)
   */
  errorAndExit(message: string, error?: Error | unknown, exitCode: number = 1): never {
    // For AppError, use helpful message with documentation link
    if (AppError.isAppError(error)) {
      const docUrl = getAppErrorDocUrl(error)
      this.error(message, error, {
        suggestDebug: true,
        actionHint: docUrl ? `For more information, see: ${docUrl}` : undefined
      })
    } else {
      this.error(message, error, { suggestDebug: true })
    }

    // Capture fatal errors with Sentry before exiting
    // Dynamic import to avoid circular dependency issues
    import('@/telemetry').then(({ captureException, shutdownTelemetry }) => {
      if (error) {
        captureException(error, { message, exitCode, fatal: true })
      }
      // Flush telemetry synchronously-ish before exit
      void shutdownTelemetry(1000).finally(() => {
        process.exit(exitCode)
      })
    }).catch(() => {
      // If telemetry import fails, just exit
      process.exit(exitCode)
    })

    // TypeScript needs this for the never return type
    // The process.exit in the promise will actually terminate
    throw new Error('Unreachable')
  }

  /**
   * Logs a technical/internal error that users typically don't need to see.
   *
   * These are logged to file always, but only shown in console when DEBUG=1.
   * Use for internal implementation details, verbose debugging info, etc.
   *
   * @param message - Technical error description
   * @param error - The error object (optional)
   */
  errorTechnical(message: string, error?: Error | unknown): void {
    this.error(message, error, { technical: true, suggestDebug: false })
  }

  /**
   * Logs an AppError with helpful message including documentation URL.
   *
   * This formats the error with correlation ID and, if available, a link to
   * troubleshooting documentation for self-service debugging.
   *
   * @param appError - The AppError instance
   *
   * @example
   * ```typescript
   * const error = new AppError(ErrorCodes.AUTH_FAILED, 'Token expired');
   * logger.errorApp(error);
   * // Output:
   * // Error: Token expired (ref: abc12345)
   * //   For more information, see: https://...
   * ```
   */
  errorApp(appError: AppError): void {
    const helpfulMessage = getHelpfulMessage(appError)
    console.error(chalk.red('Error:'), helpfulMessage)

    // Also log to file with full details
    this.logToFile(
      `[${this.localTimezoneTimestamp()}] [ERROR]`,
      `[${appError.code}] ${appError.message}`,
      appError.stack ? `\nStack: ${appError.stack}` : ''
    )
  }

  private logToConsole(level: 'debug' | 'error' | 'info' | 'warn', prefix: string, message: string, ...args: unknown[]): void {
    switch (level) {
      case 'debug': {
        console.log(chalk.gray(prefix), message, ...args)
        break
      }

      case 'error': {
        console.error(chalk.red(prefix), message, ...args)
        break
      }

      case 'info': {
        console.log(chalk.blue(prefix), message, ...args)
        break
      }

      case 'warn': {
        console.log(chalk.yellow(prefix), message, ...args)
        break
      }

      default: {
        this.debug('Unknown log level:', level)
        console.log(chalk.blue(prefix), message, ...args)
        break
      }
    }
  }

  private async sendToRemoteServer(level: string, message: string, ...args: unknown[]): Promise<void> {
    if (!this.dangerouslyUnencryptedServerLoggingUrl) return

    try {
      // Build headers - always include Content-Type
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }

      // Include dev logging token if configured for authentication
      const devLoggingToken = process.env.DEV_LOGGING_TOKEN
      if (devLoggingToken) {
        headers['X-Dev-Logging-Token'] = devLoggingToken
      }

      await fetch(this.dangerouslyUnencryptedServerLoggingUrl + '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          message: `${message} ${args.map(a =>
            typeof a === 'object' ? JSON.stringify(sanitizeForLogging(a), null, 2) : String(a)
          ).join(' ')}`,
          source: 'cli',
          platform: process.platform
        })
      })
    } catch {
      // Silently fail to avoid disrupting the session
    }
  }

  /**
   * Writes a log entry to file with graceful degradation on failure.
   * Falls back to console logging for error-level messages if file logging is unavailable.
   *
   * Error handling:
   * - Checks fileLoggingEnabled flag before attempting write
   * - Catches ENOSPC/EDQUOT (disk full) and disables file logging
   * - Catches EACCES/EPERM (permission denied) and disables file logging
   * - Catches EROFS (read-only filesystem) and disables file logging
   * - Catches ENOENT (directory deleted after init) and disables file logging
   * - Re-throws in DEBUG mode for other errors to aid debugging
   * - Silently fails in production for unknown errors to avoid disturbing Claude
   */
  private logToFile(prefix: string, message: string, ...args: unknown[]): void {
    // If file logging is disabled, fall back to console for error-level messages only
    if (!this.fileLoggingEnabled) {
      // Only log errors to console to avoid disturbing Claude sessions
      if (prefix.includes('ERROR') || prefix.includes('WARN')) {
        console.error(chalk.gray(`[fallback] ${prefix}`), message, ...args)
      }
      return
    }

    const logLine = `${prefix} ${message} ${args.map(arg =>
      typeof arg === 'string' ? arg : JSON.stringify(sanitizeForLogging(arg))
    ).join(' ')}\n`

    // Send to remote server if configured
    if (this.dangerouslyUnencryptedServerLoggingUrl) {
      // Determine log level from prefix
      let level = 'info'
      if (prefix.includes(this.localTimezoneTimestamp())) {
        level = 'debug'
      }
      // Fire and forget, with explicit .catch to prevent unhandled rejection
      this.sendToRemoteServer(level, message, ...args).catch(() => {
        // Silently ignore remote logging errors to prevent loops
      })
    }

    // If rotation is in progress, buffer the write to prevent loss
    if (this.isRotating) {
      this.pendingWrites.push(logLine)
      return
    }

    // Handle file write with graceful degradation
    try {
      appendFileSync(this.logFilePath, logLine)
      // Track size for rotation (using byte length for accuracy with UTF-8)
      this.currentLogSize += Buffer.byteLength(logLine, 'utf8')
      // Check if rotation is needed after this write
      this.rotateLogsIfNeeded()
    } catch (appendError) {
      // Use type guard for safe error code access
      if (isNodeError(appendError)) {
        const errorCode = appendError.code

        // Disable file logging for recoverable errors
        if (errorCode === 'ENOSPC' || errorCode === 'EDQUOT') {
          // Disk full or quota exceeded
          this.fileLoggingEnabled = false
          this.warnFileLoggingDisabled(appendError)
          return
        } else if (errorCode === 'EACCES' || errorCode === 'EPERM') {
          // Permission denied
          this.fileLoggingEnabled = false
          this.warnFileLoggingDisabled(appendError)
          return
        } else if (errorCode === 'EROFS') {
          // Read-only file system
          this.fileLoggingEnabled = false
          this.warnFileLoggingDisabled(appendError)
          return
        } else if (errorCode === 'ENOENT') {
          // File or directory doesn't exist (may have been deleted)
          this.fileLoggingEnabled = false
          this.warnFileLoggingDisabled(appendError)
          return
        }
      }

      // For unexpected errors in DEBUG mode, throw to aid debugging
      if (process.env.DEBUG) {
        console.error('[DEV MODE ONLY THROWING] Failed to append to log file:', appendError)
        throw appendError
      }

      // In production for other errors, track the error but fail silently to avoid disturbing Claude session
      // These errors can be retrieved at session end via getLogWriteErrors()
      const error = appendError instanceof Error ? appendError : new Error(String(appendError))
      this.logWriteErrors.push({
        timestamp: new Date(),
        error,
        context: message.substring(0, 100) // Truncate to avoid large memory usage
      })
    }
  }
}

// Will be initialized immideately on startup
export let logger = new Logger()

/**
 * Information about a log file on disk
 */
export type LogFileInfo = {
  file: string;
  path: string;
  modified: Date;
};

/**
 * List daemon log files in descending modification time order.
 * Returns up to `limit` entries; empty array if none.
 */
async function listDaemonLogFiles(limit: number = 50): Promise<LogFileInfo[]> {
  try {
    const logsDir = configuration.logsDir;
    if (!existsSync(logsDir)) {
      return [];
    }

    const logs = readdirSync(logsDir)
      .filter(file => file.endsWith('-daemon.log'))
      .map(file => {
        const fullPath = join(logsDir, file);
        const stats = statSync(fullPath);
        return { file, path: fullPath, modified: stats.mtime } as LogFileInfo;
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());

    // Prefer the path persisted by the daemon if present (return 0th element if present)
    try {
      // Dynamic import to avoid circular dependency: logger.ts -> persistence.ts -> logger.ts
      const { readDaemonState } = await import('@/persistence');
      const state = await readDaemonState();

      if (!state) {
        return logs;
      }

      if (state.daemonLogPath && existsSync(state.daemonLogPath)) {
        const stats = statSync(state.daemonLogPath);
        const persisted: LogFileInfo = {
          file: basename(state.daemonLogPath),
          path: state.daemonLogPath,
          modified: stats.mtime
        };
        const idx = logs.findIndex(l => l.path === persisted.path);
        if (idx >= 0) {
          const [found] = logs.splice(idx, 1);
          logs.unshift(found);
        } else {
          logs.unshift(persisted);
        }
      }
    } catch {
      // Ignore errors reading daemon state; fall back to directory listing
    }

    return logs.slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

/**
 * Get the most recent daemon log file, or null if none exist.
 */
export async function getLatestDaemonLog(): Promise<LogFileInfo | null> {
  const [latest] = await listDaemonLogFiles(1);
  return latest || null;
}
