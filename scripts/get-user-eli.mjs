import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/agarstake';

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true },
    balance: { type: Number, default: 0 },
    walletAddress: { type: String },
    depositAddress: { type: String },
    sponsoredRewardsBalance: { type: Number, default: 0 },
    tournamentRewardsBalance: { type: Number, default: 0 },
    hasFreeTicket: { type: Boolean, default: true },
    freeTicketUsed: { type: Boolean, default: false },
});
const User = mongoose.model('User', UserSchema);

async function run() {
    try {
        await mongoose.connect(MONGO_URI);
        const user = await User.findOne({ username: 'eli' });
        if (user) {
            console.log('User eli document fields:');
            console.log(JSON.stringify(user.toObject(), null, 4));
        } else {
            console.log('User eli not found!');
        }
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}
run();
