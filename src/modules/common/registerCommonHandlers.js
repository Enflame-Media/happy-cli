"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupAllProxies = cleanupAllProxies;
exports.registerCommonHandlers = registerCommonHandlers;
var logger_1 = require("@/ui/logger");
var child_process_1 = require("child_process");
var util_1 = require("util");
var promises_1 = require("fs/promises");
var crypto_1 = require("crypto");
var path_1 = require("path");
var index_1 = require("@/modules/ripgrep/index");
var index_2 = require("@/modules/difftastic/index");
var index_3 = require("@/modules/proxy/index");
var retry_1 = require("@/utils/retry");
var pathSecurity_1 = require("./pathSecurity");
var execAsync = (0, util_1.promisify)(child_process_1.exec);
// Track running proxies per session
var runningProxies = new Map();
/**
 * Cleanup all running proxies. Call this when a session ends.
 * @returns Promise that resolves when all proxies are closed
 */
function cleanupAllProxies() {
    return __awaiter(this, void 0, void 0, function () {
        var closePromises;
        var _this = this;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    closePromises = Array.from(runningProxies.entries()).map(function (_a) { return __awaiter(_this, [_a], void 0, function (_b) {
                        var error_1;
                        var id = _b[0], info = _b[1];
                        return __generator(this, function (_c) {
                            switch (_c.label) {
                                case 0:
                                    _c.trys.push([0, 2, , 3]);
                                    return [4 /*yield*/, info.proxy.close()];
                                case 1:
                                    _c.sent();
                                    logger_1.logger.debug("Cleaned up proxy ".concat(id));
                                    return [3 /*break*/, 3];
                                case 2:
                                    error_1 = _c.sent();
                                    logger_1.logger.debug("Failed to cleanup proxy ".concat(id, ":"), error_1);
                                    return [3 /*break*/, 3];
                                case 3: return [2 /*return*/];
                            }
                        });
                    }); });
                    return [4 /*yield*/, Promise.all(closePromises)];
                case 1:
                    _a.sent();
                    runningProxies.clear();
                    return [2 /*return*/];
            }
        });
    });
}
/**
 * Register all RPC handlers with the session
 * @param rpcHandlerManager - The RPC handler manager to register handlers with
 * @param workingDirectory - The working directory for path validation (prevents directory traversal)
 */
function registerCommonHandlers(rpcHandlerManager, workingDirectory) {
    var _this = this;
    // Shell command handler - executes commands in the default shell
    // SECURITY: Command validation prevents OS command injection (CWE-78)
    // See HAP-614 for the security audit that identified this vulnerability
    rpcHandlerManager.registerHandler('bash', function (data, _signal) { return __awaiter(_this, void 0, void 0, function () {
        var commandValidation, cwd, validation, options, _a, stdout, stderr, error_2, execError;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    logger_1.logger.debug('[RPC:bash] Command request received');
                    commandValidation = (0, pathSecurity_1.validateCommand)(data.command);
                    if (!commandValidation.valid) {
                        // Audit log: blocked command attempt
                        logger_1.logger.warn('[RPC:bash] BLOCKED command:', {
                            command: data.command.substring(0, 100), // Truncate for log safety
                            reason: commandValidation.reason,
                            error: commandValidation.error
                        });
                        return [2 /*return*/, {
                                success: false,
                                error: commandValidation.error || 'Command not allowed'
                            }];
                    }
                    // Audit log: allowed command
                    logger_1.logger.info('[RPC:bash] Executing allowed command:', data.command);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    cwd = workingDirectory;
                    if (data.cwd) {
                        validation = (0, pathSecurity_1.validatePath)(data.cwd, workingDirectory);
                        if (!validation.valid) {
                            return [2 /*return*/, {
                                    success: false,
                                    error: validation.error || 'Invalid working directory path'
                                }];
                        }
                        cwd = validation.resolvedPath;
                    }
                    options = {
                        cwd: cwd,
                        timeout: data.timeout || 30000, // Default 30 seconds timeout
                    };
                    return [4 /*yield*/, execAsync(data.command, options)];
                case 2:
                    _a = _b.sent(), stdout = _a.stdout, stderr = _a.stderr;
                    return [2 /*return*/, {
                            success: true,
                            stdout: stdout ? stdout.toString() : '',
                            stderr: stderr ? stderr.toString() : '',
                            exitCode: 0
                        }];
                case 3:
                    error_2 = _b.sent();
                    execError = error_2;
                    // Check if the error was due to timeout
                    if (execError.code === 'ETIMEDOUT' || execError.killed) {
                        return [2 /*return*/, {
                                success: false,
                                stdout: execError.stdout || '',
                                stderr: execError.stderr || '',
                                exitCode: typeof execError.code === 'number' ? execError.code : -1,
                                error: 'Command timed out'
                            }];
                    }
                    // If exec fails, it includes stdout/stderr in the error
                    return [2 /*return*/, {
                            success: false,
                            stdout: execError.stdout ? execError.stdout.toString() : '',
                            stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
                            exitCode: typeof execError.code === 'number' ? execError.code : 1,
                            error: execError.message || 'Command failed'
                        }];
                case 4: return [2 /*return*/];
            }
        });
    }); });
    // Read file handler - returns base64 encoded content
    rpcHandlerManager.registerHandler('readFile', function (data, _signal) { return __awaiter(_this, void 0, void 0, function () {
        var validation, buffer, content, error_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.logger.debug('Read file request:', data.path);
                    validation = (0, pathSecurity_1.validatePath)(data.path, workingDirectory);
                    if (!validation.valid) {
                        return [2 /*return*/, { success: false, error: validation.error || 'Invalid file path' }];
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, (0, retry_1.withRetry)(function () { return (0, promises_1.readFile)(validation.resolvedPath); })];
                case 2:
                    buffer = _a.sent();
                    content = buffer.toString('base64');
                    return [2 /*return*/, { success: true, content: content }];
                case 3:
                    error_3 = _a.sent();
                    logger_1.logger.debug('Failed to read file:', error_3);
                    return [2 /*return*/, { success: false, error: error_3 instanceof Error ? error_3.message : 'Failed to read file' }];
                case 4: return [2 /*return*/];
            }
        });
    }); });
    // Write file handler - with hash verification
    rpcHandlerManager.registerHandler('writeFile', function (data, _signal) { return __awaiter(_this, void 0, void 0, function () {
        var validation, filePath, existingBuffer, existingHash, error_4, nodeError, error_5, nodeError, buffer_1, hash, error_6;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.logger.debug('Write file request:', data.path);
                    validation = (0, pathSecurity_1.validatePath)(data.path, workingDirectory);
                    if (!validation.valid) {
                        return [2 /*return*/, { success: false, error: validation.error || 'Invalid file path' }];
                    }
                    filePath = validation.resolvedPath;
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 11, , 12]);
                    if (!(data.expectedHash !== null && data.expectedHash !== undefined)) return [3 /*break*/, 6];
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, (0, retry_1.withRetry)(function () { return (0, promises_1.readFile)(filePath); })];
                case 3:
                    existingBuffer = _a.sent();
                    existingHash = (0, crypto_1.createHash)('sha256').update(existingBuffer).digest('hex');
                    if (existingHash !== data.expectedHash) {
                        return [2 /*return*/, {
                                success: false,
                                error: "File hash mismatch. Expected: ".concat(data.expectedHash, ", Actual: ").concat(existingHash)
                            }];
                    }
                    return [3 /*break*/, 5];
                case 4:
                    error_4 = _a.sent();
                    nodeError = error_4;
                    if (nodeError.code !== 'ENOENT') {
                        throw error_4;
                    }
                    // File doesn't exist but hash was provided
                    return [2 /*return*/, {
                            success: false,
                            error: 'File does not exist but hash was provided'
                        }];
                case 5: return [3 /*break*/, 9];
                case 6:
                    _a.trys.push([6, 8, , 9]);
                    return [4 /*yield*/, (0, promises_1.stat)(filePath)];
                case 7:
                    _a.sent();
                    // File exists but we expected it to be new
                    return [2 /*return*/, {
                            success: false,
                            error: 'File already exists but was expected to be new'
                        }];
                case 8:
                    error_5 = _a.sent();
                    nodeError = error_5;
                    if (nodeError.code !== 'ENOENT') {
                        throw error_5;
                    }
                    return [3 /*break*/, 9];
                case 9:
                    buffer_1 = Buffer.from(data.content, 'base64');
                    return [4 /*yield*/, (0, retry_1.withRetry)(function () { return (0, promises_1.writeFile)(filePath, buffer_1); })];
                case 10:
                    _a.sent();
                    hash = (0, crypto_1.createHash)('sha256').update(buffer_1).digest('hex');
                    return [2 /*return*/, { success: true, hash: hash }];
                case 11:
                    error_6 = _a.sent();
                    logger_1.logger.debug('Failed to write file:', error_6);
                    return [2 /*return*/, { success: false, error: error_6 instanceof Error ? error_6.message : 'Failed to write file' }];
                case 12: return [2 /*return*/];
            }
        });
    }); });
    // List directory handler
    rpcHandlerManager.registerHandler('listDirectory', function (data, _signal) { return __awaiter(_this, void 0, void 0, function () {
        var validation, dirPath, entries, directoryEntries, error_7;
        var _this = this;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.logger.debug('List directory request:', data.path);
                    validation = (0, pathSecurity_1.validatePath)(data.path, workingDirectory);
                    if (!validation.valid) {
                        return [2 /*return*/, { success: false, error: validation.error || 'Invalid directory path' }];
                    }
                    dirPath = validation.resolvedPath;
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, (0, promises_1.readdir)(dirPath, { withFileTypes: true })];
                case 2:
                    entries = _a.sent();
                    return [4 /*yield*/, Promise.all(entries.map(function (entry) { return __awaiter(_this, void 0, void 0, function () {
                            var fullPath, type, size, modified, stats, error_8;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        fullPath = (0, path_1.join)(dirPath, entry.name);
                                        type = 'other';
                                        if (entry.isDirectory()) {
                                            type = 'directory';
                                        }
                                        else if (entry.isFile()) {
                                            type = 'file';
                                        }
                                        _a.label = 1;
                                    case 1:
                                        _a.trys.push([1, 3, , 4]);
                                        return [4 /*yield*/, (0, promises_1.stat)(fullPath)];
                                    case 2:
                                        stats = _a.sent();
                                        size = stats.size;
                                        modified = stats.mtime.getTime();
                                        return [3 /*break*/, 4];
                                    case 3:
                                        error_8 = _a.sent();
                                        // Ignore stat errors for individual files
                                        logger_1.logger.debug("Failed to stat ".concat(fullPath, ":"), error_8);
                                        return [3 /*break*/, 4];
                                    case 4: return [2 /*return*/, {
                                            name: entry.name,
                                            type: type,
                                            size: size,
                                            modified: modified
                                        }];
                                }
                            });
                        }); }))];
                case 3:
                    directoryEntries = _a.sent();
                    // Sort entries: directories first, then files, alphabetically
                    directoryEntries.sort(function (a, b) {
                        if (a.type === 'directory' && b.type !== 'directory')
                            return -1;
                        if (a.type !== 'directory' && b.type === 'directory')
                            return 1;
                        return a.name.localeCompare(b.name);
                    });
                    return [2 /*return*/, { success: true, entries: directoryEntries }];
                case 4:
                    error_7 = _a.sent();
                    logger_1.logger.debug('Failed to list directory:', error_7);
                    return [2 /*return*/, { success: false, error: error_7 instanceof Error ? error_7.message : 'Failed to list directory' }];
                case 5: return [2 /*return*/];
            }
        });
    }); });
    // Get directory tree handler - recursive with depth control
    rpcHandlerManager.registerHandler('getDirectoryTree', function (data, _signal) { return __awaiter(_this, void 0, void 0, function () {
        // Helper function to build tree recursively
        function buildTree(path, name, currentDepth) {
            return __awaiter(this, void 0, void 0, function () {
                var stats, node, entries, children_1, error_10;
                var _this = this;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 5, , 6]);
                            return [4 /*yield*/, (0, promises_1.stat)(path)];
                        case 1:
                            stats = _a.sent();
                            node = {
                                name: name,
                                path: path,
                                type: stats.isDirectory() ? 'directory' : 'file',
                                size: stats.size,
                                modified: stats.mtime.getTime()
                            };
                            if (!(stats.isDirectory() && currentDepth < data.maxDepth)) return [3 /*break*/, 4];
                            return [4 /*yield*/, (0, promises_1.readdir)(path, { withFileTypes: true })];
                        case 2:
                            entries = _a.sent();
                            children_1 = [];
                            // Process entries in parallel, filtering out symlinks
                            return [4 /*yield*/, Promise.all(entries.map(function (entry) { return __awaiter(_this, void 0, void 0, function () {
                                    var childPath, childNode;
                                    return __generator(this, function (_a) {
                                        switch (_a.label) {
                                            case 0:
                                                // Skip symbolic links completely
                                                if (entry.isSymbolicLink()) {
                                                    logger_1.logger.debug("Skipping symlink: ".concat((0, path_1.join)(path, entry.name)));
                                                    return [2 /*return*/];
                                                }
                                                childPath = (0, path_1.join)(path, entry.name);
                                                return [4 /*yield*/, buildTree(childPath, entry.name, currentDepth + 1)];
                                            case 1:
                                                childNode = _a.sent();
                                                if (childNode) {
                                                    children_1.push(childNode);
                                                }
                                                return [2 /*return*/];
                                        }
                                    });
                                }); }))];
                        case 3:
                            // Process entries in parallel, filtering out symlinks
                            _a.sent();
                            // Sort children: directories first, then files, alphabetically
                            children_1.sort(function (a, b) {
                                if (a.type === 'directory' && b.type !== 'directory')
                                    return -1;
                                if (a.type !== 'directory' && b.type === 'directory')
                                    return 1;
                                return a.name.localeCompare(b.name);
                            });
                            node.children = children_1;
                            _a.label = 4;
                        case 4: return [2 /*return*/, node];
                        case 5:
                            error_10 = _a.sent();
                            // Log error but continue traversal
                            logger_1.logger.debug("Failed to process ".concat(path, ":"), error_10 instanceof Error ? error_10.message : String(error_10));
                            return [2 /*return*/, null];
                        case 6: return [2 /*return*/];
                    }
                });
            });
        }
        var validation, treePath, baseName, tree, error_9;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.logger.debug('Get directory tree request:', data.path, 'maxDepth:', data.maxDepth);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    // Validate maxDepth
                    if (data.maxDepth < 0) {
                        return [2 /*return*/, { success: false, error: 'maxDepth must be non-negative' }];
                    }
                    validation = (0, pathSecurity_1.validatePath)(data.path, workingDirectory);
                    if (!validation.valid) {
                        return [2 /*return*/, { success: false, error: validation.error || 'Invalid directory path' }];
                    }
                    treePath = validation.resolvedPath;
                    baseName = treePath === '/' ? '/' : treePath.split('/').pop() || treePath;
                    return [4 /*yield*/, buildTree(treePath, baseName, 0)];
                case 2:
                    tree = _a.sent();
                    if (!tree) {
                        return [2 /*return*/, { success: false, error: 'Failed to access the specified path' }];
                    }
                    return [2 /*return*/, { success: true, tree: tree }];
                case 3:
                    error_9 = _a.sent();
                    logger_1.logger.debug('Failed to get directory tree:', error_9);
                    return [2 /*return*/, { success: false, error: error_9 instanceof Error ? error_9.message : 'Failed to get directory tree' }];
                case 4: return [2 /*return*/];
            }
        });
    }); });
    // Ripgrep handler - raw interface to ripgrep
    rpcHandlerManager.registerHandler('ripgrep', function (data, _signal) { return __awaiter(_this, void 0, void 0, function () {
        var cwd, validation, result, error_11;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.logger.debug('Ripgrep request with args:', data.args, 'cwd:', data.cwd);
                    cwd = workingDirectory;
                    if (data.cwd) {
                        validation = (0, pathSecurity_1.validatePath)(data.cwd, workingDirectory);
                        if (!validation.valid) {
                            return [2 /*return*/, {
                                    success: false,
                                    error: validation.error || 'Invalid working directory path'
                                }];
                        }
                        cwd = validation.resolvedPath;
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, (0, index_1.run)(data.args, { cwd: cwd })];
                case 2:
                    result = _a.sent();
                    return [2 /*return*/, {
                            success: true,
                            exitCode: result.exitCode,
                            stdout: result.stdout.toString(),
                            stderr: result.stderr.toString()
                        }];
                case 3:
                    error_11 = _a.sent();
                    logger_1.logger.debug('Failed to run ripgrep:', error_11);
                    return [2 /*return*/, {
                            success: false,
                            error: error_11 instanceof Error ? error_11.message : 'Failed to run ripgrep'
                        }];
                case 4: return [2 /*return*/];
            }
        });
    }); });
    // Difftastic handler - raw interface to difftastic
    rpcHandlerManager.registerHandler('difftastic', function (data, _signal) { return __awaiter(_this, void 0, void 0, function () {
        var cwd, validation, result, error_12;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd);
                    cwd = workingDirectory;
                    if (data.cwd) {
                        validation = (0, pathSecurity_1.validatePath)(data.cwd, workingDirectory);
                        if (!validation.valid) {
                            return [2 /*return*/, {
                                    success: false,
                                    error: validation.error || 'Invalid working directory path'
                                }];
                        }
                        cwd = validation.resolvedPath;
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, (0, index_2.run)(data.args, { cwd: cwd })];
                case 2:
                    result = _a.sent();
                    return [2 /*return*/, {
                            success: true,
                            exitCode: result.exitCode,
                            stdout: result.stdout.toString(),
                            stderr: result.stderr.toString()
                        }];
                case 3:
                    error_12 = _a.sent();
                    logger_1.logger.debug('Failed to run difftastic:', error_12);
                    return [2 /*return*/, {
                            success: false,
                            error: error_12 instanceof Error ? error_12.message : 'Failed to run difftastic'
                        }];
                case 4: return [2 /*return*/];
            }
        });
    }); });
    // Start HTTP proxy handler - creates a proxy server to forward requests
    rpcHandlerManager.registerHandler('startProxy', function (data, _signal) { return __awaiter(_this, void 0, void 0, function () {
        var targetUrl, proxy, proxyId, error_13;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.logger.debug('Start proxy request for target:', data.target);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    targetUrl = new URL(data.target);
                    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
                        return [2 /*return*/, {
                                success: false,
                                error: 'Target must be an HTTP or HTTPS URL'
                            }];
                    }
                    return [4 /*yield*/, (0, index_3.startHTTPDirectProxy)({
                            target: data.target,
                            verbose: data.verbose
                        })];
                case 2:
                    proxy = _a.sent();
                    proxyId = "proxy_".concat(Date.now(), "_").concat(Math.random().toString(36).substring(2, 8));
                    // Track the running proxy
                    runningProxies.set(proxyId, { proxy: proxy, target: data.target });
                    logger_1.logger.debug("Started proxy ".concat(proxyId, " at ").concat(proxy.url, " -> ").concat(data.target));
                    return [2 /*return*/, {
                            success: true,
                            proxyId: proxyId,
                            url: proxy.url
                        }];
                case 3:
                    error_13 = _a.sent();
                    logger_1.logger.debug('Failed to start proxy:', error_13);
                    return [2 /*return*/, {
                            success: false,
                            error: error_13 instanceof Error ? error_13.message : 'Failed to start proxy'
                        }];
                case 4: return [2 /*return*/];
            }
        });
    }); });
    // Stop HTTP proxy handler - stops a running proxy by ID
    rpcHandlerManager.registerHandler('stopProxy', function (data, _signal) { return __awaiter(_this, void 0, void 0, function () {
        var proxyInfo, error_14;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.logger.debug('Stop proxy request for:', data.proxyId);
                    proxyInfo = runningProxies.get(data.proxyId);
                    if (!proxyInfo) {
                        return [2 /*return*/, {
                                success: false,
                                error: "Proxy not found: ".concat(data.proxyId)
                            }];
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, proxyInfo.proxy.close()];
                case 2:
                    _a.sent();
                    runningProxies.delete(data.proxyId);
                    logger_1.logger.debug("Stopped proxy ".concat(data.proxyId));
                    return [2 /*return*/, { success: true }];
                case 3:
                    error_14 = _a.sent();
                    logger_1.logger.debug('Failed to stop proxy:', error_14);
                    return [2 /*return*/, {
                            success: false,
                            error: error_14 instanceof Error ? error_14.message : 'Failed to stop proxy'
                        }];
                case 4: return [2 /*return*/];
            }
        });
    }); });
    // List running proxies handler
    rpcHandlerManager.registerHandler('listProxies', function (_data, _signal) { return __awaiter(_this, void 0, void 0, function () {
        var proxies;
        return __generator(this, function (_a) {
            logger_1.logger.debug('List proxies request');
            proxies = Array.from(runningProxies.entries()).map(function (_a) {
                var id = _a[0], info = _a[1];
                return ({
                    id: id,
                    url: info.proxy.url,
                    target: info.target
                });
            });
            return [2 /*return*/, {
                    success: true,
                    proxies: proxies
                }];
        });
    }); });
    // Get allowed commands handler - returns the command allowlist for UI display
    // HAP-635: Enables mobile app to show users which bash commands are permitted
    rpcHandlerManager.registerHandler('getAllowedCommands', function (_data, _signal) { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            logger_1.logger.debug('Get allowed commands request');
            return [2 /*return*/, {
                    success: true,
                    commands: pathSecurity_1.ALLOWED_COMMANDS
                }];
        });
    }); });
}
