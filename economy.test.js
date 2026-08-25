import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ALLOWED_ENTRY_FEES,
    COMPETITIVE_SLITHER_ENTRY_FEES,
    getCompetitiveEconomy,
    getEconomy,
    getJoinPoolSplit,
    getRewardPoolSplit,
    getSurvivEconomy,
    NORMAL_ENTRY_OWNER_CUT_PCT,
} from './economy.js';

const populations = [1, 2, 3, 7, 8, 30];

test('Competitive Slither exposes separate $1, $2, and $5 economies', () => {
    assert.deepEqual(COMPETITIVE_SLITHER_ENTRY_FEES, [1, 2, 5]);
    for (const entryFeeUsd of COMPETITIVE_SLITHER_ENTRY_FEES) {
        const eco = getCompetitiveEconomy(entryFeeUsd);
        assert.equal(eco.entryFeeUsd, entryFeeUsd);
        assert.equal(eco.dollarStart, entryFeeUsd);
        assert.equal(eco.playerStartBalance, 1.0);
        assert.equal(eco.massPerPellet, 0.02);
        assert.equal(eco.cashoutPlayerPct + eco.cashoutFeePct, 1);
    }
});

test('all eligible cashout modes use the global 8% platform fee', () => {
    for (const entryFeeUsd of ALLOWED_ENTRY_FEES) {
        assert.equal(getEconomy(entryFeeUsd).cashoutFeePct, 0.08);
    }
    for (const entryFeeUsd of COMPETITIVE_SLITHER_ENTRY_FEES) {
        const economy = getCompetitiveEconomy(entryFeeUsd);
        assert.equal(economy.cashoutFeePct, 0.08);
        assert.equal(economy.cashoutPlayerPct, 0.92);
    }
    assert.equal(getSurvivEconomy(5).cashoutFeePct, 0.08);
});

for (const entryFeeUsd of ALLOWED_ENTRY_FEES) {
    for (const population of populations) {
        test(`$${entryFeeUsd} join conserves value at population ${population}`, () => {
            const eco = getEconomy(entryFeeUsd);
            const { food, ai, ownerVaultContribution } = getJoinPoolSplit(entryFeeUsd, population);
            const total = eco.playerStartBalance + food + ai + ownerVaultContribution;
            assert.ok(Math.abs(total - entryFeeUsd) < 1e-9, `Total ${total} should equal entry ${entryFeeUsd}`);
            assert.ok(food >= 0);
            assert.ok(ai >= 0);
            assert.equal(ownerVaultContribution, entryFeeUsd * NORMAL_ENTRY_OWNER_CUT_PCT);
        });
    }
}

test('Normal Agar and Slither use 20% starting dollars without changing starting mass', () => {
    for (const entryFeeUsd of ALLOWED_ENTRY_FEES) {
        const eco = getEconomy(entryFeeUsd);
        assert.equal(eco.playerStartBalance, entryFeeUsd * 0.20);
        assert.equal(eco.botStartBalance, eco.playerStartBalance);
        assert.equal(eco.massStartBalance, 1.0);
    }
});

test('Normal food pellets have double value and growth so the target count is halved', () => {
    const eco = getEconomy(10);
    assert.equal(eco.foodBlobValue, 0.04);
    assert.equal(eco.massPerPellet, 0.04);
});

// --- Reward Pool Split tests ---
for (const entryFeeUsd of ALLOWED_ENTRY_FEES) {
    test(`$${entryFeeUsd} reward pool split conserves value`, () => {
        const { food, ai, rewardPoolContribution, ownerVaultContribution } = getRewardPoolSplit(entryFeeUsd);
        const playerStart = entryFeeUsd * 0.20;
        const total = playerStart + food + ai + rewardPoolContribution + ownerVaultContribution;
        assert.ok(Math.abs(total - entryFeeUsd) < 1e-9, `Total ${total} should equal entry ${entryFeeUsd}`);
        assert.ok(food >= 0);
        assert.ok(ai >= 0);
        assert.ok(rewardPoolContribution >= 0);
        assert.ok(ownerVaultContribution >= 0);
    });
}

test('$5 starter-reward split routes its reserved share to the reward pool', () => {
    const split = getRewardPoolSplit(5);
    assert.equal(split.rewardPoolContribution, 1.0);
    assert.equal(split.ownerVaultContribution, 0.25);
    assert.equal(split.food, 1.75);  // includes golden blob ($0.50)
    assert.equal(split.ai, 1.0);
});

test('$10 starter-reward split routes its reserved share to the reward pool', () => {
    const split = getRewardPoolSplit(10);
    assert.equal(split.rewardPoolContribution, 2.0);
    assert.equal(split.ownerVaultContribution, 0.50);
    assert.equal(split.food, 3.50);  // includes golden blob ($1.00)
    assert.equal(split.ai, 2.0);
});

test('$20 starter-reward split routes its reserved share to the reward pool', () => {
    const split = getRewardPoolSplit(20);
    assert.equal(split.rewardPoolContribution, 4.0);
    assert.equal(split.ownerVaultContribution, 1.0);
    assert.equal(split.food, 7.0);  // includes golden blob ($2.00)
    assert.equal(split.ai, 4.0);
});
