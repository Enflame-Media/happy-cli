/**
 * MCP Validate Command
 *
 * Validates MCP server configurations by testing connectivity and retrieving
 * available tools. Updates config metadata with validation results.
 *
 * @module mcp/commands/validate
 */

import chalk from 'chalk';
import { getMergedMcpServers, loadMcpConfig, saveMcpConfig, hasMcpConfig } from '../config.js';
import { validateMcpServer, validateAllServers } from '../validator.js';
import type { McpValidationResult } from '../types.js';

/**
 * Options for the validate command
 */
export interface ValidateCommandOptions {
    /** Config scope for updating metadata (user or project) */
    scope?: 'user' | 'project';
}

/**
 * Display a single validation result with color-coded output
 *
 * @param result - Validation result to display
 */
function displayResult(result: McpValidationResult): void {
    if (result.success) {
        if (result.error?.includes('Skipped')) {
            // Server was skipped (disabled)
            console.log(chalk.yellow(`⊘ ${result.serverName}`) + chalk.gray(' (disabled)'));
        } else {
            // Successful validation
            console.log(
                chalk.green(`✓ ${result.serverName}`) +
                    chalk.gray(` (${result.toolCount ?? 0} tools)`)
            );
        }
    } else {
        // Failed validation
        console.log(chalk.red(`✗ ${result.serverName}`) + chalk.gray(` - ${result.error}`));
    }
}

/**
 * Update config metadata with validation results
 *
 * Persists the lastValidated timestamp and toolCount to the config file.
 * Only updates the config in the specified scope where the server is defined.
 *
 * @param name - Server name
 * @param result - Validation result
 * @param scope - Config scope to update
 */
function updateMetadata(
    name: string,
    result: McpValidationResult,
    scope: 'user' | 'project'
): void {
    try {
        const config = loadMcpConfig(scope);

        // Only update if this server exists in this scope's config
        if (config.mcpServers[name]) {
            const existingMetadata = config.mcpServers[name].metadata;
            config.mcpServers[name].metadata = {
                addedAt: existingMetadata?.addedAt ?? result.validatedAt,
                ...existingMetadata,
                lastValidated: result.validatedAt,
                toolCount: result.toolCount,
            };
            saveMcpConfig(config, scope);
        }
    } catch {
        // Ignore errors - metadata update is non-critical
    }
}

/**
 * Determine which scope a server is defined in
 *
 * Checks user config first, then project config.
 *
 * @param name - Server name to find
 * @returns The scope where the server is defined, or undefined
 */
function findServerScope(name: string): 'user' | 'project' | undefined {
    try {
        const userConfig = loadMcpConfig('user');
        if (userConfig.mcpServers[name]) {
            return 'user';
        }
    } catch {
        // User config doesn't exist or can't be read
    }

    try {
        const projectConfig = loadMcpConfig('project');
        if (projectConfig.mcpServers[name]) {
            return 'project';
        }
    } catch {
        // Project config doesn't exist or can't be read
    }

    return undefined;
}

/**
 * Execute the 'happy mcp validate' command
 *
 * Validates MCP server connectivity and tool availability.
 * Can validate a single server or all configured servers.
 * Updates config metadata with validation results on success.
 *
 * @param name - Optional server name to validate (validates all if not provided)
 * @param options - Command options
 *
 * @example
 * ```bash
 * happy mcp validate              # Validate all servers
 * happy mcp validate github       # Validate single server
 * happy mcp validate --scope project  # Update project config metadata
 * ```
 */
export async function validateCommand(
    name?: string,
    options: ValidateCommandOptions = {}
): Promise<void> {
    // Check if any config exists
    if (!hasMcpConfig()) {
        console.log(chalk.yellow('No MCP servers configured.'));
        console.log();
        console.log(chalk.gray('Add a server with:'));
        console.log(chalk.gray('  happy mcp add <name> -- <command> [args...]'));
        return;
    }

    const servers = getMergedMcpServers();

    if (name) {
        // Validate single server
        if (!servers[name]) {
            console.error(chalk.red(`Server "${name}" not found.`));
            console.log();
            console.log(chalk.gray('Available servers:'));
            for (const serverName of Object.keys(servers)) {
                console.log(chalk.gray(`  - ${serverName}`));
            }
            process.exit(1);
        }

        console.log(chalk.gray(`Validating "${name}"...`));
        console.log();

        const result = await validateMcpServer(name, servers[name]);
        displayResult(result);

        // Update metadata if validation was successful (not just skipped)
        if (result.success && !result.error?.includes('Skipped')) {
            // Use provided scope or find where the server is defined
            const scope = options.scope ?? findServerScope(name) ?? 'user';
            updateMetadata(name, result, scope);
        }
    } else {
        // Validate all servers
        const serverCount = Object.keys(servers).length;

        if (serverCount === 0) {
            console.log(chalk.yellow('No MCP servers configured.'));
            console.log();
            console.log(chalk.gray('Add a server with:'));
            console.log(chalk.gray('  happy mcp add <name> -- <command> [args...]'));
            return;
        }

        console.log(chalk.gray(`Validating ${serverCount} MCP server${serverCount !== 1 ? 's' : ''}...`));
        console.log();

        const results = await validateAllServers(servers);

        for (const result of results) {
            displayResult(result);

            // Update metadata for successful validations (not skipped)
            if (result.success && !result.error?.includes('Skipped')) {
                // Find scope for each server
                const scope = options.scope ?? findServerScope(result.serverName) ?? 'user';
                updateMetadata(result.serverName, result, scope);
            }
        }

        // Summary
        const passed = results.filter((r) => r.success && !r.error?.includes('Skipped')).length;
        const failed = results.filter((r) => !r.success).length;
        const skipped = results.filter((r) => r.success && r.error?.includes('Skipped')).length;

        console.log();
        console.log(
            chalk.bold('Summary: ') +
                chalk.green(`${passed} passed`) +
                (failed > 0 ? chalk.red(`, ${failed} failed`) : '') +
                (skipped > 0 ? chalk.yellow(`, ${skipped} skipped`) : '')
        );
    }
}
