/**
 * Tests for browser utility functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openBrowser } from './browser'

// Mock the open package
vi.mock('open', () => ({
  default: vi.fn()
}))

describe('openBrowser', () => {
  let originalStdoutIsTTY: boolean | undefined
  let originalCI: string | undefined
  let originalHeadless: string | undefined

  beforeEach(() => {
    // Save original values
    originalStdoutIsTTY = process.stdout.isTTY
    originalCI = process.env.CI
    originalHeadless = process.env.HEADLESS

    // Reset mocks
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Restore original values
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true
    })

    if (originalCI !== undefined) {
      process.env.CI = originalCI
    } else {
      delete process.env.CI
    }

    if (originalHeadless !== undefined) {
      process.env.HEADLESS = originalHeadless
    } else {
      delete process.env.HEADLESS
    }
  })

  describe('headless environment detection', () => {
    it('should return false when not in TTY', async () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
        configurable: true
      })
      delete process.env.CI
      delete process.env.HEADLESS

      const result = await openBrowser('https://example.com')

      expect(result).toBe(false)
    })

    it('should return false when CI environment variable is set', async () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true,
        configurable: true
      })
      process.env.CI = 'true'
      delete process.env.HEADLESS

      const result = await openBrowser('https://example.com')

      expect(result).toBe(false)
    })

    it('should return false when HEADLESS environment variable is set', async () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true,
        configurable: true
      })
      delete process.env.CI
      process.env.HEADLESS = '1'

      const result = await openBrowser('https://example.com')

      expect(result).toBe(false)
    })
  })

  describe('browser opening', () => {
    it('should call open with the URL when in TTY environment', async () => {
      const open = (await import('open')).default as ReturnType<typeof vi.fn>
      open.mockResolvedValue(undefined)

      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true,
        configurable: true
      })
      delete process.env.CI
      delete process.env.HEADLESS

      const result = await openBrowser('https://example.com')

      expect(result).toBe(true)
      expect(open).toHaveBeenCalledWith('https://example.com')
    })

    it('should return false and not throw when open fails', async () => {
      const open = (await import('open')).default as ReturnType<typeof vi.fn>
      open.mockRejectedValue(new Error('Failed to open browser'))

      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true,
        configurable: true
      })
      delete process.env.CI
      delete process.env.HEADLESS

      const result = await openBrowser('https://example.com')

      expect(result).toBe(false)
    })
  })
})
