import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/agarstake';

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
        console.log(`Found ${users.length} users:`);
        for (const user of users) {
            console.log(`User: ${user.username} | DB Balance: ${user.balance} SOL | Addr: ${user.depositAddress}`);
        }
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}
run();
