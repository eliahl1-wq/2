import 'dotenv/config';
import mongoose from 'mongoose';
import {
    AffiliateCommission,
    AffiliatePayout,
    AffiliateProfile,
    AffiliateRiskFlag,
    AffiliateTier,
    ReferralAttribution,
    ReferralClick,
    ensureAffiliateProfile,
    ensureAffiliateTiers,
    isAffiliateEligibleUser,
} from '../affiliate-system.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agario_db';

const MigrationUserSchema = new mongoose.Schema({
    username: String,
    isOwnerAccount: Boolean,
    personalFreePlay: Boolean,
    excludedFromReports: Boolean,
}, {
    collection: 'users',
    strict: false,
    timestamps: true,
});
const User = mongoose.models.User || mongoose.model('User', MigrationUserSchema);

async function main() {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
    await ensureAffiliateTiers();

    const users = await User.find({}).sort({ _id: 1 });
    let createdProfiles = 0;
    let skippedUsers = 0;
    for (const user of users) {
        if (!isAffiliateEligibleUser(user, process.env.ADMIN_USERNAME)) {
            skippedUsers += 1;
            continue;
        }
        const before = await AffiliateProfile.exists({ userId: user._id });
        await ensureAffiliateProfile(user);
        if (!before) createdProfiles += 1;
    }

    const models = [
        AffiliateTier,
        AffiliateProfile,
        ReferralClick,
        ReferralAttribution,
        AffiliateCommission,
        AffiliatePayout,
        AffiliateRiskFlag,
    ];
    for (const model of models) await model.syncIndexes();

    console.log(JSON.stringify({
        ok: true,
        usersScanned: users.length,
        createdProfiles,
        skippedUsers,
        indexesSynced: models.map(model => model.modelName),
    }, null, 2));
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
    });
