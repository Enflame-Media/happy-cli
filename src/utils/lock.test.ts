import { describe, it, expect } from 'vitest';
import { AsyncLock, LockTimeoutError } from './lock';

describe('AsyncLock', () => {
    describe('inLock', () => {
        it('should execute function and return result', async () => {
            const lock = new AsyncLock();
            const result = await lock.inLock(() => 'hello');
            expect(result).toBe('hello');
        });

        it('should execute async function and return result', async () => {
            const lock = new AsyncLock();
            const result = await lock.inLock(async () => {
                return 'async hello';
            });
            expect(result).toBe('async hello');
        });

        it('should serialize concurrent operations', async () => {
            const lock = new AsyncLock();
            const executionOrder: number[] = [];

            // Start two operations concurrently
            const op1 = lock.inLock(async () => {
                executionOrder.push(1);
                await new Promise(resolve => setTimeout(resolve, 50));
                executionOrder.push(2);
                return 'op1';
            });

            const op2 = lock.inLock(async () => {
                executionOrder.push(3);
                await new Promise(resolve => setTimeout(resolve, 10));
                executionOrder.push(4);
                return 'op2';
            });

            const [result1, result2] = await Promise.all([op1, op2]);

            expect(result1).toBe('op1');
            expect(result2).toBe('op2');
            // op1 should complete (1, 2) before op2 starts (3, 4)
            expect(executionOrder).toEqual([1, 2, 3, 4]);
        });

        it('should release lock even if function throws', async () => {
            const lock = new AsyncLock();

            // First operation throws
            await expect(lock.inLock(async () => {
                throw new Error('Test error');
            })).rejects.toThrow('Test error');

            // Second operation should still acquire lock
            const result = await lock.inLock(() => 'after error');
            expect(result).toBe('after error');
        });

        it('should release lock even if async function throws', async () => {
            const lock = new AsyncLock();

            // First operation throws after async work
            await expect(lock.inLock(async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                throw new Error('Async error');
            })).rejects.toThrow('Async error');

            // Second operation should still acquire lock
            const result = await lock.inLock(() => 'after async error');
            expect(result).toBe('after async error');
        });
    });

    describe('timeout behavior', () => {
        it('should throw LockTimeoutError when timeout exceeded', async () => {
            const lock = new AsyncLock();

            // Hold the lock for longer than the timeout
            const holdLockPromise = lock.inLock(async () => {
                await new Promise(resolve => setTimeout(resolve, 200));
                return 'done';
            });

            // Try to acquire with short timeout - should fail
            const timeoutPromise = lock.inLock(() => 'should timeout', 50);

            await expect(timeoutPromise).rejects.toThrow(LockTimeoutError);

            // Let the holding operation complete
            await holdLockPromise;
        });

        it('should acquire lock before timeout expires', async () => {
            const lock = new AsyncLock();

            // Hold lock briefly
            const holdPromise = lock.inLock(async () => {
                await new Promise(resolve => setTimeout(resolve, 30));
                return 'held';
            });

            // Wait with longer timeout - should succeed
            const waitPromise = lock.inLock(() => 'acquired', 500);

            const [holdResult, waitResult] = await Promise.all([holdPromise, waitPromise]);

            expect(holdResult).toBe('held');
            expect(waitResult).toBe('acquired');
        });

        it('should wait indefinitely when no timeout specified', async () => {
            const lock = new AsyncLock();
            const acquired: string[] = [];

            // Hold lock
            const holdPromise = lock.inLock(async () => {
                acquired.push('hold-start');
                await new Promise(resolve => setTimeout(resolve, 100));
                acquired.push('hold-end');
                return 'held';
            });

            // Wait without timeout (should eventually acquire)
            const waitPromise = lock.inLock(async () => {
                acquired.push('wait-acquired');
                return 'waited';
            });

            const [holdResult, waitResult] = await Promise.all([holdPromise, waitPromise]);

            expect(holdResult).toBe('held');
            expect(waitResult).toBe('waited');
            expect(acquired).toEqual(['hold-start', 'hold-end', 'wait-acquired']);
        });
    });

    describe('queue ordering', () => {
        it('should process waiters in FIFO order', async () => {
            const lock = new AsyncLock();
            const order: number[] = [];

            // Hold lock
            const hold = lock.inLock(async () => {
                await new Promise(resolve => setTimeout(resolve, 50));
                order.push(0);
            });

            // Queue up multiple waiters
            const waiter1 = lock.inLock(async () => {
                order.push(1);
            });
            const waiter2 = lock.inLock(async () => {
                order.push(2);
            });
            const waiter3 = lock.inLock(async () => {
                order.push(3);
            });

            await Promise.all([hold, waiter1, waiter2, waiter3]);

            // Should be processed in order they were queued
            expect(order).toEqual([0, 1, 2, 3]);
        });
    });

    describe('concurrent stress test', () => {
        it('should handle many concurrent operations correctly', async () => {
            const lock = new AsyncLock();
            let counter = 0;
            const results: number[] = [];

            // Create 10 concurrent increment operations
            const operations = Array.from({ length: 10 }, () =>
                lock.inLock(async () => {
                    const current = counter;
                    // Simulate some async work
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
                    counter = current + 1;
                    results.push(counter);
                    return counter;
                })
            );

            await Promise.all(operations);

            // All operations should have serialized correctly
            expect(counter).toBe(10);
            // Results should be monotonically increasing
            for (let i = 1; i < results.length; i++) {
                expect(results[i]).toBeGreaterThan(results[i - 1]);
            }
        });

        it('should maintain data consistency under concurrent read-modify-write', async () => {
            const lock = new AsyncLock();
            let state = { value: 0, updates: [] as number[] };

            // Multiple concurrent updates
            const updates = Array.from({ length: 5 }, () =>
                lock.inLock(async () => {
                    const oldValue = state.value;
                    // Simulate network latency
                    await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 10));
                    state.value = oldValue + 1;
                    state.updates.push(state.value);
                    return state.value;
                })
            );

            const finalValues = await Promise.all(updates);

            // Final state should be 5
            expect(state.value).toBe(5);
            // Each update should have incremented
            expect(state.updates).toEqual([1, 2, 3, 4, 5]);
            // Return values should match updates
            expect(finalValues).toEqual([1, 2, 3, 4, 5]);
        });
    });
});

describe('LockTimeoutError', () => {
    it('should have correct name and message', () => {
        const error = new LockTimeoutError();
        expect(error.name).toBe('LockTimeoutError');
        expect(error.message).toBe('Lock acquisition timeout');
    });

    it('should accept custom message', () => {
        const error = new LockTimeoutError('Custom timeout message');
        expect(error.name).toBe('LockTimeoutError');
        expect(error.message).toBe('Custom timeout message');
    });

    it('should be instanceof Error', () => {
        const error = new LockTimeoutError();
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(LockTimeoutError);
    });
});
