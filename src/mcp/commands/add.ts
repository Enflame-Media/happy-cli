/**
 * MCP Add Command
 *
 * Adds a new MCP server to the configuration. Supports environment variables
 * and both user-level and project-level scopes.
 *
 * @module mcp/commands/add
 *
 * @example
 * ```bash
 * # Basic add
 * happy mcp add filesystem -- npx @modelcontextprotocol/server-filesystem /home/user
 *
 * # With environment variables
 * happy mcp add github --env GITHUB_TOKEN=ghp_xxx -- npx @modelcontextprotocol/server-github
 *
 * # Project scope
 * happy mcp add database --scope project -- docker run -i mcp/postgres
 * ```
 */

import chalk from 'chalk';
import type { z } from 'zod';
import { loadMcpConfig, saveMcpConfig, type ConfigScope } from '../config.js';
import { HappyMcpServerConfigSchema } from '../types.js';

/**
 * Input type for server config (allows optional fields that have defaults)
 * This differs from the output type which requires all defaulted fields.
 */
type HappyMcpServerConfigInput = z.input<typeof HappyMcpServerConfigSchema>;

/**
 * Options for the add command
 */
export interface AddCommandOptions {
    /** Config scope: 'user' (global) or 'project' (local) */
    scope: ConfigScope;
    /** Environment variables in KEY=VALUE format */
    env?: string[];
}

/**
 * Parse environment variable strings into a record.
 *
 * Handles various edge cases:
 * - Values containing '=' characters (e.g., BASE64 encoded values)
 * - Empty values (KEY= sets KEY to empty string)
 * - Missing '=' (treats entire string as key with empty value)
 *
 * @param envStrings - Array of "KEY=VALUE" strings
 * @returns Record of parsed environment variables
 *
 * @example
 * ```typescript
 * parseEnvVars(['TOKEN=abc123', 'API_URL=https://example.com/path?query=1'])
 * // Returns: { TOKEN: 'abc123', API_URL: 'https://example.com/path?query=1' }
 * ```
 */
function parseEnvVars(envStrings: string[]): Record<string, string> {
    const env: Record<string, string> = {};

    for (const envStr of envStrings) {
        const eqIndex = envStr.indexOf('=');
        if (eqIndex === -1) {
            // No '=' found - treat entire string as key with empty value
            env[envStr] = '';
        } else {
            const key = envStr.substring(0, eqIndex);
            const value = envStr.substring(eqIndex + 1);
            env[key] = value;
        }
    }

    return env;
}

/**
 * Execute the 'happy mcp add' command
 *
 * Adds a new MCP server configuration with validation:
 * 1. Checks if server name already exists (fails if duplicate)
 * 2. Validates that a command was provided after '--'
 * 3. Parses environment variables if provided
 * 4. Creates server config with metadata (addedAt timestamp)
 * 5. Saves to appropriate config file based on scope
 *
 * @param name - Name for the MCP server (must be unique within scope)
 * @param commandArgs - Command and arguments (everything after '--')
 * @param options - Command options including scope and env vars
 *
 * @example
 * ```typescript
 * // Add a filesystem server to user config
 * await addCommand(
 *     'filesystem',
 *     ['npx', '@modelcontextprotocol/server-filesystem', '/home/user'],
 *     { scope: 'user' }
 * );
 * ```
 */
export async function addCommand(
    name: string,
    commandArgs: string[],
    options: AddCommandOptions
): Promise<void> {
    const { scope, env: envStrings } = options;

    // Load existing config for the specified scope
    const config = loadMcpConfig(scope);

    // Check if server already exists
    if (config.mcpServers[name]) {
        console.error(chalk.red(`Server "${name}" already exists.`));
        console.log(chalk.gray('Use `happy mcp edit` to modify or `happy mcp remove` first.'));
        process.exit(1);
    }

    // Parse command and args
    const [command, ...args] = commandArgs;
    if (!command) {
        console.error(chalk.red('No command specified.'));
        console.log();
        console.log(chalk.gray('Usage: happy mcp add <name> -- <command> [args...]'));
        console.log();
        console.log(chalk.gray('Examples:'));
        console.log(
            chalk.gray(
                '  happy mcp add filesystem -- npx @modelcontextprotocol/server-filesystem /path'
            )
        );
        console.log(
            chalk.gray('  happy mcp add github --env GITHUB_TOKEN=xxx -- npx @mcp/server-github')
        );
        process.exit(1);
    }

    // Parse environment variables if provided
    const env = envStrings && envStrings.length > 0 ? parseEnvVars(envStrings) : undefined;

    // Create server config (using input type since saveMcpConfig applies defaults via parse)
    const serverConfig: HappyMcpServerConfigInput = {
        command,
        args: args.length > 0 ? args : undefined,
        env: env && Object.keys(env).length > 0 ? env : undefined,
        metadata: {
            addedAt: new Date().toISOString(),
        },
    };

    // Add to config and save
    // Type assertion is safe because saveMcpConfig calls schema.parse() which applies defaults
    config.mcpServers[name] = serverConfig as typeof config.mcpServers[string];
    saveMcpConfig(config, scope);

    // Display success message
    console.log(chalk.green(`✓ Added MCP server "${name}"`));
    console.log();

    // Show configuration summary
    const commandDisplay = args.length > 0 ? `${command} ${args.join(' ')}` : command;
    console.log(chalk.gray(`  Command: ${commandDisplay}`));
    console.log(chalk.gray(`  Scope:   ${scope}`));

    if (env && Object.keys(env).length > 0) {
        console.log(chalk.gray(`  Env:     ${Object.keys(env).length} variable(s)`));
    }

    console.log();
    console.log(chalk.gray(`Run \`happy mcp validate ${name}\` to test the connection.`));
}
