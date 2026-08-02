import test from 'node:test';
import assert from 'node:assert/strict';
import { createCachedBalanceReader } from './solana-rpc-cache.js';

const key = { toBase58: () => 'wallet-1' };

test('balance reader caches repeated reads inside the requested age', async () => {
    let calls = 0;
    let time = 1_000;
    const reader = createCachedBalanceReader({
        primaryConnection: { getBalance: async () => { calls += 1; return 42; } },
        now: () => time,
    });
    assert.deepEqual(await reader.read(key, { maxAgeMs: 10_000 }), { lamports: 42, fromCache: false });
    time += 1_000;
    assert.deepEqual(await reader.read(key, { maxAgeMs: 10_000 }), { lamports: 42, fromCache: true });
    assert.equal(calls, 1);
});

test('balance reader deduplicates simultaneous requests', async () => {
    let calls = 0;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const reader = createCachedBalanceReader({
        primaryConnection: { getBalance: async () => { calls += 1; await pending; return 99; } },
    });
    const first = reader.read(key);
    const second = reader.read(key);
    release();
    assert.equal((await first).lamports, 99);
    assert.equal((await second).lamports, 99);
    assert.equal(calls, 1);
});

test('forced balance reads bypass the cache', async () => {
    let calls = 0;
    const reader = createCachedBalanceReader({
        primaryConnection: { getBalance: async () => ++calls },
    });
    await reader.read(key, { maxAgeMs: 60_000 });
    const forced = await reader.read(key, { maxAgeMs: 60_000, force: true });
    assert.equal(forced.lamports, 2);
    assert.equal(calls, 2);
});
