import test from 'node:test';
import assert from 'node:assert/strict';
import { AffiliateProfile } from './affiliate-system.js';

test('affiliate profiles require explicit activation', () => {
    const profile = new AffiliateProfile({
        userId: '507f1f77bcf86cd799439011',
        referralCode: 'creator_one',
        referralCodeNormalized: 'creator_one',
    });
    assert.equal(profile.enabled, false);
    assert.equal(profile.activatedAt, null);
});

test('affiliate activation is tracked separately from suspension state', () => {
    assert.ok(AffiliateProfile.schema.path('activatedAt'));
    assert.ok(AffiliateProfile.schema.path('enabled'));
    assert.ok(AffiliateProfile.schema.path('suspendedAt'));
});
