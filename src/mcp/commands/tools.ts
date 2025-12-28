/**
 * MCP Tools Command
 *
 * Lists all tools available from a specific MCP server, showing their
 * enabled/disabled status and descriptions.
 *
 * @module mcp/commands/tools
 */

import chalk from 'chalk';
import { getMergedMcpServers } from '../config.js';
import { validateMcpServer } from '../validator.js';

/**
 * Execute the 'happy mcp tools <name>' command
 *
 * Connects to the specified MCP server, fetches its tool list, and displays
 * each tool with its enabled/disabled status and description.
 *
 * @param serverName - The name of the MCP server to query
 *
 * @example
 * ```bash
 * happy mcp tools github
 * # Output:
 * # Tools from "github":
 * #
 * #   [enabled] search_repositories
 * #            Search for GitHub repositories
 * #   [disabled] create_issue
 * #            Create a new issue in a repository
 * #
 * # Total: 2 tools
 * ```
 */
export async function toolsCommand(serverName: string): Promise<void> {
    const servers = getMergedMcpServers();

    if (!servers[serverName]) {
        console.error(chalk.red(`Server "${serverName}" not found.`));
        process.exit(1);
    }

    const config = servers[serverName];

    if (config.disabled) {
        console.log(chalk.yellow(`Server "${serverName}" is disabled.`));
        console.log(chalk.gray(`Enable it first: \`happy mcp enable ${serverName}\``));
        return;
    }

    console.log(chalk.gray(`Fetching tools from "${serverName}"...\n`));
    const result = await validateMcpServer(serverName, config);

    if (!result.success) {
        console.error(chalk.red(`Failed to connect: ${result.error}`));
        process.exit(1);
    }

    console.log(chalk.bold(`Tools from "${serverName}":\n`));

    const disabledTools = config.disabledTools ?? [];
    const tools = result.tools ?? [];

    if (tools.length === 0) {
        console.log(chalk.gray('  No tools available from this server.'));
        console.log();
        console.log(chalk.gray('Total: 0 tools'));
        return;
    }

    for (const tool of tools) {
        const isDisabled = disabledTools.includes(tool.name);
        const status = isDisabled ? chalk.red('[disabled]') : chalk.green('[enabled]');
        const toolName = isDisabled ? chalk.gray(tool.name) : tool.name;

        console.log(`  ${status} ${toolName}`);
        if (tool.description) {
            console.log(chalk.gray(`           ${tool.description}`));
        }
    }

    console.log(chalk.gray(`\nTotal: ${tools.length} tools`));
}
