/**
 * Unit tests for HappyWebSocket
 * - HAP-351: Auth token security (headers instead of URL query params)
 * - HAP-353: Bounds enforcement and cleanup
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HappyWebSocket } from './HappyWebSocket';

// Mock the logger to prevent file I/O during tests
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Track WebSocket constructor calls to verify connection parameters
let lastWebSocketUrl: string | null = null;
let lastWebSocketOptions: { headers?: Record<string, string> } | null = null;

// Mock ws module - captures constructor arguments for verification
// Use a function (not arrow) so it can be called with `new`
vi.mock('ws', () => {
  const MockWebSocket = vi.fn(function(this: unknown, url: string, options?: { headers?: Record<string, string> }) {
    lastWebSocketUrl = url;
    lastWebSocketOptions = options ?? null;
    // Return mock methods
    return {
      on: vi.fn(),
      close: vi.fn(),
      send: vi.fn(),
      terminate: vi.fn(),
    };
  });
  return { default: MockWebSocket };
});

describe('HappyWebSocket', () => {
  let socket: HappyWebSocket;
  const mockAuth = {
    token: 'test-token',
    machineId: 'test-machine',
    sessionId: 'test-session',
    clientType: 'session-scoped' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    lastWebSocketUrl = null;
    lastWebSocketOptions = null;
    socket = new HappyWebSocket('ws://localhost', mockAuth);
  });

  describe('auth token security (HAP-351)', () => {
    it('should pass auth credentials via headers, not URL query params', () => {
      // Trigger connection to capture WebSocket constructor args
      socket.connect();

      // Verify URL does NOT contain token
      expect(lastWebSocketUrl).toBeDefined();
      const url = new URL(lastWebSocketUrl!);
      expect(url.searchParams.has('token')).toBe(false);
      expect(url.searchParams.has('clientType')).toBe(false);
      expect(url.searchParams.has('sessionId')).toBe(false);
      expect(url.searchParams.has('machineId')).toBe(false);

      // Verify headers contain auth credentials
      expect(lastWebSocketOptions).toBeDefined();
      expect(lastWebSocketOptions?.headers).toBeDefined();
      expect(lastWebSocketOptions?.headers?.['Authorization']).toBe(`Bearer ${mockAuth.token}`);
      expect(lastWebSocketOptions?.headers?.['X-Client-Type']).toBe(mockAuth.clientType);
      expect(lastWebSocketOptions?.headers?.['X-Session-Id']).toBe(mockAuth.sessionId);
      expect(lastWebSocketOptions?.headers?.['X-Machine-Id']).toBe(mockAuth.machineId);
    });

    it('should omit optional headers when auth fields are not provided', () => {
      // Create socket with minimal auth (no sessionId or machineId)
      const minimalAuth = {
        token: 'minimal-token',
        clientType: 'session-scoped' as const,
      };
      const minimalSocket = new HappyWebSocket('ws://localhost', minimalAuth);
      minimalSocket.connect();

      // Verify required headers are present
      expect(lastWebSocketOptions?.headers?.['Authorization']).toBe('Bearer minimal-token');
      expect(lastWebSocketOptions?.headers?.['X-Client-Type']).toBe('session-scoped');

      // Verify optional headers are NOT present (undefined values should not create headers)
      expect(lastWebSocketOptions?.headers?.['X-Session-Id']).toBeUndefined();
      expect(lastWebSocketOptions?.headers?.['X-Machine-Id']).toBeUndefined();
    });

    it('should use wss:// protocol for https:// base URLs', () => {
      const httpsSocket = new HappyWebSocket('https://api.example.com', mockAuth);
      httpsSocket.connect();

      expect(lastWebSocketUrl).toBeDefined();
      expect(lastWebSocketUrl).toMatch(/^wss:\/\//);
    });

    it('should use ws:// protocol for http:// base URLs', () => {
      const httpSocket = new HappyWebSocket('http://localhost:3000', mockAuth);
      httpSocket.connect();

      expect(lastWebSocketUrl).toBeDefined();
      expect(lastWebSocketUrl).toMatch(/^ws:\/\//);
    });
  });

  describe('handler bounds enforcement (HAP-353)', () => {
    it('should allow adding handlers up to the limit', () => {
      const event = 'test-event';

      // Add handlers up to but not exceeding the limit
      for (let i = 0; i < 100; i++) {
        socket.on(event, () => {});
      }

      const stats = socket.getStats();
      expect(stats.totalHandlers).toBe(100);
      expect(stats.eventTypes).toBe(1);
    });

    it('should reject handlers beyond the limit', () => {
      const event = 'bounded-event';
      const handlers: (() => void)[] = [];

      // Add 100 handlers (the limit)
      for (let i = 0; i < 100; i++) {
        const handler = () => {};
        handlers.push(handler);
        socket.on(event, handler);
      }

      // This 101st handler should be rejected
      const rejectedHandler = () => {};
      socket.on(event, rejectedHandler);

      const stats = socket.getStats();
      expect(stats.totalHandlers).toBe(100);  // Still 100, not 101
    });

    it('should log warning at 90% threshold', async () => {
      const { logger } = await import('@/ui/logger');
      const event = 'threshold-event';

      // Add 90 handlers first
      for (let i = 0; i < 90; i++) {
        socket.on(event, () => {});
      }

      // Warning fires when adding the 91st handler (when size already == 90)
      socket.on(event, () => {});

      // Check that warn was called
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Handler count approaching limit')
      );
    });

    it('should track handlers per event independently', () => {
      // Add handlers to different events
      for (let i = 0; i < 50; i++) {
        socket.on('event-a', () => {});
        socket.on('event-b', () => {});
      }

      const stats = socket.getStats();
      expect(stats.totalHandlers).toBe(100);
      expect(stats.eventTypes).toBe(2);
    });

    it('should allow more handlers after removal', () => {
      const event = 'removal-test';
      const handlers: (() => void)[] = [];

      // Fill up to limit
      for (let i = 0; i < 100; i++) {
        const handler = () => {};
        handlers.push(handler);
        socket.on(event, handler);
      }

      expect(socket.getStats().totalHandlers).toBe(100);

      // Remove one handler
      socket.off(event, handlers[0]);
      expect(socket.getStats().totalHandlers).toBe(99);

      // Now we can add another
      socket.on(event, () => {});
      expect(socket.getStats().totalHandlers).toBe(100);
    });

    it('should clear all handlers with removeAllListeners', () => {
      for (let i = 0; i < 50; i++) {
        socket.on('event-1', () => {});
        socket.on('event-2', () => {});
      }

      expect(socket.getStats().totalHandlers).toBe(100);

      socket.removeAllListeners();

      expect(socket.getStats().totalHandlers).toBe(0);
      expect(socket.getStats().eventTypes).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return correct initial stats', () => {
      const stats = socket.getStats();
      expect(stats.totalHandlers).toBe(0);
      expect(stats.eventTypes).toBe(0);
      expect(stats.pendingAcks).toBe(0);
    });

    it('should track multiple event types', () => {
      socket.on('connect', () => {});
      socket.on('disconnect', () => {});
      socket.on('error', () => {});

      const stats = socket.getStats();
      expect(stats.eventTypes).toBe(3);
      expect(stats.totalHandlers).toBe(3);
    });
  });

  describe('cleanupStaleAcks', () => {
    it('should return 0 when no stale acks exist', () => {
      const cleaned = socket.cleanupStaleAcks();
      expect(cleaned).toBe(0);
    });
  });

  describe('onMemoryPressure', () => {
    it('should not throw when called', () => {
      expect(() => socket.onMemoryPressure()).not.toThrow();
    });
  });
});
