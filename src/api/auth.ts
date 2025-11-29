import axios from 'axios';
import { encodeBase64, encodeBase64Url, authChallenge } from './encryption';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { getSafeErrorMessage } from '@/utils/errors';

/**
 * Note: This function is deprecated. Use readPrivateKey/writePrivateKey from persistence module instead.
 * Kept for backward compatibility only.
 */
export async function getOrCreateSecretKey(): Promise<Uint8Array> {
  throw new Error('getOrCreateSecretKey is deprecated. Use readPrivateKey/writePrivateKey from persistence module.');
}

/**
 * Authenticate with the server and obtain an auth token
 * @param serverUrl - The URL of the server to authenticate with
 * @param secret - The secret key to use for authentication
 * @returns The authentication token
 */
export async function authGetToken(secret: Uint8Array): Promise<string> {
  const { challenge, publicKey, signature } = authChallenge(secret);

  try {
    const response = await axios.post(`${configuration.serverUrl}/v1/auth`, {
      challenge: encodeBase64(challenge),
      publicKey: encodeBase64(publicKey),
      signature: encodeBase64(signature)
    });

    if (!response.data.success || !response.data.token) {
      throw new Error('Authentication failed');
    }

    return response.data.token;
  } catch (error) {
    logger.debug('[AUTH] [ERROR] Authentication request failed:', error);
    throw new Error(`Authentication failed: ${getSafeErrorMessage(error)}`);
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