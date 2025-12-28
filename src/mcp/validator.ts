/**
 * MCP Server Validator
 *
 * Validates MCP server configurations by connecting to servers,
 * performing handshake, and fetching tool lists.
 *
 * @module mcp/validator
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { HappyMcpServerConfig, McpValidationResult, McpTool } from './types.js';

/** Default validation timeout in milliseconds */
const DEFAULT_VALIDATION_TIMEOUT = 5000;

/**
 * Validates a single MCP server configuration
 *
 * Connects to the server, performs MCP handshake, and fetches the tool list.
 * Returns detailed validation results including tool count and tool metadata.
 *
 * @param name - The server name (used for identification in results)
 * @param config - The server configuration to validate
 * @returns Validation result with success status, tools, and any errors
 *
 * @example
 * ```typescript
 * const result = await validateMcpServer('github', {
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-github'],
 *   env: { GITHUB_TOKEN: 'ghp_xxx' },
 *   timeout: 10000
 * });
 *
 * if (result.success) {
 *   console.log(`Found ${result.toolCount} tools`);
 * } else {
 *   console.error(`Validation failed: ${result.error}`);
 * }
 * ```
 */
export async function validateMcpServer(
    name: string,
    config: HappyMcpServerConfig
): Promise<McpValidationResult> {
    const timeout = config.timeout ?? DEFAULT_VALIDATION_TIMEOUT;
    const validatedAt = new Date().toISOString();

    // Skip disabled servers
    if (config.disabled) {
        return {
            success: true,
            serverName: name,
            error: 'Skipped (disabled)',
            validatedAt,
        };
    }

    let transport: StdioClientTransport | null = null;
    let client: Client | null = null;

    try {
        // Create transport with server configuration
        transport = new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            env: {
                ...Object.fromEntries(
                    Object.entries(process.env).filter(
                        (entry): entry is [string, string] => entry[1] !== undefined
                    )
                ),
                ...config.env,
            },
        });

        // Create MCP client
        client = new Client(
            { name: 'happy-mcp-validator', version: '1.0.0' },
            { capabilities: {} }
        );

        // Connect with timeout using Promise.race
        const connectPromise = client.connect(transport);
        const timeoutPromise = new Promise<never>((_, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Connection timeout after ${timeout}ms`));
            }, timeout);
            // Ensure timer doesn't prevent Node.js from exiting
            timer.unref?.();
        });

        await Promise.race([connectPromise, timeoutPromise]);

        // Fetch available tools
        const toolsResult = await client.listTools();
        const tools: McpTool[] = toolsResult.tools.map((t) => ({
            name: t.name,
            description: t.description,
        }));

        // Cleanup connection
        await client.close();

        return {
            success: true,
            serverName: name,
            toolCount: tools.length,
            tools,
            validatedAt,
        };
    } catch (error) {
        // Attempt cleanup even on error
        try {
            await client?.close();
        } catch {
            // Ignore cleanup errors
        }

        return {
            success: false,
            serverName: name,
            error: error instanceof Error ? error.message : String(error),
            validatedAt,
        };
    }
}

/**
 * Validates all configured MCP servers
 *
 * Iterates through all servers and validates each one sequentially.
 * Disabled servers are marked as skipped without attempting connection.
 *
 * @param servers - Record of server names to configurations
 * @returns Array of validation results for each server
 *
 * @example
 * ```typescript
 * const servers = {
 *   'github': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
 *   'filesystem': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
 *   'disabled-server': { command: 'invalid', disabled: true }
 * };
 *
 * const results = await validateAllServers(servers);
 * const successful = results.filter(r => r.success && !r.error);
 * console.log(`${successful.length}/${results.length} servers validated`);
 * ```
 */
export async function validateAllServers(
    servers: Record<string, HappyMcpServerConfig>
): Promise<McpValidationResult[]> {
    const results: McpValidationResult[] = [];

    for (const [name, config] of Object.entries(servers)) {
        results.push(await validateMcpServer(name, config));
    }

    return results;
}
