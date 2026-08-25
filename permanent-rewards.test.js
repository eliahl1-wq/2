import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS,
    calculatePermanentRewardAllocation,
    permanentProgressReserveUsd,
    serializePermanentRewards,
} from './permanent-rewards.js';

test('$50 cashout at an 8% owner cut unlocks exactly 35% of the paid cut', () => {
    const result = calculatePermanentRewardAllocation({ grossCashoutUsd: 50, ownerCutUsd: 4 });
    assert.equal(result.rewardContributionUsd, 1.4);
    assert.equal(result.poolFundingUsd, 1.6);
    assert.equal(result.ownerSurplusUsd, 0.2);
    assert.equal(result.unlockedRewardUsd, 1.4);
    assert.equal(result.cyclesCompleted, 1);
    assert.equal(result.nextProgressVolumeUsd, 0);
});

test('reward follows the actual charged owner cut instead of a hardcoded gross rate', () => {
    const result = calculatePermanentRewardAllocation({ grossCashoutUsd: 50, ownerCutUsd: 5 });
    assert.equal(result.unlockedRewardUsd, 1.75);
    assert.equal(result.poolFundingUsd, 2);
    assert.equal(result.ownerSurplusUsd, 0.25);
});

test('cashout progress carries across transactions', () => {
    const first = calculatePermanentRewardAllocation({ grossCashoutUsd: 20, ownerCutUsd: 1.6 });
    const second = calculatePermanentRewardAllocation({
        grossCashoutUsd: 30,
        ownerCutUsd: 2.4,
        progressVolumeUsdMicros: first.nextProgressVolumeUsdMicros,
        progressRewardUsdMicros: first.nextProgressRewardUsdMicros,
    });
    assert.equal(first.nextProgressVolumeUsd, 20);
    assert.equal(first.nextProgressRewardUsd, 0.56);
    assert.equal(second.unlockedRewardUsd, 1.4);
    assert.equal(second.nextProgressVolumeUsd, 0);
});

test('a cashout crossing a cycle keeps the tail reward pending', () => {
    const result = calculatePermanentRewardAllocation({
        grossCashoutUsd: 10,
        ownerCutUsd: 0.8,
        progressVolumeUsdMicros: 45_000_000,
        progressRewardUsdMicros: 1_260_000,
    });
    assert.equal(result.unlockedRewardUsd, 1.4);
    assert.equal(result.nextProgressVolumeUsd, 5);
    assert.equal(result.nextProgressRewardUsd, 0.14);
});

test('multiple cycles can unlock in one large cashout', () => {
    const result = calculatePermanentRewardAllocation({ grossCashoutUsd: 105, ownerCutUsd: 8.4 });
    assert.equal(result.cyclesCompleted, 2);
    assert.equal(result.unlockedRewardUsd, 2.8);
    assert.equal(result.nextProgressVolumeUsd, 5);
    assert.equal(result.nextProgressRewardUsd, 0.14);
});

test('serialization exposes the $50 cycle and pending fee-based reward', () => {
    const data = serializePermanentRewards({
        permanentRewardProgressVolumeUsdMicros: PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS / 2,
        permanentRewardProgressEarnedUsdMicros: 700_000,
        permanentRewardsBalanceUsdMicros: 2_800_000,
        permanentRewardLifetimeVolumeUsdMicros: 100_000_000,
        permanentRewardLifetimeEarnedUsdMicros: 2_800_000,
        permanentRewardCyclesCompleted: 2,
    });
    assert.equal(data.cycleVolumeUsd, 50);
    assert.equal(data.rewardPerCycleUsd, 1.4);
    assert.equal(data.progressVolumeUsd, 25);
    assert.equal(data.progressRewardUsd, 0.7);
    assert.equal(data.progressPct, 50);
    assert.equal(data.volumeRemainingUsd, 25);
});

test('partial-cycle liability uses the tracked owner-cut reward amount', () => {
    assert.equal(permanentProgressReserveUsd(700_000), 0.7);
});
