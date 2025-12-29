import { resolve, sep } from "node:path";

/**
 * UUID v4 regex pattern for validating session IDs.
 * Session IDs must be valid UUIDs to prevent path traversal attacks.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hex session ID regex pattern (32 hex characters, no hyphens).
 * Claude Code uses this format internally for session IDs.
 * This is effectively a UUID without hyphen separators.
 */
const HEX_SESSION_ID_REGEX = /^[0-9a-f]{32}$/i;

/**
 * Checks if a session ID is in hex format (32 hex chars, no hyphens).
 * Claude Code uses this format for session IDs.
 *
 * @param sessionId - The session ID to check
 * @returns true if hex format, false otherwise
 */
export function isHexSessionId(sessionId: string): boolean {
    return HEX_SESSION_ID_REGEX.test(sessionId);
}

/**
 * Converts a hex session ID (32 chars) to UUID format (36 chars with hyphens).
 * Claude Code uses hex format internally, but Happy uses UUID format.
 *
 * @param hexId - The hex session ID (e.g., "bb6ca0a457344204ada77aa2c27473c5")
 * @returns UUID format (e.g., "bb6ca0a4-5734-4204-ada7-7aa2c27473c5")
 * @throws InvalidSessionIdError if input is not valid hex format
 */
export function hexToUuid(hexId: string): string {
    if (!isHexSessionId(hexId)) {
        throw new InvalidSessionIdError(
            `Invalid hex session ID format: expected 32 hex characters, got "${hexId.substring(0, 50)}${hexId.length > 50 ? '...' : ''}"`
        );
    }
    // Insert hyphens at standard UUID positions: 8-4-4-4-12
    return `${hexId.slice(0, 8)}-${hexId.slice(8, 12)}-${hexId.slice(12, 16)}-${hexId.slice(16, 20)}-${hexId.slice(20)}`.toLowerCase();
}

/**
 * Converts a UUID (36 chars with hyphens) to hex format (32 chars, no hyphens).
 *
 * @param uuidId - The UUID (e.g., "bb6ca0a4-5734-4204-ada7-7aa2c27473c5")
 * @returns Hex format (e.g., "bb6ca0a457344204ada77aa2c27473c5")
 * @throws InvalidSessionIdError if input is not valid UUID format
 */
export function uuidToHex(uuidId: string): string {
    if (!UUID_REGEX.test(uuidId)) {
        throw new InvalidSessionIdError(
            `Invalid UUID session ID format: expected UUID, got "${uuidId.substring(0, 50)}${uuidId.length > 50 ? '...' : ''}"`
        );
    }
    return uuidId.replace(/-/g, '').toLowerCase();
}

/**
 * Normalizes a session ID to UUID format.
 * Accepts both hex (32 chars) and UUID (36 chars) formats.
 * Returns UUID format for consistent internal use.
 *
 * @param sessionId - The session ID in either hex or UUID format
 * @returns UUID format session ID
 * @throws InvalidSessionIdError if input is neither valid hex nor UUID format
 */
export function normalizeSessionId(sessionId: string): string {
    // Already UUID format
    if (UUID_REGEX.test(sessionId)) {
        return sessionId.toLowerCase();
    }
    // Hex format - convert to UUID
    if (HEX_SESSION_ID_REGEX.test(sessionId)) {
        return hexToUuid(sessionId);
    }
    // Invalid format
    throw new InvalidSessionIdError(
        `Invalid session ID format: expected UUID or hex (32 chars), got "${sessionId.substring(0, 50)}${sessionId.length > 50 ? '...' : ''}"`
    );
}

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
 * Accepts both UUID format (36 chars with hyphens) and hex format (32 chars).
 * Useful for conditional logic where invalid IDs should be silently rejected.
 *
 * @param sessionId - The session ID to check
 * @returns true if valid UUID or hex format, false otherwise
 */
export function isValidSessionId(sessionId: string): boolean {
    return UUID_REGEX.test(sessionId) || HEX_SESSION_ID_REGEX.test(sessionId);
}
