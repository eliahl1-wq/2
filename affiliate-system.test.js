import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AffiliateCommission,
    AffiliatePayout,
    ReferralAttribution,
    getCommissionEligibility,
    normalizeReferralCode,
    referralWindowExpiresAt,
    shouldReverseCommissionForCashout,
} from './affiliate-system.js';
import {
    calculateAffiliateCommission,
    calculateCashoutMoney,
    multiplyMicrosByBps,
    usdToMicros,
} from './affiliate-money.js';
import {
    AFFILIATE_HOLD_DAYS,
    AFFILIATE_MIN_PAYOUT_USD_MICROS,
    AFFILIATE_STANDARD_SHARE_BPS,
    PLATFORM_CASHOUT_FEE_BPS,
    REFERRAL_ATTRIBUTION_DAYS,
} from './affiliate-config.js';

test('$100 cashout creates a $5 fee and $1.50 standard affiliate commission', () => {
    const cashout = calculateCashoutMoney(100);
    assert.equal(cashout.grossCashoutUsdMicros, 100_000_000);
    assert.equal(cashout.platformFeeUsdMicros, 5_000_000);
    assert.equal(cashout.playerPayoutUsdMicros, 95_000_000);
    assert.equal(cashout.platformFeeUsd, 5);
    assert.equal(cashout.playerPayoutUsd, 95);

    const affiliate = calculateAffiliateCommission(
        cashout.platformFeeUsdMicros,
        AFFILIATE_STANDARD_SHARE_BPS,
    );
    assert.equal(affiliate.commissionUsdMicros, 1_500_000);
    assert.equal(affiliate.commissionUsd, 1.5);
    assert.equal(
        cashout.platformFeeUsdMicros - affiliate.commissionUsdMicros,
        3_500_000,
    );
});

test('money calculations use deterministic integer half-up basis-point rounding', () => {
    assert.equal(multiplyMicrosByBps(1, 5_000), 1);
    assert.equal(multiplyMicrosByBps(10_000_001, 500), 500_000);
    assert.throws(() => usdToMicros(-1), RangeError);
    assert.throws(() => multiplyMicrosByBps(100, 10_001), RangeError);
});

test('tier changes only affect newly calculated commission snapshots', () => {
    const feeMicros = usdToMicros(5);
    const standard = calculateAffiliateCommission(feeMicros, 3_000);
    const partner = calculateAffiliateCommission(feeMicros, 3_500);
    const topCreator = calculateAffiliateCommission(feeMicros, 4_000);
    assert.equal(standard.commissionUsdMicros, 1_500_000);
    assert.equal(partner.commissionUsdMicros, 1_750_000);
    assert.equal(topCreator.commissionUsdMicros, 2_000_000);
    assert.equal(standard.affiliateShareBps, 3_000);
});

test('affiliate configuration defaults match the business requirements', () => {
    assert.equal(PLATFORM_CASHOUT_FEE_BPS, 500);
    assert.equal(AFFILIATE_STANDARD_SHARE_BPS, 3_000);
    assert.equal(AFFILIATE_HOLD_DAYS, 7);
    assert.equal(AFFILIATE_MIN_PAYOUT_USD_MICROS, 25_000_000);
    assert.equal(REFERRAL_ATTRIBUTION_DAYS, 60);
});

test('referral codes normalize case-insensitively and reject malformed input', () => {
    assert.equal(normalizeReferralCode('  Creator_One '), 'creator_one');
    assert.equal(normalizeReferralCode('ab'), null);
    assert.equal(normalizeReferralCode('creator code'), null);
});

test('referral attribution window is exactly 60 days', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    assert.equal(
        referralWindowExpiresAt(from).getTime() - from.getTime(),
        60 * 24 * 60 * 60 * 1000,
    );
});

function eligibleCashout(overrides = {}) {
    return {
        type: 'withdraw',
        status: 'confirmed',
        excludedFromReports: false,
        meta: {
            reason: 'Arena Cashout',
            mode: 'agar',
            dollarBalance: 100,
            platformFee: 5,
            cashoutFeeBps: 500,
            ...overrides,
        },
    };
}

const eligibleUser = {
    username: 'player',
    isOwnerAccount: false,
    personalFreePlay: false,
    excludedFromReports: false,
};

test('eligible real cashouts pass while failed, reversed, and promotional cashouts do not', () => {
    assert.equal(getCommissionEligibility(eligibleCashout(), eligibleUser).eligible, true);
    assert.equal(getCommissionEligibility({ ...eligibleCashout(), status: 'failed' }, eligibleUser).eligible, false);
    assert.equal(getCommissionEligibility(eligibleCashout({ reversed: true }), eligibleUser).eligible, false);
    assert.equal(getCommissionEligibility(eligibleCashout({ isFreeTicketPlay: true }), eligibleUser).reason, 'promotional_activity');
    assert.equal(getCommissionEligibility(eligibleCashout({ simulated: true }), eligibleUser).reason, 'test_or_excluded');
    assert.equal(getCommissionEligibility(eligibleCashout({ platformFee: 0 }), eligibleUser).reason, 'missing_fee_snapshot');
});

test('cashout invalidation triggers commission reversal', () => {
    assert.equal(shouldReverseCommissionForCashout(eligibleCashout()), false);
    assert.equal(shouldReverseCommissionForCashout({ ...eligibleCashout(), status: 'failed' }), true);
    assert.equal(shouldReverseCommissionForCashout(eligibleCashout({ reversed: true })), true);
    assert.equal(shouldReverseCommissionForCashout(eligibleCashout({ refunded: true })), true);
    assert.equal(shouldReverseCommissionForCashout(eligibleCashout({ cancelled: true })), true);
});

test('deposits, account withdrawals, BR, tournaments, bots, admins, and owner accounts are excluded', () => {
    assert.equal(getCommissionEligibility({ type: 'deposit', status: 'confirmed', meta: {} }, eligibleUser).reason, 'not_cashout');
    assert.equal(getCommissionEligibility(eligibleCashout({ reason: 'Account Withdrawal' }), eligibleUser).reason, 'ineligible_cashout_reason');
    assert.equal(getCommissionEligibility(eligibleCashout({ reason: 'BR Victory', mode: 'br-agar' }), eligibleUser).eligible, false);
    assert.equal(getCommissionEligibility(eligibleCashout({ mode: 'tournament-slither' }), eligibleUser).eligible, false);
    assert.equal(getCommissionEligibility(eligibleCashout(), { ...eligibleUser, isOwnerAccount: true }).eligible, false);
    assert.equal(getCommissionEligibility(eligibleCashout(), { ...eligibleUser, username: process.env.ADMIN_USERNAME || 'admin' }, { adminUsername: process.env.ADMIN_USERNAME || 'admin' }).eligible, false);
});

test('database schemas enforce one attribution and commission per user/cashout plus active payout uniqueness', () => {
    const attributionIndexes = ReferralAttribution.schema.indexes();
    const commissionIndexes = AffiliateCommission.schema.indexes();
    const payoutIndexes = AffiliatePayout.schema.indexes();
    assert.ok(attributionIndexes.some(([keys, options]) => keys.referredUserId === 1 && options.unique));
    assert.ok(commissionIndexes.some(([keys, options]) => keys.cashoutTransactionId === 1 && options.unique));
    assert.ok(payoutIndexes.some(([keys, options]) => keys.activeLockKey === 1 && options.unique));
});
