/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import { timingSafeEqual } from 'crypto';
import fastify from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { TrackedSession, RateLimitConfig, RateLimiterState, RateLimitMetrics } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

/** Default rate limit configuration */
const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 100,
  windowMs: 60000 // 1 minute
};

export function startDaemonControlServer({
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onHappySessionWebhook,
  authToken,
  startTime,
  rateLimit = DEFAULT_RATE_LIMIT
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  authToken: string;
  startTime: number;
  rateLimit?: RateLimitConfig;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const app = fastify({
      logger: false // We use our own logger
    });

    // Rate limiter state - sliding window algorithm
    const rateLimiterState: RateLimiterState = {
      count: 0,
      windowStart: Date.now()
    };

    // Rate limit metrics
    const rateLimitMetrics: RateLimitMetrics = {
      totalRequests: 0,
      rateLimitedRequests: 0,
      windowResets: 0
    };

    /**
     * Check if request should be rate limited.
     * Uses sliding window algorithm: resets counter when window expires.
     * @returns Object with allowed status and reset info
     */
    function checkRateLimit(): { allowed: boolean; remaining: number; resetAt: number } {
      const now = Date.now();
      rateLimitMetrics.totalRequests++;

      // Check if window has expired
      if (now > rateLimiterState.windowStart + rateLimit.windowMs) {
        rateLimiterState.count = 0;
        rateLimiterState.windowStart = now;
        rateLimitMetrics.windowResets++;
      }

      const resetAt = rateLimiterState.windowStart + rateLimit.windowMs;
      const remaining = Math.max(0, rateLimit.maxRequests - rateLimiterState.count - 1);

      // Check if over limit
      if (rateLimiterState.count >= rateLimit.maxRequests) {
        rateLimitMetrics.rateLimitedRequests++;
        return { allowed: false, remaining: 0, resetAt };
      }

      // Increment counter and allow request
      rateLimiterState.count++;
      return { allowed: true, remaining, resetAt };
    }

    // Rate limiting middleware - applied before authentication to prevent DoS
    app.addHook('preHandler', async (request, reply) => {
      const { allowed, remaining, resetAt } = checkRateLimit();

      // Always set rate limit headers
      const retryAfterSeconds = Math.ceil((resetAt - Date.now()) / 1000);
      reply.header('X-RateLimit-Limit', rateLimit.maxRequests);
      reply.header('X-RateLimit-Remaining', remaining);
      reply.header('X-RateLimit-Reset', Math.ceil(resetAt / 1000));

      if (!allowed) {
        logger.debug(`[CONTROL SERVER] Rate limit exceeded - requests: ${rateLimitMetrics.totalRequests}, limited: ${rateLimitMetrics.rateLimitedRequests}`);
        reply.header('Retry-After', retryAfterSeconds);
        reply.code(429).send({
          error: 'Rate limit exceeded',
          retryAfter: retryAfterSeconds,
          limit: rateLimit.maxRequests,
          remaining: 0,
          resetAt: new Date(resetAt).toISOString()
        });
        return;
      }
    });

    // Authentication middleware - all requests require valid token
    app.addHook('preHandler', async (request, reply) => {
      const providedToken = request.headers['x-daemon-auth'];

      // Handle missing or invalid token types (headers can be string | string[] | undefined)
      if (!providedToken || Array.isArray(providedToken)) {
        logger.debug('[CONTROL SERVER] Unauthorized request rejected - missing or invalid token');
        reply.code(403).send({ error: 'Unauthorized' });
        return;
      }

      // Use constant-time comparison to prevent timing attacks
      const providedBuffer = Buffer.from(providedToken, 'utf8');
      const authBuffer = Buffer.from(authToken, 'utf8');

      if (providedBuffer.length !== authBuffer.length ||
          !timingSafeEqual(providedBuffer, authBuffer)) {
        logger.debug('[CONTROL SERVER] Unauthorized request rejected');
        reply.code(403).send({ error: 'Unauthorized' });
        return;
      }
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          metadata: z.any() // Metadata type from API
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata } = request.body as { sessionId: string; metadata: any };

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
      onHappySessionWebhook(sessionId, metadata);

      return { status: 'ok' as const };
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              happySessionId: z.string(),
              pid: z.number()
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return { 
        children: children
          .filter(child => child.happySessionId !== undefined)
          .map(child => ({
            startedBy: child.startedBy,
            happySessionId: child.happySessionId!,
            pid: child.pid
          }))
      }
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string()
        }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body as { sessionId: string };

      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
      const success = stopSession(sessionId);
      return { success };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: z.string(),
          sessionId: z.string().optional()
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId } = request.body as { directory: string; sessionId?: string };

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}`);
      const result = await spawnSession({ directory, sessionId });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true,
            message: result.message
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'error':
          reply.code(500);
          return { 
            success: false,
            error: result.errorMessage
          };
      }
    });

    // Stop daemon
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.string()
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] Stop daemon request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' };
    });

    // Health check endpoint
    typed.get('/health', {
      schema: {
        response: {
          200: z.object({
            status: z.enum(['healthy', 'degraded', 'unhealthy']),
            uptime: z.number(),
            sessions: z.number(),
            memory: z.object({
              rss: z.number(),
              heapUsed: z.number(),
              heapTotal: z.number(),
              external: z.number()
            }),
            rateLimit: z.object({
              config: z.object({
                maxRequests: z.number(),
                windowMs: z.number()
              }),
              metrics: z.object({
                totalRequests: z.number(),
                rateLimitedRequests: z.number(),
                windowResets: z.number()
              }),
              current: z.object({
                requestsInWindow: z.number(),
                remaining: z.number(),
                windowResetAt: z.string()
              })
            }),
            timestamp: z.string()
          })
        }
      }
    }, async () => {
      const children = getChildren();
      const memoryUsage = process.memoryUsage();
      const uptime = Date.now() - startTime;

      // Determine health status based on memory pressure
      // Consider unhealthy if heap usage exceeds 90% of total
      const heapPercent = memoryUsage.heapUsed / memoryUsage.heapTotal;
      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      if (heapPercent > 0.9) {
        status = 'unhealthy';
      } else if (heapPercent > 0.75) {
        status = 'degraded';
      }

      // Calculate current rate limit state
      const windowResetAt = rateLimiterState.windowStart + rateLimit.windowMs;
      const remaining = Math.max(0, rateLimit.maxRequests - rateLimiterState.count);

      logger.debug(`[CONTROL SERVER] Health check: status=${status}, sessions=${children.length}, rateLimit=${rateLimitMetrics.rateLimitedRequests}/${rateLimitMetrics.totalRequests}`);

      return {
        status,
        uptime,
        sessions: children.length,
        memory: {
          rss: memoryUsage.rss,
          heapUsed: memoryUsage.heapUsed,
          heapTotal: memoryUsage.heapTotal,
          external: memoryUsage.external
        },
        rateLimit: {
          config: {
            maxRequests: rateLimit.maxRequests,
            windowMs: rateLimit.windowMs
          },
          metrics: {
            totalRequests: rateLimitMetrics.totalRequests,
            rateLimitedRequests: rateLimitMetrics.rateLimitedRequests,
            windowResets: rateLimitMetrics.windowResets
          },
          current: {
            requestsInWindow: rateLimiterState.count,
            remaining,
            windowResetAt: new Date(windowResetAt).toISOString()
          }
        },
        timestamp: new Date().toISOString()
      };
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        reject(err);
        return;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}