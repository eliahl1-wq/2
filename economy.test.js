import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ALLOWED_ENTRY_FEES,
    COMPETITIVE_SLITHER_ENTRY_FEES,
    getCompetitiveEconomy,
    getEconomy,
    getJoinPoolSplit,
    getRewardPoolSplit,
} from './economy.js';

const populations = [1, 2, 3, 7, 8, 30];

test('Competitive Slither exposes separate $1, $2, and $5 economies', () => {
    assert.deepEqual(COMPETITIVE_SLITHER_ENTRY_FEES, [1, 2, 5]);
    for (const entryFeeUsd of COMPETITIVE_SLITHER_ENTRY_FEES) {
        const eco = getCompetitiveEconomy(entryFeeUsd);
        assert.equal(eco.entryFeeUsd, entryFeeUsd);
        assert.equal(eco.dollarStart, entryFeeUsd);
        assert.equal(eco.cashoutPlayerPct + eco.cashoutFeePct, 1);
    }
    const oneDollar = getCompetitiveEconomy(1);
    assert.equal(oneDollar.cashoutFeePct, 0.05);
    assert.equal(oneDollar.dollarStart * oneDollar.cashoutPlayerPct, 0.95);
});

for (const entryFeeUsd of ALLOWED_ENTRY_FEES) {
    for (const population of populations) {
        test(`$${entryFeeUsd} join conserves value at population ${population}`, () => {
            const eco = getEconomy(entryFeeUsd);
            const { food, ai } = getJoinPoolSplit(entryFeeUsd, population);
            const total = eco.playerStartBalance + food + ai;
            assert.equal(total, entryFeeUsd);
            assert.ok(food >= 0);
            assert.ok(ai >= 0);
        });
    }
}

// --- Reward Pool Split tests ---
for (const entryFeeUsd of ALLOWED_ENTRY_FEES) {
    test(`$${entryFeeUsd} reward pool split conserves value`, () => {
        const { food, ai, rewardPoolContribution, ownerVaultContribution } = getRewardPoolSplit(entryFeeUsd);
        const playerStart = entryFeeUsd * 0.10;
        const total = playerStart + food + ai + rewardPoolContribution + ownerVaultContribution;
        assert.ok(Math.abs(total - entryFeeUsd) < 1e-9, `Total ${total} should equal entry ${entryFeeUsd}`);
        assert.ok(food >= 0);
        assert.ok(ai >= 0);
        assert.ok(rewardPoolContribution >= 0);
        assert.ok(ownerVaultContribution >= 0);
    });
}

test('$5 reward pool split routes extra to reward pool', () => {
    const split = getRewardPoolSplit(5);
    assert.equal(split.rewardPoolContribution, 1.0);
    assert.equal(split.ownerVaultContribution, 0);
    assert.equal(split.food, 2.5);  // includes golden blob ($0.50)
    assert.equal(split.ai, 1.0);
});

test('$10 reward pool split routes extra to reward pool', () => {
    const split = getRewardPoolSplit(10);
    assert.equal(split.rewardPoolContribution, 2.0);
    assert.equal(split.ownerVaultContribution, 0);
    assert.equal(split.food, 5.0);  // includes golden blob ($1.00)
    assert.equal(split.ai, 2.0);
});

test('$20 reward pool split routes extra to owner vault', () => {
    const split = getRewardPoolSplit(20);
    assert.equal(split.rewardPoolContribution, 0);
    assert.equal(split.ownerVaultContribution, 4.0);
    assert.equal(split.food, 10.0);  // includes golden blob ($2.00)
    assert.equal(split.ai, 4.0);
});
