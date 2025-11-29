import { z } from 'zod'
import type { StartOptions } from '@/claude/runClaude'
import { validateStartedBy } from '@/utils/validators'

/**
 * Result of parsing CLI arguments
 */
export interface ParsedCliArgs {
  options: StartOptions
  showHelp: boolean
  showVersion: boolean
  unknownArgs: string[]
}

/**
 * Parses CLI arguments for the happy command.
 *
 * Known happy-specific flags are processed and their values consumed.
 * Unknown arguments are passed through to Claude Code verbatim.
 *
 * IMPORTANT: Unknown arguments are NOT paired with their values by heuristics.
 * Claude Code handles its own argument parsing, so we pass everything through
 * one-by-one. This ensures negative numbers like `-1` and special values
 * starting with `-` are handled correctly.
 *
 * @param args Array of command line arguments (without node and script path)
 * @returns Parsed options and flags
 */
export function parseCliArgs(args: string[]): ParsedCliArgs {
  // Make a copy to avoid mutating the input
  const argsCopy = [...args]

  // If the first argument is claude, remove it
  if (argsCopy.length > 0 && argsCopy[0] === 'claude') {
    argsCopy.shift()
  }

  const options: StartOptions = {}
  let showHelp = false
  let showVersion = false
  const unknownArgs: string[] = []

  for (let i = 0; i < argsCopy.length; i++) {
    const arg = argsCopy[i]

    if (arg === '-h' || arg === '--help') {
      showHelp = true
      // Also pass through to claude
      unknownArgs.push(arg)
    } else if (arg === '-v' || arg === '--version') {
      showVersion = true
      // Also pass through to claude (will show after our version)
      unknownArgs.push(arg)
    } else if (arg === '--happy-starting-mode') {
      options.startingMode = z.enum(['local', 'remote']).parse(argsCopy[++i])
    } else if (arg === '--yolo') {
      // Shortcut for --dangerously-skip-permissions
      unknownArgs.push('--dangerously-skip-permissions')
    } else if (arg === '--started-by') {
      const value = argsCopy[++i]
      options.startedBy = validateStartedBy(value)
    } else {
      // Pass unknown arguments through to claude
      // Don't attempt to detect values - let Claude Code handle its own argument parsing
      // Previous heuristic (!args[i+1].startsWith('-')) failed for negative numbers
      // and values that legitimately start with '-'
      unknownArgs.push(arg)
    }
  }

  // Add unknown args to claudeArgs
  if (unknownArgs.length > 0) {
    options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs]
  }

  return {
    options,
    showHelp,
    showVersion,
    unknownArgs,
  }
}
