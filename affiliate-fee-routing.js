function safeMicros(value) {
    const amount = Math.floor(Number(value) || 0);
    if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new RangeError('Fee routing amounts must be non-negative safe integers');
    }
    return amount;
}

/**
 * The full fee from a referred cashout belongs in Reward Wallet. Part of it
 * may already have been reserved by permanent rewards, so this returns only
 * the additional funding and additional owner surplus required.
 */
export function calculateReferredCashoutFeeRouting({
    platformFeeUsdMicros,
    affiliateCommissionUsdMicros,
    permanentPoolFundingUsdMicros = 0,
    permanentRewardContributionUsdMicros = 0,
    permanentOwnerSurplusUsdMicros = 0,
}) {
    const fee = safeMicros(platformFeeUsdMicros);
    const commission = Math.min(fee, safeMicros(affiliateCommissionUsdMicros));
    const permanentPool = Math.min(fee, safeMicros(permanentPoolFundingUsdMicros));
    const permanentReward = Math.min(fee, safeMicros(permanentRewardContributionUsdMicros));
    const existingSurplus = Math.min(permanentPool, safeMicros(permanentOwnerSurplusUsdMicros));
    const additionalFundingUsdMicros = fee - permanentPool;
    const totalOwnerSurplusUsdMicros = Math.max(0, fee - permanentReward - commission);
    const additionalOwnerSurplusUsdMicros = Math.min(
        additionalFundingUsdMicros,
        Math.max(0, totalOwnerSurplusUsdMicros - existingSurplus),
    );

    return {
        platformFeeUsdMicros: fee,
        affiliateCommissionUsdMicros: commission,
        permanentPoolFundingUsdMicros: permanentPool,
        additionalFundingUsdMicros,
        totalOwnerSurplusUsdMicros,
        additionalOwnerSurplusUsdMicros,
    };
}
