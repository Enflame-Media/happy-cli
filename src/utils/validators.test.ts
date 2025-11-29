import { describe, it, expect } from 'vitest'
import {
  validateStartedBy,
  validatePositiveInteger,
  validatePort,
  validateTimeout,
  validateHeartbeatInterval,
  STARTED_BY_VALUES
} from './validators'

describe('validators', () => {
  describe('validateStartedBy', () => {
    it('should accept "daemon"', () => {
      expect(validateStartedBy('daemon')).toBe('daemon')
    })

    it('should accept "terminal"', () => {
      expect(validateStartedBy('terminal')).toBe('terminal')
    })

    it('should throw for invalid value', () => {
      expect(() => validateStartedBy('invalid')).toThrow(
        'Invalid --started-by value: "invalid". Must be one of: daemon, terminal'
      )
    })

    it('should throw for empty string', () => {
      expect(() => validateStartedBy('')).toThrow(
        'Invalid --started-by value: "". Must be one of: daemon, terminal'
      )
    })

    it('STARTED_BY_VALUES should contain expected values', () => {
      expect(STARTED_BY_VALUES).toEqual(['daemon', 'terminal'])
    })
  })

  describe('validatePositiveInteger', () => {
    it('should parse valid integer', () => {
      expect(validatePositiveInteger('42', 'TEST_VAR')).toBe(42)
    })

    it('should return default value when undefined', () => {
      expect(validatePositiveInteger(undefined, 'TEST_VAR', { defaultValue: 100 })).toBe(100)
    })

    it('should return default value when empty string', () => {
      expect(validatePositiveInteger('', 'TEST_VAR', { defaultValue: 100 })).toBe(100)
    })

    it('should throw when undefined without default', () => {
      expect(() => validatePositiveInteger(undefined, 'TEST_VAR')).toThrow(
        'TEST_VAR is required but was not provided'
      )
    })

    it('should throw for NaN', () => {
      expect(() => validatePositiveInteger('abc', 'TEST_VAR')).toThrow(
        'Invalid TEST_VAR: "abc". Must be a valid integer.'
      )
    })

    it('should throw when below min', () => {
      expect(() => validatePositiveInteger('0', 'TEST_VAR', { min: 1 })).toThrow(
        'Invalid TEST_VAR: 0. Must be at least 1.'
      )
    })

    it('should throw when above max', () => {
      expect(() => validatePositiveInteger('100', 'TEST_VAR', { max: 50 })).toThrow(
        'Invalid TEST_VAR: 100. Must be at most 50.'
      )
    })

    it('should accept value at min boundary', () => {
      expect(validatePositiveInteger('10', 'TEST_VAR', { min: 10 })).toBe(10)
    })

    it('should accept value at max boundary', () => {
      expect(validatePositiveInteger('50', 'TEST_VAR', { max: 50 })).toBe(50)
    })

    it('should handle negative numbers when min allows', () => {
      expect(validatePositiveInteger('-5', 'TEST_VAR', { min: -10 })).toBe(-5)
    })
  })

  describe('validatePort', () => {
    it('should accept valid port 80', () => {
      expect(validatePort('80')).toBe(80)
    })

    it('should accept port 1', () => {
      expect(validatePort('1')).toBe(1)
    })

    it('should accept port 65535', () => {
      expect(validatePort('65535')).toBe(65535)
    })

    it('should throw for port 0', () => {
      expect(() => validatePort('0')).toThrow('Invalid port: 0. Must be at least 1.')
    })

    it('should throw for port 65536', () => {
      expect(() => validatePort('65536')).toThrow('Invalid port: 65536. Must be at most 65535.')
    })

    it('should throw for non-numeric port', () => {
      expect(() => validatePort('abc')).toThrow('Invalid port: "abc". Must be a valid integer.')
    })

    it('should use custom name in error message', () => {
      expect(() => validatePort('0', '--server-port')).toThrow(
        'Invalid --server-port: 0. Must be at least 1.'
      )
    })
  })

  describe('validateTimeout', () => {
    it('should accept timeout 0 (no timeout)', () => {
      expect(validateTimeout('0', 'TIMEOUT')).toBe(0)
    })

    it('should accept positive timeout', () => {
      expect(validateTimeout('5000', 'TIMEOUT')).toBe(5000)
    })

    it('should return default when undefined', () => {
      expect(validateTimeout(undefined, 'TIMEOUT', { defaultValue: 10000 })).toBe(10000)
    })

    it('should throw for negative timeout', () => {
      expect(() => validateTimeout('-1', 'TIMEOUT')).toThrow(
        'Invalid TIMEOUT: -1. Must be at least 0.'
      )
    })

    it('should respect custom min', () => {
      expect(() => validateTimeout('50', 'TIMEOUT', { min: 100 })).toThrow(
        'Invalid TIMEOUT: 50. Must be at least 100.'
      )
    })

    it('should respect max', () => {
      expect(() => validateTimeout('400000', 'TIMEOUT', { max: 300000 })).toThrow(
        'Invalid TIMEOUT: 400000. Must be at most 300000.'
      )
    })
  })

  describe('validateHeartbeatInterval', () => {
    it('should accept 1000ms (minimum)', () => {
      expect(validateHeartbeatInterval('1000', 'HEARTBEAT')).toBe(1000)
    })

    it('should accept 60000ms (1 minute)', () => {
      expect(validateHeartbeatInterval('60000', 'HEARTBEAT')).toBe(60000)
    })

    it('should return default when undefined', () => {
      expect(validateHeartbeatInterval(undefined, 'HEARTBEAT', { defaultValue: 60000 })).toBe(60000)
    })

    it('should throw for interval below 1000ms', () => {
      expect(() => validateHeartbeatInterval('500', 'HEARTBEAT')).toThrow(
        'Invalid HEARTBEAT: 500. Must be at least 1000.'
      )
    })

    it('should throw for 0ms interval', () => {
      expect(() => validateHeartbeatInterval('0', 'HEARTBEAT')).toThrow(
        'Invalid HEARTBEAT: 0. Must be at least 1000.'
      )
    })

    it('should respect custom min', () => {
      // Allow lower min for testing
      expect(validateHeartbeatInterval('100', 'HEARTBEAT', { min: 100 })).toBe(100)
    })

    it('should respect max', () => {
      expect(() => validateHeartbeatInterval('4000000', 'HEARTBEAT', { max: 3600000 })).toThrow(
        'Invalid HEARTBEAT: 4000000. Must be at most 3600000.'
      )
    })
  })
})
