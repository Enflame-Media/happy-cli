/**
 * Unit tests for MCP Add Command
 *
 * Tests the `happy mcp add` command functionality including:
 * - Adding new servers with command and arguments
 * - Environment variable parsing edge cases
 * - Duplicate server name rejection
 * - Scope handling (user vs project)
 * - Missing command validation
 *
 * @module mcp/commands/add.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addCommand, type AddCommandOptions } from './add.js';
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

describe('addCommand', () => {
    // Spies for console and process.exit
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let processExitSpy: ReturnType<typeof vi.spyOn>;

    // Default empty config for tests
    const emptyConfig = {
        version: 1 as const,
        mcpServers: {},
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

        // Default: return empty config
        vi.mocked(config.loadMcpConfig).mockReturnValue({ ...emptyConfig });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('successful server addition', () => {
        it('should add a new server with command only', async () => {
            const options: AddCommandOptions = { scope: 'user' };

            await addCommand('test-server', ['npx', 'some-mcp-server'], options);

            // Verify saveMcpConfig was called with correct structure
            expect(config.saveMcpConfig).toHaveBeenCalledTimes(1);
            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            const savedScope = vi.mocked(config.saveMcpConfig).mock.calls[0][1];

            expect(savedScope).toBe('user');
            expect(savedConfig.mcpServers['test-server']).toBeDefined();
            expect(savedConfig.mcpServers['test-server'].command).toBe('npx');
            expect(savedConfig.mcpServers['test-server'].args).toEqual(['some-mcp-server']);
        });

        it('should add a new server with command and multiple args', async () => {
            const options: AddCommandOptions = { scope: 'user' };

            await addCommand(
                'filesystem',
                ['npx', '@modelcontextprotocol/server-filesystem', '/home/user', '--readonly'],
                options
            );

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];

            expect(savedConfig.mcpServers['filesystem'].command).toBe('npx');
            expect(savedConfig.mcpServers['filesystem'].args).toEqual([
                '@modelcontextprotocol/server-filesystem',
                '/home/user',
                '--readonly',
            ]);
        });

        it('should not include args if command has no arguments', async () => {
            const options: AddCommandOptions = { scope: 'user' };

            await addCommand('simple', ['node'], options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];

            expect(savedConfig.mcpServers['simple'].command).toBe('node');
            expect(savedConfig.mcpServers['simple'].args).toBeUndefined();
        });

        it('should add server to project scope when specified', async () => {
            const options: AddCommandOptions = { scope: 'project' };

            await addCommand('project-server', ['docker', 'run', 'mcp-server'], options);

            const savedScope = vi.mocked(config.saveMcpConfig).mock.calls[0][1];
            expect(savedScope).toBe('project');
        });

        it('should record addedAt metadata timestamp', async () => {
            const options: AddCommandOptions = { scope: 'user' };
            const beforeTime = new Date().toISOString();

            await addCommand('timestamped', ['npx', 'server'], options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            const afterTime = new Date().toISOString();

            const addedAt = savedConfig.mcpServers['timestamped'].metadata?.addedAt;
            expect(addedAt).toBeDefined();
            // Verify timestamp is within reasonable bounds
            expect(addedAt! >= beforeTime).toBe(true);
            expect(addedAt! <= afterTime).toBe(true);
        });

        it('should display success message', async () => {
            const options: AddCommandOptions = { scope: 'user' };

            await addCommand('my-server', ['npx', 'test'], options);

            // Check that success message was logged
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('Added MCP server "my-server"')
            );
        });
    });

    describe('environment variable parsing', () => {
        it('should parse single env variable correctly', async () => {
            const options: AddCommandOptions = {
                scope: 'user',
                env: ['TOKEN=abc123'],
            };

            await addCommand('github', ['npx', 'github-server'], options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            expect(savedConfig.mcpServers['github'].env).toEqual({ TOKEN: 'abc123' });
        });

        it('should parse multiple env variables', async () => {
            const options: AddCommandOptions = {
                scope: 'user',
                env: ['TOKEN=abc123', 'DEBUG=true', 'API_URL=https://api.example.com'],
            };

            await addCommand('multi-env', ['npx', 'server'], options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            expect(savedConfig.mcpServers['multi-env'].env).toEqual({
                TOKEN: 'abc123',
                DEBUG: 'true',
                API_URL: 'https://api.example.com',
            });
        });

        it('should handle values containing = characters (e.g., BASE64)', async () => {
            const options: AddCommandOptions = {
                scope: 'user',
                env: ['SECRET=abc=def=ghi'],
            };

            await addCommand('base64-env', ['npx', 'server'], options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            // Only the first = should be treated as separator
            expect(savedConfig.mcpServers['base64-env'].env).toEqual({
                SECRET: 'abc=def=ghi',
            });
        });

        it('should handle empty value (KEY=)', async () => {
            const options: AddCommandOptions = {
                scope: 'user',
                env: ['EMPTY_VAR='],
            };

            await addCommand('empty-val', ['npx', 'server'], options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            expect(savedConfig.mcpServers['empty-val'].env).toEqual({
                EMPTY_VAR: '',
            });
        });

        it('should handle key without = (treats as empty value)', async () => {
            const options: AddCommandOptions = {
                scope: 'user',
                env: ['JUST_KEY'],
            };

            await addCommand('just-key', ['npx', 'server'], options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            expect(savedConfig.mcpServers['just-key'].env).toEqual({
                JUST_KEY: '',
            });
        });

        it('should not include env if no env vars provided', async () => {
            const options: AddCommandOptions = { scope: 'user' };

            await addCommand('no-env', ['npx', 'server'], options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            expect(savedConfig.mcpServers['no-env'].env).toBeUndefined();
        });

        it('should not include env if empty array provided', async () => {
            const options: AddCommandOptions = { scope: 'user', env: [] };

            await addCommand('empty-env', ['npx', 'server'], options);

            const savedConfig = vi.mocked(config.saveMcpConfig).mock.calls[0][0];
            expect(savedConfig.mcpServers['empty-env'].env).toBeUndefined();
        });

        it('should display env count in success message', async () => {
            const options: AddCommandOptions = {
                scope: 'user',
                env: ['VAR1=a', 'VAR2=b', 'VAR3=c'],
            };

            await addCommand('env-display', ['npx', 'server'], options);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('3 variable(s)')
            );
        });
    });

    describe('duplicate server name rejection', () => {
        it('should reject duplicate server names with error', async () => {
            // Setup: server already exists
            vi.mocked(config.loadMcpConfig).mockReturnValue({
                version: 1,
                mcpServers: {
                    'existing-server': {
                        command: 'npx',
                        args: ['old-server'],
                        disabled: false,
                        disabledTools: [],
                        autoApprove: [],
                        timeout: 5000,
                    },
                },
            });

            const options: AddCommandOptions = { scope: 'user' };

            // Should throw (from our mocked process.exit)
            await expect(
                addCommand('existing-server', ['npx', 'new-server'], options)
            ).rejects.toThrow('process.exit(1)');

            // Verify error message was displayed
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('already exists')
            );

            // Verify config was NOT saved
            expect(config.saveMcpConfig).not.toHaveBeenCalled();
        });

        it('should suggest edit or remove for existing servers', async () => {
            vi.mocked(config.loadMcpConfig).mockReturnValue({
                version: 1,
                mcpServers: {
                    'existing': {
                        command: 'test',
                        disabled: false,
                        disabledTools: [],
                        autoApprove: [],
                        timeout: 5000,
                    },
                },
            });

            const options: AddCommandOptions = { scope: 'user' };

            await expect(addCommand('existing', ['npx', 'test'], options)).rejects.toThrow();

            // Check for edit/remove suggestion
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('happy mcp edit')
            );
        });
    });

    describe('missing command validation', () => {
        it('should reject when no command provided (empty args)', async () => {
            const options: AddCommandOptions = { scope: 'user' };

            await expect(addCommand('no-cmd', [], options)).rejects.toThrow('process.exit(1)');

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('No command specified')
            );
            expect(config.saveMcpConfig).not.toHaveBeenCalled();
        });

        it('should display usage examples when command is missing', async () => {
            const options: AddCommandOptions = { scope: 'user' };

            await expect(addCommand('no-cmd', [], options)).rejects.toThrow();

            // Should show usage example
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('Usage:')
            );
        });
    });

    describe('scope handling', () => {
        it('should load config from correct scope', async () => {
            const options: AddCommandOptions = { scope: 'project' };

            await addCommand('scoped-server', ['npx', 'test'], options);

            // Verify loadMcpConfig was called with correct scope
            expect(config.loadMcpConfig).toHaveBeenCalledWith('project');
        });

        it('should display scope in success message', async () => {
            const options: AddCommandOptions = { scope: 'project' };

            await addCommand('project-scoped', ['npx', 'test'], options);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('Scope:   project')
            );
        });
    });

    describe('success message display', () => {
        it('should display command summary', async () => {
            const options: AddCommandOptions = { scope: 'user' };

            await addCommand('display-test', ['npx', 'server', '--flag'], options);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('Command: npx server --flag')
            );
        });

        it('should suggest validation command', async () => {
            const options: AddCommandOptions = { scope: 'user' };

            await addCommand('validate-hint', ['npx', 'test'], options);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('happy mcp validate validate-hint')
            );
        });
    });
});
