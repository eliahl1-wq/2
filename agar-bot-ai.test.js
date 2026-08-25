import test from 'node:test';
import assert from 'node:assert/strict';
import { getAgarBotCellCenter, planAgarBotEscapeSplit, planAgarBotSplit } from './agar-bot-ai.js';

test('Agar bot takes a safe split-kill inside launch range', () => {
    const plan = planAgarBotSplit({
        cells: [{ id: 'large', x: 100, y: 100, balance: 3, radius: 55 }],
        prey: { id: 'prey', x: 300, y: 100, balance: 1, radius: 32 },
        now: 5000,
        lastSplitAt: 0,
        massStart: 1,
    });
    assert.equal(plan?.sourceCellId, 'large');
    assert.equal(plan?.angle, 0);
});

test('Agar bot refuses a split that leaves its launched half too small', () => {
    const plan = planAgarBotSplit({
        cells: [{ id: 'large', x: 0, y: 0, balance: 2.1, radius: 45 }],
        prey: { id: 'prey', x: 150, y: 0, balance: 1, radius: 32 },
        now: 5000,
        massStart: 1,
    });
    assert.equal(plan, null);
});

test('Agar regroup target is the mass-weighted center of every split cell', () => {
    const center = getAgarBotCellCenter([
        { x: 0, y: 20, balance: 1 },
        { x: 100, y: 20, balance: 3 },
    ]);
    assert.deepEqual(center, { x: 75, y: 20 });
});

test('Agar bot can sacrifice a rear half to split away from a close predator', () => {
    const plan = planAgarBotEscapeSplit({
        cells: [{ id: 'bot', x: 200, y: 100, balance: 4, radius: 60 }],
        threat: { x: 100, y: 100, balance: 8, radius: 80 },
        now: 5000,
        massStart: 1,
    });
    assert.equal(plan?.sourceCellId, 'bot');
    assert.equal(plan?.angle, 0);
});
