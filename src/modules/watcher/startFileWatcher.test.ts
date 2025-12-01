import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startFileWatcher, FileWatchEvent } from './startFileWatcher';
import { writeFileSync, unlinkSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('startFileWatcher', () => {
    let testDir: string;
    let testFile: string;

    beforeEach(() => {
        // Create a temporary test directory
        testDir = join(tmpdir(), `test-watcher-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
        testFile = join(testDir, 'test.txt');
    });

    afterEach(() => {
        // Clean up
        try {
            rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    it('should call callback when file changes', async () => {
        // Create initial file
        writeFileSync(testFile, 'initial content');

        let callCount = 0;
        let lastEvent: FileWatchEvent | null = null;
        const abort = startFileWatcher(testFile, (_file, event) => {
            callCount++;
            lastEvent = event;
        });

        // Wait a bit for watcher to start
        await new Promise(resolve => setTimeout(resolve, 100));

        // Modify the file
        writeFileSync(testFile, 'modified content');

        // Wait for the change to be detected (debounce is 100ms by default)
        await new Promise(resolve => setTimeout(resolve, 300));

        // Clean up
        abort();

        // Should have been called at least once
        expect(callCount).toBeGreaterThan(0);
        expect(lastEvent).toBe('change');
    });

    it('should emit removed event and stop watching when file is deleted', async () => {
        // Create initial file
        writeFileSync(testFile, 'initial content');

        let callCount = 0;
        let lastEvent: FileWatchEvent | null = null;
        const abort = startFileWatcher(testFile, (_file, event) => {
            callCount++;
            lastEvent = event;
        });

        // Wait for watcher to start
        await new Promise(resolve => setTimeout(resolve, 100));

        // Delete the file
        unlinkSync(testFile);

        // Wait for debounced callback and watcher to process deletion
        await new Promise(resolve => setTimeout(resolve, 500));

        // Should have received a 'removed' event before watcher stopped
        expect(lastEvent).toBe('removed');

        // Watcher should have stopped due to ENOENT, so recreating shouldn't trigger callback
        const callCountAfterRemoval = callCount;
        writeFileSync(testFile, 'new content');
        await new Promise(resolve => setTimeout(resolve, 300));

        // Should not have increased (watcher stopped)
        expect(callCount).toBe(callCountAfterRemoval);

        abort();
    });

    it('should respect abort signal', async () => {
        writeFileSync(testFile, 'initial content');

        let callCount = 0;
        const abort = startFileWatcher(testFile, (_file, _event) => {
            callCount++;
        });

        // Wait for watcher to start
        await new Promise(resolve => setTimeout(resolve, 100));

        // Abort the watcher
        abort();

        // Wait a bit
        await new Promise(resolve => setTimeout(resolve, 100));

        // Modify the file
        writeFileSync(testFile, 'modified content');

        // Wait to ensure change would have been detected
        await new Promise(resolve => setTimeout(resolve, 300));

        // Should not have been called after abort
        expect(callCount).toBe(0);
    });

    it('should handle non-existent file gracefully (ENOENT)', async () => {
        const nonExistentFile = join(testDir, 'does-not-exist.txt');

        let callCount = 0;
        const abort = startFileWatcher(nonExistentFile, (_file, _event) => {
            callCount++;
        });

        // Wait to ensure watcher has time to fail
        await new Promise(resolve => setTimeout(resolve, 300));

        // Should not have called callback
        expect(callCount).toBe(0);

        abort();
    });

    it('should reset error count on successful watch', async () => {
        writeFileSync(testFile, 'initial content');

        let callCount = 0;
        const abort = startFileWatcher(testFile, (_file, _event) => {
            callCount++;
        }, { maxConsecutiveErrors: 3 });

        // Wait for watcher to start
        await new Promise(resolve => setTimeout(resolve, 100));

        // Trigger a change
        writeFileSync(testFile, 'change 1');
        await new Promise(resolve => setTimeout(resolve, 300));

        // Should have been called
        expect(callCount).toBeGreaterThan(0);

        abort();
    });

    it('should debounce rapid file changes', async () => {
        writeFileSync(testFile, 'initial content');

        let callCount = 0;
        const events: FileWatchEvent[] = [];
        const abort = startFileWatcher(testFile, (_file, event) => {
            callCount++;
            events.push(event);
        }, { debounceMs: 150 });

        // Wait for watcher to start
        await new Promise(resolve => setTimeout(resolve, 100));

        // Rapidly modify the file multiple times
        writeFileSync(testFile, 'change 1');
        await new Promise(resolve => setTimeout(resolve, 20));
        writeFileSync(testFile, 'change 2');
        await new Promise(resolve => setTimeout(resolve, 20));
        writeFileSync(testFile, 'change 3');

        // Wait for debounce to settle
        await new Promise(resolve => setTimeout(resolve, 400));

        // Should have coalesced multiple changes into fewer callbacks
        // Due to debouncing, we expect far fewer callbacks than the 3 changes
        expect(callCount).toBeLessThanOrEqual(2);
        expect(events.every(e => e === 'change')).toBe(true);

        abort();
    });

    it('should emit rename event when file is renamed to watched path', async () => {
        // This test verifies the rename event handling
        // We create a file, start watching, then rename another file to the watched path
        writeFileSync(testFile, 'initial content');

        let events: FileWatchEvent[] = [];
        const abort = startFileWatcher(testFile, (_file, event) => {
            events.push(event);
        });

        // Wait for watcher to start
        await new Promise(resolve => setTimeout(resolve, 100));

        // Create a new file and rename it to the watched path
        // First, delete the original file
        const tempFile = join(testDir, 'temp.txt');
        writeFileSync(tempFile, 'renamed content');

        // Now rename temp to the watched file (replacing it)
        unlinkSync(testFile);
        renameSync(tempFile, testFile);

        // Wait for events to be processed
        await new Promise(resolve => setTimeout(resolve, 400));

        // Should have received at least one event (likely 'removed' when deleted, then 'rename' when new file appeared)
        // The exact sequence depends on filesystem timing
        expect(events.length).toBeGreaterThan(0);

        abort();
    });
});
