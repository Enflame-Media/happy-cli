/**
 * Input validation utilities for CLI arguments and environment variables.
 * Provides consistent validation with clear error messages.
 */

import { z } from 'zod'

/**
 * Valid values for --started-by CLI argument
 */
export const STARTED_BY_VALUES = ['daemon', 'terminal'] as const
export type StartedByValue = typeof STARTED_BY_VALUES[number]

/**
 * Zod schema for validating --started-by argument
 */
export const startedBySchema = z.enum(STARTED_BY_VALUES)

/**
 * Validates the --started-by CLI argument.
 * @param value The raw string value from CLI
 * @returns The validated value
 * @throws Error with clear message if invalid
 */
export function validateStartedBy(value: string): StartedByValue {
  const result = startedBySchema.safeParse(value)
  if (!result.success) {
    throw new Error(
      `Invalid --started-by value: "${value}". Must be one of: ${STARTED_BY_VALUES.join(', ')}`
    )
  }
  return result.data
}

/**
 * Options for validating positive integers
 */
export interface ValidateIntegerOptions {
  /** Minimum allowed value (inclusive). Defaults to 1. */
  min?: number
  /** Maximum allowed value (inclusive). */
  max?: number
  /** Default value to use if input is undefined/empty. */
  defaultValue?: number
}

/**
 * Validates that a string represents a valid positive integer within bounds.
 * Used for environment variables and CLI arguments that expect numeric values.
 *
 * @param value The raw string value to validate
 * @param name Human-readable name for error messages (e.g., "HAPPY_DAEMON_HTTP_TIMEOUT")
 * @param options Validation options including min, max, and default
 * @returns The parsed integer value
 * @throws Error with clear message if invalid
 */
export function validatePositiveInteger(
  value: string | undefined,
  name: string,
  options: ValidateIntegerOptions = {}
): number {
  const { min = 1, max, defaultValue } = options

  // Handle undefined/empty with default
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) {
      return defaultValue
    }
    throw new Error(`${name} is required but was not provided`)
  }

  const parsed = parseInt(value, 10)

  if (isNaN(parsed)) {
    throw new Error(
      `Invalid ${name}: "${value}". Must be a valid integer.`
    )
  }

  if (parsed < min) {
    throw new Error(
      `Invalid ${name}: ${parsed}. Must be at least ${min}.`
    )
  }

  if (max !== undefined && parsed > max) {
    throw new Error(
      `Invalid ${name}: ${parsed}. Must be at most ${max}.`
    )
  }

  return parsed
}

/**
 * Validates a port number (1-65535).
 *
 * @param value The raw string value to validate
 * @param name Human-readable name for error messages (e.g., "--port")
 * @returns The parsed port number
 * @throws Error with clear message if invalid
 */
export function validatePort(value: string, name: string = 'port'): number {
  return validatePositiveInteger(value, name, { min: 1, max: 65535 })
}

/**
 * Validates a timeout value in milliseconds.
 * Must be a positive integer (>= 0 for no timeout, or >= 1 for actual timeout).
 *
 * @param value The raw string value to validate
 * @param name Human-readable name for error messages
 * @param options Validation options. Defaults to min: 0 (allow 0 for "no timeout")
 * @returns The parsed timeout value
 * @throws Error with clear message if invalid
 */
export function validateTimeout(
  value: string | undefined,
  name: string,
  options: Omit<ValidateIntegerOptions, 'min'> & { min?: number } = {}
): number {
  const { min = 0, ...rest } = options
  return validatePositiveInteger(value, name, { min, ...rest })
}

/**
 * Validates a heartbeat interval in milliseconds.
 * Must be at least 1000ms (1 second) to prevent excessive server load.
 *
 * @param value The raw string value to validate
 * @param name Human-readable name for error messages
 * @param options Validation options. Defaults to min: 1000
 * @returns The parsed interval value
 * @throws Error with clear message if invalid
 */
export function validateHeartbeatInterval(
  value: string | undefined,
  name: string,
  options: Omit<ValidateIntegerOptions, 'min'> & { min?: number } = {}
): number {
  const { min = 1000, ...rest } = options
  return validatePositiveInteger(value, name, { min, ...rest })
}
