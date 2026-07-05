import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;

const UserSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', UserSchema);

async function run() {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB.');

    // Reset the deposit cursor so the scanner will backfill all recent transactions
    const result = await User.updateMany(
        { depositAddress: { $exists: true, $ne: null } },
        {
            $unset: {
                lastDepositSourceSignature: '',
                depositHistoryBackfilledAt: '',
            }
        }
    );
    console.log(`Reset deposit cursors for ${result.modifiedCount} user(s).`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
