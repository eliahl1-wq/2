import {
    USD_MICROS_PER_USD,
    microsToUsd,
    multiplyMicrosByBps,
    usdToMicros,
} from './affiliate-money.js';

/** Users receive 50% of the platform/owner cut paid on eligible cashouts. */
export const PERMANENT_REWARD_OWNER_CUT_SHARE_BPS = 5_000;
/** Reserve 55% of that cut: 50% liability + 5% safety surplus. */
export const PERMANENT_REWARD_POOL_SHARE_BPS = 5_500;
export const PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS = 50 * USD_MICROS_PER_USD;

// Kept in the public payload for backwards-compatible clients. At the normal
// 8% cashout fee, 50% of the cut equals 4% of gross cashout volume.
export const PERMANENT_REWARD_RATE_BPS = 400;
export const PERMANENT_REWARD_PER_CYCLE_USD_MICROS = multiplyMicrosByBps(
    PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS,
    PERMANENT_REWARD_RATE_BPS,
);

export function permanentProgressReserveUsd(progressRewardUsdMicros = 0) {
    return microsToUsd(Math.max(0, Math.floor(Number(progressRewardUsdMicros) || 0)));
}

/** Apply one confirmed cashout to the recurring reward cycle. */
export function calculatePermanentRewardAllocation({
    grossCashoutUsd,
    ownerCutUsd,
    progressVolumeUsdMicros = 0,
    progressRewardUsdMicros = 0,
}) {
    const cashoutVolumeUsdMicros = usdToMicros(grossCashoutUsd);
    const ownerCutUsdMicros = usdToMicros(ownerCutUsd);
    const rewardContributionUsdMicros = multiplyMicrosByBps(
        ownerCutUsdMicros,
        PERMANENT_REWARD_OWNER_CUT_SHARE_BPS,
    );
    const poolFundingUsdMicros = multiplyMicrosByBps(
        ownerCutUsdMicros,
        PERMANENT_REWARD_POOL_SHARE_BPS,
    );
    const ownerSurplusUsdMicros = Math.max(0, poolFundingUsdMicros - rewardContributionUsdMicros);

    if (!Number.isSafeInteger(progressVolumeUsdMicros) || progressVolumeUsdMicros < 0) {
        throw new RangeError('Permanent reward cashout progress must be non-negative USD micros');
    }
    if (!Number.isSafeInteger(progressRewardUsdMicros) || progressRewardUsdMicros < 0) {
        throw new RangeError('Permanent reward pending amount must be non-negative USD micros');
    }

    const combinedVolumeUsdMicros = progressVolumeUsdMicros + cashoutVolumeUsdMicros;
    const cyclesCompleted = Math.floor(combinedVolumeUsdMicros / PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS);
    const nextProgressVolumeUsdMicros = combinedVolumeUsdMicros % PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS;

    let nextProgressRewardUsdMicros = progressRewardUsdMicros + rewardContributionUsdMicros;
    let unlockedRewardUsdMicros = 0;
    if (cyclesCompleted > 0) {
        // The remaining progress is the tail of this cashout. Keep its matching
        // fee share pending and unlock everything belonging to completed cycles.
        const pendingTailUsdMicros = cashoutVolumeUsdMicros > 0
            ? Number(
                (BigInt(rewardContributionUsdMicros) * BigInt(nextProgressVolumeUsdMicros))
                / BigInt(cashoutVolumeUsdMicros)
            )
            : 0;
        unlockedRewardUsdMicros = progressRewardUsdMicros
            + rewardContributionUsdMicros
            - pendingTailUsdMicros;
        nextProgressRewardUsdMicros = pendingTailUsdMicros;
    }

    return {
        cashoutVolumeUsdMicros,
        cashoutVolumeUsd: microsToUsd(cashoutVolumeUsdMicros),
        ownerCutUsdMicros,
        ownerCutUsd: microsToUsd(ownerCutUsdMicros),
        rewardContributionUsdMicros,
        rewardContributionUsd: microsToUsd(rewardContributionUsdMicros),
        poolFundingUsdMicros,
        poolFundingUsd: microsToUsd(poolFundingUsdMicros),
        ownerSurplusUsdMicros,
        ownerSurplusUsd: microsToUsd(ownerSurplusUsdMicros),
        cyclesCompleted,
        nextProgressVolumeUsdMicros,
        nextProgressVolumeUsd: microsToUsd(nextProgressVolumeUsdMicros),
        nextProgressRewardUsdMicros,
        nextProgressRewardUsd: microsToUsd(nextProgressRewardUsdMicros),
        unlockedRewardUsdMicros,
        unlockedRewardUsd: microsToUsd(unlockedRewardUsdMicros),
    };
}

export function serializePermanentRewards(user = {}) {
    const progressVolumeUsdMicros = Math.max(0, Math.floor(Number(user.permanentRewardProgressVolumeUsdMicros) || 0));
    const progressRewardUsdMicros = Math.max(0, Math.floor(Number(user.permanentRewardProgressEarnedUsdMicros) || 0));
    const balanceUsdMicros = Math.max(0, Math.floor(Number(user.permanentRewardsBalanceUsdMicros) || 0));
    const lifetimeVolumeUsdMicros = Math.max(0, Math.floor(Number(user.permanentRewardLifetimeVolumeUsdMicros) || 0));
    const lifetimeEarnedUsdMicros = Math.max(0, Math.floor(Number(user.permanentRewardLifetimeEarnedUsdMicros) || 0));
    const starterFundingRemainingUsd = user.sponsoredRewardsCompleted
        ? 0
        : Math.max(0, (Number(user.sponsoredRewardsBalance) || 0) - (Number(user.fundedRewardsUsd) || 0));
    return {
        rateBps: PERMANENT_REWARD_RATE_BPS,
        ratePct: PERMANENT_REWARD_RATE_BPS / 100,
        ownerCutShareBps: PERMANENT_REWARD_OWNER_CUT_SHARE_BPS,
        poolShareBps: PERMANENT_REWARD_POOL_SHARE_BPS,
        cycleVolumeUsd: microsToUsd(PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS),
        rewardPerCycleUsd: microsToUsd(PERMANENT_REWARD_PER_CYCLE_USD_MICROS),
        progressVolumeUsd: microsToUsd(progressVolumeUsdMicros),
        progressRewardUsd: microsToUsd(progressRewardUsdMicros),
        progressPct: Math.min(100, (progressVolumeUsdMicros / PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS) * 100),
        volumeRemainingUsd: microsToUsd(PERMANENT_REWARD_CYCLE_VOLUME_USD_MICROS - progressVolumeUsdMicros),
        balanceUsd: microsToUsd(balanceUsdMicros),
        lifetimeVolumeUsd: microsToUsd(lifetimeVolumeUsdMicros),
        lifetimeEarnedUsd: microsToUsd(lifetimeEarnedUsdMicros),
        cyclesCompleted: Math.max(0, Math.floor(Number(user.permanentRewardCyclesCompleted) || 0)),
        starterFundingRemainingUsd: Number(starterFundingRemainingUsd.toFixed(6)),
    };
}
