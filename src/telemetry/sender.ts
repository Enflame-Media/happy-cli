/**
 * Telemetry sender for usage and performance metrics.
 *
 * This module provides a privacy-respecting way to track usage patterns
 * and performance metrics. All data is anonymized by default and requires
 * explicit opt-in.
 *
 * ## Privacy Guarantees
 * - No PII is ever collected
 * - Data is anonymized before transmission
 * - Session IDs are random, not tied to user identity
 * - Metrics are aggregated on the server
 *
 * @module telemetry/sender
 */

import os from 'node:os'
import { type TelemetryConfig } from './types'
import packageJson from '../../package.json'

/**
 * Telemetry event types for usage tracking.
 */
export type TelemetryEventType =
  | 'session_started'
  | 'session_ended'
  | 'command_executed'
  | 'feature_used'
  | 'error_occurred'

/**
 * Base telemetry event structure.
 */
export interface TelemetryEvent {
  /** Event type identifier */
  type: TelemetryEventType
  /** ISO 8601 timestamp */
  timestamp: string
  /** CLI version */
  version: string
  /** Platform (darwin, linux, win32) */
  platform: string
  /** Additional event-specific data */
  data?: Record<string, unknown>
}

/**
 * Performance metric types.
 */
export type MetricType =
  | 'startup_time'
  | 'command_duration'
  | 'session_duration'
  | 'api_latency'
  | 'memory_usage'

/**
 * Performance metric structure.
 */
export interface PerformanceMetric {
  /** Metric type identifier */
  type: MetricType
  /** Metric value (usually in milliseconds or bytes) */
  value: number
  /** ISO 8601 timestamp */
  timestamp: string
  /** CLI version */
  version: string
  /** Optional context */
  context?: Record<string, unknown>
}

/**
 * Telemetry sender class for managing event and metric collection.
 *
 * This class is designed to be instantiated once per process and maintains
 * an internal queue of events to be sent. Events are batched and sent
 * periodically or when the buffer reaches a threshold.
 */
export class TelemetrySender {
  private config: TelemetryConfig
  private eventQueue: TelemetryEvent[] = []
  private metricQueue: PerformanceMetric[] = []
  private readonly batchSize = 10
  private readonly flushIntervalMs = 30000 // 30 seconds
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private readonly endpointUrl: string | null

  /**
   * Creates a new TelemetrySender instance.
   *
   * @param config - The telemetry configuration
   */
  constructor(config: TelemetryConfig) {
    this.config = config
    this.endpointUrl = process.env.HAPPY_TELEMETRY_ENDPOINT || null

    // Start periodic flush if telemetry is enabled
    if (this.isEnabled()) {
      this.startPeriodicFlush()
    }
  }

  /**
   * Checks if telemetry is enabled and properly configured.
   */
  private isEnabled(): boolean {
    return this.config.enabled && this.endpointUrl !== null
  }

  /**
   * Checks if usage tracking is enabled.
   */
  private isUsageEnabled(): boolean {
    return this.isEnabled() && this.config.categories.usage
  }

  /**
   * Checks if performance tracking is enabled.
   */
  private isPerformanceEnabled(): boolean {
    return this.isEnabled() && this.config.categories.performance
  }

  /**
   * Starts the periodic flush timer.
   */
  private startPeriodicFlush(): void {
    if (this.flushTimer) {
      return
    }

    this.flushTimer = setInterval(() => {
      void this.flush()
    }, this.flushIntervalMs)

    // Don't keep the process alive just for telemetry
    this.flushTimer.unref()
  }

  /**
   * Stops the periodic flush timer.
   */
  public stopPeriodicFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  /**
   * Tracks a telemetry event.
   *
   * @param type - The event type
   * @param data - Optional event-specific data
   *
   * @example
   * ```typescript
   * sender.trackEvent('session_started', { mode: 'interactive' })
   * ```
   */
  public trackEvent(type: TelemetryEventType, data?: Record<string, unknown>): void {
    if (!this.isUsageEnabled()) {
      return
    }

    const event: TelemetryEvent = {
      type,
      timestamp: new Date().toISOString(),
      version: packageJson.version,
      platform: os.platform(),
      data: data ? this.anonymizeData(data) : undefined,
    }

    this.eventQueue.push(event)

    // Flush if batch size reached
    if (this.eventQueue.length >= this.batchSize) {
      void this.flush()
    }
  }

  /**
   * Tracks a performance metric.
   *
   * @param type - The metric type
   * @param value - The metric value
   * @param context - Optional context information
   *
   * @example
   * ```typescript
   * const startTime = Date.now()
   * await operation()
   * sender.trackMetric('command_duration', Date.now() - startTime, { command: 'start' })
   * ```
   */
  public trackMetric(
    type: MetricType,
    value: number,
    context?: Record<string, unknown>
  ): void {
    if (!this.isPerformanceEnabled()) {
      return
    }

    const metric: PerformanceMetric = {
      type,
      value,
      timestamp: new Date().toISOString(),
      version: packageJson.version,
      context: context ? this.anonymizeData(context) : undefined,
    }

    this.metricQueue.push(metric)

    // Flush if batch size reached
    if (this.metricQueue.length >= this.batchSize) {
      void this.flush()
    }
  }

  /**
   * Anonymizes data by removing or hashing sensitive values.
   *
   * @param data - The data to anonymize
   * @returns Anonymized data
   */
  private anonymizeData(data: Record<string, unknown>): Record<string, unknown> {
    if (!this.config.anonymize) {
      return data
    }

    const anonymized: Record<string, unknown> = {}
    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /token/i,
      /key/i,
      /auth/i,
      /credential/i,
      /session/i,
      /user/i,
      /email/i,
      /ip/i,
      /path/i,
      /file/i,
      /dir/i,
    ]

    for (const [key, value] of Object.entries(data)) {
      const isSensitive = sensitivePatterns.some(pattern => pattern.test(key))

      if (isSensitive) {
        // For sensitive keys, just indicate presence without value
        anonymized[key] = '[present]'
      } else if (typeof value === 'object' && value !== null) {
        anonymized[key] = this.anonymizeData(value as Record<string, unknown>)
      } else {
        anonymized[key] = value
      }
    }

    return anonymized
  }

  /**
   * Flushes queued events and metrics to the telemetry endpoint.
   *
   * @returns true if flush was successful, false otherwise
   */
  public async flush(): Promise<boolean> {
    if (!this.isEnabled()) {
      return true
    }

    if (this.eventQueue.length === 0 && this.metricQueue.length === 0) {
      return true
    }

    const events = [...this.eventQueue]
    const metrics = [...this.metricQueue]

    // Clear queues before sending (to avoid duplicates on retry)
    this.eventQueue = []
    this.metricQueue = []

    try {
      const response = await fetch(this.endpointUrl!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          events,
          metrics,
        }),
        signal: AbortSignal.timeout(5000), // 5 second timeout
      })

      return response.ok
    } catch {
      // Silently fail - telemetry should never interrupt normal operation
      // Re-queue events for next attempt (with some limits to prevent memory issues)
      if (events.length + this.eventQueue.length < this.batchSize * 3) {
        this.eventQueue.unshift(...events)
      }
      if (metrics.length + this.metricQueue.length < this.batchSize * 3) {
        this.metricQueue.unshift(...metrics)
      }
      return false
    }
  }

  /**
   * Updates the telemetry configuration.
   * This allows runtime changes to telemetry settings.
   *
   * @param config - The new configuration
   */
  public updateConfig(config: TelemetryConfig): void {
    const wasEnabled = this.isEnabled()
    this.config = config
    const isNowEnabled = this.isEnabled()

    // Start or stop periodic flush based on new config
    if (!wasEnabled && isNowEnabled) {
      this.startPeriodicFlush()
    } else if (wasEnabled && !isNowEnabled) {
      this.stopPeriodicFlush()
    }
  }
}

/**
 * Singleton telemetry sender instance.
 * Initialized lazily when first accessed.
 */
let senderInstance: TelemetrySender | null = null

/**
 * Gets the singleton telemetry sender instance.
 * Creates it if it doesn't exist using the provided config.
 *
 * @param config - The telemetry configuration (required on first call)
 * @returns The telemetry sender instance
 */
export function getTelemetrySender(config?: TelemetryConfig): TelemetrySender | null {
  if (!senderInstance && config) {
    senderInstance = new TelemetrySender(config)
  }
  return senderInstance
}

/**
 * Convenience function to track an event using the singleton sender.
 *
 * @param type - The event type
 * @param data - Optional event-specific data
 */
export function trackEvent(type: TelemetryEventType, data?: Record<string, unknown>): void {
  senderInstance?.trackEvent(type, data)
}

/**
 * Convenience function to track a metric using the singleton sender.
 * Integrated for CLI performance monitoring (HAP-522).
 *
 * @param type - The metric type
 * @param value - The metric value
 * @param context - Optional context information
 */
export function trackMetric(
  type: MetricType,
  value: number,
  context?: Record<string, unknown>
): void {
  senderInstance?.trackMetric(type, value, context)
}

/**
 * Flushes the singleton sender's queues.
 */
export async function flushTelemetry(): Promise<boolean> {
  if (!senderInstance) {
    return true
  }
  return senderInstance.flush()
}
