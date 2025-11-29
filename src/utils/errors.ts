/**
 * Error utilities for safe error handling.
 * Prevents sensitive information leakage in error messages.
 */
import axios from 'axios'

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
  if (axios.isAxiosError(error)) {
    if (error.response) {
      // Server responded with an error status
      return `Server returned ${error.response.status}: ${error.response.statusText}`;
    } else if (error.request) {
      // Request was made but no response received
      return 'No response from server';
    } else {
      // Error in request configuration
      return 'Request configuration error';
    }
  }
  // For non-axios errors, use generic message to avoid leaking internal details
  return error instanceof Error ? 'Internal error' : 'Unknown error';
}
