/**
 * CLI version update checker
 *
 * Checks npm registry for newer versions of happy-coder.
 * Designed with robust error handling to never block CLI startup:
 * - 5-second timeout prevents hanging on slow networks
 * - Network errors are silently logged (not shown to user)
 * - Offline mode works without any issues
 *
 * @see HAP-134 for requirements
 */

import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'

/** NPM registry response structure for package metadata */
interface NpmPackageInfo {
  name: string
  version: string
  description?: string
}

/** Version check timeout in milliseconds */
const VERSION_CHECK_TIMEOUT_MS = 5000

/** NPM registry URL for package info */
const NPM_REGISTRY_URL = 'https://registry.npmjs.org'

/** Package name on npm */
const PACKAGE_NAME = 'happy-coder'

/**
 * Result of version check operation
 */
export interface VersionCheckResult {
  /** Whether a newer version is available */
  updateAvailable: boolean
  /** Current installed version */
  currentVersion: string
  /** Latest version from npm (null if check failed) */
  latestVersion: string | null
  /** Error message if check failed (null on success) */
  error: string | null
}

/**
 * Compares two semver version strings.
 * Returns true if `latest` is newer than `current`.
 *
 * @param current - Current installed version (e.g., "1.2.3")
 * @param latest - Latest available version (e.g., "1.2.4")
 * @returns true if latest > current
 */
function isNewerVersion(current: string, latest: string): boolean {
  const currentParts = current.split('.').map(Number)
  const latestParts = latest.split('.').map(Number)

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const currentPart = currentParts[i] || 0
    const latestPart = latestParts[i] || 0

    if (latestPart > currentPart) return true
    if (latestPart < currentPart) return false
  }

  return false
}

/**
 * Checks npm registry for the latest version of happy-coder.
 *
 * This function is designed to be non-blocking and fail gracefully:
 * - Uses a 5-second timeout to prevent hanging
 * - Catches all network errors silently
 * - Logs debug info for troubleshooting
 * - Never throws exceptions
 *
 * @returns Promise<VersionCheckResult> - Result object with version info or error
 *
 * @example
 * ```typescript
 * const result = await checkForUpdates();
 * if (result.updateAvailable) {
 *   console.log(`Update available: ${result.latestVersion}`);
 * }
 * ```
 */
export async function checkForUpdates(): Promise<VersionCheckResult> {
  const currentVersion = configuration.currentCliVersion
  const url = `${NPM_REGISTRY_URL}/${PACKAGE_NAME}/latest`

  logger.debug(`[VERSION CHECK] Checking for updates: current=${currentVersion}, url=${url}`)

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
      headers: {
        'Accept': 'application/json',
        // npm registry prefers a User-Agent header
        'User-Agent': `${PACKAGE_NAME}/${currentVersion}`
      }
    })

    // Silently skip on HTTP errors (404, 500, etc.)
    if (!response.ok) {
      logger.debug(`[VERSION CHECK] HTTP error: ${response.status} ${response.statusText}`)
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion: null,
        error: `HTTP ${response.status}`
      }
    }

    const data = await response.json() as NpmPackageInfo
    const latestVersion = data.version

    logger.debug(`[VERSION CHECK] Latest version: ${latestVersion}`)

    const updateAvailable = isNewerVersion(currentVersion, latestVersion)

    if (updateAvailable) {
      logger.debug(`[VERSION CHECK] Update available: ${currentVersion} -> ${latestVersion}`)
    } else {
      logger.debug(`[VERSION CHECK] Already up to date`)
    }

    return {
      updateAvailable,
      currentVersion,
      latestVersion,
      error: null
    }
  } catch (err) {
    // Handle all errors gracefully - never block startup
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'

    // Provide specific debug info for common error types
    if (err instanceof Error && err.name === 'TimeoutError') {
      logger.debug(`[VERSION CHECK] Timeout after ${VERSION_CHECK_TIMEOUT_MS}ms`)
    } else if (err instanceof Error && err.name === 'AbortError') {
      logger.debug(`[VERSION CHECK] Request aborted`)
    } else if (err instanceof TypeError && errorMessage.includes('fetch')) {
      logger.debug(`[VERSION CHECK] Network error (offline or DNS failure)`)
    } else {
      logger.debug(`[VERSION CHECK] Error: ${errorMessage}`)
    }

    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: null,
      error: errorMessage
    }
  }
}

/**
 * Performs a non-blocking version check and logs result.
 * This is the main entry point for startup version checking.
 *
 * Characteristics:
 * - Runs asynchronously without blocking startup
 * - Only logs to debug (never disturbs user)
 * - Silently handles all errors
 *
 * @returns Promise<void>
 */
export async function checkForUpdatesAndNotify(): Promise<void> {
  const result = await checkForUpdates()

  if (result.updateAvailable && result.latestVersion) {
    // Log update notification to debug - user can check with --version
    logger.debug(
      `[VERSION CHECK] A new version of happy-coder is available: ` +
      `${result.currentVersion} -> ${result.latestVersion}. ` +
      `Run 'npm update -g happy-coder' to update.`
    )
  }
}
