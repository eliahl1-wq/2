export const STARTER_REWARD_FUNDING_BUCKET_USD = 5;

/**
 * Paid Normal games required before a free-ticket cashout becomes claimable.
 * Three $5 games fund $3 and one $10 game funds $2, so every multiplier
 * contributes exactly one $5 bucket to the reward wallet.
 */
export function getStarterRewardFundingRequirements(sponsoredRewardsBalanceUsd = 0) {
    const balanceUsd = Math.max(0, Number(sponsoredRewardsBalanceUsd) || 0);
    const fundingTargetUsd = Math.max(STARTER_REWARD_FUNDING_BUCKET_USD, balanceUsd);
    const multiplier = Math.ceil(fundingTargetUsd / STARTER_REWARD_FUNDING_BUCKET_USD);
    return {
        req5: multiplier * 3,
        req10: multiplier,
        fundingTargetUsd: multiplier * STARTER_REWARD_FUNDING_BUCKET_USD,
    };
}
