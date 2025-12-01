/**
 * Tests for Zod error formatting utilities
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  formatZodError,
  safeParseWithError,
  parseWithFriendlyError,
  ValidationError
} from './zodErrors'

/** Helper to capture thrown errors for testing - avoids no-conditional-expect lint warnings */
function getError<T extends Error>(fn: () => unknown): T {
  try {
    fn();
    throw new Error('Expected function to throw but it did not');
  } catch (e) {
    if (e instanceof Error && e.message === 'Expected function to throw but it did not') {
      throw e;
    }
    return e as T;
  }
}

describe('formatZodError', () => {
  it('formats simple field errors', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number()
    })

    const result = schema.safeParse({ name: 123, age: 'not a number' })
    expect(result.success).toBe(false)
    const formatted = formatZodError((result as any).error)
    expect(formatted).toContain('name')
    expect(formatted).toContain('age')
  })

  it('formats nested field errors with dot notation', () => {
    const schema = z.object({
      user: z.object({
        profile: z.object({
          email: z.string().email()
        })
      })
    })

    const result = schema.safeParse({
      user: { profile: { email: 'not-an-email' } }
    })
    expect(result.success).toBe(false)
    const formatted = formatZodError((result as any).error)
    expect(formatted).toContain('user.profile.email')
  })

  it('redacts sensitive field names containing "key"', () => {
    const schema = z.object({
      publicKey: z.string(),
      machineKey: z.string()
    })

    const result = schema.safeParse({ publicKey: 123, machineKey: 456 })
    expect(result.success).toBe(false)
    const formatted = formatZodError((result as any).error)
    // Should show field name but redact specific error details
    expect(formatted).toContain('publicKey: Invalid value')
    expect(formatted).toContain('machineKey: Invalid value')
    // Should NOT contain the actual error message
    expect(formatted).not.toContain('Expected string')
  })

  it('redacts sensitive field names containing "secret"', () => {
    const schema = z.object({
      secret: z.string()
    })

    const result = schema.safeParse({ secret: 123 })
    expect(result.success).toBe(false)
    const formatted = formatZodError((result as any).error)
    expect(formatted).toContain('secret: Invalid value')
  })

  it('redacts sensitive field names containing "token"', () => {
    const schema = z.object({
      authToken: z.string()
    })

    const result = schema.safeParse({ authToken: 123 })
    expect(result.success).toBe(false)
    const formatted = formatZodError((result as any).error)
    expect(formatted).toContain('authToken: Invalid value')
  })

  it('redacts nested sensitive fields', () => {
    const schema = z.object({
      encryption: z.object({
        publicKey: z.string()
      })
    })

    const result = schema.safeParse({ encryption: { publicKey: 123 } })
    expect(result.success).toBe(false)
    const formatted = formatZodError((result as any).error)
    // Both 'encryption' and 'publicKey' are sensitive patterns
    expect(formatted).toContain('encryption.publicKey: Invalid value')
  })

  it('shows detailed errors for non-sensitive fields', () => {
    const schema = z.object({
      hostname: z.string(),
      port: z.number().positive()
    })

    const result = schema.safeParse({ hostname: 123, port: -1 })
    expect(result.success).toBe(false)
    const formatted = formatZodError((result as any).error)
    // Non-sensitive fields should have detailed error messages
    expect(formatted).toContain('hostname:')
    expect(formatted).toContain('port:')
  })
})

describe('safeParseWithError', () => {
  it('returns success with data on valid input', () => {
    const schema = z.object({ name: z.string() })
    const result = safeParseWithError(schema, { name: 'test' })

    expect(result.success).toBe(true)
    expect((result as any).data).toEqual({ name: 'test' })
  })

  it('returns failure with formatted error on invalid input', () => {
    const schema = z.object({ name: z.string() })
    const result = safeParseWithError(schema, { name: 123 })

    expect(result.success).toBe(false)
    expect((result as any).error).toContain('name')
  })

  it('includes context name in error message', () => {
    const schema = z.object({ name: z.string() })
    const result = safeParseWithError(schema, { name: 123 }, 'user profile')

    expect(result.success).toBe(false)
    expect((result as any).error).toContain('Invalid user profile')
  })
})

describe('parseWithFriendlyError', () => {
  it('returns data on valid input', () => {
    const schema = z.object({ name: z.string() })
    const data = parseWithFriendlyError(schema, { name: 'test' })

    expect(data).toEqual({ name: 'test' })
  })

  it('throws Error with user-friendly message on invalid input', () => {
    const schema = z.object({ name: z.string() })

    expect(() => parseWithFriendlyError(schema, { name: 123 }))
      .toThrow('name:')
  })

  it('includes context name in thrown error', () => {
    const schema = z.object({ name: z.string() })

    expect(() => parseWithFriendlyError(schema, { name: 123 }, 'config'))
      .toThrow('Invalid config')
  })

  it('does NOT throw ZodError', () => {
    const schema = z.object({ name: z.string() })

    const error = getError<Error>(() => parseWithFriendlyError(schema, { name: 123 }))
    // Should be a regular Error, not a ZodError
    expect(error).toBeInstanceOf(Error)
    expect((error as any).issues).toBeUndefined() // ZodError has .issues
  })
})

describe('ValidationError', () => {
  it('is an instance of Error', () => {
    const error = new ValidationError('test', ['field1: error'])
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ValidationError')
  })

  it('contains field errors array', () => {
    const error = new ValidationError('test', ['field1: error1', 'field2: error2'])
    expect(error.fieldErrors).toEqual(['field1: error1', 'field2: error2'])
  })

  it('can be created from ZodError', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number()
    })

    const result = schema.safeParse({ name: 123, age: 'string' })
    expect(result.success).toBe(false)
    const error = ValidationError.fromZodError((result as any).error, 'user')
    expect(error).toBeInstanceOf(ValidationError)
    expect(error.message).toContain('Invalid user')
    expect(error.fieldErrors.length).toBe(2)
  })

  it('redacts sensitive fields when created from ZodError', () => {
    const schema = z.object({
      password: z.string().min(8)
    })

    const result = schema.safeParse({ password: 'short' })
    expect(result.success).toBe(false)
    const error = ValidationError.fromZodError((result as any).error)
    expect(error.fieldErrors[0]).toContain('password: Invalid value')
    expect(error.fieldErrors[0]).not.toContain('at least 8')
  })
})
