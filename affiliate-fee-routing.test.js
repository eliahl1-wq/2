import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateReferredCashoutFeeRouting } from './affiliate-fee-routing.js';

test('routes the full referred fee without double-counting permanent funding', () => {
    const result = calculateReferredCashoutFeeRouting({
        platformFeeUsdMicros: 8_000_000,
        affiliateCommissionUsdMicros: 2_400_000,
        permanentPoolFundingUsdMicros: 4_400_000,
        permanentRewardContributionUsdMicros: 4_000_000,
        permanentOwnerSurplusUsdMicros: 400_000,
    });
    assert.equal(result.additionalFundingUsdMicros, 3_600_000);
    assert.equal(result.totalOwnerSurplusUsdMicros, 1_600_000);
    assert.equal(result.additionalOwnerSurplusUsdMicros, 1_200_000);
    assert.equal(result.permanentPoolFundingUsdMicros + result.additionalFundingUsdMicros, 8_000_000);
});

test('keeps higher affiliate tiers protected before calculating owner surplus', () => {
    const result = calculateReferredCashoutFeeRouting({
        platformFeeUsdMicros: 8_000_000,
        affiliateCommissionUsdMicros: 3_200_000,
        permanentPoolFundingUsdMicros: 4_400_000,
        permanentRewardContributionUsdMicros: 4_000_000,
        permanentOwnerSurplusUsdMicros: 400_000,
    });
    assert.equal(result.totalOwnerSurplusUsdMicros, 800_000);
    assert.equal(result.additionalOwnerSurplusUsdMicros, 400_000);
});

test('a rewards-disabled referred user routes commission and remainder safely', () => {
    const result = calculateReferredCashoutFeeRouting({
        platformFeeUsdMicros: 8_000_000,
        affiliateCommissionUsdMicros: 2_400_000,
    });
    assert.equal(result.additionalFundingUsdMicros, 8_000_000);
    assert.equal(result.totalOwnerSurplusUsdMicros, 5_600_000);
    assert.equal(result.additionalOwnerSurplusUsdMicros, 5_600_000);
});
