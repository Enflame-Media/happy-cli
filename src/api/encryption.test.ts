import { describe, it, expect, beforeEach } from 'vitest';
import {
  encryptLegacy,
  decryptLegacy,
  encryptWithDataKey,
  decryptWithDataKey,
  libsodiumEncryptForPublicKey,
  getRandomBytes,
  _resetNonceCounter,
  _getNonceCounter,
  KeyVersionManager,
  encryptWithKeyVersion,
  getEncryptedBundleInfo,
} from './encryption';
import tweetnacl from 'tweetnacl';

describe('encryption', () => {
  beforeEach(() => {
    // Reset counter before each test for predictable behavior
    _resetNonceCounter();
  });

  describe('nonce counter', () => {
    it('should increment the nonce counter with each encryption (legacy)', () => {
      const secret = getRandomBytes(32);
      const data = { test: 'data' };

      expect(_getNonceCounter()).toBe(0n);

      encryptLegacy(data, secret);
      expect(_getNonceCounter()).toBe(1n);

      encryptLegacy(data, secret);
      expect(_getNonceCounter()).toBe(2n);

      encryptLegacy(data, secret);
      expect(_getNonceCounter()).toBe(3n);
    });

    it('should increment the nonce counter with each encryption (dataKey)', () => {
      const dataKey = getRandomBytes(32);
      const data = { test: 'data' };

      _resetNonceCounter();
      expect(_getNonceCounter()).toBe(0n);

      encryptWithDataKey(data, dataKey);
      expect(_getNonceCounter()).toBe(1n);

      encryptWithDataKey(data, dataKey);
      expect(_getNonceCounter()).toBe(2n);
    });

    it('should increment the nonce counter with each encryption (libsodium public key)', () => {
      const keyPair = tweetnacl.box.keyPair();
      const data = new Uint8Array([1, 2, 3, 4]);

      _resetNonceCounter();
      expect(_getNonceCounter()).toBe(0n);

      libsodiumEncryptForPublicKey(data, keyPair.publicKey);
      expect(_getNonceCounter()).toBe(1n);

      libsodiumEncryptForPublicKey(data, keyPair.publicKey);
      expect(_getNonceCounter()).toBe(2n);
    });
  });

  describe('nonce uniqueness under load', () => {
    it('should generate unique nonces for rapid sequential encryptions (legacy)', () => {
      const secret = getRandomBytes(32);
      const data = { test: 'data' };
      const nonceSet = new Set<string>();
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const encrypted = encryptLegacy(data, secret);
        // Extract nonce (first 24 bytes)
        const nonce = encrypted.slice(0, tweetnacl.secretbox.nonceLength);
        const nonceHex = Buffer.from(nonce).toString('hex');
        nonceSet.add(nonceHex);
      }

      // All nonces should be unique
      expect(nonceSet.size).toBe(iterations);
    });

    it('should generate unique nonces for rapid sequential encryptions (dataKey)', () => {
      const dataKey = getRandomBytes(32);
      const data = { test: 'data' };
      const nonceSet = new Set<string>();
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const encrypted = encryptWithDataKey(data, dataKey);
        // Extract nonce (bytes 1-13, version byte is at 0)
        const nonce = encrypted.slice(1, 13);
        const nonceHex = Buffer.from(nonce).toString('hex');
        nonceSet.add(nonceHex);
      }

      // All nonces should be unique
      expect(nonceSet.size).toBe(iterations);
    });

    it('should have counter component embedded in nonce', () => {
      const secret = getRandomBytes(32);
      const data = { test: 'data' };

      _resetNonceCounter();

      // Encrypt multiple times and check the counter portion of the nonces
      const nonces: Uint8Array[] = [];
      for (let i = 0; i < 100; i++) {
        const encrypted = encryptLegacy(data, secret);
        nonces.push(encrypted.slice(0, tweetnacl.secretbox.nonceLength));
      }

      // Extract counter portion (last 8 bytes of each 24-byte nonce)
      const counters: bigint[] = nonces.map((nonce) => {
        const counterBytes = nonce.slice(16, 24);
        const view = new DataView(counterBytes.buffer, counterBytes.byteOffset, 8);
        return view.getBigUint64(0, false);
      });

      // Counters should be sequential 0, 1, 2, ...
      for (let i = 0; i < counters.length; i++) {
        expect(counters[i]).toBe(BigInt(i));
      }
    });
  });

  describe('backward compatibility', () => {
    it('should encrypt and decrypt successfully with legacy format', () => {
      const secret = getRandomBytes(32);
      const data = { message: 'Hello, World!', number: 42, nested: { foo: 'bar' } };

      const encrypted = encryptLegacy(data, secret);
      const decrypted = decryptLegacy(encrypted, secret);

      expect(decrypted).toEqual(data);
    });

    it('should encrypt and decrypt successfully with dataKey format', () => {
      const dataKey = getRandomBytes(32);
      const data = { message: 'Hello, World!', number: 42, nested: { foo: 'bar' } };

      const encrypted = encryptWithDataKey(data, dataKey);
      const decrypted = decryptWithDataKey(encrypted, dataKey);

      expect(decrypted).toEqual(data);
    });

    it('should handle multiple encrypt/decrypt cycles', () => {
      const secret = getRandomBytes(32);
      const originalData = { test: 'multiple cycles' };

      for (let i = 0; i < 100; i++) {
        const encrypted = encryptLegacy(originalData, secret);
        const decrypted = decryptLegacy(encrypted, secret);
        expect(decrypted).toEqual(originalData);
      }
    });

    it('should return null for tampered data', () => {
      const secret = getRandomBytes(32);
      const data = { message: 'secret' };

      const encrypted = encryptLegacy(data, secret);
      // Tamper with the encrypted data
      encrypted[encrypted.length - 1] ^= 0xff;

      const decrypted = decryptLegacy(encrypted, secret);
      expect(decrypted).toBeNull();
    });

    it('should return null for wrong key', () => {
      const secret1 = getRandomBytes(32);
      const secret2 = getRandomBytes(32);
      const data = { message: 'secret' };

      const encrypted = encryptLegacy(data, secret1);
      const decrypted = decryptLegacy(encrypted, secret2);

      expect(decrypted).toBeNull();
    });
  });

  describe('hybrid nonce structure', () => {
    it('should have correct nonce length for legacy encryption (24 bytes)', () => {
      const secret = getRandomBytes(32);
      const data = { test: 'data' };

      const encrypted = encryptLegacy(data, secret);
      // Total length = nonce (24) + ciphertext (variable)
      expect(encrypted.length).toBeGreaterThan(24);
    });

    it('should have correct structure for dataKey encryption', () => {
      const dataKey = getRandomBytes(32);
      const data = { test: 'data' };

      const encrypted = encryptWithDataKey(data, dataKey);
      // Structure: version(1) + nonce(12) + ciphertext + authTag(16)
      expect(encrypted[0]).toBe(0); // Version byte
      expect(encrypted.length).toBeGreaterThan(1 + 12 + 16); // Minimum size
    });

    it('should have random prefix for cross-process uniqueness', () => {
      const secret = getRandomBytes(32);
      const data = { test: 'data' };

      // Generate two nonces (need to reset counter in between to isolate random portion test)
      _resetNonceCounter();
      const encrypted1 = encryptLegacy(data, secret);
      const nonce1 = encrypted1.slice(0, tweetnacl.secretbox.nonceLength);

      _resetNonceCounter();
      const encrypted2 = encryptLegacy(data, secret);
      const nonce2 = encrypted2.slice(0, tweetnacl.secretbox.nonceLength);

      // The random prefix (first 16 bytes) should be different
      const randomPrefix1 = Buffer.from(nonce1.slice(0, 16)).toString('hex');
      const randomPrefix2 = Buffer.from(nonce2.slice(0, 16)).toString('hex');
      expect(randomPrefix1).not.toBe(randomPrefix2);

      // But the counter portion (last 8 bytes) should be the same (both 0)
      const counterPart1 = Buffer.from(nonce1.slice(16, 24)).toString('hex');
      const counterPart2 = Buffer.from(nonce2.slice(16, 24)).toString('hex');
      expect(counterPart1).toBe(counterPart2);
    });
  });

  describe('KeyVersionManager', () => {
    describe('initialization', () => {
      it('should create a manager with initial key as version 1', () => {
        const initialKey = getRandomBytes(32);
        const manager = new KeyVersionManager(initialKey);

        expect(manager.getCurrentVersion()).toBe(1);
        expect(manager.getAvailableVersions()).toEqual([1]);
      });

      it('should throw on invalid initial key length', () => {
        const shortKey = getRandomBytes(16);
        expect(() => new KeyVersionManager(shortKey)).toThrow('Invalid initial key length');
      });

      it('should copy the key to prevent external mutation', () => {
        const initialKey = getRandomBytes(32);
        const originalValue = initialKey[0];
        const manager = new KeyVersionManager(initialKey);

        // Mutate the original key
        initialKey[0] = originalValue ^ 0xff;

        // Manager's key should be unchanged
        const storedKey = manager.getCurrentKey();
        expect(storedKey[0]).toBe(originalValue);
      });

      it('should return copy of key from getCurrentKey to prevent internal mutation', () => {
        const manager = new KeyVersionManager(getRandomBytes(32));
        const key = manager.getCurrentKey();
        const originalValue = key[0];

        // Attempt to mutate the returned key
        key.fill(0xff);

        // Internal key should be unchanged
        expect(manager.getCurrentKey()[0]).toBe(originalValue);
      });

      it('should return copy of key from getKey to prevent internal mutation', () => {
        const manager = new KeyVersionManager(getRandomBytes(32));
        const key = manager.getKey(1)!;
        const originalValue = key[0];

        // Attempt to mutate the returned key
        key.fill(0xff);

        // Internal key should be unchanged
        expect(manager.getKey(1)![0]).toBe(originalValue);
      });
    });

    describe('key rotation', () => {
      it('should increment version on rotation', () => {
        const manager = new KeyVersionManager(getRandomBytes(32));
        expect(manager.getCurrentVersion()).toBe(1);

        const newVersion = manager.rotateKey(getRandomBytes(32));
        expect(newVersion).toBe(2);
        expect(manager.getCurrentVersion()).toBe(2);
      });

      it('should retain old keys for decryption', () => {
        const key1 = getRandomBytes(32);
        const key2 = getRandomBytes(32);
        const manager = new KeyVersionManager(key1);

        manager.rotateKey(key2);

        expect(manager.getKey(1)).toEqual(key1);
        expect(manager.getKey(2)).toEqual(key2);
        expect(manager.getAvailableVersions()).toEqual([1, 2]);
      });

      it('should prune old keys beyond retention limit', () => {
        const manager = new KeyVersionManager(getRandomBytes(32), { retainOldKeys: 3 });

        // Add 4 more keys (total 5)
        for (let i = 0; i < 4; i++) {
          manager.rotateKey(getRandomBytes(32));
        }

        // Should only have versions 3, 4, 5 (pruned 1 and 2)
        expect(manager.getAvailableVersions()).toEqual([3, 4, 5]);
        expect(manager.getKey(1)).toBeUndefined();
        expect(manager.getKey(2)).toBeUndefined();
      });

      it('should throw on invalid key length during rotation', () => {
        const manager = new KeyVersionManager(getRandomBytes(32));
        expect(() => manager.rotateKey(getRandomBytes(16))).toThrow('Invalid key length');
      });
    });

    describe('encryption and decryption', () => {
      it('should encrypt with current key version', () => {
        const manager = new KeyVersionManager(getRandomBytes(32));
        const data = { message: 'test', value: 42 };

        const encrypted = manager.encrypt(data);
        const info = getEncryptedBundleInfo(encrypted);

        expect(info).not.toBeNull();
        expect(info!.formatVersion).toBe(1); // Versioned format
        expect(info!.keyVersion).toBe(1);
      });

      it('should decrypt with correct key version', () => {
        const manager = new KeyVersionManager(getRandomBytes(32));
        const data = { message: 'test', value: 42 };

        const encrypted = manager.encrypt(data);
        const decrypted = manager.decrypt(encrypted);

        expect(decrypted).toEqual(data);
      });

      it('should decrypt old data after key rotation', () => {
        const manager = new KeyVersionManager(getRandomBytes(32));
        const data1 = { message: 'before rotation' };

        // Encrypt with version 1
        const encrypted1 = manager.encrypt(data1);

        // Rotate key
        manager.rotateKey(getRandomBytes(32));
        expect(manager.getCurrentVersion()).toBe(2);

        // Encrypt with version 2
        const data2 = { message: 'after rotation' };
        const encrypted2 = manager.encrypt(data2);

        // Both should decrypt correctly
        expect(manager.decrypt(encrypted1)).toEqual(data1);
        expect(manager.decrypt(encrypted2)).toEqual(data2);
      });

      it('should decrypt legacy (version 0) bundles', () => {
        const key = getRandomBytes(32);
        const manager = new KeyVersionManager(key);
        const data = { message: 'legacy data' };

        // Create legacy encrypted bundle directly
        const legacyEncrypted = encryptWithDataKey(data, key);
        expect(legacyEncrypted[0]).toBe(0); // Legacy format

        // Manager should decrypt it using the initial key
        const decrypted = manager.decrypt(legacyEncrypted);
        expect(decrypted).toEqual(data);
      });

      it('should return null for unknown key version', () => {
        const manager = new KeyVersionManager(getRandomBytes(32), { retainOldKeys: 2 });

        // Add 3 more keys to prune version 1
        for (let i = 0; i < 3; i++) {
          manager.rotateKey(getRandomBytes(32));
        }

        // Create data encrypted with version 1 key (now pruned)
        // We need to manually create this since manager no longer has version 1
        const fakeBundle = new Uint8Array([0x01, 0x00, 0x01, ...Array.from({ length: 30 }, () => 0)]);

        const decrypted = manager.decrypt(fakeBundle);
        expect(decrypted).toBeNull();
      });

      it('should return null for invalid bundle', () => {
        const manager = new KeyVersionManager(getRandomBytes(32));

        expect(manager.decrypt(new Uint8Array([]))).toBeNull();
        expect(manager.decrypt(new Uint8Array([0x01]))).toBeNull(); // Too short for versioned
        expect(manager.decrypt(new Uint8Array([0x99]))).toBeNull(); // Unknown format
      });
    });

    describe('key expiration', () => {
      it('should track key expiration', () => {
        const manager = new KeyVersionManager(getRandomBytes(32), { maxKeyAge: 1000 });

        expect(manager.isKeyExpired(1)).toBe(false);

        const info = manager.getKeyInfo(1);
        expect(info).not.toBeUndefined();
        expect(info!.expiresAt).toBeInstanceOf(Date);
      });
    });

    describe('state persistence', () => {
      it('should export and restore state', () => {
        const manager = new KeyVersionManager(getRandomBytes(32));
        const data = { message: 'persistent' };

        // Rotate a few times
        manager.rotateKey(getRandomBytes(32));
        manager.rotateKey(getRandomBytes(32));

        // Encrypt something
        const encrypted = manager.encrypt(data);

        // Export and restore
        const exportedState = manager.exportState();
        const restoredManager = KeyVersionManager.fromExportedState(exportedState);

        // Should be able to decrypt
        const decrypted = restoredManager.decrypt(encrypted);
        expect(decrypted).toEqual(data);
        expect(restoredManager.getCurrentVersion()).toBe(3);
        expect(restoredManager.getAvailableVersions()).toEqual([1, 2, 3]);
      });

      it('should throw when restoring empty state', () => {
        expect(() => KeyVersionManager.fromExportedState({ keys: [], currentVersion: 0 }))
          .toThrow('Cannot restore KeyVersionManager');
      });
    });
  });

  describe('encryptWithKeyVersion', () => {
    it('should create versioned bundle with correct structure', () => {
      const key = getRandomBytes(32);
      const data = { test: 'versioned' };

      const encrypted = encryptWithKeyVersion(data, key, 42);
      const info = getEncryptedBundleInfo(encrypted);

      expect(info).not.toBeNull();
      expect(info!.formatVersion).toBe(1);
      expect(info!.keyVersion).toBe(42);
    });

    it('should throw on invalid key version', () => {
      const key = getRandomBytes(32);
      const data = { test: 'data' };

      expect(() => encryptWithKeyVersion(data, key, 0)).toThrow('Invalid key version');
      expect(() => encryptWithKeyVersion(data, key, 65536)).toThrow('Invalid key version');
      expect(() => encryptWithKeyVersion(data, key, -1)).toThrow('Invalid key version');
    });

    it('should encrypt and decrypt correctly via decryptWithDataKey', () => {
      const key = getRandomBytes(32);
      const data = { message: 'test', nested: { value: 123 } };

      const encrypted = encryptWithKeyVersion(data, key, 1);
      const decrypted = decryptWithDataKey(encrypted, key);

      expect(decrypted).toEqual(data);
    });
  });

  describe('getEncryptedBundleInfo', () => {
    it('should extract info from legacy bundle', () => {
      const key = getRandomBytes(32);
      const encrypted = encryptWithDataKey({ test: 'data' }, key);

      const info = getEncryptedBundleInfo(encrypted);
      expect(info).not.toBeNull();
      expect(info!.formatVersion).toBe(0);
      expect(info!.keyVersion).toBeUndefined();
    });

    it('should extract info from versioned bundle', () => {
      const key = getRandomBytes(32);
      const encrypted = encryptWithKeyVersion({ test: 'data' }, key, 256);

      const info = getEncryptedBundleInfo(encrypted);
      expect(info).not.toBeNull();
      expect(info!.formatVersion).toBe(1);
      expect(info!.keyVersion).toBe(256);
    });

    it('should return null for empty bundle', () => {
      expect(getEncryptedBundleInfo(new Uint8Array([]))).toBeNull();
    });
  });

  describe('backward compatibility with versioned format', () => {
    it('should decrypt versioned bundles with decryptWithDataKey', () => {
      const key = getRandomBytes(32);
      const data = { compatibility: 'test' };

      // Encrypt with versioned format
      const encrypted = encryptWithKeyVersion(data, key, 1);
      expect(encrypted[0]).toBe(1); // Versioned format

      // Should decrypt with original function
      const decrypted = decryptWithDataKey(encrypted, key);
      expect(decrypted).toEqual(data);
    });

    it('should handle mixed format decryption', () => {
      const key = getRandomBytes(32);
      const data = { mixed: 'formats' };

      // Create both legacy and versioned bundles
      const legacyEncrypted = encryptWithDataKey(data, key);
      const versionedEncrypted = encryptWithKeyVersion(data, key, 1);

      // Both should decrypt
      expect(decryptWithDataKey(legacyEncrypted, key)).toEqual(data);
      expect(decryptWithDataKey(versionedEncrypted, key)).toEqual(data);
    });
  });
});
