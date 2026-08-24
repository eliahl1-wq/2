import {
    BPS_SCALE,
    USD_MICROS_PER_USD,
    microsToUsd,
    multiplyMicrosByBps,
    usdToMicros,
} from './affiliate-money.js';

export const PERMANENT_REWARD_RATE_BPS = 2_000;
export const PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS = 20 * USD_MICROS_PER_USD;
export const PERMANENT_REWARD_PER_CYCLE_USD_MICROS = multiplyMicrosByBps(
    PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS,
    PERMANENT_REWARD_RATE_BPS,
);

export function permanentProgressReserveUsd(progressVolumeUsdMicros = 0) {
    const progress = Math.max(0, Math.floor(Number(progressVolumeUsdMicros) || 0));
    return microsToUsd(multiplyMicrosByBps(progress, PERMANENT_REWARD_RATE_BPS));
}

/**
 * Allocate the existing 20% normal-entry reward share without ever creating
 * two liabilities from the same dollar. An unfinished starter reward is
 * funded first; the remainder advances the permanent $20 -> $4 cycle.
 */
export function calculatePermanentRewardAllocation({
    entryFeeUsd,
    starterFundingRemainingUsd = 0,
    progressVolumeUsdMicros = 0,
}) {
    const entryVolumeUsdMicros = usdToMicros(entryFeeUsd);
    const contributionUsdMicros = multiplyMicrosByBps(entryVolumeUsdMicros, PERMANENT_REWARD_RATE_BPS);
    const starterRemainingUsdMicros = usdToMicros(Math.max(0, Number(starterFundingRemainingUsd) || 0));
    const starterFundingUsdMicros = Math.min(contributionUsdMicros, starterRemainingUsdMicros);
    const permanentFundingUsdMicros = contributionUsdMicros - starterFundingUsdMicros;
    const permanentVolumeUsdMicros = Number(
        (BigInt(permanentFundingUsdMicros) * BigInt(BPS_SCALE)) / BigInt(PERMANENT_REWARD_RATE_BPS),
    );

    if (!Number.isSafeInteger(progressVolumeUsdMicros) || progressVolumeUsdMicros < 0) {
        throw new RangeError('Permanent reward progress must be non-negative USD micros');
    }
    const combinedProgressUsdMicros = progressVolumeUsdMicros + permanentVolumeUsdMicros;
    const cyclesCompleted = Math.floor(combinedProgressUsdMicros / PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS);
    const nextProgressVolumeUsdMicros = combinedProgressUsdMicros % PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS;
    const unlockedRewardUsdMicros = cyclesCompleted * PERMANENT_REWARD_PER_CYCLE_USD_MICROS;

    return {
        entryVolumeUsdMicros,
        contributionUsdMicros,
        contributionUsd: microsToUsd(contributionUsdMicros),
        starterFundingUsdMicros,
        starterFundingUsd: microsToUsd(starterFundingUsdMicros),
        permanentFundingUsdMicros,
        permanentFundingUsd: microsToUsd(permanentFundingUsdMicros),
        permanentVolumeUsdMicros,
        permanentVolumeUsd: microsToUsd(permanentVolumeUsdMicros),
        cyclesCompleted,
        nextProgressVolumeUsdMicros,
        nextProgressVolumeUsd: microsToUsd(nextProgressVolumeUsdMicros),
        unlockedRewardUsdMicros,
        unlockedRewardUsd: microsToUsd(unlockedRewardUsdMicros),
    };
}

export function serializePermanentRewards(user = {}) {
    const progressVolumeUsdMicros = Math.max(0, Math.floor(Number(user.permanentRewardProgressVolumeUsdMicros) || 0));
    const balanceUsdMicros = Math.max(0, Math.floor(Number(user.permanentRewardsBalanceUsdMicros) || 0));
    const lifetimeVolumeUsdMicros = Math.max(0, Math.floor(Number(user.permanentRewardLifetimeVolumeUsdMicros) || 0));
    const lifetimeEarnedUsdMicros = Math.max(0, Math.floor(Number(user.permanentRewardLifetimeEarnedUsdMicros) || 0));
    const starterFundingRemainingUsd = user.sponsoredRewardsCompleted
        ? 0
        : Math.max(0, (Number(user.sponsoredRewardsBalance) || 0) - (Number(user.fundedRewardsUsd) || 0));
    return {
        rateBps: PERMANENT_REWARD_RATE_BPS,
        ratePct: PERMANENT_REWARD_RATE_BPS / 100,
        cycleVolumeUsd: microsToUsd(PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS),
        rewardPerCycleUsd: microsToUsd(PERMANENT_REWARD_PER_CYCLE_USD_MICROS),
        progressVolumeUsd: microsToUsd(progressVolumeUsdMicros),
        progressPct: Math.min(100, (progressVolumeUsdMicros / PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS) * 100),
        volumeRemainingUsd: microsToUsd(PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS - progressVolumeUsdMicros),
        balanceUsd: microsToUsd(balanceUsdMicros),
        lifetimeVolumeUsd: microsToUsd(lifetimeVolumeUsdMicros),
        lifetimeEarnedUsd: microsToUsd(lifetimeEarnedUsdMicros),
        cyclesCompleted: Math.max(0, Math.floor(Number(user.permanentRewardCyclesCompleted) || 0)),
        starterFundingRemainingUsd: Number(starterFundingRemainingUsd.toFixed(6)),
    };
}
