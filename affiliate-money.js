import { PLATFORM_CASHOUT_FEE_BPS } from './affiliate-config.js';

export const USD_MICROS_PER_USD = 1_000_000;
export const BPS_SCALE = 10_000;

export function usdToMicros(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1_000_000) {
        throw new RangeError('USD value must be between 0 and 1,000,000');
    }
    const micros = Math.round(numeric * USD_MICROS_PER_USD);
    if (!Number.isSafeInteger(micros)) throw new RangeError('USD value is outside the safe integer range');
    return micros;
}

export function microsToUsd(micros) {
    const numeric = Number(micros);
    if (!Number.isSafeInteger(numeric)) throw new RangeError('USD micros must be a safe integer');
    return numeric / USD_MICROS_PER_USD;
}

/** Exact integer basis-point multiplication with half-up rounding. */
export function multiplyMicrosByBps(micros, bps) {
    if (!Number.isSafeInteger(micros) || micros < 0) throw new RangeError('micros must be a non-negative safe integer');
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > BPS_SCALE) throw new RangeError('bps must be between 0 and 10,000');
    const numerator = BigInt(micros) * BigInt(bps);
    return Number((numerator + BigInt(BPS_SCALE / 2)) / BigInt(BPS_SCALE));
}

export function calculateCashoutMoney(grossCashoutUsd, platformFeeBps = PLATFORM_CASHOUT_FEE_BPS) {
    const grossCashoutUsdMicros = usdToMicros(grossCashoutUsd);
    const platformFeeUsdMicros = multiplyMicrosByBps(grossCashoutUsdMicros, platformFeeBps);
    const playerPayoutUsdMicros = grossCashoutUsdMicros - platformFeeUsdMicros;
    return {
        grossCashoutUsdMicros,
        platformFeeUsdMicros,
        playerPayoutUsdMicros,
        grossCashoutUsd: microsToUsd(grossCashoutUsdMicros),
        platformFeeUsd: microsToUsd(platformFeeUsdMicros),
        playerPayoutUsd: microsToUsd(playerPayoutUsdMicros),
        platformFeeBps,
    };
}

export function calculateAffiliateCommission(platformFeeUsdMicros, affiliateShareBps) {
    const commissionUsdMicros = multiplyMicrosByBps(platformFeeUsdMicros, affiliateShareBps);
    return {
        commissionUsdMicros,
        commissionUsd: microsToUsd(commissionUsdMicros),
        affiliateShareBps,
    };
}
