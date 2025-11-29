import { existsSync } from "fs";
import { watch } from "fs/promises";
import { logger } from "@/ui/logger";
import { delay } from "@/utils/time";

/**
 * Type guard for Node.js system errors with error codes
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/**
 * Fatal error codes that should immediately stop the watcher without retrying
 */
const FATAL_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EISDIR', 'EINVAL']);

/**
 * Event types emitted by the file watcher.
 * - 'change': File content was modified
 * - 'rename': File was renamed (still exists at watched path)
 * - 'removed': File was deleted or renamed away from watched path
 */
export type FileWatchEvent = 'change' | 'rename' | 'removed';

/** Options for configuring the file watcher behavior */
export interface FileWatcherOptions {
    /** Maximum consecutive errors before stopping the watcher. Default: 10 */
    maxConsecutiveErrors?: number;
    /** Debounce time in milliseconds to coalesce rapid events. Default: 100 */
    debounceMs?: number;
}

/**
 * Starts a file watcher that monitors a file for changes and calls the callback on each change.
 *
 * The watcher will automatically restart on transient errors, but will stop if:
 * - A fatal error occurs (ENOENT, EACCES, EISDIR, EINVAL)
 * - Maximum consecutive errors is reached
 * - The abort function is called
 *
 * Handles filesystem rename events by checking if the file still exists:
 * - If file exists after rename event: 'rename' event (file renamed TO this path)
 * - If file doesn't exist after rename: 'removed' event (file deleted or renamed away)
 *
 * @param file - Path to the file to watch
 * @param onFileChange - Callback invoked when the file changes, with event type
 * @param options - Configuration options for the watcher
 * @returns Abort function to stop the watcher
 */
export function startFileWatcher(
    file: string,
    onFileChange: (file: string, event: FileWatchEvent) => void,
    options: FileWatcherOptions = {}
): () => void {
    const abortController = new AbortController();
    const maxErrors = options.maxConsecutiveErrors ?? 10;
    const debounceMs = options.debounceMs ?? 100;
    let consecutiveErrors = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingEvent: FileWatchEvent | null = null;

    /**
     * Merges two file watcher events according to priority rules:
     * - 'removed' has highest priority, then 'rename', then 'change'
     * - If current is null, use incoming
     * - If incoming is 'removed', always use 'removed'
     * - If incoming is 'rename' and current is 'change', upgrade to 'rename'
     * - Otherwise, keep current
     */
    function mergeFileWatchEvents(current: FileWatchEvent | null, incoming: FileWatchEvent): FileWatchEvent {
        if (current === null) return incoming;
        if (incoming === 'removed') return 'removed';
        if (incoming === 'rename' && current === 'change') return 'rename';
        return current;
    }

    const debouncedCallback = (eventType: FileWatchEvent): void => {
        // Use mergeFileWatchEvents to determine the new pending event
        pendingEvent = mergeFileWatchEvents(pendingEvent, eventType);

        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
            if (pendingEvent !== null && !abortController.signal.aborted) {
                logger.debug(`[FILE_WATCHER] Emitting debounced event: ${pendingEvent} for ${file}`);
                onFileChange(file, pendingEvent);
            }
            pendingEvent = null;
            debounceTimer = null;
        }, debounceMs);
    };

    void (async (): Promise<void> => {
        while (consecutiveErrors < maxErrors) {
            try {
                logger.debug(`[FILE_WATCHER] Starting watcher for ${file}`);
                const watcher = watch(file, { persistent: true, signal: abortController.signal });
                for await (const event of watcher) {
                    if (abortController.signal.aborted) {
                        return;
                    }
                    // Reset error counter on successful event
                    consecutiveErrors = 0;

                    // Determine the actual event type
                    let watchEvent: FileWatchEvent;
                    if (event.eventType === 'rename') {
                        // For rename events, check if file still exists
                        // exists = renamed TO this path, !exists = deleted or renamed away
                        if (existsSync(file)) {
                            watchEvent = 'rename';
                            logger.debug(`[FILE_WATCHER] File renamed (still exists): ${file}`);
                        } else {
                            watchEvent = 'removed';
                            logger.debug(`[FILE_WATCHER] File removed or renamed away: ${file}`);
                        }
                    } else {
                        watchEvent = 'change';
                        logger.debug(`[FILE_WATCHER] File content changed: ${file}`);
                    }

                    debouncedCallback(watchEvent);
                }
            } catch (e: unknown) {
                // Always check abort signal first to avoid unnecessary error processing
                if (abortController.signal.aborted) {
                    return;
                }

                // Use type guard for safe error handling
                if (!isNodeError(e)) {
                    // Unknown error type - treat as fatal
                    logger.debug(`[FILE_WATCHER] Unknown error type for ${file}, stopping watcher: ${e}`);
                    return;
                }

                // Stop immediately on fatal errors - no point retrying
                if (FATAL_ERROR_CODES.has(e.code || '')) {
                    logger.debug(`[FILE_WATCHER] Fatal error (${e.code}): ${e.message} for ${file}, stopping watcher`);
                    return;
                }

                // Transient error - retry with backoff
                consecutiveErrors++;
                logger.debug(
                    `[FILE_WATCHER] Watch error (${e.code || 'unknown'}): ${e.message}, ` +
                    `attempt ${consecutiveErrors}/${maxErrors}, restarting in 1s`
                );

                // Delay with abort signal awareness
                await Promise.race([
                    delay(1000),
                    new Promise<void>((resolve) => {
                        if (abortController.signal.aborted) resolve();
                        else abortController.signal.addEventListener('abort', () => resolve(), { once: true });
                    })
                ]);

                // Check again after delay
                if (abortController.signal.aborted) {
                    return;
                }
            }
        }

        // Max errors reached
        logger.debug(
            `[FILE_WATCHER] Max consecutive errors (${maxErrors}) reached for ${file}, stopping watcher`
        );
    })();

    return () => {
        // Clear any pending debounce timer
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        pendingEvent = null;
        abortController.abort();
    };
}
