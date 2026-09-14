import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const rewardAddress = String(process.env.REWARD_WALLET_ADDRESS || process.argv[2] || '').trim();
const rpcUrl = String(process.argv[3] || process.env.SOLANA_RPC_URL || '').trim();
if (!rewardAddress || !rpcUrl || !process.env.MONGO_URI) {
    throw new Error('REWARD_WALLET_ADDRESS, SOLANA_RPC_URL and MONGO_URI are required');
}

const rewardKey = new PublicKey(rewardAddress);
const connection = new Connection(rpcUrl, 'confirmed');
const mongo = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
const round = value => Number((Number(value) || 0).toFixed(9));

function transactionKeys(tx) {
    const message = tx.transaction.message;
    if (Array.isArray(message.accountKeys)) return message.accountKeys;
    const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
    return Array.from({ length: keys.length }, (_, index) => keys.get(index));
}

try {
    await mongo.connect();
    const db = mongo.db();
    const signatures = [];
    let before;
    do {
        const page = await connection.getSignaturesForAddress(rewardKey, { before, limit: 1000 }, 'confirmed');
        signatures.push(...page);
        before = page.length === 1000 ? page.at(-1)?.signature : undefined;
    } while (before);

    const signatureValues = signatures.map(row => row.signature);
    const signatureInfo = new Map(signatures.map(row => [row.signature, row]));
    const [claimRows, auditRows] = await Promise.all([
        db.collection('rewardclaims').find(
            { signature: { $in: signatureValues } },
            { projection: { signature: 1, amountUsd: 1, sponsoredAmountUsd: 1, permanentAmountUsd: 1, rentFallbackAmountUsd: 1, userId: 1 } },
        ).toArray(),
        db.collection('transactions').find(
            { 'meta.signature': { $in: signatureValues } },
            { projection: { 'meta.signature': 1, 'meta.event': 1, 'meta.amountUsd': 1, 'meta.reason': 1, userId: 1, createdAt: 1 } },
        ).toArray(),
    ]);
    const claims = new Map(claimRows.map(row => [row.signature, row]));
    const audits = new Map(auditRows.map(row => [row.meta?.signature, row]));

    let incomingLamports = 0;
    let outgoingLamports = 0;
    const outgoing = [];
    const incoming = [];
    for (const signature of signatureValues) {
            const tx = await connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0,
            });
            if (!tx?.meta || tx.meta.err) continue;
            const keys = transactionKeys(tx);
            const rewardIndex = keys.findIndex(key => key?.equals?.(rewardKey));
            if (rewardIndex < 0) continue;
            const delta = tx.meta.postBalances[rewardIndex] - tx.meta.preBalances[rewardIndex];
            if (delta > 0) {
                incomingLamports += delta;
                incoming.push({ signature, sol: round(delta / LAMPORTS_PER_SOL), auditEvent: audits.get(signature)?.meta?.event || null });
            } else if (delta < 0) {
                outgoingLamports += -delta;
                const claim = claims.get(signature);
                const audit = audits.get(signature);
                outgoing.push({
                    signature,
                    blockTime: signatureInfo.get(signature)?.blockTime
                        ? new Date(signatureInfo.get(signature).blockTime * 1000).toISOString()
                        : null,
                    solIncludingFee: round((-delta) / LAMPORTS_PER_SOL),
                    creditedAccounts: keys.map((key, accountIndex) => ({
                        address: key?.toBase58?.() || String(key),
                        sol: round((tx.meta.postBalances[accountIndex] - tx.meta.preBalances[accountIndex]) / LAMPORTS_PER_SOL),
                    })).filter(account => account.sol > 0),
                    classification: claim ? 'reward_claim' : audit?.meta?.event || 'unmatched',
                    usd: round(claim?.amountUsd ?? audit?.meta?.amountUsd),
                    starterUsd: round(claim?.sponsoredAmountUsd),
                    permanentUsd: round(claim?.permanentAmountUsd),
                    retainedCashoutUsd: round(claim?.rentFallbackAmountUsd),
                });
            }
    }
    const balanceLamports = await connection.getBalance(rewardKey, 'confirmed');
    const unmatchedOutgoing = outgoing.filter(row => row.classification === 'unmatched');
    const creditedAddresses = [...new Set(outgoing.flatMap(row => row.creditedAccounts.map(account => account.address)))];
    const creditedUsers = creditedAddresses.length
        ? await db.collection('users').find(
            { $or: [{ depositAddress: { $in: creditedAddresses } }, { walletAddress: { $in: creditedAddresses } }] },
            { projection: { username: 1, depositAddress: 1, walletAddress: 1, isOwnerAccount: 1 } },
        ).toArray()
        : [];
    const userByAddress = new Map();
    for (const user of creditedUsers) {
        if (user.depositAddress) userByAddress.set(user.depositAddress, user);
        if (user.walletAddress) userByAddress.set(user.walletAddress, user);
    }
    for (const row of outgoing) {
        row.creditedAccounts = row.creditedAccounts.map(account => {
            const user = userByAddress.get(account.address);
            return {
                ...account,
                platformUsername: user?.username || null,
                markedOwnerAccount: !!user?.isOwnerAccount,
            };
        });
    }

    console.log(JSON.stringify({
        address: rewardAddress,
        signatureCount: signatures.length,
        currentBalanceSol: round(balanceLamports / LAMPORTS_PER_SOL),
        incomingSol: round(incomingLamports / LAMPORTS_PER_SOL),
        outgoingSolIncludingFees: round(outgoingLamports / LAMPORTS_PER_SOL),
        incomingCount: incoming.length,
        outgoingCount: outgoing.length,
        unmatchedOutgoingCount: unmatchedOutgoing.length,
        incoming,
        outgoing,
    }, null, 2));
} finally {
    await mongo.close();
}
