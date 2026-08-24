import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS,
    calculatePermanentRewardAllocation,
    permanentProgressReserveUsd,
    serializePermanentRewards,
} from './permanent-rewards.js';

test('$20 of eligible normal volume unlocks exactly $4 and starts a fresh cycle', () => {
    const result = calculatePermanentRewardAllocation({ entryFeeUsd: 20 });
    assert.equal(result.contributionUsd, 4);
    assert.equal(result.permanentVolumeUsd, 20);
    assert.equal(result.unlockedRewardUsd, 4);
    assert.equal(result.cyclesCompleted, 1);
    assert.equal(result.nextProgressVolumeUsd, 0);
});

test('permanent rewards carry progress across mixed normal entry tiers', () => {
    const first = calculatePermanentRewardAllocation({ entryFeeUsd: 5 });
    const second = calculatePermanentRewardAllocation({
        entryFeeUsd: 10,
        progressVolumeUsdMicros: first.nextProgressVolumeUsdMicros,
    });
    const third = calculatePermanentRewardAllocation({
        entryFeeUsd: 5,
        progressVolumeUsdMicros: second.nextProgressVolumeUsdMicros,
    });
    assert.equal(first.nextProgressVolumeUsd, 5);
    assert.equal(second.nextProgressVolumeUsd, 15);
    assert.equal(third.unlockedRewardUsd, 4);
    assert.equal(third.nextProgressVolumeUsd, 0);
});

test('ten $2 Normal entries unlock one full recurring reward', () => {
    let progressVolumeUsdMicros = 0;
    let unlockedRewardUsd = 0;
    for (let index = 0; index < 10; index += 1) {
        const result = calculatePermanentRewardAllocation({ entryFeeUsd: 2, progressVolumeUsdMicros });
        progressVolumeUsdMicros = result.nextProgressVolumeUsdMicros;
        unlockedRewardUsd += result.unlockedRewardUsd;
    }
    assert.equal(progressVolumeUsdMicros, 0);
    assert.equal(unlockedRewardUsd, 4);
});

test('starter funding receives priority without double-counting permanent rewards', () => {
    const result = calculatePermanentRewardAllocation({
        entryFeeUsd: 10,
        starterFundingRemainingUsd: 1.25,
    });
    assert.equal(result.contributionUsd, 2);
    assert.equal(result.starterFundingUsd, 1.25);
    assert.equal(result.permanentFundingUsd, 0.75);
    assert.equal(result.permanentVolumeUsd, 3.75);
    assert.equal(result.unlockedRewardUsd, 0);
});

test('serialization exposes the current cycle and lifetime totals', () => {
    const data = serializePermanentRewards({
        permanentRewardProgressVolumeUsdMicros: PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS / 2,
        permanentRewardsBalanceUsdMicros: 8_000_000,
        permanentRewardLifetimeVolumeUsdMicros: 55_000_000,
        permanentRewardLifetimeEarnedUsdMicros: 8_000_000,
        permanentRewardCyclesCompleted: 2,
        sponsoredRewardsBalance: 5,
        fundedRewardsUsd: 3,
    });
    assert.equal(data.progressVolumeUsd, 10);
    assert.equal(data.progressPct, 50);
    assert.equal(data.volumeRemainingUsd, 10);
    assert.equal(data.balanceUsd, 8);
    assert.equal(data.cyclesCompleted, 2);
    assert.equal(data.starterFundingRemainingUsd, 2);
});

test('partial cycle funding remains reserved before it becomes claimable', () => {
    assert.equal(permanentProgressReserveUsd(5_000_000), 1);
    assert.equal(permanentProgressReserveUsd(19_999_999), 4);
});
