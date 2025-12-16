/**
 * Telemetry module for privacy-first error reporting and usage analytics.
 *
 * ## Features
 * - Error reporting via Sentry (requires opt-in)
 * - Usage tracking for feature analytics
 * - Performance metrics collection
 * - Full anonymization support for GDPR compliance
 *
 * ## Configuration Priority
 * 1. Environment variables (HAPPY_TELEMETRY, HAPPY_TELEMETRY_ANONYMIZE)
 * 2. Settings file (~/.happy/settings.json)
 * 3. Default: telemetry disabled (opt-in model)
 *
 * ## Environment Variables
 * - `HAPPY_TELEMETRY`: Master switch (true/false)
 * - `HAPPY_TELEMETRY_ANONYMIZE`: Force anonymization (true/false)
 * - `HAPPY_SENTRY_DSN`: Sentry DSN for error reporting
 * - `HAPPY_TELEMETRY_ENDPOINT`: Endpoint for usage/performance metrics
 *
 * @module telemetry
 *
 * @example
 * ```typescript
 * import { initializeTelemetry, captureException, trackEvent } from '@/telemetry'
 *
 * // Initialize telemetry at startup
 * await initializeTelemetry()
 *
 * // Track errors
 * try {
 *   await riskyOperation()
 * } catch (error) {
 *   captureException(error, { operation: 'riskyOperation' })
 * }
 *
 * // Track usage
 * trackEvent('session_started', { mode: 'interactive' })
 * ```
 */

export { loadTelemetryConfig, isTelemetryDisabledByEnv } from './config'
export {
  DEFAULT_TELEMETRY_CONFIG,
  type TelemetryCategories,
  type TelemetryConfig,
} from './types'

// Sentry error reporting
export {
  initializeSentry,
  captureException,
  captureMessage,
  addBreadcrumb,
  setTag,
  flush as flushSentry,
  isSentryInitialized,
} from './sentry'

// Usage and performance telemetry
export {
  TelemetrySender,
  getTelemetrySender,
  trackEvent,
  trackMetric,
  flushTelemetry,
  type TelemetryEvent,
  type TelemetryEventType,
  type PerformanceMetric,
  type MetricType,
} from './sender'

// Re-export initialization helper
export { initializeTelemetry, shutdownTelemetry } from './init'

// Opt-in notice
export { showTelemetryNoticeIfNeeded, resetTelemetryNotice } from './notice'
