import 'dotenv/config';
import mongoose from 'mongoose';
import {
    isEncryptedWalletSecret,
    reencryptLegacyWalletSecret,
} from '../wallet-crypto.js';

const apply = process.argv.includes('--apply');
const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agario_db';

await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });
try {
    const users = mongoose.connection.collection('users');
    const candidates = await users.find({
        depositSecret: { $type: 'string', $ne: '' },
    }, { projection: { depositSecret: 1, username: 1 } }).toArray();
    const legacy = candidates.filter((user) => !isEncryptedWalletSecret(user.depositSecret));
    console.log(`Wallet secrets: ${candidates.length} total, ${legacy.length} require encryption.`);
    if (!apply) {
        console.log('Dry run only. Re-run with --apply to encrypt legacy secrets.');
        process.exitCode = legacy.length ? 2 : 0;
    } else if (legacy.length) {
        const operations = legacy.map((user) => ({
            updateOne: {
                filter: { _id: user._id, depositSecret: user.depositSecret },
                update: {
                    $set: {
                        depositSecret: reencryptLegacyWalletSecret(user.depositSecret),
                        walletSecretEncryptedAt: new Date(),
                    },
                },
            },
        }));
        const result = await users.bulkWrite(operations, { ordered: false });
        console.log(`Encrypted ${result.modifiedCount} wallet secrets.`);
        if (result.modifiedCount !== legacy.length) process.exitCode = 3;
    } else {
        console.log('No migration was needed.');
    }
} finally {
    await mongoose.disconnect();
}
