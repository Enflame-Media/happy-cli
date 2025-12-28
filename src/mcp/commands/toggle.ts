/**
 * MCP Enable/Disable Commands
 *
 * Toggle MCP servers on/off without removing them from configuration.
 * Supports both server-level and tool-level toggling.
 *
 * @module mcp/commands/toggle
 *
 * @example
 * ```bash
 * # Server-level
 * happy mcp enable filesystem
 * happy mcp disable database
 *
 * # Tool-level
 * happy mcp disable github --tool create_issue
 * happy mcp enable github --tool create_issue
 * ```
 */

import chalk from 'chalk';
import { loadMcpConfig, saveMcpConfig, getMcpConfigPath } from '../config.js';
import type { ConfigScope } from '../config.js';

/**
 * Options for enable/disable commands
 */
export interface ToggleOptions {
    /** Specific tool name to enable/disable (optional) */
    tool?: string;
    /** Config scope: 'user' (global) or 'project' (local) */
    scope: ConfigScope;
}

/**
 * Execute the 'happy mcp enable' command
 *
 * Enables a disabled MCP server or re-enables a specific disabled tool.
 * Idempotent: enabling an already-enabled server/tool is a no-op with success message.
 *
 * @param name - Name of the MCP server to enable
 * @param options - Command options including scope and optional tool name
 *
 * @example
 * ```typescript
 * // Enable entire server
 * await enableCommand('filesystem', { scope: 'user' });
 *
 * // Enable specific tool
 * await enableCommand('github', { scope: 'user', tool: 'create_issue' });
 * ```
 */
export async function enableCommand(name: string, options: ToggleOptions): Promise<void> {
    const config = loadMcpConfig(options.scope);

    // Check if server exists
    if (!config.mcpServers[name]) {
        console.error(chalk.red(`Server "${name}" not found.`));
        console.log(chalk.gray('Run `happy mcp list` to see configured servers.'));
        process.exit(1);
    }

    const configPath = getMcpConfigPath(options.scope);

    if (options.tool) {
        // Enable specific tool by removing it from disabledTools
        const tools = config.mcpServers[name].disabledTools ?? [];
        const toolIndex = tools.indexOf(options.tool);

        if (toolIndex === -1) {
            // Tool is already enabled (not in disabled list)
            console.log(chalk.green(`✓ Tool "${options.tool}" is already enabled in server "${name}"`));
            return;
        }

        config.mcpServers[name].disabledTools = tools.filter(t => t !== options.tool);
        saveMcpConfig(config, options.scope);

        console.log(chalk.green(`✓ Enabled tool "${options.tool}" in server "${name}"`));
        console.log(chalk.gray(`  Config: ${configPath}`));
    } else {
        // Enable entire server
        if (!config.mcpServers[name].disabled) {
            // Server is already enabled
            console.log(chalk.green(`✓ Server "${name}" is already enabled`));
            return;
        }

        config.mcpServers[name].disabled = false;
        saveMcpConfig(config, options.scope);

        console.log(chalk.green(`✓ Enabled MCP server "${name}"`));
        console.log(chalk.gray(`  Config: ${configPath}`));
    }
}

/**
 * Execute the 'happy mcp disable' command
 *
 * Disables an MCP server without removing it, or disables a specific tool.
 * Idempotent: disabling an already-disabled server/tool is a no-op with success message.
 *
 * @param name - Name of the MCP server to disable
 * @param options - Command options including scope and optional tool name
 *
 * @example
 * ```typescript
 * // Disable entire server
 * await disableCommand('database', { scope: 'user' });
 *
 * // Disable specific tool
 * await disableCommand('github', { scope: 'user', tool: 'create_issue' });
 * ```
 */
export async function disableCommand(name: string, options: ToggleOptions): Promise<void> {
    const config = loadMcpConfig(options.scope);

    // Check if server exists
    if (!config.mcpServers[name]) {
        console.error(chalk.red(`Server "${name}" not found.`));
        console.log(chalk.gray('Run `happy mcp list` to see configured servers.'));
        process.exit(1);
    }

    const configPath = getMcpConfigPath(options.scope);

    if (options.tool) {
        // Disable specific tool by adding it to disabledTools
        const tools = config.mcpServers[name].disabledTools ?? [];

        if (tools.includes(options.tool)) {
            // Tool is already disabled
            console.log(chalk.yellow(`✓ Tool "${options.tool}" is already disabled in server "${name}"`));
            return;
        }

        tools.push(options.tool);
        config.mcpServers[name].disabledTools = tools;
        saveMcpConfig(config, options.scope);

        console.log(chalk.yellow(`✓ Disabled tool "${options.tool}" in server "${name}"`));
        console.log(chalk.gray(`  Config: ${configPath}`));
    } else {
        // Disable entire server
        if (config.mcpServers[name].disabled) {
            // Server is already disabled
            console.log(chalk.yellow(`✓ Server "${name}" is already disabled`));
            return;
        }

        config.mcpServers[name].disabled = true;
        saveMcpConfig(config, options.scope);

        console.log(chalk.yellow(`✓ Disabled MCP server "${name}"`));
        console.log(chalk.gray(`  Config: ${configPath}`));
    }
}
