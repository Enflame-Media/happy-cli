/**
 * Unit tests for time utilities: delay(), exponentialBackoffDelay(), createBackoff()
 *
 * Tests cover the HAP-81 termination conditions that prevent infinite loops,
 * and the HAP-109 AbortController cancellation behavior.
 *
 * Note: These tests use real timers with short delays (no mocking per project conventions).
 */

import { describe, it, expect } from 'vitest';
import { delay, exponentialBackoffDelay, createBackoff, backoff, type BackoffFunc } from './time';

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

describe('delay', () => {
    it('should resolve after specified milliseconds', async () => {
        const start = Date.now();
        await delay(50);
        const elapsed = Date.now() - start;
        // Allow some tolerance for timing
        expect(elapsed).toBeGreaterThanOrEqual(45);
        expect(elapsed).toBeLessThan(150);
    });

    it('should reject immediately if signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(delay(1000, controller.signal)).rejects.toThrow('Aborted');

        const error = await getAsyncError<DOMException>(() => delay(1000, controller.signal));
        expect(error).toBeInstanceOf(DOMException);
        expect(error.name).toBe('AbortError');
    });

    it('should reject when signal is aborted during delay', async () => {
        const controller = new AbortController();

        const delayPromise = delay(1000, controller.signal);

        // Abort after a short delay
        setTimeout(() => controller.abort(), 20);

        await expect(delayPromise).rejects.toThrow('Aborted');

        const error = await getAsyncError<DOMException>(() => delay(1000, controller.signal));
        expect(error).toBeInstanceOf(DOMException);
        expect(error.name).toBe('AbortError');
    });

    it('should complete normally without abort signal', async () => {
        await expect(delay(10)).resolves.toBeUndefined();
    });

    it('should complete normally with non-aborted signal', async () => {
        const controller = new AbortController();
        await expect(delay(10, controller.signal)).resolves.toBeUndefined();
    });

    it('should clear timeout when abort fires (no memory leak)', async () => {
        // This test verifies that clearTimeout is called when the abort signal fires,
        // preventing the timeout from keeping references and causing memory leaks.
        // The implementation uses { once: true } on the abort listener to also
        // automatically clean up the event listener.

        const controller = new AbortController();

        // Start a long delay
        const delayPromise = delay(10000, controller.signal);

        // Abort immediately - the timeout should be cleared
        controller.abort();

        // The promise should reject with AbortError
        await expect(delayPromise).rejects.toThrow('Aborted');

        // If clearTimeout wasn't called, the timer would still be running.
        // We can't directly test clearTimeout was called without mocking,
        // but we can verify the delay resolves immediately (not after 10 seconds)
        // by checking the test completes quickly.

        // Additional verification: create another delay and verify it works correctly
        // (this ensures the abort handling didn't break the delay mechanism)
        const controller2 = new AbortController();
        const start = Date.now();
        await delay(10, controller2.signal);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(100); // Should complete in ~10ms, not 10 seconds
    });
});

describe('exponentialBackoffDelay', () => {
    it('should return value in range [0, minDelay] when currentFailureCount is 0', () => {
        // With 0 failures, maxDelayRet = minDelay
        // Result is Math.round(Math.random() * minDelay)
        // Since random is [0, 1), result should be in [0, minDelay]
        for (let i = 0; i < 20; i++) {
            const result = exponentialBackoffDelay(0, 100, 1000, 10);
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(100);
        }
    });

    it('should calculate delay proportional to failure count', () => {
        const minDelay = 100;
        const maxDelay = 1000;
        const maxFailureCount = 10;

        // Run multiple times to verify the range
        for (let i = 0; i < 20; i++) {
            const midResult = exponentialBackoffDelay(5, minDelay, maxDelay, maxFailureCount);
            // At 5 failures: maxDelayRet = 100 + ((1000 - 100) / 10) * 5 = 100 + 450 = 550
            expect(midResult).toBeGreaterThanOrEqual(0);
            expect(midResult).toBeLessThanOrEqual(550);
        }
    });

    it('should cap delay at maxDelay when currentFailureCount exceeds maxFailureCount', () => {
        const minDelay = 100;
        const maxDelay = 1000;
        const maxFailureCount = 10;

        // Run multiple times to verify the range
        for (let i = 0; i < 20; i++) {
            const result = exponentialBackoffDelay(15, minDelay, maxDelay, maxFailureCount);
            // At 15 failures (capped to 10): maxDelayRet = 100 + ((1000 - 100) / 10) * 10 = 1000
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(1000);
        }
    });

    it('should return values in expected range at max failures', () => {
        const minDelay = 250;
        const maxDelay = 1000;
        const maxFailureCount = 50;

        for (let i = 0; i < 20; i++) {
            const result = exponentialBackoffDelay(maxFailureCount, minDelay, maxDelay, maxFailureCount);
            // At max failures: maxDelayRet = 250 + ((1000 - 250) / 50) * 50 = 1000
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(1000);
        }
    });

    it('should handle edge case where minDelay equals maxDelay', () => {
        for (let i = 0; i < 10; i++) {
            const result = exponentialBackoffDelay(5, 500, 500, 10);
            // maxDelayRet = 500 + 0 * 5 = 500
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(500);
        }
    });

    it('should scale linearly from minDelay to maxDelay', () => {
        // Test that halfway through failures gives approximately halfway delay range
        const minDelay = 0;
        const maxDelay = 100;
        const maxFailureCount = 10;

        // At failure 5: maxDelayRet = 0 + ((100 - 0) / 10) * 5 = 50
        // At failure 10: maxDelayRet = 0 + ((100 - 0) / 10) * 10 = 100
        for (let i = 0; i < 20; i++) {
            const halfwayResult = exponentialBackoffDelay(5, minDelay, maxDelay, maxFailureCount);
            expect(halfwayResult).toBeLessThanOrEqual(50);

            const fullResult = exponentialBackoffDelay(10, minDelay, maxDelay, maxFailureCount);
            expect(fullResult).toBeLessThanOrEqual(100);
        }
    });
});

describe('createBackoff', () => {
    describe('core functionality', () => {
        it('should return callback result on success', async () => {
            const backoffFn = createBackoff();
            const result = await backoffFn(async () => 'success');
            expect(result).toBe('success');
        });

        it('should return numeric result on success', async () => {
            const backoffFn = createBackoff();
            const result = await backoffFn(async () => 42);
            expect(result).toBe(42);
        });

        it('should return object result on success', async () => {
            const backoffFn = createBackoff();
            const result = await backoffFn(async () => ({ key: 'value' }));
            expect(result).toEqual({ key: 'value' });
        });

        it('should retry on failure with exponential backoff delay', async () => {
            let attempts = 0;
            const backoffFn = createBackoff({ minDelay: 5, maxDelay: 20 });

            const result = await backoffFn(async () => {
                attempts++;
                if (attempts < 3) {
                    throw new Error('Temporary failure');
                }
                return 'success after retries';
            });

            expect(result).toBe('success after retries');
            expect(attempts).toBe(3);
        });

        it('should respect AbortSignal', async () => {
            const controller = new AbortController();
            const backoffFn = createBackoff();

            // Abort immediately
            controller.abort();

            await expect(backoffFn(async () => 'test', controller.signal)).rejects.toThrow(/Aborted/);
        });

        it('should abort during retry delay', async () => {
            const controller = new AbortController();
            const backoffFn = createBackoff({ minDelay: 100, maxDelay: 500 });

            let attempts = 0;
            const promise = backoffFn(async () => {
                attempts++;
                throw new Error('Always fails');
            }, controller.signal);

            // Abort after first failure starts delay
            setTimeout(() => controller.abort(), 50);

            await expect(promise).rejects.toThrow(/Aborted/);
            expect(attempts).toBeGreaterThanOrEqual(1);
        });

        it('should propagate AbortError from callback', async () => {
            const backoffFn = createBackoff();

            const error = await getAsyncError<DOMException>(() => backoffFn(async () => {
                throw new DOMException('Aborted', 'AbortError');
            }));
            expect(error).toBeInstanceOf(DOMException);
            expect(error.name).toBe('AbortError');
        });
    });

    describe('termination conditions (HAP-81 fix)', () => {
        it('should throw after maxFailureCount attempts exceeded', async () => {
            let attempts = 0;
            const backoffFn = createBackoff({
                maxFailureCount: 3,
                minDelay: 5,
                maxDelay: 10
            });

            await expect(backoffFn(async () => {
                attempts++;
                throw new Error('Always fails');
            })).rejects.toThrow('Backoff failed after 3 attempts');

            expect(attempts).toBe(3);
        });

        it('should throw after maxElapsedTime exceeded', async () => {
            let attempts = 0;
            const backoffFn = createBackoff({
                maxElapsedTime: 100,
                maxFailureCount: 1000, // High count so time limit triggers first
                minDelay: 20,
                maxDelay: 50
            });

            const start = Date.now();
            await expect(backoffFn(async () => {
                attempts++;
                throw new Error('Always fails');
            })).rejects.toThrow(/Backoff timeout after \d+ attempts/);

            const elapsed = Date.now() - start;
            expect(elapsed).toBeGreaterThanOrEqual(80); // Some tolerance
            expect(attempts).toBeGreaterThanOrEqual(1);
        });

        it('should include last error in timeout message', async () => {
            const backoffFn = createBackoff({
                maxElapsedTime: 50,
                maxFailureCount: 100,
                minDelay: 10,
                maxDelay: 20
            });

            await expect(backoffFn(async () => {
                throw new Error('Specific error message');
            })).rejects.toThrow('Specific error message');
        });

        it('should throw immediately when onError returns false', async () => {
            let attempts = 0;
            const errorHandler = (_e: any, count: number) => {
                if (count >= 2) return false; // Stop after 2 attempts
                return true;
            };

            const backoffFn = createBackoff({
                onError: errorHandler,
                minDelay: 5,
                maxDelay: 10
            });

            await expect(backoffFn(async () => {
                attempts++;
                throw new Error('Test error');
            })).rejects.toThrow('Test error');

            expect(attempts).toBe(2);
        });

        it('should continue retrying when onError returns undefined', async () => {
            let attempts = 0;
            const errorHandler = () => undefined; // Implicitly continue

            const backoffFn = createBackoff({
                onError: errorHandler,
                maxFailureCount: 3,
                minDelay: 5,
                maxDelay: 10
            });

            await expect(backoffFn(async () => {
                attempts++;
                throw new Error('Test error');
            })).rejects.toThrow('Backoff failed after 3 attempts');

            expect(attempts).toBe(3);
        });

        it('should continue retrying when onError returns true', async () => {
            let attempts = 0;
            const errorHandler = () => true;

            const backoffFn = createBackoff({
                onError: errorHandler,
                maxFailureCount: 3,
                minDelay: 5,
                maxDelay: 10
            });

            await expect(backoffFn(async () => {
                attempts++;
                throw new Error('Test error');
            })).rejects.toThrow('Backoff failed after 3 attempts');

            expect(attempts).toBe(3);
        });
    });

    describe('edge cases', () => {
        it('should succeed on first attempt without retries', async () => {
            let attempts = 0;
            const backoffFn = createBackoff();

            const result = await backoffFn(async () => {
                attempts++;
                return 'immediate success';
            });

            expect(result).toBe('immediate success');
            expect(attempts).toBe(1);
        });

        it('should respect custom minDelay and maxDelay', async () => {
            let attempts = 0;
            const backoffFn = createBackoff({
                minDelay: 10,
                maxDelay: 20,
                maxFailureCount: 3
            });

            const start = Date.now();
            await expect(backoffFn(async () => {
                attempts++;
                throw new Error('Fail');
            })).rejects.toThrow(/Fail/);

            const elapsed = Date.now() - start;
            // With 3 failures and delays between [0, ~15] each, total should be under 100ms
            expect(elapsed).toBeLessThan(200);
            expect(attempts).toBe(3);
        });

        it('should include last error in max failures message', async () => {
            const backoffFn = createBackoff({
                maxFailureCount: 2,
                minDelay: 5,
                maxDelay: 10
            });

            await expect(backoffFn(async () => {
                throw new Error('Unique error XYZ');
            })).rejects.toThrow('Unique error XYZ');
        });

        it('should make exactly 1 attempt when maxFailureCount is 1', async () => {
            let attempts = 0;
            const backoffFn = createBackoff({
                maxFailureCount: 1,
                minDelay: 5,
                maxDelay: 10
            });

            await expect(backoffFn(async () => {
                attempts++;
                throw new Error('Single attempt');
            })).rejects.toThrow('Backoff failed after 1 attempts');

            expect(attempts).toBe(1);
        });

        it('should call onError with error and failure count', async () => {
            const errors: Array<{ error: any; count: number }> = [];
            const backoffFn = createBackoff({
                onError: (e, count) => {
                    errors.push({ error: e, count });
                },
                maxFailureCount: 3,
                minDelay: 5,
                maxDelay: 10
            });

            await expect(backoffFn(async () => {
                throw new Error('Track me');
            })).rejects.toThrow('Track me');

            expect(errors).toHaveLength(3);
            expect(errors[0].count).toBe(1);
            expect(errors[1].count).toBe(2);
            expect(errors[2].count).toBe(3);
            expect(errors[0].error.message).toBe('Track me');
        });

        it('should use default options when none provided', async () => {
            const backoffFn = createBackoff();
            // Default maxFailureCount is 50, minDelay 250, maxDelay 1000

            let attempts = 0;
            const result = await backoffFn(async () => {
                attempts++;
                if (attempts === 1) throw new Error('First fail');
                return 'success';
            });

            expect(result).toBe('success');
            expect(attempts).toBe(2);
        });

        it('should check elapsed time before each attempt', async () => {
            // This test verifies that maxElapsedTime is checked BEFORE attempting,
            // not just after a failure
            const backoffFn = createBackoff({
                maxElapsedTime: 30,
                maxFailureCount: 100,
                minDelay: 50, // Delay longer than maxElapsedTime
                maxDelay: 50
            });

            let attempts = 0;
            await expect(backoffFn(async () => {
                attempts++;
                throw new Error('Fail');
            })).rejects.toThrow(/Backoff timeout/);

            // Should have made at least 1 attempt before timing out
            expect(attempts).toBeGreaterThanOrEqual(1);
        });
    });
});

describe('backoff (default instance)', () => {
    it('should be a BackoffFunc created with default options', async () => {
        // Verify it's a function with the right signature
        expect(typeof backoff).toBe('function');

        // Verify it works as expected
        const result = await backoff(async () => 'test');
        expect(result).toBe('test');
    });

    it('should have the correct type', () => {
        const fn: BackoffFunc = backoff;
        expect(fn).toBe(backoff);
    });

    it('should retry on failure', async () => {
        let attempts = 0;
        const result = await backoff(async () => {
            attempts++;
            if (attempts < 2) throw new Error('Retry');
            return 'recovered';
        });

        expect(result).toBe('recovered');
        expect(attempts).toBe(2);
    });
});
