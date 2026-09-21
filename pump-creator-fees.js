import { SystemInstruction, SystemProgram } from '@solana/web3.js';

const MAX_U64 = (1n << 64n) - 1n;

export function normalizeCreatorFeeLamports(value) {
    const lamports = BigInt(String(value));
    if (lamports <= 0n) throw new Error('There are no Pump creator fees available to claim.');
    if (lamports > MAX_U64) throw new Error('Pump creator-fee amount exceeds the Solana transfer limit.');
    return lamports;
}

export function buildCreatorFeeForwardInstruction({ creator, destination, claimableLamports }) {
    const lamports = normalizeCreatorFeeLamports(claimableLamports);
    return SystemProgram.transfer({ fromPubkey: creator, toPubkey: destination, lamports });
}

export function decodeForwardedCreatorFeeLamports(instruction) {
    return BigInt(SystemInstruction.decodeTransfer(instruction).lamports);
}
