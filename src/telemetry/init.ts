/**
 * Telemetry initialization module.
 *
 * Provides a single entry point for initializing all telemetry systems
 * (Sentry, usage tracking, performance metrics) based on the loaded configuration.
 *
 * @module telemetry/init
 */

import { loadTelemetryConfig } from './config'
import { type TelemetryConfig } from './types'
import { initializeSentry, flush as flushSentry } from './sentry'
import { getTelemetrySender, flushTelemetry, trackEvent } from './sender'

/**
 * Result of telemetry initialization.
 */
export interface TelemetryInitResult {
  /** Whether any telemetry system was initialized */
  initialized: boolean
  /** The loaded telemetry configuration */
  config: TelemetryConfig
  /** Whether Sentry (error reporting) was initialized */
  sentryEnabled: boolean
  /** Whether usage tracking was initialized */
  usageEnabled: boolean
  /** Whether performance tracking was initialized */
  performanceEnabled: boolean
}

/**
 * Tracks whether telemetry has been initialized in this process.
 */
let telemetryInitialized = false

/**
 * Stores the current configuration for runtime access.
 */
let currentConfig: TelemetryConfig | null = null

/**
 * Initializes all telemetry systems based on the loaded configuration.
 *
 * This function should be called once at application startup. It will:
 * 1. Load the telemetry configuration (env vars + settings file)
 * 2. Initialize Sentry if error reporting is enabled
 * 3. Initialize the telemetry sender if usage/performance tracking is enabled
 * 4. Track a session_started event if usage tracking is enabled
 *
 * Calling this function multiple times is safe - subsequent calls are no-ops.
 *
 * @returns The initialization result with details about what was enabled
 *
 * @example
 * ```typescript
 * // At CLI startup
 * const result = await initializeTelemetry()
 * if (result.initialized) {
 *   console.log('Telemetry enabled:', result.config)
 * }
 * ```
 */
export async function initializeTelemetry(): Promise<TelemetryInitResult> {
  // Skip if already initialized
  if (telemetryInitialized && currentConfig) {
    return {
      initialized: true,
      config: currentConfig,
      sentryEnabled: currentConfig.enabled && currentConfig.categories.errors,
      usageEnabled: currentConfig.enabled && currentConfig.categories.usage,
      performanceEnabled: currentConfig.enabled && currentConfig.categories.performance,
    }
  }

  // Load configuration
  const config = await loadTelemetryConfig()
  currentConfig = config

  // Early return if telemetry is disabled
  if (!config.enabled) {
    telemetryInitialized = true
    return {
      initialized: false,
      config,
      sentryEnabled: false,
      usageEnabled: false,
      performanceEnabled: false,
    }
  }

  // Initialize Sentry for error reporting
  const sentryEnabled = initializeSentry(config)

  // Initialize telemetry sender for usage/performance
  const sender = getTelemetrySender(config)
  const usageEnabled = config.categories.usage && sender !== null
  const performanceEnabled = config.categories.performance && sender !== null

  // Track session start if usage tracking is enabled
  if (usageEnabled) {
    trackEvent('session_started', {
      mode: process.argv.includes('daemon') ? 'daemon' : 'cli',
    })
  }

  // Register process exit handler to flush telemetry
  const exitHandler = async () => {
    await shutdownTelemetry()
  }

  // Use beforeExit for async cleanup
  process.on('beforeExit', () => {
    void exitHandler()
  })

  telemetryInitialized = true

  return {
    initialized: true,
    config,
    sentryEnabled,
    usageEnabled,
    performanceEnabled,
  }
}

/**
 * Shuts down telemetry systems gracefully.
 *
 * This function flushes all pending telemetry data before the process exits.
 * It should be called when the application is about to terminate.
 *
 * @param timeout - Maximum time to wait for flush (default: 2000ms)
 * @returns true if all systems were flushed successfully
 *
 * @example
 * ```typescript
 * // Before process exit
 * await shutdownTelemetry()
 * process.exit(0)
 * ```
 */
export async function shutdownTelemetry(timeout: number = 2000): Promise<boolean> {
  if (!telemetryInitialized || !currentConfig?.enabled) {
    return true
  }

  // Track session end if usage tracking was enabled
  if (currentConfig.categories.usage) {
    trackEvent('session_ended')
  }

  // Flush both systems in parallel with timeout
  const flushPromises: Promise<boolean>[] = []

  if (currentConfig.categories.errors) {
    flushPromises.push(flushSentry(timeout))
  }

  if (currentConfig.categories.usage || currentConfig.categories.performance) {
    flushPromises.push(flushTelemetry())
  }

  if (flushPromises.length === 0) {
    return true
  }

  try {
    const results = await Promise.race([
      Promise.all(flushPromises),
      new Promise<boolean[]>(resolve =>
        setTimeout(() => resolve([false]), timeout)
      ),
    ])

    return results.every(r => r)
  } catch {
    return false
  }
}

/**
 * Gets the current telemetry configuration.
 *
 * @returns The current config or null if not initialized
 */
export function getTelemetryConfig(): TelemetryConfig | null {
  return currentConfig
}

/**
 * Checks if telemetry has been initialized.
 *
 * @returns true if initializeTelemetry() has been called
 */
export function isTelemetryInitialized(): boolean {
  return telemetryInitialized
}
