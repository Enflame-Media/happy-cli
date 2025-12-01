import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema, parseJsonWithContext, JsonParseError } from "../types";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher, FileWatchEvent } from "@/modules/watcher/startFileWatcher";
import { getProjectPath } from "./path";
import { withRetry } from "@/utils/retry";
import { getValidatedSessionPath, isValidSessionId, InvalidSessionIdError } from "./sessionValidation";

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
}) {

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedMessageKeys = new Set<string>();

    // Mark existing messages as processed
    if (opts.sessionId) {
        let messages = await readSessionLog(projectDir, opts.sessionId);
        for (let m of messages) {
            processedMessageKeys.add(messageKey(m));
        }
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {
        // logger.debug(`[SESSION_SCANNER] Syncing...`);

        // Collect session ids
        let sessions: string[] = [];
        for (let sessionId of pendingSessions) {
            sessions.push(sessionId);
        }
        if (currentSessionId) {
            sessions.push(currentSessionId);
        }

        // Process sessions
        for (let session of sessions) {
            for (let file of await readSessionLog(projectDir, session)) {
                let key = messageKey(file);
                if (processedMessageKeys.has(key)) {
                    continue;
                }
                processedMessageKeys.add(key);
                opts.onMessage(file);
            }
        }

        // Move pending sessions to finished sessions and close their watchers
        for (let sessionId of sessions) {
            if (pendingSessions.has(sessionId)) {
                pendingSessions.delete(sessionId);
                finishedSessions.add(sessionId);

                // Close watcher for finished session to prevent file descriptor leaks
                const watcher = watchers.get(sessionId);
                if (watcher) {
                    watcher();
                    watchers.delete(sessionId);
                }
            }
        }

        // Only watch current active session (not pending/finished ones)
        if (currentSessionId && !watchers.has(currentSessionId)) {
            // Validate session ID before creating watcher path
            try {
                const watchPath = getValidatedSessionPath(projectDir, currentSessionId);
                watchers.set(currentSessionId, startFileWatcher(watchPath, (_file: string, event: FileWatchEvent) => {
                    // Handle all events - change, rename, and removed
                    // For session files, we always want to sync to catch any updates
                    // even if the file was renamed (session forking) or removed
                    logger.debug(`[SESSION_SCANNER] File event: ${event} for session ${currentSessionId}`);
                    sync.invalidate();
                }));
            } catch (error) {
                if (error instanceof InvalidSessionIdError) {
                    logger.debug(`[SESSION_SCANNER] Invalid session ID rejected for watcher: ${error.message}`);
                } else {
                    throw error;
                }
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: async () => {
            clearInterval(intervalId);
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
            await sync.invalidateAndAwait();
            sync.stop();
        },
        onNewSession: (sessionId: string) => {
            // Validate session ID format to prevent path traversal attacks
            if (!isValidSessionId(sessionId)) {
                logger.debug(`[SESSION_SCANNER] Invalid session ID format rejected: ${sessionId.substring(0, 50)}`);
                return;
            }
            if (currentSessionId === sessionId) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                return;
            }
            if (finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;

            // FIX HAP-73: Set up watcher IMMEDIATELY before invalidating to prevent message loss
            // Previously, the watcher was only set up inside the sync callback, creating a gap
            // where messages could be lost between session switch and watcher setup
            if (!watchers.has(sessionId)) {
                try {
                    const watchPath = getValidatedSessionPath(projectDir, sessionId);
                    watchers.set(sessionId, startFileWatcher(watchPath, (_file: string, event: FileWatchEvent) => {
                        logger.debug(`[SESSION_SCANNER] File event: ${event} for session ${sessionId}`);
                        sync.invalidate();
                    }));
                } catch (error) {
                    if (error instanceof InvalidSessionIdError) {
                        logger.debug(`[SESSION_SCANNER] Invalid session ID rejected for watcher: ${error.message}`);
                    } else {
                        throw error;
                    }
                }
            }

            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

async function readSessionLog(projectDir: string, sessionId: string): Promise<RawJSONLines[]> {
    // Validate session ID to prevent path traversal attacks
    let expectedSessionFile: string;
    try {
        expectedSessionFile = getValidatedSessionPath(projectDir, sessionId);
    } catch (error) {
        if (error instanceof InvalidSessionIdError) {
            logger.debug(`[SESSION_SCANNER] Invalid session ID rejected: ${error.message}`);
            return [];
        }
        throw error;
    }

    logger.debug(`[SESSION_SCANNER] Reading session file: ${expectedSessionFile}`);
    let file: string;
    try {
        file = await withRetry(() => readFile(expectedSessionFile, 'utf-8'));
    } catch {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${expectedSessionFile}`);
        return [];
    }
    let lines = file.split('\n');
    let messages: RawJSONLines[] = [];
    for (let l of lines) {
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = parseJsonWithContext(l, {
                context: 'session message',
                logger
            });
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) { // We can't deduplicate this message so we have to skip it
                logger.debugLargeJson(`[SESSION_SCANNER] Failed to validate message schema`, message)
                continue;
            }
            messages.push(parsed.data);
        } catch (e) {
            // JsonParseError already logged the context, just log the error summary
            if (e instanceof JsonParseError) {
                logger.debug(`[SESSION_SCANNER] Skipping malformed message (length: ${e.inputLength})`);
            } else {
                logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            }
            continue;
        }
    }
    return messages;
}