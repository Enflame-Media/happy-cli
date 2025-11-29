import { logger } from "@/ui/logger";
import { existsSync, readFileSync } from "node:fs";
import { getProjectPath } from "./path";
import { getValidatedSessionPath, InvalidSessionIdError } from "./sessionValidation";

export function claudeCheckSession(sessionId: string, path: string) {
    const projectDir = getProjectPath(path);

    // Validate session ID to prevent path traversal attacks
    let sessionFile: string;
    try {
        sessionFile = getValidatedSessionPath(projectDir, sessionId);
    } catch (error) {
        if (error instanceof InvalidSessionIdError) {
            logger.debug(`[claudeCheckSession] Invalid session ID rejected: ${error.message}`);
            return false;
        }
        throw error;
    }

    // Check if session file exists
    const sessionExists = existsSync(sessionFile);
    if (!sessionExists) {
        logger.debug(`[claudeCheckSession] Path ${sessionFile} does not exist`);
        return false;
    }

    // Check if session contains any messages
    const sessionData = readFileSync(sessionFile, 'utf-8').split('\n');
    const hasGoodMessage = !!sessionData.find((v) => {
        try {
            return typeof JSON.parse(v).uuid === 'string'
        } catch (e) {
            return false;
        }
    });

    return hasGoodMessage;
}