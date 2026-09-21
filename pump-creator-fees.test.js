import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import {
    buildCreatorFeeForwardInstruction,
    decodeForwardedCreatorFeeLamports,
    normalizeCreatorFeeLamports,
} from './pump-creator-fees.js';

test('creator-fee forwarding transfers exactly the measured claim and not the wallet balance', () => {
    const claimableLamports = 123_456_789n;
    const instruction = buildCreatorFeeForwardInstruction({
        creator: Keypair.generate().publicKey,
        destination: Keypair.generate().publicKey,
        claimableLamports,
    });
    assert.equal(decodeForwardedCreatorFeeLamports(instruction), claimableLamports);
});

test('creator-fee forwarding rejects empty and invalid claims', () => {
    assert.throws(() => normalizeCreatorFeeLamports(0), /no Pump creator fees/i);
    assert.throws(() => normalizeCreatorFeeLamports(-1), /no Pump creator fees/i);
    assert.throws(() => normalizeCreatorFeeLamports(1n << 64n), /transfer limit/i);
});
