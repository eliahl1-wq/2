import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createEmailVerificationService,
    createEmailVerificationRequiredError,
    getEmailVerificationStatus,
    hashEmailVerificationToken,
    maskEmail,
    normalizeEmail,
} from './email-verification.js';

test('email normalization and masking are stable', () => {
    assert.equal(normalizeEmail('  Player@Example.COM '), 'player@example.com');
    assert.equal(normalizeEmail('not-an-email'), null);
    assert.equal(maskEmail('player@example.com'), 'pl****@example.com');
    assert.equal(hashEmailVerificationToken('a'.repeat(64)).length, 64);
});

test('verification status distinguishes legacy accounts, pending email, and verified email', () => {
    assert.equal(getEmailVerificationStatus({}), 'missing');
    assert.equal(getEmailVerificationStatus({ email: 'player@example.com' }), 'unverified');
    assert.equal(getEmailVerificationStatus({ email: 'player@example.com', emailVerifiedAt: new Date() }), 'verified');
});

test('sensitive action requirement is cleared permanently after verification', () => {
    const missing = createEmailVerificationRequiredError({});
    assert.equal(missing.code, 'EMAIL_VERIFICATION_REQUIRED');
    assert.equal(missing.details.emailRequired, true);
    const pending = createEmailVerificationRequiredError({ email: 'player@example.com' });
    assert.equal(pending.details.emailVerificationStatus, 'unverified');
    assert.equal(createEmailVerificationRequiredError({ email: 'player@example.com', emailVerifiedAt: new Date() }), null);
});

test('verification links are emailed, expire, and can only be used once', async () => {
    const sent = [];
    const record = {
        _id: 'user-1',
        username: 'player',
        email: 'player@example.com',
        emailVerifiedAt: null,
        async save() {},
    };
    const User = {
        async exists() { return false; },
        async updateOne() {},
        async findOneAndUpdate(filter, update) {
            if (record.emailVerificationTokenHash !== filter.emailVerificationTokenHash) return null;
            if (!(record.emailVerificationExpiresAt > filter.emailVerificationExpiresAt.$gt)) return null;
            record.emailVerifiedAt = update.$set.emailVerifiedAt;
            delete record.emailVerificationTokenHash;
            delete record.emailVerificationExpiresAt;
            delete record.emailVerificationLastSentAt;
            return record;
        },
    };
    const service = createEmailVerificationService({
        User,
        apiKey: 'test-key',
        from: 'Arenifi <verify@arenifi.fun>',
        frontendUrl: 'https://arenifi.fun',
        now: () => Date.parse('2026-09-26T12:00:00Z'),
        randomToken: () => 'a'.repeat(64),
        fetchImpl: async (_url, options) => {
            sent.push(JSON.parse(options.body));
            return { ok: true, json: async () => ({ id: 'email-1' }) };
        },
    });

    await service.start(record);
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /https:\/\/arenifi\.fun\/verify-email\?token=a{64}/);
    await service.confirm('a'.repeat(64));
    assert.ok(record.emailVerifiedAt instanceof Date);
    await assert.rejects(() => service.confirm('a'.repeat(64)), /invalid or has expired/);
});
