/**
 * Simplified schema that only validates fields actually used in the codebase
 * while preserving all other fields through passthrough()
 */

import { z } from "zod";

// Usage statistics for assistant messages - used in apiSession.ts
export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative(),
  service_tier: z.string().optional(),
}).passthrough();

// Main schema with minimal validation for only the fields we use
// NOTE: Schema is intentionally lenient to handle various Claude Code message formats
// including synthetic error messages, API errors, and different SDK versions
export const RawJSONLinesSchema = z.discriminatedUnion("type", [
  // User message - validates uuid and message.content
  z.object({
    type: z.literal("user"),
    isSidechain: z.boolean().optional(),
    isMeta: z.boolean().optional(),
    uuid: z.string(), // Used in getMessageKey()
    message: z.object({
      content: z.union([z.string(), z.any()]) // Used in sessionScanner.ts
    }).passthrough()
  }).passthrough(),

  // Assistant message - only validates uuid and type
  // message object is optional to handle synthetic error messages (isApiErrorMessage: true)
  // which may have different structure than normal assistant messages
  z.object({
    uuid: z.string(),
    type: z.literal("assistant"),
    message: z.object({
      usage: UsageSchema.optional(), // Used in apiSession.ts
    }).passthrough().optional()
  }).passthrough(),

  // Summary message - validates summary and leafUuid
  z.object({
    type: z.literal("summary"),
    summary: z.string(), // Used in apiSession.ts
    leafUuid: z.string() // Used in getMessageKey()
  }).passthrough(),

  // System message - validates uuid
  z.object({
    type: z.literal("system"),
    uuid: z.string() // Used in getMessageKey()
  }).passthrough()
]);

export type RawJSONLines = z.infer<typeof RawJSONLinesSchema>


/**
 * Error thrown when JSON parsing fails with additional context for debugging.
 * Preserves the original error as `cause` to maintain stack trace.
 *
 * @property inputPreview - Truncated preview of the input string (for debugging, max 200 chars by default)
 * @property inputLength - Total length of the input string
 * @property originalError - The original Error thrown by JSON.parse()
 */
export class JsonParseError extends Error {
  constructor(
    message: string,
    public readonly inputPreview: string,
    public readonly inputLength: number,
    public readonly originalError: Error
  ) {
    super(message, { cause: originalError });
    this.name = 'JsonParseError';
  }
}

/**
 * Minimal logger interface for parseJsonWithContext.
 * Matches the signature of logger.debug() from '@/ui/logger'.
 */
export interface JsonParseLogger {
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Configuration for JSON parsing with context logging.
 */
export interface ParseJsonOptions {
  /**
   * Maximum characters to include in input preview (default: 200).
   * Truncation helps prevent logging sensitive data that might appear in malformed JSON.
   * Reduce this value for contexts where sensitive data may be present (e.g., auth tokens).
   */
  previewLength?: number;
  /** Label for the context in log messages (e.g., "session message", "SDK response") */
  context?: string;
  /** Logger instance for error logging. If not provided, no logging is done. */
  logger?: JsonParseLogger;
}

/**
 * Parses a JSON string with enhanced error context for debugging.
 *
 * When parsing fails, logs the input preview and length to help diagnose
 * malformed JSON issues. The thrown error includes the original error
 * as `cause` to preserve stack traces.
 *
 * Note: The type parameter T is not validated at runtime. For type safety,
 * combine with Zod schema validation after parsing.
 *
 * @param raw - The raw JSON string to parse
 * @param options - Configuration options
 * @returns The parsed JSON value (no runtime type validation - use Zod for type safety)
 * @throws {JsonParseError} When JSON parsing fails, with context included
 *
 * @example
 * ```typescript
 * import { logger } from '@/ui/logger';
 *
 * // Basic usage with logging
 * const data = parseJsonWithContext(rawLine, { logger });
 *
 * // With context for better log messages
 * const message = parseJsonWithContext(rawLine, {
 *   context: 'session message',
 *   logger
 * });
 *
 * // With Zod validation for type safety
 * const parsed = parseJsonWithContext(rawLine, { context: 'session', logger });
 * const validated = RawJSONLinesSchema.safeParse(parsed);
 * ```
 */
export function parseJsonWithContext<T = unknown>(
  raw: string,
  options: ParseJsonOptions = {}
): T {
  const { previewLength = 200, context = 'JSON', logger } = options;

  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const preview = raw.length > previewLength
      ? raw.slice(0, previewLength) + '...'
      : raw;

    const originalError = err instanceof Error ? err : new Error(String(err));

    // Log the error with context if logger is provided
    if (logger) {
      logger.debug(`[JSON_PARSE_ERROR] Failed to parse ${context}`, {
        error: originalError.message,
        inputPreview: preview,
        inputLength: raw.length
      });
    }

    throw new JsonParseError(
      `Invalid ${context}: ${originalError.message}`,
      preview,
      raw.length,
      originalError
    );
  }
}
