/**
 * Tests for PushableAsyncIterable
 */

import { describe, it, expect } from 'vitest'
import { PushableAsyncIterable } from './PushableAsyncIterable'

/** Helper to capture async errors for testing - avoids no-conditional-expect lint warnings */
async function getAsyncError<T extends Error>(fn: () => Promise<unknown>): Promise<T> {
  try {
    await fn();
    throw new Error('Expected function to throw but it did not');
  } catch (e) {
    if (e instanceof Error && e.message === 'Expected function to throw but it did not') {
      throw e;
    }
    return e as T;
  }
}

describe('PushableAsyncIterable', () => {
    it('should push and consume values', async () => {
        const iterable = new PushableAsyncIterable<number>()
        const results: number[] = []

        // Start consuming
        const consumer = (async () => {
            for await (const value of iterable) {
                results.push(value)
                if (results.length === 3) {
                    break
                }
            }
        })()

        // Push values
        iterable.push(1)
        iterable.push(2)
        iterable.push(3)

        await consumer
        expect(results).toEqual([1, 2, 3])
    })

    it('should handle async pushing', async () => {
        const iterable = new PushableAsyncIterable<string>()
        const results: string[] = []

        // Start consuming
        const consumer = (async () => {
            for await (const value of iterable) {
                results.push(value)
            }
        })()

        // Push values asynchronously
        await Promise.resolve()
        iterable.push('first')
        
        await new Promise(resolve => setTimeout(resolve, 10))
        iterable.push('second')
        
        await new Promise(resolve => setTimeout(resolve, 10))
        iterable.push('third')
        iterable.end()

        await consumer
        expect(results).toEqual(['first', 'second', 'third'])
    })

    it('should handle errors', async () => {
        const iterable = new PushableAsyncIterable<number>()
        const error = new Error('Test error')

        const consumer = (async () => {
            const values: number[] = []
            const caughtError = await getAsyncError<Error>(async () => {
                for await (const value of iterable) {
                    values.push(value)
                }
            });
            return { values, caughtError };
        })()

        iterable.push(1)
        iterable.push(2)
        iterable.setError(error)

        const result = await consumer
        expect(result.caughtError).toBe(error)
        expect(result.values).toEqual([1, 2])
    })

    it('should handle external error control', async () => {
        const iterable = new PushableAsyncIterable<number>()

        const consumer = (async () => {
            const values: number[] = []
            const caughtError = await getAsyncError<Error>(async () => {
                for await (const value of iterable) {
                    values.push(value)
                    if (value === 2) {
                        // Set error externally after second value
                        iterable.setError(new Error('External abort'))
                    }
                }
            });
            return { values, caughtError };
        })()

        iterable.push(1)
        iterable.push(2)

        const result = await consumer
        expect(result.caughtError.message).toBe('External abort')
        expect(result.values).toEqual([1, 2])
    })

    it('should queue values when no consumer is waiting', async () => {
        const iterable = new PushableAsyncIterable<number>()
        
        // Push values before consumer starts
        iterable.push(1)
        iterable.push(2)
        iterable.push(3)
        iterable.end()

        // Start consuming
        const results: number[] = []
        for await (const value of iterable) {
            results.push(value)
        }

        expect(results).toEqual([1, 2, 3])
    })

    it('should throw when pushing to completed iterable', () => {
        const iterable = new PushableAsyncIterable<number>()
        iterable.end()
        
        expect(() => iterable.push(1)).toThrow('Cannot push to completed iterable')
    })

    it('should only allow single iteration', async () => {
        const iterable = new PushableAsyncIterable<number>()

        // First iteration is fine
        const _iterator1 = iterable[Symbol.asyncIterator]()

        // Second iteration should throw
        expect(() => iterable[Symbol.asyncIterator]()).toThrow('PushableAsyncIterable can only be iterated once')
    })

    it('should provide queue and waiter status', async () => {
        const iterable = new PushableAsyncIterable<number>()

        // Push values - they should be queued
        iterable.push(1)
        iterable.push(2)
        expect(iterable.queueSize).toBe(2)
        expect(iterable.waiterCount).toBe(0)

        // Start consuming
        let queueSizeAfterConsuming2 = -1
        let waiterCountBeforeEnd = -1

        const consumer = (async () => {
            for await (const value of iterable) {
                if (value === 2) {
                    // After consuming 2 values, queue should be empty
                    queueSizeAfterConsuming2 = iterable.queueSize
                    // The for-await loop will now block waiting for more values
                    // We'll check the waiter count from outside after a delay
                }
                if (value === 3) {
                    break // This shouldn't happen, but just in case
                }
            }
        })()

        // Wait a bit for the consumer to block on the next iteration
        await new Promise(resolve => setTimeout(resolve, 10))

        // Now the consumer should be waiting for more values
        waiterCountBeforeEnd = iterable.waiterCount

        // End the iterator to complete the consumer
        iterable.end()
        await consumer

        // Assertions at top level (not inside conditional)
        expect(queueSizeAfterConsuming2).toBe(0)
        expect(waiterCountBeforeEnd).toBe(1)
    })
})