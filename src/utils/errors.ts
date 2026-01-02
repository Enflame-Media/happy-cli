/**
 * Error utilities for safe error handling and standardized error management.
 *
 * This module re-exports the shared AppError from @happy/errors and provides
 * CLI-specific error codes and utilities.
 *
 * @module utils/errors
 *
 * @example Basic usage
 * ```typescript
 * import { AppError, ErrorCodes } from '@/utils/errors';
 *
 * // Throw a standardized error
 * throw new AppError(ErrorCodes.AUTH_FAILED, 'Session expired');
 *
 * // Wrap an unknown error safely
 * try {
 *   await apiCall();
 * } catch (error) {
 *   throw AppError.fromUnknownSafe(
 *     ErrorCodes.CONNECT_FAILED,
 *     'Failed to connect to server',
 *     error
 *   );
 * }
 * ```
 */
import axios from 'axios'
import { AppError, type ErrorCode } from '@happy/errors'
import { getCorrelationId } from '@/utils/correlationId'

// Re-export AppError, ErrorCodes, and types from shared package
export { AppError, ErrorCodes } from '@happy/errors'
export type { AppErrorOptions, AppErrorJSON, ErrorCode } from '@happy/errors'

// =============================================================================
// ERROR DOCUMENTATION UTILITIES
// =============================================================================
// These utilities provide helpful error messages with documentation links
// for self-service debugging. See docs/errors/ for the documentation files.

/**
 * Base URL for error documentation.
 * In the future, this could point to a public documentation site.
 */
const ERROR_DOCS_BASE = 'https://github.com/Enflame-Media/happy-shared/blob/main/docs/errors'

/**
 * Maps error codes to their documentation anchors/pages.
 * Used to generate help URLs for self-service debugging.
 */
const ERROR_DOC_MAP: Partial<Record<string, string>> = {
  // Connection/Network errors - common troubleshooting
  CONNECT_FAILED: 'CONNECTION.md#connect-failed',
  NO_RESPONSE: 'CONNECTION.md#no-response',
  REQUEST_CONFIG_ERROR: 'CONNECTION.md#request-config-error',

  // Authentication errors - auth flow issues
  AUTH_FAILED: 'AUTHENTICATION.md#auth-failed',
  TOKEN_EXCHANGE_FAILED: 'AUTHENTICATION.md#token-exchange-failed',

  // Session/Process errors - daemon and session management
  SESSION_NOT_FOUND: 'SESSIONS.md#session-not-found',
  SESSION_REVIVAL_FAILED: 'SESSIONS.md#session-revival-failed',
  DAEMON_START_FAILED: 'DAEMON.md#start-failed',
  PROCESS_TIMEOUT: 'DAEMON.md#process-timeout',
  VERSION_MISMATCH: 'CLI.md#version-mismatch',

  // Resource errors - file and lock issues
  LOCK_ACQUISITION_FAILED: 'CLI.md#lock-acquisition-failed',
  DIRECTORY_REQUIRED: 'CLI.md#directory-required',
  RESOURCE_NOT_FOUND: 'CLI.md#resource-not-found',

  // Encryption errors - key and encryption issues
  ENCRYPTION_ERROR: 'ENCRYPTION.md#encryption-error',
  NONCE_TOO_SHORT: 'ENCRYPTION.md#nonce-too-short',
}

/**
 * Get the documentation URL for a given error code.
 *
 * @param code - The error code to look up
 * @returns Documentation URL if available, undefined otherwise
 *
 * @example
 * ```typescript
 * const url = getErrorDocUrl('AUTH_FAILED');
 * // Returns: 'https://github.com/Enflame-Media/happy-shared/blob/main/docs/errors/AUTHENTICATION.md#auth-failed'
 * ```
 */
export function getErrorDocUrl(code: string): string | undefined {
  const docPath = ERROR_DOC_MAP[code]
  return docPath ? `${ERROR_DOCS_BASE}/${docPath}` : undefined
}

/**
 * Get the documentation URL for an AppError, if available.
 *
 * @param error - The AppError instance
 * @returns Documentation URL or undefined
 */
export function getAppErrorDocUrl(error: AppError): string | undefined {
  return getErrorDocUrl(error.code)
}

/**
 * Get a formatted error message with documentation link and correlation ID.
 * Useful for CLI output where users can follow up for more information.
 *
 * The correlation ID is included to help with debugging and support requests,
 * enabling end-to-end request tracing across CLI → Server → Workers.
 *
 * @param error - The AppError instance
 * @returns Formatted message with correlation ID and optional documentation link
 *
 * @example
 * ```typescript
 * const error = new AppError(ErrorCodes.AUTH_FAILED, 'Token expired');
 * console.error(getHelpfulMessage(error));
 * // Output: "Token expired (ref: abc123...)\n  For more information, see: https://..."
 * ```
 *
 * @see HAP-509 - CLI correlation ID implementation
 */
export function getHelpfulMessage(error: AppError): string {
  const correlationId = getCorrelationId()
  const shortId = correlationId.substring(0, 8) // Show first 8 chars for brevity
  const baseMessage = `${error.message} (ref: ${shortId})`

  const docUrl = getAppErrorDocUrl(error)
  if (docUrl) {
    return `${baseMessage}\n  For more information, see: ${docUrl}`
  }
  return baseMessage
}

/**
 * Get a verbose error message with the full correlation ID.
 * Useful for support requests where the full ID is needed for log correlation.
 *
 * @param error - The AppError instance
 * @returns Message with full correlation ID for support reference
 *
 * @example
 * ```typescript
 * console.error(getVerboseErrorMessage(error));
 * // Output: "Token expired\n  Correlation ID: 550e8400-e29b-41d4-a716-446655440000"
 * ```
 *
 * @see HAP-509 - CLI correlation ID implementation
 */
export function getVerboseErrorMessage(error: AppError): string {
  const correlationId = getCorrelationId()
  return `${error.message}\n  Correlation ID: ${correlationId}`
}

/**
 * Creates an AppError from an unknown error with a safe, user-facing message.
 * Combines getSafeErrorMessage() logic with AppError creation.
 *
 * @param code - Error code to assign
 * @param contextMessage - Context message to prepend
 * @param error - Unknown error value to wrap
 * @returns AppError with safe message
 *
 * @example
 * ```typescript
 * try {
 *   await axios.post('/api/endpoint', data);
 * } catch (error) {
 *   throw fromUnknownSafe(
 *     ErrorCodes.CONNECT_FAILED,
 *     'Failed to connect to API',
 *     error
 *   );
 * }
 * ```
 */
export function fromUnknownSafe(code: ErrorCode, contextMessage: string, error: unknown): AppError {
  const safeMessage = getSafeErrorMessage(error)
  const fullMessage = `${contextMessage}: ${safeMessage}`
  const cause = error instanceof Error ? error : undefined
  return new AppError(code, fullMessage, { cause })
}

/**
 * Extracts a safe, user-facing error message from an axios error.
 * This prevents leaking sensitive information like auth tokens, URLs, or request bodies.
 * Full error details should be logged separately for debugging.
 *
 * @example
 * ```typescript
 * try {
 *   await axios.post('/api/endpoint', data);
 * } catch (error) {
 *   logger.debug('Full error:', error);  // Debug log for developers
 *   throw new Error(`Operation failed: ${getSafeErrorMessage(error)}`);  // Safe for users
 * }
 * ```
 */
export function getSafeErrorMessage(error: unknown): string {
  // Handle AppError specially - it's already safe to expose
  if (AppError.isAppError(error)) {
    return error.message
  }

  if (axios.isAxiosError(error)) {
    if (error.response) {
      // Server responded with an error status
      return `Server returned ${error.response.status}: ${error.response.statusText}`
    } else if (error.request) {
      // Request was made but no response received
      return 'No response from server'
    } else {
      // Error in request configuration
      return 'Request configuration error'
    }
  }
  // For non-axios errors, use generic message to avoid leaking internal details
  return error instanceof Error ? 'Internal error' : 'Unknown error'
}
