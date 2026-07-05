import 'dotenv/config';
import mongoose from 'mongoose';
import * as solanaWeb3 from '@solana/web3.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/agarstake';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || solanaWeb3.clusterApiUrl('mainnet-beta');
const connection = new solanaWeb3.Connection(SOLANA_RPC_URL, 'confirmed');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true },
    balance: { type: Number, default: 0 },
    depositAddress: { type: String },
});
const User = mongoose.model('User', UserSchema);

async function run() {
    try {
        await mongoose.connect(MONGO_URI);
        const users = await User.find({});
        console.log(`Found ${users.length} users. Checking on-chain balances on ${SOLANA_RPC_URL}...`);
        for (const user of users) {
            if (user.depositAddress) {
                try {
                    const pubKey = new solanaWeb3.PublicKey(user.depositAddress);
                    const lamports = await connection.getBalance(pubKey);
                    const sol = lamports / solanaWeb3.LAMPORTS_PER_SOL;
                    console.log(`User: ${user.username} | DB Balance: ${user.balance} SOL | On-Chain: ${sol} SOL | Addr: ${user.depositAddress}`);
                } catch (e) {
                    console.log(`User: ${user.username} | Error: ${e.message}`);
                }
            }
        }
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}
run();
