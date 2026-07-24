import test from 'node:test';
import assert from 'node:assert/strict';
import {
    decryptWalletSecret,
    encryptWalletSecret,
    isEncryptedWalletSecret,
    reencryptLegacyWalletSecret,
} from './wallet-crypto.js';

test('custodial secrets encrypt with AES-GCM and round trip', () => {
    const previous = process.env.WALLET_ENCRYPTION_KEY;
    process.env.WALLET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
        const secret = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
        const encrypted = encryptWalletSecret(secret);
        assert.equal(isEncryptedWalletSecret(encrypted), true);
        assert.notEqual(encrypted, secret.toString('hex'));
        assert.deepEqual(decryptWalletSecret(encrypted, { allowLegacy: false }), secret);
    } finally {
        if (previous == null) delete process.env.WALLET_ENCRYPTION_KEY;
        else process.env.WALLET_ENCRYPTION_KEY = previous;
    }
});

test('legacy hex secrets can be migrated once', () => {
    const previous = process.env.WALLET_ENCRYPTION_KEY;
    process.env.WALLET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('hex');
    try {
        const legacy = Buffer.alloc(64, 3).toString('hex');
        const encrypted = reencryptLegacyWalletSecret(legacy);
        assert.equal(isEncryptedWalletSecret(encrypted), true);
        assert.deepEqual(decryptWalletSecret(encrypted), Buffer.alloc(64, 3));
        assert.equal(reencryptLegacyWalletSecret(encrypted), encrypted);
    } finally {
        if (previous == null) delete process.env.WALLET_ENCRYPTION_KEY;
        else process.env.WALLET_ENCRYPTION_KEY = previous;
    }
});
