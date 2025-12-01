/**
 * Zod error formatting utilities for user-friendly validation messages.
 *
 * Transforms technical ZodError messages into human-readable format while
 * filtering out sensitive field values from error output.
 */

import { ZodError, ZodIssue, ZodSchema } from 'zod'
import { AppError, ErrorCodes } from '@/utils/errors'

/**
 * Field name patterns considered sensitive - values will be redacted from errors.
 * Uses case-insensitive substring matching against field path segments.
 */
const SENSITIVE_FIELD_PATTERNS = [
  'key',
  'secret',
  'token',
  'password',
  'credential',
  'encryption',
  'private',
  'auth'
] as const

/**
 * Check if a field path contains any sensitive patterns.
 * Matches against individual path segments (e.g., 'encryption.publicKey' checks both).
 * ZodIssue.path is typed as PropertyKey[] which can include symbols, though in practice
 * it's typically string | number for object keys and array indices.
 */
function isSensitivePath(path: readonly PropertyKey[]): boolean {
  return path.some(segment => {
    if (typeof segment !== 'string') return false
    const lower = segment.toLowerCase()
    return SENSITIVE_FIELD_PATTERNS.some(pattern => lower.includes(pattern))
  })
}

/**
 * Formats a Zod error into a user-friendly string.
 *
 * - Groups errors by field path
 * - Redacts sensitive field names from detailed errors
 * - Provides clear, actionable messages
 *
 * @param error The ZodError to format
 * @returns Human-readable error string
 *
 * @example
 * // For an invalid session object:
 * formatZodError(error)
 * // => "id: Expected string, received number; metadata.path: Required"
 */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue: ZodIssue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'

      // For sensitive fields, provide less specific error info
      if (isSensitivePath(issue.path)) {
        return `${path}: Invalid value`
      }

      return `${path}: ${issue.message}`
    })
    .join('; ')
}

/**
 * Result type for safeParseWithError - mirrors ZodSafeParseReturnType
 * but with a formatted error string instead of ZodError.
 */
export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

/**
 * Wraps Zod's safeParse with user-friendly error formatting.
 *
 * Use this instead of .parse() when you want to handle errors gracefully
 * without exposing technical ZodError details.
 *
 * @param schema The Zod schema to validate against
 * @param data The data to validate
 * @param contextName Optional name for the data being validated (improves error context)
 * @returns SafeParseResult with either data or formatted error string
 *
 * @example
 * const result = safeParseWithError(SessionSchema, rawData, 'session')
 * if (!result.success) {
 *   console.error(`Invalid session: ${result.error}`)
 * }
 */
export function safeParseWithError<T>(
  schema: ZodSchema<T>,
  data: unknown,
  contextName?: string
): SafeParseResult<T> {
  const result = schema.safeParse(data)

  if (result.success) {
    return { success: true, data: result.data }
  }

  const formatted = formatZodError(result.error)
  const prefix = contextName ? `Invalid ${contextName}: ` : ''

  return { success: false, error: `${prefix}${formatted}` }
}

/**
 * Parse data with a Zod schema, throwing a user-friendly error on failure.
 *
 * This is a drop-in replacement for schema.parse() that throws an Error
 * with a formatted message instead of throwing raw ZodError.
 *
 * @param schema The Zod schema to validate against
 * @param data The data to validate
 * @param contextName Optional name for the data being validated
 * @returns The validated and typed data
 * @throws Error with user-friendly message if validation fails
 *
 * @example
 * // Instead of: SessionSchema.parse(data)
 * const session = parseWithFriendlyError(SessionSchema, data, 'session')
 */
export function parseWithFriendlyError<T>(
  schema: ZodSchema<T>,
  data: unknown,
  contextName?: string
): T {
  const result = safeParseWithError(schema, data, contextName)

  if (!result.success) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, result.error)
  }

  return result.data
}

/**
 * Creates a custom error class for validation failures.
 * Useful when you need to distinguish validation errors from other errors.
 */
export class ValidationError extends Error {
  constructor(message: string, public readonly fieldErrors: string[]) {
    super(message)
    this.name = 'ValidationError'
  }

  /**
   * Create a ValidationError from a ZodError
   */
  static fromZodError(error: ZodError, contextName?: string): ValidationError {
    const fieldErrors = error.issues.map((issue: ZodIssue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      if (isSensitivePath(issue.path)) {
        return `${path}: Invalid value`
      }
      return `${path}: ${issue.message}`
    })

    const message = contextName
      ? `Invalid ${contextName}: ${fieldErrors.join('; ')}`
      : fieldErrors.join('; ')

    return new ValidationError(message, fieldErrors)
  }
}
