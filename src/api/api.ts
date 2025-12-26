import axios from 'axios'
import { logger } from '@/ui/logger'
import { EXIT_CODES } from '@/commands/registry'
import type { AgentState, CreateSessionResponse, Metadata, Session, Machine, MachineMetadata, DaemonState } from '@/api/types'
import { ApiSessionClient } from './apiSession';
import { ApiMachineClient } from './apiMachine';
import { decodeBase64, encodeBase64, getRandomBytes, encrypt, decrypt, libsodiumEncryptForPublicKey } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import chalk from 'chalk';
import { Credentials } from '@/persistence';
import { AppError, ErrorCodes, fromUnknownSafe } from '@/utils/errors';
import { createDeduplicator, type Deduplicator } from '@/utils/requestDeduplication';
import { getCorrelationId } from '@/utils/correlationId';

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient(credential);
  }

  private readonly credential: Credentials;
  private readonly pushClient: PushNotificationClient;
  private readonly activeSessions: Set<ApiSessionClient> = new Set();
  private readonly activeMachines: Set<ApiMachineClient> = new Set();
  private disposed = false;

  /**
   * Request deduplicators for coalescing concurrent identical requests.
   * Prevents duplicate network calls when multiple callers request the same resource simultaneously.
   *
   * Machine requests: Deduplicated by machineId to prevent duplicate registrations during parallel startup.
   * Vendor token requests: Deduplicated by vendor name to prevent duplicate API token registrations.
   */
  private readonly machineDeduplicator: Deduplicator<Machine>;
  private readonly vendorTokenDeduplicator: Deduplicator<void>;

  private constructor(credential: Credentials) {
    this.credential = credential
    this.pushClient = new PushNotificationClient(credential.token, configuration.serverUrl)

    // Initialize request deduplicators with 30-second timeout as safety net
    const deduplicationOptions = {
      timeoutMs: 30000,
      onDeduplicated: (key: string) => logger.debug(`[API] Request deduplicated: ${key}`)
    };
    this.machineDeduplicator = createDeduplicator<Machine>(deduplicationOptions);
    this.vendorTokenDeduplicator = createDeduplicator<void>(deduplicationOptions);
  }

  /**
   * Create a new session or load existing one with the given tag
   */
  async getOrCreateSession(opts: {
    tag: string,
    metadata: Metadata,
    state: AgentState | null,
    signal?: AbortSignal
  }): Promise<Session> {

    // Resolve encryption key
    let dataEncryptionKey: Uint8Array | null = null;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    if (this.credential.encryption.type === 'dataKey') {

      // Generate new encryption key
      encryptionKey = getRandomBytes(32);
      encryptionVariant = 'dataKey';

      // Derive and encrypt data encryption key
      // const contentDataKey = await deriveKey(this.secret, 'Happy EnCoder', ['content']);
      // const publicKey = libsodiumPublicKeyFromSecretKey(contentDataKey);
      let encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, this.credential.encryption.publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Data key
    } else {
      encryptionKey = this.credential.encryption.secret;
      encryptionVariant = 'legacy';
    }

    // Create session
    try {
      const response = await axios.post<CreateSessionResponse>(
        `${configuration.serverUrl}/v1/sessions`,
        {
          tag: opts.tag,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          agentState: opts.state ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.state)) : null,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : null,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
            'X-Correlation-ID': getCorrelationId()
          },
          timeout: 60000, // 1 minute timeout for very bad network connections
          signal: opts.signal
        }
      )

      logger.debug(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
      let raw = response.data.session;

      // Decrypt metadata with null check
      const decryptedMetadata = decrypt<Metadata>(encryptionKey, encryptionVariant, decodeBase64(raw.metadata));
      if (decryptedMetadata === null) {
        throw new AppError(ErrorCodes.ENCRYPTION_ERROR, 'Failed to decrypt session metadata - session may be corrupted');
      }

      // Decrypt agentState with null check (only if present)
      let decryptedAgentState: AgentState | null = null;
      if (raw.agentState) {
        decryptedAgentState = decrypt<AgentState>(encryptionKey, encryptionVariant, decodeBase64(raw.agentState));
        if (decryptedAgentState === null) {
          throw new AppError(ErrorCodes.ENCRYPTION_ERROR, 'Failed to decrypt session agentState - session may be corrupted');
        }
      }

      let session: Session = {
        id: raw.id,
        seq: raw.seq,
        metadata: decryptedMetadata,
        metadataVersion: raw.metadataVersion,
        agentState: decryptedAgentState,
        agentStateVersion: raw.agentStateVersion,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant
      }
      return session;
    } catch (error) {
      // Handle cancellation with a clean error message
      if (axios.isCancel(error)) {
        logger.debug('[API] Session creation was cancelled');
        throw fromUnknownSafe(ErrorCodes.OPERATION_CANCELLED, 'Session creation was cancelled', error);
      }
      logger.debug('[API] [ERROR] Failed to get or create session:', error);
      throw fromUnknownSafe(ErrorCodes.CONNECT_FAILED, 'Failed to get or create session', error);
    }
  }

  /**
   * Register or update machine with the server
   * Returns the current machine state from the server with decrypted metadata and daemonState
   *
   * Note: Concurrent calls with the same machineId are deduplicated - only one network
   * request is made and the result is shared among all callers.
   */
  async getOrCreateMachine(opts: {
    machineId: string,
    metadata: MachineMetadata,
    daemonState?: DaemonState,
    signal?: AbortSignal,
  }): Promise<Machine> {
    // Use deduplication to coalesce concurrent requests for the same machine
    return this.machineDeduplicator.request(`machine:${opts.machineId}`, async () => {
      // Resolve encryption key
      let dataEncryptionKey: Uint8Array | null = null;
      let encryptionKey: Uint8Array;
      let encryptionVariant: 'legacy' | 'dataKey';
      if (this.credential.encryption.type === 'dataKey') {
        // Encrypt data encryption key
        encryptionVariant = 'dataKey';
        encryptionKey = this.credential.encryption.machineKey;
        const encryptedDataKey = libsodiumEncryptForPublicKey(this.credential.encryption.machineKey, this.credential.encryption.publicKey);
        dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
        dataEncryptionKey.set([0], 0); // Version byte
        dataEncryptionKey.set(encryptedDataKey, 1); // Data key
      } else {
        // Legacy encryption
        encryptionKey = this.credential.encryption.secret;
        encryptionVariant = 'legacy';
      }

      // Create machine
      try {
        const response = await axios.post(
          `${configuration.serverUrl}/v1/machines`,
          {
            id: opts.machineId,
            metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
            daemonState: opts.daemonState ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.daemonState)) : undefined,
            dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : undefined
          },
          {
            headers: {
              'Authorization': `Bearer ${this.credential.token}`,
              'Content-Type': 'application/json',
              'X-Correlation-ID': getCorrelationId()
            },
            timeout: 60000, // 1 minute timeout for very bad network connections
            signal: opts.signal
          }
        );

        if (response.status !== 200) {
          console.error(chalk.red('[API] Failed to create machine'));
          console.log(chalk.yellow('[API] Failed to create machine. Most likely you have re-authenticated, but you still have a machine associated with the old account. Now we are trying to re-associate the machine with the new account. That is not allowed. Please run \'happy doctor clean\' to clean up your happy state, and try your original command again. Please create an issue on github if this is causing you problems. We apologize for the inconvenience.'));
          process.exit(EXIT_CODES.GENERAL_ERROR.code);
        }

        const raw = response.data.machine;
        logger.debug(`[API] Machine ${opts.machineId} registered/updated with server`);

        // Decrypt metadata with null check (required field)
        if (!raw.metadata) {
          throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Server returned machine without metadata - unexpected server response');
        }
        const decryptedMetadata = decrypt<MachineMetadata>(encryptionKey, encryptionVariant, decodeBase64(raw.metadata));
        if (decryptedMetadata === null) {
          throw new AppError(ErrorCodes.ENCRYPTION_ERROR, 'Failed to decrypt machine metadata - machine state may be corrupted');
        }

        // Decrypt daemonState with null check (only if present)
        let decryptedDaemonState: DaemonState | null = null;
        if (raw.daemonState) {
          decryptedDaemonState = decrypt<DaemonState>(encryptionKey, encryptionVariant, decodeBase64(raw.daemonState));
          if (decryptedDaemonState === null) {
            throw new AppError(ErrorCodes.ENCRYPTION_ERROR, 'Failed to decrypt machine daemonState - machine state may be corrupted');
          }
        }

        // Return decrypted machine like we do for sessions
        const machine: Machine = {
          id: raw.id,
          encryptionKey: encryptionKey,
          encryptionVariant: encryptionVariant,
          metadata: decryptedMetadata,
          metadataVersion: raw.metadataVersion || 0,
          daemonState: decryptedDaemonState,
          daemonStateVersion: raw.daemonStateVersion || 0,
        };
        return machine;
      } catch (error) {
        // Handle cancellation with a clean error message
        if (axios.isCancel(error)) {
          logger.debug('[API] Machine creation was cancelled');
          throw fromUnknownSafe(ErrorCodes.OPERATION_CANCELLED, 'Machine creation was cancelled', error);
        }
        logger.debug('[API] [ERROR] Failed to get or create machine:', error);
        throw fromUnknownSafe(ErrorCodes.CONNECT_FAILED, 'Failed to get or create machine', error);
      }
    });
  }

  sessionSyncClient(session: Session): ApiSessionClient {
    const client = new ApiSessionClient(this.credential.token, session);
    this.activeSessions.add(client);
    return client;
  }

  machineSyncClient(machine: Machine): ApiMachineClient {
    const client = new ApiMachineClient(this.credential.token, machine);
    this.activeMachines.add(client);
    return client;
  }

  push(): PushNotificationClient {
    return this.pushClient;
  }

  /**
   * Register a vendor API token with the server
   * The token is sent as a JSON string - server handles encryption
   *
   * Note: Concurrent calls for the same vendor are deduplicated - only one network
   * request is made and the result is shared among all callers.
   */
  async registerVendorToken(
    vendor: 'openai' | 'anthropic' | 'gemini',
    apiKey: unknown,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    // Use deduplication to prevent duplicate registrations for the same vendor
    return this.vendorTokenDeduplicator.request(`vendor:${vendor}`, async () => {
      try {
        const response = await axios.post(
          `${configuration.serverUrl}/v1/connect/${vendor}/register`,
          {
            token: JSON.stringify(apiKey)
          },
          {
            headers: {
              'Authorization': `Bearer ${this.credential.token}`,
              'Content-Type': 'application/json',
              'X-Correlation-ID': getCorrelationId()
            },
            timeout: 5000,
            signal: options?.signal
          }
        );

        if (response.status !== 200 && response.status !== 201) {
          throw new AppError(ErrorCodes.CONNECT_FAILED, `Server returned status ${response.status}`);
        }

        logger.debug(`[API] Vendor token for ${vendor} registered successfully`);
      } catch (error) {
        // Handle cancellation with a clean error message
        if (axios.isCancel(error)) {
          logger.debug('[API] Vendor token registration was cancelled');
          throw fromUnknownSafe(ErrorCodes.OPERATION_CANCELLED, 'Vendor token registration was cancelled', error);
        }
        logger.debug('[API] [ERROR] Failed to register vendor token:', error);
        throw fromUnknownSafe(ErrorCodes.CONNECT_FAILED, 'Failed to register vendor token', error);
      }
    });
  }

  /**
   * Dispose of all active sessions and machines, closing their connections.
   * This method is idempotent - calling it multiple times has no additional effect.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Clear request deduplicators
    this.machineDeduplicator.clear();
    this.vendorTokenDeduplicator.clear();

    // Close all active sessions (async)
    await Promise.all(
      Array.from(this.activeSessions).map(session => session.close().catch(() => {}))
    );
    this.activeSessions.clear();

    // Shutdown all active machines (sync)
    Array.from(this.activeMachines).forEach(machine => machine.shutdown());
    this.activeMachines.clear();

    logger.debug('[API] ApiClient disposed - all sessions and machines cleaned up');
  }

  /**
   * Get vendor API token from the server
   * Returns the token if it exists, null otherwise
   */
  async getVendorToken(vendor: 'openai' | 'anthropic' | 'gemini'): Promise<any | null> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/connect/${vendor}/token`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        }
      );

      if (response.status === 404) {
        logger.debug(`[API] No vendor token found for ${vendor}`);
        return null;
      }

      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }

      // Log raw response for debugging
      logger.debug(`[API] Raw vendor token response:`, {
        status: response.status,
        dataKeys: Object.keys(response.data || {}),
        hasToken: 'token' in (response.data || {}),
        tokenType: typeof response.data?.token,
      });

      // Token is returned as JSON string, parse it
      let tokenData: any = null;
      if (response.data?.token) {
        if (typeof response.data.token === 'string') {
          try {
            tokenData = JSON.parse(response.data.token);
          } catch (parseError) {
            logger.debug(`[API] Failed to parse token as JSON, using as string:`, parseError);
            tokenData = response.data.token;
          }
        } else if (response.data.token !== null) {
          // Token exists and is not null
          tokenData = response.data.token;
        } else {
          // Token is explicitly null - treat as not found
          logger.debug(`[API] Token is null for ${vendor}, treating as not found`);
          return null;
        }
      } else if (response.data && typeof response.data === 'object') {
        // Maybe the token is directly in response.data
        // But check if it's { token: null } - treat as not found
        if (response.data.token === null && Object.keys(response.data).length === 1) {
          logger.debug(`[API] Response contains only null token for ${vendor}, treating as not found`);
          return null;
        }
        tokenData = response.data;
      }
      
      // Final check: if tokenData is null or { token: null }, return null
      if (tokenData === null || (tokenData && typeof tokenData === 'object' && tokenData.token === null && Object.keys(tokenData).length === 1)) {
        logger.debug(`[API] Token data is null for ${vendor}`);
        return null;
      }
      
      logger.debug(`[API] Vendor token for ${vendor} retrieved successfully`, {
        tokenDataType: typeof tokenData,
        tokenDataKeys: tokenData && typeof tokenData === 'object' ? Object.keys(tokenData) : 'not an object',
      });
      return tokenData;
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.debug(`[API] No vendor token found for ${vendor}`);
        return null;
      }
      logger.debug(`[API] [ERROR] Failed to get vendor token:`, error);
      return null;
    }
  }
}
