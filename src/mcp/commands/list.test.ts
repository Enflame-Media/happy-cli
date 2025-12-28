/**
 * Unit tests for MCP List Command
 *
 * Tests the `happy mcp list` command functionality including:
 * - Listing servers from merged user + project configs
 * - JSON output format validation
 * - Filter options (enabled/disabled)
 * - Empty config handling
 * - Table formatting
 *
 * @module mcp/commands/list.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listCommand, type ListCommandOptions } from './list.js';
import * as config from '../config.js';

// Mock the config module
vi.mock('../config.js', () => ({
    getMergedMcpServers: vi.fn(),
    hasMcpConfig: vi.fn(),
}));

// Mock chalk to return strings directly for easier testing
vi.mock('chalk', () => ({
    default: {
        red: vi.fn((str: string) => `[red]${str}[/red]`),
        green: vi.fn((str: string) => `[green]${str}[/green]`),
        yellow: vi.fn((str: string) => `[yellow]${str}[/yellow]`),
        gray: vi.fn((str: string) => `[gray]${str}[/gray]`),
        bold: vi.fn((str: string) => `[bold]${str}[/bold]`),
    },
}));

describe('listCommand', () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    // Sample servers for testing
    const sampleServers = {
        'github-server': {
            command: 'npx',
            args: ['@modelcontextprotocol/server-github'],
            env: { GITHUB_TOKEN: 'xxx' },
            disabled: false,
            disabledTools: [] as string[],
            autoApprove: [] as string[],
            timeout: 5000,
            metadata: {
                addedAt: '2024-12-28T00:00:00.000Z',
                lastValidated: '2024-12-28T01:00:00.000Z',
                toolCount: 5,
                description: 'GitHub integration',
            },
        },
        'filesystem-server': {
            command: 'npx',
            args: ['@modelcontextprotocol/server-filesystem', '/home/user'],
            disabled: true,
            disabledTools: [] as string[],
            autoApprove: [] as string[],
            timeout: 5000,
            metadata: {
                addedAt: '2024-12-27T00:00:00.000Z',
            },
        },
        'simple-server': {
            command: 'node',
            args: ['server.js'],
            disabled: false,
            disabledTools: [] as string[],
            autoApprove: [] as string[],
            timeout: 5000,
            // No metadata
        },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Default: config exists with sample servers
        vi.mocked(config.hasMcpConfig).mockReturnValue(true);
        vi.mocked(config.getMergedMcpServers).mockReturnValue({ ...sampleServers });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('table output format', () => {
        it('should display servers in table format by default', async () => {
            await listCommand({});

            // Should display header
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('MCP Servers')
            );

            // Should display each server name
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('github-server')
            );
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('filesystem-server')
            );
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('simple-server')
            );
        });

        it('should display status with color coding', async () => {
            await listCommand({});

            // Check for enabled servers (green)
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('[green]enabled[/green]')
            );

            // Check for disabled servers (red)
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('[red]disabled[/red]')
            );
        });

        it('should display tool count from metadata', async () => {
            await listCommand({});

            // github-server has toolCount: 5
            const allCalls = consoleLogSpy.mock.calls.flat().join('\n');
            expect(allCalls).toContain('5');
        });

        it('should display last validated date', async () => {
            await listCommand({});

            // github-server has lastValidated: '2024-12-28T01:00:00.000Z'
            // The formatted date depends on timezone, so we just verify a Dec 2024 date appears
            const allCalls = consoleLogSpy.mock.calls.flat().join('\n');
            expect(allCalls).toMatch(/Dec.*2\d.*2024/);
        });

        it('should display summary line', async () => {
            await listCommand({});

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('3 servers')
            );
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('2 enabled')
            );
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('1 disabled')
            );
        });
    });

    describe('JSON output format', () => {
        it('should output valid JSON when format is json', async () => {
            const options: ListCommandOptions = { format: 'json' };

            await listCommand(options);

            // Find the JSON output call
            const jsonCalls = consoleLogSpy.mock.calls.filter((call: unknown[]) =>
                typeof call[0] === 'string' && call[0].startsWith('{')
            );
            expect(jsonCalls.length).toBe(1);

            // Verify it's valid JSON
            const jsonOutput = JSON.parse(jsonCalls[0][0] as string);
            expect(typeof jsonOutput).toBe('object');
        });

        it('should include all servers in JSON output', async () => {
            const options: ListCommandOptions = { format: 'json' };

            await listCommand(options);

            const jsonCalls = consoleLogSpy.mock.calls.filter((call: unknown[]) =>
                typeof call[0] === 'string' && call[0].startsWith('{')
            );
            const jsonOutput = JSON.parse(jsonCalls[0][0] as string);

            expect(Object.keys(jsonOutput)).toHaveLength(3);
            expect(jsonOutput['github-server']).toBeDefined();
            expect(jsonOutput['filesystem-server']).toBeDefined();
            expect(jsonOutput['simple-server']).toBeDefined();
        });

        it('should include correct fields in JSON output', async () => {
            const options: ListCommandOptions = { format: 'json' };

            await listCommand(options);

            const jsonCalls = consoleLogSpy.mock.calls.filter((call: unknown[]) =>
                typeof call[0] === 'string' && call[0].startsWith('{')
            );
            const jsonOutput = JSON.parse(jsonCalls[0][0] as string);

            const github = jsonOutput['github-server'];
            expect(github.command).toBe('npx');
            expect(github.args).toEqual(['@modelcontextprotocol/server-github']);
            expect(github.disabled).toBe(false);
            expect(github.toolCount).toBe(5);
            expect(github.lastValidated).toBe('2024-12-28T01:00:00.000Z');
            expect(github.description).toBe('GitHub integration');
        });

        it('should handle null values for missing metadata in JSON', async () => {
            const options: ListCommandOptions = { format: 'json' };

            await listCommand(options);

            const jsonCalls = consoleLogSpy.mock.calls.filter((call: unknown[]) =>
                typeof call[0] === 'string' && call[0].startsWith('{')
            );
            const jsonOutput = JSON.parse(jsonCalls[0][0] as string);

            // simple-server has no metadata
            const simple = jsonOutput['simple-server'];
            expect(simple.toolCount).toBeNull();
            expect(simple.lastValidated).toBeNull();
            expect(simple.description).toBeNull();
        });
    });

    describe('filter options', () => {
        it('should filter to show only enabled servers', async () => {
            const options: ListCommandOptions = { filter: 'enabled' };

            await listCommand(options);

            const allCalls = consoleLogSpy.mock.calls.flat().join('\n');

            // Should include enabled servers
            expect(allCalls).toContain('github-server');
            expect(allCalls).toContain('simple-server');

            // Should NOT include disabled servers
            expect(allCalls).not.toContain('filesystem-server');
        });

        it('should filter to show only disabled servers', async () => {
            const options: ListCommandOptions = { filter: 'disabled' };

            await listCommand(options);

            const allCalls = consoleLogSpy.mock.calls.flat().join('\n');

            // Should include disabled servers
            expect(allCalls).toContain('filesystem-server');

            // Should NOT include enabled servers
            expect(allCalls).not.toContain('github-server');
            expect(allCalls).not.toContain('simple-server');
        });

        it('should show message when no servers match filter', async () => {
            // All servers enabled
            vi.mocked(config.getMergedMcpServers).mockReturnValue({
                'enabled-only': {
                    command: 'test',
                    disabled: false,
                    disabledTools: [],
                    autoApprove: [],
                    timeout: 5000,
                },
            });

            const options: ListCommandOptions = { filter: 'disabled' };

            await listCommand(options);

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('No disabled MCP servers found')
            );
        });

        it('should apply filter to JSON output', async () => {
            const options: ListCommandOptions = { format: 'json', filter: 'enabled' };

            await listCommand(options);

            const jsonCalls = consoleLogSpy.mock.calls.filter((call: unknown[]) =>
                typeof call[0] === 'string' && call[0].startsWith('{')
            );
            const jsonOutput = JSON.parse(jsonCalls[0][0] as string);

            expect(Object.keys(jsonOutput)).toHaveLength(2);
            expect(jsonOutput['github-server']).toBeDefined();
            expect(jsonOutput['simple-server']).toBeDefined();
            expect(jsonOutput['filesystem-server']).toBeUndefined();
        });
    });

    describe('empty config handling', () => {
        it('should show helpful message when no config exists', async () => {
            vi.mocked(config.hasMcpConfig).mockReturnValue(false);

            await listCommand({});

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('No MCP servers configured')
            );

            // Should show add suggestion
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('happy mcp add')
            );
        });

        it('should show message when config exists but has no servers', async () => {
            vi.mocked(config.hasMcpConfig).mockReturnValue(true);
            vi.mocked(config.getMergedMcpServers).mockReturnValue({});

            await listCommand({});

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('No MCP servers configured')
            );
        });

        it('should not call getMergedMcpServers if no config exists', async () => {
            vi.mocked(config.hasMcpConfig).mockReturnValue(false);

            await listCommand({});

            expect(config.getMergedMcpServers).not.toHaveBeenCalled();
        });
    });

    describe('edge cases', () => {
        it('should handle single server', async () => {
            vi.mocked(config.getMergedMcpServers).mockReturnValue({
                'single-server': {
                    command: 'test',
                    disabled: false,
                    disabledTools: [],
                    autoApprove: [],
                    timeout: 5000,
                },
            });

            await listCommand({});

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('1 server')
            );
            // Should use singular form
            expect(consoleLogSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('1 servers')
            );
        });

        it('should handle servers with very long names', async () => {
            vi.mocked(config.getMergedMcpServers).mockReturnValue({
                'very-long-server-name-that-might-break-formatting': {
                    command: 'test',
                    disabled: false,
                    disabledTools: [],
                    autoApprove: [],
                    timeout: 5000,
                },
            });

            // Should not throw
            await expect(listCommand({})).resolves.not.toThrow();
        });

        it('should handle servers with missing optional fields', async () => {
            vi.mocked(config.getMergedMcpServers).mockReturnValue({
                'minimal-server': {
                    command: 'test',
                    disabled: false,
                    disabledTools: [],
                    autoApprove: [],
                    timeout: 5000,
                    // No args, no env, no metadata
                },
            });

            await listCommand({});

            // Should display without errors
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('minimal-server')
            );
        });

        it('should handle undefined disabled field as enabled', async () => {
            vi.mocked(config.getMergedMcpServers).mockReturnValue({
                'implicit-enabled': {
                    command: 'test',
                    // disabled is undefined (should be treated as enabled)
                    disabled: undefined as unknown as boolean,
                    disabledTools: [] as string[],
                    autoApprove: [] as string[],
                    timeout: 5000,
                },
            });

            const options: ListCommandOptions = { filter: 'enabled' };

            await listCommand(options);

            const allCalls = consoleLogSpy.mock.calls.flat().join('\n');
            expect(allCalls).toContain('implicit-enabled');
        });

        it('should handle invalid date in metadata gracefully', async () => {
            vi.mocked(config.getMergedMcpServers).mockReturnValue({
                'invalid-date-server': {
                    command: 'test',
                    disabled: false,
                    disabledTools: [],
                    autoApprove: [],
                    timeout: 5000,
                    metadata: {
                        addedAt: '2024-12-28T00:00:00.000Z',
                        lastValidated: 'not-a-valid-date',
                    },
                },
            });

            // Should not throw
            await expect(listCommand({})).resolves.not.toThrow();

            const allCalls = consoleLogSpy.mock.calls.flat().join('\n');
            expect(allCalls).toContain('invalid');
        });
    });

    describe('default options', () => {
        it('should use table format by default', async () => {
            await listCommand({});

            // Table format shows "MCP Servers:" header
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('MCP Servers')
            );
        });

        it('should show all servers by default (no filter)', async () => {
            await listCommand({});

            const allCalls = consoleLogSpy.mock.calls.flat().join('\n');

            // All servers should be visible
            expect(allCalls).toContain('github-server');
            expect(allCalls).toContain('filesystem-server');
            expect(allCalls).toContain('simple-server');
        });

        it('should work with empty options object', async () => {
            await expect(listCommand({})).resolves.not.toThrow();
        });

        it('should work with no options argument', async () => {
            await expect(listCommand()).resolves.not.toThrow();
        });
    });
});
