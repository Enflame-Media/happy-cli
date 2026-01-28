import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { claudeCheckSession } from './claudeCheckSession';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { existsSync } from 'node:fs';

/**
 * Tests for claudeCheckSession utility.
 *
 * The claudeCheckSession function validates whether a Claude Code session file exists
 * and contains valid message history. It supports both UUID format (36 chars with hyphens)
 * and hex format (32 chars without hyphens) session IDs.
 *
 * @see HAP-756 - Add unit tests for claudeCheckSession utility
 * @see HAP-754 - Support for both UUID and hex format session IDs
 */
describe('claudeCheckSession', () => {
    let testDir: string;
    let projectDir: string;

    beforeEach(async () => {
        // Create a unique temporary test directory
        testDir = join(tmpdir(), `claudeCheckSession-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(testDir, { recursive: true });

        // Create the project directory where Claude stores session files
        // Uses same path transformation as getProjectPath
        const projectName = testDir.replace(/[\\/:.]/g, '-');
        projectDir = join(homedir(), '.claude', 'projects', projectName);
        await mkdir(projectDir, { recursive: true });
    });

    afterEach(async () => {
        // Clean up test directories
        if (existsSync(testDir)) {
            await rm(testDir, { recursive: true, force: true });
        }
        if (existsSync(projectDir)) {
            await rm(projectDir, { recursive: true, force: true });
        }
    });

    describe('valid session with message history', () => {
        it('should return true for valid UUID format session with messages', async () => {
            const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const sessionFile = join(projectDir, `${sessionId}.jsonl`);

            // Write a valid JSONL session file with message that has uuid field
            const sessionContent = [
                JSON.stringify({
                    type: 'user',
                    uuid: 'msg-001',
                    sessionId,
                    message: { role: 'user', content: 'Hello' }
                }),
                JSON.stringify({
                    type: 'assistant',
                    uuid: 'msg-002',
                    sessionId,
                    message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
                })
            ].join('\n');

            await writeFile(sessionFile, sessionContent);

            const result = claudeCheckSession(sessionId, testDir);

            expect(result).toBe(true);
        });

        it('should return true for valid hex format session with messages', async () => {
            // Hex format session ID (32 chars, no hyphens)
            const hexSessionId = 'bb6ca0a457344204ada77aa2c27473c5';
            // Normalized UUID format (used for file path)
            const uuidSessionId = 'bb6ca0a4-5734-4204-ada7-7aa2c27473c5';
            const sessionFile = join(projectDir, `${uuidSessionId}.jsonl`);

            // Write a valid JSONL session file with message that has uuid field
            const sessionContent = [
                JSON.stringify({
                    type: 'user',
                    uuid: 'msg-001',
                    sessionId: uuidSessionId,
                    message: { role: 'user', content: 'Test message' }
                })
            ].join('\n');

            await writeFile(sessionFile, sessionContent);

            // Call with hex format - should normalize and find the file
            const result = claudeCheckSession(hexSessionId, testDir);

            expect(result).toBe(true);
        });

        it('should return true for uppercase hex format session', async () => {
            // Uppercase hex format session ID
            const hexSessionId = 'BB6CA0A457344204ADA77AA2C27473C5';
            // Normalized UUID format (lowercase)
            const uuidSessionId = 'bb6ca0a4-5734-4204-ada7-7aa2c27473c5';
            const sessionFile = join(projectDir, `${uuidSessionId}.jsonl`);

            const sessionContent = JSON.stringify({
                type: 'user',
                uuid: 'msg-001',
                sessionId: uuidSessionId,
                message: { role: 'user', content: 'Test' }
            });

            await writeFile(sessionFile, sessionContent);

            const result = claudeCheckSession(hexSessionId, testDir);

            expect(result).toBe(true);
        });
    });

    describe('invalid session ID format', () => {
        it('should return false for malformed session ID', () => {
            const invalidIds = [
                'not-a-valid-uuid',
                '12345',
                '../../../etc/passwd',
                '',
                'gggggggg-gggg-gggg-gggg-gggggggggggg', // invalid hex chars
            ];

            for (const invalidId of invalidIds) {
                const result = claudeCheckSession(invalidId, testDir);
                expect(result).toBe(false);
            }
        });

        it('should return false for truncated UUID', () => {
            const result = claudeCheckSession('93a9705e-bc6a-406d-8dce', testDir);
            expect(result).toBe(false);
        });

        it('should return false for hex ID with wrong length', () => {
            // 31 chars (too short)
            expect(claudeCheckSession('bb6ca0a457344204ada77aa2c27473c', testDir)).toBe(false);
            // 33 chars (too long)
            expect(claudeCheckSession('bb6ca0a457344204ada77aa2c27473c5a', testDir)).toBe(false);
        });

        it('should return false for path traversal attempts', () => {
            const traversalAttempts = [
                '../../../etc/passwd',
                '..\\..\\..\\windows\\system32',
                '93a9705e-bc6a-406d-8dce-8acc014dedbd/../../../etc/passwd',
            ];

            for (const attempt of traversalAttempts) {
                const result = claudeCheckSession(attempt, testDir);
                expect(result).toBe(false);
            }
        });
    });

    describe('non-existent session file', () => {
        it('should return false when session file does not exist', () => {
            const validSessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            // Don't create the file - it doesn't exist

            const result = claudeCheckSession(validSessionId, testDir);

            expect(result).toBe(false);
        });

        it('should return false for valid hex format when file does not exist', () => {
            const hexSessionId = 'bb6ca0a457344204ada77aa2c27473c5';
            // Don't create the file

            const result = claudeCheckSession(hexSessionId, testDir);

            expect(result).toBe(false);
        });
    });

    describe('empty session file', () => {
        it('should return false for empty session file', async () => {
            const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const sessionFile = join(projectDir, `${sessionId}.jsonl`);

            // Create empty file
            await writeFile(sessionFile, '');

            const result = claudeCheckSession(sessionId, testDir);

            expect(result).toBe(false);
        });

        it('should return false for file with only whitespace', async () => {
            const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const sessionFile = join(projectDir, `${sessionId}.jsonl`);

            // Create file with only newlines and whitespace
            await writeFile(sessionFile, '\n\n   \n');

            const result = claudeCheckSession(sessionId, testDir);

            expect(result).toBe(false);
        });
    });

    describe('malformed JSON in file', () => {
        it('should return false for file with invalid JSON', async () => {
            const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const sessionFile = join(projectDir, `${sessionId}.jsonl`);

            // Write invalid JSON
            await writeFile(sessionFile, 'this is not valid json\n{broken json here');

            const result = claudeCheckSession(sessionId, testDir);

            expect(result).toBe(false);
        });

        it('should return false when all lines are invalid JSON', async () => {
            const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const sessionFile = join(projectDir, `${sessionId}.jsonl`);

            await writeFile(sessionFile, 'not json\nalso not json\n');

            const result = claudeCheckSession(sessionId, testDir);

            expect(result).toBe(false);
        });
    });

    describe('file with no uuid fields', () => {
        it('should return false when JSON lines have no uuid field', async () => {
            const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const sessionFile = join(projectDir, `${sessionId}.jsonl`);

            // Write valid JSON but without uuid field
            const sessionContent = [
                JSON.stringify({ type: 'summary', summary: 'Previous conversation summary' }),
                JSON.stringify({ type: 'metadata', version: '1.0' })
            ].join('\n');

            await writeFile(sessionFile, sessionContent);

            const result = claudeCheckSession(sessionId, testDir);

            expect(result).toBe(false);
        });

        it('should return false when uuid field is not a string', async () => {
            const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const sessionFile = join(projectDir, `${sessionId}.jsonl`);

            // Write JSON with uuid as number (invalid)
            const sessionContent = JSON.stringify({
                type: 'user',
                uuid: 12345, // number instead of string
                message: { role: 'user', content: 'Test' }
            });

            await writeFile(sessionFile, sessionContent);

            const result = claudeCheckSession(sessionId, testDir);

            expect(result).toBe(false);
        });

        it('should return false when uuid field is null', async () => {
            const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const sessionFile = join(projectDir, `${sessionId}.jsonl`);

            const sessionContent = JSON.stringify({
                type: 'user',
                uuid: null,
                message: { role: 'user', content: 'Test' }
            });

            await writeFile(sessionFile, sessionContent);

            const result = claudeCheckSession(sessionId, testDir);

            expect(result).toBe(false);
        });
    });

    describe('mixed content in session file', () => {
        it('should return true if at least one line has valid uuid field', async () => {
            const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const sessionFile = join(projectDir, `${sessionId}.jsonl`);

            // Mix of invalid and valid lines
            const sessionContent = [
                JSON.stringify({ type: 'summary', summary: 'Summary without uuid' }),
                'invalid json line',
                JSON.stringify({ type: 'user', uuid: 'valid-uuid', message: { role: 'user', content: 'Hello' } }),
            ].join('\n');

            await writeFile(sessionFile, sessionContent);

            const result = claudeCheckSession(sessionId, testDir);

            expect(result).toBe(true);
        });

        it('should return true when valid message is after invalid lines', async () => {
            const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const sessionFile = join(projectDir, `${sessionId}.jsonl`);

            const sessionContent = [
                'not json',
                JSON.stringify({ no_uuid: true }),
                JSON.stringify({ uuid: 123 }), // wrong type
                JSON.stringify({ uuid: 'valid-string-uuid', type: 'assistant' }), // valid!
            ].join('\n');

            await writeFile(sessionFile, sessionContent);

            const result = claudeCheckSession(sessionId, testDir);

            expect(result).toBe(true);
        });
    });
});
