/**
 * Tests for trimIdent utility function
 */

import { describe, it, expect } from 'vitest'
import { trimIdent } from './trimIdent'

describe('trimIdent', () => {
  describe('basic functionality', () => {
    it('should remove common leading whitespace from all lines', () => {
      const input = `
        Hello
        World
        `
      const expected = 'Hello\nWorld'
      expect(trimIdent(input)).toBe(expected)
    })

    it('should handle text with no leading whitespace', () => {
      const input = 'Hello\nWorld'
      expect(trimIdent(input)).toBe('Hello\nWorld')
    })

    it('should handle single line text', () => {
      const input = '    Hello'
      expect(trimIdent(input)).toBe('Hello')
    })

    it('should handle empty string', () => {
      expect(trimIdent('')).toBe('')
    })
  })

  describe('leading/trailing empty lines', () => {
    it('should remove leading empty lines', () => {
      const input = '\n\n    Hello\n    World'
      expect(trimIdent(input)).toBe('Hello\nWorld')
    })

    it('should remove trailing empty lines', () => {
      const input = '    Hello\n    World\n\n'
      expect(trimIdent(input)).toBe('Hello\nWorld')
    })

    it('should remove both leading and trailing empty lines', () => {
      const input = '\n\n    Hello\n    World\n\n\n'
      expect(trimIdent(input)).toBe('Hello\nWorld')
    })
  })

  describe('mixed indentation', () => {
    it('should use minimum indentation as the base', () => {
      const input = `
        Line 1
          Indented Line 2
        Line 3
        `
      const expected = 'Line 1\n  Indented Line 2\nLine 3'
      expect(trimIdent(input)).toBe(expected)
    })

    it('should preserve relative indentation', () => {
      const input = `
        function foo() {
            return bar;
        }
        `
      const expected = 'function foo() {\n    return bar;\n}'
      expect(trimIdent(input)).toBe(expected)
    })
  })

  describe('empty lines within content', () => {
    it('should handle empty lines within the text', () => {
      const input = `
        First

        Second
        `
      const expected = 'First\n\nSecond'
      expect(trimIdent(input)).toBe(expected)
    })

    it('should not count empty lines for minimum indentation', () => {
      const input = `
        Line 1

        Line 2
        `
      // Empty line in the middle should not affect indentation calculation
      expect(trimIdent(input)).toBe('Line 1\n\nLine 2')
    })
  })

  describe('whitespace-only lines', () => {
    it('should handle lines with only whitespace', () => {
      const input = '    Hello\n        \n    World'
      // The whitespace-only line should be trimmed to common indent
      const result = trimIdent(input)
      expect(result).toContain('Hello')
      expect(result).toContain('World')
    })
  })

  describe('edge cases', () => {
    it('should handle all whitespace input', () => {
      const input = '   \n   \n   '
      expect(trimIdent(input)).toBe('')
    })

    it('should handle single newline', () => {
      expect(trimIdent('\n')).toBe('')
    })

    it('should handle text with tabs', () => {
      const input = '\t\tHello\n\t\tWorld'
      expect(trimIdent(input)).toBe('Hello\nWorld')
    })

    it('should handle mixed tabs and spaces', () => {
      const input = '\t Hello\n\t World'
      expect(trimIdent(input)).toBe('Hello\nWorld')
    })
  })

  describe('template literal use case', () => {
    it('should work well with template literals', () => {
      // This is the main use case - cleaning up indented template literals
      const result = trimIdent(`
        {
          "name": "test",
          "version": "1.0.0"
        }
      `)
      expect(result).toBe('{\n  "name": "test",\n  "version": "1.0.0"\n}')
    })
  })
})
