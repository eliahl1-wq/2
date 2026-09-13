import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_MISSING_BROADCAST_TIMEOUT_MS,
    shouldReleaseMissingBroadcastClaim,
} from './reward-claim-reconciliation.js';

test('missing broadcast claim remains reserved during the confirmation window', () => {
    const now = Date.parse('2026-09-13T12:00:00.000Z');
    assert.equal(shouldReleaseMissingBroadcastClaim({
        updatedAt: new Date(now - DEFAULT_MISSING_BROADCAST_TIMEOUT_MS + 1),
    }, now), false);
});

test('missing broadcast claim is released after the confirmation window', () => {
    const now = Date.parse('2026-09-13T12:00:00.000Z');
    assert.equal(shouldReleaseMissingBroadcastClaim({
        updatedAt: new Date(now - DEFAULT_MISSING_BROADCAST_TIMEOUT_MS),
    }, now), true);
});

test('claim without a valid timestamp is never released automatically', () => {
    assert.equal(shouldReleaseMissingBroadcastClaim({ updatedAt: null }), false);
});
