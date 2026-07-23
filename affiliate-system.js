import mongoose from 'mongoose';
import { createHmac, randomBytes } from 'crypto';
import {
    AFFILIATE_HOLD_DAYS,
    AFFILIATE_MIN_PAYOUT_USD_MICROS,
    AFFILIATE_TIER_CONFIG,
    PLATFORM_CASHOUT_FEE_BPS,
    REFERRAL_ATTRIBUTION_DAYS,
    getAffiliatePublicConfig,
} from './affiliate-config.js';
import {
    calculateAffiliateCommission,
    microsToUsd,
    usdToMicros,
} from './affiliate-money.js';

const { Schema } = mongoose;
const CASHOUT_REASON_RE = /^(Arena Cashout|Admin Forced Cashout|Auto Room Reset(?: to Account Address)?)$/i;
const REFERRAL_CODE_RE = /^[a-z0-9_][a-z0-9_-]{1,38}[a-z0-9_]$/;

const AffiliateTierSchema = new Schema({
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    shareBps: { type: Number, required: true, min: 0, max: 10_000 },
    enabled: { type: Boolean, default: false },
}, { timestamps: true });

const AffiliateProfileSchema = new Schema({
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    referralCode: { type: String, required: true },
    referralCodeNormalized: { type: String, required: true, unique: true, index: true },
    tierKey: { type: String, default: 'standard', index: true },
    enabled: { type: Boolean, default: true, index: true },
    suspendedAt: { type: Date, default: null },
    suspendedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    suspensionReason: { type: String, default: '' },
    internalNotes: { type: String, default: '' },
    activePayoutId: { type: Schema.Types.ObjectId, ref: 'AffiliatePayout', default: null },
}, { timestamps: true });

const ReferralClickSchema = new Schema({
    affiliateProfileId: { type: Schema.Types.ObjectId, ref: 'AffiliateProfile', required: true, index: true },
    referralCode: { type: String, required: true },
    visitorKey: { type: String, required: true, index: true },
    ipHash: { type: String, default: null, index: true },
    deviceHash: { type: String, default: null, index: true },
    userAgentHash: { type: String, default: null },
    expiresAt: { type: Date, required: true, index: true },
    convertedUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    convertedAt: { type: Date, default: null },
}, { timestamps: true });
ReferralClickSchema.index({ affiliateProfileId: 1, createdAt: -1 });
ReferralClickSchema.index({ visitorKey: 1, expiresAt: -1 });

const ReferralAttributionSchema = new Schema({
    referredUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    affiliateUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    affiliateProfileId: { type: Schema.Types.ObjectId, ref: 'AffiliateProfile', required: true, index: true },
    referralCode: { type: String, required: true },
    referralClickId: { type: Schema.Types.ObjectId, ref: 'ReferralClick', default: null },
    source: { type: String, enum: ['link', 'manual', 'google_oauth', 'migration'], default: 'manual' },
    registrationIpHash: { type: String, default: null, index: true },
    deviceHash: { type: String, default: null, index: true },
    attributedAt: { type: Date, default: Date.now, immutable: true },
}, { timestamps: true });
ReferralAttributionSchema.index({ affiliateProfileId: 1, attributedAt: -1 });

const AffiliateCommissionSchema = new Schema({
    cashoutTransactionId: { type: Schema.Types.ObjectId, ref: 'Transaction', required: true, unique: true, index: true },
    affiliateProfileId: { type: Schema.Types.ObjectId, ref: 'AffiliateProfile', required: true, index: true },
    affiliateUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    referredUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tierKey: { type: String, required: true },
    commissionShareBps: { type: Number, required: true, min: 0, max: 10_000 },
    platformFeeBps: { type: Number, required: true, min: 0, max: 10_000 },
    grossCashoutUsdMicros: { type: Number, required: true, min: 0 },
    platformFeeUsdMicros: { type: Number, required: true, min: 0 },
    commissionUsdMicros: { type: Number, required: true, min: 0 },
    gameMode: { type: String, required: true, index: true },
    currency: { type: String, default: 'USD' },
    status: {
        type: String,
        enum: ['pending', 'available', 'paid', 'reversed'],
        default: 'pending',
        index: true,
    },
    availableAt: { type: Date, required: true, index: true },
    payoutId: { type: Schema.Types.ObjectId, ref: 'AffiliatePayout', default: null, index: true },
    riskFlagged: { type: Boolean, default: false, index: true },
    paidAt: { type: Date, default: null },
    reversedAt: { type: Date, default: null },
    reversedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reversalReason: { type: String, default: '' },
    previousStatus: { type: String, default: null },
    cashoutCompletedAt: { type: Date, required: true },
}, { timestamps: true });
AffiliateCommissionSchema.index({ affiliateProfileId: 1, status: 1, availableAt: 1 });
AffiliateCommissionSchema.index({ referredUserId: 1, createdAt: -1 });

const AffiliatePayoutSchema = new Schema({
    affiliateProfileId: { type: Schema.Types.ObjectId, ref: 'AffiliateProfile', required: true, index: true },
    affiliateUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    commissionIds: [{ type: Schema.Types.ObjectId, ref: 'AffiliateCommission' }],
    amountUsdMicros: { type: Number, required: true, min: 0 },
    destinationWallet: { type: String, required: true },
    status: {
        type: String,
        enum: ['requested', 'processing', 'completed', 'rejected'],
        default: 'requested',
        index: true,
    },
    activeLockKey: { type: String, unique: true, sparse: true },
    requestedAt: { type: Date, default: Date.now },
    processingAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewReason: { type: String, default: '' },
    signature: { type: String, default: null, sparse: true },
    solAmount: { type: Number, default: null },
    solPriceUsd: { type: Number, default: null },
}, { timestamps: true });
AffiliatePayoutSchema.index({ affiliateProfileId: 1, createdAt: -1 });

const AffiliateRiskFlagSchema = new Schema({
    affiliateProfileId: { type: Schema.Types.ObjectId, ref: 'AffiliateProfile', required: true, index: true },
    referredUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    type: {
        type: String,
        enum: [
            'self_referral',
            'shared_wallet',
            'reused_wallet',
            'repeated_ip',
            'repeated_device',
            'related_account_activity',
        ],
        required: true,
        index: true,
    },
    severity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    status: { type: String, enum: ['open', 'resolved', 'dismissed'], default: 'open', index: true },
    dedupeKey: { type: String, required: true, unique: true },
    evidence: { type: Schema.Types.Mixed, default: {} },
    internalNotes: { type: String, default: '' },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
AffiliateRiskFlagSchema.index({ affiliateProfileId: 1, status: 1, createdAt: -1 });

export const AffiliateTier = mongoose.models.AffiliateTier
    || mongoose.model('AffiliateTier', AffiliateTierSchema);
export const AffiliateProfile = mongoose.models.AffiliateProfile
    || mongoose.model('AffiliateProfile', AffiliateProfileSchema);
export const ReferralClick = mongoose.models.ReferralClick
    || mongoose.model('ReferralClick', ReferralClickSchema);
export const ReferralAttribution = mongoose.models.ReferralAttribution
    || mongoose.model('ReferralAttribution', ReferralAttributionSchema);
export const AffiliateCommission = mongoose.models.AffiliateCommission
    || mongoose.model('AffiliateCommission', AffiliateCommissionSchema);
export const AffiliatePayout = mongoose.models.AffiliatePayout
    || mongoose.model('AffiliatePayout', AffiliatePayoutSchema);
export const AffiliateRiskFlag = mongoose.models.AffiliateRiskFlag
    || mongoose.model('AffiliateRiskFlag', AffiliateRiskFlagSchema);

function serviceError(message, status = 400, code = 'AFFILIATE_ERROR') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function sameId(left, right) {
    return String(left || '') === String(right || '');
}

export function normalizeReferralCode(code) {
    const normalized = String(code || '').trim().toLowerCase();
    if (!REFERRAL_CODE_RE.test(normalized)) return null;
    return normalized;
}

function safeReferralBase(username) {
    const normalized = String(username || 'player')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/^[-]+|[-]+$/g, '')
        .slice(0, 32);
    return normalizeReferralCode(normalized) ? normalized : `player_${randomBytes(3).toString('hex')}`;
}

export function hashReferralSignal(value, secret = process.env.REFERRAL_HASH_SECRET || process.env.JWT_SECRET || 'development-referral-secret') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return null;
    return createHmac('sha256', secret).update(normalized).digest('hex');
}

export function referralWindowExpiresAt(from = new Date()) {
    return new Date(new Date(from).getTime() + REFERRAL_ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000);
}

export async function ensureAffiliateTiers() {
    await Promise.all(AFFILIATE_TIER_CONFIG.map(tier => AffiliateTier.updateOne(
        { key: tier.key },
        {
            $setOnInsert: { key: tier.key, name: tier.name },
            $set: { shareBps: tier.shareBps, enabled: tier.enabled },
        },
        { upsert: true },
    )));
}

export function isAffiliateEligibleUser(user, adminUsername = process.env.ADMIN_USERNAME) {
    if (!user) return false;
    if (adminUsername && String(user.username).toLowerCase() === String(adminUsername).toLowerCase()) return false;
    return !user.isOwnerAccount && !user.personalFreePlay && !user.excludedFromReports;
}

export async function ensureAffiliateProfile(user, { adminUsername = process.env.ADMIN_USERNAME } = {}) {
    if (!isAffiliateEligibleUser(user, adminUsername)) {
        throw serviceError('This account is not eligible for the affiliate program', 403, 'AFFILIATE_INELIGIBLE');
    }

    const existing = await AffiliateProfile.findOne({ userId: user._id });
    if (existing) return existing;

    const base = safeReferralBase(user.username);
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const suffix = attempt === 0 ? '' : `-${randomBytes(2).toString('hex')}`;
        const normalized = `${base.slice(0, 40 - suffix.length)}${suffix}`;
        try {
            return await AffiliateProfile.create({
                userId: user._id,
                referralCode: normalized,
                referralCodeNormalized: normalized,
                tierKey: 'standard',
            });
        } catch (error) {
            if (error?.code !== 11000) throw error;
            const raced = await AffiliateProfile.findOne({ userId: user._id });
            if (raced) return raced;
        }
    }
    throw serviceError('Could not allocate a unique referral code', 503, 'REFERRAL_CODE_UNAVAILABLE');
}

export async function resolveReferralCode(code) {
    const normalized = normalizeReferralCode(code);
    if (!normalized) return null;
    return AffiliateProfile.findOne({
        referralCodeNormalized: normalized,
        enabled: true,
        suspendedAt: null,
    }).lean();
}

export async function recordReferralClick({
    code,
    visitorKey,
    ipHash = null,
    deviceHash = null,
    userAgentHash = null,
    now = new Date(),
}) {
    const profile = await resolveReferralCode(code);
    if (!profile) throw serviceError('Referral code not found', 404, 'REFERRAL_NOT_FOUND');
    if (!visitorKey) throw serviceError('A visitor identifier is required', 400, 'VISITOR_ID_REQUIRED');

    const current = await ReferralClick.findOne({
        visitorKey,
        expiresAt: { $gt: now },
    }).sort({ createdAt: 1 });
    if (current) return { click: current, firstTouch: false, profileId: current.affiliateProfileId };

    const click = await ReferralClick.create({
        affiliateProfileId: profile._id,
        referralCode: profile.referralCode,
        visitorKey,
        ipHash,
        deviceHash,
        userAgentHash,
        expiresAt: referralWindowExpiresAt(now),
    });
    return { click, firstTouch: true, profileId: profile._id };
}

async function upsertRiskFlag({
    affiliateProfileId,
    referredUserId = null,
    type,
    severity = 'medium',
    evidence = {},
    dedupeKey,
}) {
    return AffiliateRiskFlag.findOneAndUpdate(
        { dedupeKey },
        {
            $setOnInsert: {
                affiliateProfileId,
                referredUserId,
                type,
                severity,
                evidence,
                dedupeKey,
                status: 'open',
            },
        },
        { upsert: true, new: true },
    );
}

async function evaluateAttributionRisk(attribution, referredUser, affiliateUser) {
    const profileId = attribution.affiliateProfileId;
    const referredUserId = attribution.referredUserId;
    const wallet = String(referredUser.walletAddress || '').trim();
    const affiliateWallet = String(affiliateUser?.walletAddress || '').trim();

    if (wallet && affiliateWallet && wallet === affiliateWallet) {
        await upsertRiskFlag({
            affiliateProfileId: profileId,
            referredUserId,
            type: 'shared_wallet',
            severity: 'high',
            evidence: { walletHash: hashReferralSignal(wallet) },
            dedupeKey: `shared_wallet:${profileId}:${referredUserId}:${hashReferralSignal(wallet)}`,
        });
    }

    if (wallet) {
        const UserModel = mongoose.model('User');
        const sameWalletUsers = await UserModel.find({
            walletAddress: wallet,
            _id: { $ne: referredUserId },
        }).select('_id').lean();
        if (sameWalletUsers.length) {
            await upsertRiskFlag({
                affiliateProfileId: profileId,
                referredUserId,
                type: 'reused_wallet',
                severity: 'high',
                evidence: { walletHash: hashReferralSignal(wallet), relatedAccountCount: sameWalletUsers.length },
                dedupeKey: `reused_wallet:${profileId}:${referredUserId}:${hashReferralSignal(wallet)}`,
            });
        }
    }

    if (attribution.registrationIpHash) {
        const count = await ReferralAttribution.countDocuments({
            registrationIpHash: attribution.registrationIpHash,
        });
        if (count >= 3) {
            await upsertRiskFlag({
                affiliateProfileId: profileId,
                referredUserId,
                type: 'repeated_ip',
                evidence: { registrationCount: count },
                dedupeKey: `repeated_ip:${profileId}:${attribution.registrationIpHash}`,
            });
        }
    }

    if (attribution.deviceHash) {
        const count = await ReferralAttribution.countDocuments({ deviceHash: attribution.deviceHash });
        if (count >= 2) {
            await upsertRiskFlag({
                affiliateProfileId: profileId,
                referredUserId,
                type: 'repeated_device',
                severity: 'high',
                evidence: { registrationCount: count },
                dedupeKey: `repeated_device:${profileId}:${attribution.deviceHash}`,
            });
        }
    }
}

export async function createReferralAttribution({
    referredUser,
    code,
    source = 'manual',
    referralClickId = null,
    registrationIpHash = null,
    deviceHash = null,
}) {
    if (!referredUser?._id) throw serviceError('Referred user is required');
    const existing = await ReferralAttribution.findOne({ referredUserId: referredUser._id });
    if (existing) return { attribution: existing, created: false };

    const profile = await resolveReferralCode(code);
    if (!profile) throw serviceError('Referral code not found', 404, 'REFERRAL_NOT_FOUND');
    if (sameId(profile.userId, referredUser._id)) {
        await upsertRiskFlag({
            affiliateProfileId: profile._id,
            referredUserId: referredUser._id,
            type: 'self_referral',
            severity: 'high',
            evidence: {},
            dedupeKey: `self_referral:${profile._id}:${referredUser._id}`,
        });
        throw serviceError('You cannot refer yourself', 400, 'SELF_REFERRAL');
    }

    let validReferralClickId = null;
    if (referralClickId && mongoose.isValidObjectId(referralClickId)) {
        const click = await ReferralClick.findOne({
            _id: referralClickId,
            affiliateProfileId: profile._id,
            expiresAt: { $gt: new Date() },
        }).select('_id').lean();
        validReferralClickId = click?._id || null;
    }

    let attribution;
    try {
        attribution = await ReferralAttribution.create({
            referredUserId: referredUser._id,
            affiliateUserId: profile.userId,
            affiliateProfileId: profile._id,
            referralCode: profile.referralCode,
            referralClickId: validReferralClickId,
            source,
            registrationIpHash,
            deviceHash,
        });
    } catch (error) {
        if (error?.code !== 11000) throw error;
        attribution = await ReferralAttribution.findOne({ referredUserId: referredUser._id });
        return { attribution, created: false };
    }

    if (validReferralClickId) {
        await ReferralClick.updateOne(
            { _id: validReferralClickId, convertedUserId: null },
            { $set: { convertedUserId: referredUser._id, convertedAt: new Date() } },
        );
    }

    const affiliateUser = await mongoose.model('User').findById(profile.userId).lean();
    await evaluateAttributionRisk(attribution, referredUser, affiliateUser).catch(error => {
        console.error('[Affiliate Risk] Attribution evaluation failed:', error.message);
    });
    return { attribution, created: true };
}

export function getCommissionEligibility(cashout, referredUser, {
    adminUsername = process.env.ADMIN_USERNAME,
} = {}) {
    const meta = cashout?.meta || {};
    if (!cashout || cashout.type !== 'withdraw') return { eligible: false, reason: 'not_cashout' };
    if (cashout.status !== 'confirmed' || meta.reversed || meta.refunded || meta.cancelled) {
        return { eligible: false, reason: 'cashout_not_confirmed' };
    }
    if (cashout.excludedFromReports || meta.simulated || meta.personalFreePlay) {
        return { eligible: false, reason: 'test_or_excluded' };
    }
    if (!CASHOUT_REASON_RE.test(String(meta.reason || ''))) return { eligible: false, reason: 'ineligible_cashout_reason' };
    if (!['agar', 'slither', 'competitive-slither', 'surviv'].includes(meta.mode)) {
        return { eligible: false, reason: 'ineligible_game_mode' };
    }
    if (meta.isFreeTicketPlay || meta.locked || meta.rewardCreditedUsd || meta.promotionalBalanceUsed) {
        return { eligible: false, reason: 'promotional_activity' };
    }
    const feeBps = Number.isSafeInteger(meta.cashoutFeeBps)
        ? meta.cashoutFeeBps
        : Math.round(Number(meta.cashoutFeePct || 0) * 10_000);
    if (feeBps !== PLATFORM_CASHOUT_FEE_BPS) return { eligible: false, reason: 'platform_fee_not_collected' };
    if (!(Number(meta.platformFee) > 0) || !(Number(meta.dollarBalance) > 0)) {
        return { eligible: false, reason: 'missing_fee_snapshot' };
    }
    if (!referredUser || !isAffiliateEligibleUser(referredUser, adminUsername)) {
        return { eligible: false, reason: 'referred_account_ineligible' };
    }
    return { eligible: true, feeBps };
}

export function shouldReverseCommissionForCashout(cashout) {
    const meta = cashout?.meta || {};
    return cashout?.status !== 'confirmed'
        || !!meta.reversed
        || !!meta.refunded
        || !!meta.cancelled;
}

async function reverseCommissionForInvalidatedCashout(commission, cashout) {
    if (!commission || commission.status === 'reversed' || !shouldReverseCommissionForCashout(cashout)) {
        return commission;
    }
    return AffiliateCommission.findOneAndUpdate(
        { _id: commission._id, status: { $ne: 'reversed' } },
        {
            $set: {
                previousStatus: commission.status,
                status: 'reversed',
                reversedAt: new Date(),
                reversedBy: null,
                reversalReason: 'Source cashout was failed, reversed, refunded, or cancelled',
            },
        },
        { new: true },
    );
}

export async function createAffiliateCommissionForCashout(cashout, {
    UserModel = mongoose.model('User'),
    now = new Date(),
} = {}) {
    const prior = await AffiliateCommission.findOne({ cashoutTransactionId: cashout?._id });
    if (prior) {
        const commission = await reverseCommissionForInvalidatedCashout(prior, cashout);
        return { commission, created: false, reversed: commission?.status === 'reversed' };
    }

    const referredUser = cashout?.userId ? await UserModel.findById(cashout.userId).lean() : null;
    const eligibility = getCommissionEligibility(cashout, referredUser);
    if (!eligibility.eligible) return { commission: null, created: false, reason: eligibility.reason };

    const attribution = await ReferralAttribution.findOne({ referredUserId: cashout.userId }).lean();
    if (!attribution) return { commission: null, created: false, reason: 'no_referral_attribution' };
    const profile = await AffiliateProfile.findOne({
        _id: attribution.affiliateProfileId,
        enabled: true,
        suspendedAt: null,
    }).lean();
    if (!profile) return { commission: null, created: false, reason: 'affiliate_inactive' };

    const tier = await AffiliateTier.findOne({ key: profile.tierKey }).lean()
        || AFFILIATE_TIER_CONFIG.find(item => item.key === profile.tierKey)
        || AFFILIATE_TIER_CONFIG[0];
    const grossCashoutUsdMicros = Number.isSafeInteger(cashout.meta?.grossCashoutUsdMicros)
        ? cashout.meta.grossCashoutUsdMicros
        : usdToMicros(cashout.meta.dollarBalance);
    const platformFeeUsdMicros = Number.isSafeInteger(cashout.meta?.platformFeeUsdMicros)
        ? cashout.meta.platformFeeUsdMicros
        : usdToMicros(cashout.meta.platformFee);
    const { commissionUsdMicros } = calculateAffiliateCommission(platformFeeUsdMicros, tier.shareBps);
    if (commissionUsdMicros <= 0) return { commission: null, created: false, reason: 'commission_rounds_to_zero' };

    const openRiskCount = await AffiliateRiskFlag.countDocuments({
        affiliateProfileId: profile._id,
        status: 'open',
        $or: [
            { referredUserId: cashout.userId },
            { referredUserId: null },
        ],
    });
    const availableAt = new Date(now.getTime() + AFFILIATE_HOLD_DAYS * 24 * 60 * 60 * 1000);
    try {
        const commission = await AffiliateCommission.create({
            cashoutTransactionId: cashout._id,
            affiliateProfileId: profile._id,
            affiliateUserId: profile.userId,
            referredUserId: cashout.userId,
            tierKey: tier.key,
            commissionShareBps: tier.shareBps,
            platformFeeBps: eligibility.feeBps,
            grossCashoutUsdMicros,
            platformFeeUsdMicros,
            commissionUsdMicros,
            gameMode: cashout.meta.mode,
            currency: cashout.currency || 'USD',
            status: 'pending',
            availableAt,
            riskFlagged: openRiskCount > 0,
            cashoutCompletedAt: cashout.createdAt || now,
        });
        return { commission, created: true };
    } catch (error) {
        if (error?.code !== 11000) throw error;
        return {
            commission: await AffiliateCommission.findOne({ cashoutTransactionId: cashout._id }),
            created: false,
        };
    }
}

export async function reconcileAffiliateCommissions(TransactionModel, {
    limit = 500,
} = {}) {
    const cashouts = await TransactionModel.find({
        type: 'withdraw',
        status: 'confirmed',
        excludedFromReports: { $ne: true },
        'meta.mode': { $in: ['agar', 'slither', 'competitive-slither', 'surviv'] },
        'meta.cashoutFeeBps': PLATFORM_CASHOUT_FEE_BPS,
    }).sort({ createdAt: -1 }).limit(Math.max(1, Math.min(Number(limit) || 500, 2_000)));

    let created = 0;
    for (const cashout of cashouts) {
        const result = await createAffiliateCommissionForCashout(cashout);
        if (result.created) {
            created += 1;
            await TransactionModel.updateOne(
                { _id: cashout._id },
                {
                    $set: {
                        'meta.affiliateCommissionId': result.commission._id,
                        'meta.affiliateCommissionCreatedAt': new Date().toISOString(),
                    },
                    $unset: {
                        'meta.affiliateCommissionError': 1,
                        'meta.affiliateCommissionErrorAt': 1,
                    },
                },
            );
        }
    }

    let reversed = 0;
    const existingCommissions = await AffiliateCommission.find({
        status: { $ne: 'reversed' },
    }).sort({ updatedAt: -1 }).limit(Math.max(1, Math.min(Number(limit) || 500, 2_000)));
    if (existingCommissions.length) {
        const sourceCashouts = await TransactionModel.find({
            _id: { $in: existingCommissions.map(item => item.cashoutTransactionId) },
        });
        const cashoutById = new Map(sourceCashouts.map(item => [String(item._id), item]));
        for (const commission of existingCommissions) {
            const cashout = cashoutById.get(String(commission.cashoutTransactionId));
            if (cashout && shouldReverseCommissionForCashout(cashout)) {
                const result = await reverseCommissionForInvalidatedCashout(commission, cashout);
                if (result?.status === 'reversed') reversed += 1;
            }
        }
    }
    return { scanned: cashouts.length, created, reversed };
}

export async function releaseMatureAffiliateCommissions(affiliateProfileId = null, now = new Date()) {
    const filter = {
        status: 'pending',
        availableAt: { $lte: now },
        riskFlagged: false,
    };
    if (affiliateProfileId) filter.affiliateProfileId = affiliateProfileId;
    return AffiliateCommission.updateMany(filter, { $set: { status: 'available' } });
}

function sumMicros(rows, field = 'commissionUsdMicros') {
    return rows.reduce((total, row) => total + Number(row[field] || 0), 0);
}

function anonymizeUsername(username) {
    const value = String(username || 'Player');
    if (value.length <= 2) return `${value[0] || 'P'}*`;
    return `${value[0]}${'*'.repeat(Math.min(6, value.length - 2))}${value.at(-1)}`;
}

function serializeCommission(commission) {
    const referred = commission.referredUserId;
    return {
        id: commission._id,
        date: commission.cashoutCompletedAt || commission.createdAt,
        referredUser: anonymizeUsername(referred?.username),
        gameMode: commission.gameMode,
        grossCashoutUsd: microsToUsd(commission.grossCashoutUsdMicros),
        platformFeeUsd: microsToUsd(commission.platformFeeUsdMicros),
        commissionUsd: microsToUsd(commission.commissionUsdMicros),
        commissionShareBps: commission.commissionShareBps,
        status: commission.status,
        availableAt: commission.availableAt,
        riskFlagged: commission.riskFlagged,
    };
}

function serializePayout(payout) {
    return {
        id: payout._id,
        amountUsd: microsToUsd(payout.amountUsdMicros),
        destinationWallet: payout.destinationWallet,
        status: payout.status,
        requestedAt: payout.requestedAt,
        processingAt: payout.processingAt,
        completedAt: payout.completedAt,
        rejectedAt: payout.rejectedAt,
        signature: payout.signature,
        reviewReason: payout.reviewReason,
    };
}

export async function getAffiliateDashboard(user, { baseUrl = 'https://agararena.space' } = {}) {
    const profile = await ensureAffiliateProfile(user);
    await releaseMatureAffiliateCommissions(profile._id);

    const [
        attributionCount,
        commissions,
        recentCommissions,
        payouts,
        clickCount,
        convertedClickCount,
        openRiskCount,
        tier,
    ] = await Promise.all([
        ReferralAttribution.countDocuments({ affiliateProfileId: profile._id }),
        AffiliateCommission.find({ affiliateProfileId: profile._id }).lean(),
        AffiliateCommission.find({ affiliateProfileId: profile._id })
            .sort({ createdAt: -1 })
            .limit(50)
            .populate('referredUserId', 'username')
            .lean(),
        AffiliatePayout.find({ affiliateProfileId: profile._id }).sort({ createdAt: -1 }).limit(50).lean(),
        ReferralClick.countDocuments({ affiliateProfileId: profile._id }),
        ReferralClick.countDocuments({ affiliateProfileId: profile._id, convertedUserId: { $ne: null } }),
        AffiliateRiskFlag.countDocuments({ affiliateProfileId: profile._id, status: 'open' }),
        AffiliateTier.findOne({ key: profile.tierKey }).lean(),
    ]);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const activeReferredUsers = await AffiliateCommission.distinct('referredUserId', {
        affiliateProfileId: profile._id,
        cashoutCompletedAt: { $gte: thirtyDaysAgo },
        status: { $ne: 'reversed' },
    });
    const byStatus = status => sumMicros(commissions.filter(item => item.status === status));
    const availableMicros = sumMicros(commissions.filter(
        item => item.status === 'available' && !item.payoutId && !item.riskFlagged,
    ));
    const totalVolumeMicros = sumMicros(
        commissions.filter(item => item.status !== 'reversed'),
        'grossCashoutUsdMicros',
    );
    const config = getAffiliatePublicConfig();
    return {
        profile: {
            id: profile._id,
            referralCode: profile.referralCode,
            referralLink: `${String(baseUrl).replace(/\/$/, '')}/?ref=${encodeURIComponent(profile.referralCode)}`,
            tierKey: profile.tierKey,
            tierName: tier?.name || profile.tierKey,
            commissionShareBps: tier?.shareBps ?? config.standardAffiliateShareBps,
            enabled: profile.enabled,
            suspended: !!profile.suspendedAt,
            payoutWallet: user.walletAddress || null,
        },
        metrics: {
            totalReferredUsers: attributionCount,
            activeReferredUsers: activeReferredUsers.length,
            totalReferredCashoutVolumeUsd: microsToUsd(totalVolumeMicros),
            pendingCommissionUsd: microsToUsd(byStatus('pending')),
            availableCommissionUsd: microsToUsd(availableMicros),
            totalPaidCommissionUsd: microsToUsd(byStatus('paid')),
            reversedCommissionUsd: microsToUsd(byStatus('reversed')),
            conversionRate: clickCount > 0 ? convertedClickCount / clickCount : null,
            referralClicks: clickCount,
            openRiskFlags: openRiskCount,
        },
        commissions: recentCommissions.map(serializeCommission),
        payouts: payouts.map(serializePayout),
        config: {
            ...config,
            minimumPayoutUsd: microsToUsd(config.minimumPayoutUsdMicros),
        },
    };
}

export async function getAffiliateCommissionHistory(user, { limit = 100, before = null } = {}) {
    const profile = await ensureAffiliateProfile(user);
    await releaseMatureAffiliateCommissions(profile._id);
    const filter = { affiliateProfileId: profile._id };
    if (before && mongoose.isValidObjectId(before)) filter._id = { $lt: before };
    const rows = await AffiliateCommission.find(filter)
        .sort({ _id: -1 })
        .limit(Math.min(200, Math.max(1, Number(limit) || 100)))
        .populate('referredUserId', 'username')
        .lean();
    return {
        commissions: rows.map(serializeCommission),
        nextCursor: rows.length ? rows.at(-1)._id : null,
    };
}

export async function getAffiliatePayoutHistory(user) {
    const profile = await ensureAffiliateProfile(user);
    const rows = await AffiliatePayout.find({ affiliateProfileId: profile._id }).sort({ _id: -1 }).lean();
    return { payouts: rows.map(serializePayout) };
}

export async function requestAffiliatePayout(user) {
    const profile = await ensureAffiliateProfile(user);
    if (!profile.enabled || profile.suspendedAt) throw serviceError('Affiliate payouts are suspended', 403, 'AFFILIATE_SUSPENDED');
    const destinationWallet = String(user.walletAddress || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(destinationWallet)) {
        throw serviceError('Connect a valid payout wallet in your profile first', 400, 'PAYOUT_WALLET_REQUIRED');
    }
    await releaseMatureAffiliateCommissions(profile._id);

    const payoutId = new mongoose.Types.ObjectId();
    const lockedProfile = await AffiliateProfile.findOneAndUpdate(
        { _id: profile._id, activePayoutId: null, suspendedAt: null },
        { $set: { activePayoutId: payoutId } },
        { new: true },
    );
    if (!lockedProfile) throw serviceError('A payout request is already active', 409, 'PAYOUT_ALREADY_ACTIVE');

    try {
        const commissions = await AffiliateCommission.find({
            affiliateProfileId: profile._id,
            status: 'available',
            payoutId: null,
            riskFlagged: false,
        }).sort({ availableAt: 1, _id: 1 });
        const amountUsdMicros = sumMicros(commissions);
        if (amountUsdMicros < AFFILIATE_MIN_PAYOUT_USD_MICROS) {
            throw serviceError(
                `At least $${microsToUsd(AFFILIATE_MIN_PAYOUT_USD_MICROS).toFixed(2)} in available commission is required`,
                400,
                'MINIMUM_PAYOUT_NOT_MET',
            );
        }

        const commissionIds = commissions.map(item => item._id);
        const claimed = await AffiliateCommission.updateMany(
            {
                _id: { $in: commissionIds },
                status: 'available',
                payoutId: null,
                riskFlagged: false,
            },
            { $set: { payoutId } },
        );
        if (claimed.modifiedCount !== commissionIds.length) {
            throw serviceError('Available commission changed; please retry', 409, 'PAYOUT_RESERVATION_CONFLICT');
        }

        const payout = await AffiliatePayout.create({
            _id: payoutId,
            affiliateProfileId: profile._id,
            affiliateUserId: user._id,
            commissionIds,
            amountUsdMicros,
            destinationWallet,
            status: 'requested',
            activeLockKey: String(profile._id),
        });
        return serializePayout(payout);
    } catch (error) {
        await AffiliateCommission.updateMany({ payoutId }, { $set: { payoutId: null } }).catch(() => {});
        await AffiliatePayout.deleteOne({ _id: payoutId }).catch(() => {});
        await AffiliateProfile.updateOne({ _id: profile._id, activePayoutId: payoutId }, { $set: { activePayoutId: null } }).catch(() => {});
        throw error;
    }
}

export async function beginAffiliatePayout(payoutId, adminUserId) {
    const candidate = await AffiliatePayout.findById(payoutId);
    if (!candidate) throw serviceError('Payout not found', 404, 'PAYOUT_NOT_FOUND');
    if (candidate.status === 'requested') {
        const payableCount = await AffiliateCommission.countDocuments({
            _id: { $in: candidate.commissionIds },
            payoutId: candidate._id,
            status: 'available',
            riskFlagged: false,
        });
        if (payableCount !== candidate.commissionIds.length) {
            throw serviceError(
                'Payout contains commission that is no longer payable',
                409,
                'PAYOUT_COMMISSION_INVALIDATED',
            );
        }
    }
    const payout = await AffiliatePayout.findOneAndUpdate(
        { _id: payoutId, status: 'requested' },
        {
            $set: {
                status: 'processing',
                processingAt: new Date(),
                reviewedBy: adminUserId,
            },
        },
        { new: true },
    );
    if (payout) return payout;
    const existing = await AffiliatePayout.findById(payoutId);
    if (!existing) throw serviceError('Payout not found', 404, 'PAYOUT_NOT_FOUND');
    if (existing.status === 'processing' || existing.status === 'completed') return existing;
    throw serviceError(`Cannot approve a ${existing.status} payout`, 409, 'INVALID_PAYOUT_STATUS');
}

export async function completeAffiliatePayout(payoutId, {
    adminUserId,
    signature,
    solAmount,
    solPriceUsd,
}) {
    const payout = await AffiliatePayout.findOneAndUpdate(
        { _id: payoutId, status: 'processing' },
        {
            $set: {
                status: 'completed',
                completedAt: new Date(),
                reviewedBy: adminUserId,
                signature,
                solAmount,
                solPriceUsd,
            },
            $unset: { activeLockKey: 1 },
        },
        { new: true },
    );
    if (!payout) {
        const existing = await AffiliatePayout.findById(payoutId);
        if (existing?.status === 'completed') return existing;
        throw serviceError('Payout is not processing', 409, 'INVALID_PAYOUT_STATUS');
    }
    await Promise.all([
        AffiliateCommission.updateMany(
            { _id: { $in: payout.commissionIds }, payoutId: payout._id, status: 'available' },
            { $set: { status: 'paid', paidAt: new Date() } },
        ),
        AffiliateProfile.updateOne(
            { _id: payout.affiliateProfileId, activePayoutId: payout._id },
            { $set: { activePayoutId: null } },
        ),
    ]);
    return payout;
}

export async function rejectAffiliatePayout(payoutId, {
    adminUserId,
    reason,
}) {
    const cleanReason = String(reason || '').trim();
    if (cleanReason.length < 3) throw serviceError('A rejection reason is required');
    const payout = await AffiliatePayout.findOneAndUpdate(
        {
            _id: payoutId,
            status: { $in: ['requested', 'processing'] },
            signature: null,
        },
        {
            $set: {
                status: 'rejected',
                rejectedAt: new Date(),
                reviewedBy: adminUserId,
                reviewReason: cleanReason,
            },
            $unset: { activeLockKey: 1 },
        },
        { new: true },
    );
    if (!payout) {
        const existing = await AffiliatePayout.findById(payoutId);
        if (existing?.status === 'rejected') return existing;
        throw serviceError('Payout cannot be rejected', 409, 'INVALID_PAYOUT_STATUS');
    }
    await Promise.all([
        AffiliateCommission.updateMany(
            { _id: { $in: payout.commissionIds }, payoutId: payout._id, status: 'available' },
            { $set: { payoutId: null } },
        ),
        AffiliateProfile.updateOne(
            { _id: payout.affiliateProfileId, activePayoutId: payout._id },
            { $set: { activePayoutId: null } },
        ),
    ]);
    return payout;
}

export async function reverseAffiliateCommission(commissionId, {
    adminUserId,
    reason,
}) {
    const cleanReason = String(reason || '').trim();
    if (cleanReason.length < 3) throw serviceError('An audit reason is required');
    const current = await AffiliateCommission.findById(commissionId);
    if (!current) throw serviceError('Commission not found', 404, 'COMMISSION_NOT_FOUND');
    if (current.status === 'reversed') return current;
    if (current.payoutId) {
        const payout = await AffiliatePayout.findById(current.payoutId).lean();
        if (payout && ['requested', 'processing'].includes(payout.status)) {
            throw serviceError('Reject the active payout before reversing this commission', 409, 'COMMISSION_RESERVED');
        }
    }
    current.previousStatus = current.status;
    current.status = 'reversed';
    current.reversedAt = new Date();
    current.reversedBy = adminUserId;
    current.reversalReason = cleanReason;
    await current.save();
    return current;
}

export async function getOutstandingAffiliateLiabilityUsdMicros() {
    const rows = await AffiliateCommission.aggregate([
        {
            $match: {
                status: { $in: ['pending', 'available'] },
            },
        },
        {
            $group: {
                _id: null,
                total: { $sum: '$commissionUsdMicros' },
            },
        },
    ]);
    return Number(rows[0]?.total || 0);
}

export async function scanAffiliateWalletRisk(user) {
    if (!user?._id || !user.walletAddress) return;
    const attribution = await ReferralAttribution.findOne({ referredUserId: user._id });
    if (attribution) {
        const affiliateUser = await mongoose.model('User').findById(attribution.affiliateUserId).lean();
        await evaluateAttributionRisk(attribution, user, affiliateUser);
    }
    const profile = await AffiliateProfile.findOne({ userId: user._id });
    if (profile) {
        const referred = await ReferralAttribution.find({ affiliateProfileId: profile._id }).select('referredUserId');
        const referredUsers = await mongoose.model('User').find({
            _id: { $in: referred.map(item => item.referredUserId) },
            walletAddress: user.walletAddress,
        }).select('_id walletAddress').lean();
        for (const referredUser of referredUsers) {
            await upsertRiskFlag({
                affiliateProfileId: profile._id,
                referredUserId: referredUser._id,
                type: 'shared_wallet',
                severity: 'high',
                evidence: { walletHash: hashReferralSignal(user.walletAddress) },
                dedupeKey: `shared_wallet:${profile._id}:${referredUser._id}:${hashReferralSignal(user.walletAddress)}`,
            });
        }
    }
}

export async function getAdminAffiliateOverview() {
    await releaseMatureAffiliateCommissions();
    const profiles = await AffiliateProfile.find()
        .populate('userId', 'username email walletAddress')
        .sort({ createdAt: -1 })
        .lean();
    const [attributions, commissions, payouts, risks, tiers] = await Promise.all([
        ReferralAttribution.find().lean(),
        AffiliateCommission.find()
            .sort({ createdAt: -1 })
            .limit(500)
            .populate('referredUserId', 'username')
            .populate('affiliateUserId', 'username')
            .lean(),
        AffiliatePayout.find().sort({ createdAt: -1 }).lean(),
        AffiliateRiskFlag.find({ status: 'open' }).sort({ createdAt: -1 }).lean(),
        AffiliateTier.find().sort({ shareBps: 1 }).lean(),
    ]);
    const affiliates = profiles.map(profile => {
        const ownAttributions = attributions.filter(item => sameId(item.affiliateProfileId, profile._id));
        const ownCommissions = commissions.filter(item => sameId(item.affiliateProfileId, profile._id));
        const amountFor = status => sumMicros(ownCommissions.filter(item => item.status === status));
        return {
            id: profile._id,
            userId: profile.userId?._id,
            username: profile.userId?.username,
            email: profile.userId?.email,
            payoutWallet: profile.userId?.walletAddress || null,
            referralCode: profile.referralCode,
            referralCount: ownAttributions.length,
            referredCashoutVolumeUsd: microsToUsd(sumMicros(
                ownCommissions.filter(item => item.status !== 'reversed'),
                'grossCashoutUsdMicros',
            )),
            pendingCommissionUsd: microsToUsd(amountFor('pending')),
            availableCommissionUsd: microsToUsd(amountFor('available')),
            paidCommissionUsd: microsToUsd(amountFor('paid')),
            reversedCommissionUsd: microsToUsd(amountFor('reversed')),
            tierKey: profile.tierKey,
            enabled: profile.enabled,
            suspended: !!profile.suspendedAt,
            suspensionReason: profile.suspensionReason,
            internalNotes: profile.internalNotes,
            openRiskFlags: risks.filter(item => sameId(item.affiliateProfileId, profile._id)).length,
            createdAt: profile.createdAt,
        };
    });
    return {
        affiliates,
        commissions: commissions.map(commission => ({
            ...serializeCommission(commission),
            affiliateUsername: commission.affiliateUserId?.username || 'Unknown',
            referredUsername: anonymizeUsername(commission.referredUserId?.username),
            cashoutTransactionId: commission.cashoutTransactionId,
            reversalReason: commission.reversalReason,
        })),
        payouts: payouts.map(serializePayout),
        riskFlags: risks,
        tiers,
        config: getAffiliatePublicConfig(),
    };
}

export async function updateAffiliateProfileAdmin(profileId, {
    tierKey,
    suspended,
    reason,
    internalNotes,
    adminUserId,
}) {
    const updates = {};
    if (tierKey !== undefined) {
        const tier = await AffiliateTier.findOne({ key: tierKey });
        if (!tier) throw serviceError('Affiliate tier not found', 404, 'TIER_NOT_FOUND');
        updates.tierKey = tier.key;
    }
    if (suspended !== undefined) {
        updates.suspendedAt = suspended ? new Date() : null;
        updates.suspendedBy = suspended ? adminUserId : null;
        updates.suspensionReason = suspended ? String(reason || '').trim() : '';
        updates.enabled = !suspended;
        if (suspended && updates.suspensionReason.length < 3) {
            throw serviceError('A suspension reason is required');
        }
    }
    if (internalNotes !== undefined) updates.internalNotes = String(internalNotes).slice(0, 5000);
    const profile = await AffiliateProfile.findByIdAndUpdate(profileId, { $set: updates }, { new: true });
    if (!profile) throw serviceError('Affiliate profile not found', 404, 'AFFILIATE_NOT_FOUND');
    return profile;
}

export async function resolveAffiliateRiskFlag(flagId, {
    status,
    notes,
    adminUserId,
}) {
    if (!['resolved', 'dismissed'].includes(status)) throw serviceError('Invalid risk resolution');
    const flag = await AffiliateRiskFlag.findByIdAndUpdate(
        flagId,
        {
            $set: {
                status,
                internalNotes: String(notes || '').slice(0, 5000),
                resolvedAt: new Date(),
                resolvedBy: adminUserId,
            },
        },
        { new: true },
    );
    if (!flag) throw serviceError('Risk flag not found', 404, 'RISK_FLAG_NOT_FOUND');
    const remaining = await AffiliateRiskFlag.countDocuments({
        affiliateProfileId: flag.affiliateProfileId,
        referredUserId: flag.referredUserId,
        status: 'open',
    });
    if (!remaining) {
        await AffiliateCommission.updateMany(
            {
                affiliateProfileId: flag.affiliateProfileId,
                referredUserId: flag.referredUserId,
                status: 'pending',
            },
            { $set: { riskFlagged: false } },
        );
        await releaseMatureAffiliateCommissions(flag.affiliateProfileId);
    }
    return flag;
}
