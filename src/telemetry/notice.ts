/**
 * Telemetry opt-in notice for first-time users.
 *
 * Shows a one-time notice about telemetry options and how to enable them.
 * The notice is informational only and doesn't require user action.
 *
 * @module telemetry/notice
 */

import chalk from 'chalk'
import { readSettings, updateSettings } from '@/persistence'

/**
 * Shows the telemetry opt-in notice if it hasn't been shown before.
 *
 * This function:
 * 1. Checks if the notice has already been shown
 * 2. If not, displays an informational message about telemetry
 * 3. Marks the notice as shown in settings
 *
 * The notice is non-blocking and informational - it doesn't prompt
 * for input or change any settings.
 *
 * @returns true if the notice was shown, false if already shown
 */
export async function showTelemetryNoticeIfNeeded(): Promise<boolean> {
  const settings = await readSettings()

  // Skip if already shown
  if (settings.telemetryNoticeShown) {
    return false
  }

  // Show the notice
  console.log('')
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
  console.log(chalk.cyan.bold('  📊 Help Improve Happy CLI'))
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
  console.log('')
  console.log(chalk.gray('  Happy CLI includes optional telemetry to help us'))
  console.log(chalk.gray('  improve the product. By default, no data is collected.'))
  console.log('')
  console.log(chalk.gray('  To opt in to anonymized error reporting:'))
  console.log(chalk.white('    export HAPPY_TELEMETRY=true'))
  console.log('')
  console.log(chalk.gray('  Privacy: All data is anonymized by default.'))
  console.log(chalk.gray('  See: https://happy.enflamemedia.com/privacy'))
  console.log('')
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
  console.log('')

  // Mark as shown
  await updateSettings(s => ({
    ...s,
    telemetryNoticeShown: true,
  }))

  return true
}

/**
 * Resets the telemetry notice shown flag.
 * Useful for testing or when telemetry settings change significantly.
 */
export async function resetTelemetryNotice(): Promise<void> {
  await updateSettings(s => ({
    ...s,
    telemetryNoticeShown: false,
  }))
}
