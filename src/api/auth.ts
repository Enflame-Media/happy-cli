import axios from 'axios';
import { encodeBase64, encodeBase64Url, authChallenge } from './encryption';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { AppError, ErrorCodes } from '@/utils/errors';

/**
 * Note: This function is deprecated. Use readPrivateKey/writePrivateKey from persistence module instead.
 * Kept for backward compatibility only.
 */
export async function getOrCreateSecretKey(): Promise<Uint8Array> {
  throw new AppError(ErrorCodes.UNSUPPORTED_OPERATION, 'getOrCreateSecretKey is deprecated. Use readPrivateKey/writePrivateKey from persistence module.');
}

/**
 * Authenticate with the server and obtain an auth token
 * @param serverUrl - The URL of the server to authenticate with
 * @param secret - The secret key to use for authentication
 * @param options - Optional configuration including abort signal
 * @returns The authentication token
 */
export async function authGetToken(
  secret: Uint8Array,
  options?: { signal?: AbortSignal }
): Promise<string> {
  const { challenge, publicKey, signature } = authChallenge(secret);

  try {
    const response = await axios.post(
      `${configuration.serverUrl}/v1/auth`,
      {
        challenge: encodeBase64(challenge),
        publicKey: encodeBase64(publicKey),
        signature: encodeBase64(signature)
      },
      {
        timeout: 30000,
        signal: options?.signal
      }
    );

    if (!response.data.success || !response.data.token) {
      throw new AppError(ErrorCodes.AUTH_FAILED, 'Authentication failed');
    }

    return response.data.token;
  } catch (error) {
    // Handle cancellation with a clean error message
    if (axios.isCancel(error)) {
      logger.debug('[AUTH] Authentication was cancelled');
      throw AppError.fromUnknownSafe(ErrorCodes.OPERATION_CANCELLED, 'Authentication was cancelled', error);
    }
    logger.debug('[AUTH] [ERROR] Authentication request failed:', error);
    throw AppError.fromUnknownSafe(ErrorCodes.AUTH_FAILED, 'Authentication failed', error);
  }
}

/**
 * Generate a URL for the mobile app to connect to the server
 * @param secret - The secret key to use for authentication
 * @returns The URL for the mobile app to connect to the server
 */
export function generateAppUrl(secret: Uint8Array): string {
  const secretBase64Url = encodeBase64Url(secret);
  return `handy://${secretBase64Url}`;
}