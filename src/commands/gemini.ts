/**
 * Gemini command handler
 *
 * Runs Gemini AI agent with Happy integration.
 */

import chalk from 'chalk'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { logger } from '@/ui/logger'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient'
import { EXIT_CODES } from '@/commands/registry'

const VALID_GEMINI_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'] as const

/**
 * Handle gemini command
 *
 * @param args - Command arguments
 */
export async function handleGeminiCommand(args: string[]): Promise<void> {
  const geminiSubcommand = args[0]

  // Handle "happy gemini model set <model>" command
  if (geminiSubcommand === 'model' && args[1] === 'set' && args[2]) {
    handleModelSet(args[2])
    return
  }

  // Handle "happy gemini model get" command
  if (geminiSubcommand === 'model' && args[1] === 'get') {
    handleModelGet()
    return
  }

  // Handle gemini command (ACP-based agent)
  try {
    const { runGemini } = await import('@/gemini/runGemini')

    // Parse startedBy argument
    let startedBy: 'daemon' | 'terminal' | undefined = undefined
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--started-by') {
        startedBy = args[++i] as 'daemon' | 'terminal'
      }
    }

    const { credentials } = await authAndSetupMachineIfNeeded()

    // Auto-start daemon for gemini (same as claude)
    logger.debug('Ensuring Happy background service is running & matches our version...')
    if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
      logger.debug('Starting Happy background service...')
      const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
      daemonProcess.unref()
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    await runGemini({ credentials, startedBy })
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
    if (process.env.DEBUG) {
      console.error(error)
    }
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }
}

function handleModelSet(modelName: string): void {
  if (!VALID_GEMINI_MODELS.includes(modelName as typeof VALID_GEMINI_MODELS[number])) {
    console.error(`Invalid model: ${modelName}`)
    console.error(`Available models: ${VALID_GEMINI_MODELS.join(', ')}`)
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }

  try {
    const configDir = join(homedir(), '.gemini')
    const configPath = join(configDir, 'config.json')

    // Create directory if it doesn't exist
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true })
    }

    // Read existing config or create new one
    let config: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch {
        // Ignore parse errors, start fresh
        config = {}
      }
    }

    // Update model in config
    config.model = modelName

    // Write config back
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    console.log(`✓ Model set to: ${modelName}`)
    console.log(`  Config saved to: ${configPath}`)
    console.log(`  This model will be used in future sessions.`)
    process.exit(EXIT_CODES.SUCCESS.code)
  } catch (error) {
    console.error('Failed to save model configuration:', error)
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }
}

function handleModelGet(): void {
  try {
    const configPaths = [
      join(homedir(), '.gemini', 'config.json'),
      join(homedir(), '.config', 'gemini', 'config.json'),
    ]

    let model: string | null = null
    for (const configPath of configPaths) {
      if (existsSync(configPath)) {
        try {
          const config = JSON.parse(readFileSync(configPath, 'utf-8'))
          model = config.model || config.GEMINI_MODEL || null
          if (model) break
        } catch {
          // Ignore parse errors
        }
      }
    }

    if (model) {
      console.log(`Current model: ${model}`)
    } else if (process.env.GEMINI_MODEL) {
      console.log(`Current model: ${process.env.GEMINI_MODEL} (from GEMINI_MODEL env var)`)
    } else {
      console.log('Current model: gemini-2.5-pro (default)')
    }
    process.exit(EXIT_CODES.SUCCESS.code)
  } catch (error) {
    console.error('Failed to read model configuration:', error)
    process.exit(EXIT_CODES.GENERAL_ERROR.code)
  }
}
