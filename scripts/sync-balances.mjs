import 'dotenv/config';
import mongoose from 'mongoose';
import * as solanaWeb3 from '@solana/web3.js';

const MONGO_URI = process.env.MONGO_URI;
// Use public Solana RPC to avoid rate limits from Helius
const connection = new solanaWeb3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true },
    balance: { type: Number, default: 0 },
    depositAddress: { type: String },
}, { strict: false });
const User = mongoose.model('User', UserSchema);

async function run() {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB.');

    const users = await User.find({ depositAddress: { $exists: true, $ne: null } });
    console.log(`Found ${users.length} users with deposit addresses. Syncing...`);

    let updated = 0;
    let skipped = 0;

    for (const user of users) {
        try {
            const pubKey = new solanaWeb3.PublicKey(user.depositAddress);
            const lamports = await connection.getBalance(pubKey);
            const onChainSol = lamports / solanaWeb3.LAMPORTS_PER_SOL;

            if (Math.abs(user.balance - onChainSol) > 0.000001) {
                console.log(`  Updating ${user.username}: DB=${user.balance.toFixed(6)} SOL → On-chain=${onChainSol.toFixed(6)} SOL`);
                user.balance = onChainSol;
                await user.save();
                updated++;
            } else {
                skipped++;
            }
            // Small delay to avoid rate limiting
            await new Promise(r => setTimeout(r, 300));
        } catch (err) {
            console.warn(`  Skipping ${user.username}: ${err.message}`);
        }
    }

    console.log(`\nDone. Updated: ${updated} | Already correct: ${skipped}`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
