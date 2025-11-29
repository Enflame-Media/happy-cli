/**
 * Retry utility for handling transient file system errors
 *
 * Provides automatic retry with exponential backoff for recoverable
 * file system errors like EBUSY (resource busy), EAGAIN (try again),
 * EMFILE (too many open files), and ENFILE (system file table overflow).
 */

/**
 * Error codes that indicate transient file system conditions
 * that may succeed on retry.
 */
export const TRANSIENT_FS_ERROR_CODES = ['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE'] as const;

export type TransientFsErrorCode = typeof TRANSIENT_FS_ERROR_CODES[number];

/**
 * Configuration options for retry behavior
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds before first retry (default: 100) */
  initialDelayMs?: number;
  /** Whether to use exponential backoff (default: true) */
  exponentialBackoff?: boolean;
  /** Maximum delay cap in milliseconds (default: 5000) */
  maxDelayMs?: number;
  /** Additional error codes to retry on (optional) */
  additionalErrorCodes?: string[];
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'additionalErrorCodes'>> = {
  maxRetries: 3,
  initialDelayMs: 100,
  exponentialBackoff: true,
  maxDelayMs: 5000,
};

/**
 * Sleep for the specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay for a given attempt using exponential backoff
 */
function calculateDelay(attempt: number, options: Required<Omit<RetryOptions, 'additionalErrorCodes'>>): number {
  if (!options.exponentialBackoff) {
    return options.initialDelayMs;
  }
  const delay = options.initialDelayMs * Math.pow(2, attempt);
  return Math.min(delay, options.maxDelayMs);
}

/**
 * Check if an error code is a transient error that should be retried
 */
function isTransientError(code: string | undefined, additionalCodes?: string[]): boolean {
  if (!code) return false;

  const retryableCodes = new Set<string>([
    ...TRANSIENT_FS_ERROR_CODES,
    ...(additionalCodes ?? [])
  ]);

  return retryableCodes.has(code);
}

/**
 * Execute an async function with automatic retry on transient file system errors.
 *
 * @param fn - The async function to execute
 * @param options - Configuration options for retry behavior
 * @returns The result of the function if successful
 * @throws The last error if all retries are exhausted or a non-transient error occurs
 *
 * @example
 * ```typescript
 * // Basic usage with defaults (3 retries, 100ms initial delay)
 * await withRetry(() => fs.writeFile(path, data));
 *
 * // Custom retry configuration
 * await withRetry(
 *   () => fs.readFile(path, 'utf8'),
 *   { maxRetries: 5, initialDelayMs: 200 }
 * );
 *
 * // Disable exponential backoff (fixed delay)
 * await withRetry(
 *   () => fs.mkdir(path, { recursive: true }),
 *   { exponentialBackoff: false, initialDelayMs: 500 }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      const code = error.code;

      // If it's the last attempt or not a transient error, throw immediately
      const isLastAttempt = attempt === opts.maxRetries;
      const isRetryable = isTransientError(code, options?.additionalErrorCodes);

      if (isLastAttempt || !isRetryable) {
        throw err;
      }

      // Calculate delay and wait before next attempt
      const delay = calculateDelay(attempt, opts);
      await sleep(delay);
    }
  }

  // This should never be reached due to the throw in the loop
  throw new Error('withRetry: unexpected code path');
}

/**
 * Higher-order function to create a retryable version of any async function.
 * Useful for creating pre-configured retryable wrappers.
 *
 * @param fn - The async function to wrap
 * @param options - Configuration options for retry behavior
 * @returns A new function with the same signature that retries on transient errors
 *
 * @example
 * ```typescript
 * import { writeFile, readFile, mkdir } from 'fs/promises';
 *
 * // Create retryable versions of fs functions
 * const safeWriteFile = withRetryWrapper(writeFile, { maxRetries: 5 });
 * const safeReadFile = withRetryWrapper(readFile);
 * const safeMkdir = withRetryWrapper(mkdir);
 *
 * // Use them like normal
 * await safeWriteFile(path, content);
 * const data = await safeReadFile(path, 'utf8');
 * ```
 */
export function withRetryWrapper<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options?: RetryOptions
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => withRetry(() => fn(...args), options);
}
