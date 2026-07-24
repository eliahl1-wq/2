import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
} from 'node:crypto';

const PREFIX = 'enc:v1';

function readEncryptionKey(raw = process.env.WALLET_ENCRYPTION_KEY) {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    let key;
    if (/^[a-f0-9]{64}$/i.test(trimmed)) {
        key = Buffer.from(trimmed, 'hex');
    } else {
        key = Buffer.from(trimmed, 'base64');
    }
    if (key.length !== 32) {
        throw new Error('WALLET_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }
    return key;
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

export function decryptWalletSecret(value, { allowLegacy = true } = {}) {
    if (isEncryptedWalletSecret(value)) {
        const key = readEncryptionKey();
        if (!key) throw new Error('WALLET_ENCRYPTION_KEY is not configured');
        const parts = String(value).split(':');
        if (parts.length !== 5) throw new Error('Encrypted wallet secret is malformed');
        const iv = Buffer.from(parts[2], 'base64url');
        const tag = Buffer.from(parts[3], 'base64url');
        const encrypted = Buffer.from(parts[4], 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    }
    if (!allowLegacy) throw new Error('Custodial wallet secret has not been encrypted');
    if (!/^[a-f0-9]{128}$/i.test(String(value || ''))) {
        throw new Error('Legacy wallet secret is malformed');
    }
    return Buffer.from(value, 'hex');
}

export function reencryptLegacyWalletSecret(value) {
    if (isEncryptedWalletSecret(value)) return value;
    return encryptWalletSecret(decryptWalletSecret(value, { allowLegacy: true }));
}
