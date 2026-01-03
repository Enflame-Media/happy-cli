/**
 * MCP command handler
 *
 * Manages MCP (Model Context Protocol) configurations.
 */

import { addBreadcrumb, trackMetric } from '@/telemetry'
import { logger } from '@/ui/logger'

/**
 * Handle MCP management command
 *
 * @param args - Command arguments
 */
export async function handleMcpCommand(args: string[]): Promise<void> {
  const commandStart = Date.now()
  addBreadcrumb({ category: 'command', message: 'Starting mcp command', level: 'info' })

  try {
    const mcpMain = await import('@/mcp/index.js')
    await mcpMain.default(args)
    trackMetric('command_duration', Date.now() - commandStart, { command: 'mcp', success: true })
  } catch (error) {
    trackMetric('command_duration', Date.now() - commandStart, { command: 'mcp', success: false })
    logger.errorAndExit('MCP command failed', error)
  }
}
