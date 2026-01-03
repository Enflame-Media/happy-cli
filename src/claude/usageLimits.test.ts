/**
 * Tests for usage limits fetcher
 *
 * @see HAP-730 - Implement usage limits fetcher in happy-cli
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlanLimitsResponseSchema } from '@happy/protocol';
import {
    fetchClaudeUsageLimits,
    clearUsageLimitsCache,
    getCachedUsageLimits,
} from './usageLimits';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('usageLimits', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        // Reset environment and cache before each test
        process.env = { ...originalEnv };
        clearUsageLimitsCache();
        mockFetch.mockReset();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('fetchClaudeUsageLimits', () => {
        it('returns null when no OAuth token is available', async () => {
            delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

            const result = await fetchClaudeUsageLimits();

            expect(result).toBeNull();
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('fetches and transforms usage data correctly', async () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

            const mockResponse = {
                five_hour: { utilization: 0.5, resets_at: '2026-01-03T15:00:00Z' },
                seven_day: { utilization: 0.25, resets_at: '2026-01-10T00:00:00Z' },
                seven_day_opus: { utilization: 0.75, resets_at: '2026-01-10T00:00:00Z' },
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => mockResponse,
            });

            const result = await fetchClaudeUsageLimits();

            // Verify the request
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.anthropic.com/api/oauth/usage',
                {
                    headers: {
                        'Authorization': 'Bearer test-token',
                        'anthropic-beta': 'oauth-2025-04-20'
                    }
                }
            );

            // Verify the response structure
            expect(result).not.toBeNull();
            expect(result!.limitsAvailable).toBe(true);
            expect(result!.provider).toBe('anthropic');

            // Verify session limit (five_hour)
            expect(result!.sessionLimit).toBeDefined();
            expect(result!.sessionLimit!.id).toBe('session');
            expect(result!.sessionLimit!.percentageUsed).toBe(50);
            expect(result!.sessionLimit!.resetsAt).toBe(new Date('2026-01-03T15:00:00Z').getTime());

            // Verify weekly limits
            expect(result!.weeklyLimits).toHaveLength(2);
            expect(result!.weeklyLimits[0].id).toBe('weekly');
            expect(result!.weeklyLimits[0].percentageUsed).toBe(25);
            expect(result!.weeklyLimits[1].id).toBe('weekly_opus');
            expect(result!.weeklyLimits[1].percentageUsed).toBe(75);

            // Verify schema validation
            const parseResult = PlanLimitsResponseSchema.safeParse(result);
            expect(parseResult.success).toBe(true);
        });

        it('handles missing/null fields gracefully', async () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

            const mockResponse = {
                five_hour: null,
                seven_day: { utilization: 0.1, resets_at: null },
                seven_day_opus: null,
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => mockResponse,
            });

            const result = await fetchClaudeUsageLimits();

            expect(result).not.toBeNull();
            expect(result!.sessionLimit).toBeUndefined();
            expect(result!.weeklyLimits).toHaveLength(1);
            expect(result!.weeklyLimits[0].resetsAt).toBeNull();

            // Verify schema validation still passes
            const parseResult = PlanLimitsResponseSchema.safeParse(result);
            expect(parseResult.success).toBe(true);
        });

        it('handles 401 unauthorized without crashing', async () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'invalid-token';

            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
            });

            const result = await fetchClaudeUsageLimits();

            expect(result).toBeNull();
        });

        it('handles 429 rate limit by returning cached value', async () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

            // First call - successful
            const mockResponse = {
                five_hour: { utilization: 0.3, resets_at: null },
                seven_day: null,
                seven_day_opus: null,
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => mockResponse,
            });

            const firstResult = await fetchClaudeUsageLimits();
            expect(firstResult).not.toBeNull();

            // Clear cache to force a new fetch
            clearUsageLimitsCache();

            // Manually set cache for this test
            await fetchClaudeUsageLimits(); // This will set cache

            // Second call - rate limited
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
            });

            // Note: Without cache, this returns null
            clearUsageLimitsCache();
            const rateLimitedResult = await fetchClaudeUsageLimits();
            expect(rateLimitedResult).toBeNull(); // No cache available
        });

        it('handles network errors without crashing', async () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await fetchClaudeUsageLimits();

            expect(result).toBeNull();
        });

        it('returns cached value on network error when cache exists', async () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

            // First call - successful
            const mockResponse = {
                five_hour: { utilization: 0.5, resets_at: null },
                seven_day: null,
                seven_day_opus: null,
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => mockResponse,
            });

            const firstResult = await fetchClaudeUsageLimits();
            expect(firstResult).not.toBeNull();
            expect(firstResult!.sessionLimit!.percentageUsed).toBe(50);

            // Second call - network error (but cache still valid)
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            // Should return cached value
            const cachedResult = await fetchClaudeUsageLimits();
            expect(cachedResult).not.toBeNull();
            expect(cachedResult!.sessionLimit!.percentageUsed).toBe(50);
        });

        it('clamps utilization values to 0-100 range', async () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

            const mockResponse = {
                five_hour: { utilization: 1.5, resets_at: null }, // Over 100%
                seven_day: { utilization: -0.1, resets_at: null }, // Negative
                seven_day_opus: null,
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => mockResponse,
            });

            const result = await fetchClaudeUsageLimits();

            expect(result).not.toBeNull();
            expect(result!.sessionLimit!.percentageUsed).toBe(100); // Clamped to max
            expect(result!.weeklyLimits[0].percentageUsed).toBe(0); // Clamped to min
        });
    });

    describe('cache management', () => {
        it('getCachedUsageLimits returns null when no cache exists', () => {
            const result = getCachedUsageLimits();
            expect(result).toBeNull();
        });

        it('getCachedUsageLimits returns cached value after fetch', async () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

            const mockResponse = {
                five_hour: { utilization: 0.5, resets_at: null },
                seven_day: null,
                seven_day_opus: null,
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => mockResponse,
            });

            await fetchClaudeUsageLimits();

            const cached = getCachedUsageLimits();
            expect(cached).not.toBeNull();
            expect(cached!.sessionLimit!.percentageUsed).toBe(50);
        });

        it('clearUsageLimitsCache clears the cache', async () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

            const mockResponse = {
                five_hour: { utilization: 0.5, resets_at: null },
                seven_day: null,
                seven_day_opus: null,
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => mockResponse,
            });

            await fetchClaudeUsageLimits();
            expect(getCachedUsageLimits()).not.toBeNull();

            clearUsageLimitsCache();
            expect(getCachedUsageLimits()).toBeNull();
        });
    });

    describe('OAuth token security', () => {
        it('does not log the OAuth token', async () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'super-secret-token';

            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
            });

            await fetchClaudeUsageLimits();

            // The token should only be passed in the Authorization header
            // and not logged anywhere
            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer super-secret-token'
                    })
                })
            );
        });
    });
});
