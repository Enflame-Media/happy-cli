/**
 * Tests for claudeLocal SIGKILL escalation
 *
 * These tests verify that when a child process ignores SIGTERM,
 * we escalate to SIGKILL after 5 seconds to prevent zombie processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * Mock child process for testing SIGKILL escalation logic.
 * This mimics the relevant parts of ChildProcess without the readonly constraints.
 */
interface MockChildProcess extends EventEmitter {
    killed: boolean
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill: (signal?: string) => boolean
    stdio: (null)[]
    pid: number
}

function createMockChild(): MockChildProcess {
    const emitter = new EventEmitter()
    return Object.assign(emitter, {
        killed: false,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(function(this: MockChildProcess, signal?: string) {
            if (signal === 'SIGKILL') {
                this.killed = true
            }
            return true
        }),
        stdio: [null, null, null, null],
        pid: 12345
    }) as MockChildProcess
}

describe('claudeLocal SIGKILL escalation', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('should send SIGKILL if child does not exit within 5 seconds of abort', async () => {
        // Create a mock child process that ignores SIGTERM
        const mockChild = createMockChild()

        // Simulate the abort signal setup (mirrors claudeLocal.ts implementation)
        const abortController = new AbortController()
        let killTimeout: NodeJS.Timeout | undefined

        abortController.signal.addEventListener('abort', () => {
            killTimeout = setTimeout(() => {
                // Check if process is still alive (exitCode/signalCode are null until process exits)
                if (mockChild.exitCode === null && mockChild.signalCode === null) {
                    mockChild.kill('SIGKILL')
                }
            }, 5000)
        })

        mockChild.on('exit', () => {
            if (killTimeout) {
                clearTimeout(killTimeout)
                killTimeout = undefined
            }
        })

        // Trigger abort (simulates user pressing Ctrl+C or remote abort)
        abortController.abort()

        // Child hasn't exited yet - should not have SIGKILL yet
        expect(mockChild.kill).not.toHaveBeenCalled()

        // Advance time by 4 seconds - still no SIGKILL
        await vi.advanceTimersByTimeAsync(4000)
        expect(mockChild.kill).not.toHaveBeenCalled()

        // Advance to 5 seconds - should trigger SIGKILL
        await vi.advanceTimersByTimeAsync(1000)
        expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL')
        expect(mockChild.killed).toBe(true)
    })

    it('should clear timeout if child exits before 5 seconds', async () => {
        const mockChild = createMockChild()

        const abortController = new AbortController()
        let killTimeout: NodeJS.Timeout | undefined

        abortController.signal.addEventListener('abort', () => {
            killTimeout = setTimeout(() => {
                // Check if process is still alive (exitCode/signalCode are null until process exits)
                if (mockChild.exitCode === null && mockChild.signalCode === null) {
                    mockChild.kill('SIGKILL')
                }
            }, 5000)
        })

        mockChild.on('exit', () => {
            if (killTimeout) {
                clearTimeout(killTimeout)
                killTimeout = undefined
            }
        })

        // Trigger abort
        abortController.abort()

        // Child exits after 2 seconds (responds to SIGTERM from spawn's signal option)
        await vi.advanceTimersByTimeAsync(2000)
        mockChild.exitCode = 0
        mockChild.signalCode = 'SIGTERM'
        mockChild.emit('exit', 0, 'SIGTERM')

        // Timeout should be cleared
        expect(killTimeout).toBeUndefined()

        // Advance time past 5 seconds - no SIGKILL should be sent
        await vi.advanceTimersByTimeAsync(5000)

        // kill() should never have been called (SIGTERM was handled by spawn's signal option)
        expect(mockChild.kill).not.toHaveBeenCalled()
    })

    it('should not send SIGKILL if child exits normally before abort', async () => {
        const mockChild = createMockChild()

        const abortController = new AbortController()
        let killTimeout: NodeJS.Timeout | undefined

        abortController.signal.addEventListener('abort', () => {
            killTimeout = setTimeout(() => {
                // Check if process is still alive (exitCode/signalCode are null until process exits)
                if (mockChild.exitCode === null && mockChild.signalCode === null) {
                    mockChild.kill('SIGKILL')
                }
            }, 5000)
        })

        mockChild.on('exit', () => {
            if (killTimeout) {
                clearTimeout(killTimeout)
                killTimeout = undefined
            }
        })

        // Child exits normally (no abort)
        mockChild.exitCode = 0
        mockChild.emit('exit', 0, null)

        // Now abort happens after exit
        abortController.abort()

        // Advance all timers
        await vi.advanceTimersByTimeAsync(10000)

        // SIGKILL should not be sent because child.killed is true
        expect(mockChild.kill).not.toHaveBeenCalled()
    })

    it('should handle already-aborted signal gracefully', async () => {
        const mockChild = createMockChild()

        // Create an already-aborted signal
        const abortController = new AbortController()
        abortController.abort() // Abort before adding listener

        let killTimeout: NodeJS.Timeout | undefined

        // Mirrors the implementation pattern: check .aborted before addEventListener
        // In Node.js, addEventListener doesn't fire for already-aborted signals
        const setKillTimeout = () => {
            killTimeout = setTimeout(() => {
                // Check if process is still alive (exitCode/signalCode are null until process exits)
                if (mockChild.exitCode === null && mockChild.signalCode === null) {
                    mockChild.kill('SIGKILL')
                }
            }, 5000)
        }

        if (abortController.signal.aborted) {
            setKillTimeout()
        } else {
            abortController.signal.addEventListener('abort', setKillTimeout)
        }

        mockChild.on('exit', () => {
            if (killTimeout) {
                clearTimeout(killTimeout)
                killTimeout = undefined
            }
        })

        // Timeout should have been set immediately since signal was already aborted
        expect(killTimeout).toBeDefined()

        // Advance 5 seconds - SIGKILL should fire
        await vi.advanceTimersByTimeAsync(5000)
        expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL')
    })
})
