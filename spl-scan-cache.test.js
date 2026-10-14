import test from 'node:test';
import assert from 'node:assert/strict';
import { createSplScanCache } from './spl-scan-cache.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
test('manual force rescan bypasses a fresh saved balance and waits for the new on-chain result', async () => {
    let calls = 0, release, saved;
    const record = { tokens: [{ amountAtomic: '10' }], attemptedAt: new Date(100_000), checkedAt: new Date(100_000) };
    const cache = createSplScanCache({ now: () => 100_010, scan: async () => {
        calls++; await new Promise(resolve => { release = resolve; }); return [{ amountAtomic: '50' }];
    }, save: async (_address, result) => { saved = result; } });
    assert.equal((await cache.get('wallet', record)).tokens[0].amountAtomic, '10');
    assert.equal(calls, 0);
    let completed = false;
    const forced = cache.get('wallet', record, { force: true }).then(result => { completed = true; return result; });
    const duplicate = cache.get('wallet', record, { force: true });
    await settle();
    assert.equal(completed, false); assert.equal(calls, 1);
    release();
    const result = await forced;
    assert.equal(result.tokens[0].amountAtomic, '50');
    assert.equal((await duplicate).tokens[0].amountAtomic, '50');
    assert.equal(saved.tokens[0].amountAtomic, '50');
    assert.equal(result.cached, false);
});
test('saved empty wallets return immediately, revalidate and discover new or changed tokens', async () => {
    let now = 100_000;
    let calls = 0;
    let tokens = [];
    const saved = new Map();
    const options = { now: () => now, scan: async () => { calls++; return tokens; },
        save: async (address, record) => saved.set(address, record) };
    let cache = createSplScanCache(options);
    const first = await cache.get('wallet', null);
    assert.deepEqual(first.tokens, []);
    assert.equal(calls, 1);
    // Simulated process restart still reads persisted data, without RPC.
    cache = createSplScanCache(options);
    assert.deepEqual((await cache.get('wallet', saved.get('wallet'))).tokens, []);
    assert.equal(calls, 1);
    now += 61_000; tokens = [{ mint: 'new-token', amountAtomic: '10' }];
    const stale = await cache.get('wallet', saved.get('wallet'));
    assert.deepEqual(stale.tokens, []);
    assert.equal(stale.refreshing, true);
    await settle();
    assert.equal((await cache.get('wallet', saved.get('wallet'))).tokens[0].amountAtomic, '10');
    now += 61_000; tokens = [{ mint: 'new-token', amountAtomic: '25' }];
    await cache.get('wallet', saved.get('wallet')); await settle();
    assert.equal(saved.get('wallet').tokens[0].amountAtomic, '25');
    now += 61_000; tokens = [];
    await cache.get('wallet', saved.get('wallet')); await settle();
    assert.deepEqual(saved.get('wallet').tokens, []);
});

test('RPC failures retain known balances and back off instead of replacing them with zero', async () => {
    let calls = 0;
    const old = { tokens: [{ amountAtomic: '123' }], checkedAt: new Date(1), attemptedAt: new Date(1) };
    let saved;
    const cache = createSplScanCache({ now: () => 100_000, scan: async () => { calls++; throw new Error('RPC unavailable'); },
        save: async (_address, record) => { saved = record; } });
    await cache.get('wallet', old); await settle();
    assert.deepEqual(saved.tokens, old.tokens);
    assert.equal(saved.checkedAt.getTime(), 1);
    assert.equal(saved.error, 'RPC unavailable');
    await cache.get('wallet', saved);
    assert.equal(calls, 1);
});

test('requests share one scan per wallet and respect global concurrency', async () => {
    let active = 0, peak = 0, calls = 0;
    const release = [];
    const cache = createSplScanCache({ concurrency: 2, scan: async () => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise(resolve => release.push(resolve)); active--; return [];
    }, save: async () => {} });
    const requests = [cache.get('same', null), cache.get('same', null), cache.get('other', null), cache.get('third', null)];
    assert.equal(calls, 2);
    release.shift()(); release.shift()(); await settle();
    assert.equal(calls, 3); assert.equal(peak, 2);
    release.shift()(); await Promise.all(requests);
});

test('cache-only first load does not wait for RPC; invalidation rejects in-flight old results', async () => {
    let release;
    const saved = [];
    const cache = createSplScanCache({ scan: async () => {
        await new Promise(resolve => { release = resolve; }); return [{ amountAtomic: 'old' }];
    }, save: async (_address, record) => saved.push(record) });
    const immediate = await cache.get('wallet', null, { cachedOnly: true });
    assert.equal(immediate.refreshing, true);
    assert.deepEqual(immediate.tokens, []);
    cache.invalidate('wallet'); release(); await settle();
    assert.equal(saved.length, 0);
});

test('saved-balance listing can skip stale RPC refreshes', async () => {
    let calls = 0;
    const cache = createSplScanCache({
        scan: async () => { calls++; return []; },
        save: async () => {},
    });
    const result = await cache.get('wallet', null, { cachedOnly: true, refreshStale: false });
    assert.equal(calls, 0);
    assert.equal(result.refreshing, false);
    assert.deepEqual(result.tokens, []);
});
