import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerialOperationQueue } from './serial-operation-queue.js';

test('serial operation queue never overlaps wallet mutations', async () => {
    const queue = createSerialOperationQueue();
    let active = 0;
    let maxActive = 0;
    const order = [];

    await Promise.all([1, 2, 3].map(value => queue.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        order.push(value);
        active -= 1;
    })));

    assert.equal(maxActive, 1);
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(queue.size, 0);
});

test('a failed wallet mutation does not block the queue', async () => {
    const queue = createSerialOperationQueue();
    await assert.rejects(queue.run(async () => { throw new Error('failed'); }), /failed/);
    assert.equal(await queue.run(async () => 42), 42);
    assert.equal(queue.size, 0);
});
