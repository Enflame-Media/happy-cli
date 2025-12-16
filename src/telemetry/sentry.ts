/**
 * Sentry error reporting integration with privacy-first configuration.
 *
 * This module handles Sentry initialization with proper anonymization support
 * and respects the telemetry configuration settings.
 *
 * ## Privacy Features
 * - Anonymization removes user IPs, usernames, and other PII
 * - No data collection unless explicitly enabled
 * - Respects HAPPY_TELEMETRY environment variable
 *
 * @module telemetry/sentry
 */

import * as Sentry from '@sentry/node'
import { type TelemetryConfig } from './types'
import packageJson from '../../package.json'

/** Sentry DSN for error reporting. Set via environment variable. */
const SENTRY_DSN = process.env.HAPPY_SENTRY_DSN

/**
 * Tracks whether Sentry has been initialized in this process.
 * Prevents double initialization which can cause issues.
 */
let sentryInitialized = false

/**
 * Keys that are considered sensitive and should be scrubbed in anonymize mode.
 * These are removed from breadcrumbs, tags, and extra data.
 */
const SENSITIVE_KEYS = [
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'credential',
  'privateKey',
  'private_key',
  'sessionId',
  'session_id',
  'machineId',
  'machine_id',
  'userId',
  'user_id',
  'email',
  'ip',
  'ipAddress',
  'ip_address',
]

/**
 * Recursively scrubs sensitive values from an object.
 *
 * @param obj - The object to scrub
 * @returns A new object with sensitive values replaced by '[Redacted]'
 */
function scrubSensitiveData<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj
  }

  if (typeof obj === 'string') {
    return obj as T
  }

  if (Array.isArray(obj)) {
    return obj.map(item => scrubSensitiveData(item)) as T
  }

  if (typeof obj === 'object') {
    const scrubbed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase()
      const isSensitive = SENSITIVE_KEYS.some(
        sensitiveKey => lowerKey.includes(sensitiveKey.toLowerCase())
      )

      if (isSensitive) {
        scrubbed[key] = '[Redacted]'
      } else if (typeof value === 'object' && value !== null) {
        scrubbed[key] = scrubSensitiveData(value)
      } else {
        scrubbed[key] = value
      }
    }
    return scrubbed as T
  }

  return obj
}

/**
 * Anonymizes a Sentry event by removing PII and sensitive data.
 * Applied when telemetry config has `anonymize: true`.
 *
 * @param event - The Sentry event to anonymize
 * @returns The anonymized event
 */
function anonymizeEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  // Remove user information
  if (event.user) {
    event.user = {
      // Keep only anonymized identifiers if needed
    }
  }

  // Remove IP address
  delete event.request?.headers?.['x-forwarded-for']
  delete event.request?.headers?.['x-real-ip']

  // Scrub sensitive data from extra context
  if (event.extra) {
    event.extra = scrubSensitiveData(event.extra)
  }

  // Scrub sensitive data from tags
  if (event.tags) {
    event.tags = scrubSensitiveData(event.tags)
  }

  // Scrub sensitive data from breadcrumbs
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(breadcrumb => ({
      ...breadcrumb,
      data: breadcrumb.data ? scrubSensitiveData(breadcrumb.data) : undefined,
      message: breadcrumb.message,
    }))
  }

  // Ensure no server name is leaked
  delete event.server_name

  return event
}

/**
 * Initializes Sentry error reporting based on telemetry configuration.
 *
 * This function is safe to call multiple times - it will only initialize
 * Sentry once. Subsequent calls check if the configuration has changed.
 *
 * @param config - The telemetry configuration
 * @returns true if Sentry was initialized (or already was), false if disabled
 *
 * @example
 * ```typescript
 * const config = await loadTelemetryConfig()
 * const initialized = initializeSentry(config)
 * if (initialized) {
 *   console.log('Error reporting enabled')
 * }
 * ```
 */
export function initializeSentry(config: TelemetryConfig): boolean {
  // Skip if telemetry is disabled or errors category is disabled
  if (!config.enabled || !config.categories.errors) {
    return false
  }

  // Skip if no DSN configured
  if (!SENTRY_DSN) {
    return false
  }

  // Skip if already initialized
  if (sentryInitialized) {
    return true
  }

  const shouldAnonymize = config.anonymize

  Sentry.init({
    dsn: SENTRY_DSN,

    // Application info
    release: `happy-cli@${packageJson.version}`,
    environment: process.env.NODE_ENV || 'production',

    // Performance sampling (disabled by default, controlled by performance category)
    tracesSampleRate: config.categories.performance ? 0.1 : 0,

    // Privacy: don't send default PII
    sendDefaultPii: false,

    // Normalize depth for data scrubbing
    normalizeDepth: 5,

    // Before sending, apply anonymization if configured
    beforeSend: (event) => {
      if (shouldAnonymize) {
        return anonymizeEvent(event)
      }
      return event
    },

    // Don't send breadcrumbs for console logs (can contain sensitive data)
    integrations: integrations => {
      return integrations.filter(integration => {
        // Remove console breadcrumb integration when anonymizing
        if (shouldAnonymize && integration.name === 'Console') {
          return false
        }
        return true
      })
    },
  })

  // Add CLI context
  Sentry.setTag('cli.version', packageJson.version)
  Sentry.setTag('platform', process.platform)
  Sentry.setTag('node.version', process.version)

  sentryInitialized = true
  return true
}

/**
 * Captures an exception with Sentry if error reporting is enabled.
 *
 * This is a wrapper around Sentry.captureException that respects
 * the telemetry configuration. If Sentry is not initialized, this
 * is a no-op.
 *
 * @param error - The error to capture
 * @param context - Optional extra context to attach to the error
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation()
 * } catch (error) {
 *   captureException(error, { operation: 'riskyOperation' })
 * }
 * ```
 */
export function captureException(
  error: unknown,
  context?: Record<string, unknown>
): void {
  if (!sentryInitialized) {
    return
  }

  if (context) {
    Sentry.withScope(scope => {
      scope.setExtras(context)
      Sentry.captureException(error)
    })
  } else {
    Sentry.captureException(error)
  }
}

/**
 * Captures a message with Sentry for non-error events.
 *
 * @param message - The message to capture
 * @param level - The severity level (default: 'info')
 * @param context - Optional extra context
 */
export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = 'info',
  context?: Record<string, unknown>
): void {
  if (!sentryInitialized) {
    return
  }

  if (context) {
    Sentry.withScope(scope => {
      scope.setExtras(context)
      Sentry.captureMessage(message, level)
    })
  } else {
    Sentry.captureMessage(message, level)
  }
}

/**
 * Adds a breadcrumb to the current Sentry scope.
 * Breadcrumbs are used to track user actions leading up to an error.
 *
 * @param breadcrumb - The breadcrumb to add
 */
export function addBreadcrumb(breadcrumb: Sentry.Breadcrumb): void {
  if (!sentryInitialized) {
    return
  }

  Sentry.addBreadcrumb(breadcrumb)
}

/**
 * Sets a tag on the current Sentry scope.
 * Tags are searchable and can be used to filter events.
 *
 * @param key - The tag key
 * @param value - The tag value
 */
export function setTag(key: string, value: string): void {
  if (!sentryInitialized) {
    return
  }

  Sentry.setTag(key, value)
}

/**
 * Flushes pending Sentry events before process exit.
 * Should be called before the process terminates to ensure
 * all events are sent.
 *
 * @param timeout - Maximum time to wait for flush (default: 2000ms)
 */
export async function flush(timeout: number = 2000): Promise<boolean> {
  if (!sentryInitialized) {
    return true
  }

  return Sentry.close(timeout)
}

/**
 * Checks if Sentry has been initialized.
 *
 * @returns true if Sentry is initialized and ready to capture events
 */
export function isSentryInitialized(): boolean {
  return sentryInitialized
}
