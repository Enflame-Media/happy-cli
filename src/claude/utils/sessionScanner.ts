import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
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
        for (let p of pendingSessions) {
            sessions.push(p);
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

        // Move pending sessions to finished sessions
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers
        for (let p of sessions) {
            if (!watchers.has(p)) {
                // Validate session ID before creating watcher path
                try {
                    const watchPath = getValidatedSessionPath(projectDir, p);
                    watchers.set(p, startFileWatcher(watchPath, () => { sync.invalidate(); }));
                } catch (error) {
                    if (error instanceof InvalidSessionIdError) {
                        logger.debug(`[SESSION_SCANNER] Invalid session ID rejected for watcher: ${error.message}`);
                        continue;
                    }
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
    } catch (error) {
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
            let message = JSON.parse(l);
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) { // We can't deduplicate this message so we have to skip it
                logger.debugLargeJson(`[SESSION_SCANNER] Failed to parse message`, message)
                continue;
            }
            messages.push(parsed.data);
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return messages;
}