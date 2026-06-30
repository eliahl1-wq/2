#!/usr/bin/env node
/**
 * Generate a Solana keypair for the Reward Pool wallet.
 * Add the output to phantom-game-server/.env (or Railway env vars) — never commit secrets to git.
 *
 * Usage:  node scripts/generate-reward-wallet.mjs
 */
import { Keypair } from '@solana/web3.js';

const kp = Keypair.generate();
const address = kp.publicKey.toBase58();
const secret = Buffer.from(kp.secretKey).toString('hex');

console.log('');
console.log('# ── Reward Pool wallet (paste into .env / Railway) ──');
console.log('# Separate from house wallet, owner vault, and BR wallets.');
console.log('# Fund with a small amount of SOL for transaction fees.');
console.log('');
console.log(`REWARD_WALLET_ADDRESS=${address}`);
console.log(`REWARD_WALLET_SECRET=${secret}`);
console.log('');
console.log('IMPORTANT: Save the secret key somewhere safe offline!');
