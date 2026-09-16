import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForActiveSetToDrain } from './reset-safety.js';

test('arena reset waits for an entry already being confirmed', async () => {
    const active = new Set(['user-1']);
    let ticks = 0;
    const drained = await waitForActiveSetToDrain(active, {
        maxWaitMs: 10,
        pollMs: 1,
        now: () => ticks,
        delay: async () => {
            ticks += 1;
            active.clear();
        },
    });
    assert.equal(drained, true);
});

test('arena reset fails closed when an entry never finishes', async () => {
    const active = new Set(['user-1']);
    let ticks = 0;
    const drained = await waitForActiveSetToDrain(active, {
        maxWaitMs: 3,
        pollMs: 1,
        now: () => ticks,
        delay: async () => { ticks += 1; },
    });
    assert.equal(drained, false);
    assert.equal(active.size, 1);
});
