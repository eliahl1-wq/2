import 'dotenv/config';
import mongoose from 'mongoose';
import * as solanaWeb3 from '@solana/web3.js';
import {
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getAccount,
    getAssociatedTokenAddressSync,
    getMint,
} from '@solana/spl-token';
import { hasWalletEncryptionKey, isEncryptedWalletSecret } from '../wallet-crypto.js';
import { fetchAgarMarketPrice } from '../agar-market.js';

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });
const rpcUrl = process.env.SOLANA_RPC_URL || solanaWeb3.clusterApiUrl('mainnet-beta');
const connection = new solanaWeb3.Connection(rpcUrl, 'confirmed');

check('AGAR_TOKEN_ENABLED', process.env.AGAR_TOKEN_ENABLED === 'true');
check('AGAR_SHOP_ENABLED', process.env.AGAR_SHOP_ENABLED === 'true');
check('AGAR_ACCOUNT_SWAP_ENABLED', process.env.AGAR_ACCOUNT_SWAP_ENABLED === 'true');
check('WALLET_ENCRYPTION_KEY', hasWalletEncryptionKey());
check('JUPITER_API_KEY', !!process.env.JUPITER_API_KEY);

let mint = null;
let tokenProgram = null;
let decimals = null;
try {
    mint = new solanaWeb3.PublicKey(process.env.AGAR_TOKEN_MINT || '');
    const account = await connection.getAccountInfo(mint, 'confirmed');
    tokenProgram = account?.owner?.equals(TOKEN_PROGRAM_ID)
        ? TOKEN_PROGRAM_ID
        : account?.owner?.equals(TOKEN_2022_PROGRAM_ID)
            ? TOKEN_2022_PROGRAM_ID
            : null;
    if (!account || !tokenProgram) throw new Error('Mint is missing or uses an unsupported token program');
    const mintInfo = await getMint(connection, mint, 'confirmed', tokenProgram);
    decimals = mintInfo.decimals;
    check('AGAR mint', true, `${mint.toBase58()} (${decimals} decimals)`);
    check('AGAR decimals', decimals === Number(process.env.AGAR_TOKEN_DECIMALS || 9), `chain=${decimals}`);
} catch (error) {
    check('AGAR mint', false, error.message);
}

if (mint && tokenProgram) {
    for (const [name, envName] of [
        ['Treasury ATA', 'AGAR_TREASURY_ADDRESS'],
        ['Owner revenue ATA', 'AGAR_OWNER_REVENUE_ADDRESS'],
    ]) {
        try {
            const owner = new solanaWeb3.PublicKey(process.env[envName] || '');
            const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
            const account = await getAccount(connection, ata, 'confirmed', tokenProgram);
            check(name, !account.isFrozen, `${owner.toBase58()} -> ${ata.toBase58()}`);
        } catch (error) {
            check(name, false, error.message);
        }
    }
    try {
        const market = await fetchAgarMarketPrice({ mint: mint.toBase58() });
        check('AGAR market price', true, `$${market.priceUsd} / liquidity $${market.liquidityUsd}`);
    } catch (error) {
        check('AGAR market price', false, error.message);
    }
}

if (hasWalletEncryptionKey()) {
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agario_db', {
            serverSelectionTimeoutMS: 10_000,
        });
        const users = await mongoose.connection.collection('users').find({
            depositSecret: { $type: 'string', $ne: '' },
        }, { projection: { depositSecret: 1 } }).toArray();
        const legacy = users.filter((user) => !isEncryptedWalletSecret(user.depositSecret));
        check('Encrypted account wallets', legacy.length === 0, `${legacy.length} legacy secrets`);
    } catch (error) {
        check('Encrypted account wallets', false, error.message);
    } finally {
        await mongoose.disconnect().catch(() => {});
    }
}

for (const result of checks) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
}
if (checks.some((result) => !result.ok)) process.exitCode = 1;
