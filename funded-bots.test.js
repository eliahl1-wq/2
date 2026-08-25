import test from 'node:test';
import assert from 'node:assert/strict';
import { getFundedBotSpawnCount } from './funded-bots.js';

test('one 20% AI allocation funds one 20% starting-balance bot', () => {
    assert.equal(getFundedBotSpawnCount({
        targetCount: 5,
        activeCount: 0,
        aiBudget: 2,
        botStake: 2,
    }), 1);
});

test('future economy changes can fund multiple bots without a hardcoded per-join limit', () => {
    assert.equal(getFundedBotSpawnCount({
        targetCount: 5,
        activeCount: 0,
        aiBudget: 4,
        botStake: 2,
    }), 2);
});

test('pending spawns and insufficient fractional budget prevent duplicate attempts', () => {
    assert.equal(getFundedBotSpawnCount({
        targetCount: 5,
        activeCount: 1,
        pendingCount: 1,
        aiBudget: 1.99,
        botStake: 2,
    }), 0);
});
