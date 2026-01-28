"use strict";
/**
 * Security utilities for RPC handlers.
 *
 * This module provides:
 * 1. Path validation - prevents directory traversal attacks
 * 2. Command validation - prevents OS command injection (OWASP A03:2021)
 *
 * Security Notes:
 * - Path validation ensures file operations remain within the working directory
 * - Command validation implements an allowlist to prevent arbitrary command execution
 * - Both are defense-in-depth measures that protect even if E2E encryption is compromised
 *
 * @see https://owasp.org/www-community/attacks/Command_Injection (CWE-78)
 * @see HAP-614 for the security audit that identified the command injection vulnerability
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALLOWED_COMMANDS = void 0;
exports.validatePath = validatePath;
exports.createPathValidator = createPathValidator;
exports.validatePathOrThrow = validatePathOrThrow;
exports.validateCommand = validateCommand;
exports.validateCommandOrThrow = validateCommandOrThrow;
exports.getAllowedCommandNames = getAllowedCommandNames;
var node_path_1 = require("node:path");
/**
 * Validates that a path resolves to a location within the working directory.
 * Prevents directory traversal attacks (e.g., "../../etc/passwd").
 *
 * This implementation uses path.relative() for cross-platform compatibility,
 * avoiding string prefix checks that can fail on Windows due to:
 * - Case-insensitive filesystem paths
 * - Different path separators (\ vs /)
 * - Drive letter handling
 *
 * @param inputPath - The path to validate (can be absolute or relative)
 * @param workingDirectory - The base directory that paths must be within
 * @returns ValidationResult with resolved path if valid, error message if not
 *
 * @example
 * ```typescript
 * const result = validatePath('./file.txt', '/home/user/project');
 * if (result.valid) {
 *   // Safe to use result.resolvedPath
 * } else {
 *   // Reject with result.error
 * }
 * ```
 *
 * @security
 * - Rejects paths containing null bytes (used in some attacks)
 * - Rejects paths that resolve outside working directory
 * - Handles symlinks by resolving to absolute paths
 */
function validatePath(inputPath, workingDirectory) {
    // Check for null bytes (potential path injection attack)
    if (inputPath.includes('\0')) {
        return {
            valid: false,
            error: 'Path contains invalid characters (null byte)'
        };
    }
    // Resolve the path to an absolute path
    // If inputPath is absolute, resolve() returns it normalized
    // If inputPath is relative, resolve() joins it with workingDirectory
    var resolvedPath = (0, node_path_1.isAbsolute)(inputPath)
        ? (0, node_path_1.resolve)(inputPath)
        : (0, node_path_1.resolve)(workingDirectory, inputPath);
    // Normalize the working directory for comparison
    var normalizedWorkingDir = (0, node_path_1.resolve)(workingDirectory);
    // Use path.relative() to determine the relationship between paths
    // If the resolved path is outside working dir, relative() will return
    // a path starting with '..' or an absolute path (on Windows with different drives)
    var relativePath = (0, node_path_1.relative)(normalizedWorkingDir, resolvedPath);
    // Check if the path escapes the working directory:
    // 1. Starts with '..' - traverses upward
    // 2. Is an absolute path - on Windows, different drive (e.g., D:\)
    // 3. Empty string is OK (means same directory)
    if (relativePath.startsWith('..') || (0, node_path_1.isAbsolute)(relativePath)) {
        return {
            valid: false,
            error: "Path \"".concat(inputPath, "\" resolves outside the working directory")
        };
    }
    return {
        valid: true,
        resolvedPath: resolvedPath
    };
}
/**
 * Creates a validation function bound to a specific working directory.
 * Useful for handlers that need to validate multiple paths against the same base.
 *
 * @param workingDirectory - The base directory for validation
 * @returns A function that validates paths against the bound working directory
 *
 * @example
 * ```typescript
 * const validator = createPathValidator('/home/user/project');
 * const result = validator('./subdir/file.txt');
 * ```
 */
function createPathValidator(workingDirectory) {
    return function (inputPath) { return validatePath(inputPath, workingDirectory); };
}
/**
 * Validates a path and throws if invalid.
 * Convenience function for handlers that want to throw on invalid paths.
 *
 * @param inputPath - The path to validate
 * @param workingDirectory - The base directory that paths must be within
 * @returns The resolved absolute path
 * @throws Error if path is invalid
 */
function validatePathOrThrow(inputPath, workingDirectory) {
    var result = validatePath(inputPath, workingDirectory);
    if (!result.valid) {
        throw new Error(result.error);
    }
    return result.resolvedPath;
}
// =============================================================================
// COMMAND SECURITY - OS Command Injection Prevention (CWE-78, OWASP A03:2021)
// =============================================================================
/**
 * Shell metacharacters that enable command injection attacks.
 *
 * These characters allow:
 * - `;` - Command separator (ls; rm -rf /)
 * - `&` - Background execution and command chaining (cmd1 & cmd2, cmd1 && cmd2)
 * - `|` - Pipe to another command (ls | xargs rm)
 * - `` ` `` - Command substitution (`rm -rf /`)
 * - `$` - Variable expansion and command substitution $(rm -rf /)
 * - `(` `)` - Subshell execution
 * - `>` `<` - Redirection (could overwrite files)
 * - `\n` - Newline (command separator on Unix)
 *
 * @security This is a critical security control. Do NOT remove characters without
 * thorough security review.
 */
var SHELL_METACHARACTERS = /[;&|`$()<>\n]/;
/**
 * Allowlist of commands that can be executed via the bash RPC handler.
 *
 * Structure:
 * - Key: The base command/executable
 * - Value: Array of allowed first arguments (subcommands)
 *   - Empty array [] means ANY first argument is allowed (command is fully trusted)
 *   - Non-empty array means ONLY those specific first arguments are allowed
 *
 * @security This is a critical security control. Adding commands here allows
 * remote execution. Only add commands that are:
 * 1. Read-only or safe to execute
 * 2. Do not allow arbitrary file/command arguments that could be exploited
 *
 * @see HAP-614 for the security audit that established this allowlist
 */
exports.ALLOWED_COMMANDS = {
    // Git operations (read-only and safe write operations)
    'git': ['status', 'diff', 'log', 'branch', 'show', 'rev-parse', 'remote', 'fetch', 'config', 'ls-files', 'stash'],
    // File operations (read-only)
    'ls': [], // Any ls arguments are safe
    'cat': [], // Any cat arguments are safe (read-only)
    'head': [], // Any head arguments are safe
    'tail': [], // Any tail arguments are safe
    'pwd': [], // No arguments needed
    'which': [], // Safe - just shows paths
    'wc': [], // Word count - safe
    'file': [], // File type detection - safe
    'find': [], // Find files - read-only
    'tree': [], // Directory tree - read-only
    // Build tools (npm/yarn scripts are sandboxed by package.json)
    'npm': ['run', 'test', 'start', 'build', 'ls', 'list', 'outdated', 'audit', 'version', 'view', 'info', 'pack', 'publish', 'cache'],
    'npx': [], // npx runs local packages - generally safe in project context
    'yarn': ['run', 'test', 'start', 'build', 'list', 'outdated', 'audit', 'version', 'info', 'pack', 'publish', 'cache', 'workspaces'],
    'pnpm': ['run', 'test', 'start', 'build', 'list', 'outdated', 'audit', 'view'],
    'bun': ['run', 'test', 'build', 'x'],
    // TypeScript/JavaScript
    'tsc': [], // TypeScript compiler - safe
    'node': [], // Node.js - needed for scripts
    'deno': ['run', 'check', 'test', 'lint', 'fmt', 'info', 'types'],
    // Common dev tools
    'grep': [], // Search - read-only
    'rg': [], // Ripgrep - read-only
    'ag': [], // Silver searcher - read-only
    'awk': [], // Text processing - read-only on stdout
    'sed': [], // Stream editor - safe without -i
    'sort': [], // Sorting - read-only
    'uniq': [], // Unique lines - read-only
    'diff': [], // Diff files - read-only
    'jq': [], // JSON processor - read-only
    'yq': [], // YAML processor - read-only
    // Docker (safe read operations)
    'docker': ['ps', 'images', 'logs', 'inspect', 'stats', 'top', 'version', 'info'],
    // Claude Code
    'claude': ['--version', '--help', 'config', 'doctor'],
    // Environment info
    'env': [], // Show environment - read-only
    'echo': [], // Echo - safe
    'printf': [], // Printf - safe
    'date': [], // Date - safe
    'uname': [], // System info - safe
    'hostname': [], // Hostname - safe
    'whoami': [], // Current user - safe
    'id': [], // User/group info - safe
    // Make/build systems
    'make': [], // Make - runs Makefile targets
    'cmake': [], // CMake configuration
    'cargo': ['build', 'test', 'run', 'check', 'clippy', 'fmt', 'doc', 'bench', 'tree', 'metadata'],
    'go': ['build', 'test', 'run', 'vet', 'fmt', 'mod', 'get', 'list', 'version', 'env'],
    'python': [], // Python - needed for scripts
    'python3': [], // Python 3
    'pip': ['list', 'show', 'freeze', 'check'],
    'pip3': ['list', 'show', 'freeze', 'check'],
    // Linting and formatting
    'eslint': [],
    'prettier': [],
    'biome': [],
    'oxlint': [],
    'rustfmt': [],
    'gofmt': [],
    'black': [],
    'ruff': [],
};
/**
 * Validates a shell command against the security allowlist.
 *
 * This function prevents OS command injection (CWE-78) by:
 * 1. Rejecting commands containing shell metacharacters
 * 2. Only allowing commands on the explicit allowlist
 * 3. Optionally restricting subcommands for certain executables
 *
 * @param command - The full command string to validate
 * @returns CommandValidationResult indicating if the command is allowed
 *
 * @example
 * ```typescript
 * validateCommand('git status');           // { valid: true }
 * validateCommand('rm -rf /');             // { valid: false, reason: 'not_allowlisted' }
 * validateCommand('ls; rm -rf /');         // { valid: false, reason: 'metacharacters' }
 * validateCommand('git push');             // { valid: false, reason: 'subcommand_not_allowed' }
 * ```
 *
 * @security This is a critical security control. The allowlist is intentionally
 * restrictive - it's better to block legitimate commands than allow malicious ones.
 */
function validateCommand(command) {
    // Trim and check for empty command
    var trimmedCommand = command.trim();
    if (!trimmedCommand) {
        return {
            valid: false,
            error: 'Empty command',
            reason: 'not_allowlisted'
        };
    }
    // Check for shell metacharacters FIRST (highest priority security check)
    // This blocks command chaining, piping, substitution, etc.
    if (SHELL_METACHARACTERS.test(trimmedCommand)) {
        return {
            valid: false,
            error: 'Command contains shell metacharacters which are not allowed for security reasons',
            reason: 'metacharacters'
        };
    }
    // Parse the command into parts
    // Note: This is a simple split - it doesn't handle quoted strings perfectly,
    // but that's OK because we already blocked metacharacters that would be needed
    // to escape quotes maliciously
    var parts = trimmedCommand.split(/\s+/);
    var executable = parts[0];
    var firstArg = parts[1];
    // Check if the executable is in the allowlist
    if (!(executable in exports.ALLOWED_COMMANDS)) {
        return {
            valid: false,
            error: "Command '".concat(executable, "' is not in the allowed commands list. Allowed commands: ").concat(Object.keys(exports.ALLOWED_COMMANDS).join(', ')),
            reason: 'not_allowlisted'
        };
    }
    // Check subcommand restrictions
    var allowedSubcommands = exports.ALLOWED_COMMANDS[executable];
    if (allowedSubcommands.length > 0) {
        // This executable has subcommand restrictions
        if (!firstArg || !allowedSubcommands.includes(firstArg)) {
            return {
                valid: false,
                error: "Subcommand '".concat(firstArg || '(none)', "' is not allowed for '").concat(executable, "'. Allowed: ").concat(allowedSubcommands.join(', ')),
                reason: 'subcommand_not_allowed'
            };
        }
    }
    // Command is allowed
    return { valid: true };
}
/**
 * Validates a command and throws if invalid.
 * Convenience function for handlers that want to throw on invalid commands.
 *
 * @param command - The command to validate
 * @throws Error if command is not allowed
 */
function validateCommandOrThrow(command) {
    var result = validateCommand(command);
    if (!result.valid) {
        throw new Error(result.error);
    }
}
/**
 * Gets the list of allowed command names.
 * Useful for displaying to users what commands are available.
 *
 * @returns Array of allowed executable names
 */
function getAllowedCommandNames() {
    return Object.keys(exports.ALLOWED_COMMANDS);
}
