/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';
import type { DirResult } from 'tmp';

/**
 * Possible session status values returned by get-session-status RPC
 * @see HAP-642
 */
export type SessionStatus = 'active' | 'stopped' | 'unknown';

/**
 * Response from get-session-status RPC handler
 * @see HAP-642
 */
export interface GetSessionStatusResponse {
    status: SessionStatus;
    /** Session ID in UUID format (normalized) */
    sessionId: string;
    /** Human-readable message explaining the status */
    message?: string;
    /** Session metadata if available and active */
    metadata?: {
        startedBy: string;
        pid?: number;
    };
}

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** Temporary directory created for Codex sessions (for auth.json storage). Cleaned up on session exit. */
  codexTempDir?: DirResult;
}


/**
 * Configuration for rate limiting on the control server.
 */
export interface RateLimitConfig {
  /** Maximum number of requests allowed per time window. Default: 100 */
  maxRequests: number;
  /** Time window in milliseconds. Default: 60000 (1 minute) */
  windowMs: number;
}

/**
 * Internal state for the sliding window rate limiter.
 */
export interface RateLimiterState {
  /** Number of requests in the current window */
  count: number;
  /** Timestamp when the current window started */
  windowStart: number;
}

/**
 * Metrics tracking for rate limiting.
 */
export interface RateLimitMetrics {
  /** Total number of requests received */
  totalRequests: number;
  /** Number of requests that were rate limited */
  rateLimitedRequests: number;
  /** Number of times the rate limit window has reset */
  windowResets: number;
}
