import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ALLOWED_ENTRY_FEES,
    getEconomy,
    getJoinPoolSplit,
    getRewardPoolSplit,
    getRewardChallengeFundingSummary,
} from './economy.js';

const populations = [1, 2, 3, 7, 8, 30];

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

test('challenge funding tracks exact owner surplus below $5 reward', () => {
    const summary = getRewardChallengeFundingSummary(3, 3, 1);
    assert.deepEqual(summary, { rewardUsd: 3, fundedUsd: 5, surplusUsd: 2 });
});

test('challenge funding tracks rounding surplus above $5 reward', () => {
    const summary = getRewardChallengeFundingSummary(7.25, 6, 2);
    assert.deepEqual(summary, { rewardUsd: 7.25, fundedUsd: 10, surplusUsd: 2.75 });
});

test('challenge funding never creates negative owner surplus', () => {
    const summary = getRewardChallengeFundingSummary(6, 3, 1);
    assert.deepEqual(summary, { rewardUsd: 6, fundedUsd: 5, surplusUsd: 0 });
});