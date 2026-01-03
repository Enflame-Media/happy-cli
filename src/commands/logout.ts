/**
 * Logout command handler (deprecated)
 *
 * Redirects to auth logout for backward compatibility.
 */

import chalk from 'chalk'
import { handleAuthCommand } from '@/commands/auth'
import { logger } from '@/ui/logger'

/**
 * Handle logout command
 *
 * @deprecated Use 'happy auth logout' instead
 * @param _args - Command arguments (unused)
 */
export async function handleLogoutCommand(_args: string[]): Promise<void> {
  // Keep for backward compatibility - redirect to auth logout
  console.log(chalk.yellow('Note: "happy logout" is deprecated. Use "happy auth logout" instead.\n'))

  try {
    await handleAuthCommand(['logout'])
  } catch (error) {
    logger.errorAndExit('Logout command failed', error)
  }
}
