import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
} from 'node:crypto';

const PREFIX = 'enc:v1';

function readEncryptionKey(raw = process.env.WALLET_ENCRYPTION_KEY, name = 'WALLET_ENCRYPTION_KEY') {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    let key;
    if (/^[a-f0-9]{64}$/i.test(trimmed)) {
        key = Buffer.from(trimmed, 'hex');
    } else {
        key = Buffer.from(trimmed, 'base64');
    }
    if (key.length !== 32) {
        throw new Error(`${name} must decode to exactly 32 bytes`);
    }
    return key;
}

function readDecryptionKeys() {
    const primary = readEncryptionKey();
    if (!primary) return [];
    const previous = String(process.env.WALLET_ENCRYPTION_KEY_PREVIOUS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value, index) => readEncryptionKey(value, `WALLET_ENCRYPTION_KEY_PREVIOUS[${index}]`));
    const seen = new Set();
    return [primary, ...previous].filter((key) => {
        const fingerprint = key.toString('hex');
        if (seen.has(fingerprint)) return false;
        seen.add(fingerprint);
        return true;
    });
}

export function hasWalletEncryptionKey() {
    return !!readEncryptionKey();
}

export function isEncryptedWalletSecret(value) {
    return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

export function encryptWalletSecret(secretBytes) {
    const key = readEncryptionKey();
    if (!key) {
        throw new Error('WALLET_ENCRYPTION_KEY is required to create custodial wallets');
    }
    const plaintext = Buffer.from(secretBytes);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
        PREFIX,
        iv.toString('base64url'),
        tag.toString('base64url'),
        encrypted.toString('base64url'),
    ].join(':');
}

export function decryptWalletSecretWithMetadata(value, { allowLegacy = true } = {}) {
    if (isEncryptedWalletSecret(value)) {
        const keys = readDecryptionKeys();
        if (!keys.length) throw new Error('WALLET_ENCRYPTION_KEY is not configured');
        const parts = String(value).split(':');
        if (parts.length !== 5) throw new Error('Encrypted wallet secret is malformed');
        const iv = Buffer.from(parts[2], 'base64url');
        const tag = Buffer.from(parts[3], 'base64url');
        const encrypted = Buffer.from(parts[4], 'base64url');
        if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) {
            throw new Error('Encrypted wallet secret is malformed');
        }
        for (let index = 0; index < keys.length; index += 1) {
            try {
                const decipher = createDecipheriv('aes-256-gcm', keys[index], iv);
                decipher.setAuthTag(tag);
                return {
                    secret: Buffer.concat([decipher.update(encrypted), decipher.final()]),
                    keySource: index === 0 ? 'primary' : 'previous',
                };
            } catch {
                // Authentication failure means the secret may belong to another configured key.
            }
        }
        const error = new Error('No configured wallet encryption key could decrypt the secret');
        error.code = 'WALLET_DECRYPT_FAILED';
        throw error;
    }
    if (!allowLegacy) throw new Error('Custodial wallet secret has not been encrypted');
    if (!/^[a-f0-9]{128}$/i.test(String(value || ''))) {
        throw new Error('Legacy wallet secret is malformed');
    }
    return { secret: Buffer.from(value, 'hex'), keySource: 'legacy' };
}

export function decryptWalletSecret(value, options) {
    return decryptWalletSecretWithMetadata(value, options).secret;
}

export function reencryptLegacyWalletSecret(value) {
    if (isEncryptedWalletSecret(value)) return value;
    return encryptWalletSecret(decryptWalletSecret(value, { allowLegacy: true }));
}

export function rotateWalletSecretEncryption(value) {
    return encryptWalletSecret(decryptWalletSecret(value, { allowLegacy: true }));
}
