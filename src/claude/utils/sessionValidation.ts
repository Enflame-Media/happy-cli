import { resolve, sep } from "node:path";

/**
 * UUID v4 regex pattern for validating session IDs.
 * Session IDs must be valid UUIDs to prevent path traversal attacks.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Error thrown when session ID validation fails.
 * Indicates either invalid UUID format or path traversal attempt.
 */
export class InvalidSessionIdError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidSessionIdError';
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Validates that a session ID is a valid UUID format.
 * This prevents path traversal attacks by ensuring session IDs
 * cannot contain directory traversal sequences like "../".
 *
 * @param sessionId - The session ID to validate
 * @returns true if valid UUID format
 * @throws InvalidSessionIdError if format is invalid
 */
export function validateSessionId(sessionId: string): boolean {
    if (!UUID_REGEX.test(sessionId)) {
        throw new InvalidSessionIdError(
            `Invalid session ID format: expected UUID, got "${sessionId.substring(0, 50)}${sessionId.length > 50 ? '...' : ''}"`
        );
    }
    return true;
}

/**
 * Returns a safe session file path after validation.
 * Performs two-layer protection:
 * 1. Validates sessionId is a valid UUID (prevents injection)
 * 2. Validates resolved path stays within base directory (defense in depth)
 *
 * @param baseDir - The base directory where session files should reside
 * @param sessionId - The session ID (must be valid UUID)
 * @returns The validated absolute path to the session file
 * @throws InvalidSessionIdError if validation fails
 */
export function getValidatedSessionPath(baseDir: string, sessionId: string): string {
    // Layer 1: Validate UUID format
    validateSessionId(sessionId);

    // Layer 2: Resolve and verify path stays within base directory
    const resolvedBase = resolve(baseDir);
    const sessionPath = resolve(baseDir, `${sessionId}.jsonl`);

    // Ensure the resolved path starts with the base directory + separator
    // This prevents both path escape and prefix matching issues
    // (e.g., "/home/user" won't match "/home/userdata/file.jsonl")
    const baseWithSep = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
    if (!sessionPath.startsWith(baseWithSep)) {
        throw new InvalidSessionIdError(
            `Session path escapes base directory: resolved to "${sessionPath}"`
        );
    }

    return sessionPath;
}

/**
 * Checks if a session ID is valid without throwing.
 * Useful for conditional logic where invalid IDs should be silently rejected.
 *
 * @param sessionId - The session ID to check
 * @returns true if valid UUID format, false otherwise
 */
export function isValidSessionId(sessionId: string): boolean {
    return UUID_REGEX.test(sessionId);
}
