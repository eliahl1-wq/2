export const DEFAULT_SETTLEMENT_STALE_MS = 10 * 60 * 1000;

export function isFreshPositivePrice(price, updatedAt, now = Date.now(), maxAgeMs = 15 * 60 * 1000) {
    const numericPrice = Number(price);
    const timestamp = Number(updatedAt);
    const allowedAge = Math.max(60_000, Number(maxAgeMs) || 0);
    return Number.isFinite(numericPrice)
        && numericPrice > 0
        && Number.isFinite(timestamp)
        && timestamp > 0
        && now - timestamp <= allowedAge;
}

export function usdToLamportsCeil(amountUsd, solPriceUsd) {
    const amount = Math.max(0, Number(amountUsd) || 0);
    const price = Number(solPriceUsd);
    if (!Number.isFinite(price) || price <= 0) throw new RangeError('SOL price must be positive');
    return Math.max(0, Math.ceil((amount / price) * 1_000_000_000));
}

/**
 * Classify whether a native-SOL game cashout can be submitted. A zero-value
 * exit is not an error, while sender liquidity and destination rent are two
 * separate actionable failures and must not be reported as the same problem.
 */
export function classifyCashoutTransferReadiness({
    requestedLamports,
    payoutLamports,
    recipientLamports,
    rentMinimumLamports,
}) {
    const requested = Math.max(0, Math.floor(Number(requestedLamports) || 0));
    const payout = Math.max(0, Math.floor(Number(payoutLamports) || 0));
    const recipient = Math.max(0, Math.floor(Number(recipientLamports) || 0));
    const rentMinimum = Math.max(0, Math.floor(Number(rentMinimumLamports) || 0));

    if (requested <= 0) return 'no_value';
    if (payout <= 0) return 'liquidity_unavailable';
    if (recipient + payout < rentMinimum) {
        // If the requested transfer would have activated the destination but
        // the liquidity cap reduced it below rent, sender liquidity is the
        // actual blocker rather than the receiving wallet.
        if (payout < requested && recipient + requested >= rentMinimum) {
            return 'liquidity_unavailable';
        }
        return 'destination_rent_minimum';
    }
    return 'ready';
}

export function splitCollectedLamports(totalLamports, ownerBps) {
    const total = Math.max(0, Math.floor(Number(totalLamports) || 0));
    const bps = Math.min(10_000, Math.max(0, Math.floor(Number(ownerBps) || 0)));
    const ownerLamports = Math.floor((total * bps) / 10_000);
    return {
        totalLamports: total,
        ownerLamports,
        prizeLamports: total - ownerLamports,
    };
}

/**
 * Reward liabilities are USD-denominated while the wallet is funded in SOL.
 * Recompute the required SOL at the current price instead of assuming that an
 * older sweep is still sufficient after SOL moves.
 */
export function calculateRewardWalletTopUp({
    liabilityUsd,
    pendingHouseUsd,
    rewardWalletLamports,
    solPriceUsd,
    feeBufferLamports = 15_000,
}) {
    const balance = Math.max(0, Math.floor(Number(rewardWalletLamports) || 0));
    const feeBuffer = Math.max(0, Math.floor(Number(feeBufferLamports) || 0));
    const liabilityTarget = usdToLamportsCeil(liabilityUsd, solPriceUsd) + feeBuffer;
    const currentDeficit = Math.max(0, liabilityTarget - balance);
    const pendingTarget = usdToLamportsCeil(pendingHouseUsd, solPriceUsd);
    return {
        liabilityTargetLamports: liabilityTarget,
        currentDeficitLamports: currentDeficit,
        pendingTargetLamports: pendingTarget,
        requestedTopUpLamports: Math.max(currentDeficit, pendingTarget),
    };
}

/**
 * Missing signatures are ambiguous until their blockhash has expired. Once it
 * has expired (or an old legacy record exceeded the safety timeout), funds can
 * be released without risking a second valid transfer.
 */
export function classifySettlement({
    signatureStatus,
    currentBlockHeight,
    lastValidBlockHeight,
    updatedAt,
    now = Date.now(),
    staleMs = DEFAULT_SETTLEMENT_STALE_MS,
}) {
    if (signatureStatus?.err) return 'failed';
    if (['confirmed', 'finalized'].includes(signatureStatus?.confirmationStatus)) return 'confirmed';
    if (signatureStatus) return 'pending';

    const currentHeight = Number(currentBlockHeight);
    const lastHeight = Number(lastValidBlockHeight);
    if (Number.isFinite(currentHeight) && Number.isFinite(lastHeight) && currentHeight > lastHeight) {
        return 'expired';
    }

    const timestamp = new Date(updatedAt || 0).getTime();
    const timeout = Math.max(60_000, Number(staleMs) || DEFAULT_SETTLEMENT_STALE_MS);
    if ((!Number.isFinite(lastHeight) || lastHeight <= 0)
        && Number.isFinite(timestamp) && timestamp > 0 && now - timestamp >= timeout) {
        return 'expired';
    }
    return 'pending';
}
