/**
 * Main query implementation for Claude Code SDK
 * Handles spawning Claude process and managing message streams
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { Stream } from './stream'
import {
    type QueryOptions,
    type QueryPrompt,
    type SDKMessage,
    type ControlResponseHandler,
    type SDKControlRequest,
    type ControlRequest,
    type SDKControlResponse,
    type CanCallToolCallback,
    type CanUseToolControlRequest,
    type CanUseToolControlResponse,
    type ControlCancelRequest,
    type PermissionResult,
    AbortError
} from './types'
import { getDefaultClaudeCodePath, getCleanEnv, logDebug, streamToStdin } from './utils'
import type { Writable } from 'node:stream'
import { logger } from '@/ui/logger'
import { AppError, ErrorCodes } from '@/utils/errors'
import { parseJsonWithContext, JsonParseError } from '@/claude/types'

/**
 * Query class manages Claude Code process interaction
 */
export class Query implements AsyncIterableIterator<SDKMessage>, AsyncDisposable {
    private pendingControlResponses = new Map<string, ControlResponseHandler>()
    private cancelControllers = new Map<string, AbortController>()
    private sdkMessages: AsyncIterableIterator<SDKMessage>
    private inputStream: Stream<SDKMessage>
    private canCallTool?: CanCallToolCallback
    private isDisposed = false

    constructor(
        private childStdin: Writable | null,
        private childStdout: NodeJS.ReadableStream,
        private processExitPromise: Promise<void>,
        canCallTool?: CanCallToolCallback
    ) {
        this.canCallTool = canCallTool
        // Pass cleanup callback to inputStream for early termination handling
        this.inputStream = new Stream<SDKMessage>(() => this.cleanup())
        this.readMessages()
        this.sdkMessages = this.readSdkMessages()
    }

    /**
     * Set an error on the stream
     */
    setError(error: Error): void {
        this.inputStream.error(error)
    }

    /**
     * AsyncIterableIterator implementation
     */
    next(...args: [] | [undefined]): Promise<IteratorResult<SDKMessage>> {
        return this.sdkMessages.next(...args)
    }

    return(value?: unknown): Promise<IteratorResult<SDKMessage>> {
        if (this.sdkMessages.return) {
            return this.sdkMessages.return(value)
        }
        return Promise.resolve({ done: true, value: undefined })
    }

    throw(e?: unknown): Promise<IteratorResult<SDKMessage>> {
        if (this.sdkMessages.throw) {
            return this.sdkMessages.throw(e)
        }
        return Promise.reject(e)
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
        return this.sdkMessages
    }

    /**
     * Read messages from Claude process stdout
     */
    private async readMessages(): Promise<void> {
        const rl = createInterface({ input: this.childStdout })

        try {
            for await (const line of rl) {
                if (line.trim()) {
                    try {
                        const message = parseJsonWithContext<SDKMessage | SDKControlResponse>(line, {
                            context: 'SDK message',
                            logger
                        })

                        if (message.type === 'control_response') {
                            const controlResponse = message as SDKControlResponse
                            const handler = this.pendingControlResponses.get(controlResponse.response.request_id)
                            if (handler) {
                                handler(controlResponse.response)
                            }
                            continue
                        } else if (message.type === 'control_request') {
                            await this.handleControlRequest(message as unknown as CanUseToolControlRequest)
                            continue
                        } else if (message.type === 'control_cancel_request') {
                            this.handleControlCancelRequest(message as unknown as ControlCancelRequest)
                            continue
                        }

                        this.inputStream.enqueue(message)
                    } catch (e) {
                        // JsonParseError already logged with context, just log summary
                        if (e instanceof JsonParseError) {
                            logger.debug(`[SDK_QUERY] Skipping malformed SDK message (length: ${e.inputLength})`)
                        } else {
                            logger.debug(`[SDK_QUERY] Error processing message: ${e}`)
                        }
                    }
                }
            }
            await this.processExitPromise
        } catch (error) {
            this.inputStream.error(error as Error)
        } finally {
            this.inputStream.done()
            this.cleanupControllers()
            rl.close()
        }
    }

    /**
     * Async generator for SDK messages
     * Uses try/finally to ensure cleanup on early termination (break, return, throw)
     */
    private async *readSdkMessages(): AsyncIterableIterator<SDKMessage> {
        try {
            for await (const message of this.inputStream) {
                yield message
            }
        } finally {
            // Cleanup runs on break, return, throw, or natural completion
            this.cleanup()
        }
    }

    /**
     * Send interrupt request to Claude
     */
    async interrupt(): Promise<void> {
        if (!this.childStdin) {
            throw new AppError(ErrorCodes.INVALID_INPUT, 'Interrupt requires --input-format stream-json')
        }

        await this.request({
            subtype: 'interrupt'
        }, this.childStdin)
    }

    /**
     * Send control request to Claude process
     */
    private request(request: ControlRequest, childStdin: Writable): Promise<SDKControlResponse['response']> {
        const requestId = Math.random().toString(36).substring(2, 15)
        const sdkRequest: SDKControlRequest = {
            request_id: requestId,
            type: 'control_request',
            request
        }

        return new Promise((resolve, reject) => {
            this.pendingControlResponses.set(requestId, (response) => {
                if (response.subtype === 'success') {
                    resolve(response)
                } else {
                    reject(new Error(response.error))
                }
            })

            childStdin.write(JSON.stringify(sdkRequest) + '\n')
        })
    }

    /**
     * Handle incoming control requests for tool permissions
     * Replicates the exact logic from the SDK's handleControlRequest method
     */
    private async handleControlRequest(request: CanUseToolControlRequest): Promise<void> {
        if (!this.childStdin) {
            logDebug('Cannot handle control request - no stdin available')
            return
        }

        const controller = new AbortController()
        this.cancelControllers.set(request.request_id, controller)

        try {
            const response = await this.processControlRequest(request, controller.signal)
            const controlResponse: CanUseToolControlResponse = {
                type: 'control_response',
                response: {
                    subtype: 'success',
                    request_id: request.request_id,
                    response
                }
            }
            this.childStdin.write(JSON.stringify(controlResponse) + '\n')
        } catch (error) {
            const controlErrorResponse: CanUseToolControlResponse = {
                type: 'control_response',
                response: {
                    subtype: 'error',
                    request_id: request.request_id,
                    error: error instanceof Error ? error.message : String(error)
                }
            }
            this.childStdin.write(JSON.stringify(controlErrorResponse) + '\n')
        } finally {
            this.cancelControllers.delete(request.request_id)
        }
    }

    /**
     * Handle control cancel requests
     * Replicates the exact logic from the SDK's handleControlCancelRequest method
     */
    private handleControlCancelRequest(request: ControlCancelRequest): void {
        const controller = this.cancelControllers.get(request.request_id)
        if (controller) {
            controller.abort()
            this.cancelControllers.delete(request.request_id)
        }
    }

    /**
     * Process control requests based on subtype
     * Replicates the exact logic from the SDK's processControlRequest method
     */
    private async processControlRequest(request: CanUseToolControlRequest, signal: AbortSignal): Promise<PermissionResult> {
        if (request.request.subtype === 'can_use_tool') {
            if (!this.canCallTool) {
                throw new AppError(ErrorCodes.INVALID_INPUT, 'canCallTool callback is not provided.')
            }
            return this.canCallTool(request.request.tool_name, request.request.input, {
                signal
            })
        }

        throw new AppError(ErrorCodes.UNSUPPORTED_OPERATION, 'Unsupported control request subtype: ' + request.request.subtype)
    }

    /**
     * Cleanup method to abort all pending control requests
     */
    private cleanupControllers(): void {
        for (const [requestId, controller] of this.cancelControllers.entries()) {
            controller.abort()
            this.cancelControllers.delete(requestId)
        }
    }

    /**
     * Main cleanup method for resource management
     * Called on early termination (break/return/throw) or natural completion
     * Safe to call multiple times (idempotent)
     */
    private cleanup(): void {
        if (this.isDisposed) {
            return
        }
        this.isDisposed = true
        this.cleanupControllers()
        this.pendingControlResponses.clear()
    }

    /**
     * Implements AsyncDisposable for modern async resource management
     * Enables usage with `await using query = ...` syntax
     */
    async [Symbol.asyncDispose](): Promise<void> {
        this.cleanup()
        // Ensure inputStream is properly closed
        await this.inputStream.return()
    }
}

/**
 * Main query function to interact with Claude Code
 */
export function query(config: {
    prompt: QueryPrompt
    options?: QueryOptions
}): Query {
    const {
        prompt,
        options: {
            allowedTools = [],
            appendSystemPrompt,
            customSystemPrompt,
            cwd,
            disallowedTools = [],
            executable = 'node',
            executableArgs = [],
            maxTurns,
            mcpServers,
            pathToClaudeCodeExecutable = getDefaultClaudeCodePath(),
            permissionMode = 'default',
            continue: continueConversation,
            resume,
            model,
            fallbackModel,
            strictMcpConfig,
            canCallTool,
            settingsPath
        } = {}
    } = config

    // Set entrypoint if not already set
    if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
        process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    }

    // Build command arguments
    const args = ['--output-format', 'stream-json', '--verbose']

    if (customSystemPrompt) args.push('--system-prompt', customSystemPrompt)
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt)
    if (maxTurns) args.push('--max-turns', maxTurns.toString())
    if (model) args.push('--model', model)
    if (canCallTool) {
        if (typeof prompt === 'string') {
            throw new AppError(ErrorCodes.INVALID_INPUT, 'canCallTool callback requires --input-format stream-json. Please set prompt as an AsyncIterable.')
        }
        args.push('--permission-prompt-tool', 'stdio')
    }
    if (continueConversation) args.push('--continue')
    if (resume) args.push('--resume', resume)
    if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','))
    if (disallowedTools.length > 0) args.push('--disallowedTools', disallowedTools.join(','))
    if (mcpServers && Object.keys(mcpServers).length > 0) {
        args.push('--mcp-config', JSON.stringify({ mcpServers }))
    }
    if (strictMcpConfig) args.push('--strict-mcp-config')
    if (permissionMode) args.push('--permission-mode', permissionMode)
    if (settingsPath) args.push('--settings', settingsPath)

    if (fallbackModel) {
        if (model && fallbackModel === model) {
            throw new AppError(ErrorCodes.INVALID_INPUT, 'Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.')
        }
        args.push('--fallback-model', fallbackModel)
    }

    // Handle prompt input
    if (typeof prompt === 'string') {
        args.push('--print', prompt.trim())
    } else {
        args.push('--input-format', 'stream-json')
    }

    // Determine how to spawn Claude Code
    // - If it's a .js/.cjs file → spawn('node', [path, ...args])
    // - If it's just 'claude' command → spawn('claude', args) with shell on Windows
    // - If it's a full path to binary → spawn(path, args)
    const isJsFile = pathToClaudeCodeExecutable.endsWith('.js') || pathToClaudeCodeExecutable.endsWith('.cjs')
    const isCommandOnly = pathToClaudeCodeExecutable === 'claude'
    
    // Validate executable path (skip for command-only mode)
    if (!isCommandOnly && !existsSync(pathToClaudeCodeExecutable)) {
        throw new ReferenceError(`Claude Code executable not found at ${pathToClaudeCodeExecutable}. Is options.pathToClaudeCodeExecutable set?`)
    }

    const spawnCommand = isJsFile ? executable : pathToClaudeCodeExecutable
    const spawnArgs = isJsFile 
        ? [...executableArgs, pathToClaudeCodeExecutable, ...args]
        : args

    // Spawn Claude Code process
    // Use clean env for global claude to avoid local node_modules/.bin taking precedence
    const spawnEnv = isCommandOnly ? getCleanEnv() : process.env
    logDebug(`Spawning Claude Code process: ${spawnCommand} ${spawnArgs.join(' ')} (using ${isCommandOnly ? 'clean' : 'normal'} env)`)

    const child = spawn(spawnCommand, spawnArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: config.options?.abort,
        env: spawnEnv,
        // Use shell on Windows for global binaries and command-only mode
        shell: !isJsFile && process.platform === 'win32'
    }) as ChildProcessWithoutNullStreams

    // Add timeout to escalate to SIGKILL if child ignores SIGTERM
    // This prevents zombie processes when the child has a SIGTERM handler that doesn't exit
    let killTimeout: NodeJS.Timeout | undefined
    // Declare setKillTimeout at function scope so we can remove the listener in cleanup
    // (fixes listener accumulation if same AbortSignal is reused across query() calls)
    let setKillTimeout: (() => void) | undefined
    let listenerAdded = false
    if (config.options?.abort) {
        setKillTimeout = () => {
            killTimeout = setTimeout(() => {
                // Check if process is still alive (exitCode/signalCode are null until process exits)
                if (child.exitCode === null && child.signalCode === null) {
                    logDebug('[SDK Query] Child did not respond to SIGTERM, sending SIGKILL')
                    child.kill('SIGKILL')
                }
            }, 5000) // 5 second grace period before SIGKILL
        }

        // In Node.js, addEventListener doesn't fire for already-aborted signals
        // so we need to check and set up the timeout immediately in that case
        if (config.options.abort.aborted) {
            setKillTimeout()
        } else {
            config.options.abort.addEventListener('abort', setKillTimeout)
            listenerAdded = true
        }
    }

    // Clear kill timeout when child exits (whether via SIGTERM or otherwise)
    child.on('exit', () => {
        if (killTimeout) {
            clearTimeout(killTimeout)
            killTimeout = undefined
        }
    })

    // Handle stdin
    let childStdin: Writable | null = null
    if (typeof prompt === 'string') {
        child.stdin.end()
    } else {
        streamToStdin(prompt, child.stdin, config.options?.abort)
        childStdin = child.stdin
    }

    // Handle stderr in debug mode
    if (process.env.DEBUG) {
        child.stderr.on('data', (data) => {
            console.error('Claude Code stderr:', data.toString())
        })
    }

    // Setup cleanup
    const cleanup = () => {
        if (!child.killed) {
            child.kill('SIGTERM')
        }
    }

    // Note: spawn() already handles abort via its signal option (line ~330)
    // Only register for process exit (not abort - that would cause double cleanup)
    // Use separate exitHandler reference so we can remove it later (prevents handler accumulation)
    const exitHandler = () => cleanup()
    process.on('exit', exitHandler)

    // Declare query before processExitPromise to avoid TDZ issues
    // (close event may fire before Query construction if child exits immediately)
    let query: Query | undefined

    // Handle process exit
    const processExitPromise = new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
            if (config.options?.abort?.aborted) {
                const error = new AbortError('Claude Code process aborted by user')
                if (query) {
                    query.setError(error)
                } else {
                    reject(error)
                }
                return
            }
            if (code !== 0) {
                const error = new Error(`Claude Code process exited with code ${code}`)
                if (query) {
                    query.setError(error)
                } else {
                    reject(error)
                }
                return
            }
            resolve()
        })
    })

    // Create query instance
    query = new Query(childStdin, child.stdout, processExitPromise, canCallTool)

    // Handle process errors
    child.on('error', (error) => {
        const err = config.options?.abort?.aborted
            ? new AbortError('Claude Code process aborted by user')
            : new Error(`Failed to spawn Claude Code process: ${error.message}`)

        // query should always be defined here since error events fire after spawn,
        // but check defensively to match the pattern used in close handler
        if (query) {
            query.setError(err)
        }
    })

    // Cleanup on exit
    processExitPromise.finally(() => {
        cleanup()
        process.removeListener('exit', exitHandler)  // Remove handler to prevent accumulation
        // Remove abort listener to prevent accumulation if AbortSignal is reused (HAP-173)
        // Only remove if we actually added it (not if signal was already aborted)
        if (listenerAdded && config.options?.abort && setKillTimeout) {
            config.options.abort.removeEventListener('abort', setKillTimeout)
        }
        if (process.env.CLAUDE_SDK_MCP_SERVERS) {
            delete process.env.CLAUDE_SDK_MCP_SERVERS
        }
    })

    return query
}