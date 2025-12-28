/**
 * Unit tests for MCP Server Validator
 *
 * Tests validation logic using mocked MCP SDK transport and client.
 * Covers success scenarios, error handling, timeouts, and disabled servers.
 *
 * @module mcp/validator.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HappyMcpServerConfig } from './types';

// Shared mock state that persists across all Client instances
const mockState = {
    connectBehavior: 'resolve' as 'resolve' | 'reject' | 'timeout',
    connectError: null as Error | string | null,
    connectTimeout: 0,
    listToolsResult: {
        tools: [
            { name: 'read_file', description: 'Read a file' },
            { name: 'write_file', description: 'Write to a file' },
        ],
    } as { tools: Array<{ name: string; description?: string }> },
    listToolsError: null as Error | null,
    closeError: null as Error | null,
    closeCalls: 0,
    connectCalls: 0,
};

// Track transport calls for assertions
let mockTransportCalls: { command: string; args?: string[]; env?: Record<string, string> }[] = [];

// Mock the MCP SDK with proper class constructors
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
    return {
        Client: class MockClient {
            async connect(): Promise<void> {
                mockState.connectCalls++;
                if (mockState.connectBehavior === 'reject') {
                    throw mockState.connectError ?? new Error('Connection failed');
                }
                if (mockState.connectBehavior === 'timeout') {
                    await new Promise((resolve) => setTimeout(resolve, mockState.connectTimeout));
                }
            }

            async listTools(): Promise<{ tools: Array<{ name: string; description?: string }> }> {
                if (mockState.listToolsError) {
                    throw mockState.listToolsError;
                }
                return mockState.listToolsResult;
            }

            async close(): Promise<void> {
                mockState.closeCalls++;
                if (mockState.closeError) {
                    throw mockState.closeError;
                }
            }
        },
    };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
    return {
        StdioClientTransport: class MockTransport {
            command: string;
            args: string[];
            env: Record<string, string>;

            constructor(config: { command: string; args?: string[]; env?: Record<string, string> }) {
                this.command = config.command;
                this.args = config.args ?? [];
                this.env = config.env ?? {};
                // Track calls for assertions
                mockTransportCalls.push({
                    command: config.command,
                    args: config.args,
                    env: config.env,
                });
            }
        },
    };
});

// Import after mocks are set up
import { validateMcpServer, validateAllServers } from './validator';

// Helper to reset mock state
function resetMockState() {
    mockState.connectBehavior = 'resolve';
    mockState.connectError = null;
    mockState.connectTimeout = 0;
    mockState.listToolsResult = {
        tools: [
            { name: 'read_file', description: 'Read a file' },
            { name: 'write_file', description: 'Write to a file' },
        ],
    };
    mockState.listToolsError = null;
    mockState.closeError = null;
    mockState.closeCalls = 0;
    mockState.connectCalls = 0;
    mockTransportCalls = [];
}

describe('validateMcpServer', () => {
    beforeEach(() => {
        resetMockState();
    });

    describe('successful validation', () => {
        it('should return success with tool count and tools list', async () => {
            const config: HappyMcpServerConfig = {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-github'],
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            const result = await validateMcpServer('github', config);

            expect(result.success).toBe(true);
            expect(result.serverName).toBe('github');
            expect(result.toolCount).toBe(2);
            expect(result.tools).toHaveLength(2);
            expect(result.tools?.[0].name).toBe('read_file');
            expect(result.tools?.[0].description).toBe('Read a file');
            expect(result.tools?.[1].name).toBe('write_file');
            expect(result.validatedAt).toBeDefined();
            expect(result.error).toBeUndefined();
        });

        it('should create transport with correct config', async () => {
            const config: HappyMcpServerConfig = {
                command: 'node',
                args: ['server.js', '--port', '3000'],
                env: { API_KEY: 'secret123' },
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            await validateMcpServer('custom', config);

            expect(mockTransportCalls).toHaveLength(1);
            expect(mockTransportCalls[0].command).toBe('node');
            expect(mockTransportCalls[0].args).toEqual(['server.js', '--port', '3000']);
            expect(mockTransportCalls[0].env).toHaveProperty('API_KEY', 'secret123');
        });

        it('should close client connection after successful validation', async () => {
            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            await validateMcpServer('test', config);

            expect(mockState.closeCalls).toBe(1);
        });

        it('should handle empty tools list', async () => {
            mockState.listToolsResult = { tools: [] };

            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            const result = await validateMcpServer('empty', config);

            expect(result.success).toBe(true);
            expect(result.toolCount).toBe(0);
            expect(result.tools).toEqual([]);
        });

        it('should handle tools without descriptions', async () => {
            mockState.listToolsResult = {
                tools: [{ name: 'tool1' }, { name: 'tool2', description: undefined }],
            };

            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            const result = await validateMcpServer('no-desc', config);

            expect(result.success).toBe(true);
            expect(result.tools?.[0].name).toBe('tool1');
            expect(result.tools?.[0].description).toBeUndefined();
        });
    });

    describe('disabled servers', () => {
        it('should skip disabled servers without connecting', async () => {
            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: true,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            const result = await validateMcpServer('disabled', config);

            expect(result.success).toBe(true);
            expect(result.serverName).toBe('disabled');
            expect(result.error).toBe('Skipped (disabled)');
            expect(result.toolCount).toBeUndefined();
            expect(result.tools).toBeUndefined();
            expect(result.validatedAt).toBeDefined();

            // Should not attempt to connect
            expect(mockTransportCalls).toHaveLength(0);
            expect(mockState.connectCalls).toBe(0);
        });
    });

    describe('connection errors', () => {
        it('should return error on connection failure', async () => {
            mockState.connectBehavior = 'reject';
            mockState.connectError = new Error('Connection refused');

            const config: HappyMcpServerConfig = {
                command: 'invalid-command',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            const result = await validateMcpServer('broken', config);

            expect(result.success).toBe(false);
            expect(result.serverName).toBe('broken');
            expect(result.error).toBe('Connection refused');
            expect(result.toolCount).toBeUndefined();
            expect(result.tools).toBeUndefined();
            expect(result.validatedAt).toBeDefined();
        });

        it('should return error on listTools failure', async () => {
            mockState.listToolsError = new Error('Protocol error');

            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            const result = await validateMcpServer('protocol-error', config);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Protocol error');
        });

        it('should handle non-Error exceptions', async () => {
            mockState.connectBehavior = 'reject';
            mockState.connectError = 'string error';

            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            const result = await validateMcpServer('string-error', config);

            expect(result.success).toBe(false);
            expect(result.error).toBe('string error');
        });

        it('should attempt cleanup even on error', async () => {
            mockState.connectBehavior = 'reject';
            mockState.connectError = new Error('Connection failed');

            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            await validateMcpServer('cleanup-test', config);

            // close() should still be called for cleanup
            expect(mockState.closeCalls).toBeGreaterThan(0);
        });

        it('should ignore cleanup errors', async () => {
            mockState.listToolsError = new Error('List failed');
            mockState.closeError = new Error('Close failed too');

            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            // Should not throw, even though close() fails
            const result = await validateMcpServer('cleanup-error', config);

            expect(result.success).toBe(false);
            expect(result.error).toBe('List failed');
        });
    });

    describe('timeout handling', () => {
        it('should use custom timeout from config', async () => {
            // Make connect take longer than the timeout
            mockState.connectBehavior = 'timeout';
            mockState.connectTimeout = 500;

            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 100, // Very short timeout
            };

            const result = await validateMcpServer('slow', config);

            expect(result.success).toBe(false);
            expect(result.error).toContain('timeout');
            expect(result.error).toContain('100ms');
        });
    });

    describe('config edge cases', () => {
        it('should handle missing args', async () => {
            const config: HappyMcpServerConfig = {
                command: 'simple-server',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            await validateMcpServer('no-args', config);

            const lastCall = mockTransportCalls[mockTransportCalls.length - 1];
            expect(lastCall.command).toBe('simple-server');
            expect(lastCall.args).toEqual([]);
        });

        it('should handle missing env', async () => {
            const config: HappyMcpServerConfig = {
                command: 'server',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            await validateMcpServer('no-env', config);

            const lastCall = mockTransportCalls[mockTransportCalls.length - 1];
            // Should still pass process.env through
            expect(lastCall.env).toBeDefined();
            expect(typeof lastCall.env).toBe('object');
        });

        it('should merge config.env with process.env', async () => {
            const config: HappyMcpServerConfig = {
                command: 'server',
                env: { CUSTOM_VAR: 'custom_value' },
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            await validateMcpServer('merged-env', config);

            const lastCall = mockTransportCalls[mockTransportCalls.length - 1];
            expect(lastCall.env).toHaveProperty('CUSTOM_VAR', 'custom_value');
            // Should also have process.env keys (like PATH)
            expect(lastCall.env).toHaveProperty('PATH');
        });
    });

    describe('validatedAt timestamp', () => {
        it('should include ISO timestamp on success', async () => {
            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            const before = new Date().toISOString();
            const result = await validateMcpServer('timestamp', config);
            const after = new Date().toISOString();

            expect(result.validatedAt).toBeDefined();
            expect(result.validatedAt >= before).toBe(true);
            expect(result.validatedAt <= after).toBe(true);
        });

        it('should include ISO timestamp on failure', async () => {
            mockState.connectBehavior = 'reject';
            mockState.connectError = new Error('Failed');

            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            const result = await validateMcpServer('failed-timestamp', config);

            expect(result.validatedAt).toBeDefined();
            // Verify it's a valid ISO date
            expect(new Date(result.validatedAt).toISOString()).toBe(result.validatedAt);
        });

        it('should include ISO timestamp for disabled servers', async () => {
            const config: HappyMcpServerConfig = {
                command: 'node',
                disabled: true,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            };

            const result = await validateMcpServer('disabled-timestamp', config);

            expect(result.validatedAt).toBeDefined();
        });
    });
});

describe('validateAllServers', () => {
    beforeEach(() => {
        resetMockState();
    });

    it('should validate all servers in order', async () => {
        const servers: Record<string, HappyMcpServerConfig> = {
            server1: {
                command: 'cmd1',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            },
            server2: {
                command: 'cmd2',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            },
            server3: {
                command: 'cmd3',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            },
        };

        const results = await validateAllServers(servers);

        expect(results).toHaveLength(3);
        expect(results[0].serverName).toBe('server1');
        expect(results[1].serverName).toBe('server2');
        expect(results[2].serverName).toBe('server3');
        expect(results.every((r) => r.success)).toBe(true);
    });

    it('should skip disabled servers in the list', async () => {
        const servers: Record<string, HappyMcpServerConfig> = {
            enabled: {
                command: 'cmd',
                disabled: false,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            },
            disabled: {
                command: 'cmd',
                disabled: true,
                disabledTools: [],
                autoApprove: [],
                timeout: 5000,
            },
        };

        const results = await validateAllServers(servers);

        expect(results).toHaveLength(2);

        const enabledResult = results.find((r) => r.serverName === 'enabled');
        const disabledResult = results.find((r) => r.serverName === 'disabled');

        expect(enabledResult?.success).toBe(true);
        expect(enabledResult?.toolCount).toBe(2); // Default mock returns 2 tools

        expect(disabledResult?.success).toBe(true);
        expect(disabledResult?.error).toBe('Skipped (disabled)');
        expect(disabledResult?.toolCount).toBeUndefined();
    });

    it('should handle empty servers record', async () => {
        const servers: Record<string, HappyMcpServerConfig> = {};

        const results = await validateAllServers(servers);

        expect(results).toHaveLength(0);
    });
});

describe('Integration scenarios', () => {
    beforeEach(() => {
        resetMockState();
    });

    it('should simulate validating a GitHub MCP server', async () => {
        mockState.listToolsResult = {
            tools: [
                { name: 'search_repos', description: 'Search GitHub repositories' },
                { name: 'create_issue', description: 'Create a GitHub issue' },
                { name: 'read_file', description: 'Read file contents' },
            ],
        };

        const config: HappyMcpServerConfig = {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_TOKEN: 'ghp_test_token' },
            disabled: false,
            disabledTools: [],
            autoApprove: ['search_*'],
            timeout: 10000,
            metadata: {
                addedAt: '2024-12-28T00:00:00.000Z',
                description: 'GitHub MCP server',
            },
        };

        const result = await validateMcpServer('github', config);

        expect(result.success).toBe(true);
        expect(result.serverName).toBe('github');
        expect(result.toolCount).toBe(3);
        expect(result.tools?.map((t) => t.name)).toContain('search_repos');
        expect(result.tools?.map((t) => t.name)).toContain('create_issue');
        expect(result.tools?.map((t) => t.name)).toContain('read_file');
    });
});
