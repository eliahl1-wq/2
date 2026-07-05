#!/usr/bin/env node
/**
 * Generate a Solana keypair for the Tournament wallet.
 * Add the output to phantom-game-server/.env — never commit secrets to git.
 *
 * Usage:  node scripts/generate-tournament-wallet.mjs
 */
import { Keypair } from '@solana/web3.js';

const kp = Keypair.generate();
const address = kp.publicKey.toBase58();
const secret = Buffer.from(kp.secretKey).toString('hex');

console.log('');
console.log('# ── Tournament wallet (paste into .env) ──');
console.log('# Separate from house wallet, owner vault, and reward wallets.');
console.log('# Fund with SOL for user claims / payouts.');
console.log('');
console.log(`TOURNAMENT_WALLET_ADDRESS=${address}`);
console.log(`TOURNAMENT_WALLET_SECRET=${secret}`);
console.log('');
console.log('IMPORTANT: Save the secret key somewhere safe offline!');
