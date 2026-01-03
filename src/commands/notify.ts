/**
 * Notify command handler
 *
 * Sends push notifications to mobile devices.
 */

import chalk from 'chalk'
import { readCredentials } from '@/persistence'
import { ApiClient } from '@/api/api'
import { generateCommandHelp, EXIT_CODES } from '@/commands/registry'

/**
 * Handle notify command
 *
 * @param args - Command arguments
 */
export async function handleNotifyCommand(args: string[]): Promise<void> {
  let message = ''
  let title = ''
  let showHelp = false

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-p' && i + 1 < args.length) {
      message = args[++i]
    } else if (arg === '-t' && i + 1 < args.length) {
      title = args[++i]
    } else if (arg === '-h' || arg === '--help') {
      showHelp = true
    } else {
      console.error(chalk.red(`Unknown argument for notify command: ${arg}`))
      process.exit(EXIT_CODES.GENERAL_ERROR.code)
    }
  }

  if (showHelp) {
    const help = generateCommandHelp('notify')
    if (help) {
      console.log(help)
    } else {
      console.error(chalk.red('Error: Help text not available for notify command'))
    }
    return
  }

  if (!message) {
    console.error(chalk.red('Error: Message is required. Use -p "your message" to specify the notification text.'))
    console.log(chalk.gray('Run "happy notify --help" for usage information.'))
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }

  // Load credentials
  const credentials = await readCredentials()
  if (!credentials) {
    console.error(chalk.red('Error: Not authenticated. Please run "happy auth login" first.'))
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }

  console.log(chalk.blue('📱 Sending push notification...'))

  try {
    // Create API client and send push notification
    const api = await ApiClient.create(credentials)

    // Use custom title or default to "Happy"
    const notificationTitle = title || 'Happy'

    // Send the push notification and await completion
    await api.push().sendToAllDevices(
      notificationTitle,
      message,
      {
        source: 'cli',
        timestamp: Date.now()
      }
    )

    console.log(chalk.green('✓ Push notification sent successfully!'))
    console.log(chalk.gray(`  Title: ${notificationTitle}`))
    console.log(chalk.gray(`  Message: ${message}`))
    console.log(chalk.gray('  Check your mobile device for the notification.'))

  } catch (error) {
    console.error(chalk.red('✗ Failed to send push notification'))
    throw error
  }
}
