import test from 'node:test';
import assert from 'node:assert/strict';
import {
    decryptWalletSecret,
    decryptWalletSecretWithMetadata,
    encryptWalletSecret,
    isEncryptedWalletSecret,
    reencryptLegacyWalletSecret,
    rotateWalletSecretEncryption,
} from './wallet-crypto.js';

function restoreEnv(name, value) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
}

test('custodial secrets encrypt with AES-GCM and round trip', () => {
    const previous = process.env.WALLET_ENCRYPTION_KEY;
    const previousKeys = process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
    process.env.WALLET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    delete process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
    try {
        const secret = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
        const encrypted = encryptWalletSecret(secret);
        assert.equal(isEncryptedWalletSecret(encrypted), true);
        assert.notEqual(encrypted, secret.toString('hex'));
        assert.deepEqual(decryptWalletSecret(encrypted, { allowLegacy: false }), secret);
    } finally {
        restoreEnv('WALLET_ENCRYPTION_KEY', previous);
        restoreEnv('WALLET_ENCRYPTION_KEY_PREVIOUS', previousKeys);
    }
});

test('legacy hex secrets can be migrated once', () => {
    const previous = process.env.WALLET_ENCRYPTION_KEY;
    const previousKeys = process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
    process.env.WALLET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('hex');
    delete process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
    try {
        const legacy = Buffer.alloc(64, 3).toString('hex');
        const encrypted = reencryptLegacyWalletSecret(legacy);
        assert.equal(isEncryptedWalletSecret(encrypted), true);
        assert.deepEqual(decryptWalletSecret(encrypted), Buffer.alloc(64, 3));
        assert.equal(reencryptLegacyWalletSecret(encrypted), encrypted);
    } finally {
        restoreEnv('WALLET_ENCRYPTION_KEY', previous);
        restoreEnv('WALLET_ENCRYPTION_KEY_PREVIOUS', previousKeys);
    }
});

test('wallet secrets remain decryptable during key rotation', () => {
    const primaryBefore = process.env.WALLET_ENCRYPTION_KEY;
    const previousBefore = process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
    const oldKey = Buffer.alloc(32, 11).toString('base64');
    const newKey = Buffer.alloc(32, 12).toString('base64');
    try {
        process.env.WALLET_ENCRYPTION_KEY = oldKey;
        delete process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
        const secret = Buffer.alloc(64, 4);
        const encryptedWithOldKey = encryptWalletSecret(secret);

        process.env.WALLET_ENCRYPTION_KEY = newKey;
        process.env.WALLET_ENCRYPTION_KEY_PREVIOUS = oldKey;
        const decrypted = decryptWalletSecretWithMetadata(encryptedWithOldKey, { allowLegacy: false });
        assert.deepEqual(decrypted.secret, secret);
        assert.equal(decrypted.keySource, 'previous');

        const rotated = rotateWalletSecretEncryption(encryptedWithOldKey);
        delete process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
        assert.deepEqual(decryptWalletSecret(rotated, { allowLegacy: false }), secret);
    } finally {
        restoreEnv('WALLET_ENCRYPTION_KEY', primaryBefore);
        restoreEnv('WALLET_ENCRYPTION_KEY_PREVIOUS', previousBefore);
    }
});

test('wallet decryption fails with a stable error code when no key matches', () => {
    const primaryBefore = process.env.WALLET_ENCRYPTION_KEY;
    const previousBefore = process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
    try {
        process.env.WALLET_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64');
        delete process.env.WALLET_ENCRYPTION_KEY_PREVIOUS;
        const encrypted = encryptWalletSecret(Buffer.alloc(64, 5));
        process.env.WALLET_ENCRYPTION_KEY = Buffer.alloc(32, 14).toString('base64');
        assert.throws(
            () => decryptWalletSecret(encrypted, { allowLegacy: false }),
            (error) => error.code === 'WALLET_DECRYPT_FAILED',
        );
    } finally {
        restoreEnv('WALLET_ENCRYPTION_KEY', primaryBefore);
        restoreEnv('WALLET_ENCRYPTION_KEY_PREVIOUS', previousBefore);
    }
});
