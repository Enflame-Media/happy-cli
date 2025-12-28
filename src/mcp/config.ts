/**
 * MCP Configuration File Management
 *
 * Provides utilities for loading, saving, and merging MCP configurations
 * from both user-level (~/.happy/config/mcp.json) and project-level
 * (.happy/mcp.json) config files.
 *
 * @module mcp/config
 * @see {@link ./types.ts} for schema definitions
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { logger } from '@/ui/logger';
import {
    HappyMcpConfig,
    HappyMcpConfigSchema,
    HappyMcpServerConfig,
    DEFAULT_MCP_CONFIG,
} from './types';

/** Filename for project-level MCP configuration */
const PROJECT_CONFIG_NAME = '.happy/mcp.json';

/**
 * Get the path to user-level MCP configuration.
 * Uses a function instead of constant to support testing with mocked homedir.
 */
function getUserConfigPath(): string {
    return join(homedir(), '.happy', 'config', 'mcp.json');
}

/**
 * Config scope determines which config file to operate on.
 * - 'user': Global config in ~/.happy/config/mcp.json
 * - 'project': Per-project config in .happy/mcp.json at project root
 */
export type ConfigScope = 'user' | 'project';

/**
 * Find the project root directory by searching for common project markers.
 *
 * Walks up the directory tree from cwd looking for:
 * 1. package.json (Node.js projects)
 * 2. .git directory (any Git repository)
 *
 * @returns The project root path, or cwd if no markers found
 *
 * @example
 * ```typescript
 * // In /home/user/projects/my-app/src/utils
 * findProjectRoot() // Returns "/home/user/projects/my-app"
 * ```
 */
export function findProjectRoot(): string {
    let current = process.cwd();

    // Walk up the directory tree until we hit the filesystem root
    while (true) {
        // Check for package.json or .git
        if (existsSync(join(current, 'package.json')) || existsSync(join(current, '.git'))) {
            return current;
        }

        const parent = dirname(current);
        // If dirname returns the same path, we've hit the root
        if (parent === current) {
            break;
        }
        current = parent;
    }

    // Fallback to cwd if no project root found
    logger.debug('[MCP Config] No project root found, using cwd');
    return process.cwd();
}

/**
 * Get the full path to an MCP configuration file.
 *
 * @param scope - Which config scope to get the path for (default: 'user')
 * @returns Absolute path to the config file
 *
 * @example
 * ```typescript
 * getMcpConfigPath('user')     // "/home/user/.happy/config/mcp.json"
 * getMcpConfigPath('project')  // "/project/root/.happy/mcp.json"
 * ```
 */
export function getMcpConfigPath(scope: ConfigScope = 'user'): string {
    if (scope === 'user') {
        return getUserConfigPath();
    }
    return join(findProjectRoot(), PROJECT_CONFIG_NAME);
}

/**
 * Load MCP configuration from a specific scope.
 *
 * Reads and validates the config file, returning DEFAULT_MCP_CONFIG if:
 * - File doesn't exist
 * - File contains invalid JSON
 * - Content fails Zod validation
 *
 * @param scope - Which config scope to load (default: 'user')
 * @returns Validated HappyMcpConfig object
 *
 * @example
 * ```typescript
 * const userConfig = loadMcpConfig('user');
 * const projectConfig = loadMcpConfig('project');
 *
 * // Config is always valid - never null
 * console.log(userConfig.mcpServers);
 * ```
 */
export function loadMcpConfig(scope: ConfigScope = 'user'): HappyMcpConfig {
    const configPath = getMcpConfigPath(scope);

    if (!existsSync(configPath)) {
        logger.debug(`[MCP Config] No ${scope} config file at ${configPath}`);
        return { ...DEFAULT_MCP_CONFIG };
    }

    try {
        const content = readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(content);
        const validated = HappyMcpConfigSchema.parse(parsed);
        logger.debug(`[MCP Config] Loaded ${scope} config from ${configPath}`);
        return validated;
    } catch (error) {
        if (error instanceof SyntaxError) {
            logger.error(`[MCP Config] Invalid JSON in ${configPath}: ${error.message}`);
        } else if (error instanceof Error && error.name === 'ZodError') {
            logger.error(`[MCP Config] Validation failed for ${configPath}: ${error.message}`);
        } else {
            logger.error(`[MCP Config] Failed to read ${configPath}:`, error);
        }
        return { ...DEFAULT_MCP_CONFIG };
    }
}

/**
 * Save MCP configuration to a specific scope.
 *
 * Before writing:
 * 1. Validates config with Zod schema
 * 2. Creates parent directories if needed
 * 3. Creates backup of existing file (mcp.json.bak)
 *
 * @param config - The configuration to save
 * @param scope - Which config scope to save to
 * @throws Error if validation fails or write operation fails
 *
 * @example
 * ```typescript
 * const config = loadMcpConfig('user');
 * config.mcpServers['my-server'] = {
 *     command: 'node',
 *     args: ['server.js'],
 *     metadata: { addedAt: new Date().toISOString() }
 * };
 * saveMcpConfig(config, 'user');
 * ```
 */
export function saveMcpConfig(config: HappyMcpConfig, scope: ConfigScope): void {
    // Validate before saving to ensure data integrity
    const validated = HappyMcpConfigSchema.parse(config);

    const configPath = getMcpConfigPath(scope);
    const configDir = dirname(configPath);
    const backupPath = configPath + '.bak';

    // Ensure directory exists
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
        logger.debug(`[MCP Config] Created directory ${configDir}`);
    }

    // Create backup if file exists
    if (existsSync(configPath)) {
        try {
            copyFileSync(configPath, backupPath);
            logger.debug(`[MCP Config] Created backup at ${backupPath}`);
        } catch (backupError) {
            logger.warn(`[MCP Config] Failed to create backup: ${backupError}`);
            // Continue with save even if backup fails
        }
    }

    // Write config
    writeFileSync(configPath, JSON.stringify(validated, null, 2), 'utf-8');
    logger.debug(`[MCP Config] Saved ${scope} config to ${configPath}`);
}

/**
 * Get merged MCP server configurations from both user and project scopes.
 *
 * Merge strategy:
 * 1. Load user config as base
 * 2. Load project config
 * 3. Project servers override user servers with the same name
 * 4. Optionally apply agent-specific overrides
 *
 * @param agentName - Optional agent name to apply specific overrides (e.g., 'claude', 'codex')
 * @returns Merged record of server name to configuration
 *
 * @example
 * ```typescript
 * // Get all servers for any agent
 * const allServers = getMergedMcpServers();
 *
 * // Get servers with claude-specific overrides applied
 * const claudeServers = getMergedMcpServers('claude');
 *
 * // Iterate over enabled servers
 * for (const [name, config] of Object.entries(allServers)) {
 *     if (!config.disabled) {
 *         console.log(`${name}: ${config.command}`);
 *     }
 * }
 * ```
 */
export function getMergedMcpServers(
    agentName?: string
): Record<string, HappyMcpServerConfig> {
    const userConfig = loadMcpConfig('user');
    const projectConfig = loadMcpConfig('project');

    // Start with user servers as base
    const merged: Record<string, HappyMcpServerConfig> = { ...userConfig.mcpServers };

    // Project servers override user servers
    for (const [name, serverConfig] of Object.entries(projectConfig.mcpServers)) {
        merged[name] = serverConfig;
    }

    // Apply agent-specific overrides if specified
    if (agentName) {
        // Check both user and project configs for agent overrides
        const userOverrides = userConfig.agentOverrides?.[agentName];
        const projectOverrides = projectConfig.agentOverrides?.[agentName];

        // Apply user agent overrides first
        if (userOverrides) {
            applyAgentOverrides(merged, userOverrides);
        }

        // Apply project agent overrides (takes precedence)
        if (projectOverrides) {
            applyAgentOverrides(merged, projectOverrides);
        }
    }

    return merged;
}

/**
 * Apply agent-specific overrides to a merged server configuration.
 *
 * @param servers - Mutable record of servers to modify
 * @param overrides - Agent-specific override configuration
 */
function applyAgentOverrides(
    servers: Record<string, HappyMcpServerConfig>,
    overrides: { mcpServers?: Record<string, HappyMcpServerConfig>; disabled?: string[] }
): void {
    // Add/override servers from agent overrides
    if (overrides.mcpServers) {
        for (const [name, serverConfig] of Object.entries(overrides.mcpServers)) {
            servers[name] = serverConfig;
        }
    }

    // Mark servers as disabled for this agent
    if (overrides.disabled) {
        for (const serverName of overrides.disabled) {
            if (servers[serverName]) {
                servers[serverName] = { ...servers[serverName], disabled: true };
            }
        }
    }
}

/**
 * Get the list of enabled (non-disabled) MCP servers.
 *
 * Convenience function that filters out disabled servers from the merged config.
 *
 * @param agentName - Optional agent name for agent-specific filtering
 * @returns Record of enabled servers only
 *
 * @example
 * ```typescript
 * const enabledServers = getEnabledMcpServers('claude');
 * console.log(`${Object.keys(enabledServers).length} servers enabled`);
 * ```
 */
export function getEnabledMcpServers(
    agentName?: string
): Record<string, HappyMcpServerConfig> {
    const allServers = getMergedMcpServers(agentName);
    const enabled: Record<string, HappyMcpServerConfig> = {};

    for (const [name, config] of Object.entries(allServers)) {
        if (!config.disabled) {
            enabled[name] = config;
        }
    }

    return enabled;
}

/**
 * Check if any MCP config files exist (user or project level).
 *
 * @returns true if at least one config file exists
 */
export function hasMcpConfig(): boolean {
    return existsSync(getMcpConfigPath('user')) || existsSync(getMcpConfigPath('project'));
}

/**
 * Build MCP sync state for daemon state transmission to the app.
 *
 * Transforms the local HappyMcpConfig into the protocol's McpSyncState format
 * for syncing to connected mobile apps via daemonState.
 *
 * @see HAP-608 - CLI Sync: Include MCP Config in daemonState
 * @returns McpSyncState containing server states, or undefined if no config exists
 *
 * @example
 * ```typescript
 * const mcpConfig = buildMcpSyncState();
 * if (mcpConfig) {
 *     daemonState.mcpConfig = mcpConfig;
 * }
 * ```
 */
export function buildMcpSyncState(): {
    servers: Record<string, {
        disabled: boolean;
        toolCount?: number;
        lastValidated?: string;
        disabledTools?: string[];
    }>;
} | undefined {
    // If no MCP config exists, return undefined (no servers configured)
    if (!hasMcpConfig()) {
        return undefined;
    }

    // Get merged servers from both user and project configs
    const servers = getMergedMcpServers();

    // If no servers configured, return undefined
    if (Object.keys(servers).length === 0) {
        return undefined;
    }

    // Transform to sync state format
    const syncServers: Record<string, {
        disabled: boolean;
        toolCount?: number;
        lastValidated?: string;
        disabledTools?: string[];
    }> = {};

    for (const [name, config] of Object.entries(servers)) {
        syncServers[name] = {
            disabled: config.disabled ?? false,
            toolCount: config.metadata?.toolCount,
            lastValidated: config.metadata?.lastValidated,
            disabledTools: config.disabledTools?.length ? config.disabledTools : undefined,
        };
    }

    return { servers: syncServers };
}
