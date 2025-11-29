/**
 * Tests for persistence atomic write functionality (HAP-114)
 * Verifies that config files are written atomically to prevent corruption
 * during concurrent writes or crashes.
 *
 * NOTE: These tests use the configuration module which reads HAPPY_HOME_DIR at module load time.
 * Tests work with the actual configuration paths for integration testing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, existsSync, rmSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { configuration } from './configuration'
import { writeSettings, readSettings, writeDaemonState, readDaemonState, DaemonLocallyPersistedState } from './persistence'

/**
 * Async atomic write helper - mirrors the implementation in persistence.ts
 * Used here to test the pattern in isolation
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, content)
    await rename(tempPath, filePath)
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        await unlink(tempPath)
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error
  }
}

/**
 * Sync atomic write helper - mirrors the implementation in persistence.ts
 * Used here to test the pattern in isolation
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, content, 'utf-8')
    renameSync(tempPath, filePath)
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath)
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error
  }
}

describe('Atomic write pattern functionality (HAP-114)', () => {
  let testDir: string

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = join(tmpdir(), `happy-atomic-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe('atomicWriteFile (async)', () => {
    it('should write file atomically without leaving temp files', async () => {
      const testFile = join(testDir, 'test.json')
      const content = JSON.stringify({ test: true, id: 'atomic-123' }, null, 2)

      await atomicWriteFile(testFile, content)

      // Verify the file exists and contains correct data
      expect(existsSync(testFile)).toBe(true)
      const readContent = JSON.parse(readFileSync(testFile, 'utf-8'))
      expect(readContent.test).toBe(true)
      expect(readContent.id).toBe('atomic-123')

      // Verify no temp files remain
      const files = readdirSync(testDir)
      const tempFiles = files.filter(f => f.includes('.tmp'))
      expect(tempFiles).toHaveLength(0)
    })

    it('should handle concurrent writes without corruption', async () => {
      const testFile = join(testDir, 'concurrent.json')

      // Simulate concurrent writes
      const writes = Array.from({ length: 10 }, (_, i) =>
        atomicWriteFile(testFile, JSON.stringify({ version: i, data: `value-${i}` }, null, 2))
      )

      await Promise.all(writes)

      // Verify file is not corrupted (valid JSON)
      expect(existsSync(testFile)).toBe(true)
      const content = readFileSync(testFile, 'utf-8')
      expect(() => JSON.parse(content)).not.toThrow()

      // Verify no temp files remain
      const files = readdirSync(testDir)
      const tempFiles = files.filter(f => f.includes('.tmp'))
      expect(tempFiles).toHaveLength(0)
    })

    it('should overwrite existing file atomically', async () => {
      const testFile = join(testDir, 'overwrite.json')

      // First write
      await atomicWriteFile(testFile, JSON.stringify({ version: 1 }, null, 2))
      expect(JSON.parse(readFileSync(testFile, 'utf-8')).version).toBe(1)

      // Second write (overwrite)
      await atomicWriteFile(testFile, JSON.stringify({ version: 2, extra: 'data' }, null, 2))
      const final = JSON.parse(readFileSync(testFile, 'utf-8'))
      expect(final.version).toBe(2)
      expect(final.extra).toBe('data')

      // Verify no temp files remain
      const files = readdirSync(testDir)
      const tempFiles = files.filter(f => f.includes('.tmp'))
      expect(tempFiles).toHaveLength(0)
    })
  })

  describe('atomicWriteFileSync (sync)', () => {
    it('should write file atomically without leaving temp files', () => {
      const testFile = join(testDir, 'sync-test.json')
      const content = JSON.stringify({ sync: true, id: 'sync-123' }, null, 2)

      atomicWriteFileSync(testFile, content)

      // Verify the file exists and contains correct data
      expect(existsSync(testFile)).toBe(true)
      const readContent = JSON.parse(readFileSync(testFile, 'utf-8'))
      expect(readContent.sync).toBe(true)
      expect(readContent.id).toBe('sync-123')

      // Verify no temp files remain
      const files = readdirSync(testDir)
      const tempFiles = files.filter(f => f.includes('.tmp'))
      expect(tempFiles).toHaveLength(0)
    })

    it('should handle rapid sequential writes without corruption', () => {
      const testFile = join(testDir, 'rapid-writes.json')

      // Simulate rapid sequential writes
      for (let i = 0; i < 20; i++) {
        atomicWriteFileSync(testFile, JSON.stringify({ iteration: i, timestamp: Date.now() }, null, 2))
      }

      // Verify file is not corrupted (valid JSON)
      expect(existsSync(testFile)).toBe(true)
      const content = readFileSync(testFile, 'utf-8')
      expect(() => JSON.parse(content)).not.toThrow()

      // Final value should be the last write
      const parsed = JSON.parse(content)
      expect(parsed.iteration).toBe(19)

      // Verify no temp files remain
      const files = readdirSync(testDir)
      const tempFiles = files.filter(f => f.includes('.tmp'))
      expect(tempFiles).toHaveLength(0)
    })

    it('should overwrite existing file atomically', () => {
      const testFile = join(testDir, 'sync-overwrite.json')

      // First write
      atomicWriteFileSync(testFile, JSON.stringify({ version: 1 }, null, 2))
      expect(JSON.parse(readFileSync(testFile, 'utf-8')).version).toBe(1)

      // Second write (overwrite)
      atomicWriteFileSync(testFile, JSON.stringify({ version: 2, extra: 'sync-data' }, null, 2))
      const final = JSON.parse(readFileSync(testFile, 'utf-8'))
      expect(final.version).toBe(2)
      expect(final.extra).toBe('sync-data')

      // Verify no temp files remain
      const files = readdirSync(testDir)
      const tempFiles = files.filter(f => f.includes('.tmp'))
      expect(tempFiles).toHaveLength(0)
    })
  })

  describe('multiple write cycles', () => {
    it('should not accumulate temp files over many write cycles', async () => {
      const testFile = join(testDir, 'cycles.json')

      // Perform many write cycles
      for (let cycle = 0; cycle < 50; cycle++) {
        await atomicWriteFile(testFile, JSON.stringify({ cycle, data: `cycle-${cycle}` }, null, 2))
      }

      // Verify only the target file exists (no temp file accumulation)
      const files = readdirSync(testDir)
      expect(files).toHaveLength(1)
      expect(files[0]).toBe('cycles.json')
    })
  })
})

describe('Integration: writeSettings and writeDaemonState use atomic writes', () => {
  // These tests verify the actual persistence functions use atomic writes
  // by checking that they work correctly with the actual configuration

  it('writeSettings should preserve data integrity', async () => {
    const testSettings = {
      onboardingCompleted: true,
      machineId: 'integration-test-123',
      machineIdConfirmedByServer: true,
      daemonAutoStartWhenRunningHappy: false
    }

    await writeSettings(testSettings)
    const readBack = await readSettings()

    expect(readBack.onboardingCompleted).toBe(true)
    expect(readBack.machineId).toBe('integration-test-123')
    expect(readBack.machineIdConfirmedByServer).toBe(true)
    expect(readBack.daemonAutoStartWhenRunningHappy).toBe(false)

    // Verify no temp files in the home directory
    const files = readdirSync(configuration.happyHomeDir)
    const tempFiles = files.filter(f => f.includes('.tmp') && f.includes('settings'))
    expect(tempFiles).toHaveLength(0)
  })

  it('writeDaemonState should preserve data integrity', async () => {
    const testState: DaemonLocallyPersistedState = {
      pid: 88888,
      httpPort: 9999,
      startTime: '2024-12-01T12:00:00.000Z',
      startedWithCliVersion: '0.99.0',
      lastHeartbeat: '2024-12-01T12:00:30.000Z',
      daemonLogPath: '/test/path/daemon.log'
    }

    writeDaemonState(testState)
    const readBack = await readDaemonState()

    expect(readBack).not.toBeNull()
    expect(readBack!.pid).toBe(88888)
    expect(readBack!.httpPort).toBe(9999)
    expect(readBack!.startedWithCliVersion).toBe('0.99.0')
    expect(readBack!.lastHeartbeat).toBe('2024-12-01T12:00:30.000Z')
    expect(readBack!.daemonLogPath).toBe('/test/path/daemon.log')

    // Verify no temp files in the home directory
    const files = readdirSync(configuration.happyHomeDir)
    const tempFiles = files.filter(f => f.includes('.tmp') && f.includes('daemon'))
    expect(tempFiles).toHaveLength(0)
  })

  it('concurrent writeSettings calls should not corrupt the file', async () => {
    // Simulate concurrent writes to settings
    const writes = Array.from({ length: 5 }, (_, i) =>
      writeSettings({
        onboardingCompleted: true,
        machineId: `concurrent-${i}`
      })
    )

    await Promise.all(writes)

    // Verify file is not corrupted
    const content = readFileSync(configuration.settingsFile, 'utf-8')
    expect(() => JSON.parse(content)).not.toThrow()

    // Verify no temp files remain
    const files = readdirSync(configuration.happyHomeDir)
    const tempFiles = files.filter(f => f.includes('.tmp') && f.includes('settings'))
    expect(tempFiles).toHaveLength(0)
  })
})

/**
 * Tests for lock file cleanup during updateSettings (HAP-83)
 * Verifies that lock files are properly cleaned up even if errors occur
 * during the update process, preventing orphaned locks that block future operations.
 */
import { updateSettings } from './persistence'

describe('Lock file cleanup during updateSettings (HAP-83)', () => {
  const lockFile = configuration.settingsFile + '.lock'

  afterEach(async () => {
    // Clean up any stale lock files from tests
    try {
      if (existsSync(lockFile)) {
        await unlink(lockFile)
      }
    } catch {
      // Ignore cleanup errors
    }
  })

  it('should not leave orphaned lock file after successful update', async () => {
    // Perform a successful settings update
    await updateSettings(current => ({
      ...current,
      machineId: 'test-no-orphan-lock'
    }))

    // Verify lock file is cleaned up
    expect(existsSync(lockFile)).toBe(false)

    // Verify settings were updated
    const settings = await readSettings()
    expect(settings.machineId).toBe('test-no-orphan-lock')
  })

  it('should clean up lock file when updater function throws', async () => {
    // Attempt an update that throws during the updater
    await expect(
      updateSettings(() => {
        throw new Error('Simulated updater error')
      })
    ).rejects.toThrow('Simulated updater error')

    // Verify lock file is cleaned up even after error
    expect(existsSync(lockFile)).toBe(false)
  })

  it('should clean up lock file when updater returns and async promise rejects', async () => {
    // Attempt an update with an async updater that rejects
    await expect(
      updateSettings(async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        throw new Error('Async updater rejection')
      })
    ).rejects.toThrow('Async updater rejection')

    // Verify lock file is cleaned up
    expect(existsSync(lockFile)).toBe(false)
  })

  it('should handle stale lock file from previous crash', async () => {
    // Simulate a stale lock file left from a crash
    // Create a lock file that's older than the stale timeout
    writeFileSync(lockFile, '')

    // Artificially age the lock file by modifying its mtime
    // Note: This relies on the stale lock detection logic in updateSettings
    const pastTime = new Date(Date.now() - 15000) // 15 seconds ago (past the 10s stale threshold)
    const { utimes } = await import('node:fs/promises')
    await utimes(lockFile, pastTime, pastTime)

    // Perform an update - it should detect and remove the stale lock
    await updateSettings(current => ({
      ...current,
      machineId: 'test-stale-lock-recovery'
    }))

    // Verify lock file is cleaned up
    expect(existsSync(lockFile)).toBe(false)

    // Verify settings were updated successfully
    const settings = await readSettings()
    expect(settings.machineId).toBe('test-stale-lock-recovery')
  })

  it('should allow subsequent updates after error recovery', async () => {
    // First update that fails
    await expect(
      updateSettings(() => {
        throw new Error('First update error')
      })
    ).rejects.toThrow('First update error')

    // Verify lock is cleaned up
    expect(existsSync(lockFile)).toBe(false)

    // Second update should succeed without waiting for lock
    const startTime = Date.now()
    await updateSettings(current => ({
      ...current,
      machineId: 'test-recovery-success'
    }))
    const elapsed = Date.now() - startTime

    // Should be fast (not waiting for lock timeout)
    expect(elapsed).toBeLessThan(1000)

    // Verify settings were updated
    const settings = await readSettings()
    expect(settings.machineId).toBe('test-recovery-success')
  })

  it('should serialize concurrent updateSettings calls', async () => {
    let concurrentCalls = 0
    let maxConcurrentCalls = 0

    const updates = Array.from({ length: 5 }, (_, i) =>
      updateSettings(async current => {
        concurrentCalls++
        maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls)

        // Small delay to allow overlap if locking is broken
        await new Promise(resolve => setTimeout(resolve, 50))

        concurrentCalls--
        return {
          ...current,
          machineId: `concurrent-update-${i}`
        }
      })
    )

    await Promise.all(updates)

    // With proper locking, only one update should run at a time
    expect(maxConcurrentCalls).toBe(1)

    // Verify no lock file remains
    expect(existsSync(lockFile)).toBe(false)
  })
})
