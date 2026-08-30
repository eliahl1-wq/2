import 'dotenv/config';
import mongoose from 'mongoose';
import { Keypair } from '@solana/web3.js';
import { encryptWalletSecret } from '../wallet-crypto.js';

await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agario_db');
try {
    const launches = mongoose.connection.collection('tokenlaunches');
    const existing = await launches.findOne({ key: 'arenifi' });
    if (existing?.status === 'launched' || existing?.status === 'launching') throw new Error('The prepared token has already launched or is launching.');
    console.log('Grinding an offline Solana keypair ending in "pump". This creates no token and sends no transaction.');
    let mint;
    let attempts = 0;
    do {
        mint = Keypair.generate();
        attempts += 1;
        if (attempts % 1_000_000 === 0) console.log(`${attempts.toLocaleString()} addresses checked...`);
    } while (!mint.publicKey.toBase58().endsWith('pump'));
    const mintAddress = mint.publicKey.toBase58();
    await launches.updateOne({ key: 'arenifi' }, {
        $set: {
            mintAddress,
            encryptedMintSecret: encryptWalletSecret(mint.secretKey),
            status: 'prepared', signature: '', error: '', launchedAt: null,
            imageUri: '', metadataUri: '', updatedAt: new Date(),
        },
        $setOnInsert: { key: 'arenifi', name: 'AreniFi Credits', symbol: 'ARC', createdAt: new Date() },
    }, { upsert: true });
    console.log(`Prepared mint: ${mintAddress}`);
    console.log('Copy this public address to AGAR_TOKEN_MINT and VITE_AGAR_MINT. Keep token launch flags disabled.');
} finally {
    await mongoose.disconnect();
}
