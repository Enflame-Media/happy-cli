import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDeduplicator, deduplicatedRequest } from './requestDeduplication';

describe('Request Deduplication', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('createDeduplicator', () => {
    it('should deduplicate concurrent requests with the same key', async () => {
      const dedup = createDeduplicator<number>();
      const mockFn = vi.fn().mockResolvedValue(42);

      const [result1, result2, result3] = await Promise.all([
        dedup.request('key1', mockFn),
        dedup.request('key1', mockFn),
        dedup.request('key1', mockFn),
      ]);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(result1).toBe(42);
      expect(result2).toBe(42);
      expect(result3).toBe(42);
      expect(dedup.pendingCount()).toBe(0);
    });

    it('should execute requests with different keys independently', async () => {
      const dedup = createDeduplicator<number>();
      const mockFn1 = vi.fn().mockResolvedValue(1);
      const mockFn2 = vi.fn().mockResolvedValue(2);

      const [result1, result2] = await Promise.all([
        dedup.request('key1', mockFn1),
        dedup.request('key2', mockFn2),
      ]);

      expect(mockFn1).toHaveBeenCalledTimes(1);
      expect(mockFn2).toHaveBeenCalledTimes(1);
      expect(result1).toBe(1);
      expect(result2).toBe(2);
    });

    it('should cleanup after request completes', async () => {
      const dedup = createDeduplicator<string>();
      const mockFn = vi.fn().mockResolvedValue('done');

      expect(dedup.pendingCount()).toBe(0);
      const promise = dedup.request('key1', mockFn);
      expect(dedup.pendingCount()).toBe(1);
      await promise;
      expect(dedup.pendingCount()).toBe(0);
    });

    it('should cleanup after request fails', async () => {
      const dedup = createDeduplicator<string>();
      const error = new Error('Request failed');
      const mockFn = vi.fn().mockRejectedValue(error);

      expect(dedup.pendingCount()).toBe(0);
      const promise = dedup.request('key1', mockFn);
      expect(dedup.pendingCount()).toBe(1);

      await expect(promise).rejects.toThrow(/Request failed/);
      expect(dedup.pendingCount()).toBe(0);
    });

    it('should share errors among deduplicated requests', async () => {
      const dedup = createDeduplicator<string>();
      const error = new Error('Network error');
      const mockFn = vi.fn().mockRejectedValue(error);

      const promises = [
        dedup.request('key1', mockFn),
        dedup.request('key1', mockFn),
        dedup.request('key1', mockFn),
      ];

      expect(mockFn).toHaveBeenCalledTimes(1);

      for (const promise of promises) {
        await expect(promise).rejects.toThrow(/Network error/);
      }
    });

    it('should allow retry after failed request', async () => {
      const dedup = createDeduplicator<number>();
      const mockFn = vi.fn()
        .mockRejectedValueOnce(new Error('First attempt failed'))
        .mockResolvedValueOnce(42);

      // First attempt fails
      await expect(dedup.request('key1', mockFn)).rejects.toThrow('First attempt failed');

      // Retry should succeed
      const result = await dedup.request('key1', mockFn);
      expect(result).toBe(42);
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should call onDeduplicated callback when request is deduplicated', async () => {
      const onDeduplicated = vi.fn();
      const dedup = createDeduplicator<number>({ onDeduplicated });
      const mockFn = vi.fn().mockResolvedValue(42);

      await Promise.all([
        dedup.request('key1', mockFn),
        dedup.request('key1', mockFn),
        dedup.request('key1', mockFn),
      ]);

      expect(onDeduplicated).toHaveBeenCalledTimes(2);
      expect(onDeduplicated).toHaveBeenCalledWith('key1');
    });

    it('should not call onDeduplicated for the first request', async () => {
      const onDeduplicated = vi.fn();
      const dedup = createDeduplicator<number>({ onDeduplicated });
      const mockFn = vi.fn().mockResolvedValue(42);

      await dedup.request('key1', mockFn);

      expect(onDeduplicated).not.toHaveBeenCalled();
    });

    it('should timeout stale requests when timeoutMs is set', async () => {
      const dedup = createDeduplicator<number>({ timeoutMs: 1000 });
      const mockFn = vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(42), 5000))
      );

      const promise = dedup.request('key1', mockFn);
      expect(dedup.pendingCount()).toBe(1);

      // Fast-forward past timeout
      await vi.advanceTimersByTimeAsync(1000);

      // Should be removed from cache due to timeout
      expect(dedup.pendingCount()).toBe(0);

      // But the original promise should still work
      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toBe(42);
    });

    it('should clear timeout on successful completion', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const dedup = createDeduplicator<number>({ timeoutMs: 5000 });
      const mockFn = vi.fn().mockResolvedValue(42);

      await dedup.request('key1', mockFn);

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('should handle race condition between timeout and cleanup', async () => {
      const dedup = createDeduplicator<number>({ timeoutMs: 100 });
      const mockFn = vi.fn().mockResolvedValue(42);

      // Start a request
      const promise = dedup.request('key1', mockFn);

      // Advance time close to timeout
      await vi.advanceTimersByTimeAsync(50);

      // Request completes
      await promise;

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(100);

      // Should not cause issues
      expect(dedup.pendingCount()).toBe(0);
    });

    it('should track multiple concurrent pending requests', () => {
      const dedup = createDeduplicator<number>();
      const slowFn = () => new Promise<number>(resolve => setTimeout(() => resolve(1), 1000));

      dedup.request('key1', slowFn);
      dedup.request('key2', slowFn);
      dedup.request('key3', slowFn);

      expect(dedup.pendingCount()).toBe(3);
      expect(dedup.hasPending('key1')).toBe(true);
      expect(dedup.hasPending('key2')).toBe(true);
      expect(dedup.hasPending('key3')).toBe(true);
      expect(dedup.hasPending('key4')).toBe(false);
    });

    it('should clear all pending requests', async () => {
      const dedup = createDeduplicator<number>({ timeoutMs: 5000 });
      const slowFn = () => new Promise<number>(resolve => setTimeout(() => resolve(1), 1000));

      dedup.request('key1', slowFn);
      dedup.request('key2', slowFn);
      dedup.request('key3', slowFn);

      expect(dedup.pendingCount()).toBe(3);

      dedup.clear();

      expect(dedup.pendingCount()).toBe(0);
      expect(dedup.hasPending('key1')).toBe(false);
    });

    it('should clear timeouts when clear() is called', () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const dedup = createDeduplicator<number>({ timeoutMs: 5000 });
      const slowFn = () => new Promise<number>(resolve => setTimeout(() => resolve(1), 1000));

      dedup.request('key1', slowFn);
      dedup.request('key2', slowFn);

      dedup.clear();

      expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    });

    it('should handle sequential requests after first completes', async () => {
      const dedup = createDeduplicator<number>();
      const mockFn = vi.fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2);

      const result1 = await dedup.request('key1', mockFn);
      expect(result1).toBe(1);

      const result2 = await dedup.request('key1', mockFn);
      expect(result2).toBe(2);

      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('deduplicatedRequest (global)', () => {
    it('should deduplicate concurrent global requests', async () => {
      const mockFn = vi.fn().mockResolvedValue('global-result');

      const [result1, result2] = await Promise.all([
        deduplicatedRequest('global-key-1', mockFn),
        deduplicatedRequest('global-key-1', mockFn),
      ]);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(result1).toBe('global-result');
      expect(result2).toBe('global-result');
    });

    it('should execute different global keys independently', async () => {
      const mockFn1 = vi.fn().mockResolvedValue('result-1');
      const mockFn2 = vi.fn().mockResolvedValue('result-2');

      const [result1, result2] = await Promise.all([
        deduplicatedRequest('global-key-a', mockFn1),
        deduplicatedRequest('global-key-b', mockFn2),
      ]);

      expect(mockFn1).toHaveBeenCalledTimes(1);
      expect(mockFn2).toHaveBeenCalledTimes(1);
      expect(result1).toBe('result-1');
      expect(result2).toBe('result-2');
    });

    it('should handle different return types', async () => {
      const stringFn = vi.fn().mockResolvedValue('string');
      const numberFn = vi.fn().mockResolvedValue(123);
      const objectFn = vi.fn().mockResolvedValue({ foo: 'bar' });

      const stringResult = await deduplicatedRequest('str-key', stringFn);
      const numberResult = await deduplicatedRequest('num-key', numberFn);
      const objectResult = await deduplicatedRequest('obj-key', objectFn);

      expect(stringResult).toBe('string');
      expect(numberResult).toBe(123);
      expect(objectResult).toEqual({ foo: 'bar' });
    });

    it('should cleanup global requests after completion', async () => {
      const mockFn = vi.fn().mockResolvedValue('done');

      await deduplicatedRequest('cleanup-key', mockFn);

      // Should allow a new request to execute
      mockFn.mockClear();
      await deduplicatedRequest('cleanup-key', mockFn);

      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should share errors globally', async () => {
      const error = new Error('Global error');
      const mockFn = vi.fn().mockRejectedValue(error);

      const promises = [
        deduplicatedRequest('error-key', mockFn),
        deduplicatedRequest('error-key', mockFn),
      ];

      for (const promise of promises) {
        await expect(promise).rejects.toThrow('Global error');
      }

      expect(mockFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('Type Safety', () => {
    it('should preserve type information for scoped deduplicator', async () => {
      interface User {
        id: string;
        name: string;
      }

      const dedup = createDeduplicator<User>();
      const mockUser: User = { id: '123', name: 'Test User' };
      const mockFn = vi.fn().mockResolvedValue(mockUser);

      const result: User = await dedup.request('user-123', mockFn);

      // TypeScript should infer this correctly
      expect(result.id).toBe('123');
      expect(result.name).toBe('Test User');
    });

    it('should preserve type information for global deduplicator', async () => {
      interface Product {
        sku: string;
        price: number;
      }

      const mockProduct: Product = { sku: 'ABC123', price: 99.99 };
      const mockFn = vi.fn().mockResolvedValue(mockProduct);

      const result: Product = await deduplicatedRequest<Product>('product-abc', mockFn);

      // TypeScript should infer this correctly
      expect(result.sku).toBe('ABC123');
      expect(result.price).toBe(99.99);
    });
  });

  describe('Edge Cases', () => {
    it('should handle requests that never complete without timeout', async () => {
      const dedup = createDeduplicator<number>();
      const neverResolves = () => new Promise<number>(() => {});

      const _promise = dedup.request('stuck', neverResolves);
      expect(dedup.pendingCount()).toBe(1);

      // Promise will never resolve, but shouldn't crash
      expect(dedup.hasPending('stuck')).toBe(true);

      // Can still clear it
      dedup.clear();
      expect(dedup.pendingCount()).toBe(0);
    });

    it('should handle empty keys', async () => {
      const dedup = createDeduplicator<string>();
      const mockFn = vi.fn().mockResolvedValue('empty-key-result');

      const result = await dedup.request('', mockFn);
      expect(result).toBe('empty-key-result');
    });

    it('should handle very long keys', async () => {
      const dedup = createDeduplicator<string>();
      const longKey = 'k'.repeat(10000);
      const mockFn = vi.fn().mockResolvedValue('long-key-result');

      const result = await dedup.request(longKey, mockFn);
      expect(result).toBe('long-key-result');
    });

    it('should handle rapid sequential requests', async () => {
      const dedup = createDeduplicator<number>();
      const results: number[] = [];

      for (let i = 0; i < 100; i++) {
        const mockFn = vi.fn().mockResolvedValue(i);
        const result = await dedup.request(`key-${i}`, mockFn);
        results.push(result);
      }

      expect(results).toHaveLength(100);
      expect(results[0]).toBe(0);
      expect(results[99]).toBe(99);
    });

    it('should handle Promise.race scenarios', async () => {
      const dedup = createDeduplicator<string>();
      const fastFn = vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve('fast'), 10))
      );
      const slowFn = vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve('slow'), 100))
      );

      const fastPromise = dedup.request('race-key', fastFn);
      await vi.advanceTimersByTimeAsync(5);
      const slowPromise = dedup.request('race-key', fastFn);

      // Both should get the same result
      await vi.advanceTimersByTimeAsync(100);
      const [fast, slow] = await Promise.all([fastPromise, slowPromise]);

      expect(fast).toBe('fast');
      expect(slow).toBe('fast');
      expect(fastFn).toHaveBeenCalledTimes(1);
      expect(slowFn).not.toHaveBeenCalled();
    });
  });

  describe('Real-world Scenarios', () => {
    it('should handle API client pattern with machine registration', async () => {
      interface Machine {
        id: string;
        status: string;
      }

      const dedup = createDeduplicator<Machine>({ timeoutMs: 30000 });
      const apiCall = vi.fn().mockResolvedValue({ id: 'machine-1', status: 'active' });

      // Simulate multiple components requesting the same machine registration
      const [result1, result2, result3] = await Promise.all([
        dedup.request('machine:machine-1', apiCall),
        dedup.request('machine:machine-1', apiCall),
        dedup.request('machine:machine-1', apiCall),
      ]);

      expect(apiCall).toHaveBeenCalledTimes(1);
      expect(result1.id).toBe('machine-1');
      expect(result2).toBe(result1); // Same object reference
      expect(result3).toBe(result1); // Same object reference
    });

    it('should handle vendor token registration pattern', async () => {
      const dedup = createDeduplicator<void>({ timeoutMs: 30000 });
      const registerToken = vi.fn().mockResolvedValue(undefined);

      // Simulate multiple components trying to register the same vendor token
      await Promise.all([
        dedup.request('vendor:anthropic', registerToken),
        dedup.request('vendor:anthropic', registerToken),
        dedup.request('vendor:anthropic', registerToken),
      ]);

      expect(registerToken).toHaveBeenCalledTimes(1);
    });

    it('should handle network retry pattern', async () => {
      const dedup = createDeduplicator<string>();
      let attempt = 0;
      const unreliableApi = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt < 3) {
          throw new Error('Network error');
        }
        return 'success';
      });

      // First two attempts fail
      await expect(dedup.request('api-call', unreliableApi)).rejects.toThrow('Network error');
      await expect(dedup.request('api-call', unreliableApi)).rejects.toThrow('Network error');

      // Third attempt succeeds
      const result = await dedup.request('api-call', unreliableApi);
      expect(result).toBe('success');
    });
  });
});
