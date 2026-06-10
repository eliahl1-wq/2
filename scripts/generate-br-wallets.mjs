#!/usr/bin/env node
/**
 * Generate Solana keypairs for Battle Royale house wallets.
 * One wallet per variant + entry tier ($5 and $10).
 * Add the output to phantom-game-server/.env — never commit secrets to git.
 */
import { Keypair } from '@solana/web3.js';

function formatWallet(label, kp) {
    const address = kp.publicKey.toBase58();
    const secret = Buffer.from(kp.secretKey).toString('hex');
    return [
        `# ${label}`,
        `${label}_HOUSE_WALLET_ADDRESS=${address}`,
        `${label}_HOUSE_WALLET_SECRET=${secret}`,
        '',
    ].join('\n');
}

const wallets = [
    { label: 'BR_AGAR', desc: 'Agar BR $5' },
    { label: 'BR_AGAR_10', desc: 'Agar BR $10' },
    { label: 'BR_SLITHER', desc: 'Slither BR $5' },
    { label: 'BR_SLITHER_10', desc: 'Slither BR $10' },
];

console.log('');
console.log('# ── Battle Royale house wallets (paste into .env) ──');
console.log('# Separate pool per variant AND entry fee ($5 / $10).');
console.log('# NOT swept on normal arena reset — separate from HOUSE_WALLET_*.');
console.log('# Fund each wallet with a little SOL for transaction fees.');
console.log('');

for (const { label, desc } of wallets) {
    console.log(`# ${desc}`);
    console.log(formatWallet(label, Keypair.generate()));
}
