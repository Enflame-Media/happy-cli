/**
 * Usage limits fetcher for Claude OAuth API
 *
 * Fetches usage limit data from Anthropic's OAuth API and transforms it
 * to the Happy format for display in the mobile app.
 *
 * @see HAP-730 - Implement usage limits fetcher in happy-cli
 */

import type { PlanLimitsResponse, UsageLimit } from '@happy/protocol';
import { logger } from '@/ui/logger';

/** Anthropic OAuth usage API endpoint */
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** Cache TTL in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Polling interval in milliseconds (60 seconds) */
export const USAGE_LIMITS_POLL_INTERVAL_MS = 60 * 1000;

/**
 * Anthropic usage API response format
 */
interface AnthropicUsageResponse {
    /** 5-hour rolling session limit */
    five_hour: { utilization: number; resets_at: string | null } | null;
    /** 7-day rolling limit */
    seven_day: { utilization: number; resets_at: string | null } | null;
    /** 7-day Opus-specific limit */
    seven_day_opus: { utilization: number; resets_at: string | null } | null;
}

/**
 * Cached usage limits response
 */
interface CachedUsageLimits {
    data: PlanLimitsResponse;
    cachedAt: number;
}

/** Cached response with TTL */
let cachedLimits: CachedUsageLimits | null = null;

/**
 * Parse ISO timestamp to Unix milliseconds
 *
 * @param isoTimestamp - ISO 8601 timestamp string or null
 * @returns Unix timestamp in milliseconds, or null if input is null/invalid
 */
function parseResetTimestamp(isoTimestamp: string | null): number | null {
    if (!isoTimestamp) return null;
    const timestamp = new Date(isoTimestamp).getTime();
    return isNaN(timestamp) ? null : timestamp;
}

/**
 * Transform a single Anthropic limit to Happy format
 *
 * @param id - Limit identifier
 * @param label - Human-readable label
 * @param utilization - Percentage used (0-1 from Anthropic API)
 * @param resetsAt - ISO timestamp when limit resets
 * @param description - Optional description
 * @returns UsageLimit in Happy format
 */
function transformLimit(
    id: string,
    label: string,
    utilization: number,
    resetsAt: string | null,
    description?: string
): UsageLimit {
    return {
        id,
        label,
        percentageUsed: Math.min(100, Math.max(0, utilization * 100)),
        resetsAt: parseResetTimestamp(resetsAt),
        resetDisplayType: 'countdown',
        ...(description && { description }),
    };
}

/**
 * Transform Anthropic API response to Happy format
 *
 * Mapping:
 * - five_hour → sessionLimit (5-hour rolling session limit)
 * - seven_day → weeklyLimits[0] (7-day rolling limit)
 * - seven_day_opus → weeklyLimits[1] (7-day Opus-specific limit)
 *
 * @param data - Anthropic usage API response
 * @returns PlanLimitsResponse in Happy format
 */
function transformToHappyFormat(data: AnthropicUsageResponse): PlanLimitsResponse {
    const weeklyLimits: UsageLimit[] = [];

    // Transform session limit (five_hour)
    const sessionLimit = data.five_hour
        ? transformLimit(
            'session',
            'Session Limit',
            data.five_hour.utilization,
            data.five_hour.resets_at,
            '5-hour rolling usage limit'
        )
        : undefined;

    // Transform 7-day limit
    if (data.seven_day) {
        weeklyLimits.push(
            transformLimit(
                'weekly',
                'Weekly Limit',
                data.seven_day.utilization,
                data.seven_day.resets_at,
                '7-day rolling usage limit'
            )
        );
    }

    // Transform 7-day Opus limit
    if (data.seven_day_opus) {
        weeklyLimits.push(
            transformLimit(
                'weekly_opus',
                'Weekly Opus Limit',
                data.seven_day_opus.utilization,
                data.seven_day_opus.resets_at,
                '7-day rolling Opus model limit'
            )
        );
    }

    return {
        sessionLimit,
        weeklyLimits,
        lastUpdatedAt: Date.now(),
        limitsAvailable: true,
        provider: 'anthropic',
    };
}

/**
 * Fetch Claude usage limits from Anthropic OAuth API
 *
 * Uses the CLAUDE_CODE_OAUTH_TOKEN environment variable for authentication.
 * Returns cached value on network errors with 5-minute TTL.
 *
 * @returns PlanLimitsResponse if successful, null if token unavailable or API error
 */
export async function fetchClaudeUsageLimits(): Promise<PlanLimitsResponse | null> {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) {
        logger.debug('[UsageLimits] No OAuth token available');
        return null;
    }

    // Return cached value if still valid
    if (cachedLimits && (Date.now() - cachedLimits.cachedAt) < CACHE_TTL_MS) {
        logger.debug('[UsageLimits] Returning cached limits');
        return cachedLimits.data;
    }

    try {
        const response = await fetch(ANTHROPIC_USAGE_URL, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'anthropic-beta': 'oauth-2025-04-20'
            }
        });

        if (response.status === 401) {
            logger.debug('[UsageLimits] Unauthorized - token may be invalid or expired');
            return null;
        }

        if (response.status === 429) {
            logger.debug('[UsageLimits] Rate limited - returning cached value if available');
            return cachedLimits?.data ?? null;
        }

        if (!response.ok) {
            logger.debug(`[UsageLimits] API error: ${response.status} ${response.statusText}`);
            return cachedLimits?.data ?? null;
        }

        const data = await response.json() as AnthropicUsageResponse;
        const transformed = transformToHappyFormat(data);

        // Update cache
        cachedLimits = {
            data: transformed,
            cachedAt: Date.now()
        };

        logger.debug('[UsageLimits] Successfully fetched and cached limits');
        return transformed;
    } catch (error) {
        // Network error - return cached value if available
        logger.debug('[UsageLimits] Failed to fetch:', error);
        return cachedLimits?.data ?? null;
    }
}

/**
 * Clear the usage limits cache
 *
 * Useful for testing or forcing a refresh
 */
export function clearUsageLimitsCache(): void {
    cachedLimits = null;
}

/**
 * Get cached usage limits without fetching
 *
 * @returns Cached PlanLimitsResponse if available and not expired, null otherwise
 */
export function getCachedUsageLimits(): PlanLimitsResponse | null {
    if (!cachedLimits) return null;
    if ((Date.now() - cachedLimits.cachedAt) >= CACHE_TTL_MS) return null;
    return cachedLimits.data;
}
