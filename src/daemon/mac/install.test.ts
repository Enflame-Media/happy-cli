/**
 * Tests for macOS LaunchDaemon plist generation
 */

import { describe, it, expect } from 'vitest'
import plist from 'plist'
import os from 'os'

describe('macOS LaunchDaemon plist generation', () => {
  describe('plist structure', () => {
    it('should generate valid plist XML with correct structure', () => {
      // Mock the values that would be used in install()
      const PLIST_LABEL = 'com.happy-cli.daemon'
      const happyPath = '/usr/local/bin/node'
      const scriptPath = '/usr/local/bin/happy'

      // Create the same plist data structure as install.ts
      const plistData = {
        Label: PLIST_LABEL,
        ProgramArguments: [happyPath, scriptPath, 'happy-daemon'],
        EnvironmentVariables: {
          HAPPY_DAEMON_MODE: 'true'
        },
        RunAtLoad: true,
        KeepAlive: true,
        StandardErrorPath: `${os.homedir()}/.enfm-happy/daemon.err`,
        StandardOutPath: `${os.homedir()}/.enfm-happy/daemon.log`,
        WorkingDirectory: '/tmp'
      }

      // Generate plist content
      const plistContent = plist.build(plistData)

      // Verify plist content is valid XML
      expect(plistContent).toContain('<?xml version="1.0" encoding="UTF-8"?>')
      expect(plistContent).toContain('<plist version="1.0">')
      expect(plistContent).toContain('</plist>')

      // Verify key fields are present
      expect(plistContent).toContain('<key>Label</key>')
      expect(plistContent).toContain('<string>com.happy-cli.daemon</string>')
      expect(plistContent).toContain('<key>ProgramArguments</key>')
      expect(plistContent).toContain('<array>')
      expect(plistContent).toContain(`<string>${happyPath}</string>`)
      expect(plistContent).toContain(`<string>${scriptPath}</string>`)
      expect(plistContent).toContain('<string>happy-daemon</string>')
      expect(plistContent).toContain('<key>EnvironmentVariables</key>')
      expect(plistContent).toContain('<key>HAPPY_DAEMON_MODE</key>')
      expect(plistContent).toContain('<key>RunAtLoad</key>')
      expect(plistContent).toContain('<true/>')
      expect(plistContent).toContain('<key>KeepAlive</key>')
      expect(plistContent).toContain('<key>StandardErrorPath</key>')
      expect(plistContent).toContain('<key>StandardOutPath</key>')
      expect(plistContent).toContain('<key>WorkingDirectory</key>')
      expect(plistContent).toContain('<string>/tmp</string>')
    })

    it('should properly escape special XML characters in paths', () => {
      const PLIST_LABEL = 'com.happy-cli.daemon'
      // Create paths with special XML characters
      const happyPath = '/usr/bin/node<>&"'
      const scriptPath = "/usr/bin/happy'test"

      const plistData = {
        Label: PLIST_LABEL,
        ProgramArguments: [happyPath, scriptPath, 'happy-daemon'],
        EnvironmentVariables: {
          HAPPY_DAEMON_MODE: 'true'
        },
        RunAtLoad: true,
        KeepAlive: true,
        StandardErrorPath: `${os.homedir()}/.enfm-happy/daemon.err`,
        StandardOutPath: `${os.homedir()}/.enfm-happy/daemon.log`,
        WorkingDirectory: '/tmp'
      }

      const plistContent = plist.build(plistData)

      // Verify that special characters are properly escaped
      // The plist library should escape <, >, &, and " automatically
      expect(plistContent).toContain('&lt;')  // < should be escaped
      expect(plistContent).toContain('&gt;')  // > should be escaped
      expect(plistContent).toContain('&amp;') // & should be escaped
      // Single quotes don't need escaping in XML, but double quotes in attributes would
      expect(plistContent).not.toContain('<>&"') // Raw special chars should not appear

      // Verify the plist can be parsed back
      const parsed = plist.parse(plistContent) as any
      expect(parsed.ProgramArguments[0]).toBe(happyPath)
      expect(parsed.ProgramArguments[1]).toBe(scriptPath)
    })

    it('should generate valid plist that can be parsed back to original data', () => {
      const PLIST_LABEL = 'com.happy-cli.daemon'
      const happyPath = '/usr/local/bin/node'
      const scriptPath = '/usr/local/bin/happy'

      const originalData = {
        Label: PLIST_LABEL,
        ProgramArguments: [happyPath, scriptPath, 'happy-daemon'],
        EnvironmentVariables: {
          HAPPY_DAEMON_MODE: 'true'
        },
        RunAtLoad: true,
        KeepAlive: true,
        StandardErrorPath: `${os.homedir()}/.enfm-happy/daemon.err`,
        StandardOutPath: `${os.homedir()}/.enfm-happy/daemon.log`,
        WorkingDirectory: '/tmp'
      }

      const plistContent = plist.build(originalData)
      const parsedData = plist.parse(plistContent) as any

      // Verify all fields match
      expect(parsedData.Label).toBe(originalData.Label)
      expect(parsedData.ProgramArguments).toEqual(originalData.ProgramArguments)
      expect(parsedData.EnvironmentVariables).toEqual(originalData.EnvironmentVariables)
      expect(parsedData.RunAtLoad).toBe(originalData.RunAtLoad)
      expect(parsedData.KeepAlive).toBe(originalData.KeepAlive)
      expect(parsedData.StandardErrorPath).toBe(originalData.StandardErrorPath)
      expect(parsedData.StandardOutPath).toBe(originalData.StandardOutPath)
      expect(parsedData.WorkingDirectory).toBe(originalData.WorkingDirectory)
    })

    it('should include DOCTYPE declaration for compatibility', () => {
      const PLIST_LABEL = 'com.happy-cli.daemon'
      const plistData = {
        Label: PLIST_LABEL,
        ProgramArguments: ['/usr/bin/node', '/usr/bin/happy', 'happy-daemon'],
        EnvironmentVariables: {
          HAPPY_DAEMON_MODE: 'true'
        },
        RunAtLoad: true,
        KeepAlive: true,
        StandardErrorPath: `${os.homedir()}/.enfm-happy/daemon.err`,
        StandardOutPath: `${os.homedir()}/.enfm-happy/daemon.log`,
        WorkingDirectory: '/tmp'
      }

      const plistContent = plist.build(plistData)

      // Verify DOCTYPE is present for macOS compatibility
      expect(plistContent).toContain('<!DOCTYPE plist PUBLIC')
      expect(plistContent).toContain('https://www.apple.com/DTDs/PropertyList-1.0.dtd')
    })
  })
})
