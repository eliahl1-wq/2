import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailVerificationService } from './email-verification.js';

function fixture() {
    let clock = Date.now();
    let record = { _id: 'u1', email: 'old@example.com', emailVerifiedAt: new Date(), username: 'player' };
    const emails = [];
    const matches = filter => Object.entries(filter).every(([key, expected]) => {
        if (key === '$or') return expected.some(matches);
        const value = key.split('.').reduce((o, part) => o?.[part], record);
        if (expected && typeof expected === 'object') {
            if ('$exists' in expected) return (value !== undefined) === expected.$exists;
            if ('$gt' in expected) return value > expected.$gt;
            if ('$lte' in expected) return value <= expected.$lte;
        }
        return value === expected;
    });
    const apply = update => {
        for (const [key, value] of Object.entries(update.$set || {})) {
            if (key === 'emailChange.approved') record.emailChange.approved = value;
            else record[key] = value;
        }
        for (const key of Object.keys(update.$unset || {})) delete record[key];
    };
    const User = {
        exists: async () => false,
        findOne: filter => ({ select: async () => matches(filter) ? structuredClone(record) : null }),
        findOneAndUpdate: async (filter, update) => {
            if (!matches(filter)) return null;
            apply(update);
            return structuredClone(record);
        },
        updateOne: async (filter, update) => {
            if (!matches(filter)) return { matchedCount: 0 };
            apply(update);
            return { matchedCount: 1 };
        },
    };
    const service = createEmailVerificationService({ User, frontendUrl: 'https://arenifi.fun', apiKey: 'test', from: 'verify@arenifi.fun', now: () => clock,
        fetchImpl: async (_url, options) => { emails.push(JSON.parse(options.body)); return { ok: true, json: async () => ({}) }; },
    });
    const token = index => new URL(emails[index].text.match(/https:\/\/\S+/)[0]).searchParams.get('token');
    return { service, emails, token, user: () => record, advance: ms => { clock += ms; } };
}

test('email change requires both inboxes and consumes the final token atomically', async () => {
    const f = fixture();
    await f.service.startChange(f.user(), 'new@example.com');
    assert.equal(f.emails[0].to[0], 'old@example.com');
    assert.equal(f.user().email, 'old@example.com');
    await assert.rejects(f.service.confirmChange(f.token(0), 'new'));
    await f.service.confirmChange(f.token(0), 'old');
    assert.equal(f.emails[1].to[0], 'new@example.com');
    assert.equal(f.user().email, 'old@example.com');
    const result = await f.service.confirmChange(f.token(1), 'new');
    assert.equal(result.complete, true);
    assert.equal(f.user().email, 'new@example.com');
    assert.ok(f.user().emailVerifiedAt);
    await assert.rejects(f.service.confirmChange(f.token(1), 'new'));
    await assert.rejects(f.service.confirmChange(f.token(0), 'old'));
});

test('expired changes leave the current address intact', async () => {
    const f = fixture();
    await f.service.startChange(f.user(), 'new@example.com');
    f.advance(24 * 60 * 60 * 1000 + 1);
    await assert.rejects(f.service.confirmChange(f.token(0), 'old'));
    assert.equal(f.user().email, 'old@example.com');
});

test('ordinary verification cannot bypass approval from an unverified existing email', async () => {
    const f = fixture();
    f.user().emailVerifiedAt = null;
    await assert.rejects(f.service.start(f.user(), 'new@example.com'), error => error.code === 'EMAIL_CHANGE_REQUIRED');
    assert.equal(f.emails.length, 0);
});
