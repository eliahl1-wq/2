import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/agarstake';

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true },
    balance: { type: Number, default: 0 },
    tournamentRewardsBalance: { type: Number, default: 0 },
    tournamentRewardsLamports: { type: Number, default: 0 },
    tournamentRewardClaimInProgress: { type: Boolean, default: false },
    tournamentRewardClaimReservedUsd: { type: Number, default: 0 },
    tournamentRewardClaimReservedLamports: { type: Number, default: 0 },
    activeTournamentRewardClaimId: { type: mongoose.Schema.Types.ObjectId, default: null },
    tournamentRewardCreditIds: { type: [String], default: [] },
});

const User = mongoose.model('User', UserSchema);

async function run() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB.');

        const result = await User.updateMany({}, {
            $set: {
                tournamentRewardsBalance: 0,
                tournamentRewardsLamports: 0,
                tournamentRewardClaimInProgress: false,
                tournamentRewardClaimReservedUsd: 0,
                tournamentRewardClaimReservedLamports: 0,
                activeTournamentRewardClaimId: null,
                tournamentRewardCreditIds: [],
            }
        });

        console.log(`Successfully updated ${result.modifiedCount} user documents. Winnings reset to $0.00.`);
    } catch (err) {
        console.error('Error running script:', err);
    } finally {
        await mongoose.disconnect();
    }
}

run();
