#!/usr/bin/env node
/**
 * Generate two Solana keypairs for Battle Royale house wallets (Agar + Slither).
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

const agar = Keypair.generate();
const slither = Keypair.generate();

console.log('');
console.log('# ── Battle Royale house wallets (paste into .env) ──');
console.log('# Entry fees land here; winners are paid from here.');
console.log('# NOT swept on normal arena reset — separate from HOUSE_WALLET_*.');
console.log('# Fund each wallet with a little SOL for transaction fees.');
console.log('');
console.log(formatWallet('BR_AGAR', agar));
console.log(formatWallet('BR_SLITHER', slither));
