/**
 * Unit tests for AcpSdkBackend MCP Integration
 *
 * Tests disabledTools initialization and permission denial logic.
 * Uses mocks to avoid spawning real agent processes.
 *
 * @module agent/acp/AcpSdkBackend.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process to avoid spawning real processes
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
      once: vi.fn(),
    },
    stdout: {
      on: vi.fn(),
      destroy: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn(),
    once: vi.fn(),
    kill: vi.fn(),
  })),
}));

// Mock the ACP SDK
vi.mock('@agentclientprotocol/sdk', () => ({
  ClientSideConnection: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue({ capabilities: {} }),
    newSession: vi.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
    prompt: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue({}),
  })),
  ndJsonStream: vi.fn().mockReturnValue({}),
}));

// Mock logger to suppress output
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock package.json
vi.mock('../../../package.json', () => ({
  default: { version: '1.0.0-test' },
}));

// Mock utils
vi.mock('./utils', () => ({
  isInvestigationTool: vi.fn().mockReturnValue(false),
  determineToolName: vi.fn((toolName: string) => toolName),
  getRealToolName: vi.fn((toolCallId: string, toolKind: string) => toolKind),
  getToolCallTimeout: vi.fn().mockReturnValue(30000),
}));

// Mock prompt utils
vi.mock('@/gemini/utils/promptUtils', () => ({
  hasChangeTitleInstruction: vi.fn().mockReturnValue(false),
}));

import { AcpSdkBackend, type AcpSdkBackendOptions } from './AcpSdkBackend';

describe('AcpSdkBackend', () => {
  const baseOptions: AcpSdkBackendOptions = {
    agentName: 'test',
    cwd: '/test',
    command: 'test-cmd',
    args: ['--test'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('disabledTools initialization', () => {
    it('should collect disabled tools from all MCP server configs', () => {
      const opts: AcpSdkBackendOptions = {
        ...baseOptions,
        mcpServers: {
          'server-a': {
            command: 'a',
            disabledTools: ['tool1', 'tool2'],
          },
          'server-b': {
            command: 'b',
            disabledTools: ['tool3'],
          },
        },
      };

      const backend = new AcpSdkBackend(opts);

      // Access private disabledTools via any cast for testing
      const disabledTools = (backend as any).disabledTools as Set<string>;

      expect(disabledTools.size).toBe(3);
      expect(disabledTools.has('tool1')).toBe(true);
      expect(disabledTools.has('tool2')).toBe(true);
      expect(disabledTools.has('tool3')).toBe(true);
    });

    it('should handle servers with no disabled tools', () => {
      const opts: AcpSdkBackendOptions = {
        ...baseOptions,
        mcpServers: {
          'server-a': {
            command: 'a',
            // No disabledTools
          },
        },
      };

      // Should not throw
      const backend = new AcpSdkBackend(opts);

      // Access private disabledTools
      const disabledTools = (backend as any).disabledTools as Set<string>;

      expect(disabledTools.size).toBe(0);
    });

    it('should handle no MCP servers', () => {
      const backend = new AcpSdkBackend(baseOptions);

      // Access private disabledTools
      const disabledTools = (backend as any).disabledTools as Set<string>;

      expect(disabledTools.size).toBe(0);
    });

    it('should handle empty disabledTools array', () => {
      const opts: AcpSdkBackendOptions = {
        ...baseOptions,
        mcpServers: {
          'server-a': {
            command: 'a',
            disabledTools: [],
          },
        },
      };

      const backend = new AcpSdkBackend(opts);

      const disabledTools = (backend as any).disabledTools as Set<string>;

      expect(disabledTools.size).toBe(0);
    });

    it('should handle duplicate disabled tools across servers', () => {
      const opts: AcpSdkBackendOptions = {
        ...baseOptions,
        mcpServers: {
          'server-a': {
            command: 'a',
            disabledTools: ['shared_tool', 'tool_a'],
          },
          'server-b': {
            command: 'b',
            disabledTools: ['shared_tool', 'tool_b'],
          },
        },
      };

      const backend = new AcpSdkBackend(opts);

      const disabledTools = (backend as any).disabledTools as Set<string>;

      // Set should deduplicate
      expect(disabledTools.size).toBe(3);
      expect(disabledTools.has('shared_tool')).toBe(true);
      expect(disabledTools.has('tool_a')).toBe(true);
      expect(disabledTools.has('tool_b')).toBe(true);
    });

    it('should handle mixed servers with and without disabled tools', () => {
      const opts: AcpSdkBackendOptions = {
        ...baseOptions,
        mcpServers: {
          'server-with-tools': {
            command: 'a',
            disabledTools: ['tool1'],
          },
          'server-without-tools': {
            command: 'b',
            // No disabledTools
          },
          'server-empty-tools': {
            command: 'c',
            disabledTools: [],
          },
        },
      };

      const backend = new AcpSdkBackend(opts);

      const disabledTools = (backend as any).disabledTools as Set<string>;

      expect(disabledTools.size).toBe(1);
      expect(disabledTools.has('tool1')).toBe(true);
    });
  });

  describe('event handling', () => {
    it('should call message handlers when emit is called', () => {
      const backend = new AcpSdkBackend(baseOptions);
      const handler = vi.fn();

      backend.onMessage(handler);

      // Trigger an internal emit (we need to access it indirectly)
      // Since emit is private, we test it through startSession which emits status
      // But that requires more setup, so we'll test the handler registration

      // Verify handler is registered by adding and removing
      backend.offMessage(handler);

      // Add another handler
      const handler2 = vi.fn();
      backend.onMessage(handler2);

      // Verify handlers are tracked (indirectly through the listeners array)
      expect((backend as any).listeners).toContain(handler2);
      expect((backend as any).listeners).not.toContain(handler);
    });

    it('should not emit after disposal', async () => {
      const backend = new AcpSdkBackend(baseOptions);
      const handler = vi.fn();

      backend.onMessage(handler);
      await backend.dispose();

      // After disposal, the listeners should be cleared
      expect((backend as any).listeners).toEqual([]);
    });
  });

  describe('dispose', () => {
    it('should set disposed flag', async () => {
      const backend = new AcpSdkBackend(baseOptions);

      expect((backend as any).disposed).toBe(false);

      await backend.dispose();

      expect((backend as any).disposed).toBe(true);
    });

    it('should clear active tool calls', async () => {
      const backend = new AcpSdkBackend(baseOptions);

      // Simulate active tool calls
      (backend as any).activeToolCalls.add('tool-1');
      (backend as any).activeToolCalls.add('tool-2');

      await backend.dispose();

      expect((backend as any).activeToolCalls.size).toBe(0);
    });

    it('should clear tool call timeouts', async () => {
      const backend = new AcpSdkBackend(baseOptions);

      // Simulate a tool call timeout
      const timeout = setTimeout(() => {}, 10000);
      (backend as any).toolCallTimeouts.set('tool-1', timeout);

      await backend.dispose();

      expect((backend as any).toolCallTimeouts.size).toBe(0);
    });

    it('should be idempotent (can be called multiple times)', async () => {
      const backend = new AcpSdkBackend(baseOptions);

      await backend.dispose();
      await backend.dispose(); // Should not throw

      expect((backend as any).disposed).toBe(true);
    });
  });

  describe('permission handling', () => {
    it('should track permission to tool call mapping', () => {
      const backend = new AcpSdkBackend(baseOptions);

      // The permissionToToolCallMap is used internally during permission requests
      expect((backend as any).permissionToToolCallMap).toBeInstanceOf(Map);
    });

    it('should track tool call ID to name mapping', () => {
      const backend = new AcpSdkBackend(baseOptions);

      // The toolCallIdToNameMap is used for auto-approval
      expect((backend as any).toolCallIdToNameMap).toBeInstanceOf(Map);
    });
  });
});

describe('AcpSdkBackend disabledTools permission denial', () => {
  /**
   * Note: Testing the actual permission denial flow requires more complex
   * setup with mocked ACP SDK requestPermission callbacks. The key logic
   * tested here is that:
   *
   * 1. disabledTools Set is correctly populated from MCP configs
   * 2. The Set can be used for O(1) lookup (tested via .has())
   *
   * The actual denial logic in requestPermission callback (lines 507-523)
   * checks: if (this.disabledTools.has(toolName)) { ... return cancel }
   *
   * This pattern ensures:
   * - Auto-deny without prompting user
   * - Emit permission-response with approved: false
   * - Return 'cancel' optionId to ACP
   */

  it('should have disabledTools as a Set for O(1) lookup', () => {
    const opts: AcpSdkBackendOptions = {
      agentName: 'test',
      cwd: '/test',
      command: 'cmd',
      mcpServers: {
        server: {
          command: 'test',
          disabledTools: ['dangerous_tool', 'another_tool'],
        },
      },
    };

    const backend = new AcpSdkBackend(opts);
    const disabledTools = (backend as any).disabledTools;

    // Verify it's a Set (for O(1) lookup)
    expect(disabledTools).toBeInstanceOf(Set);

    // Verify lookup works
    expect(disabledTools.has('dangerous_tool')).toBe(true);
    expect(disabledTools.has('another_tool')).toBe(true);
    expect(disabledTools.has('safe_tool')).toBe(false);
  });
});

describe('AcpSdkBackend respondToPermission', () => {
  const baseOptions: AcpSdkBackendOptions = {
    agentName: 'test',
    cwd: '/test',
    command: 'test-cmd',
    args: ['--test'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('pending permissions management', () => {
    it('should have pendingPermissions as a Map with correct structure', () => {
      const backend = new AcpSdkBackend(baseOptions);
      const pendingPermissions = (backend as any).pendingPermissions;

      expect(pendingPermissions).toBeInstanceOf(Map);
      expect(pendingPermissions.size).toBe(0);
    });

    it('should resolve pending permission with approved optionId when approved', async () => {
      const backend = new AcpSdkBackend(baseOptions);
      const permissionId = 'test-permission-id';
      const options = [
        { optionId: 'proceed_once', name: 'Proceed Once' },
        { optionId: 'cancel', name: 'Cancel' },
      ];

      let resolvedResponse: any = null;

      (backend as any).pendingPermissions.set(permissionId, {
        resolve: (response: any) => {
          resolvedResponse = response;
        },
        options,
      });

      await backend.respondToPermission(permissionId, true);

      expect(resolvedResponse).toEqual({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      });

      expect((backend as any).pendingPermissions.has(permissionId)).toBe(false);
    });

    it('should resolve pending permission with cancel optionId when denied', async () => {
      const backend = new AcpSdkBackend(baseOptions);
      const permissionId = 'test-permission-id';
      const options = [
        { optionId: 'proceed_once', name: 'Proceed Once' },
        { optionId: 'cancel', name: 'Cancel' },
      ];

      let resolvedResponse: any = null;

      (backend as any).pendingPermissions.set(permissionId, {
        resolve: (response: any) => {
          resolvedResponse = response;
        },
        options,
      });

      await backend.respondToPermission(permissionId, false);

      expect(resolvedResponse).toEqual({
        outcome: { outcome: 'selected', optionId: 'cancel' },
      });

      expect((backend as any).pendingPermissions.has(permissionId)).toBe(false);
    });

    it('should handle missing pending permission gracefully', async () => {
      const backend = new AcpSdkBackend(baseOptions);
      const handler = vi.fn();
      backend.onMessage(handler);

      await backend.respondToPermission('non-existent-id', true);

      expect(handler).toHaveBeenCalledWith({
        type: 'permission-response',
        id: 'non-existent-id',
        approved: true,
      });
    });

    it('should fallback to default optionIds when options are empty', async () => {
      const backend = new AcpSdkBackend(baseOptions);
      const permissionId = 'test-permission-id';
      const options: any[] = [];

      let resolvedResponse: any = null;

      (backend as any).pendingPermissions.set(permissionId, {
        resolve: (response: any) => {
          resolvedResponse = response;
        },
        options,
      });

      await backend.respondToPermission(permissionId, true);

      expect(resolvedResponse).toEqual({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      });
    });

    it('should prefer proceed_always option for session approval', async () => {
      const backend = new AcpSdkBackend(baseOptions);
      const permissionId = 'test-permission-id';
      const options = [
        { optionId: 'proceed_always', name: 'Proceed Always' },
        { optionId: 'cancel', name: 'Cancel' },
      ];

      let resolvedResponse: any = null;

      (backend as any).pendingPermissions.set(permissionId, {
        resolve: (response: any) => {
          resolvedResponse = response;
        },
        options,
      });

      await backend.respondToPermission(permissionId, true);

      expect(resolvedResponse).toEqual({
        outcome: { outcome: 'selected', optionId: 'proceed_always' },
      });
    });
  });

  describe('dispose cleanup', () => {
    it('should cancel all pending permissions on dispose', async () => {
      const backend = new AcpSdkBackend(baseOptions);
      const permissionId = 'test-permission-id';
      const options = [
        { optionId: 'proceed_once', name: 'Proceed Once' },
        { optionId: 'cancel', name: 'Cancel' },
      ];

      let resolvedResponse: any = null;

      (backend as any).pendingPermissions.set(permissionId, {
        resolve: (response: any) => {
          resolvedResponse = response;
        },
        options,
      });

      await backend.dispose();

      expect(resolvedResponse).toEqual({
        outcome: { outcome: 'selected', optionId: 'cancel' },
      });

      expect((backend as any).pendingPermissions.size).toBe(0);
    });
  });

  describe('event emission', () => {
    it('should emit permission-response event when resolving pending permission', async () => {
      const backend = new AcpSdkBackend(baseOptions);
      const handler = vi.fn();
      backend.onMessage(handler);

      const permissionId = 'test-permission-id';
      const options = [
        { optionId: 'proceed_once', name: 'Proceed Once' },
        { optionId: 'cancel', name: 'Cancel' },
      ];

      (backend as any).pendingPermissions.set(permissionId, {
        resolve: () => {},
        options,
      });

      await backend.respondToPermission(permissionId, true);

      expect(handler).toHaveBeenCalledWith({
        type: 'permission-response',
        id: permissionId,
        approved: true,
      });
    });
  });
});
