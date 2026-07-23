function readInteger(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        console.warn(`[Affiliate Config] Ignoring invalid ${name}=${raw}; using ${fallback}.`);
        return fallback;
    }
    return value;
}

function readUsdMicros(name, fallbackUsd) {
    const raw = process.env[name];
    const value = raw == null || raw === '' ? fallbackUsd : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
        console.warn(`[Affiliate Config] Ignoring invalid ${name}=${raw}; using ${fallbackUsd}.`);
        return Math.round(fallbackUsd * 1_000_000);
    }
    return Math.round(value * 1_000_000);
}

/** 5% of each eligible in-game cashout, expressed in basis points. */
export const PLATFORM_CASHOUT_FEE_BPS = readInteger(
    'PLATFORM_CASHOUT_FEE_BPS',
    500,
    { min: 0, max: 10_000 },
);

/** Affiliate tier shares are percentages of the platform fee, not of gross cashout. */
export const AFFILIATE_STANDARD_SHARE_BPS = readInteger(
    'AFFILIATE_STANDARD_SHARE_BPS',
    3_000,
    { min: 0, max: 10_000 },
);
export const AFFILIATE_PARTNER_SHARE_BPS = readInteger(
    'AFFILIATE_PARTNER_SHARE_BPS',
    3_500,
    { min: 0, max: 10_000 },
);
export const AFFILIATE_TOP_CREATOR_SHARE_BPS = readInteger(
    'AFFILIATE_TOP_CREATOR_SHARE_BPS',
    4_000,
    { min: 0, max: 10_000 },
);

export const AFFILIATE_HOLD_DAYS = readInteger(
    'AFFILIATE_HOLD_DAYS',
    7,
    { min: 0, max: 365 },
);
export const AFFILIATE_MIN_PAYOUT_USD_MICROS = readUsdMicros(
    'AFFILIATE_MIN_PAYOUT_USD',
    25,
);
export const REFERRAL_ATTRIBUTION_DAYS = readInteger(
    'REFERRAL_ATTRIBUTION_DAYS',
    60,
    { min: 1, max: 3650 },
);

export const AFFILIATE_TIER_CONFIG = Object.freeze([
    {
        key: 'standard',
        name: 'Standard',
        shareBps: AFFILIATE_STANDARD_SHARE_BPS,
        enabled: true,
    },
    {
        key: 'partner',
        name: 'Partner',
        shareBps: AFFILIATE_PARTNER_SHARE_BPS,
        enabled: false,
    },
    {
        key: 'top_creator',
        name: 'Top Creator',
        shareBps: AFFILIATE_TOP_CREATOR_SHARE_BPS,
        enabled: false,
    },
]);

export function getAffiliatePublicConfig() {
    return {
        platformCashoutFeeBps: PLATFORM_CASHOUT_FEE_BPS,
        standardAffiliateShareBps: AFFILIATE_STANDARD_SHARE_BPS,
        holdingPeriodDays: AFFILIATE_HOLD_DAYS,
        minimumPayoutUsdMicros: AFFILIATE_MIN_PAYOUT_USD_MICROS,
        referralAttributionDays: REFERRAL_ATTRIBUTION_DAYS,
    };
}
