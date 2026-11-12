import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisitorTracker, visitorKey, depositGrowthPipeline, summarizeDepositGrowth, getVisitorAnalytics } from './platform-analytics.js';
import { REPORTED_TRANSACTION_MATCH } from './reporting-filters.js';

const id = '00000000-0000-4000-8000-000000000001';
const window = { from: new Date('2026-11-06Z'), previousFrom: new Date('2026-10-30Z'), to: new Date('2026-11-12T12:00:00Z') };

test('visitor identity is pseudonymous, stable, namespace/key specific and rejects malformed input', () => {
    assert.equal(visitorKey(id, 'test'), visitorKey(id, 'test'));
    assert.match(visitorKey(id, 'test'), /^[a-f0-9]{64}$/);
    assert.notEqual(visitorKey(id, 'other'), visitorKey(id, 'test'));
    for (const invalid of [null, {}, '', '1.2.3.4', '<script>', 'x'.repeat(1000)]) assert.equal(visitorKey(invalid, 'test'), null);
    assert.equal(visitorKey(id), null);
});

test('tracking deduplicates heartbeat writes but records login and a new UTC day', async () => {
    let now = Date.parse('2026-11-12T23:59:00Z');
    const writes = [], states = [];
    const track = createVisitorTracker({ Visit: { updateOne: async (...args) => writes.push(args) },
        State: { updateOne: async (...args) => states.push(args) }, secret: 'test', clock: () => now });
    assert.equal(await track({ id, userAgent: 'Android Mobile', page: '/pre-game?secret=abc' }), true);
    assert.equal(await track({ id }), false);
    assert.equal(await track({ id, userId: 'user1' }), true);
    assert.equal(await track({ id, userId: 'user1' }), false);
    now += 60_000;
    assert.equal(await track({ id, userId: 'user1' }), true);
    assert.equal(writes.length, 3);
    assert.equal(states.length, 1);
    assert.equal(JSON.stringify(writes).includes('secret=abc'), false);
    assert.equal(writes[0][1].$setOnInsert.device, 'mobile');
    assert.equal(writes[1][1].$addToSet.userIds, 'user1');
    assert.notEqual(writes[0][0].day.getTime(), writes[2][0].day.getTime());
    assert.equal(JSON.stringify(writes).includes(id), false);
});

test('tracking excludes obvious crawlers, retries failed writes and never rejects callers', async () => {
    let attempts = 0;
    const track = createVisitorTracker({ Visit: { updateOne: async () => { if (++attempts === 1) throw Error('offline'); } },
        State: { updateOne: async () => {} }, secret: 'test' });
    assert.equal(await track({ id, userAgent: 'Googlebot' }), false);
    assert.equal(attempts, 0);
    assert.equal(await track({ id }), false);
    assert.equal(await track({ id }), true);
    assert.equal(attempts, 2);
});

test('unique depositors, earliest-ever deposits and signup cohort are distinct metrics', () => {
    const result = summarizeDepositGrowth([
        { _id: 'new', firstAt: '2026-11-07Z', currentCount: 3, previousCount: 0, currentSol: 2 },
        { _id: 'returning', firstAt: '2026-01-01Z', currentCount: 1, previousCount: 2, currentSol: 1 },
        { _id: 'prev', firstAt: '2026-11-01Z', currentCount: 0, previousCount: 1, currentSol: 0 },
        { _id: 'old-new-depositor', firstAt: '2026-11-06Z', currentCount: 1, previousCount: 0, currentSol: .5 },
    ], { ...window, newUserIds: ['new'] });
    assert.deepEqual(result, { depositors: 3, previousDepositors: 2, firstDepositors: 2,
        previousFirstDepositors: 1, repeatDepositors: 1, multiDepositAccounts: 1,
        newUsersWhoDeposited: 1, deposits: 5, depositSol: 3.5 });
});

test('empty data is safe and zero deposits never imply conversions', () => {
    const result = summarizeDepositGrowth([], window);
    assert.ok(Object.values(result).every(value => value === 0));
});

test('deposit pipeline uses confirmed real customer scope and indexed earliest history, not just this period', () => {
    const match = { ...REPORTED_TRANSACTION_MATCH, type: 'deposit', status: 'confirmed', userId: { $nin: ['owner', 'excluded'] } };
    const pipeline = depositGrowthPipeline(match, window);
    assert.deepEqual(pipeline[0].$match.$and[0], match);
    assert.equal(pipeline[0].$match.$and[1].amount.$gt, 0);
    assert.equal(pipeline[0].$match.$and[1].createdAt.$gte, window.previousFrom);
    const lookup = pipeline[1].$facet.accounts.find(stage => stage.$lookup).$lookup;
    assert.deepEqual(lookup.pipeline[0].$match.$and[0], match);
    assert.equal(lookup.pipeline[0].$match.$and[1].createdAt.$gte, undefined);
    assert.equal(lookup.pipeline[2].$limit, 1);
});

test('visitor totals are cross-day deduplicated, coverage stays explicit, owners are excluded', async () => {
    let pipeline;
    const data = await getVisitorAnalytics({ aggregate: async input => {
        pipeline = input;
        return [{ current: [{ count: 5 }], previous: [{ count: 3 }], daily: [{ _id: '2026-11-12', visitors: 4 }], devices: [] }];
    } }, { findById: () => ({ lean: async () => ({ since: new Date('2026-11-09Z') }) }) }, { ...window, excludedUserIds: ['owner'] });
    assert.equal(data.visitors, 5);
    assert.equal(data.complete, false);
    assert.equal(data.previousComplete, false);
    assert.deepEqual(pipeline[0].$match.userIds, { $nin: ['owner'] });
    assert.deepEqual(pipeline[1].$facet.current[1], { $group: { _id: '$visitorKey' } });
});
