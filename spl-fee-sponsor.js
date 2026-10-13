import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getMint, getAccountLenForMint } from '@solana/spl-token';
import bs58 from 'bs58';

// Dedicated operational wallet only. Never fall back to house/reward/user funds.
export function loadSplFeeSponsor(env = process.env, blockedAddresses = []) {
    const secret = String(env.SPL_FEE_SPONSOR_SECRET || '').trim();
    if (!secret) return null;
    let keypair;
    try {
        const bytes = /^[a-fA-F0-9]{128}$/.test(secret) ? Buffer.from(secret, 'hex')
            : secret.startsWith('[') ? (() => {
                const values = JSON.parse(secret);
                if (!Array.isArray(values) || values.length !== 64 || values.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error();
                return Uint8Array.from(values);
            })() : bs58.decode(secret);
        if (bytes.length !== 64) throw new Error();
        keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
    } catch { throw new Error('SPL_FEE_SPONSOR_SECRET must be a valid 64-byte private key (hex, base58 or JSON array).'); }
    const address = keypair.publicKey.toBase58();
    if (blockedAddresses.filter(Boolean).includes(address)) throw new Error('SPL fee sponsorship must use a separate wallet, not a house, reward or tournament wallet.');
    const maxSol = Number(env.SPL_FEE_SPONSOR_MAX_SOL || '0.25');
    if (!Number.isFinite(maxSol) || maxSol <= 0 || maxSol > 1) throw new Error('SPL_FEE_SPONSOR_MAX_SOL must be greater than 0 and at most 1 SOL.');
    return { keypair, address, maxLamports: Math.floor(maxSol * LAMPORTS_PER_SOL) };
}

export function createSplFeeBudget(maxFeeSol, serverMaximumLamports) {
    const sol = Number(maxFeeSol);
    const limit = Math.floor(sol * LAMPORTS_PER_SOL);
    if (!Number.isFinite(sol) || sol <= 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > serverMaximumLamports) {
        throw new Error(`Choose a fee budget above 0 and at most ${serverMaximumLamports / LAMPORTS_PER_SOL} SOL.`);
    }
    let reserved = 0;
    return {
        get reservedLamports() { return reserved; },
        limitLamports: limit,
        reserve(lamports) {
            if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error('Invalid fee estimate.');
            if (reserved + lamports > limit) throw new Error('Admin fee budget reached. Remaining token balances were not sent.');
            reserved += lamports;
        },
    };
}

export async function prepareSponsoredSplTransaction({ connection, transaction, sponsor, sourceAddress,
    destinationTokenAccount, mint, programId, budget, getMintImpl = getMint, accountLenImpl = getAccountLenForMint }) {
    if (sourceAddress.equals(sponsor.keypair.publicKey)) throw new Error('The fee wallet cannot also be a source account.');
    transaction.feePayer = sponsor.keypair.publicKey;
    const [blockhash, destinationAccount] = await Promise.all([
        connection.getLatestBlockhash('confirmed'),
        connection.getAccountInfo(destinationTokenAccount, 'confirmed'),
    ]);
    transaction.recentBlockhash = blockhash.blockhash;
    transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
    let rentLamports = 0;
    if (!destinationAccount) {
        const mintInfo = await getMintImpl(connection, mint, 'confirmed', programId);
        rentLamports = await connection.getMinimumBalanceForRentExemption(accountLenImpl(mintInfo));
    }
    const [fee, availableLamports] = await Promise.all([
        connection.getFeeForMessage(transaction.compileMessage(), 'confirmed'),
        connection.getBalance(sponsor.keypair.publicKey, 'confirmed'),
    ]);
    if (!Number.isSafeInteger(fee?.value) || fee.value < 0) throw new Error('Could not estimate the network fee. Try again.');
    const totalLamports = fee.value + rentLamports;
    if (availableLamports < totalLamports) throw new Error('Admin fee wallet has insufficient SOL for the network fee and destination token-account rent.');
    // Reserve before submission and keep the reservation on uncertain failures.
    // This may under-use the limit, but can never silently spend it twice.
    budget.reserve(totalLamports);
    return { networkFeeLamports: fee.value, rentLamports, reservedLamports: totalLamports };
}
