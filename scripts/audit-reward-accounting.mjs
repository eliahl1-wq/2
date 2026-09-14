import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');

const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });

const round = (value) => Number((Number(value) || 0).toFixed(6));

async function sumTransactions(transactions, match, expression) {
    const [row] = await transactions.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: expression }, count: { $sum: 1 } } },
    ]).toArray();
    return { count: row?.count || 0, usd: round(row?.total) };
}

try {
    await client.connect();
    const db = client.db();
    const transactions = db.collection('transactions');
    const rewardClaims = db.collection('rewardclaims');
    const users = db.collection('users');
    const state = await db.collection('rewardpoolstates').findOne({ key: 'global' });
    const latestFactoryReset = await transactions.findOne(
        { 'meta.event': 'reward_pool_factory_reset' },
        { sort: { createdAt: -1 }, projection: { createdAt: 1, 'meta.signature': 1, 'meta.discardedPlayerRewardUsd': 1 } },
    );

    const [starter, permanent, fallback, corrections, sweeps, confirmedClaims] = await Promise.all([
        sumTransactions(
            transactions,
            { 'meta.event': 'reward_pool_contribution' },
            { $ifNull: ['$meta.contributionUsd', 0] },
        ),
        sumTransactions(
            transactions,
            { 'meta.permanentPoolFundingUsd': { $gt: 0 } },
            '$meta.permanentPoolFundingUsd',
        ),
        sumTransactions(
            transactions,
            { 'meta.isLiquidityFallback': true },
            { $ifNull: ['$meta.retainedWinningsAmountUsd', '$amount'] },
        ),
        sumTransactions(
            transactions,
            { 'meta.event': 'reward_pool_correction' },
            { $ifNull: ['$meta.correctionUsd', 0] },
        ),
        sumTransactions(
            transactions,
            { 'meta.event': 'reward_pool_sweep' },
            { $ifNull: ['$meta.pendingReductionUsd', '$meta.amountUsd'] },
        ),
        rewardClaims.aggregate([
            { $match: { status: 'confirmed' } },
            { $group: {
                _id: null,
                count: { $sum: 1 },
                total: { $sum: '$amountUsd' },
                starter: { $sum: '$sponsoredAmountUsd' },
                permanent: { $sum: '$permanentAmountUsd' },
                fallback: { $sum: '$rentFallbackAmountUsd' },
            } },
        ]).toArray(),
    ]);

    const sinceReset = latestFactoryReset?.createdAt ? { createdAt: { $gt: latestFactoryReset.createdAt } } : {};
    const [starterSinceReset, permanentSinceReset, fallbackSinceReset, correctionsSinceReset, sweepsSinceReset] = await Promise.all([
        sumTransactions(transactions, { ...sinceReset, 'meta.event': 'reward_pool_contribution' }, { $ifNull: ['$meta.contributionUsd', 0] }),
        sumTransactions(transactions, { ...sinceReset, 'meta.permanentPoolFundingUsd': { $gt: 0 } }, '$meta.permanentPoolFundingUsd'),
        sumTransactions(transactions, { ...sinceReset, 'meta.isLiquidityFallback': true }, { $ifNull: ['$meta.retainedWinningsAmountUsd', '$amount'] }),
        sumTransactions(transactions, { ...sinceReset, 'meta.event': 'reward_pool_correction' }, { $ifNull: ['$meta.correctionUsd', 0] }),
        sumTransactions(transactions, { ...sinceReset, 'meta.event': 'reward_pool_sweep' }, { $ifNull: ['$meta.pendingReductionUsd', '$meta.amountUsd'] }),
    ]);

    const sourceTotal = starter.usd + permanent.usd + fallback.usd + corrections.usd;
    const topFallbacks = await transactions.find(
        { 'meta.isLiquidityFallback': true },
        {
            projection: {
                userId: 1,
                amount: 1,
                createdAt: 1,
                'meta.mode': 1,
                'meta.roomId': 1,
                'meta.reason': 1,
                'meta.retainedWinningsAmountUsd': 1,
                'meta.settlementError': 1,
            },
            sort: { amount: -1 },
            limit: 25,
        },
    ).toArray();
    const userIds = [...new Set(topFallbacks.map(row => String(row.userId || '')).filter(Boolean))]
        .filter(ObjectId.isValid).map(id => new ObjectId(id));
    const usernames = new Map((await users.find(
        { _id: { $in: userIds } },
        { projection: { username: 1 } },
    ).toArray()).map(user => [String(user._id), user.username]));
    const recentSweeps = await transactions.find(
        { 'meta.event': 'reward_pool_sweep' },
        {
            projection: {
                createdAt: 1,
                'meta.amountUsd': 1,
                'meta.pendingReductionUsd': 1,
                'meta.solAmount': 1,
                'meta.solPriceUsd': 1,
                'meta.signature': 1,
                'meta.from': 1,
                'meta.destination': 1,
            },
            sort: { createdAt: -1 },
            limit: 50,
        },
    ).toArray();
    const recentClaims = await rewardClaims.aggregate([
        { $match: { status: 'confirmed' } },
        { $sort: { createdAt: -1 } },
        { $limit: 20 },
        { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
        { $project: {
            createdAt: 1,
            amountUsd: 1,
            sponsoredAmountUsd: 1,
            permanentAmountUsd: 1,
            rentFallbackAmountUsd: 1,
            signature: 1,
            username: { $arrayElemAt: ['$user.username', 0] },
        } },
    ]).toArray();
    const ownerRewardSweeps = await transactions.find(
        { 'meta.event': 'reward_owner_surplus_sweep' },
        { projection: { createdAt: 1, 'meta.amountUsd': 1, 'meta.signature': 1, 'meta.destination': 1 }, sort: { createdAt: -1 } },
    ).toArray();

    console.log(JSON.stringify({
        state: {
            pendingHouseUsd: round(state?.pendingHouseUsd),
            totalFundedUsd: round(state?.totalFundedUsd),
            totalSweptUsd: round(state?.totalSweptUsd),
            totalClaimedUsd: round(state?.totalClaimedUsd),
            createdAt: state?.createdAt || null,
            updatedAt: state?.updatedAt || null,
        },
        latestFactoryReset: latestFactoryReset || null,
        fundingSourcesFromAuditRows: {
            starterContributions: starter,
            permanentRewardFunding: permanent,
            retainedCashoutFallbacks: fallback,
            corrections,
            sourceTotal: round(sourceTotal),
        },
        accountingSinceLatestFactoryReset: {
            starterContributions: starterSinceReset,
            permanentRewardFunding: permanentSinceReset,
            retainedCashoutFallbacks: fallbackSinceReset,
            corrections: correctionsSinceReset,
            sourceTotal: round(starterSinceReset.usd + permanentSinceReset.usd + fallbackSinceReset.usd + correctionsSinceReset.usd),
            houseToRewardSweeps: sweepsSinceReset,
            calculatedPendingUsd: round(starterSinceReset.usd + permanentSinceReset.usd + fallbackSinceReset.usd + correctionsSinceReset.usd - sweepsSinceReset.usd),
        },
        houseToRewardSweeps: sweeps,
        recentHouseToRewardSweeps: recentSweeps.map(row => ({
            createdAt: row.createdAt || null,
            usd: round(row.meta?.amountUsd),
            pendingReductionUsd: round(row.meta?.pendingReductionUsd),
            sol: round(row.meta?.solAmount),
            solPriceUsd: round(row.meta?.solPriceUsd),
            signature: row.meta?.signature || null,
            from: row.meta?.from || null,
            destination: row.meta?.destination || null,
        })),
        confirmedClaims: {
            count: confirmedClaims[0]?.count || 0,
            totalUsd: round(confirmedClaims[0]?.total),
            starterUsd: round(confirmedClaims[0]?.starter),
            permanentUsd: round(confirmedClaims[0]?.permanent),
            retainedCashoutUsd: round(confirmedClaims[0]?.fallback),
        },
        recentConfirmedClaims: recentClaims.map(claim => ({
            createdAt: claim.createdAt,
            username: claim.username || 'unknown',
            totalUsd: round(claim.amountUsd),
            starterUsd: round(claim.sponsoredAmountUsd),
            permanentUsd: round(claim.permanentAmountUsd),
            retainedCashoutUsd: round(claim.rentFallbackAmountUsd),
            signature: claim.signature,
        })),
        ownerRewardSweeps: ownerRewardSweeps.map(row => ({
            createdAt: row.createdAt,
            usd: round(row.meta?.amountUsd),
            signature: row.meta?.signature,
            destination: row.meta?.destination,
        })),
        largestRetainedCashouts: topFallbacks.map(row => ({
            username: usernames.get(String(row.userId)) || 'unknown',
            usd: round(row.meta?.retainedWinningsAmountUsd ?? row.amount),
            mode: row.meta?.mode || null,
            reason: row.meta?.reason || null,
            createdAt: row.createdAt || null,
            settlementError: row.meta?.settlementError || null,
        })),
    }, null, 2));
} finally {
    await client.close();
}
