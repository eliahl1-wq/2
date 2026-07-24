import mongoose from 'mongoose';

const SkinEntitlementSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    gameMode: { type: String, enum: ['agar', 'slither', 'all'], required: true },
    skinId: { type: String, required: true },
    productId: { type: String, required: true },
    purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'SkinPurchase', default: null },
    source: { type: String, enum: ['purchase', 'admin'], default: 'purchase' },
}, { timestamps: true });
SkinEntitlementSchema.index({ userId: 1, gameMode: 1, skinId: 1 }, { unique: true });

const SkinPurchaseSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: String, required: true },
    gameMode: { type: String, enum: ['agar', 'slither', 'all'], required: true },
    skinId: { type: String, required: true },
    usdPrice: { type: Number, required: true },
    tokenPriceUsd: { type: Number, required: true },
    tokenAmountAtomic: { type: String, required: true },
    treasuryAmountAtomic: { type: String, required: true },
    ownerAmountAtomic: { type: String, required: true },
    decimals: { type: Number, required: true },
    quoteExpiresAt: { type: Date, required: true, index: true },
    idempotencyKey: { type: String, default: null },
    sourceAddress: { type: String, default: '' },
    treasuryAddress: { type: String, default: '' },
    ownerAddress: { type: String, default: '' },
    signature: { type: String, default: null, index: true },
    status: {
        type: String,
        enum: ['quoted', 'processing', 'broadcast', 'confirmed', 'failed', 'expired', 'needs_review'],
        default: 'quoted',
        index: true,
    },
    error: { type: String, default: '' },
    confirmedAt: { type: Date, default: null },
}, { timestamps: true });
SkinPurchaseSchema.index(
    { userId: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

const AgarSwapSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    inputMint: { type: String, required: true },
    outputMint: { type: String, required: true },
    inputAmountAtomic: { type: String, required: true },
    outputAmountAtomic: { type: String, default: '' },
    requestId: { type: String, default: '' },
    signature: { type: String, default: '', index: true },
    status: { type: String, enum: ['processing', 'broadcast', 'confirmed', 'failed', 'needs_review'], default: 'processing' },
    error: { type: String, default: '' },
}, { timestamps: true });

const WalletOperationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    operationId: { type: String, required: true },
    kind: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

export const SkinEntitlement = mongoose.models.SkinEntitlement
    || mongoose.model('SkinEntitlement', SkinEntitlementSchema);
export const SkinPurchase = mongoose.models.SkinPurchase
    || mongoose.model('SkinPurchase', SkinPurchaseSchema);
export const AgarSwap = mongoose.models.AgarSwap
    || mongoose.model('AgarSwap', AgarSwapSchema);
export const WalletOperation = mongoose.models.WalletOperation
    || mongoose.model('WalletOperation', WalletOperationSchema);

export async function acquireWalletOperation(userId, kind, operationId, leaseMs = 120_000) {
    const now = new Date();
    try {
        const lock = await WalletOperation.findOneAndUpdate(
            {
                userId,
                $or: [
                    { expiresAt: { $lte: now } },
                    { operationId },
                ],
            },
            {
                $set: {
                    kind,
                    operationId,
                    expiresAt: new Date(now.getTime() + leaseMs),
                },
            },
            { new: true, upsert: true },
        );
        return lock?.operationId === operationId;
    } catch (error) {
        if (error?.code === 11000) return false;
        throw error;
    }
}

export async function releaseWalletOperation(userId, operationId) {
    await WalletOperation.deleteOne({ userId, operationId });
}
