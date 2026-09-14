import mongoose from 'mongoose';

export const TOURNAMENT_ENTRY_FEE_USD = 1;
export const TOURNAMENT_DURATION_MS = 30 * 60 * 1000;
export const TOURNAMENT_ENDED_VISIBLE_MS = 10 * 60 * 1000;
export const TOURNAMENT_MAX_ATTEMPTS = 3;
export const TOURNAMENT_GAMEPLAY_ENTRY_FEE_USD = 10;
export const TOURNAMENT_PRIZE_SPLITS = [0.60, 0.30, 0.10];

export const TOURNAMENT_FORMATS = Object.freeze({
    'balance-grab': Object.freeze({
        id: 'balance-grab',
        name: 'Balance Grab',
        gameMode: 'slither',
        entryFeeUsd: 1,
        maxAttempts: 3,
        gameplayEntryFeeUsd: TOURNAMENT_GAMEPLAY_ENTRY_FEE_USD,
        gameplayStartBalanceUsd: 1,
        imageUrl: '/normal slither.png',
    }),
    'mass-grab': Object.freeze({
        id: 'mass-grab',
        name: 'Mass Grab',
        gameMode: 'agar',
        entryFeeUsd: 2,
        maxAttempts: 1,
        gameplayEntryFeeUsd: TOURNAMENT_GAMEPLAY_ENTRY_FEE_USD,
        gameplayStartBalanceUsd: 2,
        imageUrl: '/mass-grab.png',
    }),
});

export function getTournamentFormat(formatId = 'balance-grab') {
    return TOURNAMENT_FORMATS[formatId] || TOURNAMENT_FORMATS['balance-grab'];
}

export function tournamentSettings(value = {}) {
    const inferredFormat = value.tournamentType
        || (value.gameMode === 'agar' ? 'mass-grab' : 'balance-grab');
    const format = getTournamentFormat(inferredFormat);
    return {
        tournamentType: format.id,
        gameMode: format.gameMode,
        entryFeeUsd: Number(value.entryFeeUsd) > 0 ? Number(value.entryFeeUsd) : format.entryFeeUsd,
        maxAttempts: Math.max(1, Math.min(10, Math.floor(Number(value.maxAttempts) || format.maxAttempts))),
        gameplayEntryFeeUsd: Number(value.gameplayEntryFeeUsd) > 0
            ? Number(value.gameplayEntryFeeUsd)
            : format.gameplayEntryFeeUsd,
        gameplayStartBalanceUsd: Number(value.gameplayStartBalanceUsd) > 0
            ? Number(value.gameplayStartBalanceUsd)
            : format.gameplayStartBalanceUsd,
        imageUrl: String(value.imageUrl || format.imageUrl),
    };
}

const ParticipantSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    entries: { type: Number, default: 0, min: 0 },
    tournamentBalanceUsd: { type: Number, default: 0, min: 0 },
    lastCashoutAt: { type: Date, default: null },
    placement: { type: Number, default: null },
    winningsUsd: { type: Number, default: 0, min: 0 },
    winningsLamports: { type: Number, default: 0, min: 0 },
    rewardCredited: { type: Boolean, default: false },
}, { _id: false });

const TournamentSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 60 },
    tournamentType: { type: String, default: 'balance-grab', enum: Object.keys(TOURNAMENT_FORMATS) },
    gameMode: {
        type: String,
        default() { return getTournamentFormat(this.tournamentType).gameMode; },
        enum: ['agar', 'slither'],
    },
    status: {
        type: String,
        enum: ['scheduled', 'live', 'settling', 'ended', 'cancelled'],
        default: 'scheduled',
        index: true,
    },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true, index: true },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    displayUntil: { type: Date, default: null },
    durationMinutes: { type: Number, default: 30 },
    entryFeeUsd: {
        type: Number,
        default() { return getTournamentFormat(this.tournamentType).entryFeeUsd; },
    },
    maxAttempts: {
        type: Number,
        default() { return getTournamentFormat(this.tournamentType).maxAttempts; },
    },
    gameplayEntryFeeUsd: {
        type: Number,
        default() { return getTournamentFormat(this.tournamentType).gameplayEntryFeeUsd; },
    },
    gameplayStartBalanceUsd: {
        type: Number,
        default() { return getTournamentFormat(this.tournamentType).gameplayStartBalanceUsd; },
    },
    imageUrl: {
        type: String,
        default() { return getTournamentFormat(this.tournamentType).imageUrl; },
    },
    prizeSplits: { type: [Number], default: TOURNAMENT_PRIZE_SPLITS },
    totalEntryFeesUsd: { type: Number, default: 0, min: 0 },
    totalCollectedLamports: { type: Number, default: 0, min: 0 },
    totalAttempts: { type: Number, default: 0, min: 0 },
    roomId: { type: String, default: null },
    participants: { type: [ParticipantSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

TournamentSchema.index({ status: 1, startAt: 1, endAt: 1 });
TournamentSchema.index({ 'participants.userId': 1, createdAt: -1 });

const TournamentRewardClaimSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amountUsd: { type: Number, required: true, min: 0 },
    lamports: { type: Number, required: true, min: 0 },
    solAmount: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ['reserving', 'reserved', 'broadcast', 'confirmed', 'failed'],
        default: 'reserving',
        index: true,
    },
    signature: { type: String, default: null },
    blockhash: { type: String, default: null },
    lastValidBlockHeight: { type: Number, default: null },
    broadcastAt: { type: Date, default: null },
    error: { type: String, default: null },
}, { timestamps: true });

export const Tournament = mongoose.models.Tournament
    || mongoose.model('Tournament', TournamentSchema);
export const TournamentRewardClaim = mongoose.models.TournamentRewardClaim
    || mongoose.model('TournamentRewardClaim', TournamentRewardClaimSchema);

export function rankTournamentParticipants(participants = []) {
    return [...participants].sort((a, b) => {
        const balanceDiff = (Number(b.tournamentBalanceUsd) || 0) - (Number(a.tournamentBalanceUsd) || 0);
        if (Math.abs(balanceDiff) > 1e-9) return balanceDiff;
        const aTime = a.lastCashoutAt ? new Date(a.lastCashoutAt).getTime() : Number.MAX_SAFE_INTEGER;
        const bTime = b.lastCashoutAt ? new Date(b.lastCashoutAt).getTime() : Number.MAX_SAFE_INTEGER;
        if (aTime !== bTime) return aTime - bTime;
        return String(a.username || '').localeCompare(String(b.username || ''));
    });
}

export function calculateTournamentPrizes(participants, potUsd, potLamports) {
    const ranked = rankTournamentParticipants(participants);
    const winnerCount = Math.min(TOURNAMENT_PRIZE_SPLITS.length, ranked.length);
    if (!winnerCount) return [];

    // Deduct the global 8% owner cut from the pot, leaving it in the tournament wallet.
    const prizePotUsd = Number(potUsd) * 0.92;
    const prizePotLamports = Math.floor(Number(potLamports) * 0.92);

    // If fewer than three people entered, normalize the available placement shares
    // so the net prize pot still belongs to the tournament players.
    const activeSplits = TOURNAMENT_PRIZE_SPLITS.slice(0, winnerCount);
    const splitTotal = activeSplits.reduce((sum, value) => sum + value, 0);
    let assignedUsd = 0;
    let assignedLamports = 0;

    return ranked.slice(0, winnerCount).map((participant, index) => {
        const isLast = index === winnerCount - 1;
        const normalizedShare = activeSplits[index] / splitTotal;
        const winningsUsd = isLast
            ? Math.max(0, Number(prizePotUsd) - assignedUsd)
            : Math.max(0, Number((Number(prizePotUsd) * normalizedShare).toFixed(6)));
        const winningsLamports = isLast
            ? Math.max(0, Math.floor(Number(prizePotLamports) - assignedLamports))
            : Math.max(0, Math.floor(Number(prizePotLamports) * normalizedShare));
        assignedUsd += winningsUsd;
        assignedLamports += winningsLamports;
        return {
            userId: participant.userId,
            username: participant.username,
            placement: index + 1,
            share: normalizedShare,
            tournamentBalanceUsd: Number(participant.tournamentBalanceUsd) || 0,
            winningsUsd,
            winningsLamports,
        };
    });
}

export function serializeTournament(doc, userId = null) {
    const value = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
    if (!value) return null;
    const key = userId?.toString();
    const participants = rankTournamentParticipants(value.participants || []);
    const me = key
        ? participants.find(p => p.userId?.toString() === key)
        : null;

    const settings = tournamentSettings(value);
    const maxAttempts = settings.maxAttempts;

    return {
        id: value._id?.toString(),
        name: value.name,
        tournamentType: settings.tournamentType,
        gameMode: settings.gameMode,
        status: value.status,
        startAt: value.startAt,
        endAt: value.endAt,
        startedAt: value.startedAt,
        endedAt: value.endedAt,
        displayUntil: value.displayUntil,
        durationMinutes: value.durationMinutes,
        entryFeeUsd: settings.entryFeeUsd,
        maxAttempts,
        gameplayEntryFeeUsd: settings.gameplayEntryFeeUsd,
        gameplayStartBalanceUsd: settings.gameplayStartBalanceUsd,
        imageUrl: settings.imageUrl,
        prizeSplits: value.prizeSplits,
        prizePotUsd: Number(((value.totalEntryFeesUsd || 0) * 0.92).toFixed(2)),
        totalAttempts: value.totalAttempts || 0,
        participantCount: participants.length,
        leaderboard: participants.slice(0, 10).map((p, index) => ({
            rank: p.placement || index + 1,
            username: p.username,
            balanceUsd: Number((p.tournamentBalanceUsd || 0).toFixed(2)),
            entries: p.entries || 0,
            winningsUsd: Number((p.winningsUsd || 0).toFixed(2)),
        })),
        me: me ? {
            entries: me.entries || 0,
            attemptsRemaining: Math.max(0, maxAttempts - (me.entries || 0)),
            balanceUsd: Number((me.tournamentBalanceUsd || 0).toFixed(2)),
            placement: me.placement || null,
            winningsUsd: Number((me.winningsUsd || 0).toFixed(2)),
            rewardCredited: !!me.rewardCredited,
        } : {
            entries: 0,
            attemptsRemaining: maxAttempts,
            balanceUsd: 0,
            placement: null,
            winningsUsd: 0,
            rewardCredited: false,
        },
    };
}
