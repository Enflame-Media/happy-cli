"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeyVersionManager = void 0;
exports.encodeBase64 = encodeBase64;
exports.encodeBase64Url = encodeBase64Url;
exports.decodeBase64 = decodeBase64;
exports.getRandomBytes = getRandomBytes;
exports._resetNonceCounter = _resetNonceCounter;
exports._getNonceCounter = _getNonceCounter;
exports.libsodiumEncryptForPublicKey = libsodiumEncryptForPublicKey;
exports.encryptLegacy = encryptLegacy;
exports.decryptLegacy = decryptLegacy;
exports.encryptWithDataKey = encryptWithDataKey;
exports.decryptWithDataKey = decryptWithDataKey;
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.encryptWithKeyVersion = encryptWithKeyVersion;
exports.getEncryptedBundleInfo = getEncryptedBundleInfo;
exports.authChallenge = authChallenge;
var node_crypto_1 = require("node:crypto");
var tweetnacl_1 = require("tweetnacl");
var errors_1 = require("@/utils/errors");
/**
 * Module-level counter for hybrid nonce generation.
 * Combined with random bytes to eliminate any theoretical nonce collision risk.
 */
var nonceCounter = 0n;
var MAX_UINT64 = (Math.pow(2n, 64n)) - 1n;
/**
 * Encode a Uint8Array to base64 string
 * @param buffer - The buffer to encode
 * @param variant - The encoding variant ('base64' or 'base64url')
 */
function encodeBase64(buffer, variant) {
    if (variant === void 0) { variant = 'base64'; }
    if (variant === 'base64url') {
        return encodeBase64Url(buffer);
    }
    return Buffer.from(buffer).toString('base64');
}
/**
 * Encode a Uint8Array to base64url string (URL-safe base64)
 * Base64URL uses '-' instead of '+', '_' instead of '/', and removes padding
 */
function encodeBase64Url(buffer) {
    return Buffer.from(buffer)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
}
/**
 * Decode a base64 string to a Uint8Array
 * @param base64 - The base64 string to decode
 * @param variant - The encoding variant ('base64' or 'base64url')
 * @returns The decoded Uint8Array
 */
function decodeBase64(base64, variant) {
    if (variant === void 0) { variant = 'base64'; }
    if (variant === 'base64url') {
        // Convert base64url to base64
        var base64Standard = base64
            .replaceAll('-', '+')
            .replaceAll('_', '/')
            + '='.repeat((4 - base64.length % 4) % 4);
        return new Uint8Array(Buffer.from(base64Standard, 'base64'));
    }
    return new Uint8Array(Buffer.from(base64, 'base64'));
}
/**
 * Generate secure random bytes
 */
function getRandomBytes(size) {
    return new Uint8Array((0, node_crypto_1.randomBytes)(size));
}
/**
 * Generate a hybrid nonce combining random bytes with a monotonic counter.
 * This eliminates theoretical collision risk in high-throughput scenarios
 * while maintaining cryptographic randomness.
 *
 * Structure: [random bytes][8-byte counter (big-endian)]
 * - 24-byte nonce (NaCl): 16 random + 8 counter
 * - 12-byte nonce (AES-GCM): 4 random + 8 counter
 *
 * @param totalLength - Total nonce length in bytes
 * @returns Hybrid nonce as Uint8Array
 */
function generateHybridNonce(totalLength) {
    var counterBytes = 8;
    var randomLength = totalLength - counterBytes;
    if (randomLength < 0) {
        throw new errors_1.AppError(errors_1.ErrorCodes.NONCE_TOO_SHORT, "Nonce length ".concat(totalLength, " is too short for hybrid nonce (minimum 8 bytes)"));
    }
    var nonce = new Uint8Array(totalLength);
    // Random prefix for cross-process/cross-machine uniqueness
    if (randomLength > 0) {
        var randomPart = getRandomBytes(randomLength);
        nonce.set(randomPart, 0);
    }
    // Counter suffix for within-process uniqueness (big-endian)
    var counterView = new DataView(nonce.buffer, randomLength, counterBytes);
    counterView.setBigUint64(0, nonceCounter, false);
    // Increment counter, but never allow wrapping
    if (nonceCounter >= MAX_UINT64) {
        // This should be practically impossible (2^64 encryptions)
        // but handle it securely: never
        throw new errors_1.AppError(errors_1.ErrorCodes.ENCRYPTION_ERROR, "Nonce counter exhausted: cryptographic safety requires key rotation or process termination.");
    }
    else {
        nonceCounter++;
    }
    return nonce;
}
/**
 * Reset the nonce counter. Primarily for testing purposes.
 * @internal
 */
function _resetNonceCounter() {
    nonceCounter = 0n;
}
/**
 * Get the current nonce counter value. For testing purposes.
 * @internal
 */
function _getNonceCounter() {
    return nonceCounter;
}
function libsodiumEncryptForPublicKey(data, recipientPublicKey) {
    // Generate ephemeral keypair for this encryption
    var ephemeralKeyPair = tweetnacl_1.default.box.keyPair();
    // Generate hybrid nonce (24 bytes for box encryption: 16 random + 8 counter)
    var nonce = generateHybridNonce(tweetnacl_1.default.box.nonceLength);
    // Encrypt the data using box (authenticated encryption)
    var encrypted = tweetnacl_1.default.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);
    // Bundle format: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data
    var result = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
    result.set(ephemeralKeyPair.publicKey, 0);
    result.set(nonce, ephemeralKeyPair.publicKey.length);
    result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
    return result;
}
/**
 * Encrypt data using the secret key
 * @param data - The data to encrypt (must be JSON-serializable)
 * @param secret - The secret key to use for encryption
 * @returns The encrypted data
 */
function encryptLegacy(data, secret) {
    // Generate hybrid nonce (24 bytes for secretbox: 16 random + 8 counter)
    var nonce = generateHybridNonce(tweetnacl_1.default.secretbox.nonceLength);
    var encrypted = tweetnacl_1.default.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
    var result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
    return result;
}
/**
 * Decrypt data using the secret key
 * @param data - The data to decrypt
 * @param secret - The secret key to use for decryption
 * @returns The decrypted data, or null if decryption fails
 * @template T - The expected type of the decrypted data (defaults to unknown)
 */
function decryptLegacy(data, secret) {
    var nonce = data.slice(0, tweetnacl_1.default.secretbox.nonceLength);
    var encrypted = data.slice(tweetnacl_1.default.secretbox.nonceLength);
    var decrypted = tweetnacl_1.default.secretbox.open(encrypted, nonce, secret);
    if (!decrypted) {
        // Decryption failed - returning null is sufficient for error handling
        // Callers should handle the null case appropriately
        return null;
    }
    return JSON.parse(new TextDecoder().decode(decrypted));
}
/**
 * Encrypt data using AES-256-GCM with the data encryption key
 * @param data - The data to encrypt (must be JSON-serializable)
 * @param dataKey - The 32-byte AES-256 key
 * @returns The encrypted data bundle (nonce + ciphertext + auth tag)
 * @throws Error if dataKey is not exactly 32 bytes
 */
function encryptWithDataKey(data, dataKey) {
    if (dataKey.length !== 32) {
        throw new errors_1.AppError(errors_1.ErrorCodes.ENCRYPTION_ERROR, "Invalid encryption key length: expected 32 bytes, got ".concat(dataKey.length, " bytes"));
    }
    // Generate hybrid nonce (12 bytes for AES-GCM: 4 random + 8 counter)
    var nonce = generateHybridNonce(12);
    var cipher = (0, node_crypto_1.createCipheriv)('aes-256-gcm', dataKey, nonce);
    var plaintext = new TextEncoder().encode(JSON.stringify(data));
    var encrypted = Buffer.concat([
        cipher.update(plaintext),
        cipher.final()
    ]);
    var authTag = cipher.getAuthTag();
    // Bundle: version(1) + nonce (12) + ciphertext + auth tag (16)
    var bundle = new Uint8Array(12 + encrypted.length + 16 + 1);
    bundle.set([0], 0);
    bundle.set(nonce, 1);
    bundle.set(new Uint8Array(encrypted), 13);
    bundle.set(new Uint8Array(authTag), 13 + encrypted.length);
    return bundle;
}
/**
 * Decrypt data using AES-256-GCM with the data encryption key
 * @param bundle - The encrypted data bundle
 * @param dataKey - The 32-byte AES-256 key
 * @returns The decrypted data, or null if decryption fails
 * @throws Error if dataKey is not exactly 32 bytes
 * @template T - The expected type of the decrypted data (defaults to unknown)
 */
function decryptWithDataKey(bundle, dataKey) {
    if (dataKey.length !== 32) {
        throw new errors_1.AppError(errors_1.ErrorCodes.ENCRYPTION_ERROR, "Invalid decryption key length: expected 32 bytes, got ".concat(dataKey.length, " bytes"));
    }
    if (bundle.length < 1) {
        return null;
    }
    var formatVersion = bundle[0];
    // Handle legacy format (version 0x00)
    if (formatVersion === 0) {
        if (bundle.length < 12 + 16 + 1) { // Minimum: version + nonce + auth tag
            return null;
        }
        var nonce = bundle.slice(1, 13);
        var authTag = bundle.slice(bundle.length - 16);
        var ciphertext = bundle.slice(13, bundle.length - 16);
        try {
            var decipher = (0, node_crypto_1.createDecipheriv)('aes-256-gcm', dataKey, nonce);
            decipher.setAuthTag(authTag);
            var decrypted = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]);
            return JSON.parse(new TextDecoder().decode(decrypted));
        }
        catch (_a) {
            // Decryption failed
            return null;
        }
    }
    // Handle versioned format (version 0x01)
    // Note: For direct calls to decryptWithDataKey with versioned bundles,
    // the caller must provide the correct key for the embedded version.
    // Use KeyVersionManager.decrypt() for automatic key version handling.
    if (formatVersion === 1) {
        if (bundle.length < 31) { // Minimum: 1 + 2 + 12 + 0 + 16
            return null;
        }
        var nonce = bundle.slice(3, 15);
        var authTag = bundle.slice(bundle.length - 16);
        var ciphertext = bundle.slice(15, bundle.length - 16);
        try {
            var decipher = (0, node_crypto_1.createDecipheriv)('aes-256-gcm', dataKey, nonce);
            decipher.setAuthTag(authTag);
            var decrypted = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]);
            return JSON.parse(new TextDecoder().decode(decrypted));
        }
        catch (_b) {
            // Decryption failed
            return null;
        }
    }
    // Unknown format version
    return null;
}
function encrypt(key, variant, data) {
    if (variant === 'legacy') {
        return encryptLegacy(data, key);
    }
    else {
        return encryptWithDataKey(data, key);
    }
}
function decrypt(key, variant, data) {
    if (variant === 'legacy') {
        return decryptLegacy(data, key);
    }
    else {
        return decryptWithDataKey(data, key);
    }
}
// ============================================================================
// KEY VERSIONING AND ROTATION SUPPORT
// ============================================================================
/**
 * Bundle format version constants.
 * - VERSION_0: Original format without key versioning (legacy compatibility)
 * - VERSION_1: New format with embedded key version for rotation support
 */
var BUNDLE_VERSION_LEGACY = 0x00;
var BUNDLE_VERSION_KEYED = 0x01;
/**
 * Manages encryption key versions for secure key rotation.
 *
 * This class enables key rotation without breaking existing encrypted data:
 * - New encryptions use the current (latest) key version
 * - Decryptions automatically use the correct key based on the version in the bundle
 * - Old keys are retained to decrypt historical data
 *
 * Bundle format for versioned encryption (VERSION_1):
 * - Byte 0: 0x01 (format version)
 * - Bytes 1-2: Key version (uint16 big-endian)
 * - Bytes 3-14: Nonce (12 bytes for AES-GCM)
 * - Bytes 15 to N-16: Ciphertext
 * - Last 16 bytes: Auth tag
 *
 * @example
 * ```typescript
 * const manager = new KeyVersionManager(initialKey);
 *
 * // Encrypt with current key
 * const encrypted = manager.encrypt({ message: 'hello' });
 *
 * // Rotate to a new key
 * const newVersion = manager.rotateKey(newKey);
 *
 * // Old data can still be decrypted
 * const decrypted = manager.decrypt(encrypted); // Works!
 * ```
 */
var KeyVersionManager = /** @class */ (function () {
    /**
     * Creates a new KeyVersionManager with an initial key.
     *
     * @param initialKey - The initial 32-byte encryption key (becomes version 1)
     * @param config - Optional rotation configuration
     * @throws Error if initialKey is not exactly 32 bytes
     */
    function KeyVersionManager(initialKey, config) {
        if (config === void 0) { config = {}; }
        var _a;
        this.keys = new Map();
        this.currentVersion = 0;
        if (initialKey.length !== 32) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ENCRYPTION_ERROR, "Invalid initial key length: expected 32 bytes, got ".concat(initialKey.length, " bytes"));
        }
        this.config = __assign({ retainOldKeys: (_a = config.retainOldKeys) !== null && _a !== void 0 ? _a : 10 }, config);
        // Add the initial key as version 1
        this.addKey(initialKey);
        // Set up auto-rotation if configured
        if (this.config.autoRotateInterval && this.config.autoRotateInterval > 0) {
            this.startAutoRotation();
        }
    }
    /**
     * Adds a new key version.
     * @internal
     */
    KeyVersionManager.prototype.addKey = function (key) {
        this.currentVersion++;
        var keyVersion = {
            version: this.currentVersion,
            key: new Uint8Array(key), // Copy to prevent external mutation
            createdAt: new Date(),
            expiresAt: this.config.maxKeyAge
                ? new Date(Date.now() + this.config.maxKeyAge)
                : undefined
        };
        this.keys.set(this.currentVersion, keyVersion);
        this.pruneOldKeys();
        return this.currentVersion;
    };
    /**
     * Removes old keys beyond the retention limit.
     * @internal
     */
    KeyVersionManager.prototype.pruneOldKeys = function () {
        var _a;
        var retainCount = (_a = this.config.retainOldKeys) !== null && _a !== void 0 ? _a : 10;
        var versions = Array.from(this.keys.keys()).sort(function (a, b) { return a - b; });
        while (versions.length > retainCount) {
            var oldestVersion = versions.shift();
            this.keys.delete(oldestVersion);
        }
    };
    /**
     * Starts automatic key rotation timer.
     * @internal
     */
    KeyVersionManager.prototype.startAutoRotation = function () {
        var _this = this;
        if (this.autoRotateTimer) {
            clearInterval(this.autoRotateTimer);
        }
        this.autoRotateTimer = setInterval(function () {
            var newKey = getRandomBytes(32);
            _this.rotateKey(newKey);
        }, this.config.autoRotateInterval);
        // Don't prevent process exit
        if (this.autoRotateTimer.unref) {
            this.autoRotateTimer.unref();
        }
    };
    /**
     * Stops automatic key rotation.
     */
    KeyVersionManager.prototype.stopAutoRotation = function () {
        if (this.autoRotateTimer) {
            clearInterval(this.autoRotateTimer);
            this.autoRotateTimer = undefined;
        }
    };
    /**
     * Gets the current (latest) key version number.
     * @returns The current key version number
     */
    KeyVersionManager.prototype.getCurrentVersion = function () {
        return this.currentVersion;
    };
    /**
     * Gets the current (latest) encryption key.
     * @returns The current 32-byte encryption key
     */
    KeyVersionManager.prototype.getCurrentKey = function () {
        return new Uint8Array(this.keys.get(this.currentVersion).key);
    };
    /**
     * Gets a specific key version.
     * @param version - The key version to retrieve
     * @returns The key for that version, or undefined if not found
     */
    KeyVersionManager.prototype.getKey = function (version) {
        var keyVersion = this.keys.get(version);
        return keyVersion ? new Uint8Array(keyVersion.key) : undefined;
    };
    /**
     * Gets all available key versions.
     * @returns Array of available key version numbers
     */
    KeyVersionManager.prototype.getAvailableVersions = function () {
        return Array.from(this.keys.keys()).sort(function (a, b) { return a - b; });
    };
    /**
     * Checks if a key version is expired.
     * @param version - The key version to check
     * @returns True if expired, false otherwise
     */
    KeyVersionManager.prototype.isKeyExpired = function (version) {
        var keyVersion = this.keys.get(version);
        if (!keyVersion || !keyVersion.expiresAt) {
            return false;
        }
        return new Date() > keyVersion.expiresAt;
    };
    /**
     * Rotates to a new encryption key.
     *
     * After rotation:
     * - New encryptions will use the new key
     * - Old keys are retained for decrypting existing data
     * - Keys beyond the retention limit are removed
     *
     * @param newKey - The new 32-byte encryption key
     * @returns The new key version number
     * @throws Error if newKey is not exactly 32 bytes
     */
    KeyVersionManager.prototype.rotateKey = function (newKey) {
        if (newKey.length !== 32) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ENCRYPTION_ERROR, "Invalid key length: expected 32 bytes, got ".concat(newKey.length, " bytes"));
        }
        return this.addKey(newKey);
    };
    /**
     * Encrypts data using the current key version.
     *
     * The encrypted bundle includes the key version, allowing future decryption
     * even after key rotation.
     *
     * @param data - The data to encrypt (must be JSON-serializable)
     * @returns Encrypted bundle with embedded key version
     */
    KeyVersionManager.prototype.encrypt = function (data) {
        return encryptWithKeyVersion(data, this.getCurrentKey(), this.currentVersion);
    };
    /**
     * Decrypts data using the appropriate key version.
     *
     * Automatically determines the correct key from the bundle's embedded version.
     * Supports both versioned (0x01) and legacy (0x00) bundle formats.
     *
     * @param bundle - The encrypted bundle
     * @param legacyKey - Optional key to use for legacy (0x00) bundles
     * @returns Decrypted data, or null if decryption fails
     * @template T - The expected type of the decrypted data (defaults to unknown)
     */
    KeyVersionManager.prototype.decrypt = function (bundle, legacyKey) {
        if (bundle.length < 1) {
            return null;
        }
        var formatVersion = bundle[0];
        if (formatVersion === BUNDLE_VERSION_LEGACY) {
            // Legacy format - use provided legacy key or fall back to version 1
            var key = legacyKey !== null && legacyKey !== void 0 ? legacyKey : this.getKey(1);
            if (!key) {
                return null;
            }
            return decryptWithDataKey(bundle, key);
        }
        if (formatVersion === BUNDLE_VERSION_KEYED) {
            // Versioned format - extract key version from bundle
            if (bundle.length < 3) {
                return null;
            }
            var keyVersion = (bundle[1] << 8) | bundle[2];
            var key = this.getKey(keyVersion);
            if (!key) {
                return null; // Key version not found
            }
            return decryptVersionedBundle(bundle, key);
        }
        // Unknown format version
        return null;
    };
    /**
     * Gets metadata about a specific key version.
     * @param version - The key version to get info for
     * @returns Key version info or undefined if not found
     */
    KeyVersionManager.prototype.getKeyInfo = function (version) {
        var keyVersion = this.keys.get(version);
        if (!keyVersion) {
            return undefined;
        }
        return {
            version: keyVersion.version,
            createdAt: keyVersion.createdAt,
            expiresAt: keyVersion.expiresAt
        };
    };
    /**
     * Serializes the key manager state for persistence.
     * WARNING: This exports sensitive key material. Handle with care.
     * @returns Serialized state containing all keys
     */
    KeyVersionManager.prototype.exportState = function () {
        var _a;
        var keys = [];
        for (var _i = 0, _b = this.keys; _i < _b.length; _i++) {
            var _c = _b[_i], version = _c[0], keyVersion = _c[1];
            keys.push({
                version: version,
                key: encodeBase64(keyVersion.key),
                createdAt: keyVersion.createdAt.toISOString(),
                expiresAt: (_a = keyVersion.expiresAt) === null || _a === void 0 ? void 0 : _a.toISOString()
            });
        }
        return { keys: keys, currentVersion: this.currentVersion };
    };
    /**
     * Creates a KeyVersionManager from exported state.
     * @param state - Previously exported state
     * @param config - Optional rotation configuration
     * @returns Restored KeyVersionManager
     */
    KeyVersionManager.fromExportedState = function (state, config) {
        if (config === void 0) { config = {}; }
        if (state.keys.length === 0) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ENCRYPTION_ERROR, 'Cannot restore KeyVersionManager: no keys in state');
        }
        // Sort keys by version to find the first one
        var sortedKeys = __spreadArray([], state.keys, true).sort(function (a, b) { return a.version - b.version; });
        var firstKey = decodeBase64(sortedKeys[0].key);
        // Create manager with the first key
        var manager = new KeyVersionManager(firstKey, config);
        // Clear the auto-created version 1 and restore from state
        manager.keys.clear();
        manager.currentVersion = 0;
        // Restore all keys
        for (var _i = 0, _a = state.keys; _i < _a.length; _i++) {
            var keyData = _a[_i];
            var keyVersion = {
                version: keyData.version,
                key: decodeBase64(keyData.key),
                createdAt: new Date(keyData.createdAt),
                expiresAt: keyData.expiresAt ? new Date(keyData.expiresAt) : undefined
            };
            manager.keys.set(keyData.version, keyVersion);
            if (keyData.version > manager.currentVersion) {
                manager.currentVersion = keyData.version;
            }
        }
        return manager;
    };
    return KeyVersionManager;
}());
exports.KeyVersionManager = KeyVersionManager;
/**
 * Encrypts data with a specific key version embedded in the bundle.
 *
 * @param data - The data to encrypt (must be JSON-serializable)
 * @param dataKey - The 32-byte encryption key
 * @param keyVersion - The key version number (1-65535)
 * @returns Encrypted bundle with embedded key version
 * @throws Error if dataKey is not 32 bytes or keyVersion is out of range
 */
function encryptWithKeyVersion(data, dataKey, keyVersion) {
    if (dataKey.length !== 32) {
        throw new errors_1.AppError(errors_1.ErrorCodes.ENCRYPTION_ERROR, "Invalid encryption key length: expected 32 bytes, got ".concat(dataKey.length, " bytes"));
    }
    if (keyVersion < 1 || keyVersion > 65535) {
        throw new errors_1.AppError(errors_1.ErrorCodes.INVALID_INPUT, "Invalid key version: must be between 1 and 65535, got ".concat(keyVersion));
    }
    // Generate hybrid nonce (12 bytes for AES-GCM: 4 random + 8 counter)
    var nonce = generateHybridNonce(12);
    var cipher = (0, node_crypto_1.createCipheriv)('aes-256-gcm', dataKey, nonce);
    var plaintext = new TextEncoder().encode(JSON.stringify(data));
    var encrypted = Buffer.concat([
        cipher.update(plaintext),
        cipher.final()
    ]);
    var authTag = cipher.getAuthTag();
    // Bundle: version(1=0x01) + keyVersion(2) + nonce(12) + ciphertext + authTag(16)
    var bundle = new Uint8Array(1 + 2 + 12 + encrypted.length + 16);
    bundle[0] = BUNDLE_VERSION_KEYED;
    bundle[1] = (keyVersion >> 8) & 0xff; // High byte
    bundle[2] = keyVersion & 0xff; // Low byte
    bundle.set(nonce, 3);
    bundle.set(new Uint8Array(encrypted), 15);
    bundle.set(new Uint8Array(authTag), 15 + encrypted.length);
    return bundle;
}
/**
 * Decrypts a versioned bundle (format version 0x01).
 *
 * @param bundle - The encrypted bundle
 * @param dataKey - The 32-byte encryption key for this version
 * @returns Decrypted data, or null if decryption fails
 * @template T - The expected type of the decrypted data (defaults to unknown)
 * @internal
 */
function decryptVersionedBundle(bundle, dataKey) {
    if (dataKey.length !== 32) {
        throw new errors_1.AppError(errors_1.ErrorCodes.ENCRYPTION_ERROR, "Invalid decryption key length: expected 32 bytes, got ".concat(dataKey.length, " bytes"));
    }
    // Bundle: version(1) + keyVersion(2) + nonce(12) + ciphertext + authTag(16)
    // Minimum length: 1 + 2 + 12 + 0 + 16 = 31 bytes
    if (bundle.length < 31) {
        return null;
    }
    if (bundle[0] !== BUNDLE_VERSION_KEYED) {
        return null;
    }
    var nonce = bundle.slice(3, 15);
    var authTag = bundle.slice(bundle.length - 16);
    var ciphertext = bundle.slice(15, bundle.length - 16);
    try {
        var decipher = (0, node_crypto_1.createDecipheriv)('aes-256-gcm', dataKey, nonce);
        decipher.setAuthTag(authTag);
        var decrypted = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]);
        return JSON.parse(new TextDecoder().decode(decrypted));
    }
    catch (_a) {
        // Decryption failed
        return null;
    }
}
/**
 * Extracts the key version from an encrypted bundle without decrypting.
 *
 * @param bundle - The encrypted bundle
 * @returns Object with format version and key version (if applicable), or null if invalid
 */
function getEncryptedBundleInfo(bundle) {
    if (bundle.length < 1) {
        return null;
    }
    var formatVersion = bundle[0];
    if (formatVersion === BUNDLE_VERSION_LEGACY) {
        return { formatVersion: formatVersion };
    }
    if (formatVersion === BUNDLE_VERSION_KEYED) {
        if (bundle.length < 3) {
            return null;
        }
        var keyVersion = (bundle[1] << 8) | bundle[2];
        return { formatVersion: formatVersion, keyVersion: keyVersion };
    }
    return null;
}
/**
 * Generate authentication challenge response
 */
function authChallenge(secret) {
    var keypair = tweetnacl_1.default.sign.keyPair.fromSeed(secret);
    var challenge = getRandomBytes(32);
    var signature = tweetnacl_1.default.sign.detached(challenge, keypair.secretKey);
    return {
        challenge: challenge,
        publicKey: keypair.publicKey,
        signature: signature
    };
}
