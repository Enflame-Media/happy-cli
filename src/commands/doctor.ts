/**
 * Doctor command handler
 *
 * Performs health checks and cleanup of the Happy CLI environment.
 */

import { killRunawayHappyProcesses, killOrphanedCaffeinate } from '@/daemon/doctor'
import { runDoctorCommand } from '@/ui/doctor'
import { EXIT_CODES } from '@/commands/registry'

/**
 * Handle doctor command
 *
 * @param args - Command arguments
 */
export async function handleDoctorCommand(args: string[]): Promise<void> {
  // Check for clean subcommand
  if (args[0] === 'clean') {
    const result = await killRunawayHappyProcesses()
    console.log(`Cleaned up ${result.killed} runaway processes`)
    if (result.errors.length > 0) {
      console.log('Errors:', result.errors)
    }

    // Also clean up orphaned caffeinate process if any
    const caffeinateResult = await killOrphanedCaffeinate()
    if (caffeinateResult.killed) {
      console.log('Cleaned up orphaned caffeinate process')
    }
    if (caffeinateResult.error) {
      console.log('Caffeinate cleanup error:', caffeinateResult.error)
    }

    process.exit(EXIT_CODES.SUCCESS.code)
  }

  await runDoctorCommand()
}
