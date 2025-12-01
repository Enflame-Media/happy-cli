import { describe, it, expect } from 'vitest'
import { AxiosError } from 'axios'
import { AppError, ErrorCodes, getSafeErrorMessage, type ErrorCode } from './errors'

/** Helper to capture thrown errors for testing - avoids no-conditional-expect lint warnings */
function getError<T extends Error>(fn: () => unknown): T {
  try {
    fn();
    throw new Error('Expected function to throw but it did not');
  } catch (e) {
    if (e instanceof Error && e.message === 'Expected function to throw but it did not') {
      throw e;
    }
    return e as T;
  }
}

describe('ErrorCodes', () => {
  it('should have all expected error code categories', () => {
    // Connection errors
    expect(ErrorCodes.CONNECT_FAILED).toBe('CONNECT_FAILED')
    expect(ErrorCodes.NO_RESPONSE).toBe('NO_RESPONSE')
    expect(ErrorCodes.REQUEST_CONFIG_ERROR).toBe('REQUEST_CONFIG_ERROR')

    // Auth errors
    expect(ErrorCodes.AUTH_FAILED).toBe('AUTH_FAILED')
    expect(ErrorCodes.TOKEN_EXCHANGE_FAILED).toBe('TOKEN_EXCHANGE_FAILED')

    // Session errors
    expect(ErrorCodes.SESSION_NOT_FOUND).toBe('SESSION_NOT_FOUND')
    expect(ErrorCodes.DAEMON_START_FAILED).toBe('DAEMON_START_FAILED')
    expect(ErrorCodes.PROCESS_TIMEOUT).toBe('PROCESS_TIMEOUT')
    expect(ErrorCodes.VERSION_MISMATCH).toBe('VERSION_MISMATCH')

    // Resource errors
    expect(ErrorCodes.LOCK_ACQUISITION_FAILED).toBe('LOCK_ACQUISITION_FAILED')
    expect(ErrorCodes.DIRECTORY_REQUIRED).toBe('DIRECTORY_REQUIRED')
    expect(ErrorCodes.RESOURCE_NOT_FOUND).toBe('RESOURCE_NOT_FOUND')

    // Encryption errors
    expect(ErrorCodes.ENCRYPTION_ERROR).toBe('ENCRYPTION_ERROR')
    expect(ErrorCodes.NONCE_TOO_SHORT).toBe('NONCE_TOO_SHORT')

    // Validation errors
    expect(ErrorCodes.INVALID_INPUT).toBe('INVALID_INPUT')
    expect(ErrorCodes.VALIDATION_FAILED).toBe('VALIDATION_FAILED')

    // Operation errors
    expect(ErrorCodes.OPERATION_CANCELLED).toBe('OPERATION_CANCELLED')
    expect(ErrorCodes.OPERATION_FAILED).toBe('OPERATION_FAILED')
    expect(ErrorCodes.UNSUPPORTED_OPERATION).toBe('UNSUPPORTED_OPERATION')

    // Queue errors
    expect(ErrorCodes.QUEUE_CLOSED).toBe('QUEUE_CLOSED')
    expect(ErrorCodes.ALREADY_STARTED).toBe('ALREADY_STARTED')

    // Generic errors
    expect(ErrorCodes.INTERNAL_ERROR).toBe('INTERNAL_ERROR')
    expect(ErrorCodes.UNKNOWN_ERROR).toBe('UNKNOWN_ERROR')
  })

  it('should be type-safe and prevent invalid error codes', () => {
    // This should compile
    const validCode: ErrorCode = ErrorCodes.AUTH_FAILED

    // @ts-expect-error - Invalid error code should not be assignable
    const _invalidCode: ErrorCode = 'INVALID_CODE'

    expect(validCode).toBe('AUTH_FAILED')
  })

  it('should support const assertion for type inference', () => {
    const codes = Object.values(ErrorCodes)
    expect(codes).toContain('AUTH_FAILED')
    expect(codes).toContain('INTERNAL_ERROR')
    expect(codes.length).toBeGreaterThan(0)
  })
})

describe('AppError', () => {
  describe('constructor', () => {
    it('should create error with code and message', () => {
      const error = new AppError(ErrorCodes.AUTH_FAILED, 'Authentication failed')

      expect(error.code).toBe(ErrorCodes.AUTH_FAILED)
      expect(error.message).toBe('Authentication failed')
      expect(error.name).toBe('AppError')
      expect(error.cause).toBeUndefined()
    })

    it('should create error with cause chain', () => {
      const originalError = new Error('Network timeout')
      const error = new AppError(ErrorCodes.CONNECT_FAILED, 'Failed to connect', originalError)

      expect(error.code).toBe(ErrorCodes.CONNECT_FAILED)
      expect(error.message).toBe('Failed to connect')
      expect(error.cause).toBe(originalError)
    })

    it('should maintain proper prototype chain', () => {
      const error = new AppError(ErrorCodes.INTERNAL_ERROR, 'Test error')

      expect(error instanceof AppError).toBe(true)
      expect(error instanceof Error).toBe(true)
      expect(Object.getPrototypeOf(error)).toBe(AppError.prototype)
    })

    it('should capture stack trace', () => {
      const error = new AppError(ErrorCodes.OPERATION_FAILED, 'Operation failed')

      expect(error.stack).toBeDefined()
      expect(error.stack).toContain('AppError')
    })
  })

  describe('toJSON', () => {
    it('should serialize to JSON with required fields', () => {
      const error = new AppError(ErrorCodes.VALIDATION_FAILED, 'Invalid input')
      const json = error.toJSON()

      expect(json.code).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(json.message).toBe('Invalid input')
      expect(json.name).toBe('AppError')
    })

    it('should include cause message when cause exists', () => {
      const originalError = new Error('Original error')
      const error = new AppError(ErrorCodes.OPERATION_FAILED, 'Wrapped error', originalError)
      const json = error.toJSON()

      expect(json.cause).toBe('Original error')
    })

    it('should not include cause when undefined', () => {
      const error = new AppError(ErrorCodes.INTERNAL_ERROR, 'Test error')
      const json = error.toJSON()

      expect(json.cause).toBeUndefined()
    })

    it('should include stack trace when available', () => {
      const error = new AppError(ErrorCodes.UNKNOWN_ERROR, 'Test error')
      const json = error.toJSON()

      expect(json.stack).toBeDefined()
      expect(json.stack).toContain('AppError')
    })

    it('should work with JSON.stringify', () => {
      const error = new AppError(ErrorCodes.AUTH_FAILED, 'Auth failed')
      const jsonString = JSON.stringify(error)
      const parsed = JSON.parse(jsonString)

      expect(parsed.code).toBe(ErrorCodes.AUTH_FAILED)
      expect(parsed.message).toBe('Auth failed')
      expect(parsed.name).toBe('AppError')
    })
  })

  describe('fromUnknown', () => {
    it('should wrap Error objects with cause', () => {
      const originalError = new Error('Original error')
      const appError = AppError.fromUnknown(
        ErrorCodes.OPERATION_FAILED,
        'Operation failed',
        originalError
      )

      expect(appError.code).toBe(ErrorCodes.OPERATION_FAILED)
      expect(appError.message).toBe('Operation failed')
      expect(appError.cause).toBe(originalError)
    })

    it('should handle non-Error values without cause', () => {
      const appError = AppError.fromUnknown(ErrorCodes.UNKNOWN_ERROR, 'Unknown error', 'string error')

      expect(appError.code).toBe(ErrorCodes.UNKNOWN_ERROR)
      expect(appError.message).toBe('Unknown error')
      expect(appError.cause).toBeUndefined()
    })

    it('should handle null/undefined', () => {
      const error1 = AppError.fromUnknown(ErrorCodes.INTERNAL_ERROR, 'Error', null)
      const error2 = AppError.fromUnknown(ErrorCodes.INTERNAL_ERROR, 'Error', undefined)

      expect(error1.cause).toBeUndefined()
      expect(error2.cause).toBeUndefined()
    })

    it('should handle AppError as cause', () => {
      const originalAppError = new AppError(ErrorCodes.AUTH_FAILED, 'Auth failed')
      const wrappedError = AppError.fromUnknown(
        ErrorCodes.OPERATION_FAILED,
        'Wrapped',
        originalAppError
      )

      expect(wrappedError.cause).toBe(originalAppError)
      expect(wrappedError.cause instanceof AppError).toBe(true)
    })
  })

  describe('fromUnknownSafe', () => {
    it('should create error with safe message from Error', () => {
      const originalError = new Error('Sensitive data: password123')
      const appError = AppError.fromUnknownSafe(
        ErrorCodes.OPERATION_FAILED,
        'Operation failed',
        originalError
      )

      expect(appError.code).toBe(ErrorCodes.OPERATION_FAILED)
      expect(appError.message).toBe('Operation failed: Internal error')
      expect(appError.cause).toBe(originalError)
    })

    it('should handle axios errors with safe messages', () => {
      const axiosError = new AxiosError('Request failed')
      axiosError.response = {
        status: 404,
        statusText: 'Not Found',
        data: {},
        headers: {},
        config: {} as any,
      }

      const appError = AppError.fromUnknownSafe(ErrorCodes.CONNECT_FAILED, 'API call failed', axiosError)

      expect(appError.message).toBe('API call failed: Server returned 404: Not Found')
    })

    it('should handle AppError specially', () => {
      const originalAppError = new AppError(ErrorCodes.AUTH_FAILED, 'Authentication failed')
      const wrappedError = AppError.fromUnknownSafe(
        ErrorCodes.OPERATION_FAILED,
        'Operation failed',
        originalAppError
      )

      // AppError messages are safe to expose
      expect(wrappedError.message).toBe('Operation failed: Authentication failed')
    })

    it('should handle non-Error values safely', () => {
      const appError = AppError.fromUnknownSafe(
        ErrorCodes.UNKNOWN_ERROR,
        'Something went wrong',
        'sensitive string'
      )

      expect(appError.message).toBe('Something went wrong: Unknown error')
      expect(appError.cause).toBeUndefined()
    })
  })

  describe('isAppError', () => {
    it('should return true for AppError instances', () => {
      const error = new AppError(ErrorCodes.INTERNAL_ERROR, 'Test')
      expect(AppError.isAppError(error)).toBe(true)
    })

    it('should return false for regular Error', () => {
      const error = new Error('Regular error')
      expect(AppError.isAppError(error)).toBe(false)
    })

    it('should return false for non-error values', () => {
      expect(AppError.isAppError('string')).toBe(false)
      expect(AppError.isAppError(null)).toBe(false)
      expect(AppError.isAppError(undefined)).toBe(false)
      expect(AppError.isAppError({})).toBe(false)
      expect(AppError.isAppError(42)).toBe(false)
    })

    it('should provide type narrowing', () => {
      const error: unknown = new AppError(ErrorCodes.AUTH_FAILED, 'Auth failed')

      // Use type assertion instead of conditional to avoid no-conditional-expect
      expect(AppError.isAppError(error)).toBe(true)
      expect((error as AppError).code).toBe(ErrorCodes.AUTH_FAILED)
    })
  })
})

describe('getSafeErrorMessage', () => {
  it('should handle AppError specially', () => {
    const appError = new AppError(ErrorCodes.AUTH_FAILED, 'Authentication failed')
    const message = getSafeErrorMessage(appError)

    expect(message).toBe('Authentication failed')
  })

  it('should handle axios error with response', () => {
    const axiosError = new AxiosError('Request failed')
    axiosError.response = {
      status: 404,
      statusText: 'Not Found',
      data: {},
      headers: {},
      config: {} as any,
    }

    const message = getSafeErrorMessage(axiosError)
    expect(message).toBe('Server returned 404: Not Found')
  })

  it('should handle axios error without response', () => {
    const axiosError = new AxiosError('Request failed')
    axiosError.request = {}

    const message = getSafeErrorMessage(axiosError)
    expect(message).toBe('No response from server')
  })

  it('should handle axios configuration error', () => {
    const axiosError = new AxiosError('Request failed')
    // No request or response set

    const message = getSafeErrorMessage(axiosError)
    expect(message).toBe('Request configuration error')
  })

  it('should handle generic Error with safe message', () => {
    const error = new Error('Sensitive internal details')
    const message = getSafeErrorMessage(error)

    expect(message).toBe('Internal error')
    expect(message).not.toContain('Sensitive')
  })

  it('should handle non-Error values', () => {
    expect(getSafeErrorMessage('string error')).toBe('Unknown error')
    expect(getSafeErrorMessage(null)).toBe('Unknown error')
    expect(getSafeErrorMessage(undefined)).toBe('Unknown error')
    expect(getSafeErrorMessage(42)).toBe('Unknown error')
    expect(getSafeErrorMessage({ message: 'object' })).toBe('Unknown error')
  })

  it('should not leak sensitive information', () => {
    const sensitiveError = new Error('Password: secret123')
    const message = getSafeErrorMessage(sensitiveError)

    expect(message).toBe('Internal error')
    expect(message).not.toContain('Password')
    expect(message).not.toContain('secret123')
  })
})

describe('Error handling patterns', () => {
  it('should support cause chain traversal', () => {
    const rootError = new Error('Root cause')
    const midError = new AppError(ErrorCodes.OPERATION_FAILED, 'Mid level', rootError)
    const topError = new AppError(ErrorCodes.INTERNAL_ERROR, 'Top level', midError)

    expect(topError.cause).toBe(midError)
    expect(topError.cause?.cause).toBe(rootError)
  })

  it('should work in try-catch blocks', () => {
    const error = getError<AppError>(() => {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Validation failed')
    });
    expect(AppError.isAppError(error)).toBe(true)
    // Use type assertion instead of conditional to avoid no-conditional-expect
    expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED)
  })

  it('should support wrapping unknown errors', () => {
    function riskyOperation(): never {
      throw 'string error'
    }

    const error = getError(() => riskyOperation());
    const appError = AppError.fromUnknown(ErrorCodes.OPERATION_FAILED, 'Operation failed', error)
    expect(appError.code).toBe(ErrorCodes.OPERATION_FAILED)
    expect(appError.cause).toBeUndefined()
  })

  it('should maintain type safety across error boundaries', () => {
    const errorCodes: ErrorCode[] = [
      ErrorCodes.AUTH_FAILED,
      ErrorCodes.CONNECT_FAILED,
      ErrorCodes.VALIDATION_FAILED,
    ]

    errorCodes.forEach((code) => {
      const error = new AppError(code, 'Test message')
      expect(error.code).toBe(code)
    })
  })
})
