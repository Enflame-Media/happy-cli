/**
 * Codex command handler
 *
 * Runs Codex AI agent with Happy integration.
 */

import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { validateStartedBy } from '@/utils/validators'
import { addBreadcrumb, trackMetric } from '@/telemetry'
import { logger } from '@/ui/logger'

/**
 * Handle codex command
 *
 * @param args - Command arguments
 */
export async function handleCodexCommand(args: string[]): Promise<void> {
  const commandStart = Date.now()
  addBreadcrumb({ category: 'command', message: 'Starting codex command', level: 'info' })

  try {
    const { runCodex } = await import('@/codex/runCodex')

    // Parse startedBy argument
    let startedBy: 'daemon' | 'terminal' | undefined = undefined
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--started-by') {
        startedBy = validateStartedBy(args[++i])
      }
    }

    const { credentials } = await authAndSetupMachineIfNeeded()
    await runCodex({ credentials, startedBy })
    trackMetric('command_duration', Date.now() - commandStart, { command: 'codex', success: true })
    // Do not force exit here; allow instrumentation to show lingering handles
  } catch (error) {
    trackMetric('command_duration', Date.now() - commandStart, { command: 'codex', success: false })
    logger.errorAndExit('Codex command failed', error)
  }
}
