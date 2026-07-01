import mongoose from 'mongoose';
import { randomUUID } from 'crypto';

const RewardPoolStateSchema = new mongoose.Schema({
    key: { type: String, unique: true, required: true, default: 'global' },
    pendingHouseUsd: { type: Number, default: 0 },
    totalFundedUsd: { type: Number, default: 0 },
    totalSweptUsd: { type: Number, default: 0 },
    totalClaimedUsd: { type: Number, default: 0 },
    ownerSurplusUsd: { type: Number, default: 0 },
    ownerSurplusReservedUsd: { type: Number, default: 0 },
    totalOwnerSurplusSweptUsd: { type: Number, default: 0 },
    ownerSurplusSweep: {
        sweepId: { type: String, default: null },
        amountUsd: { type: Number, default: 0 },
        solAmount: { type: Number, default: null },
        status: { type: String, enum: ['reserved', 'broadcast', 'confirmed', 'failed'], default: null },
        signature: { type: String, default: null },
        error: { type: String, default: null },
        createdAt: { type: Date, default: null },
    },
}, { timestamps: true });

const RewardClaimSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    claimKey: { type: String, unique: true, required: true },
    amountUsd: { type: Number, required: true },
    sponsoredAmountUsd: { type: Number, default: 0 },
    rentFallbackAmountUsd: { type: Number, default: 0 },
    solAmount: { type: Number, default: null },
    status: { type: String, enum: ['reserved', 'broadcast', 'confirmed', 'failed'], default: 'reserved', index: true },
    signature: { type: String, sparse: true, unique: true },
    error: { type: String, default: null },
}, { timestamps: true });

const DepositSourceSchema = new mongoose.Schema({
    signature: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sourceWallet: { type: String, required: true, index: true },
    destinationWallet: { type: String, required: true },
    amountLamports: { type: Number, required: true },
}, { timestamps: true });
DepositSourceSchema.index({ signature: 1, userId: 1, destinationWallet: 1 }, { unique: true });

const RewardSecurityAlertSchema = new mongoose.Schema({
    type: { type: String, default: 'shared_deposit_wallet' },
    sourceWallet: { type: String, unique: true, required: true },
    userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    approvedUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    snapshots: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        hasFreeTicket: Boolean,
        freeTicketUsed: Boolean,
        completedFiveDollarNormalGames: Number,
        completedTenDollarNormalGames: Number,
        sponsoredRewardsUnlocked: Boolean,
        sponsoredRewardsCompleted: Boolean,
        sponsoredRewardsBalance: Number,
    }],
    status: { type: String, enum: ['pending', 'approved', 'denied'], default: 'pending', index: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    note: { type: String, default: '' },
}, { timestamps: true });

export const RewardPoolState = mongoose.models.RewardPoolState || mongoose.model('RewardPoolState', RewardPoolStateSchema);
export const RewardClaim = mongoose.models.RewardClaim || mongoose.model('RewardClaim', RewardClaimSchema);
export const DepositSource = mongoose.models.DepositSource || mongoose.model('DepositSource', DepositSourceSchema);
export const RewardSecurityAlert = mongoose.models.RewardSecurityAlert || mongoose.model('RewardSecurityAlert', RewardSecurityAlertSchema);

let cachedPendingHouseUsd = 0;

export async function hydrateRewardPoolState() {
    let state = await RewardPoolState.findOne({ key: 'global' });
    if (!state) {
        const Transaction = mongoose.model('Transaction');
        const legacy = await Transaction.aggregate([
            { $match: { 'meta.event': { $in: ['reward_pool_contribution', 'reward_pool_correction', 'reward_pool_sweep'] } } },
            { $group: {
                _id: null,
                funded: { $sum: { $cond: [{ $eq: ['$meta.event', 'reward_pool_contribution'] }, { $ifNull: ['$meta.contributionUsd', 0] }, 0] } },
                corrected: { $sum: { $cond: [{ $eq: ['$meta.event', 'reward_pool_correction'] }, { $ifNull: ['$meta.correctionUsd', 0] }, 0] } },
                swept: { $sum: { $cond: [{ $eq: ['$meta.event', 'reward_pool_sweep'] }, { $ifNull: ['$meta.amountUsd', '$amount'] }, 0] } },
            } },
        ]);
        const funded = Math.max(0, Number(legacy[0]?.funded) || 0);
        const swept = Math.max(0, Number(legacy[0]?.swept) || 0);
        const corrected = Number(legacy[0]?.corrected) || 0;
        state = await RewardPoolState.findOneAndUpdate(
            { key: 'global' },
            { $setOnInsert: {
                pendingHouseUsd: Math.max(0, funded + corrected - swept),
                totalFundedUsd: funded,
                totalSweptUsd: swept,
                totalClaimedUsd: 0,
            } },
            { upsert: true, new: true },
        );
    }
    cachedPendingHouseUsd = Math.max(0, Number(state.pendingHouseUsd) || 0);
    return state;
}
export function getCachedPendingRewardUsd() {
    return cachedPendingHouseUsd;
}

export async function addRewardFundingUsd(amountUsd) {
    const amount = Math.max(0, Number(amountUsd) || 0);
    if (!amount) return cachedPendingHouseUsd;
    const state = await RewardPoolState.findOneAndUpdate(
        { key: 'global' },
        { $inc: { pendingHouseUsd: amount, totalFundedUsd: amount } },
        { upsert: true, new: true },
    );
    cachedPendingHouseUsd = Math.max(0, Number(state.pendingHouseUsd) || 0);
    return cachedPendingHouseUsd;
}

export async function reducePendingRewardUsd(amountUsd, { swept = false } = {}) {
    const amount = Math.max(0, Number(amountUsd) || 0);
    if (!amount) return cachedPendingHouseUsd;
    
    // Fetch, update, and save to avoid Mongoose aggregation pipeline limitations
    let state = await RewardPoolState.findOne({ key: 'global' });
    if (!state) {
        state = new RewardPoolState({ key: 'global' });
    }
    
    const currentPending = Number(state.pendingHouseUsd) || 0;
    const currentSwept = Number(state.totalSweptUsd) || 0;
    
    state.pendingHouseUsd = Math.max(0, currentPending - amount);
    if (swept) {
        state.totalSweptUsd = currentSwept + amount;
    }
    
    await state.save();
    cachedPendingHouseUsd = state.pendingHouseUsd;
    return cachedPendingHouseUsd;
}


export async function resetRewardPoolAccounting() {
    const state = await RewardPoolState.findOneAndUpdate(
        { key: 'global' },
        { $set: {
            pendingHouseUsd: 0,
            totalFundedUsd: 0,
            totalSweptUsd: 0,
            totalClaimedUsd: 0,
        } },
        { upsert: true, new: true },
    );
    cachedPendingHouseUsd = 0;
    return state;
}

export async function reserveRewardClaim(userId) {
    const User = mongoose.model('User');
    const claimId = new mongoose.Types.ObjectId();
    const claimKey = randomUUID();
    // Fetch the user first to calculate the values
    const user = await User.findOne({
        _id: userId,
        rewardClaimInProgress: { $ne: true },
        $or: [
            { rentFallbackBalanceUsd: { $gt: 0 } },
            {
                sponsoredRewardsUnlocked: true,
                sponsoredRewardsCompleted: true,
                sponsoredRewardsBalance: { $gt: 0 },
                rewardsDisabled: { $ne: true },
            },
        ],
    });
    if (!user) return null;

    const sponsoredAmountUsd = user.sponsoredRewardsUnlocked && user.sponsoredRewardsCompleted && !user.rewardsDisabled
        ? (Number(user.sponsoredRewardsBalance) || 0)
        : 0;
    const rentFallbackAmountUsd = Number(user.rentFallbackBalanceUsd) || 0;
    const amountUsd = sponsoredAmountUsd + rentFallbackAmountUsd;

    // Perform the update atomically, matching the expected balances to prevent race conditions
    const updatedUser = await User.findOneAndUpdate(
        {
            _id: userId,
            rewardClaimInProgress: { $ne: true },
            sponsoredRewardsBalance: user.sponsoredRewardsBalance,
            rentFallbackBalanceUsd: user.rentFallbackBalanceUsd,
        },
        {
            $set: {
                activeRewardClaimId: claimId,
                rewardClaimInProgress: true,
                rewardClaimReservedUsd: amountUsd,
                sponsoredRewardsBalance: user.sponsoredRewardsBalance - sponsoredAmountUsd,
                rentFallbackBalanceUsd: 0,
            }
        },
        { new: false }, // Return the old (pre-update) document as expected by the rest of the code
    );

    if (!updatedUser) return null;
    try {
        const claim = await RewardClaim.create({
            _id: claimId,
            userId,
            claimKey,
            amountUsd,
            sponsoredAmountUsd,
            rentFallbackAmountUsd,
            status: 'reserved',
        });
        return { user, claim };
    } catch (err) {
        await User.updateOne(
            { _id: userId, activeRewardClaimId: claimId },
            {
                $inc: { sponsoredRewardsBalance: sponsoredAmountUsd, rentFallbackBalanceUsd: rentFallbackAmountUsd },
                $set: { rewardClaimInProgress: false, rewardClaimReservedUsd: 0 },
                $unset: { activeRewardClaimId: 1 },
            },
        );
        throw err;
    }
}
export async function markClaimBroadcast(claimId, { signature, solAmount }) {
    return RewardClaim.findOneAndUpdate(
        { _id: claimId, status: 'reserved' },
        { $set: { status: 'broadcast', signature, solAmount, error: null } },
        { new: true },
    );
}

export async function completeRewardClaim(claimId) {
    let claim = await RewardClaim.findOneAndUpdate(
        { _id: claimId, status: { $in: ['reserved', 'broadcast'] } },
        { $set: { status: 'confirmed', error: null } },
        { new: true },
    );
    const newlyConfirmed = !!claim;
    if (!claim) {
        claim = await RewardClaim.findById(claimId);
        if (claim?.status !== 'confirmed') throw new Error('Reward claim record not found');
    }

    // The active-claim id makes this cleanup idempotent if the process stopped
    // after persisting the confirmed claim but before clearing the user lock.
    const User = mongoose.model('User');
    await User.updateOne(
        { _id: claim.userId, activeRewardClaimId: claim._id },
        { $set: { rewardClaimInProgress: false, rewardClaimReservedUsd: 0 }, $unset: { activeRewardClaimId: 1 } },
    );
    if (newlyConfirmed) {
        await RewardPoolState.updateOne({ key: 'global' }, { $inc: { totalClaimedUsd: claim.amountUsd } }, { upsert: true });
    }
    return claim;
}

export async function failAndReleaseRewardClaim(claimId, error) {
    let claim = await RewardClaim.findOneAndUpdate(
        { _id: claimId, status: { $in: ['reserved', 'broadcast'] } },
        { $set: { status: 'failed', error: String(error || 'Claim failed') } },
        { new: true },
    );
    if (!claim) {
        claim = await RewardClaim.findById(claimId);
        if (claim?.status !== 'failed') return null;
    }

    // This update can safely be retried: only the user that still points at this
    // exact claim receives the reserved balances back.
    const User = mongoose.model('User');
    await User.updateOne(
        { _id: claim.userId, activeRewardClaimId: claim._id },
        {
            $inc: { sponsoredRewardsBalance: claim.sponsoredAmountUsd || 0, rentFallbackBalanceUsd: claim.rentFallbackAmountUsd || 0 },
            $set: { rewardClaimInProgress: false, rewardClaimReservedUsd: 0 },
            $unset: { activeRewardClaimId: 1 },
        },
    );
    return claim;
}

export async function recordDepositSource({ signature, userId, sourceWallet, destinationWallet, amountLamports }) {
    if (!signature || !sourceWallet || !destinationWallet || !userId || !(amountLamports > 0)) return null;
    const trustedSystemWallets = new Set([
        process.env.HOUSE_WALLET_ADDRESS,
        process.env.REWARD_WALLET_ADDRESS,
        process.env.OWNER_VAULT_ADDRESS,
    ].filter(Boolean));
    // Arena payouts and reward claims come from shared platform wallets by design.
    if (trustedSystemWallets.has(sourceWallet)) return null;
    try {
        await DepositSource.create({ signature, userId, sourceWallet, destinationWallet, amountLamports });
    } catch (err) {
        if (err?.code !== 11000) throw err;
    }
    return evaluateSharedDepositWallet(sourceWallet);
}

async function snapshotUser(user) {
    return {
        userId: user._id,
        hasFreeTicket: !!user.hasFreeTicket,
        freeTicketUsed: !!user.freeTicketUsed,
        completedFiveDollarNormalGames: user.completedFiveDollarNormalGames || 0,
        completedTenDollarNormalGames: user.completedTenDollarNormalGames || 0,
        sponsoredRewardsUnlocked: !!user.sponsoredRewardsUnlocked,
        sponsoredRewardsCompleted: !!user.sponsoredRewardsCompleted,
        sponsoredRewardsBalance: user.sponsoredRewardsBalance || 0,
        fundedRewardsUsd: user.fundedRewardsUsd || 0,
    };
}

export async function evaluateSharedDepositWallet(sourceWallet) {
    const sources = await DepositSource.find({ sourceWallet }).lean();
    const userIds = [...new Set(sources.map(source => source.userId.toString()))];
    if (userIds.length < 2) return null;

    const User = mongoose.model('User');
    const users = await User.find({ _id: { $in: userIds } });
    let alert = await RewardSecurityAlert.findOne({ sourceWallet });

    // Migrate alerts created before approvals were scoped per account.
    if (alert?.status === 'approved' && !alert.approvedUserIds?.length) {
        alert.approvedUserIds = [...alert.userIds];
    }
    const approvedIds = new Set((alert?.approvedUserIds || []).map(id => id.toString()));
    const knownIds = new Set((alert?.userIds || []).map(id => id.toString()));
    const newlyLinkedUsers = users.filter(user => !knownIds.has(user._id.toString()));

    if (alert && newlyLinkedUsers.length === 0 && ['approved', 'denied'].includes(alert.status)) {
        return alert;
    }

    if (!alert) {
        alert = new RewardSecurityAlert({
            sourceWallet,
            userIds: users.map(user => user._id),
            snapshots: await Promise.all(users.map(snapshotUser)),
            status: 'pending',
        });
    } else {
        for (const user of newlyLinkedUsers) {
            alert.userIds.push(user._id);
            alert.snapshots.push(await snapshotUser(user));
        }
        if (newlyLinkedUsers.length > 0) {
            alert.status = 'pending';
            alert.resolvedBy = null;
            alert.resolvedAt = null;
        }
    }
    try {
        await alert.save();
    } catch (err) {
        if (err?.code !== 11000) throw err;
        alert = await RewardSecurityAlert.findOne({ sourceWallet });
        if (!alert) throw err;
    }

    // Previously approved account ids remain approved. A newly linked account
    // is blocked and must be reviewed explicitly in the dashboard.
    const usersToDisable = users.filter(user => !approvedIds.has(user._id.toString()));
    if (usersToDisable.length > 0) {
        await User.updateMany(
            { _id: { $in: usersToDisable.map(user => user._id) } },
            {
                $set: {
                    rewardsDisabled: true,
                    rewardsDisabledReason: `shared_wallet:${sourceWallet}`,
                    hasFreeTicket: false,
                    freeTicketUsed: true,
                    completedFiveDollarNormalGames: 0,
                    completedTenDollarNormalGames: 0,
                    sponsoredRewardsUnlocked: false,
                    sponsoredRewardsCompleted: false,
                    sponsoredRewardsBalance: 0,
                    fundedRewardsUsd: 0,
                },
            },
        );
    }
    return alert;
}
export async function resolveRewardSecurityAlert(alertId, action, adminUserId, note = '') {
    const alert = await RewardSecurityAlert.findById(alertId);
    if (!alert) throw new Error('Alert not found');
    if (!['approve', 'deny'].includes(action)) throw new Error('Invalid alert action');

    const User = mongoose.model('User');
    if (action === 'approve') {
        for (const snapshot of alert.snapshots) {
            await User.updateOne(
                { _id: snapshot.userId, rewardsDisabledReason: `shared_wallet:${alert.sourceWallet}` },
                { $set: {
                    rewardsDisabled: false,
                    rewardsDisabledReason: '',
                    hasFreeTicket: snapshot.hasFreeTicket,
                    freeTicketUsed: snapshot.freeTicketUsed,
                    completedFiveDollarNormalGames: snapshot.completedFiveDollarNormalGames,
                    completedTenDollarNormalGames: snapshot.completedTenDollarNormalGames,
                    sponsoredRewardsUnlocked: snapshot.sponsoredRewardsUnlocked,
                    sponsoredRewardsCompleted: snapshot.sponsoredRewardsCompleted,
                    sponsoredRewardsBalance: Math.max(snapshot.sponsoredRewardsBalance || 0, (await User.findById(snapshot.userId).lean())?.sponsoredRewardsBalance || 0),
                    fundedRewardsUsd: snapshot.fundedRewardsUsd || 0,
                } },
            );
        }
        alert.approvedUserIds = [...alert.userIds];
        alert.status = 'approved';
    } else {
        alert.status = 'denied';
    }
    alert.resolvedBy = adminUserId;
    alert.resolvedAt = new Date();
    alert.note = String(note || '').slice(0, 500);
    await alert.save();
    return alert;
}
