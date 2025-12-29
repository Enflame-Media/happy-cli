/**
 * Tests for RpcHandlerManager error handling improvements
 * @see HAP-642 - Improved RPC error handling for stopped/archived sessions
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RpcHandlerManager, RPC_ERROR_CODES } from './RpcHandlerManager';
import { decrypt, decodeBase64 } from '@/api/encryption';

// Mock encryption module
vi.mock('@/api/encryption', () => ({
    encrypt: vi.fn((key, variant, data) => {
        // Return a mock encrypted string that's actually just JSON for testing
        return new TextEncoder().encode(JSON.stringify(data));
    }),
    decrypt: vi.fn((key, variant, data) => {
        // Return the mock decrypted data
        try {
            return JSON.parse(new TextDecoder().decode(data));
        } catch {
            return null;
        }
    }),
    encodeBase64: vi.fn((data) => {
        return Buffer.from(data).toString('base64');
    }),
    decodeBase64: vi.fn((data) => {
        return new Uint8Array(Buffer.from(data, 'base64'));
    }),
}));

describe('RpcHandlerManager', () => {
    let manager: RpcHandlerManager;
    let mockLogger: (message: string, data?: unknown) => void;
    let loggerCalls: Array<{ message: string; data?: unknown }>;
    const testEncryptionKey = new Uint8Array(32); // 256-bit key
    const testScopePrefix = 'test-scope';

    beforeEach(() => {
        loggerCalls = [];
        mockLogger = (message: string, data?: unknown) => {
            loggerCalls.push({ message, data });
        };
        manager = new RpcHandlerManager({
            scopePrefix: testScopePrefix,
            encryptionKey: testEncryptionKey,
            encryptionVariant: 'dataKey',
            logger: mockLogger,
        });
    });

    describe('RPC_ERROR_CODES', () => {
        it('should export all expected error codes', () => {
            expect(RPC_ERROR_CODES.METHOD_NOT_FOUND).toBe('METHOD_NOT_FOUND');
            expect(RPC_ERROR_CODES.SESSION_NOT_ACTIVE).toBe('SESSION_NOT_ACTIVE');
            expect(RPC_ERROR_CODES.OPERATION_CANCELLED).toBe('OPERATION_CANCELLED');
            expect(RPC_ERROR_CODES.DECRYPTION_FAILED).toBe('DECRYPTION_FAILED');
            expect(RPC_ERROR_CODES.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
        });
    });

    describe('handleRequest - Method Not Found', () => {
        it('should return SESSION_NOT_ACTIVE for session-scoped methods', async () => {
            // Session ID is 32+ chars (UUID without hyphens or with hyphens)
            const sessionId = 'bb6ca0a457344204ada77aa2c27473c5';
            const method = `${sessionId}:getAllowedCommands`;

            const result = await manager.handleRequest({
                method,
                params: 'encrypted-params',
            });

            // Decode and parse the result
            const decoded = Buffer.from(result, 'base64');
            const parsed = JSON.parse(new TextDecoder().decode(decoded));

            expect(parsed.code).toBe(RPC_ERROR_CODES.SESSION_NOT_ACTIVE);
            expect(parsed.error).toBe('Session not active');
            expect(parsed.message).toContain('session this method belongs to is no longer active');
            expect(parsed.method).toBe('getAllowedCommands');
            expect(parsed.cancelled).toBe(false);

            // Should log at DEBUG level, not ERROR
            expect(loggerCalls.some(call =>
                call.message === '[RPC] [DEBUG] Method not found for session (session may have stopped)' &&
                (call.data as Record<string, unknown>)?.method === method &&
                (call.data as Record<string, unknown>)?.sessionPrefix === 'bb6ca0a4...'
            )).toBe(true);
        });

        it('should return SESSION_NOT_ACTIVE for UUID-formatted session IDs', async () => {
            // UUID format (36 chars with hyphens)
            const sessionId = 'bb6ca0a4-5734-4204-ada7-7aa2c27473c5';
            const method = `${sessionId}:bash`;

            const result = await manager.handleRequest({
                method,
                params: 'encrypted-params',
            });

            const decoded = Buffer.from(result, 'base64');
            const parsed = JSON.parse(new TextDecoder().decode(decoded));

            expect(parsed.code).toBe(RPC_ERROR_CODES.SESSION_NOT_ACTIVE);
            expect(parsed.method).toBe('bash');
        });

        it('should return METHOD_NOT_FOUND for non-session-scoped methods', async () => {
            // Short prefix (not a session ID)
            const method = 'unknown:method';

            const result = await manager.handleRequest({
                method,
                params: 'encrypted-params',
            });

            const decoded = Buffer.from(result, 'base64');
            const parsed = JSON.parse(new TextDecoder().decode(decoded));

            expect(parsed.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
            expect(parsed.error).toBe('Method not found');

            // Should log at ERROR level for non-session methods
            expect(loggerCalls.some(call =>
                call.message === '[RPC] [ERROR] Method not found' &&
                (call.data as Record<string, unknown>)?.method === method
            )).toBe(true);
        });

        it('should return METHOD_NOT_FOUND for methods without prefix', async () => {
            const method = 'simpleMethod';

            const result = await manager.handleRequest({
                method,
                params: 'encrypted-params',
            });

            const decoded = Buffer.from(result, 'base64');
            const parsed = JSON.parse(new TextDecoder().decode(decoded));

            expect(parsed.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
        });
    });

    describe('hasHandler', () => {
        it('should return false for unregistered handlers', () => {
            expect(manager.hasHandler('nonexistent')).toBe(false);
        });

        it('should return true for registered handlers', () => {
            manager.registerHandler('test-method', async () => ({ ok: true }));
            expect(manager.hasHandler('test-method')).toBe(true);
        });
    });

    describe('getHandlerCount', () => {
        it('should return 0 for new manager', () => {
            expect(manager.getHandlerCount()).toBe(0);
        });

        it('should return correct count after registrations', () => {
            manager.registerHandler('method1', async () => ({}));
            manager.registerHandler('method2', async () => ({}));
            expect(manager.getHandlerCount()).toBe(2);
        });
    });

    describe('clearHandlers', () => {
        it('should remove all handlers', () => {
            manager.registerHandler('method1', async () => ({}));
            manager.registerHandler('method2', async () => ({}));
            expect(manager.getHandlerCount()).toBe(2);

            manager.clearHandlers();
            expect(manager.getHandlerCount()).toBe(0);
        });
    });
});
