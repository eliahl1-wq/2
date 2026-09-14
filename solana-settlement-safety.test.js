import test from 'node:test';
import assert from 'node:assert/strict';
import {
    calculateRewardWalletTopUp,
    classifySettlement,
    isFreshPositivePrice,
    splitCollectedLamports,
    usdToLamportsCeil,
} from './solana-settlement-safety.js';

test('price freshness rejects bootstrap, stale and invalid prices', () => {
    const now = 1_000_000;
    assert.equal(isFreshPositivePrice(100, now - 1_000, now, 60_000), true);
    assert.equal(isFreshPositivePrice(100, 0, now, 60_000), false);
    assert.equal(isFreshPositivePrice(100, now - 60_001, now, 60_000), false);
    assert.equal(isFreshPositivePrice(0, now, now, 60_000), false);
});

test('USD conversion rounds liabilities upward to atomic lamports', () => {
    assert.equal(usdToLamportsCeil(1, 100), 10_000_000);
    assert.equal(usdToLamportsCeil(0.00000001, 100), 1);
});

test('BR lamport split conserves the exact funded pot across price moves', () => {
    const split = splitCollectedLamports(1_234_567, 800);
    assert.equal(split.ownerLamports, 98_765);
    assert.equal(split.prizeLamports, 1_135_802);
    assert.equal(split.ownerLamports + split.prizeLamports, split.totalLamports);
});

test('reward top-up reacts to price-driven wallet shortfall', () => {
    const result = calculateRewardWalletTopUp({
        liabilityUsd: 100,
        pendingHouseUsd: 0,
        rewardWalletLamports: 1_000_015_000,
        solPriceUsd: 50,
        feeBufferLamports: 15_000,
    });
    assert.equal(result.liabilityTargetLamports, 2_000_015_000);
    assert.equal(result.currentDeficitLamports, 1_000_000_000);
    assert.equal(result.requestedTopUpLamports, 1_000_000_000);
});

test('reward top-up still includes newly pending funding', () => {
    const result = calculateRewardWalletTopUp({
        liabilityUsd: 10,
        pendingHouseUsd: 5,
        rewardWalletLamports: 100_015_000,
        solPriceUsd: 100,
    });
    assert.equal(result.currentDeficitLamports, 0);
    assert.equal(result.pendingTargetLamports, 50_000_000);
    assert.equal(result.requestedTopUpLamports, 50_000_000);
});

test('settlement waits for live blockhash and releases only after expiry', () => {
    assert.equal(classifySettlement({ signatureStatus: { confirmationStatus: 'confirmed', err: null } }), 'confirmed');
    assert.equal(classifySettlement({ signatureStatus: { err: { InstructionError: [0, 'x'] } } }), 'failed');
    assert.equal(classifySettlement({ signatureStatus: null, currentBlockHeight: 99, lastValidBlockHeight: 100 }), 'pending');
    assert.equal(classifySettlement({ signatureStatus: null, currentBlockHeight: 101, lastValidBlockHeight: 100 }), 'expired');
});
