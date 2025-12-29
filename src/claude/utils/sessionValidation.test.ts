import { describe, it, expect } from 'vitest';
import {
    validateSessionId,
    getValidatedSessionPath,
    isValidSessionId,
    isHexSessionId,
    hexToUuid,
    uuidToHex,
    normalizeSessionId,
    InvalidSessionIdError
} from './sessionValidation';

/** Helper to capture thrown errors for testing - avoids no-conditional-expect lint warnings */
function getError<T extends Error>(fn: () => unknown): T {
  try {
    fn();
    throw new Error('Expected function to throw but it did not');
  } catch (e) {
    if (e instanceof Error && e.message === 'Expected function to throw but it did not') {
      throw e;
    }
    return e as T;
  }
}

describe('sessionValidation', () => {
    describe('validateSessionId', () => {
        it('should accept valid UUID v4 format', () => {
            const validUUIDs = [
                '93a9705e-bc6a-406d-8dce-8acc014dedbd',
                'aada10c6-9299-4c45-abc4-91db9c0f935d',
                '1433467f-ff14-4292-b5b2-2aac77a808f0',
                'AADA10C6-9299-4C45-ABC4-91DB9C0F935D', // uppercase
            ];

            for (const uuid of validUUIDs) {
                expect(() => validateSessionId(uuid)).not.toThrow();
                expect(validateSessionId(uuid)).toBe(true);
            }
        });

        it('should reject path traversal attempts', () => {
            const traversalAttempts = [
                '../../../etc/passwd',
                '..\\..\\..\\windows\\system32',
                'valid-uuid-prefix/../../../etc/passwd',
                '93a9705e-bc6a-406d-8dce-8acc014dedbd/../../../etc/passwd',
            ];

            for (const attempt of traversalAttempts) {
                expect(() => validateSessionId(attempt)).toThrow(InvalidSessionIdError);
            }
        });

        it('should reject malformed session IDs', () => {
            const malformed = [
                '', // empty
                'not-a-uuid',
                '12345',
                '93a9705e-bc6a-406d-8dce', // truncated
                '93a9705e-bc6a-406d-8dce-8acc014dedbd-extra', // too long
                '93a9705e_bc6a_406d_8dce_8acc014dedbd', // wrong separator
                'gggggggg-gggg-gggg-gggg-gggggggggggg', // invalid hex chars
            ];

            for (const id of malformed) {
                expect(() => validateSessionId(id)).toThrow(InvalidSessionIdError);
            }
        });

        it('should truncate long session IDs in error messages', () => {
            const longId = 'x'.repeat(100);

            const error = getError<InvalidSessionIdError>(() => validateSessionId(longId));
            expect(error).toBeInstanceOf(InvalidSessionIdError);
            expect(error.message).toContain('...');
            expect(error.message.length).toBeLessThan(150);
        });
    });

    describe('isValidSessionId', () => {
        it('should return true for valid UUIDs', () => {
            expect(isValidSessionId('93a9705e-bc6a-406d-8dce-8acc014dedbd')).toBe(true);
        });

        it('should return true for valid hex session IDs (32 chars)', () => {
            expect(isValidSessionId('bb6ca0a457344204ada77aa2c27473c5')).toBe(true);
            expect(isValidSessionId('BB6CA0A457344204ADA77AA2C27473C5')).toBe(true);
        });

        it('should return false for invalid IDs without throwing', () => {
            expect(isValidSessionId('../etc/passwd')).toBe(false);
            expect(isValidSessionId('not-a-uuid')).toBe(false);
            expect(isValidSessionId('')).toBe(false);
        });
    });

    describe('isHexSessionId', () => {
        it('should return true for valid 32-char hex strings', () => {
            expect(isHexSessionId('bb6ca0a457344204ada77aa2c27473c5')).toBe(true);
            expect(isHexSessionId('BB6CA0A457344204ADA77AA2C27473C5')).toBe(true);
            expect(isHexSessionId('f7df87cf91644819924704c6ed07dada')).toBe(true);
        });

        it('should return false for UUIDs with hyphens', () => {
            expect(isHexSessionId('93a9705e-bc6a-406d-8dce-8acc014dedbd')).toBe(false);
        });

        it('should return false for wrong length strings', () => {
            expect(isHexSessionId('bb6ca0a457344204ada77aa2c27473c')).toBe(false); // 31 chars
            expect(isHexSessionId('bb6ca0a457344204ada77aa2c27473c5a')).toBe(false); // 33 chars
        });

        it('should return false for non-hex characters', () => {
            expect(isHexSessionId('gg6ca0a457344204ada77aa2c27473c5')).toBe(false);
        });
    });

    describe('hexToUuid', () => {
        it('should convert hex to UUID format', () => {
            expect(hexToUuid('bb6ca0a457344204ada77aa2c27473c5')).toBe('bb6ca0a4-5734-4204-ada7-7aa2c27473c5');
            expect(hexToUuid('BB6CA0A457344204ADA77AA2C27473C5')).toBe('bb6ca0a4-5734-4204-ada7-7aa2c27473c5');
        });

        it('should throw for invalid hex IDs', () => {
            expect(() => hexToUuid('not-valid-hex')).toThrow(InvalidSessionIdError);
            expect(() => hexToUuid('93a9705e-bc6a-406d-8dce-8acc014dedbd')).toThrow(InvalidSessionIdError);
        });
    });

    describe('uuidToHex', () => {
        it('should convert UUID to hex format', () => {
            expect(uuidToHex('93a9705e-bc6a-406d-8dce-8acc014dedbd')).toBe('93a9705ebc6a406d8dce8acc014dedbd');
            expect(uuidToHex('93A9705E-BC6A-406D-8DCE-8ACC014DEDBD')).toBe('93a9705ebc6a406d8dce8acc014dedbd');
        });

        it('should throw for invalid UUIDs', () => {
            expect(() => uuidToHex('not-a-uuid')).toThrow(InvalidSessionIdError);
            expect(() => uuidToHex('bb6ca0a457344204ada77aa2c27473c5')).toThrow(InvalidSessionIdError);
        });
    });

    describe('normalizeSessionId', () => {
        it('should pass through valid UUIDs', () => {
            expect(normalizeSessionId('93a9705e-bc6a-406d-8dce-8acc014dedbd')).toBe('93a9705e-bc6a-406d-8dce-8acc014dedbd');
        });

        it('should lowercase UUIDs', () => {
            expect(normalizeSessionId('93A9705E-BC6A-406D-8DCE-8ACC014DEDBD')).toBe('93a9705e-bc6a-406d-8dce-8acc014dedbd');
        });

        it('should convert hex IDs to UUID format', () => {
            expect(normalizeSessionId('bb6ca0a457344204ada77aa2c27473c5')).toBe('bb6ca0a4-5734-4204-ada7-7aa2c27473c5');
            expect(normalizeSessionId('BB6CA0A457344204ADA77AA2C27473C5')).toBe('bb6ca0a4-5734-4204-ada7-7aa2c27473c5');
        });

        it('should throw for invalid session IDs', () => {
            expect(() => normalizeSessionId('not-valid')).toThrow(InvalidSessionIdError);
            expect(() => normalizeSessionId('')).toThrow(InvalidSessionIdError);
            expect(() => normalizeSessionId('../etc/passwd')).toThrow(InvalidSessionIdError);
        });
    });

    describe('getValidatedSessionPath', () => {
        const baseDir = '/home/user/.claude/projects/myproject';

        it('should return valid path for valid session ID', () => {
            const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const result = getValidatedSessionPath(baseDir, sessionId);

            expect(result).toBe(`${baseDir}/${sessionId}.jsonl`);
        });

        it('should reject path traversal attempts via session ID', () => {
            const attacks = [
                '../../../etc/passwd',
                '..%2F..%2F..%2Fetc%2Fpasswd',
                '....//....//etc/passwd',
                '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
            ];

            for (const attack of attacks) {
                expect(() => getValidatedSessionPath(baseDir, attack)).toThrow(InvalidSessionIdError);
            }
        });

        it('should reject session IDs with null bytes', () => {
            // Null byte injection attempt
            const nullByteAttack = '93a9705e-bc6a-406d-8dce-8acc014dedbd\x00.txt';
            expect(() => getValidatedSessionPath(baseDir, nullByteAttack)).toThrow(InvalidSessionIdError);
        });

        it('should reject session IDs with special characters', () => {
            const specialChars = [
                '93a9705e;rm -rf /',
                '93a9705e`whoami`',
                '93a9705e$(cat /etc/passwd)',
                "93a9705e'||'",
            ];

            for (const attack of specialChars) {
                expect(() => getValidatedSessionPath(baseDir, attack)).toThrow(InvalidSessionIdError);
            }
        });

        it('should handle edge case with current directory reference', () => {
            // Even with valid-looking patterns, UUID validation should catch these
            const edgeCases = [
                './93a9705e-bc6a-406d-8dce-8acc014dedbd',
                '93a9705e-bc6a-406d-8dce-8acc014dedbd/.',
            ];

            for (const edgeCase of edgeCases) {
                expect(() => getValidatedSessionPath(baseDir, edgeCase)).toThrow(InvalidSessionIdError);
            }
        });

        it('should be case-insensitive for hex characters', () => {
            const lowerCase = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const upperCase = '93A9705E-BC6A-406D-8DCE-8ACC014DEDBD';
            const mixedCase = '93A9705e-bc6A-406d-8DCE-8acc014DEDBD';

            expect(() => getValidatedSessionPath(baseDir, lowerCase)).not.toThrow();
            expect(() => getValidatedSessionPath(baseDir, upperCase)).not.toThrow();
            expect(() => getValidatedSessionPath(baseDir, mixedCase)).not.toThrow();
        });

        it('should prevent path prefix matching attacks', () => {
            // Test that base directory validation prevents prefix matching
            // e.g., ensure "/home/user" doesn't match "/home/userdata/file"
            const validSessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd';
            const result = getValidatedSessionPath('/home/user', validSessionId);

            // Should successfully create path within the correct directory
            expect(result).toBe('/home/user/93a9705e-bc6a-406d-8dce-8acc014dedbd.jsonl');
        });
    });

    describe('InvalidSessionIdError', () => {
        it('should have correct error name', () => {
            const error = new InvalidSessionIdError('test message');
            expect(error.name).toBe('InvalidSessionIdError');
        });

        it('should extend Error', () => {
            const error = new InvalidSessionIdError('test message');
            expect(error).toBeInstanceOf(Error);
            expect(error).toBeInstanceOf(InvalidSessionIdError);
        });
    });
});
