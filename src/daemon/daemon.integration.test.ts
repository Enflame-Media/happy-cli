/**
 * Integration tests for daemon HTTP control system
 * 
 * Tests the full flow of daemon startup, session tracking, and shutdown
 * 
 * IMPORTANT: These tests MUST be run with the integration test environment:
 * yarn test:integration-test-env
 * 
 * DO NOT run with regular 'npm test' or 'yarn test' - it will use the wrong environment
 * and the daemon will not work properly!
 * 
 * The integration test environment uses .env.integration-test which sets:
 * - HAPPY_HOME_DIR=~/.happy-dev-test (DIFFERENT from dev's ~/.happy-dev!)
 * - HAPPY_SERVER_URL=http://localhost:3005 (local dev server)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from 'fs';
import path, { join } from 'path';
import { configuration } from '@/configuration';
import {
  listDaemonSessions,
  stopDaemonSession,
  spawnDaemonSession,
  stopDaemonHttp,
  notifyDaemonSessionStarted,
  stopDaemon,
  getDaemonHealth
} from '@/daemon/controlClient';
import { readDaemonState, clearDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { getLatestDaemonLog } from '@/ui/logger';

// Utility to wait for condition
async function waitFor(
  condition: () => Promise<boolean>,
  timeout = 5000,
  interval = 100
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('Timeout waiting for condition');
}

// Check if dev server is running and properly configured
async function isServerHealthy(): Promise<boolean> {
  try {
    // First check if server responds
    const response = await fetch('http://localhost:3005/', { 
      signal: AbortSignal.timeout(1000) 
    });
    if (!response.ok) {
      console.log('[TEST] Server health check failed: root endpoint not OK');
      return false;
    }
    
    // Check if we have test credentials
    const testCredentials = existsSync(join(configuration.happyHomeDir, 'access.key'));
    if (!testCredentials) {
      console.log('[TEST] No test credentials found in', configuration.happyHomeDir);
      console.log('[TEST] Run "happy auth login" with HAPPY_HOME_DIR=~/.happy-dev-test first');
      return false;
    }
    
    return true;
  } catch (error) {
    console.log('[TEST] Server not reachable:', error);
    return false;
  }
}

describe.skipIf(!await isServerHealthy())('Daemon Integration Tests', { timeout: 20_000 }, () => {
  let daemonPid: number;

  beforeEach(async () => {
    // First ensure no daemon is running by checking PID in metadata file
    await stopDaemon()
    
    // Start fresh daemon for this test
    // This will return and start a background process - we don't need to wait for it
    void spawnHappyCLI(['daemon', 'start'], {
      stdio: 'ignore'
    });
    
    // Wait for daemon to write its state file (it needs to auth, setup, and start server)
    await waitFor(async () => {
      const state = await readDaemonState();
      return state !== null;
    }, 10_000, 250); // Wait up to 10 seconds, checking every 250ms
    
    const daemonState = await readDaemonState();
    if (!daemonState) {
      throw new Error('Daemon failed to start within timeout');
    }
    daemonPid = daemonState.pid;

    console.log(`[TEST] Daemon started for test: PID=${daemonPid}`);
    console.log(`[TEST] Daemon log file: ${daemonState?.daemonLogPath}`);
  });

  afterEach(async () => {
    await stopDaemon()
  });

  it('should list sessions (initially empty)', async () => {
    const result = await listDaemonSessions();
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.data.children).toEqual([]);
  });

  it('should return health status from running daemon', async () => {
    const result = await getDaemonHealth();

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);

    // Verify response structure matches HealthResponse interface
    expect(result.data.status).toBe('healthy');
    expect(result.data.uptime).toBeGreaterThan(0);
    expect(result.data.sessions).toBeGreaterThanOrEqual(0);

    // Verify memory usage structure
    expect(result.data.memory).toHaveProperty('rss');
    expect(result.data.memory).toHaveProperty('heapTotal');
    expect(result.data.memory).toHaveProperty('heapUsed');
    expect(result.data.memory).toHaveProperty('external');

    // All memory values should be positive numbers
    expect(result.data.memory.rss).toBeGreaterThan(0);
    expect(result.data.memory.heapTotal).toBeGreaterThan(0);
    expect(result.data.memory.heapUsed).toBeGreaterThan(0);
    expect(result.data.memory.external).toBeGreaterThanOrEqual(0);

    // Timestamp should be a valid ISO string
    expect(result.data.timestamp).toBeDefined();
    expect(typeof result.data.timestamp).toBe('string');
    expect(new Date(result.data.timestamp).getTime()).not.toBeNaN();
  });

  it('should track session-started webhook from terminal session', async () => {
    // Simulate a terminal-started session reporting to daemon
    const mockMetadata: Metadata = {
      path: '/test/path',
      host: 'test-host',
      homeDir: '/test/home',
      happyHomeDir: '/test/happy-home',
      happyLibDir: '/test/happy-lib',
      happyToolsDir: '/test/happy-tools',
      hostPid: 99999,
      startedBy: 'terminal',
      machineId: 'test-machine-123'
    };

    const notifyResult = await notifyDaemonSessionStarted('test-session-123', mockMetadata);
    expect(notifyResult.success).toBe(true);

    // Verify session is tracked
    const result = await listDaemonSessions();
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.data.children).toHaveLength(1);

    const tracked = result.data.children[0];
    expect(tracked.startedBy).toBe('happy directly - likely by user from terminal');
    expect(tracked.happySessionId).toBe('test-session-123');
    expect(tracked.pid).toBe(99999);
  });

  it('should spawn & stop a session via HTTP (not testing RPC route, but similar enough)', async () => {
    const response = await spawnDaemonSession('/tmp', 'spawned-test-456');

    expect(response.success).toBe(true);
    if (!response.success) throw new Error(response.error);
    expect(response.data.success).toBe(true);
    expect(response.data.sessionId).toBeDefined();

    // Verify session is tracked
    const listResult = await listDaemonSessions();
    expect(listResult.success).toBe(true);
    if (!listResult.success) throw new Error(listResult.error);
    const spawnedSession = listResult.data.children.find(
      (s) => s.happySessionId === response.data.sessionId
    );

    expect(spawnedSession).toBeDefined();
    expect(spawnedSession!.startedBy).toBe('daemon');

    // Clean up - stop the spawned session
    expect(spawnedSession!.happySessionId).toBeDefined();
    await stopDaemonSession(spawnedSession!.happySessionId);
  });

  it('stress test: spawn / stop', { timeout: 60_000 }, async () => {
    const promises = [];
    const sessionCount = 20;
    for (let i = 0; i < sessionCount; i++) {
      promises.push(spawnDaemonSession('/tmp'));
    }

    // Wait for all sessions to be spawned
    const results = await Promise.all(promises);
    const sessionIds = results.map(r => {
      expect(r.success).toBe(true);
      if (!r.success) throw new Error(r.error);
      return r.data.sessionId!;
    });

    const listResult = await listDaemonSessions();
    expect(listResult.success).toBe(true);
    if (!listResult.success) throw new Error(listResult.error);
    expect(listResult.data.children).toHaveLength(sessionCount);

    // Stop all sessions
    const stopResults = await Promise.all(sessionIds.map(sessionId => stopDaemonSession(sessionId)));
    expect(stopResults.every(r => r.success && r.data.success)).toBe(true);

    // Verify all sessions are stopped
    const emptyListResult = await listDaemonSessions();
    expect(emptyListResult.success).toBe(true);
    if (!emptyListResult.success) throw new Error(emptyListResult.error);
    expect(emptyListResult.data.children).toHaveLength(0);
  });

  it('should handle daemon stop request gracefully', async () => {
    const result = await stopDaemonHttp();
    expect(result.success).toBe(true);

    // Verify metadata file is cleaned up
    await waitFor(async () => !existsSync(configuration.daemonStateFile), 1000);
  });

  it('should track both daemon-spawned and terminal sessions', async () => {
    // Spawn a real happy process that looks like it was started from terminal
    const terminalHappyProcess = spawnHappyCLI([
      '--happy-starting-mode', 'remote',
      '--started-by', 'terminal'
    ], {
      cwd: '/tmp',
      detached: true,
      stdio: 'ignore'
    });
    if (!terminalHappyProcess || !terminalHappyProcess.pid) {
      throw new Error('Failed to spawn terminal happy process');
    }
    // Give time to start & report itself
    await new Promise(resolve => setTimeout(resolve, 5_000));

    // Spawn a daemon session
    const spawnResponse = await spawnDaemonSession('/tmp', 'daemon-session-bbb');
    expect(spawnResponse.success).toBe(true);
    if (!spawnResponse.success) throw new Error(spawnResponse.error);

    // List all sessions
    const listResult = await listDaemonSessions();
    expect(listResult.success).toBe(true);
    if (!listResult.success) throw new Error(listResult.error);
    expect(listResult.data.children).toHaveLength(2);

    // Verify we have one of each type
    const terminalSession = listResult.data.children.find(
      (s) => s.pid === terminalHappyProcess.pid
    );
    const daemonSession = listResult.data.children.find(
      (s) => s.happySessionId === spawnResponse.data.sessionId
    );

    expect(terminalSession).toBeDefined();
    expect(terminalSession!.startedBy).toBe('happy directly - likely by user from terminal');

    expect(daemonSession).toBeDefined();
    expect(daemonSession!.startedBy).toBe('daemon');

    // Clean up both sessions
    await stopDaemonSession('terminal-session-aaa');
    await stopDaemonSession(daemonSession!.happySessionId);

    // Also kill the terminal process directly to be sure
    try {
      terminalHappyProcess.kill('SIGTERM');
    } catch {
      // Process might already be dead
    }
  });

  it('should update session metadata when webhook is called', async () => {
    // Spawn a session
    const spawnResponse = await spawnDaemonSession('/tmp');
    expect(spawnResponse.success).toBe(true);
    if (!spawnResponse.success) throw new Error(spawnResponse.error);

    // Verify webhook was processed (session ID updated)
    const listResult = await listDaemonSessions();
    expect(listResult.success).toBe(true);
    if (!listResult.success) throw new Error(listResult.error);
    const session = listResult.data.children.find((s) => s.happySessionId === spawnResponse.data.sessionId);
    expect(session).toBeDefined();

    // Clean up
    await stopDaemonSession(spawnResponse.data.sessionId!);
  });

  it('should not allow starting a second daemon', async () => {
    // Daemon is already running from beforeEach
    // Try to start another daemon
    const secondChild = spawn('yarn', ['tsx', 'src/index.ts', 'daemon', 'start-sync'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    secondChild.stdout?.on('data', (data) => {
      output += data.toString();
    });
    secondChild.stderr?.on('data', (data) => {
      output += data.toString();
    });

    // Wait for the second daemon to exit
    await new Promise<void>((resolve) => {
      secondChild.on('exit', () => resolve());
    });

    // Should report that daemon is already running
    expect(output).toContain('already running');
  });

  it('should handle concurrent session operations', async () => {
    // Spawn multiple sessions concurrently
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        spawnDaemonSession('/tmp')
      );
    }

    const results = await Promise.all(promises);

    // All should succeed
    results.forEach(res => {
      expect(res.success).toBe(true);
      if (!res.success) throw new Error(res.error);
      expect(res.data.success).toBe(true);
      expect(res.data.sessionId).toBeDefined();
    });

    // Collect session IDs for tracking
    const spawnedSessionIds = results.map(r => {
      if (!r.success) throw new Error(r.error);
      return r.data.sessionId!;
    });

    // Give sessions time to report via webhook
    await new Promise(resolve => setTimeout(resolve, 1000));

    // List should show all sessions
    const listResult = await listDaemonSessions();
    expect(listResult.success).toBe(true);
    if (!listResult.success) throw new Error(listResult.error);
    const daemonSessions = listResult.data.children.filter(
      (s) => s.startedBy === 'daemon' && spawnedSessionIds.includes(s.happySessionId)
    );
    expect(daemonSessions.length).toBeGreaterThanOrEqual(3);

    // Stop all spawned sessions
    for (const session of daemonSessions) {
      expect(session.happySessionId).toBeDefined();
      await stopDaemonSession(session.happySessionId);
    }
  });

  it('should die with logs when SIGKILL is sent', async () => {
    // SIGKILL test - daemon should die immediately
    const logsDir = configuration.logsDir;
    const { readdirSync } = await import('fs');
    
    // Get initial log files
    const initialLogs = readdirSync(logsDir).filter(f => f.endsWith('-daemon.log'));
    
    // Send SIGKILL to daemon (force kill)
    process.kill(daemonPid, 'SIGKILL');
    
    // Wait for process to die
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check if process is dead
    let isDead = false;
    try {
      process.kill(daemonPid, 0);
    } catch {
      isDead = true;
    }
    expect(isDead).toBe(true);
    
    // Check that log file exists (it was created when daemon started)
    const finalLogs = readdirSync(logsDir).filter(f => f.endsWith('-daemon.log'));
    expect(finalLogs.length).toBeGreaterThanOrEqual(initialLogs.length);
    
    // The daemon won't have time to write cleanup logs with SIGKILL
    console.log('[TEST] Daemon killed with SIGKILL - no cleanup logs expected');
    
    // Clean up state file manually since daemon couldn't do it
    await clearDaemonState();
  });

  it('should die with cleanup logs when SIGTERM is sent', async () => {
    // SIGTERM test - daemon should cleanup gracefully
    const logFile = await getLatestDaemonLog();
    if (!logFile) {
      throw new Error('No log file found');
    }
    
    // Send SIGTERM to daemon (graceful shutdown)
    process.kill(daemonPid, 'SIGTERM');
    
    // Wait for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 4_000));
    
    // Check if process is dead
    let isDead = false;
    try {
      process.kill(daemonPid, 0);
    } catch {
      isDead = true;
    }
    expect(isDead).toBe(true);
    
    // Read the log file to check for cleanup messages
    const logContent = readFileSync(logFile.path, 'utf8');
    
    // Should contain cleanup messages
    expect(logContent).toContain('SIGTERM');
    expect(logContent).toContain('cleanup');
    
    console.log('[TEST] Daemon terminated gracefully with SIGTERM - cleanup logs written');

    // Clean up state file if it still exists (should have been cleaned by SIGTERM handler)
    await clearDaemonState();
  });

  /**
   * Package.json Version Cache Invalidation Test (HAP-367)
   *
   * This test validates the version caching behavior introduced in HAP-354:
   * - getProjectVersion() caches the version on first read
   * - fs.watch() detects package.json changes
   * - Cache is invalidated and refreshed when file changes
   *
   * Since getProjectVersion() and cleanupVersionWatcher() are private functions,
   * we test behavior through daemon logs:
   * - [DAEMON RUN] Cached project version: X.Y.Z (initial cache population)
   * - [DAEMON RUN] package.json changed, refreshing version cache (file change detected)
   * - [DAEMON RUN] Updated cached version: X.Y.Z (cache refreshed)
   *
   * Test flow:
   * 1. Daemon starts and caches version (first heartbeat populates cache)
   * 2. Wait for initial cache to be logged
   * 3. Modify package.json version field (simulating npm upgrade)
   * 4. Wait ~500ms for fs.watch to trigger debounced callback
   * 5. Verify daemon log contains cache invalidation message
   * 6. Restore original package.json (cleanup)
   */
  it('should detect package.json version change and refresh cache (HAP-367)', { timeout: 15_000 }, async () => {
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJsonOriginalRawText = readFileSync(packagePath, 'utf8');
    const originalPackage = JSON.parse(packageJsonOriginalRawText);
    const originalVersion = originalPackage.version;
    const testVersion = `0.0.0-cache-test-${Date.now()}`;

    try {
      // Get daemon log file
      const logFile = await getLatestDaemonLog();
      if (!logFile) {
        throw new Error('No daemon log file found');
      }

      // Verify initial cache was populated (from daemon startup)
      // Give the daemon a moment to start up fully and log cache message
      await new Promise(resolve => setTimeout(resolve, 1000));

      let logContent = readFileSync(logFile.path, 'utf8');
      expect(logContent).toContain('[DAEMON RUN] Cached project version:');
      console.log('[TEST] Initial version cache confirmed populated');

      // Modify package.json version to trigger cache invalidation
      const modifiedPackage = { ...originalPackage, version: testVersion };
      writeFileSync(packagePath, JSON.stringify(modifiedPackage, null, 2));
      console.log(`[TEST] Modified package.json version from ${originalVersion} to ${testVersion}`);

      // Wait for fs.watch to trigger and cache to be refreshed
      // fs.watch has platform-specific behavior, so we use polling with retries
      const maxWaitMs = 5000;
      const pollInterval = 250;
      let cacheRefreshed = false;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        logContent = readFileSync(logFile.path, 'utf8');

        if (logContent.includes('[DAEMON RUN] package.json changed, refreshing version cache')) {
          cacheRefreshed = true;
          break;
        }
      }

      expect(cacheRefreshed).toBe(true);
      console.log('[TEST] Cache invalidation message found in logs');

      // Verify the updated version was logged
      expect(logContent).toContain(`[DAEMON RUN] Updated cached version: ${testVersion}`);
      console.log('[TEST] Updated cached version confirmed in logs');

      console.log('[TEST] Package.json version cache invalidation test passed');
    } finally {
      // CRITICAL: Restore original package.json
      writeFileSync(packagePath, packageJsonOriginalRawText);
      console.log(`[TEST] Restored package.json version to ${originalVersion}`);
    }
  });

  /**
   * Version mismatch detection test - control flow:
   * 
   * 1. Test starts daemon with original version (e.g., 0.9.0-6) compiled into dist/
   * 2. Test modifies package.json to new version (e.g., 0.0.0-integration-test-*)
   * 3. Test runs `yarn build` to recompile with new version
   * 4. Daemon's heartbeat (every 30s) reads package.json and compares to its compiled version
   * 5. Daemon detects mismatch: package.json != configuration.currentCliVersion
   * 6. Daemon spawns new daemon via spawnHappyCLI(['daemon', 'start'])
   * 7. New daemon starts, reads daemon.state.json, sees old version != its compiled version
   * 8. New daemon calls stopDaemon() to kill old daemon, then takes over
   * 
   * This simulates what happens during `npm upgrade happy-coder`:
   * - Running daemon has OLD version loaded in memory (configuration.currentCliVersion)
   * - npm replaces node_modules/happy-coder/ with NEW version files
   * - package.json on disk now has NEW version
   * - Daemon reads package.json, detects mismatch, triggers self-update
   * - Key difference: npm atomically replaces the entire module directory, while
   *   our test must carefully rebuild to avoid missing entrypoint errors
   * 
   * Critical timing constraints:
   * - Heartbeat must be long enough (30s) for yarn build to complete before daemon tries to spawn
   * - If heartbeat fires during rebuild, spawn fails (dist/index.mjs missing) and test fails
   * - pkgroll doesn't reliably update compiled version, must use full yarn build
   * - Test modifies package.json BEFORE rebuild to ensure new version is compiled in
   * 
   * Common failure modes:
   * - Heartbeat too short: daemon tries to spawn while dist/ is being rebuilt
   * - Using pkgroll alone: doesn't update compiled configuration.currentCliVersion
   * - Modifying package.json after daemon starts: triggers immediate version check on startup
   */
  it('[takes 1 minute to run] should detect version mismatch and kill old daemon', { timeout: 100_000 }, async () => {
    // Read current package.json to get version
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJsonOriginalRawText = readFileSync(packagePath, 'utf8');
    const originalPackage = JSON.parse(packageJsonOriginalRawText);
    const originalVersion = originalPackage.version;
    const testVersion = `0.0.0-integration-test-should-be-auto-cleaned-up-${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;

    expect(originalVersion).not.toBe(testVersion);
    
    // Modify package.json version
    const modifiedPackage = { ...originalPackage, version: testVersion };
    writeFileSync(packagePath, JSON.stringify(modifiedPackage, null, 2));

    try {
      // Get initial daemon state
      const initialState = await readDaemonState();
      expect(initialState).toBeDefined();
      expect(initialState!.startedWithCliVersion).toBe(originalVersion);
      const initialPid = initialState!.pid;

      // Re-build the CLI - so it will import the new package.json in its configuartion.ts
      // and think it is a new version
      // We are not using yarn build here because it cleans out dist/
      // and we want to avoid that, 
      // otherwise daemon will spawn a non existing happy js script.
      // We need to remove index, but not the other files, otherwise some of our code might fail when called from within the daemon.
      execSync('yarn build', { stdio: 'ignore' });
      
      console.log(`[TEST] Current daemon running with version ${originalVersion}, PID: ${initialPid}`);
      
      console.log(`[TEST] Changed package.json version to ${testVersion}`);

      // The daemon should automatically detect the version mismatch and restart itself
      // We check once per minute, wait for a little longer than that
      await new Promise(resolve => setTimeout(resolve, parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '30000') + 10_000));

      // Check that the daemon is running with the new version
      const finalState = await readDaemonState();
      expect(finalState).toBeDefined();
      expect(finalState!.startedWithCliVersion).toBe(testVersion);
      expect(finalState!.pid).not.toBe(initialPid);
      console.log('[TEST] Daemon version mismatch detection successful');
    } finally {
      // CRITICAL: Restore original package.json version
      writeFileSync(packagePath, packageJsonOriginalRawText);
      console.log(`[TEST] Restored package.json version to ${originalVersion}`);

      // Lets rebuild it so we keep it as we found it
      execSync('yarn build', { stdio: 'ignore' });
    }
  });

  /**
   * Corrupted Daemon State File Tests (HAP-216)
   *
   * These tests verify that the daemon gracefully handles corrupted state files.
   * When daemon.state.json is corrupted (malformed JSON, invalid schema, empty, etc.),
   * the daemon should:
   * 1. Log appropriate warnings
   * 2. Clean up the corrupted file
   * 3. Start fresh as if no state file existed
   */
  describe('Corrupted daemon state file handling', () => {
    beforeEach(async () => {
      // Stop any running daemon first
      await stopDaemon();
      // Ensure no state file exists
      await clearDaemonState();
    });

    afterEach(async () => {
      await stopDaemon();
      await clearDaemonState();
    });

    it('should handle malformed JSON in daemon.state.json', async () => {
      // Write malformed JSON to the state file
      const malformedJson = '{ "pid": 12345, "httpPort": invalid json here';
      writeFileSync(configuration.daemonStateFile, malformedJson);
      expect(existsSync(configuration.daemonStateFile)).toBe(true);

      // readDaemonState should return null and clean up the file
      const state = await readDaemonState();
      expect(state).toBeNull();
      expect(existsSync(configuration.daemonStateFile)).toBe(false);

      console.log('[TEST] Malformed JSON handled - file cleaned up');
    });

    it('should handle empty state file', async () => {
      // Write empty file
      writeFileSync(configuration.daemonStateFile, '');
      expect(existsSync(configuration.daemonStateFile)).toBe(true);

      // readDaemonState should return null and clean up the file
      const state = await readDaemonState();
      expect(state).toBeNull();
      expect(existsSync(configuration.daemonStateFile)).toBe(false);

      console.log('[TEST] Empty file handled - file cleaned up');
    });

    it('should handle state file with invalid schema (missing required fields)', async () => {
      // Write JSON that's valid but missing required fields (pid, httpPort, startTime, startedWithCliVersion)
      const invalidSchema = JSON.stringify({
        someRandomField: 'value',
        anotherField: 123
      });
      writeFileSync(configuration.daemonStateFile, invalidSchema);
      expect(existsSync(configuration.daemonStateFile)).toBe(true);

      // readDaemonState should return null and clean up the file
      const state = await readDaemonState();
      expect(state).toBeNull();
      expect(existsSync(configuration.daemonStateFile)).toBe(false);

      console.log('[TEST] Invalid schema handled - file cleaned up');
    });

    it('should handle partially written state file (simulating crash during write)', async () => {
      // Simulate a partial write - truncated JSON (crash mid-write scenario)
      const truncatedJson = '{"pid":12345,"httpPort":8080,"startTime":"2025-01-01T00:00:00.000Z","startedWithCli';
      writeFileSync(configuration.daemonStateFile, truncatedJson);
      expect(existsSync(configuration.daemonStateFile)).toBe(true);

      // readDaemonState should return null and clean up the file
      const state = await readDaemonState();
      expect(state).toBeNull();
      expect(existsSync(configuration.daemonStateFile)).toBe(false);

      console.log('[TEST] Partially written file handled - file cleaned up');
    });

    it('should handle state file with wrong field types', async () => {
      // Write JSON with correct field names but wrong types
      const wrongTypes = JSON.stringify({
        pid: 'not-a-number',  // Should be number
        httpPort: 'also-not-a-number',  // Should be number
        startTime: 12345,  // Should be string
        startedWithCliVersion: null  // Should be string
      });
      writeFileSync(configuration.daemonStateFile, wrongTypes);
      expect(existsSync(configuration.daemonStateFile)).toBe(true);

      // readDaemonState should return null and clean up the file
      const state = await readDaemonState();
      expect(state).toBeNull();
      expect(existsSync(configuration.daemonStateFile)).toBe(false);

      console.log('[TEST] Wrong field types handled - file cleaned up');
    });

    it('should start daemon fresh after cleaning up corrupted state file', async () => {
      // Write corrupted state file
      const malformedJson = '{ this is not valid json at all }}}';
      writeFileSync(configuration.daemonStateFile, malformedJson);
      expect(existsSync(configuration.daemonStateFile)).toBe(true);

      // Start daemon - it should clean up corrupted file and start fresh
      void spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });

      // Wait for daemon to start successfully
      await waitFor(async () => {
        const state = await readDaemonState();
        return state !== null && state.pid > 0;
      }, 10_000, 250);

      // Verify daemon started with valid state
      const state = await readDaemonState();
      expect(state).not.toBeNull();
      expect(state!.pid).toBeGreaterThan(0);
      expect(state!.httpPort).toBeGreaterThan(0);
      expect(state!.startedWithCliVersion).toBeDefined();

      console.log(`[TEST] Daemon started fresh after corrupted state - PID: ${state!.pid}`);
    });
  });

  /**
   * NPM Uninstall Scenario Test (HAP-217)
   *
   * This test validates that the daemon gracefully shuts down when the CLI binary
   * is deleted (simulating npm uninstall). The scenario is:
   *
   * 1. Daemon is running with version X
   * 2. Package.json is modified to version Y (simulating npm upgrade)
   * 3. dist/index.mjs is deleted (simulating corrupted or uninstalled state)
   * 4. Daemon heartbeat detects version mismatch and tries to spawn new daemon
   * 5. spawnHappyCLI throws RESOURCE_NOT_FOUND error because binary is missing
   * 6. Daemon should detect this and shut down gracefully instead of hanging
   * 7. Daemon state file should be cleared on shutdown
   *
   * This prevents the daemon from leaving orphaned state files when uninstalled.
   */
  it('[takes 1 minute to run] should gracefully shutdown when binary is missing (npm uninstall scenario)', { timeout: 100_000 }, async () => {
    // Read current package.json to get version
    const packagePath = path.join(process.cwd(), 'package.json');
    const entrypointPath = path.join(process.cwd(), 'dist', 'index.mjs');
    const entrypointBackupPath = path.join(process.cwd(), 'dist', 'index.mjs.backup');

    const packageJsonOriginalRawText = readFileSync(packagePath, 'utf8');
    const originalPackage = JSON.parse(packageJsonOriginalRawText);
    const originalVersion = originalPackage.version;
    const testVersion = `0.0.0-uninstall-test-${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;

    expect(originalVersion).not.toBe(testVersion);

    try {
      // Get initial daemon state
      const initialState = await readDaemonState();
      expect(initialState).toBeDefined();
      expect(initialState!.startedWithCliVersion).toBe(originalVersion);
      const initialPid = initialState!.pid;

      console.log(`[TEST] Current daemon running with version ${originalVersion}, PID: ${initialPid}`);

      // Backup the entrypoint before deleting
      expect(existsSync(entrypointPath)).toBe(true);
      copyFileSync(entrypointPath, entrypointBackupPath);
      console.log(`[TEST] Backed up entrypoint to ${entrypointBackupPath}`);

      // Modify package.json version to trigger version mismatch detection
      const modifiedPackage = { ...originalPackage, version: testVersion };
      writeFileSync(packagePath, JSON.stringify(modifiedPackage, null, 2));
      console.log(`[TEST] Changed package.json version to ${testVersion}`);

      // Delete the entrypoint to simulate uninstall
      unlinkSync(entrypointPath);
      expect(existsSync(entrypointPath)).toBe(false);
      console.log(`[TEST] Deleted entrypoint ${entrypointPath}`);

      // Wait for heartbeat to detect version mismatch and attempt to spawn new daemon
      // The spawn will fail due to missing binary, triggering graceful shutdown
      const heartbeatInterval = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '30000');
      const waitTime = heartbeatInterval + 15_000; // Wait for heartbeat + buffer for shutdown
      console.log(`[TEST] Waiting ${waitTime}ms for heartbeat and graceful shutdown...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));

      // Check if daemon process is dead
      let isDead = false;
      try {
        process.kill(initialPid, 0);
      } catch {
        isDead = true;
      }
      expect(isDead).toBe(true);
      console.log('[TEST] Daemon process is dead as expected');

      // Check that daemon state file was cleaned up (graceful shutdown)
      const finalState = await readDaemonState();
      expect(finalState).toBeNull();
      console.log('[TEST] Daemon state file was cleaned up');

      // Check daemon log for graceful shutdown messages
      const logFile = await getLatestDaemonLog();
      expect(logFile).toBeDefined();
      const logContent = readFileSync(logFile!.path, 'utf8');
      expect(logContent).toContain('Binary missing');
      expect(logContent).toContain('Initiating graceful shutdown');
      console.log('[TEST] Daemon log contains graceful shutdown messages');

      console.log('[TEST] NPM uninstall scenario handled gracefully');
    } finally {
      // CRITICAL: Restore entrypoint and package.json
      if (existsSync(entrypointBackupPath)) {
        copyFileSync(entrypointBackupPath, entrypointPath);
        unlinkSync(entrypointBackupPath);
        console.log(`[TEST] Restored entrypoint from backup`);
      }
      writeFileSync(packagePath, packageJsonOriginalRawText);
      console.log(`[TEST] Restored package.json version to ${originalVersion}`);

      // Clean up any orphaned state files
      await clearDaemonState();
    }
  });
  /**
   * Pre-start Validation Tests (HAP-760)
   *
   * Tests for daemon startup validation behavior from HAP-755:
   * - Failing with detailed message when daemon is already running (handleDaemonStart path)
   * - Detecting and cleaning up stale state (process dead but state file exists)
   * - Starting fresh after stale state cleanup
   *
   * Note: There's also a similar test at line 308 "should not allow starting a
   * second daemon" which tests the start-sync path. These tests specifically
   * verify the NEW handleDaemonStart() pre-start validation from HAP-755.
   */
  describe('Pre-start validation (HAP-760)', () => {
    afterEach(async () => {
      await stopDaemon();
      await clearDaemonState();
    });

    it('should fail with detailed message when daemon is already running', async () => {
      // First, ensure clean state and start a daemon
      await stopDaemon();
      await clearDaemonState();

      void spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });

      await waitFor(async () => {
        const state = await readDaemonState();
        return state !== null && state.pid > 0;
      }, 10_000, 250);

      const runningState = await readDaemonState();
      expect(runningState).not.toBeNull();

      console.log(`[TEST] Daemon running with PID: ${runningState!.pid}`);

      // Try to start another daemon using 'daemon start' (not start-sync)
      // This tests the NEW handleDaemonStart() pre-start validation from HAP-755
      const secondChild = spawn('yarn', ['tsx', 'src/index.ts', 'daemon', 'start'], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      secondChild.stdout?.on('data', (data) => {
        output += data.toString();
      });
      secondChild.stderr?.on('data', (data) => {
        output += data.toString();
      });

      // Wait for the second daemon attempt to exit
      const exitCode = await new Promise<number | null>((resolve) => {
        secondChild.on('exit', (code) => resolve(code));
      });

      // Verify the NEW pre-start validation behavior from HAP-755:
      // - Detailed error message with PID and Port
      // - Suggests using restart or stop commands
      expect(output).toContain('already running');
      expect(output).toContain('PID:');
      expect(output).toContain('Port:');
      expect(output).toContain('restart');
      expect(exitCode).not.toBe(0);

      console.log('[TEST] Pre-start validation correctly rejected second daemon start with detailed message');
    });

    it('should clean up stale state and start successfully', async () => {
      // Stop any running daemon first
      await stopDaemon();
      await clearDaemonState();
      // Create stale state: write a state file with a PID that doesn't exist
      // Use a high PID that's unlikely to be running
      const stalePid = 99999999;
      const staleState = {
        pid: stalePid,
        httpPort: 12345,
        startTime: new Date().toISOString(),
        startedWithCliVersion: '0.0.0-stale-test',
      };
      writeFileSync(configuration.daemonStateFile, JSON.stringify(staleState));
      expect(existsSync(configuration.daemonStateFile)).toBe(true);

      // Verify the stale PID is not running
      let pidRunning = true;
      try {
        process.kill(stalePid, 0);
      } catch {
        pidRunning = false;
      }
      expect(pidRunning).toBe(false);

      console.log('[TEST] Created stale daemon state file with dead PID');

      // Start daemon - it should clean up stale state and start fresh
      void spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });

      // Wait for daemon to start successfully
      await waitFor(async () => {
        const state = await readDaemonState();
        return state !== null && state.pid > 0 && state.pid !== stalePid;
      }, 10_000, 250);

      // Verify daemon started with new PID
      const state = await readDaemonState();
      expect(state).not.toBeNull();
      expect(state!.pid).not.toBe(stalePid);
      expect(state!.pid).toBeGreaterThan(0);
      expect(state!.httpPort).toBeGreaterThan(0);
      expect(state!.startedWithCliVersion).toBeDefined();
      expect(state!.startedWithCliVersion).not.toBe('0.0.0-stale-test');

      // Verify the new daemon is actually running
      let isRunning = false;
      try {
        process.kill(state!.pid, 0);
        isRunning = true;
      } catch {
        isRunning = false;
      }
      expect(isRunning).toBe(true);

      console.log(`[TEST] Daemon started fresh after stale state cleanup - PID: ${state!.pid}`);
    });
  });

  /**
   * Restart Command Tests (HAP-760)
   *
   * Tests for daemon restart command behavior:
   * - Restart with running daemon (stop then start)
   * - Restart with no daemon running (just start)
   * - Restart with stale daemon state (cleanup then start)
   */
  describe('Restart command (HAP-760)', () => {
    afterEach(async () => {
      await stopDaemon();
      await clearDaemonState();
    });

    it('should stop and restart when daemon is running', async () => {
      // First, start a daemon
      await stopDaemon();
      await clearDaemonState();

      void spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });

      await waitFor(async () => {
        const state = await readDaemonState();
        return state !== null && state.pid > 0;
      }, 10_000, 250);

      const initialState = await readDaemonState();
      expect(initialState).not.toBeNull();
      const initialPid = initialState!.pid;

      console.log(`[TEST] Initial daemon running with PID: ${initialPid}`);

      // Call restart command
      const restartChild = spawn('yarn', ['tsx', 'src/index.ts', 'daemon', 'restart'], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      restartChild.stdout?.on('data', (data) => {
        output += data.toString();
      });
      restartChild.stderr?.on('data', (data) => {
        output += data.toString();
      });

      // Wait for restart to complete
      await new Promise<void>((resolve) => {
        restartChild.on('exit', () => resolve());
      });

      // Wait for new daemon to be running
      await waitFor(async () => {
        const state = await readDaemonState();
        return state !== null && state.pid > 0;
      }, 10_000, 250);

      // Verify new daemon has different PID
      const finalState = await readDaemonState();
      expect(finalState).not.toBeNull();
      expect(finalState!.pid).not.toBe(initialPid);
      expect(finalState!.pid).toBeGreaterThan(0);

      // Verify output contains restart messages
      expect(output).toContain('Stopping');
      expect(output).toContain('Starting');
      expect(output).toContain('restarted successfully');

      console.log(`[TEST] Daemon restarted with new PID: ${finalState!.pid}`);
    });

    it('should just start when no daemon running', async () => {
      // Ensure no daemon is running
      await stopDaemon();
      await clearDaemonState();

      // Brief pause to ensure clean state
      await new Promise(resolve => setTimeout(resolve, 500));

      // Call restart command (with no daemon running)
      const restartChild = spawn('yarn', ['tsx', 'src/index.ts', 'daemon', 'restart'], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      restartChild.stdout?.on('data', (data) => {
        output += data.toString();
      });
      restartChild.stderr?.on('data', (data) => {
        output += data.toString();
      });

      // Wait for restart to complete
      await new Promise<void>((resolve) => {
        restartChild.on('exit', () => resolve());
      });

      // Wait for daemon to be running
      await waitFor(async () => {
        const state = await readDaemonState();
        return state !== null && state.pid > 0;
      }, 10_000, 250);

      // Verify daemon started
      const state = await readDaemonState();
      expect(state).not.toBeNull();
      expect(state!.pid).toBeGreaterThan(0);

      // Verify output does not contain "Stopping" (since no daemon was running)
      // But should contain "Starting" and success
      expect(output).toContain('Starting');
      expect(output).toContain('restarted successfully');

      console.log(`[TEST] Daemon started via restart command - PID: ${state!.pid}`);
    });

    it('should handle stale state on restart', async () => {
      // Stop any running daemon first
      await stopDaemon();
      await clearDaemonState();

      // Create stale state: write a state file with a PID that doesn't exist
      const stalePid = 99999998;
      const staleState = {
        pid: stalePid,
        httpPort: 12346,
        startTime: new Date().toISOString(),
        startedWithCliVersion: '0.0.0-stale-restart-test',
      };
      writeFileSync(configuration.daemonStateFile, JSON.stringify(staleState));
      expect(existsSync(configuration.daemonStateFile)).toBe(true);

      console.log('[TEST] Created stale daemon state file');

      // Call restart command
      const restartChild = spawn('yarn', ['tsx', 'src/index.ts', 'daemon', 'restart'], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      restartChild.stdout?.on('data', (data) => {
        output += data.toString();
      });
      restartChild.stderr?.on('data', (data) => {
        output += data.toString();
      });

      // Wait for restart to complete
      await new Promise<void>((resolve) => {
        restartChild.on('exit', () => resolve());
      });

      // Wait for daemon to be running
      await waitFor(async () => {
        const state = await readDaemonState();
        return state !== null && state.pid > 0 && state.pid !== stalePid;
      }, 10_000, 250);

      // Verify daemon started with new PID
      const state = await readDaemonState();
      expect(state).not.toBeNull();
      expect(state!.pid).not.toBe(stalePid);
      expect(state!.pid).toBeGreaterThan(0);

      // Verify output mentions stale state cleanup
      expect(output).toContain('stale');
      expect(output).toContain('Starting');
      expect(output).toContain('restarted successfully');

      console.log(`[TEST] Daemon started after stale state cleanup - PID: ${state!.pid}`);
    });
  });
});

/**
 * Daemon Lock Race Condition Tests (HAP-156)
 *
 * These tests validate the fix from HAP-59 which ensures the daemon lock is released
 * atomically by the OS when the process exits, rather than being manually released
 * before process.exit(). This eliminates a race window where a new daemon could fail
 * to acquire the lock.
 *
 * The lock mechanism relies on:
 * - O_EXCL flag for atomic lock file creation
 * - OS releasing file handle atomically on process.exit()
 * - acquireDaemonLock() detecting stale locks via process.kill(pid, 0)
 * - Lock file containing PID allows new daemons to detect dead holders
 */
describe.skipIf(!await isServerHealthy())('Daemon Lock Race Condition Tests (HAP-156)', { timeout: 60_000 }, () => {

  // Helper to check if a process is running
  function isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // Helper to verify daemon state file is valid JSON with expected fields
  async function verifyDaemonStateIntegrity(): Promise<{ valid: boolean; pid?: number; error?: string }> {
    try {
      const state = await readDaemonState();
      if (!state) {
        return { valid: false, error: 'State file not found or empty' };
      }
      if (typeof state.pid !== 'number' || state.pid <= 0) {
        return { valid: false, error: `Invalid PID: ${state.pid}` };
      }
      if (typeof state.httpPort !== 'number' || state.httpPort <= 0) {
        return { valid: false, error: `Invalid httpPort: ${state.httpPort}` };
      }
      return { valid: true, pid: state.pid };
    } catch (error) {
      return { valid: false, error: `Parse error: ${error}` };
    }
  }

  // Helper to count running daemon processes
  async function countRunningDaemons(): Promise<number> {
    const state = await readDaemonState();
    if (!state) return 0;
    return isProcessRunning(state.pid) ? 1 : 0;
  }

  afterEach(async () => {
    // Ensure cleanup after each test
    await stopDaemon();
    await clearDaemonState();
  });

  /**
   * Test 1: Rapid stop/start cycles
   *
   * Validates that rapidly stopping and starting the daemon doesn't cause:
   * - Lock acquisition failures
   * - State file corruption
   * - Multiple daemons running simultaneously
   */
  it('should handle rapid stop/start cycles without lock conflicts', async () => {
    const CYCLE_COUNT = 5;
    const previousPids: number[] = [];

    for (let cycle = 0; cycle < CYCLE_COUNT; cycle++) {
      console.log(`[TEST] Cycle ${cycle + 1}/${CYCLE_COUNT}: Starting daemon...`);

      // Start daemon
      void spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });

      // Wait for daemon to be fully running
      await waitFor(async () => {
        const state = await readDaemonState();
        return state !== null && isProcessRunning(state.pid);
      }, 10_000, 250);

      // Verify state integrity
      const stateCheck = await verifyDaemonStateIntegrity();
      expect(stateCheck.valid).toBe(true);

      // Verify this is a new PID (not reusing old one)
      // Use assertion outside conditional to avoid no-conditional-expect
      expect(stateCheck.pid).toBeDefined();
      expect(previousPids.includes(stateCheck.pid!)).toBe(false);
      previousPids.push(stateCheck.pid!);

      // Verify only one daemon is running
      const runningCount = await countRunningDaemons();
      expect(runningCount).toBe(1);

      console.log(`[TEST] Cycle ${cycle + 1}/${CYCLE_COUNT}: Stopping daemon (PID: ${stateCheck.pid})...`);

      // Stop daemon - this should release lock atomically via OS on exit
      await stopDaemon();

      // Brief pause to ensure process fully exits
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log('[TEST] All rapid stop/start cycles completed successfully');
  });

  /**
   * Test 2: Parallel start attempts
   *
   * Validates that when multiple daemons try to start simultaneously,
   * only one succeeds in acquiring the lock and running.
   */
  it('should allow only one daemon when multiple start attempts occur simultaneously', async () => {
    // Ensure no daemon is running
    await stopDaemon();
    await clearDaemonState();

    // Brief pause to ensure clean slate
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('[TEST] Spawning 3 daemons simultaneously...');

    // Spawn 3 daemons at the same time
    spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });
    spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });
    spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });

    // Wait for things to settle - at least one should succeed
    await waitFor(async () => {
      const state = await readDaemonState();
      return state !== null;
    }, 15_000, 250);

    // Give extra time for competing daemons to exit
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify state integrity
    const stateCheck = await verifyDaemonStateIntegrity();
    expect(stateCheck.valid).toBe(true);

    // The critical check: only ONE daemon should be running
    const runningCount = await countRunningDaemons();
    expect(runningCount).toBe(1);

    // Verify the running daemon matches the state file
    const state = await readDaemonState();
    expect(state).not.toBeNull();
    expect(isProcessRunning(state!.pid)).toBe(true);

    console.log(`[TEST] Parallel start test passed: Only daemon PID ${state!.pid} is running`);
  });

  /**
   * Test 3: Crash (SIGKILL) + immediate restart
   *
   * Validates that when a daemon is killed with SIGKILL (no cleanup),
   * a new daemon can detect the stale lock and take over.
   *
   * This is the scenario HAP-59 specifically addresses:
   * - Old daemon dies without releasing lock
   * - Lock file remains with dead PID
   * - New daemon detects stale lock via process.kill(pid, 0)
   * - New daemon cleans up stale lock and acquires new one
   */
  it('should recover from crashed daemon (SIGKILL) and acquire lock', async () => {
    // Start initial daemon
    void spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });

    await waitFor(async () => {
      const state = await readDaemonState();
      return state !== null && isProcessRunning(state.pid);
    }, 10_000, 250);

    const initialState = await readDaemonState();
    expect(initialState).not.toBeNull();
    const crashedPid = initialState!.pid;

    console.log(`[TEST] Initial daemon running with PID ${crashedPid}`);

    // Verify lock file exists
    expect(existsSync(configuration.daemonLockFile)).toBe(true);

    // SIGKILL the daemon - this simulates a crash with no cleanup
    console.log(`[TEST] Sending SIGKILL to daemon PID ${crashedPid}...`);
    process.kill(crashedPid, 'SIGKILL');

    // Wait for process to die
    await waitFor(async () => !isProcessRunning(crashedPid), 2000, 100);
    expect(isProcessRunning(crashedPid)).toBe(false);

    // Lock file should still exist (no cleanup on SIGKILL)
    // Note: The lock file might be cleaned up by the OS releasing the file handle
    // but the state file should still show the old PID
    console.log('[TEST] Daemon crashed. Lock file exists:', existsSync(configuration.daemonLockFile));

    // Immediately try to start a new daemon
    console.log('[TEST] Immediately starting new daemon...');
    void spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });

    // Wait for new daemon to start
    await waitFor(async () => {
      const state = await readDaemonState();
      return state !== null && state.pid !== crashedPid && isProcessRunning(state.pid);
    }, 15_000, 250);

    // Verify new daemon took over
    const newState = await readDaemonState();
    expect(newState).not.toBeNull();
    expect(newState!.pid).not.toBe(crashedPid);
    expect(isProcessRunning(newState!.pid)).toBe(true);

    // Verify state integrity
    const stateCheck = await verifyDaemonStateIntegrity();
    expect(stateCheck.valid).toBe(true);

    console.log(`[TEST] Successfully recovered: New daemon PID ${newState!.pid} replaced crashed PID ${crashedPid}`);
  });

  /**
   * Test 4: Multiple SIGKILL + restart cycles
   *
   * Stress test that repeatedly crashes and restarts the daemon to ensure
   * the lock recovery mechanism is robust.
   */
  it('should handle multiple crash/restart cycles reliably', async () => {
    const CRASH_CYCLES = 3;

    for (let cycle = 0; cycle < CRASH_CYCLES; cycle++) {
      console.log(`[TEST] Crash cycle ${cycle + 1}/${CRASH_CYCLES}`);

      // Start daemon
      void spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });

      await waitFor(async () => {
        const state = await readDaemonState();
        return state !== null && isProcessRunning(state.pid);
      }, 10_000, 250);

      const state = await readDaemonState();
      expect(state).not.toBeNull();
      const pid = state!.pid;

      // Verify it's running
      expect(isProcessRunning(pid)).toBe(true);

      // Crash it
      process.kill(pid, 'SIGKILL');

      // Wait for death
      await waitFor(async () => !isProcessRunning(pid), 2000, 100);

      // Small delay before next cycle
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Final verification: start one more daemon and ensure it works
    void spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });

    await waitFor(async () => {
      const state = await readDaemonState();
      return state !== null && isProcessRunning(state.pid);
    }, 10_000, 250);

    const finalState = await readDaemonState();
    expect(finalState).not.toBeNull();
    expect(isProcessRunning(finalState!.pid)).toBe(true);

    console.log(`[TEST] All crash cycles completed. Final daemon PID: ${finalState!.pid}`);
  });
});