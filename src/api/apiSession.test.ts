/**
 * Unit tests for ApiSessionClient concurrent state update handling
 *
 * These tests verify that the race condition fixes from HAP-50 work correctly:
 * 1. Concurrent updateMetadata calls serialize properly
 * 2. Concurrent updateAgentState calls serialize properly
 * 3. WebSocket updates racing with client updates are handled correctly
 * 4. Version numbers remain monotonically increasing under concurrent load
 *
 * Since ApiSessionClient requires a real Socket.IO connection and encryption,
 * we test the concurrency patterns by creating a minimal testable harness that
 * replicates the critical lock-protected update logic.
 */

import { describe, it, expect } from 'vitest';
import { AsyncLock } from '@/utils/lock';

/**
 * Test harness that replicates the concurrent state update patterns from ApiSessionClient.
 * This allows us to test the concurrency logic without Socket.IO dependencies.
 */
class ConcurrentStateManager<T> {
    private state: T;
    private version: number;
    private lock: AsyncLock;
    private updateHistory: Array<{ version: number; state: T; timestamp: number }>;

    constructor(initialState: T, initialVersion: number = 0) {
        this.state = initialState;
        this.version = initialVersion;
        this.lock = new AsyncLock();
        this.updateHistory = [];
    }

    getState(): T {
        return this.state;
    }

    getVersion(): number {
        return this.version;
    }

    getUpdateHistory() {
        return [...this.updateHistory];
    }

    /**
     * Simulates the updateMetadata/updateAgentState pattern from ApiSessionClient.
     * Uses lock to serialize concurrent updates.
     */
    async update(
        handler: (currentState: T) => T,
        simulatedNetworkDelay: number = 0
    ): Promise<{ version: number; state: T }> {
        return this.lock.inLock(async () => {
            const updated = handler(this.state);

            // Simulate network round-trip
            if (simulatedNetworkDelay > 0) {
                await new Promise(resolve => setTimeout(resolve, simulatedNetworkDelay));
            }

            // Simulate server response with incremented version
            this.version += 1;
            this.state = updated;

            this.updateHistory.push({
                version: this.version,
                state: updated,
                timestamp: Date.now()
            });

            return { version: this.version, state: this.state };
        });
    }

    /**
     * Simulates WebSocket 'update-session' handler with double-check pattern.
     * This is the critical pattern that prevents race conditions:
     * 1. Check version outside lock (fast path)
     * 2. Re-check version inside lock (prevents stale updates)
     */
    async handleRemoteUpdate(remoteVersion: number, remoteState: T): Promise<boolean> {
        // First check outside lock (optimization for common case)
        if (remoteVersion <= this.version) {
            return false;
        }

        // Acquire lock and re-check
        return this.lock.inLock(async () => {
            // Double-check pattern: version might have changed while waiting for lock
            if (remoteVersion <= this.version) {
                return false;
            }

            this.version = remoteVersion;
            this.state = remoteState;

            this.updateHistory.push({
                version: this.version,
                state: remoteState,
                timestamp: Date.now()
            });

            return true;
        });
    }
}

describe('ApiSessionClient concurrent state update patterns', () => {
    describe('updateMetadata concurrent access', () => {
        it('should serialize concurrent updates correctly', async () => {
            type Metadata = { name: string; counter: number };
            const manager = new ConcurrentStateManager<Metadata>(
                { name: 'test', counter: 0 },
                0
            );

            // Launch multiple concurrent updates
            const updates = await Promise.all([
                manager.update(state => ({ ...state, counter: state.counter + 1 }), 10),
                manager.update(state => ({ ...state, counter: state.counter + 1 }), 10),
                manager.update(state => ({ ...state, counter: state.counter + 1 }), 10),
            ]);

            // All updates should have serialized
            expect(manager.getState().counter).toBe(3);

            // Each update should have gotten incrementing versions
            const versions = updates.map(u => u.version);
            expect(versions).toEqual([1, 2, 3]);
        });

        it('should maintain version monotonicity under concurrent load', async () => {
            type Metadata = { value: number };
            const manager = new ConcurrentStateManager<Metadata>({ value: 0 }, 0);

            // Create 20 concurrent updates
            const updatePromises = Array.from({ length: 20 }, (_, _i) =>
                manager.update(
                    state => ({ value: state.value + 1 }),
                    Math.random() * 5
                )
            );

            const _results = await Promise.all(updatePromises);

            // Final value should reflect all updates
            expect(manager.getState().value).toBe(20);
            expect(manager.getVersion()).toBe(20);

            // Verify version monotonicity in update history
            const history = manager.getUpdateHistory();
            for (let i = 1; i < history.length; i++) {
                expect(history[i].version).toBeGreaterThan(history[i - 1].version);
            }
        });

        it('should not corrupt state under concurrent modifications', async () => {
            type Metadata = { items: string[] };
            const manager = new ConcurrentStateManager<Metadata>({ items: [] }, 0);

            // Concurrent updates that modify the same array
            const _updates = await Promise.all([
                manager.update(state => ({ items: [...state.items, 'a'] })),
                manager.update(state => ({ items: [...state.items, 'b'] })),
                manager.update(state => ({ items: [...state.items, 'c'] })),
                manager.update(state => ({ items: [...state.items, 'd'] })),
                manager.update(state => ({ items: [...state.items, 'e'] })),
            ]);

            // Should have all 5 items
            expect(manager.getState().items.length).toBe(5);

            // Each item should appear exactly once
            const items = manager.getState().items;
            expect(new Set(items).size).toBe(5);
            expect(items).toContain('a');
            expect(items).toContain('b');
            expect(items).toContain('c');
            expect(items).toContain('d');
            expect(items).toContain('e');
        });
    });

    describe('updateAgentState concurrent access', () => {
        it('should serialize concurrent agent state updates', async () => {
            type AgentState = {
                controlledByUser: boolean;
                requests: Record<string, { tool: string; timestamp: number }>;
            };

            const manager = new ConcurrentStateManager<AgentState>(
                { controlledByUser: false, requests: {} },
                0
            );

            // Concurrent updates adding different requests
            const updates = await Promise.all([
                manager.update(state => ({
                    ...state,
                    requests: { ...state.requests, req1: { tool: 'Read', timestamp: 1 } }
                }), 5),
                manager.update(state => ({
                    ...state,
                    requests: { ...state.requests, req2: { tool: 'Write', timestamp: 2 } }
                }), 5),
                manager.update(state => ({
                    ...state,
                    controlledByUser: true
                }), 5),
            ]);

            const finalState = manager.getState();

            // All requests should be present
            expect(Object.keys(finalState.requests)).toHaveLength(2);
            expect(finalState.requests.req1).toBeDefined();
            expect(finalState.requests.req2).toBeDefined();
            expect(finalState.controlledByUser).toBe(true);

            // Versions should be monotonic
            expect(updates[0].version).toBe(1);
            expect(updates[1].version).toBe(2);
            expect(updates[2].version).toBe(3);
        });

        it('should handle rapid consecutive updates', async () => {
            type AgentState = { counter: number };
            const manager = new ConcurrentStateManager<AgentState>({ counter: 0 }, 0);

            // Rapid fire updates with no delay
            const results = await Promise.all(
                Array.from({ length: 100 }, () =>
                    manager.update(state => ({ counter: state.counter + 1 }))
                )
            );

            expect(manager.getState().counter).toBe(100);
            expect(manager.getVersion()).toBe(100);

            // Each result should have a unique, sequential version
            const versions = results.map(r => r.version).sort((a, b) => a - b);
            for (let i = 0; i < versions.length; i++) {
                expect(versions[i]).toBe(i + 1);
            }
        });
    });

    describe('WebSocket updates racing with client updates', () => {
        it('should properly acquire locks for remote updates', async () => {
            type State = { value: number };
            const manager = new ConcurrentStateManager<State>({ value: 0 }, 0);

            // Simulate concurrent local and remote updates
            const localUpdate = manager.update(state => ({ value: state.value + 10 }), 20);

            // Remote update arrives during local update
            await new Promise(resolve => setTimeout(resolve, 5));
            const remoteAccepted = manager.handleRemoteUpdate(2, { value: 100 });

            const [localResult, wasAccepted] = await Promise.all([localUpdate, remoteAccepted]);

            // Local update should have completed first (version 1)
            expect(localResult.version).toBe(1);

            // Remote update should have been accepted (version 2 > 1)
            expect(wasAccepted).toBe(true);

            // Final state should reflect the higher version remote update
            expect(manager.getVersion()).toBe(2);
            expect(manager.getState().value).toBe(100);
        });

        it('should reject stale remote updates after lock acquisition (double-check pattern)', async () => {
            type State = { value: number };
            const manager = new ConcurrentStateManager<State>({ value: 0 }, 5);

            // Try to apply a remote update with version 3 (stale - current is 5)
            const wasAccepted = await manager.handleRemoteUpdate(3, { value: 999 });

            expect(wasAccepted).toBe(false);
            expect(manager.getVersion()).toBe(5);
            expect(manager.getState().value).toBe(0); // Unchanged
        });

        it('should handle race where version changes while waiting for lock', async () => {
            type State = { value: number };
            const manager = new ConcurrentStateManager<State>({ value: 0 }, 0);

            // Start a local update that will increment version to 1
            const localUpdate = manager.update(state => ({ value: state.value + 1 }), 30);

            // Remote update checks version (0), sees it should apply (version 2 > 0)
            // But by the time it acquires the lock, version will be 1
            await new Promise(resolve => setTimeout(resolve, 5));

            // This remote update has version 2, which should still be accepted
            // after local update completes (2 > 1)
            const remoteAccepted = manager.handleRemoteUpdate(2, { value: 200 });

            const [localResult, wasAccepted] = await Promise.all([localUpdate, remoteAccepted]);

            expect(localResult.version).toBe(1);
            expect(wasAccepted).toBe(true);
            expect(manager.getVersion()).toBe(2);
            expect(manager.getState().value).toBe(200);
        });

        it('should correctly reject stale update that looked valid initially', async () => {
            type State = { value: number };
            const manager = new ConcurrentStateManager<State>({ value: 0 }, 0);

            // Start a local update that will increment version to 1
            const localUpdate = manager.update(state => ({ value: state.value + 100 }), 30);

            // Remote update checks version (0), sees version 1 should apply
            // But local update will also create version 1, making the remote stale
            await new Promise(resolve => setTimeout(resolve, 5));

            // This remote update has version 1, same as what local will produce
            // Should be rejected because 1 <= 1
            const remoteAccepted = manager.handleRemoteUpdate(1, { value: 50 });

            const [localResult, wasAccepted] = await Promise.all([localUpdate, remoteAccepted]);

            expect(localResult.version).toBe(1);
            expect(wasAccepted).toBe(false); // Rejected due to double-check
            expect(manager.getVersion()).toBe(1);
            expect(manager.getState().value).toBe(100); // Local value preserved
        });
    });

    describe('lock behavior under errors', () => {
        it('should release lock when update handler throws', async () => {
            type State = { value: number };
            const manager = new ConcurrentStateManager<State>({ value: 0 }, 0);

            // First update throws
            await expect(
                manager.update(() => {
                    throw new Error('Update failed');
                })
            ).rejects.toThrow('Update failed');

            // Second update should succeed (lock was released)
            const result = await manager.update(state => ({ value: state.value + 1 }));
            expect(result.version).toBe(1);
            expect(manager.getState().value).toBe(1);
        });

        it('should release lock when async operation fails', async () => {
            type _State = { value: number };
            const lock = new AsyncLock();
            let counter = 0;

            // First operation fails after delay
            const op1 = lock.inLock(async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                throw new Error('Async failure');
            }).catch(() => {
                // Catch to prevent unhandled rejection
                return 'failed';
            });

            // Second operation should eventually acquire lock
            const op2 = lock.inLock(async () => {
                counter += 1;
                return 'success';
            });

            const [result1, result2] = await Promise.all([op1, op2]);

            expect(result1).toBe('failed');
            expect(result2).toBe('success');
            expect(counter).toBe(1);
        });
    });

    describe('version monotonicity stress test', () => {
        it('should maintain strict version ordering under heavy concurrent load', async () => {
            type State = { updates: number[] };
            const manager = new ConcurrentStateManager<State>({ updates: [] }, 0);

            // Create 50 concurrent updates
            const updatePromises = Array.from({ length: 50 }, (_, i) =>
                manager.update(
                    state => ({ updates: [...state.updates, i] }),
                    Math.random() * 10
                )
            );

            const results = await Promise.all(updatePromises);

            // Final state should have all 50 updates
            expect(manager.getState().updates.length).toBe(50);
            expect(manager.getVersion()).toBe(50);

            // All returned versions should be unique
            const versions = results.map(r => r.version);
            const uniqueVersions = new Set(versions);
            expect(uniqueVersions.size).toBe(50);

            // Versions should span 1 to 50
            expect(Math.min(...versions)).toBe(1);
            expect(Math.max(...versions)).toBe(50);
        });

        it('should handle interleaved local and remote updates without data loss', async () => {
            type State = { counter: number; source: string };
            const manager = new ConcurrentStateManager<State>({ counter: 0, source: 'init' }, 0);

            // Track which updates were accepted
            const acceptedUpdates: string[] = [];

            // Run a mix of local and remote updates concurrently
            // Local updates increment by 1, remote updates set specific values
            const operations: Promise<void>[] = [];

            // 5 local updates
            for (let i = 0; i < 5; i++) {
                operations.push(
                    manager.update(
                        state => ({ counter: state.counter + 1, source: `local-${i}` }),
                        Math.random() * 10
                    ).then(result => {
                        acceptedUpdates.push(`local-${i}:v${result.version}`);
                    })
                );
            }

            // 5 remote updates with high versions to ensure they're accepted
            // Each has a unique high version number
            for (let i = 0; i < 5; i++) {
                const remoteVersion = 1000 + i;
                operations.push(
                    manager.handleRemoteUpdate(
                        remoteVersion,
                        { counter: remoteVersion, source: `remote-${i}` }
                    ).then(accepted => {
                        if (accepted) {
                            acceptedUpdates.push(`remote-${i}:v${remoteVersion}`);
                        }
                    })
                );
            }

            await Promise.all(operations);

            // All local updates should have completed (they always succeed)
            const localUpdates = acceptedUpdates.filter(u => u.startsWith('local-'));
            expect(localUpdates.length).toBe(5);

            // At least some remote updates should have been accepted
            // (the ones with highest versions will "win" over lower ones)
            const remoteUpdates = acceptedUpdates.filter(u => u.startsWith('remote-'));
            expect(remoteUpdates.length).toBeGreaterThan(0);

            // Final version should be the highest remote version (1004)
            // since remote versions are all > local versions
            expect(manager.getVersion()).toBe(1004);
        });
    });
});

describe('Double-check pattern correctness', () => {
    /**
     * The double-check pattern in WebSocket handlers is critical:
     *
     * 1. Check version outside lock (fast rejection of old updates)
     * 2. Acquire lock
     * 3. Re-check version inside lock (handles race where version changed while waiting)
     *
     * Without the double-check, this race can occur:
     * - WebSocket handler checks: remoteVersion (5) > localVersion (4) ✓
     * - Local update starts, acquires lock, sets version to 5
     * - Local update releases lock
     * - WebSocket handler acquires lock, applies stale remote data (version 5)
     * - Now we have wrong data despite version being "correct"
     */

    it('should demonstrate the race condition that double-check prevents', async () => {
        type State = { value: string };

        // Create a manager WITHOUT proper double-check (simulating the bug)
        class BuggyManager {
            state: State = { value: 'initial' };
            version = 0;
            lock = new AsyncLock();

            async update(newValue: string, delay: number = 0): Promise<void> {
                await this.lock.inLock(async () => {
                    if (delay > 0) {
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                    this.version += 1;
                    this.state = { value: newValue };
                });
            }

            // BUGGY: Only checks version outside lock
            async handleRemoteUpdateBuggy(remoteVersion: number, remoteState: State): Promise<boolean> {
                // Check outside lock
                if (remoteVersion <= this.version) {
                    return false;
                }

                // Acquire lock but DON'T re-check
                await this.lock.inLock(async () => {
                    // BUG: Should re-check version here but doesn't
                    this.version = remoteVersion;
                    this.state = remoteState;
                });

                return true;
            }
        }

        const buggyManager = new BuggyManager();

        // Start local update (will set version to 1, value to 'local')
        const localUpdate = buggyManager.update('local', 20);

        // Remote update checks version (0), decides to apply
        await new Promise(resolve => setTimeout(resolve, 5));
        const buggyRemote = buggyManager.handleRemoteUpdateBuggy(1, { value: 'remote' });

        await Promise.all([localUpdate, buggyRemote]);

        // BUG: Remote overwrote local even though both have version 1
        // The local update should have won since it was initiated first
        // This demonstrates the race condition that double-check prevents
        expect(buggyManager.state.value).toBe('remote'); // The bug!
        expect(buggyManager.version).toBe(1);
    });

    it('should correctly prevent the race with double-check pattern', async () => {
        type State = { value: string };

        // Manager WITH proper double-check
        class CorrectManager {
            state: State = { value: 'initial' };
            version = 0;
            lock = new AsyncLock();

            async update(newValue: string, delay: number = 0): Promise<void> {
                await this.lock.inLock(async () => {
                    if (delay > 0) {
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                    this.version += 1;
                    this.state = { value: newValue };
                });
            }

            // CORRECT: Double-check pattern
            async handleRemoteUpdate(remoteVersion: number, remoteState: State): Promise<boolean> {
                // Check outside lock (optimization)
                if (remoteVersion <= this.version) {
                    return false;
                }

                // Acquire lock AND re-check
                return this.lock.inLock(async () => {
                    // Double-check: version might have changed while waiting
                    if (remoteVersion <= this.version) {
                        return false;
                    }
                    this.version = remoteVersion;
                    this.state = remoteState;
                    return true;
                });
            }
        }

        const correctManager = new CorrectManager();

        // Start local update (will set version to 1, value to 'local')
        const localUpdate = correctManager.update('local', 20);

        // Remote update checks version (0), decides to apply
        await new Promise(resolve => setTimeout(resolve, 5));
        const correctRemote = correctManager.handleRemoteUpdate(1, { value: 'remote' });

        await Promise.all([localUpdate, correctRemote]);

        // CORRECT: Local update wins because remote version (1) is not > local version (1)
        expect(correctManager.state.value).toBe('local'); // Correct behavior!
        expect(correctManager.version).toBe(1);
    });
});
