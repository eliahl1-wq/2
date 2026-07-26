import 'dotenv/config';
import mongoose from 'mongoose';
import {
    decryptWalletSecretWithMetadata,
    isEncryptedWalletSecret,
    rotateWalletSecretEncryption,
} from '../wallet-crypto.js';

const apply = process.argv.includes('--apply');
const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agario_db';

await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });
try {
    const users = mongoose.connection.collection('users');
    const candidates = await users.find({
        depositSecret: { $type: 'string', $ne: '' },
    }, { projection: { depositSecret: 1 } }).toArray();
    const rotation = [];
    let unreadable = 0;

    for (const user of candidates) {
        if (!isEncryptedWalletSecret(user.depositSecret)) continue;
        try {
            const metadata = decryptWalletSecretWithMetadata(user.depositSecret, { allowLegacy: false });
            if (metadata.keySource === 'previous') rotation.push(user);
        } catch {
            unreadable += 1;
        }
    }

    console.log(`Wallet secrets: ${candidates.length} total, ${rotation.length} require rotation, ${unreadable} unreadable.`);
    if (unreadable) {
        console.error('Rotation stopped because at least one wallet cannot be decrypted with the configured keys.');
        process.exitCode = 3;
    } else if (!apply) {
        console.log('Dry run only. Re-run with --apply to rotate secrets to WALLET_ENCRYPTION_KEY.');
        process.exitCode = rotation.length ? 2 : 0;
    } else if (rotation.length) {
        const operations = rotation.map((user) => ({
            updateOne: {
                filter: { _id: user._id, depositSecret: user.depositSecret },
                update: {
                    $set: {
                        depositSecret: rotateWalletSecretEncryption(user.depositSecret),
                        walletSecretEncryptedAt: new Date(),
                    },
                },
            },
        }));
        const result = await users.bulkWrite(operations, { ordered: false });
        console.log(`Rotated ${result.modifiedCount} wallet secrets.`);
        if (result.modifiedCount !== rotation.length) process.exitCode = 4;
    } else {
        console.log('No rotation was needed.');
    }
} finally {
    await mongoose.disconnect();
}
