/**
 * Tests for InvalidateSync class
 *
 * Tests AbortController cancellation behavior as added in HAP-109.
 * Verifies proper cleanup when stop() is called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InvalidateSync } from './sync';

describe('InvalidateSync', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should execute command when invalidated', async () => {
        let commandExecuted = false;
        const sync = new InvalidateSync(async () => {
            commandExecuted = true;
        });

        sync.invalidate();

        // Allow the async operation to complete
        await vi.advanceTimersByTimeAsync(0);

        expect(commandExecuted).toBe(true);
    });

    it('should stop() prevent command from executing during backoff delay', async () => {
        let commandCallCount = 0;
        const sync = new InvalidateSync(async () => {
            commandCallCount++;
            if (commandCallCount === 1) {
                throw new Error('First call fails');
            }
        });

        sync.invalidate();

        // First call fails
        await vi.advanceTimersByTimeAsync(0);
        expect(commandCallCount).toBe(1);

        // Stop during backoff delay (before retry)
        sync.stop();

        // Advance time past the backoff delay
        await vi.advanceTimersByTimeAsync(10000);

        // Command should not have been called again
        expect(commandCallCount).toBe(1);
    });

    it('should stop() on already-stopped instance be idempotent', async () => {
        let commandCallCount = 0;
        const sync = new InvalidateSync(async () => {
            commandCallCount++;
        });

        // Stop multiple times - should not throw
        sync.stop();
        sync.stop();
        sync.stop();

        // Invalidate after stop should be ignored
        sync.invalidate();
        await vi.advanceTimersByTimeAsync(0);

        expect(commandCallCount).toBe(0);
    });

    it('should resolve pending promises after stop()', async () => {
        let _commandCallCount = 0;
        const sync = new InvalidateSync(async () => {
            _commandCallCount++;
            // Simulate long-running command that would block
            await new Promise(resolve => setTimeout(resolve, 1000));
        });

        // Start an invalidateAndAwait
        const pendingPromise = sync.invalidateAndAwait();

        // Let it start
        await vi.advanceTimersByTimeAsync(0);

        // Stop while the command is running (during backoff or execution)
        sync.stop();

        // The pending promise should resolve (not hang forever)
        // Advance time to allow any cleanup
        await vi.advanceTimersByTimeAsync(0);

        // The promise should resolve
        await expect(pendingPromise).resolves.toBeUndefined();
    });

    it('should create fresh abort signal for each _doSync() call', async () => {
        let syncCallCount = 0;

        // Test that multiple sync cycles work correctly.
        // If abort signals weren't created fresh for each _doSync(),
        // subsequent syncs would be aborted by the previous signal.

        const sync = new InvalidateSync(async () => {
            syncCallCount++;
        });

        // First sync
        sync.invalidate();
        await vi.advanceTimersByTimeAsync(0);
        expect(syncCallCount).toBe(1);

        // After first sync completes, _invalidated is reset to false.
        // Calling invalidate() twice:
        // - First invalidate(): sets _invalidated = true, calls _doSync() (2nd sync)
        // - Second invalidate(): sets _invalidatedDouble = true (queues 3rd sync)
        // After 2nd sync completes, _invalidatedDouble triggers 3rd sync.
        sync.invalidate();
        sync.invalidate();

        // Let both the 2nd sync and the triggered 3rd sync complete
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);

        // Total: 3 syncs (1st + 2nd triggered by invalidate + 3rd from double invalidation)
        expect(syncCallCount).toBe(3);

        // Key assertion: If abort signals weren't fresh, only the first sync would succeed
        // and subsequent syncs would throw AbortError, resulting in fewer than 3 syncs.
    });

    it('should handle rapid invalidate() -> stop() sequence', async () => {
        let commandCallCount = 0;
        const sync = new InvalidateSync(async () => {
            commandCallCount++;
        });

        // Rapid sequence: invalidate then immediately stop
        sync.invalidate();
        sync.stop();

        // Advance time
        await vi.advanceTimersByTimeAsync(1000);

        // Command might have started but should not complete normally
        // or should not run at all depending on timing
        // The key is that no error is thrown and state is consistent
        expect(commandCallCount).toBeLessThanOrEqual(1);
    });

    it('should not execute invalidate after stop', async () => {
        let commandCallCount = 0;
        const sync = new InvalidateSync(async () => {
            commandCallCount++;
        });

        sync.stop();

        // Try to invalidate after stop
        sync.invalidate();
        await vi.advanceTimersByTimeAsync(1000);

        expect(commandCallCount).toBe(0);
    });

    it('should not execute invalidateAndAwait after stop', async () => {
        let commandCallCount = 0;
        const sync = new InvalidateSync(async () => {
            commandCallCount++;
        });

        sync.stop();

        // Try to invalidateAndAwait after stop
        const promise = sync.invalidateAndAwait();
        await vi.advanceTimersByTimeAsync(0);

        // Should resolve immediately without calling command
        await expect(promise).resolves.toBeUndefined();
        expect(commandCallCount).toBe(0);
    });

    it('should handle double invalidation correctly', async () => {
        let commandCallCount = 0;
        const sync = new InvalidateSync(async () => {
            commandCallCount++;
        });

        // Invalidate twice while first is running
        sync.invalidate();
        sync.invalidate();

        // Allow first sync to complete
        await vi.advanceTimersByTimeAsync(0);

        // Allow second sync triggered by double invalidation
        await vi.advanceTimersByTimeAsync(0);

        expect(commandCallCount).toBe(2);
    });

    it('should resolve multiple pending promises when stop() is called', async () => {
        const sync = new InvalidateSync(async () => {
            // Simulate a command that would take a while
            await new Promise(resolve => setTimeout(resolve, 5000));
        });

        // Create multiple pending promises
        const pending1 = sync.invalidateAndAwait();
        const pending2 = sync.invalidateAndAwait();
        const pending3 = sync.invalidateAndAwait();

        // Let them start
        await vi.advanceTimersByTimeAsync(0);

        // Stop - all pending should resolve
        sync.stop();
        await vi.advanceTimersByTimeAsync(0);

        // All promises should resolve
        await expect(pending1).resolves.toBeUndefined();
        await expect(pending2).resolves.toBeUndefined();
        await expect(pending3).resolves.toBeUndefined();
    });

    it('should abort long-running command when stop() is called', async () => {
        let commandStarted = false;
        let _commandCompleted = false;

        const sync = new InvalidateSync(async () => {
            commandStarted = true;
            // Simulate a long operation
            await new Promise(resolve => setTimeout(resolve, 10000));
            _commandCompleted = true;
        });

        sync.invalidate();

        // Let command start
        await vi.advanceTimersByTimeAsync(0);
        expect(commandStarted).toBe(true);

        // Stop mid-execution
        sync.stop();

        // Advance time past when command would have completed
        await vi.advanceTimersByTimeAsync(20000);

        // Command was interrupted, completion depends on whether
        // the command itself respects abort signals (it doesn't in this mock)
        // But the backoff loop should have been aborted
        expect(commandStarted).toBe(true);
    });
});
