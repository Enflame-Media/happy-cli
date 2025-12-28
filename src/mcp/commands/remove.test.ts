/**
 * Unit tests for MCP Remove Command
 *
 * Tests the `happy mcp remove` command functionality including:
 * - Successful server removal with --force
 * - Non-existent server error handling
 * - Scope handling (user vs project)
 * - Confirmation prompt behavior (mocked)
 *
 * @module mcp/commands/remove.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { removeCommand, type RemoveCommandOptions } from './remove.js';
import * as config from '../config.js';

// Mock the config module
vi.mock('../config.js', () => ({
    loadMcpConfig: vi.fn(),
    saveMcpConfig: vi.fn(),
    getMcpConfigPath: vi.fn(() => '/mock/path/mcp.json'),
}));

// Mock chalk to avoid color code issues in test assertions
vi.mock('chalk', () => ({
    default: {
        red: vi.fn((str: string) => str),
        green: vi.fn((str: string) => str),
        gray: vi.fn((str: string) => str),
    },
}));

// Mock readline for confirmation prompt testing
// We need to define the mock implementation inside the vi.mock factory
// because vi.mock is hoisted to the top of the file
vi.mock('readline', () => {
    const mockQuestion = vi.fn((message: string, callback: (answer: string) => void) => {
        // Default: simulate user declining (empty or 'n')
        callback('n');
    });
    const mockClose = vi.fn();
    const createInterfaceFn = vi.fn(() => ({
        question: mockQuestion,
        close: mockClose,
    }));
    return {
        default: {
            createInterface: createInterfaceFn,
        },
        createInterface: createInterfaceFn,
    };
});

import readline from 'readline';

describe('removeCommand', () => {
    // Spies for console and process.exit
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let processExitSpy: ReturnType<typeof vi.spyOn>;

    // Sample config with a server to remove
    const configWithServer = {
        version: 1 as const,
        mcpServers: {
            'test-server': {
                command: 'npx',
                args: ['test-mcp-server'],
                disabled: false,
                disabledTools: [] as string[],
                autoApprove: [] as string[],
                timeout: 5000,
                metadata: {
                    addedAt: '2024-12-28T00:00:00.000Z',
                },
            },
            'another-server': {
                command: 'node',
                args: ['server.js'],
                disabled: false,
                disabledTools: [] as string[],
                autoApprove: [] as string[],
                timeout: 5000,
            },
        },
    };

    beforeEach(() => {
        // Reset all mocks
        vi.clearAllMocks();

        // Setup console spies
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        // Mock process.exit to throw instead of exiting
        processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
            throw new Error(`process.exit(${code})`);
        });

        // Default: return config with servers
        vi.mocked(config.loadMcpConfig).mockReturnValue(structuredClone(configWithServer));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('successful removal with --force', () => {
        it('should remove existing server when --force is provided', async () => {
            const options: RemoveCommandOptions = { force: true, scope: 'user' };

            await removeCommand('test-server', options);

            // Verify saveMcpConfig was called
            expect(config.saveMcpConfig).toHaveBeenCalledTimes(1);

            // Verify the server was removed from config
            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            expect(savedConfig.mcpServers['test-server']).toBeUndefined();
            expect(savedConfig.mcpServers['another-server']).toBeDefined();
        });

        it('should preserve other servers when removing one', async () => {
            const options: RemoveCommandOptions = { force: true, scope: 'user' };

            await removeCommand('test-server', options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            expect(savedConfig.mcpServers['another-server']).toBeDefined();
            expect(savedConfig.mcpServers['another-server'].command).toBe('node');
        });

        it('should display success message', async () => {
            const options: RemoveCommandOptions = { force: true, scope: 'user' };

            await removeCommand('test-server', options);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('Removed MCP server "test-server"')
            );
        });

        it('should display config path', async () => {
            const options: RemoveCommandOptions = { force: true, scope: 'user' };

            await removeCommand('test-server', options);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('Config:')
            );
        });
    });

    describe('non-existent server error', () => {
        it('should show error for non-existent server', async () => {
            const options: RemoveCommandOptions = { force: true, scope: 'user' };

            await expect(
                removeCommand('does-not-exist', options)
            ).rejects.toThrow('process.exit(1)');

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('not found')
            );
        });

        it('should suggest list command when server not found', async () => {
            const options: RemoveCommandOptions = { force: true, scope: 'user' };

            await expect(removeCommand('missing', options)).rejects.toThrow();

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('happy mcp list')
            );
        });

        it('should not save config when server not found', async () => {
            const options: RemoveCommandOptions = { force: true, scope: 'user' };

            await expect(removeCommand('missing', options)).rejects.toThrow();

            expect(config.saveMcpConfig).not.toHaveBeenCalled();
        });
    });

    describe('scope handling', () => {
        it('should load and save to user scope', async () => {
            const options: RemoveCommandOptions = { force: true, scope: 'user' };

            await removeCommand('test-server', options);

            expect(config.loadMcpConfig).toHaveBeenCalledWith('user');
            expect(config.saveMcpConfig).toHaveBeenCalledWith(
                expect.anything(),
                'user'
            );
        });

        it('should load and save to project scope', async () => {
            const options: RemoveCommandOptions = { force: true, scope: 'project' };

            await removeCommand('test-server', options);

            expect(config.loadMcpConfig).toHaveBeenCalledWith('project');
            expect(config.saveMcpConfig).toHaveBeenCalledWith(
                expect.anything(),
                'project'
            );
        });
    });

    describe('confirmation prompt behavior', () => {
        it('should cancel removal when user declines confirmation', async () => {
            // Default mock returns 'n' for confirmation
            const options: RemoveCommandOptions = { force: false, scope: 'user' };

            await removeCommand('test-server', options);

            // Should log cancelled message
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('Cancelled')
            );

            // Should NOT save config
            expect(config.saveMcpConfig).not.toHaveBeenCalled();
        });

        it('should proceed with removal when user confirms', async () => {
            // Mock user typing 'y'
            vi.mocked(readline.createInterface).mockReturnValueOnce({
                question: vi.fn((message: string, callback: (answer: string) => void) => {
                    callback('y');
                }),
                close: vi.fn(),
            } as unknown as ReturnType<typeof readline.createInterface>);

            const options: RemoveCommandOptions = { force: false, scope: 'user' };

            await removeCommand('test-server', options);

            // Should save config (server removed)
            expect(config.saveMcpConfig).toHaveBeenCalled();
        });

        it('should skip confirmation when --force is true', async () => {
            const options: RemoveCommandOptions = { force: true, scope: 'user' };

            await removeCommand('test-server', options);

            // Should not create readline interface
            expect(readline.createInterface).not.toHaveBeenCalled();

            // Should save config directly
            expect(config.saveMcpConfig).toHaveBeenCalled();
        });

        it('should treat lowercase y as confirmation', async () => {
            vi.mocked(readline.createInterface).mockReturnValueOnce({
                question: vi.fn((message: string, callback: (answer: string) => void) => {
                    callback('y');
                }),
                close: vi.fn(),
            } as unknown as ReturnType<typeof readline.createInterface>);

            const options: RemoveCommandOptions = { force: false, scope: 'user' };

            await removeCommand('test-server', options);

            expect(config.saveMcpConfig).toHaveBeenCalled();
        });

        it('should treat anything other than y as decline', async () => {
            vi.mocked(readline.createInterface).mockReturnValueOnce({
                question: vi.fn((message: string, callback: (answer: string) => void) => {
                    callback('yes'); // Not just 'y'
                }),
                close: vi.fn(),
            } as unknown as ReturnType<typeof readline.createInterface>);

            const options: RemoveCommandOptions = { force: false, scope: 'user' };

            await removeCommand('test-server', options);

            expect(config.saveMcpConfig).not.toHaveBeenCalled();
        });

        it('should treat empty input as decline', async () => {
            vi.mocked(readline.createInterface).mockReturnValueOnce({
                question: vi.fn((message: string, callback: (answer: string) => void) => {
                    callback('');
                }),
                close: vi.fn(),
            } as unknown as ReturnType<typeof readline.createInterface>);

            const options: RemoveCommandOptions = { force: false, scope: 'user' };

            await removeCommand('test-server', options);

            expect(config.saveMcpConfig).not.toHaveBeenCalled();
        });
    });

    describe('edge cases', () => {
        it('should handle removing last server in config', async () => {
            vi.mocked(config.loadMcpConfig).mockReturnValue({
                version: 1,
                mcpServers: {
                    'only-server': {
                        command: 'test',
                        disabled: false,
                        disabledTools: [],
                        autoApprove: [],
                        timeout: 5000,
                    },
                },
            });

            const options: RemoveCommandOptions = { force: true, scope: 'user' };

            await removeCommand('only-server', options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            expect(Object.keys(savedConfig.mcpServers).length).toBe(0);
        });

        it('should handle server with complex metadata', async () => {
            vi.mocked(config.loadMcpConfig).mockReturnValue({
                version: 1,
                mcpServers: {
                    'complex-server': {
                        command: 'npx',
                        args: ['server'],
                        env: { TOKEN: 'secret' },
                        disabled: true,
                        disabledTools: ['tool1'],
                        autoApprove: ['read_*'],
                        timeout: 10000,
                        metadata: {
                            addedAt: '2024-12-28T00:00:00.000Z',
                            lastValidated: '2024-12-28T01:00:00.000Z',
                            toolCount: 5,
                            description: 'Test server',
                        },
                    },
                },
            });

            const options: RemoveCommandOptions = { force: true, scope: 'user' };

            await removeCommand('complex-server', options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            expect(savedConfig.mcpServers['complex-server']).toBeUndefined();
        });
    });
});
