/**
 * MCP Remove Command
 *
 * Removes an MCP server from the configuration with confirmation prompt.
 * Use --force to skip the confirmation.
 *
 * @module mcp/commands/remove
 */

import chalk from 'chalk';
import readline from 'readline';
import { loadMcpConfig, saveMcpConfig, getMcpConfigPath } from '../config.js';
import type { ConfigScope } from '../config.js';

/**
 * Options for the remove command
 */
export interface RemoveCommandOptions {
    /** Skip confirmation prompt */
    force?: boolean;
    /** Config scope to remove from (user or project) */
    scope: ConfigScope;
}

/**
 * Prompt user for confirmation
 *
 * @param message - The confirmation message to display
 * @returns Promise resolving to true if user confirms, false otherwise
 */
async function confirm(message: string): Promise<boolean> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(`${message} [y/N] `, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y');
        });
    });
}

/**
 * Execute the 'happy mcp remove' command
 *
 * Removes an MCP server from the specified configuration scope.
 * Prompts for confirmation unless --force is provided.
 *
 * @param name - Name of the server to remove
 * @param options - Command options
 *
 * @example
 * ```bash
 * happy mcp remove filesystem        # With confirmation
 * happy mcp remove filesystem --force  # Skip confirmation
 * happy mcp remove myserver --scope project  # Remove from project config
 * ```
 */
export async function removeCommand(name: string, options: RemoveCommandOptions): Promise<void> {
    const config = loadMcpConfig(options.scope);

    // Check if server exists
    if (!config.mcpServers[name]) {
        console.error(chalk.red(`Server "${name}" not found.`));
        console.log(chalk.gray('Run `happy mcp list` to see configured servers.'));
        process.exit(1);
    }

    // Confirmation unless --force
    if (!options.force) {
        const confirmed = await confirm(
            `Remove MCP server "${name}"? This cannot be undone.`
        );
        if (!confirmed) {
            console.log(chalk.gray('Cancelled.'));
            return;
        }
    }

    // Remove the server
    delete config.mcpServers[name];
    saveMcpConfig(config, options.scope);

    const configPath = getMcpConfigPath(options.scope);
    console.log(chalk.green(`✓ Removed MCP server "${name}"`));
    console.log(chalk.gray(`  Config: ${configPath}`));
}
