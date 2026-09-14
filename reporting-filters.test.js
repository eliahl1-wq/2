import test from 'node:test';
import assert from 'node:assert/strict';
import { REPORTED_TRANSACTION_MATCH, isFreePlayTransaction } from './reporting-filters.js';

test('real-money reporting filter excludes every free-play marker', () => {
    assert.deepEqual(REPORTED_TRANSACTION_MATCH.excludedFromReports, { $ne: true });
    assert.deepEqual(REPORTED_TRANSACTION_MATCH['meta.simulated'], { $ne: true });
    assert.deepEqual(REPORTED_TRANSACTION_MATCH['meta.freePlay'], { $ne: true });
    assert.deepEqual(REPORTED_TRANSACTION_MATCH['meta.freeMode'], { $ne: true });
    assert.deepEqual(REPORTED_TRANSACTION_MATCH['meta.publicFreeMode'], { $ne: true });
    assert.deepEqual(REPORTED_TRANSACTION_MATCH['meta.personalFreePlay'], { $ne: true });
});

test('free-play detection covers current and legacy transaction formats', () => {
    assert.equal(isFreePlayTransaction({ excludedFromReports: true }), true);
    assert.equal(isFreePlayTransaction({ meta: { simulated: true } }), true);
    assert.equal(isFreePlayTransaction({ meta: { publicFreeMode: true } }), true);
    assert.equal(isFreePlayTransaction({ meta: { personalFreePlay: true } }), true);
    assert.equal(isFreePlayTransaction({ meta: { signature: 'simulated' } }), true);
    assert.equal(isFreePlayTransaction({ meta: { signature: 'simulated_claim' } }), true);
    assert.equal(isFreePlayTransaction({ meta: { roomId: 'personal-freeplay-arena-public-10' } }), true);
    assert.equal(isFreePlayTransaction({ excludedFromReports: false, meta: { signature: '5RealSolanaSignature' } }), false);
});
