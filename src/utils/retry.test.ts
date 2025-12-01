/**
 * Tests for retry utility functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  TRANSIENT_FS_ERROR_CODES,
  withRetry,
  withRetryWrapper
} from './retry'

describe('retry utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('TRANSIENT_FS_ERROR_CODES', () => {
    it('should contain expected transient error codes', () => {
      expect(TRANSIENT_FS_ERROR_CODES).toContain('EBUSY')
      expect(TRANSIENT_FS_ERROR_CODES).toContain('EAGAIN')
      expect(TRANSIENT_FS_ERROR_CODES).toContain('EMFILE')
      expect(TRANSIENT_FS_ERROR_CODES).toContain('ENFILE')
    })

    it('should have exactly 4 transient error codes', () => {
      expect(TRANSIENT_FS_ERROR_CODES).toHaveLength(4)
    })
  })

  describe('withRetry', () => {
    describe('successful execution', () => {
      it('should return result on first successful attempt', async () => {
        const fn = vi.fn().mockResolvedValue('success')

        const result = await withRetry(fn)

        expect(result).toBe('success')
        expect(fn).toHaveBeenCalledTimes(1)
      })

      it('should return result after retrying on transient error', async () => {
        const error = new Error('Resource busy') as NodeJS.ErrnoException
        error.code = 'EBUSY'

        const fn = vi.fn()
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce('success')

        const resultPromise = withRetry(fn)
        await vi.advanceTimersByTimeAsync(100) // Initial delay
        const result = await resultPromise

        expect(result).toBe('success')
        expect(fn).toHaveBeenCalledTimes(2)
      })
    })

    describe('error handling', () => {
      it('should throw immediately on non-transient error', async () => {
        const error = new Error('Permission denied') as NodeJS.ErrnoException
        error.code = 'EACCES'

        const fn = vi.fn().mockRejectedValue(error)

        await expect(withRetry(fn)).rejects.toThrow('Permission denied')
        expect(fn).toHaveBeenCalledTimes(1)
      })

      it('should throw after exhausting all retries on transient error', async () => {
        vi.useRealTimers() // Use real timers to avoid promise issues

        const error = new Error('Resource busy') as NodeJS.ErrnoException
        error.code = 'EBUSY'

        const fn = vi.fn().mockRejectedValue(error)

        await expect(withRetry(fn, { maxRetries: 2, initialDelayMs: 1 })).rejects.toThrow('Resource busy')
        expect(fn).toHaveBeenCalledTimes(3) // Initial + 2 retries
      })

      it('should throw immediately on error without code', async () => {
        const error = new Error('Unknown error')
        const fn = vi.fn().mockRejectedValue(error)

        await expect(withRetry(fn)).rejects.toThrow('Unknown error')
        expect(fn).toHaveBeenCalledTimes(1)
      })
    })

    describe('retry behavior with different transient errors', () => {
      it.each([
        ['EBUSY', 'Resource busy'],
        ['EAGAIN', 'Try again'],
        ['EMFILE', 'Too many open files'],
        ['ENFILE', 'System file table overflow'],
      ])('should retry on %s error', async (code, message) => {
        const error = new Error(message) as NodeJS.ErrnoException
        error.code = code

        const fn = vi.fn()
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce('success')

        const resultPromise = withRetry(fn)
        await vi.advanceTimersByTimeAsync(100)
        const result = await resultPromise

        expect(result).toBe('success')
        expect(fn).toHaveBeenCalledTimes(2)
      })
    })

    describe('options', () => {
      it('should respect maxRetries option', async () => {
        vi.useRealTimers() // Use real timers to avoid promise issues

        const error = new Error('Busy') as NodeJS.ErrnoException
        error.code = 'EBUSY'

        const fn = vi.fn().mockRejectedValue(error)

        await expect(withRetry(fn, { maxRetries: 1, initialDelayMs: 1 })).rejects.toThrow('Busy')
        expect(fn).toHaveBeenCalledTimes(2) // Initial + 1 retry
      })

      it('should respect initialDelayMs option', async () => {
        const error = new Error('Busy') as NodeJS.ErrnoException
        error.code = 'EBUSY'

        const fn = vi.fn()
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce('success')

        const resultPromise = withRetry(fn, { initialDelayMs: 500 })

        // Should not have resolved yet at 400ms
        await vi.advanceTimersByTimeAsync(400)
        expect(fn).toHaveBeenCalledTimes(1)

        // Should resolve after 500ms
        await vi.advanceTimersByTimeAsync(100)
        const result = await resultPromise
        expect(result).toBe('success')
      })

      it('should use fixed delay when exponentialBackoff is false', async () => {
        const error = new Error('Busy') as NodeJS.ErrnoException
        error.code = 'EBUSY'

        const fn = vi.fn()
          .mockRejectedValueOnce(error)
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce('success')

        const resultPromise = withRetry(fn, {
          exponentialBackoff: false,
          initialDelayMs: 100
        })

        // First retry at 100ms
        await vi.advanceTimersByTimeAsync(100)
        expect(fn).toHaveBeenCalledTimes(2)

        // Second retry also at 100ms (not doubled)
        await vi.advanceTimersByTimeAsync(100)
        const result = await resultPromise
        expect(result).toBe('success')
        expect(fn).toHaveBeenCalledTimes(3)
      })

      it('should respect maxDelayMs cap with exponential backoff', async () => {
        vi.useRealTimers() // Use real timers for this test to avoid promise issues

        const error = new Error('Busy') as NodeJS.ErrnoException
        error.code = 'EBUSY'

        const fn = vi.fn().mockRejectedValue(error)

        // Use very short delays for the test
        await expect(withRetry(fn, {
          maxRetries: 2,
          initialDelayMs: 1,
          maxDelayMs: 2
        })).rejects.toThrow('Busy')

        // Verify the function was retried
        expect(fn).toHaveBeenCalledTimes(3) // Initial + 2 retries
      })

      it('should retry on additional error codes when specified', async () => {
        const error = new Error('Custom error') as NodeJS.ErrnoException
        error.code = 'CUSTOM_ERROR'

        const fn = vi.fn()
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce('success')

        const resultPromise = withRetry(fn, {
          additionalErrorCodes: ['CUSTOM_ERROR']
        })
        await vi.advanceTimersByTimeAsync(100)
        const result = await resultPromise

        expect(result).toBe('success')
        expect(fn).toHaveBeenCalledTimes(2)
      })
    })
  })

  describe('withRetryWrapper', () => {
    it('should create a retryable version of a function', async () => {
      const error = new Error('Busy') as NodeJS.ErrnoException
      error.code = 'EBUSY'

      const originalFn = vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce('result') as (arg: string) => Promise<string>

      const wrappedFn = withRetryWrapper(originalFn)

      const resultPromise = wrappedFn('arg')
      await vi.advanceTimersByTimeAsync(100)
      const result = await resultPromise

      expect(result).toBe('result')
      expect(originalFn).toHaveBeenCalledTimes(2)
      expect(originalFn).toHaveBeenCalledWith('arg')
    })

    it('should pass options to underlying withRetry', async () => {
      vi.useRealTimers() // Use real timers to avoid promise issues

      const error = new Error('Busy') as NodeJS.ErrnoException
      error.code = 'EBUSY'

      const originalFn = vi.fn().mockRejectedValue(error)

      const wrappedFn = withRetryWrapper(originalFn, { maxRetries: 1, initialDelayMs: 1 })

      await expect(wrappedFn()).rejects.toThrow('Busy')
      expect(originalFn).toHaveBeenCalledTimes(2)
    })

    it('should preserve function arguments', async () => {
      const originalFn = vi.fn()
        .mockResolvedValue('result') as (a: string, b: number, c: boolean) => Promise<string>

      const wrappedFn = withRetryWrapper(originalFn)

      const result = await wrappedFn('str', 42, true)

      expect(result).toBe('result')
      expect(originalFn).toHaveBeenCalledWith('str', 42, true)
    })
  })
})
