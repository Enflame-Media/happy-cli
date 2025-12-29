import { logger } from '@/ui/logger';
import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { run as runRipgrep } from '@/modules/ripgrep/index';
import { run as runDifftastic } from '@/modules/difftastic/index';
import { startHTTPDirectProxy, HTTPProxy } from '@/modules/proxy/index';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import { withRetry } from '@/utils/retry';
import { validatePath, validateCommand, ALLOWED_COMMANDS } from './pathSecurity';

const execAsync = promisify(exec);

interface BashRequest {
    command: string;
    cwd?: string;
    timeout?: number; // timeout in milliseconds
}

interface BashResponse {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
}

interface ReadFileRequest {
    path: string;
}

interface ReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    error?: string;
}

interface WriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null; // null for new files, hash for existing files
}

interface WriteFileResponse {
    success: boolean;
    hash?: string; // hash of written file
    error?: string;
}

interface ListDirectoryRequest {
    path: string;
}

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number; // timestamp
}

interface ListDirectoryResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

interface GetDirectoryTreeRequest {
    path: string;
    maxDepth: number;
}

interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: TreeNode[]; // Only present for directories
}

interface GetDirectoryTreeResponse {
    success: boolean;
    tree?: TreeNode;
    error?: string;
}

interface RipgrepRequest {
    args: string[];
    cwd?: string;
}

interface RipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface DifftasticRequest {
    args: string[];
    cwd?: string;
}

interface DifftasticResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface StartProxyRequest {
    target: string;
    verbose?: boolean;
}

interface StartProxyResponse {
    success: boolean;
    proxyId?: string;
    url?: string;
    error?: string;
}

interface StopProxyRequest {
    proxyId: string;
}

interface StopProxyResponse {
    success: boolean;
    error?: string;
}

interface ListProxiesResponse {
    success: boolean;
    proxies?: Array<{ id: string; url: string; target: string }>;
    error?: string;
}

// Allowed commands types
interface GetAllowedCommandsResponse {
    success: boolean;
    /**
     * Map of command name to allowed subcommands.
     * Empty array means all subcommands are allowed.
     * Non-empty array means only those specific subcommands are allowed.
     */
    commands?: Record<string, readonly string[]>;
    error?: string;
}

// Track running proxies per session
const runningProxies = new Map<string, { proxy: HTTPProxy; target: string }>();

/**
 * Cleanup all running proxies. Call this when a session ends.
 * @returns Promise that resolves when all proxies are closed
 */
export async function cleanupAllProxies(): Promise<void> {
    const closePromises = Array.from(runningProxies.entries()).map(async ([id, info]) => {
        try {
            await info.proxy.close();
            logger.debug(`Cleaned up proxy ${id}`);
        } catch (error) {
            logger.debug(`Failed to cleanup proxy ${id}:`, error);
        }
    });

    await Promise.all(closePromises);
    runningProxies.clear();
}

/*
 * Spawn Session Options and Result
 * This rpc type is used by the daemon, all other RPCs here are for sessions
*/

export interface SpawnSessionOptions {
    machineId?: string;
    directory: string;
    sessionId?: string;
    approvedNewDirectoryCreation?: boolean;
    agent?: 'claude' | 'codex' | 'gemini';
    token?: string;
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string; resumedFrom?: string; message?: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

/**
 * Register all RPC handlers with the session
 * @param rpcHandlerManager - The RPC handler manager to register handlers with
 * @param workingDirectory - The working directory for path validation (prevents directory traversal)
 */
export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string) {

    // Shell command handler - executes commands in the default shell
    // SECURITY: Command validation prevents OS command injection (CWE-78)
    // See HAP-614 for the security audit that identified this vulnerability
    rpcHandlerManager.registerHandler<BashRequest, BashResponse>('bash', async (data, _signal) => {
        logger.debug('[RPC:bash] Command request received');

        // SECURITY: Validate command against allowlist BEFORE any execution
        // This is the primary defense against command injection attacks
        const commandValidation = validateCommand(data.command);
        if (!commandValidation.valid) {
            // Audit log: blocked command attempt
            logger.warn('[RPC:bash] BLOCKED command:', {
                command: data.command.substring(0, 100), // Truncate for log safety
                reason: commandValidation.reason,
                error: commandValidation.error
            });
            return {
                success: false,
                error: commandValidation.error || 'Command not allowed'
            };
        }

        // Audit log: allowed command
        logger.info('[RPC:bash] Executing allowed command:', data.command);

        try {
            // Validate and resolve cwd
            let cwd = workingDirectory;
            if (data.cwd) {
                const validation = validatePath(data.cwd, workingDirectory);
                if (!validation.valid) {
                    return {
                        success: false,
                        error: validation.error || 'Invalid working directory path'
                    };
                }
                cwd = validation.resolvedPath!;
            }

            // Build options with shell enabled by default
            // Note: ExecOptions doesn't support boolean for shell, but exec() uses the default shell when shell is undefined
            const options: ExecOptions = {
                cwd,
                timeout: data.timeout || 30000, // Default 30 seconds timeout
            };

            const { stdout, stderr } = await execAsync(data.command, options);

            return {
                success: true,
                stdout: stdout ? stdout.toString() : '',
                stderr: stderr ? stderr.toString() : '',
                exitCode: 0
            };
        } catch (error) {
            const execError = error as NodeJS.ErrnoException & {
                stdout?: string;
                stderr?: string;
                code?: number | string;
                killed?: boolean;
            };

            // Check if the error was due to timeout
            if (execError.code === 'ETIMEDOUT' || execError.killed) {
                return {
                    success: false,
                    stdout: execError.stdout || '',
                    stderr: execError.stderr || '',
                    exitCode: typeof execError.code === 'number' ? execError.code : -1,
                    error: 'Command timed out'
                };
            }

            // If exec fails, it includes stdout/stderr in the error
            return {
                success: false,
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
                exitCode: typeof execError.code === 'number' ? execError.code : 1,
                error: execError.message || 'Command failed'
            };
        }
    });

    // Read file handler - returns base64 encoded content
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>('readFile', async (data, _signal) => {
        logger.debug('Read file request:', data.path);

        // Validate path to prevent directory traversal
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error || 'Invalid file path' };
        }

        try {
            const buffer = await withRetry(() => readFile(validation.resolvedPath!));
            const content = buffer.toString('base64');
            return { success: true, content };
        } catch (error) {
            logger.debug('Failed to read file:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' };
        }
    });

    // Write file handler - with hash verification
    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>('writeFile', async (data, _signal) => {
        logger.debug('Write file request:', data.path);

        // Validate path to prevent directory traversal
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error || 'Invalid file path' };
        }
        const filePath = validation.resolvedPath!;

        try {
            // If expectedHash is provided (not null), verify existing file
            if (data.expectedHash !== null && data.expectedHash !== undefined) {
                try {
                    const existingBuffer = await withRetry(() => readFile(filePath));
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex');

                    if (existingHash !== data.expectedHash) {
                        return {
                            success: false,
                            error: `File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`
                        };
                    }
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException;
                    if (nodeError.code !== 'ENOENT') {
                        throw error;
                    }
                    // File doesn't exist but hash was provided
                    return {
                        success: false,
                        error: 'File does not exist but hash was provided'
                    };
                }
            } else {
                // expectedHash is null - expecting new file
                try {
                    await stat(filePath);
                    // File exists but we expected it to be new
                    return {
                        success: false,
                        error: 'File already exists but was expected to be new'
                    };
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException;
                    if (nodeError.code !== 'ENOENT') {
                        throw error;
                    }
                    // File doesn't exist - this is expected
                }
            }

            // Write the file
            const buffer = Buffer.from(data.content, 'base64');
            await withRetry(() => writeFile(filePath, buffer));

            // Calculate and return hash of written file
            const hash = createHash('sha256').update(buffer).digest('hex');

            return { success: true, hash };
        } catch (error) {
            logger.debug('Failed to write file:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to write file' };
        }
    });

    // List directory handler
    rpcHandlerManager.registerHandler<ListDirectoryRequest, ListDirectoryResponse>('listDirectory', async (data, _signal) => {
        logger.debug('List directory request:', data.path);

        // Validate path to prevent directory traversal
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error || 'Invalid directory path' };
        }
        const dirPath = validation.resolvedPath!;

        try {
            const entries = await readdir(dirPath, { withFileTypes: true });

            const directoryEntries: DirectoryEntry[] = await Promise.all(
                entries.map(async (entry) => {
                    const fullPath = join(dirPath, entry.name);
                    let type: 'file' | 'directory' | 'other' = 'other';
                    let size: number | undefined;
                    let modified: number | undefined;

                    if (entry.isDirectory()) {
                        type = 'directory';
                    } else if (entry.isFile()) {
                        type = 'file';
                    }

                    try {
                        const stats = await stat(fullPath);
                        size = stats.size;
                        modified = stats.mtime.getTime();
                    } catch (error) {
                        // Ignore stat errors for individual files
                        logger.debug(`Failed to stat ${fullPath}:`, error);
                    }

                    return {
                        name: entry.name,
                        type,
                        size,
                        modified
                    };
                })
            );

            // Sort entries: directories first, then files, alphabetically
            directoryEntries.sort((a, b) => {
                if (a.type === 'directory' && b.type !== 'directory') return -1;
                if (a.type !== 'directory' && b.type === 'directory') return 1;
                return a.name.localeCompare(b.name);
            });

            return { success: true, entries: directoryEntries };
        } catch (error) {
            logger.debug('Failed to list directory:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' };
        }
    });

    // Get directory tree handler - recursive with depth control
    rpcHandlerManager.registerHandler<GetDirectoryTreeRequest, GetDirectoryTreeResponse>('getDirectoryTree', async (data, _signal) => {
        logger.debug('Get directory tree request:', data.path, 'maxDepth:', data.maxDepth);

        // Helper function to build tree recursively
        async function buildTree(path: string, name: string, currentDepth: number): Promise<TreeNode | null> {
            try {
                const stats = await stat(path);

                // Base node information
                const node: TreeNode = {
                    name,
                    path,
                    type: stats.isDirectory() ? 'directory' : 'file',
                    size: stats.size,
                    modified: stats.mtime.getTime()
                };

                // If it's a directory and we haven't reached max depth, get children
                if (stats.isDirectory() && currentDepth < data.maxDepth) {
                    const entries = await readdir(path, { withFileTypes: true });
                    const children: TreeNode[] = [];

                    // Process entries in parallel, filtering out symlinks
                    await Promise.all(
                        entries.map(async (entry) => {
                            // Skip symbolic links completely
                            if (entry.isSymbolicLink()) {
                                logger.debug(`Skipping symlink: ${join(path, entry.name)}`);
                                return;
                            }

                            const childPath = join(path, entry.name);
                            const childNode = await buildTree(childPath, entry.name, currentDepth + 1);
                            if (childNode) {
                                children.push(childNode);
                            }
                        })
                    );

                    // Sort children: directories first, then files, alphabetically
                    children.sort((a, b) => {
                        if (a.type === 'directory' && b.type !== 'directory') return -1;
                        if (a.type !== 'directory' && b.type === 'directory') return 1;
                        return a.name.localeCompare(b.name);
                    });

                    node.children = children;
                }

                return node;
            } catch (error) {
                // Log error but continue traversal
                logger.debug(`Failed to process ${path}:`, error instanceof Error ? error.message : String(error));
                return null;
            }
        }

        try {
            // Validate maxDepth
            if (data.maxDepth < 0) {
                return { success: false, error: 'maxDepth must be non-negative' };
            }

            // Validate path to prevent directory traversal
            const validation = validatePath(data.path, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error || 'Invalid directory path' };
            }
            const treePath = validation.resolvedPath!;

            // Get the base name for the root node
            const baseName = treePath === '/' ? '/' : treePath.split('/').pop() || treePath;

            // Build the tree starting from the requested path
            const tree = await buildTree(treePath, baseName, 0);

            if (!tree) {
                return { success: false, error: 'Failed to access the specified path' };
            }

            return { success: true, tree };
        } catch (error) {
            logger.debug('Failed to get directory tree:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to get directory tree' };
        }
    });

    // Ripgrep handler - raw interface to ripgrep
    rpcHandlerManager.registerHandler<RipgrepRequest, RipgrepResponse>('ripgrep', async (data, _signal) => {
        logger.debug('Ripgrep request with args:', data.args, 'cwd:', data.cwd);

        // Validate cwd if provided
        let cwd = workingDirectory;
        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return {
                    success: false,
                    error: validation.error || 'Invalid working directory path'
                };
            }
            cwd = validation.resolvedPath!;
        }

        try {
            const result = await runRipgrep(data.args, { cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run ripgrep:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run ripgrep'
            };
        }
    });

    // Difftastic handler - raw interface to difftastic
    rpcHandlerManager.registerHandler<DifftasticRequest, DifftasticResponse>('difftastic', async (data, _signal) => {
        logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd);

        // Validate cwd if provided
        let cwd = workingDirectory;
        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return {
                    success: false,
                    error: validation.error || 'Invalid working directory path'
                };
            }
            cwd = validation.resolvedPath!;
        }

        try {
            const result = await runDifftastic(data.args, { cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run difftastic:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run difftastic'
            };
        }
    });

    // Start HTTP proxy handler - creates a proxy server to forward requests
    rpcHandlerManager.registerHandler<StartProxyRequest, StartProxyResponse>('startProxy', async (data, _signal) => {
        logger.debug('Start proxy request for target:', data.target);

        try {
            // Validate target URL
            const targetUrl = new URL(data.target);
            if (!['http:', 'https:'].includes(targetUrl.protocol)) {
                return {
                    success: false,
                    error: 'Target must be an HTTP or HTTPS URL'
                };
            }

            const proxy = await startHTTPDirectProxy({
                target: data.target,
                verbose: data.verbose
            });

            // Generate a unique proxy ID
            const proxyId = `proxy_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

            // Track the running proxy
            runningProxies.set(proxyId, { proxy, target: data.target });

            logger.debug(`Started proxy ${proxyId} at ${proxy.url} -> ${data.target}`);

            return {
                success: true,
                proxyId,
                url: proxy.url
            };
        } catch (error) {
            logger.debug('Failed to start proxy:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to start proxy'
            };
        }
    });

    // Stop HTTP proxy handler - stops a running proxy by ID
    rpcHandlerManager.registerHandler<StopProxyRequest, StopProxyResponse>('stopProxy', async (data, _signal) => {
        logger.debug('Stop proxy request for:', data.proxyId);

        const proxyInfo = runningProxies.get(data.proxyId);
        if (!proxyInfo) {
            return {
                success: false,
                error: `Proxy not found: ${data.proxyId}`
            };
        }

        try {
            await proxyInfo.proxy.close();
            runningProxies.delete(data.proxyId);

            logger.debug(`Stopped proxy ${data.proxyId}`);

            return { success: true };
        } catch (error) {
            logger.debug('Failed to stop proxy:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to stop proxy'
            };
        }
    });

    // List running proxies handler
    rpcHandlerManager.registerHandler<Record<string, never>, ListProxiesResponse>('listProxies', async (_data, _signal) => {
        logger.debug('List proxies request');

        const proxies = Array.from(runningProxies.entries()).map(([id, info]) => ({
            id,
            url: info.proxy.url,
            target: info.target
        }));

        return {
            success: true,
            proxies
        };
    });

    // Get allowed commands handler - returns the command allowlist for UI display
    // HAP-635: Enables mobile app to show users which bash commands are permitted
    rpcHandlerManager.registerHandler<Record<string, never>, GetAllowedCommandsResponse>('getAllowedCommands', async (_data, _signal) => {
        logger.debug('Get allowed commands request');

        return {
            success: true,
            commands: ALLOWED_COMMANDS
        };
    });
}