import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { createServer } from 'http';
import 'dotenv/config';
import * as util from './utils.js';
import { QuadTree, Rectangle, Point } from './quadtree.js';
import * as solanaWeb3 from '@solana/web3.js';
import passport from 'passport';
import { randomBytes } from 'crypto';
import fetch from 'node-fetch'; // Se till att du kör 'npm install node-fetch'
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import {
    SLITHER,
    COMPETITIVE_SLITHER,
    createSlitherPlayer,
    createCompetitiveSlitherPlayer,
    createCompetitiveSlitherAdminBot,
    addSlitherBots,
    getSlitherTargetBots,
    trimSlitherBots,
    processSlitherRoom,
    processCompetitiveSlitherRoom,
    broadcastSlitherState,
    broadcastCompetitiveSlitherState,
    syncSlitherFood,
    syncCompetitiveSlitherFood,
    spawnGoldenSlitherBlob,
    getCompetitiveEffectiveRadius,
    getCompetitiveZone,
    addSlitherFood,
    createSegments,
    isSpawnClear,
    isCompetitiveSpawnClear,
    pickSlitherSpawn,
} from './slither-engine.js';
import {
    ALLOWED_ENTRY_FEES,
    DEFAULT_ENTRY_FEE,
    COMPETITIVE_SLITHER_ENTRY_FEES,
    DEFAULT_COMPETITIVE_ENTRY_FEE,
    SURVIV_ENTRY_FEES,
    DEFAULT_SURVIV_ENTRY_FEE,
    normalizeEntryFee,
    normalizeCompetitiveEntryFee,
    normalizeSurvivEntryFee,
    getEconomy,
    getCompetitiveEconomy,
    getSurvivEconomy,
    getJoinPoolSplit,
    getRewardPoolSplit,
    getGoldenBlobValue,
    wealthTaxDecayAmount,
} from './economy.js';
import {
    SURVIV,
    beginSurvivReload,
    createSurvivPlayer,
    generateSurvivMap,
    getSurvivZone,
    processSurvivRoom,
    resetSurvivRoomRuntime,
    broadcastSurvivState,
    spawnLootFromPool,
    spawnSurvivBotNear,
} from './surviv-engine.js';
import {
    setupBattleRoyale,
    processBattleRoyaleMatches,
    processBRQueues,
    findBRPlayerBySocket,
    getBRMatchForMongo,
    isPlayerInBR,
    getBRPlayerCountsByFee,
    getRecentBRVictories,
    getBRServerStatus,
    BR,
    getActiveBRMatchesRaw,
} from './battle-royale.js';
import { setupSandbox, getSandboxStatus, applySandboxAction, getSandboxRoom } from './sandbox.js';
import {
    RewardClaim,
    RewardPoolState,
    RewardSecurityAlert,
    addRewardFundingUsd,
    completeRewardClaim,
    failAndReleaseRewardClaim,
    getCachedPendingRewardUsd,
    hydrateRewardPoolState,
    markClaimBroadcast,
    recordDepositSource,
    reducePendingRewardUsd,
    reserveRewardClaim,
    resetRewardPoolAccounting,
    resolveRewardSecurityAlert,
    setOwnerAccountStatus,
} from './reward-system.js';
import { validateBRWalletsOnStartup, listBRHouseWallets } from './br-wallets.js';
import {
    Tournament,
    TournamentRewardClaim,
    TOURNAMENT_DURATION_MS,
    TOURNAMENT_ENDED_VISIBLE_MS,
    TOURNAMENT_ENTRY_FEE_USD,
    TOURNAMENT_GAMEPLAY_ENTRY_FEE_USD,
    TOURNAMENT_MAX_ATTEMPTS,
    calculateTournamentPrizes,
    serializeTournament,
} from './tournament-system.js';

// --- SOLANA KONFIGURATION ---
const HOUSE_WALLET_ADDRESS = process.env.HOUSE_WALLET_ADDRESS;
const HOUSE_WALLET_SECRET = process.env.HOUSE_WALLET_SECRET;
const OWNER_VAULT_ADDRESS = process.env.OWNER_VAULT_ADDRESS; // Din personliga plånbok för vinst
const REWARD_WALLET_ADDRESS = process.env.REWARD_WALLET_ADDRESS;
const REWARD_WALLET_SECRET = process.env.REWARD_WALLET_SECRET;
const TOURNAMENT_WALLET_ADDRESS = process.env.TOURNAMENT_WALLET_ADDRESS;
const TOURNAMENT_WALLET_SECRET = process.env.TOURNAMENT_WALLET_SECRET;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || solanaWeb3.clusterApiUrl('mainnet-beta');
const connection = new solanaWeb3.Connection(SOLANA_RPC_URL, 'confirmed');
const DEV_FREE_PLAY = process.env.DEV_FREE_PLAY === 'true';
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
    console.warn('JWT_SECRET is not configured; using a process-local development secret. Sessions will reset on restart.');
}
let SOL_PRICE_USD = 57; // Default fallback price, updated by market scanner

if (DEV_FREE_PLAY) {
    console.warn('⚠️ DEV_FREE_PLAY is ON — join/cashout/reset use simulated money (no real Solana).');
}

function logGameLoopError(label, err) {
    const message = err?.stack || err?.message || err;
    console.error(`[GAME LOOP ERROR] ${label}:`, message);
}

async function logSolanaTransactionError(label, err) {
    let logs = err?.logs || null;
    if (!logs && typeof err?.getLogs === 'function') {
        try {
            logs = await err.getLogs(connection);
        } catch {
            // The original error remains the useful fallback.
        }
    }
    console.error(label, err?.message || err, logs ? { logs } : '');
}

async function updateSolPrice() {
    try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        if (!response.ok) throw new Error('CoinGecko network error');
        const data = await response.json();
        if (data && data.solana && data.solana.usd) {
            SOL_PRICE_USD = parseFloat(data.solana.usd);
            console.log(`[PRICE SCANNER] Live SOL price updated to: $${SOL_PRICE_USD} USD`);
        }
    } catch (error) {
        console.error('[PRICE SCANNER ERROR] CoinGecko failed, trying Binance...', error.message);
        try {
            const binanceResponse = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
            const binanceData = await binanceResponse.json();
            if (binanceData && binanceData.price) {
                SOL_PRICE_USD = parseFloat(binanceData.price);
                console.log(`[PRICE SCANNER FALLBACK] Live SOL price updated from Binance: $${SOL_PRICE_USD} USD`);
            }
        } catch (binanceError) {
            console.error('[PRICE SCANNER ERROR] Fallback Binance API also failed:', binanceError.message);
        }
    }
}
// Start scanner immediately and refresh every 5 minutes
updateSolPrice();
setInterval(updateSolPrice, 300000);

// Kontrollera att kritiska miljövariabler finns
if (!HOUSE_WALLET_ADDRESS || !HOUSE_WALLET_SECRET) {
    console.warn("⚠️ VARNING: HOUSE_WALLET_ADDRESS eller HOUSE_WALLET_SECRET saknas i miljövariablerna!");
    console.warn("Transaktioner och cashouts kommer inte att fungera.");
} else {
    console.log("✅ Solana House Wallet konfigurerad: " + HOUSE_WALLET_ADDRESS);
}

validateBRWalletsOnStartup({ devFreePlay: DEV_FREE_PLAY });

// Reward wallet startup validation
if (REWARD_WALLET_ADDRESS && REWARD_WALLET_SECRET) {
    console.log('✅ Reward Wallet configured:', REWARD_WALLET_ADDRESS);
} else if (REWARD_WALLET_ADDRESS || REWARD_WALLET_SECRET) {
    console.warn('⚠️  Reward Wallet incomplete — set BOTH REWARD_WALLET_ADDRESS and REWARD_WALLET_SECRET.');
} else {
    console.warn('⚠️  Reward Wallet not configured — reward pool contributions tracked in-memory only (no on-chain transfers).');
}

if (TOURNAMENT_WALLET_ADDRESS && TOURNAMENT_WALLET_SECRET) {
    console.log('Tournament Wallet configured:', TOURNAMENT_WALLET_ADDRESS);
} else if (TOURNAMENT_WALLET_ADDRESS || TOURNAMENT_WALLET_SECRET) {
    console.warn('Tournament Wallet incomplete - set BOTH TOURNAMENT_WALLET_ADDRESS and TOURNAMENT_WALLET_SECRET.');
} else {
    console.warn('Tournament Wallet not configured - real-money tournament entries and claims are disabled.');
}

const allowedOrigins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://www.agararena.space",
    "https://agararena.space",
    "https://2-production-9e74.up.railway.app",
    /\.up\.railway\.app$/,
    /\.agararena\.space$/,
    ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
];

function isOriginAllowed(origin) {
    if (!origin) return true;
    return allowedOrigins.some(o => (typeof o === 'string' ? o === origin : o.test(origin)));
}

function applyCorsHeaders(req, res) {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    }
}

const corsOptions = {
    origin(origin, callback) {
        if (!origin || isOriginAllowed(origin)) callback(null, true);
        else {
            console.warn(`CORS blocked origin: ${origin}`);
            callback(null, false);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'bypass-tunnel-reminders', 'Cache-Control', 'Pragma', 'X-Presence-Id', 'X-Presence-Timezone', 'X-Presence-Page', 'X-Presence-Gamemode'],
};

const app = express();

// Always answer preflight + attach ACAO even if a route throws (e.g. during Railway restarts)
app.use((req, res, next) => {
    applyCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, bypass-tunnel-reminders, Cache-Control, Pragma, X-Presence-Id, X-Presence-Timezone, X-Presence-Page, X-Presence-Gamemode');
        return res.sendStatus(204);
    }
    next();
});

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());

// --- 1. MODELLER & KONFIGURATION (Flyttade till toppen för att undvika krascher) ---

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, unique: true, sparse: true },
    googleId: { type: String, unique: true, sparse: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 }, // Tracked in raw SOL
    walletAddress: { type: String },
    depositAddress: { type: String },
    depositSecret: { type: String },
    playtime: { type: Number, default: 0 },
    excludedFromReports: { type: Boolean, default: false },
    isOwnerAccount: { type: Boolean, default: false, index: true },
    sponsoredRewardsCompleted: { type: Boolean, default: false },
    hasFreeTicket: { type: Boolean, default: true },
    freeTicketUsed: { type: Boolean, default: false },
    completedFiveDollarNormalGames: { type: Number, default: 0 },
    completedTenDollarNormalGames: { type: Number, default: 0 },
    sponsoredRewardsUnlocked: { type: Boolean, default: false },
    sponsoredRewardsBalance: { type: Number, default: 0 }, // USD-denominated promotional reward
    fundedRewardsUsd: { type: Number, default: 0 }, // Amount of the reward that has been funded by the player's game entries
    rentFallbackBalanceUsd: { type: Number, default: 0 }, // Real cashouts retained because the destination was below rent minimum
    rewardsDisabled: { type: Boolean, default: false },
    rewardsDisabledReason: { type: String, default: '' },
    rewardClaimInProgress: { type: Boolean, default: false },
    rewardClaimReservedUsd: { type: Number, default: 0 },
    activeRewardClaimId: { type: mongoose.Schema.Types.ObjectId, default: null },
    tournamentRewardsBalance: { type: Number, default: 0 },
    tournamentRewardsLamports: { type: Number, default: 0 },
    tournamentRewardClaimInProgress: { type: Boolean, default: false },
    tournamentRewardClaimReservedUsd: { type: Number, default: 0 },
    tournamentRewardClaimReservedLamports: { type: Number, default: 0 },
    activeTournamentRewardClaimId: { type: mongoose.Schema.Types.ObjectId, default: null },
    tournamentRewardCreditIds: { type: [String], default: [] },
    lastDepositSourceSignature: { type: String, default: null },
    depositHistoryBackfilledAt: { type: Date, default: null },
});

const User = mongoose.model('User', UserSchema);

const TransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: { type: String, enum: ['deposit', 'withdraw', 'game'], required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    meta: { type: Object, default: {} },
    status: { type: String, enum: ['pending', 'confirmed', 'failed'], default: 'confirmed' },
    excludedFromReports: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

function getDynamicChallengeReqs(sponsoredRewardsBalance) {
    const balance = sponsoredRewardsBalance || 0;
    const requiredContribution = Math.max(5, balance);
    const multiplier = Math.ceil(requiredContribution / 5);
    return {
        req5: multiplier * 3,
        req10: multiplier * 1
    };
}

TransactionSchema.post('save', async function(doc) {
    if (doc.status !== 'confirmed') return;
    const isNormalGameDeath = doc.type === 'game' && doc.meta?.event === 'death' && doc.meta?.reason === 'Arena Death';
    const isNormalGameCashout = doc.type === 'withdraw'
        && (doc.meta?.reason === 'Arena Cashout' || doc.meta?.reason === 'Auto Room Reset to Account Address');
    if (!isNormalGameDeath && !isNormalGameCashout) return;

    const userId = doc.userId;
    const entryFeeUsd = Number(doc.meta?.entryFeeUsd);
    const mode = doc.meta?.mode;
    if (!userId || !['agar', 'slither'].includes(mode) || doc.meta?.isFreeTicketPlay || ![5, 10].includes(entryFeeUsd)) return;

    const TransactionMod = mongoose.model('Transaction');
    const marker = await TransactionMod.updateOne(
        { _id: doc._id, 'meta.challengeProgressApplied': { $ne: true } },
        { $set: { 'meta.challengeProgressApplied': true, 'meta.challengeProgressAppliedAt': new Date().toISOString() } },
    );
    if (!marker.modifiedCount) return;

    try {
        const UserMod = mongoose.model('User');
        const current = await UserMod.findOne({
            _id: userId,
            sponsoredRewardsUnlocked: { $ne: true },
            freeTicketUsed: true,
            rewardsDisabled: { $ne: true },
        }).lean();
        if (!current) return;

        const reqs = getDynamicChallengeReqs(current.sponsoredRewardsBalance);
        const progressField = entryFeeUsd === 5
            ? 'completedFiveDollarNormalGames'
            : 'completedTenDollarNormalGames';
        const required = entryFeeUsd === 5 ? reqs.req5 : reqs.req10;
        const updated = await UserMod.findOneAndUpdate(
            {
                _id: userId,
                sponsoredRewardsUnlocked: { $ne: true },
                freeTicketUsed: true,
                rewardsDisabled: { $ne: true },
                [progressField]: { $lt: required },
            },
            { $inc: { [progressField]: 1 } },
            { new: true },
        );
        if (!updated) return;

        console.log(`[Challenge Progress] User ${updated.username} completed a $${entryFeeUsd} normal game. `
            + `${updated[progressField]}/${required}`);

        const unlocked = await UserMod.findOneAndUpdate(
            {
                _id: userId,
                sponsoredRewardsUnlocked: { $ne: true },
                completedFiveDollarNormalGames: { $gte: reqs.req5 },
                completedTenDollarNormalGames: { $gte: reqs.req10 },
            },
            { $set: { sponsoredRewardsUnlocked: true, sponsoredRewardsCompleted: true } },
            { new: true },
        );
        if (!unlocked) return;


        console.log(`[Challenge Unlocked] User ${unlocked.username} completed all sponsored reward challenges!`);
    } catch (err) {
        await TransactionMod.updateOne(
            { _id: doc._id },
            { $unset: { 'meta.challengeProgressApplied': 1, 'meta.challengeProgressAppliedAt': 1 } },
        ).catch(() => {});
        console.error('Error in Transaction post-save challenge processing:', err.message);
    }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

/** In-game cashouts only — excludes account withdrawals to external wallets. */
const GAME_CASHOUT_REASON_RE = /Arena Cashout|Admin Forced Cashout|Auto Room Reset|BR Victory/i;

function buildGameCashoutTxFilter() {
    return {
        type: 'withdraw',
        'meta.reason': { $regex: GAME_CASHOUT_REASON_RE },
        'meta.destination': { $exists: false },
        'meta.event': { $nin: ['pool_sweep', 'br_owner_sweep', 'reward_owner_surplus_sweep', 'reward_pool_factory_reset'] },
    };
}

const c = {
    worldWidth: 6000,
    worldHeight: 6000,
    foodCount: 0,
    virusCount: 40,
    playerStartBalance: 1.0,
    maxCells: 16,
    minMassSplit: 2.0,
    minMassEject: 1.5,
    ejectMass: 0.05,
    ejectMassGain: 0.05,
    massLossRate: 1.0,
    mergeTimer: 2,
    speedMult: 1.45,
    houseFee: 0.0,
    targetPopulation: 30,
    botStartBalance: 1.0,
    botMaxBalance: 500.0,
    sizeMult: 18,
    growthBoost: 2,
    foodValuePerPlayer: 6.0,
    foodBlobValue: 0.04, // legacy doc; use foodBlobValueForRoom(room) per arena tier
    roomDuration: process.env.DEV_ROOM_DURATION_MS
        ? parseInt(process.env.DEV_ROOM_DURATION_MS, 10)
        : 3 * 60 * 60 * 1000,
};

const CASHOUT_DURATION_MS = 5_000;
const joiningUsers = new Set();
let rewardPoolAdminResetting = false;

let GLOBAL_ARENA_START = Date.now();
let globalArenaResetting = false;

function createArenaRoom(entryFeeUsd) {
    return {
        id: `arena-${entryFeeUsd}`,
        entryFeeUsd,
        players: [],
        bots: [],
        slitherBots: [],
        food: [],
        slitherFood: [],
        spectators: [],
        viruses: [],
        ejected: [],
        foodPoolBalance: 0,
        aiBudgetBalance: 0,
        ownerBalance: 0,
        fundedEntryUsd: 0,
        reservedCashoutUsd: 0,
        paidCashoutUsd: 0,
        startTime: GLOBAL_ARENA_START,
        isResetting: false,
        qt: new QuadTree(new Rectangle(c.worldWidth / 2, c.worldHeight / 2, c.worldWidth / 2, c.worldHeight / 2), 4),
        lastHumanTime: Date.now(),
    };
}

const rooms = [
    ...ALLOWED_ENTRY_FEES.map(fee => createArenaRoom(fee)),
    Object.assign(createArenaRoom(5), { id: 'arena-free-ticket', isFreeTicketRoom: true })
];

const tournamentRooms = new Map();

function createTournamentArenaRoom(tournament) {
    const room = createArenaRoom(TOURNAMENT_GAMEPLAY_ENTRY_FEE_USD);
    room.id = `tournament-${tournament._id}`;
    room.isTournament = true;
    room.tournamentId = tournament._id.toString();
    room.tournamentName = tournament.name;
    room.startTime = new Date(tournament.startedAt || tournament.startAt).getTime();
    room.endTime = new Date(tournament.endAt).getTime();
    // Score food and bots are intentionally virtual. Tournament entry fees never
    // fund this gameplay pool; the complete entry pot stays in the tournament wallet.
    room.foodPoolBalance = 1_000_000;
    room.aiBudgetBalance = 20;
    tournamentRooms.set(room.tournamentId, room);
    return room;
}

function getTournamentRoom(tournamentOrId) {
    const id = tournamentOrId?._id?.toString?.() || tournamentOrId?.toString?.();
    if (!id) return null;
    return tournamentRooms.get(id) || null;
}

function createCompetitiveSlitherRoom(entryFeeUsd) {
    return {
        id: `competitive-slither-${entryFeeUsd}`,
        entryFeeUsd,
        isCompetitiveSlither: true,
        players: [],
        competitiveSpectators: [],
        slitherFood: [],
        startTime: GLOBAL_ARENA_START,
        isResetting: false,
    };
}

const competitiveSlitherRooms = COMPETITIVE_SLITHER_ENTRY_FEES.map(fee => createCompetitiveSlitherRoom(fee));

function createSurvivRoom(entryFeeUsd) {
    const map = generateSurvivMap(SURVIV.worldHalf);
    return {
        id: `surviv-${entryFeeUsd}`,
        entryFeeUsd,
        isSurviv: true,
        players: [],
        bots: [],
        bullets: [],
        loot: [...map.loot],
        obstacles: map.obstacles,
        spawnPoints: map.spawnPoints,
        landmarks: map.landmarks,
        lootPoolBalance: 0,
        spectators: [],
        deathMarkers: [],
        startTime: GLOBAL_ARENA_START,
        isResetting: false,
    };
}

const survivRooms = SURVIV_ENTRY_FEES.map(fee => createSurvivRoom(fee));

function getSurvivRoom(entryFeeUsd) {
    const fee = normalizeSurvivEntryFee(entryFeeUsd);
    return survivRooms.find(r => r.entryFeeUsd === fee)
        ?? survivRooms.find(r => r.entryFeeUsd === DEFAULT_SURVIV_ENTRY_FEE);
}

function findSurvivRoomById(roomId) {
    return survivRooms.find(r => r.id === roomId) ?? null;
}

function removeSurvivSpectator(room, socketId) {
    if (!room?.spectators?.length) return;
    room.spectators = room.spectators.filter(s => s.id !== socketId);
}

function getCompetitiveSlitherRoom(entryFeeUsd) {
    const fee = normalizeCompetitiveEntryFee(entryFeeUsd);
    return competitiveSlitherRooms.find(r => r.entryFeeUsd === fee)
        ?? competitiveSlitherRooms.find(r => r.entryFeeUsd === DEFAULT_COMPETITIVE_ENTRY_FEE);
}

function removeCompetitiveSpectator(room, socketId) {
    if (!room?.competitiveSpectators?.length) return;
    room.competitiveSpectators = room.competitiveSpectators.filter(s => s.id !== socketId);
}

function removeCompetitiveSpectatorsForUser(room, mongoId) {
    if (!room?.competitiveSpectators?.length || !mongoId) return;
    const key = mongoId.toString();
    room.competitiveSpectators = room.competitiveSpectators.filter(s => s.mongoId?.toString() !== key);
}

function findCompetitiveSlitherRoomById(roomId) {
    return competitiveSlitherRooms.find(r => r.id === roomId) ?? null;
}

// In-memory locks and maps for idempotency / processing
const processingCashouts = new Set(); // mongoId strings

/** USD balance used for HUD, leaderboard, and cashout (mass is stored on cells / snake.balance). */
function arenaCashoutUsd(player) {
    if (player?.mode === 'slither' || player?.mode === 'agar' || !player?.mode) {
        return player.dollarBalance ?? player.balance ?? 0;
    }
    return player?.balance ?? 0;
}
async function executeTournamentCashout(player, room) {
    const scoreUsd = Math.max(0, Number(arenaCashoutUsd(player)) || 0);
    const playerId = player.id;
    const mongoId = player.mongoId?.toString();
    const now = new Date();
    const tournament = await Tournament.findOneAndUpdate(
        {
            _id: room.tournamentId,
            status: 'live',
            endAt: { $gt: now },
            participants: { $elemMatch: { userId: player.mongoId } },
        },
        {
            $inc: { 'participants.$.tournamentBalanceUsd': scoreUsd },
            $set: { 'participants.$.lastCashoutAt': now },
        },
        { new: true },
    );
    if (!tournament) throw new Error('Tournament has ended; this run could not be cashed out');

    const participant = tournament.participants.find(p => p.userId.toString() === mongoId);
    room.players = room.players.filter(p => p !== player);
    if (!room.spectators) room.spectators = [];
    const head = player.segments?.[0];
    room.spectators = room.spectators.filter(s => s.id !== playerId);
    room.spectators.push({ id: playerId, x: head?.x ?? 0, y: head?.y ?? 0 });

    await Promise.all([
        User.findByIdAndUpdate(player.mongoId, { $inc: { playtime: Date.now() - player.startTime } }),
        Transaction.create({
            userId: player.mongoId,
            type: 'game',
            amount: scoreUsd,
            currency: 'USD',
            meta: {
                event: 'tournament_cashout',
                reason: 'Tournament Cashout',
                tournamentId: tournament._id.toString(),
                tournamentName: tournament.name,
                attempt: player.tournamentAttempt,
                amountUsd: scoreUsd,
                tournamentBalanceUsd: participant?.tournamentBalanceUsd || scoreUsd,
            },
            status: 'confirmed',
        }),
    ]);

    io.to(playerId).emit('cashOutSuccess', {
        amount: scoreUsd,
        signature: 'tournament_score_saved',
        tournament: true,
        tournamentId: tournament._id.toString(),
        tournamentBalanceUsd: participant?.tournamentBalanceUsd || scoreUsd,
        attemptsUsed: participant?.entries || 0,
    });
    return { scoreUsd, tournamentBalanceUsd: participant?.tournamentBalanceUsd || scoreUsd };
}


function reserveArenaCashout(room, player, requestedUsd) {
    const requested = Math.max(0, Number(requestedUsd) || 0);
    const funded = Math.max(0, Number(room.fundedEntryUsd) || 0);
    const reserved = Math.max(0, Number(room.reservedCashoutUsd) || 0);
    const paid = Math.max(0, Number(room.paidCashoutUsd) || 0);
    const available = Math.max(0, funded - reserved - paid);
    const amount = Math.min(requested, available);

    if (amount + 1e-9 < requested) {
        console.error(
            `ECONOMY INVARIANT: ${room.id} requested $${requested.toFixed(6)} cashout `
            + `with only $${available.toFixed(6)} of paid entries available; payout capped.`,
        );
    }
    if (amount <= 1e-9) throw new Error('No funded arena value available for cashout');

    room.reservedCashoutUsd = reserved + amount;
    player._arenaCashoutReservationUsd = amount;
    return amount;
}

function releaseArenaCashoutReservation(room, player) {
    const amount = Math.max(0, Number(player?._arenaCashoutReservationUsd) || 0);
    if (amount <= 0) return;
    room.reservedCashoutUsd = Math.max(0, (Number(room.reservedCashoutUsd) || 0) - amount);
    delete player._arenaCashoutReservationUsd;
}

function commitArenaCashoutReservation(room, player) {
    const amount = Math.max(0, Number(player?._arenaCashoutReservationUsd) || 0);
    if (amount <= 0) return;
    room.reservedCashoutUsd = Math.max(0, (Number(room.reservedCashoutUsd) || 0) - amount);
    room.paidCashoutUsd = (Number(room.paidCashoutUsd) || 0) + amount;
    delete player._arenaCashoutReservationUsd;
}

function keepCompetitiveCashoutSpectator(room, player) {
    const head = player.segments?.[0];
    if (!room.competitiveSpectators) room.competitiveSpectators = [];
    room.competitiveSpectators = room.competitiveSpectators.filter(s =>
        s.id !== player.id && s.mongoId?.toString() !== player.mongoId?.toString()
    );
    room.competitiveSpectators.push({
        id: player.id,
        mongoId: player.mongoId,
        x: head?.x ?? player.x ?? 0,
        y: head?.y ?? player.y ?? 0,
        dollarBalance: player.dollarBalance,
    });
}

let cachedSystemAccountRentLamports = null;
async function getSystemAccountRentLamports() {
    if (cachedSystemAccountRentLamports == null) {
        cachedSystemAccountRentLamports = await connection.getMinimumBalanceForRentExemption(0);
    }
    return cachedSystemAccountRentLamports;
}

async function canReceiveSystemTransfer(address, lamports) {
    if (!address || !(lamports > 0)) return false;
    const pubkey = new solanaWeb3.PublicKey(address);
    const [balance, rentMinimum] = await Promise.all([
        connection.getBalance(pubkey),
        getSystemAccountRentLamports(),
    ]);
    return balance + lamports >= rentMinimum;
}

async function executeCompetitiveCashout(player, room, reason = 'Arena Cashout') {
    const dollarBalance = Number(player.dollarBalance) || 0;
    const entryFeeUsd = room.entryFeeUsd ?? player.entryFeeUsd ?? DEFAULT_COMPETITIVE_ENTRY_FEE;
    const { cashoutPlayerPct, cashoutFeePct } = getCompetitiveEconomy(entryFeeUsd);
    const playerPayout = dollarBalance * cashoutPlayerPct;
    const platformFee = dollarBalance * cashoutFeePct;
    const mongoId = player.mongoId?.toString();
    const playerId = player.id;

    let user = await User.findById(mongoId);
    if (!user) throw new Error('Account not found');

    const logMeta = {
        reason,
        mode: 'competitive-slither',
        entryFeeUsd,
        dollarBalance,
        playerPayout,
        platformFee,
        cashoutFeePct,
        playerId: mongoId,
        timestamp: new Date().toISOString(),
    };

    if (DEV_FREE_PLAY) {
        room.players = room.players.filter(pl => pl.mongoId?.toString() !== mongoId);
        keepCompetitiveCashoutSpectator(room, player);
        user.playtime += (Date.now() - player.startTime);
        const payoutSol = playerPayout / SOL_PRICE_USD;
        user.balance = (user.balance || 0) + payoutSol;
        await user.save();
        await Transaction.create({
            userId: user._id,
            type: 'withdraw',
            amount: playerPayout,
            meta: { ...logMeta, simulated: true, signature: 'simulated' },
            status: 'confirmed',
        });
        io.to(playerId).emit('cashOutSuccess', { amount: playerPayout, signature: 'simulated' });
        return { playerPayout, platformFee, signature: 'simulated' };
    }

    user = await ensureUserDepositWallet(user);
    if (!user.depositAddress) throw new Error('No deposit address');

    const solPayout = playerPayout / SOL_PRICE_USD;
    const payoutLamports = Math.round(solPayout * solanaWeb3.LAMPORTS_PER_SOL);
    const feeLamports = Math.round((platformFee / SOL_PRICE_USD) * solanaWeb3.LAMPORTS_PER_SOL);

    if (!HOUSE_WALLET_ADDRESS || !HOUSE_WALLET_SECRET) throw new Error('House wallet not configured');
    const houseKeypair = solanaWeb3.Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(HOUSE_WALLET_SECRET, 'hex'))
    );
    const housePubKey = houseKeypair.publicKey;

    const totalLamports = await connection.getBalance(housePubKey);
    const feeBuffer = Math.round(0.005 * solanaWeb3.LAMPORTS_PER_SOL);
    // Cashout fees stay in the house wallet and are batched into the normal reset sweep.
    // Sending one tiny owner transfer per cashout wastes fees and can violate rent minimums.
    const canTransferOwnerFee = false;
    const transferredFeeLamports = 0;
    if (totalLamports < payoutLamports + transferredFeeLamports + feeBuffer) {
        throw new Error('House wallet lacks liquidity');
    }

    const userPubKey = new solanaWeb3.PublicKey(user.depositAddress);
    const userLamports = await connection.getBalance(userPubKey);
    const rentExemptMinimum = await getSystemAccountRentLamports();

    if (payoutLamports > 0 && (userLamports + payoutLamports < rentExemptMinimum)) {
        console.log(`[Rent Exemption] Payout too small for ${user.username}. Retaining $${playerPayout.toFixed(2)} for later claim.`);
        room.players = room.players.filter(pl => pl.mongoId?.toString() !== mongoId);
        keepCompetitiveCashoutSpectator(room, player);
        user.playtime += (Date.now() - player.startTime);
        user.rentFallbackBalanceUsd += playerPayout;
        await user.save();
        await addRewardFundingUsd(playerPayout);

        await Transaction.create({
            userId: user._id,
            type: 'withdraw',
            amount: playerPayout,
            meta: { ...logMeta, isRentExemptFallback: true, signature: 'sponsored_rent_fallback' },
            status: 'confirmed',
        });
        io.to(playerId).emit('cashOutSuccess', { amount: playerPayout, signature: 'sponsored_rent_fallback' });
        return { playerPayout, platformFee, signature: 'sponsored_rent_fallback' };
    }

    const transaction = new solanaWeb3.Transaction();
    transaction.add(
        solanaWeb3.SystemProgram.transfer({
            fromPubkey: housePubKey,
            toPubkey: new solanaWeb3.PublicKey(user.depositAddress),
            lamports: payoutLamports,
        })
    );
    if (canTransferOwnerFee) {
        transaction.add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: housePubKey,
                toPubkey: new solanaWeb3.PublicKey(OWNER_VAULT_ADDRESS),
                lamports: feeLamports,
            })
        );
    }

    const signature = await solanaWeb3.sendAndConfirmTransaction(connection, transaction, [houseKeypair]);

    room.players = room.players.filter(pl => pl.mongoId?.toString() !== mongoId);
    keepCompetitiveCashoutSpectator(room, player);
    user.playtime += (Date.now() - player.startTime);
    await user.save();

    await Transaction.create({
        userId: user._id,
        type: 'withdraw',
        amount: playerPayout,
        meta: {
            ...logMeta,
            signature,
            solAmount: solPayout,
            feeSolAmount: transferredFeeLamports / solanaWeb3.LAMPORTS_PER_SOL,
            feeDestination: canTransferOwnerFee ? OWNER_VAULT_ADDRESS : null,
            retainedPlatformFeeUsd: canTransferOwnerFee ? 0 : platformFee,
        },
        status: 'confirmed',
    });

    console.log(`💰 COMPETITIVE CASHOUT: $${playerPayout.toFixed(2)} to ${user.depositAddress}, fee $${platformFee.toFixed(2)}, sig ${signature}`);
    io.to(playerId).emit('cashOutSuccess', { amount: playerPayout, signature });
    return { playerPayout, platformFee, signature };
}

async function executeSurvivCashout(player, room, reason = 'Arena Cashout') {
    const dollarBalance = Number(player.dollarBalance) || 0;
    const entryFeeUsd = room.entryFeeUsd ?? player.entryFeeUsd ?? DEFAULT_SURVIV_ENTRY_FEE;
    const { cashoutPlayerPct, cashoutFeePct } = getSurvivEconomy(entryFeeUsd);
    const playerPayout = dollarBalance * cashoutPlayerPct;
    const platformFee = dollarBalance * cashoutFeePct;
    const mongoId = player.mongoId?.toString();
    const playerId = player.id;

    let user = await User.findById(mongoId);
    if (!user) throw new Error('Account not found');

    const logMeta = {
        reason,
        mode: 'surviv',
        entryFeeUsd,
        dollarBalance,
        playerPayout,
        platformFee,
        cashoutFeePct,
        playerId: mongoId,
        timestamp: new Date().toISOString(),
    };

    if (DEV_FREE_PLAY) {
        room.players = room.players.filter(pl => pl.mongoId?.toString() !== mongoId);
        user.playtime += (Date.now() - player.startTime);
        const payoutSol = playerPayout / SOL_PRICE_USD;
        user.balance = (user.balance || 0) + payoutSol;
        await user.save();
        await Transaction.create({
            userId: user._id,
            type: 'withdraw',
            amount: playerPayout,
            meta: { ...logMeta, simulated: true, signature: 'simulated' },
            status: 'confirmed',
        });
        io.to(playerId).emit('cashOutSuccess', { amount: playerPayout, signature: 'simulated' });
        return { playerPayout, platformFee, signature: 'simulated' };
    }

    user = await ensureUserDepositWallet(user);
    if (!user.depositAddress) throw new Error('No deposit address');

    const solPayout = playerPayout / SOL_PRICE_USD;
    const payoutLamports = Math.round(solPayout * solanaWeb3.LAMPORTS_PER_SOL);
    const feeLamports = Math.round((platformFee / SOL_PRICE_USD) * solanaWeb3.LAMPORTS_PER_SOL);

    if (!HOUSE_WALLET_ADDRESS || !HOUSE_WALLET_SECRET) throw new Error('House wallet not configured');
    const houseKeypair = solanaWeb3.Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(HOUSE_WALLET_SECRET, 'hex'))
    );
    const housePubKey = houseKeypair.publicKey;

    const totalLamports = await connection.getBalance(housePubKey);
    const feeBuffer = Math.round(0.005 * solanaWeb3.LAMPORTS_PER_SOL);
    // Cashout fees stay in the house wallet and are batched into the normal reset sweep.
    // Sending one tiny owner transfer per cashout wastes fees and can violate rent minimums.
    const canTransferOwnerFee = false;
    const transferredFeeLamports = 0;
    if (totalLamports < payoutLamports + transferredFeeLamports + feeBuffer) {
        throw new Error('House wallet lacks liquidity');
    }

    const userPubKey = new solanaWeb3.PublicKey(user.depositAddress);
    const userLamports = await connection.getBalance(userPubKey);
    const rentExemptMinimum = await getSystemAccountRentLamports();

    if (payoutLamports > 0 && (userLamports + payoutLamports < rentExemptMinimum)) {
        console.log(`[Rent Exemption] Payout too small for ${user.username}. Retaining $${playerPayout.toFixed(2)} for later claim.`);
        room.players = room.players.filter(pl => pl.mongoId?.toString() !== mongoId);
        user.playtime += (Date.now() - player.startTime);
        user.rentFallbackBalanceUsd += playerPayout;
        await user.save();
        await addRewardFundingUsd(playerPayout);

        await Transaction.create({
            userId: user._id,
            type: 'withdraw',
            amount: playerPayout,
            meta: { ...logMeta, isRentExemptFallback: true, signature: 'sponsored_rent_fallback' },
            status: 'confirmed',
        });
        io.to(playerId).emit('cashOutSuccess', { amount: playerPayout, signature: 'sponsored_rent_fallback' });
        return { playerPayout, platformFee, signature: 'sponsored_rent_fallback' };
    }

    const transaction = new solanaWeb3.Transaction();
    transaction.add(
        solanaWeb3.SystemProgram.transfer({
            fromPubkey: housePubKey,
            toPubkey: new solanaWeb3.PublicKey(user.depositAddress),
            lamports: payoutLamports,
        })
    );
    if (canTransferOwnerFee) {
        transaction.add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: housePubKey,
                toPubkey: new solanaWeb3.PublicKey(OWNER_VAULT_ADDRESS),
                lamports: feeLamports,
            })
        );
    }

    const signature = await solanaWeb3.sendAndConfirmTransaction(connection, transaction, [houseKeypair]);

    room.players = room.players.filter(pl => pl.mongoId?.toString() !== mongoId);
    user.playtime += (Date.now() - player.startTime);
    await user.save();

    await Transaction.create({
        userId: user._id,
        type: 'withdraw',
        amount: playerPayout,
        meta: {
            ...logMeta,
            signature,
            solAmount: solPayout,
            feeSolAmount: transferredFeeLamports / solanaWeb3.LAMPORTS_PER_SOL,
            feeDestination: canTransferOwnerFee ? OWNER_VAULT_ADDRESS : null,
            retainedPlatformFeeUsd: canTransferOwnerFee ? 0 : platformFee,
        },
        status: 'confirmed',
    });

    console.log(`💰 SURVIV CASHOUT: $${playerPayout.toFixed(2)} to ${user.depositAddress}, fee $${platformFee.toFixed(2)}, sig ${signature}`);
    io.to(playerId).emit('cashOutSuccess', { amount: playerPayout, signature });
    return { playerPayout, platformFee, signature };
}

async function executeArenaCashout(player, room, reason = 'Arena Cashout') {
    const requestedDollarBalance = arenaCashoutUsd(player);
    const dollarBalance = reserveArenaCashout(room, player, requestedDollarBalance);
    const entryFeeUsd = room.entryFeeUsd ?? player.entryFeeUsd ?? DEFAULT_ENTRY_FEE;
    const { cashoutPlayerPct, cashoutFeePct } = getEconomy(entryFeeUsd);
    const playerPayout = dollarBalance * cashoutPlayerPct;
    const platformFee = dollarBalance * cashoutFeePct;
    const mongoId = player.mongoId?.toString();
    const playerId = player.id;
    const gameMode = player.mode === 'slither' ? 'slither' : 'agar';

    let user = await User.findById(mongoId);
    if (!user) throw new Error('Account not found');

    const logMeta = {
        reason,
        mode: gameMode,
        entryFeeUsd,
        dollarBalance,
        playerPayout,
        platformFee,
        cashoutFeePct,
        playerId: mongoId,
        timestamp: new Date().toISOString(),
    };

    if (player.isFreeTicketPlay) {
        room.players = room.players.filter(pl => pl.mongoId?.toString() !== mongoId);
        user.playtime += (Date.now() - player.startTime);
        const creditedPayout = user.rewardsDisabled ? 0 : playerPayout;
        if (creditedPayout > 0) user.sponsoredRewardsBalance += creditedPayout;
        await user.save();

        await Transaction.create({
            userId: user._id,
            type: 'withdraw',
            amount: creditedPayout,
            meta: {
                ...logMeta,
                playerPayout: creditedPayout,
                isFreeTicketPlay: true,
                locked: creditedPayout > 0,
                rewardBlocked: !!user.rewardsDisabled,
                signature: user.rewardsDisabled ? 'sponsored_blocked' : 'sponsored_locked'
            },
            status: 'confirmed',
        });
        const signature = user.rewardsDisabled ? 'sponsored_blocked' : 'sponsored_locked';
        io.to(playerId).emit('cashOutSuccess', { amount: creditedPayout, signature });
        commitArenaCashoutReservation(room, player);
        return { playerPayout: creditedPayout, platformFee, signature };
    }

    if (DEV_FREE_PLAY) {
        room.players = room.players.filter(pl => pl.mongoId?.toString() !== mongoId);
        user.playtime += (Date.now() - player.startTime);
        const payoutSol = playerPayout / SOL_PRICE_USD;
        user.balance = (user.balance || 0) + payoutSol;
        await user.save();
        await Transaction.create({
            userId: user._id,
            type: 'withdraw',
            amount: playerPayout,
            meta: { ...logMeta, simulated: true, signature: 'simulated' },
            status: 'confirmed',
        });
        io.to(playerId).emit('cashOutSuccess', { amount: playerPayout, signature: 'simulated' });
        commitArenaCashoutReservation(room, player);
        return { playerPayout, platformFee, signature: 'simulated' };
    }

    user = await ensureUserDepositWallet(user);
    if (!user.depositAddress) throw new Error('No deposit address');

    const solPayout = playerPayout / SOL_PRICE_USD;
    const payoutLamports = Math.round(solPayout * solanaWeb3.LAMPORTS_PER_SOL);
    const feeLamports = Math.round((platformFee / SOL_PRICE_USD) * solanaWeb3.LAMPORTS_PER_SOL);

    if (!HOUSE_WALLET_ADDRESS || !HOUSE_WALLET_SECRET) throw new Error('House wallet not configured');
    const houseKeypair = solanaWeb3.Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(HOUSE_WALLET_SECRET, 'hex'))
    );
    const housePubKey = houseKeypair.publicKey;

    const totalLamports = await connection.getBalance(housePubKey);
    const feeBuffer = Math.round(0.00002 * solanaWeb3.LAMPORTS_PER_SOL);
    // Cashout fees remain in house and are sent in the batched reset sweep.
    const canTransferOwnerFee = false;
    if (totalLamports < payoutLamports + feeBuffer) {
        throw new Error('House wallet lacks liquidity');
    }

    const userPubKey = new solanaWeb3.PublicKey(user.depositAddress);
    const userLamports = await connection.getBalance(userPubKey);
    const rentExemptMinimum = await getSystemAccountRentLamports();

    if (payoutLamports > 0 && (userLamports + payoutLamports < rentExemptMinimum)) {
        console.log(`[Rent Exemption] Payout too small for ${user.username}. Retaining $${playerPayout.toFixed(2)} for later claim.`);
        room.players = room.players.filter(pl => pl.mongoId?.toString() !== mongoId);
        user.playtime += (Date.now() - player.startTime);
        user.rentFallbackBalanceUsd += playerPayout;
        await user.save();
        await addRewardFundingUsd(playerPayout);

        await Transaction.create({
            userId: user._id,
            type: 'withdraw',
            amount: playerPayout,
            meta: { ...logMeta, isRentExemptFallback: true, signature: 'sponsored_rent_fallback' },
            status: 'confirmed',
        });
        io.to(playerId).emit('cashOutSuccess', { amount: playerPayout, signature: 'sponsored_rent_fallback' });
        commitArenaCashoutReservation(room, player);
        return { playerPayout, platformFee, signature: 'sponsored_rent_fallback' };
    }

    const transaction = new solanaWeb3.Transaction();
    transaction.add(
        solanaWeb3.SystemProgram.transfer({
            fromPubkey: housePubKey,
            toPubkey: new solanaWeb3.PublicKey(user.depositAddress),
            lamports: payoutLamports,
        })
    );
    if (feeLamports > 0 && canTransferOwnerFee) {
        transaction.add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: housePubKey,
                toPubkey: new solanaWeb3.PublicKey(OWNER_VAULT_ADDRESS),
                lamports: feeLamports,
            })
        );
    }

    const signature = await solanaWeb3.sendAndConfirmTransaction(connection, transaction, [houseKeypair]);
    // The transfer is final even if a later DB/log write fails. Commit now so
    // this funded value can never be paid twice.
    commitArenaCashoutReservation(room, player);

    room.players = room.players.filter(pl => pl.mongoId?.toString() !== mongoId);
    user.playtime += (Date.now() - player.startTime);
    await user.save();

    await Transaction.create({
        userId: user._id,
        type: 'withdraw',
        amount: playerPayout,
        meta: {
            ...logMeta,
            signature,
            solAmount: solPayout,
            feeSolAmount: canTransferOwnerFee ? feeLamports / solanaWeb3.LAMPORTS_PER_SOL : 0,
            feeDestination: canTransferOwnerFee ? OWNER_VAULT_ADDRESS : null,
            retainedPlatformFeeUsd: canTransferOwnerFee ? 0 : platformFee,
        },
        status: 'confirmed',
    });

    console.log(`💰 ARENA CASHOUT: $${playerPayout.toFixed(2)} to ${user.depositAddress}, fee $${platformFee.toFixed(2)}, sig ${signature}`);
    io.to(playerId).emit('cashOutSuccess', { amount: playerPayout, signature });
    return { playerPayout, platformFee, signature };
}

async function cashOutCompetitiveRoomPlayers(room) {
    let allSettled = true;
    const playersToProcess = [...room.players];
    for (const p of playersToProcess) {
        // Competitive admin bots have no account and are cleared only after
        // every real player cashout has settled.
        if (p.isBot) continue;
        if (p.isCashingOut) {
            allSettled = false;
            continue;
        }
        const mongoId = p.mongoId?.toString();
        if (!acquireCashoutLock(mongoId)) {
            allSettled = false;
            continue;
        }
        try {
            await executeCompetitiveCashout(p, room, 'Auto Room Reset');
        } catch (err) {
            allSettled = false;
            console.error(`Competitive reset cashout failed for ${p.username}:`, err.message);
            await Transaction.create({
                type: 'game',
                amount: 0,
                meta: {
                    event: 'failure',
                    reason: 'competitive_auto_cashout_failed',
                    userId: mongoId,
                    error: err.message,
                },
            });
        } finally {
            releaseCashoutLock(mongoId);
        }
    }
    // Server-owned bots deliberately remain in room.players until the reset
    // reaches its entity-clearing phase. They must not keep the cashout phase
    // pending forever; only real players can have unsettled cashouts.
    return allSettled && room.players.every(p => p.isBot);
}

async function cashOutSurvivRoomPlayers(room) {
    const playersToProcess = [...room.players];
    let allSettled = true;
    for (const p of playersToProcess) {
        if (p.isCashingOut) {
            allSettled = false;
            continue;
        }
        const mongoId = p.mongoId?.toString();
        if (!acquireCashoutLock(mongoId)) {
            allSettled = false;
            continue;
        }
        try {
            await executeSurvivCashout(p, room, 'Auto Room Reset');
        } catch (err) {
            allSettled = false;
            console.error(`Surviv reset cashout failed for ${p.username}:`, err.message);
            await Transaction.create({
                type: 'game',
                amount: 0,
                meta: {
                    event: 'failure',
                    reason: 'surviv_auto_cashout_failed',
                    userId: mongoId,
                    error: err.message,
                },
            });
        } finally {
            releaseCashoutLock(mongoId);
        }
    }
    return allSettled && room.players.length === 0;
}

// --- RESET FLOW LOGIC ---
async function cashOutRoomPlayers(room) {
    let allSettled = true;
    const playersToProcess = [...room.players];
    for (const p of playersToProcess) {
        if (p.isCashingOut || !acquireCashoutLock(p.mongoId)) {
            allSettled = false;
            console.log(`⏭️ Reset skip cashout for ${p.username} (cashout in progress)`);
            continue;
        }
        try {
            const user = await User.findById(p.mongoId);
            if (!user) {
                allSettled = false;
                continue;
            }
            if (DEV_FREE_PLAY || (user.depositAddress && HOUSE_WALLET_SECRET)) {
                await executeArenaCashout(
                    p,
                    room,
                    DEV_FREE_PLAY ? 'Auto Room Reset (Free Play)' : 'Auto Room Reset to Account Address',
                );
            } else {
                allSettled = false;
                console.warn(`⚠️ Reset cashout skipped for ${p.username}: no depositAddress or house wallet`);
                await Transaction.create({
                    type: 'game',
                    amount: 0,
                    meta: { event: 'failure', reason: 'auto_cashout_no_wallet', userId: p.mongoId, balance: p.balance },
                });
            }
        } catch (err) {
            releaseArenaCashoutReservation(room, p);
            allSettled = false;
            await Transaction.create({
                type: 'game',
                amount: 0,
                meta: { event: 'failure', reason: 'auto_cashout_failed', userId: p.mongoId, error: err.message },
            });
        } finally {
            releaseCashoutLock(p.mongoId);
        }
    }
    return allSettled && room.players.length === 0;
}

function resetRoomEntities(room) {
    room.bots = [];
    room.slitherBots = [];
    room.food = [];
    room.slitherFood = [];
    room.viruses = [];
    room.ejected = [];
    room.qt.clear();
    addViruses(room, c.virusCount);
    room.aiBudgetBalance = 0;
    room.foodPoolBalance = 0;
    room.ownerBalance = 0;
    room.fundedEntryUsd = 0;
    room.reservedCashoutUsd = 0;
    room.paidCashoutUsd = 0;
}

async function sweepHouseWalletOnReset() {
    // Only the main arena house wallet — BR house wallets are separate env keys and never touched here.
    if (DEV_FREE_PLAY || !HOUSE_WALLET_ADDRESS || !HOUSE_WALLET_SECRET || !OWNER_VAULT_ADDRESS) return;

    const housePubKey = new solanaWeb3.PublicKey(HOUSE_WALLET_ADDRESS);
    const totalLamports = await connection.getBalance(housePubKey);
    const solPrice = Number(SOL_PRICE_USD || 64);
    const bufferLamports = Math.round((1.0 / solPrice) * solanaWeb3.LAMPORTS_PER_SOL);
    const totalSweepLamports = totalLamports - bufferLamports;

    if (totalSweepLamports <= 0) return;

    // Persisted contributions survive restarts. Fund the reward wallet for all
    // player liabilities, tracked owner surplus, and the permanent $0.50 buffer.
    const rewardState = await hydrateRewardPoolState();
    const pendingRewardUsd = Math.max(0, Number(rewardState.pendingHouseUsd) || 0);
    let rewardSweepLamports = 0;
    if (REWARD_WALLET_ADDRESS) {
        const pendingLamports = Math.round((pendingRewardUsd / solPrice) * solanaWeb3.LAMPORTS_PER_SOL);
        rewardSweepLamports = Math.min(totalSweepLamports, pendingLamports);
    }
    
    const reservedRewardSweepLamports = rewardSweepLamports;
    if (rewardSweepLamports > 0
        && !await canReceiveSystemTransfer(REWARD_WALLET_ADDRESS, rewardSweepLamports)) {
        console.log('Reward sweep deferred until it can satisfy the destination rent minimum.');
        rewardSweepLamports = 0;
    }

    let ownerSweepLamports = totalSweepLamports - reservedRewardSweepLamports;
    if (ownerSweepLamports > 0
        && !await canReceiveSystemTransfer(OWNER_VAULT_ADDRESS, ownerSweepLamports)) {
        console.log('Owner sweep deferred until it can satisfy the destination rent minimum.');
        ownerSweepLamports = 0;
    }
    if (ownerSweepLamports <= 0 && rewardSweepLamports <= 0) return;

    const houseKeypair = solanaWeb3.Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(HOUSE_WALLET_SECRET, 'hex'))
    );
    const sweepTx = new solanaWeb3.Transaction();
    
    if (rewardSweepLamports > 0) {
        sweepTx.add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: houseKeypair.publicKey,
                toPubkey: new solanaWeb3.PublicKey(REWARD_WALLET_ADDRESS),
                lamports: rewardSweepLamports,
            })
        );
    }
    
    if (ownerSweepLamports > 0) {
        sweepTx.add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: houseKeypair.publicKey,
                toPubkey: new solanaWeb3.PublicKey(OWNER_VAULT_ADDRESS),
                lamports: ownerSweepLamports,
            })
        );
    }

    const sig = await solanaWeb3.sendAndConfirmTransaction(connection, sweepTx, [houseKeypair]);

    if (rewardSweepLamports > 0) {
        const sweptUsd = (rewardSweepLamports / solanaWeb3.LAMPORTS_PER_SOL) * solPrice;
        await reducePendingRewardUsd(Math.min(pendingRewardUsd, sweptUsd), { swept: true });
        await Transaction.create({
            type: 'withdraw',
            amount: rewardSweepLamports / solanaWeb3.LAMPORTS_PER_SOL,
            currency: 'SOL',
            meta: {
                event: 'reward_pool_sweep',
                amountUsd: sweptUsd,
                signature: sig,
                reason: 'Room Reset Reward Sweep',
                solAmount: rewardSweepLamports / solanaWeb3.LAMPORTS_PER_SOL,
                from: HOUSE_WALLET_ADDRESS,
                destination: REWARD_WALLET_ADDRESS,
            },
        });
        console.log(`💸 Reward Sweep: ${rewardSweepLamports / solanaWeb3.LAMPORTS_PER_SOL} SOL sent to Reward Pool.`);
    }

    if (ownerSweepLamports > 0) {
        await Transaction.create({
            type: 'withdraw',
            amount: (ownerSweepLamports / solanaWeb3.LAMPORTS_PER_SOL) * solPrice,
            currency: 'SOL',
            meta: {
                event: 'pool_sweep',
                signature: sig,
                reason: 'Room Reset Wallet Sweep',
                solAmount: ownerSweepLamports / solanaWeb3.LAMPORTS_PER_SOL,
                from: HOUSE_WALLET_ADDRESS,
                destination: OWNER_VAULT_ADDRESS,
            },
        });
        console.log(`💸 Wallet Sweep: ${ownerSweepLamports / solanaWeb3.LAMPORTS_PER_SOL} SOL sent to owner.`);
    }
}

async function performGlobalArenaReset() {
    if (globalArenaResetting) return { success: false, alreadyRunning: true };
    globalArenaResetting = true;
    for (const room of rooms) room.isResetting = true;
    for (const room of competitiveSlitherRooms) room.isResetting = true;
    for (const room of survivRooms) room.isResetting = true;

    console.log('🚨 GLOBAL ARENA RESET STARTED (all stake tiers — BR matches unaffected)');
    await Transaction.create({
        type: 'game',
        amount: 0,
        meta: { event: 'reset_start', roomId: 'all', tiers: ALLOWED_ENTRY_FEES },
        status: 'confirmed',
    });

    try {
        let allCashoutsSettled = true;
        for (const room of rooms) {
            const settled = await cashOutRoomPlayers(room);
            allCashoutsSettled = settled && allCashoutsSettled;
        }
        for (const room of competitiveSlitherRooms) {
            const settled = await cashOutCompetitiveRoomPlayers(room);
            allCashoutsSettled = settled && allCashoutsSettled;
        }
        for (const room of survivRooms) {
            const settled = await cashOutSurvivRoomPlayers(room);
            allCashoutsSettled = settled && allCashoutsSettled;
        }

        if (!allCashoutsSettled) {
            console.error('Arena reset deferred: every player cashout must settle before any wallet sweep.');
            await Transaction.create({
                type: 'game',
                amount: 0,
                meta: { event: 'reset_deferred', reason: 'unsettled_cashouts' },
                status: 'confirmed',
            });
            GLOBAL_ARENA_START = Date.now() - c.roomDuration + 30_000;
            for (const room of [...rooms, ...competitiveSlitherRooms, ...survivRooms]) {
                room.startTime = GLOBAL_ARENA_START;
            }
            return { success: false, deferred: true, reason: 'unsettled_cashouts' };
        }

        try {
            await sweepHouseWalletOnReset();
        } catch (sweepErr) {
            console.error('Sweep Error:', sweepErr.message);
            await Transaction.create({
                type: 'game',
                amount: 0,
                meta: { event: 'failure', reason: 'pool_sweep_failed', error: sweepErr.message },
            });
            GLOBAL_ARENA_START = Date.now() - c.roomDuration + 30_000;
            for (const room of [...rooms, ...competitiveSlitherRooms, ...survivRooms]) {
                room.startTime = GLOBAL_ARENA_START;
            }
            return { success: false, deferred: true, reason: 'pool_sweep_failed' };
        }

        for (const room of rooms) {
            resetRoomEntities(room);
        }
        for (const room of competitiveSlitherRooms) {
            room.players = [];
            room.slitherFood = [];
            room.competitiveSpectators = [];
        }
        for (const room of survivRooms) {
            resetSurvivRoomRuntime(room);
        }

        GLOBAL_ARENA_START = Date.now();
        for (const room of rooms) {
            room.startTime = GLOBAL_ARENA_START;
        }
        for (const room of competitiveSlitherRooms) {
            room.startTime = GLOBAL_ARENA_START;
        }
        for (const room of survivRooms) {
            room.startTime = GLOBAL_ARENA_START;
        }

        console.log('✅ GLOBAL ARENA RESET COMPLETE');
        await Transaction.create({
            type: 'game',
            amount: 0,
            meta: { event: 'reset_complete', roomId: 'all', tiers: ALLOWED_ENTRY_FEES },
            status: 'confirmed',
        });
        return { success: true };
    } finally {
        for (const room of rooms) room.isResetting = false;
        for (const room of competitiveSlitherRooms) room.isResetting = false;
        for (const room of survivRooms) room.isResetting = false;
        globalArenaResetting = false;
    }
}

async function performRoomReset(_room) {
    await performGlobalArenaReset();
}

// In-memory lock for scanDeposits to prevent concurrent runs
let isScanningDeposits = false;
let globalPlayerEarningsSol = 0;
let globalPlayerEarningsUsd = 0;

function getTransactionAccountKeys(txDetails) {
    const message = txDetails?.transaction?.message;
    const staticKeys = message?.staticAccountKeys || message?.accountKeys || [];
    const loaded = txDetails?.meta?.loadedAddresses;
    return [
        ...staticKeys,
        ...(loaded?.writable || []),
        ...(loaded?.readonly || []),
    ];
}

function extractNativeDeposit(txDetails, destinationAddress) {
    if (!txDetails || txDetails.meta?.err) return null;
    const keys = getTransactionAccountKeys(txDetails);
    const destinationIndex = keys.findIndex(key => key.toString() === destinationAddress);
    if (destinationIndex < 0) return null;
    const creditedLamports = (txDetails.meta.postBalances[destinationIndex] || 0) - (txDetails.meta.preBalances[destinationIndex] || 0);
    if (creditedLamports <= 0) return null;

    let sourceIndex = -1;
    let largestDebit = 0;
    for (let index = 0; index < keys.length; index += 1) {
        if (index === destinationIndex) continue;
        const debit = (txDetails.meta.preBalances[index] || 0) - (txDetails.meta.postBalances[index] || 0);
        if (debit > largestDebit) {
            largestDebit = debit;
            sourceIndex = index;
        }
    }
    if (sourceIndex < 0) return null;
    return {
        sourceWallet: keys[sourceIndex].toString(),
        creditedLamports,
    };
}

function isPlatformAccountCredit(sourceWallet) {
    if (!sourceWallet) return false;
    const platformPayoutWallets = new Set([
        HOUSE_WALLET_ADDRESS,
        REWARD_WALLET_ADDRESS,
        TOURNAMENT_WALLET_ADDRESS,
        ...listBRHouseWallets().map(wallet => wallet.address),
    ].filter(Boolean));
    return platformPayoutWallets.has(sourceWallet);
}

async function logPersonalAccountDeposit({
    signature,
    userId,
    sourceWallet,
    destinationWallet,
    amountLamports,
}) {
    if (!signature || !userId || !sourceWallet || !destinationWallet || !(amountLamports > 0)) return null;
    // Platform payouts have their own game/reward transaction rows. Logging them
    // again as deposits would make account history misleading.
    if (isPlatformAccountCredit(sourceWallet)) return null;

    const solAmount = amountLamports / solanaWeb3.LAMPORTS_PER_SOL;
    return Transaction.findOneAndUpdate(
        { userId, type: 'deposit', 'meta.signature': signature },
        {
            $setOnInsert: {
                userId,
                type: 'deposit',
                amount: solAmount,
                currency: 'SOL',
                meta: {
                    event: 'account_deposit',
                    signature,
                    solAmount,
                    amountUsd: solAmount * SOL_PRICE_USD,
                    detectedOnChain: true,
                    sourceWallet,
                    destinationWallet,
                },
                status: 'confirmed',
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

// Helper: get balance with automatic fallback to public RPC on rate-limit
async function getBalanceWithFallback(pubKey) {
    try {
        return await connection.getBalance(pubKey);
    } catch (e) {
        if (e.message && (e.message.includes('429') || e.message.includes('Too Many Requests') || e.message.includes('rate'))) {
            const fallback = new solanaWeb3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
            return await fallback.getBalance(pubKey);
        }
        throw e;
    }
}

// Helper: get signatures with fallback
async function getSignaturesWithFallback(pubKey, opts) {
    try {
        return await connection.getSignaturesForAddress(pubKey, opts);
    } catch (e) {
        if (e.message && (e.message.includes('429') || e.message.includes('Too Many Requests') || e.message.includes('rate'))) {
            const fallback = new solanaWeb3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
            return await fallback.getSignaturesForAddress(pubKey, opts);
        }
        throw e;
    }
}

// Helper: get transaction details with fallback
async function getTransactionWithFallback(signature) {
    try {
        return await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    } catch (e) {
        if (e.message && (e.message.includes('429') || e.message.includes('Too Many Requests') || e.message.includes('rate'))) {
            const fallback = new solanaWeb3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
            return await fallback.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
        }
        throw e;
    }
}

async function captureRecentDepositSources(user, pubKey) {
    const signatures = await getSignaturesWithFallback(pubKey, { limit: 50 });
    const previousCursor = user.lastDepositSourceSignature;
    const unseen = [];
    for (const info of signatures) {
        if (info.signature === previousCursor) break;
        unseen.push(info);
    }

    // Existing accounts get one bounded backfill so manual/address-copy deposits
    // made before this fix also appear in history.
    const signaturesToInspect = user.depositHistoryBackfilledAt ? unseen : signatures;
    for (const info of signaturesToInspect.slice().reverse()) {
        if (info.err) continue;
        const txDetails = await getTransactionWithFallback(info.signature);
        const deposit = extractNativeDeposit(txDetails, user.depositAddress);
        if (!deposit) continue;
        await logPersonalAccountDeposit({
            signature: info.signature,
            userId: user._id,
            sourceWallet: deposit.sourceWallet,
            destinationWallet: user.depositAddress,
            amountLamports: deposit.creditedLamports,
        });
        await recordDepositSource({
            signature: info.signature,
            userId: user._id,
            sourceWallet: deposit.sourceWallet,
            destinationWallet: user.depositAddress,
            amountLamports: deposit.creditedLamports,
        });
    }

    const newestSignature = signatures[0]?.signature;
    const scanState = {
        depositHistoryBackfilledAt: user.depositHistoryBackfilledAt || new Date(),
    };
    if (newestSignature) {
        scanState.lastDepositSourceSignature = newestSignature;
    }
    await User.updateOne({ _id: user._id }, { $set: scanState });
}
// --- NYTT: AUTOMATISK INSÄTTNINGS-SCANNER ---
async function scanDeposits() {
    if (isScanningDeposits) return;
    isScanningDeposits = true;
    try {
        // Hitta alla användare som har en insättningsadress
        const users = await User.find({ depositAddress: { $exists: true } });

        for (const user of users) {
            if (!user.depositAddress) continue;
            try {
                const pubKey = new solanaWeb3.PublicKey(user.depositAddress);
                const lamports = await getBalanceWithFallback(pubKey);
                const solOnChain = lamports / solanaWeb3.LAMPORTS_PER_SOL;

                // Scan by signature cursor even if the funds were already spent between scans.
                await captureRecentDepositSources(user, pubKey);
                if (Math.abs(user.balance - solOnChain) > 0.00001) {
                    user.balance = solOnChain;
                    await user.save();
                    console.log(`[scanDeposits] Updated ${user.username}: ${solOnChain.toFixed(6)} SOL`);
                }
            } catch (e) { console.error(`Sync error for ${user.username}:`, e.message); }
        }
    } catch (err) {
        console.error("Scanner Error:", err.message);
    } finally {
        isScanningDeposits = false;
    }
}

// Starta scannern var 5:e sekund
setInterval(async () => {
    if (!isScanningDeposits) await scanDeposits();
}, 5000);

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
        methods: ['GET', 'POST'],
        credentials: true,
    },
    transports: ['polling', 'websocket'],
    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 45000,
});

app.use(passport.initialize());

const sensitiveRequestBuckets = new Map();
function sensitiveRateLimit({ limit, windowMs }) {
    return (req, res, next) => {
        const key = `${req.ip || req.socket?.remoteAddress || 'unknown'}:${req.path}`;
        const now = Date.now();
        const current = sensitiveRequestBuckets.get(key);
        if (!current || current.resetAt <= now) {
            sensitiveRequestBuckets.set(key, { count: 1, resetAt: now + windowMs });
            return next();
        }
        if (current.count >= limit) {
            res.setHeader('Retry-After', Math.ceil((current.resetAt - now) / 1000));
            return res.status(429).json({ error: 'Too many requests. Try again later.' });
        }
        current.count += 1;
        return next();
    };
}
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of sensitiveRequestBuckets) if (value.resetAt <= now) sensitiveRequestBuckets.delete(key);
}, 10 * 60_000).unref();
// --- GOOGLE OAUTH KONFIGURATION ---
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || "DIN_GOOGLE_CLIENT_ID",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "DIN_GOOGLE_CLIENT_SECRET",
    callbackURL: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/auth/google/callback`
},
    async (accessToken, refreshToken, profile, done) => {
        try {
            const profileEmail = profile.emails && profile.emails.length > 0 ? profile.emails[0].value : null;
            let user = await User.findOne({ $or: [{ googleId: profile.id }, { email: profileEmail }].filter(q => q.email || q.googleId) });

            if (!user) {
                // Skapa ny användare om den inte finns
                const keypair = solanaWeb3.Keypair.generate();
                user = new User({
                    googleId: profile.id,
                    username: (profile.displayName || 'Gladiator').replace(/\s+/g, '').toLowerCase() + Math.floor(Math.random() * 1000),
                    email: profileEmail,
                    password: await bcrypt.hash(Math.random().toString(36), 10), // Random lösenord för Google-användare
                    depositAddress: keypair.publicKey.toBase58(),
                    depositSecret: Buffer.from(keypair.secretKey).toString('hex') // Spara secret (bör krypteras i produktion)
                });
                await user.save();
            } else if (!user.depositAddress || !user.depositSecret) {
                await ensureUserDepositWallet(user);
            }
            return done(null, user);
        } catch (err) {
            return done(err, null);
        }
    }
));

// Google Auth Routes
app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/api/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login' }),
    (req, res) => {
        const secret = JWT_SECRET;
        const token = jwt.sign({ id: req.user._id }, secret, { expiresIn: '24h' });
        // Skicka tillbaka användaren till frontenden med token i URL:en
        const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
        res.redirect(`${frontendUrl}/?token=${token}`);
    }
);

// Lightweight health check — always returns CORS headers (used by frontend + uptime monitors)
app.get('/api/health', (req, res) => {
    applyCorsHeaders(req, res);
    res.json({ ok: true, ts: Date.now() });
});

// Hälso-check för att se om servern är vaken
app.get('/', (req, res) => {
    console.log("Health check requested at " + new Date().toISOString());
    res.send('<html><body style="font-family:sans-serif;background:#0a0a0c;color:white;text-align:center;padding-top:100px;"><h1>AgarStake Engine v2.0 🎮</h1><p style="color:#007AFF;font-size:1.5rem;">Status: Pro Physics Enabled (v11)</p><p>Full Agar.io clone logic integrated.</p><p style="color:#00ff7f;">Ready for redeploy on Railway.</p></body></html>');
});

const authenticateToken = (req, res, next) => {
    applyCorsHeaders(req, res);
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided' });

    const jwtSecret = JWT_SECRET;

    jwt.verify(token, jwtSecret, (err, user) => {
        if (err) {
            const expired = err.name === 'TokenExpiredError';
            return res.status(403).json({
                message: expired ? 'Session expired — please log in again' : 'Invalid token',
                expired,
            });
        }
        req.user = user;
        next();
    });
};

async function ensureUserDepositWallet(user) {
    if (user.depositAddress && user.depositSecret) return user;
    const keypair = solanaWeb3.Keypair.generate();
    user.depositAddress = keypair.publicKey.toBase58();
    user.depositSecret = Buffer.from(keypair.secretKey).toString('hex');
    await user.save();
    console.log(`🔑 Created deposit wallet for ${user.username}`);
    return user;
}

app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        let user = await User.findById(req.user.id).select('-password');
        if (!user) return res.status(404).json({ message: "Användare hittades ej" });
        user = await ensureUserDepositWallet(user);

        let solOnChain = 0;
        if (user.depositAddress && !DEV_FREE_PLAY) {
            try {
                const pubKey = new solanaWeb3.PublicKey(user.depositAddress);
                const lamports = await connection.getBalance(pubKey);
                solOnChain = lamports / solanaWeb3.LAMPORTS_PER_SOL;

                await captureRecentDepositSources(user, pubKey);
                if (Math.abs(user.balance - solOnChain) > 0.00001) {
                    user.balance = solOnChain;
                    await user.save();
                }
            } catch (e) {
                // If Helius is rate-limiting, fall back to the public Solana RPC
                if (e.message && (e.message.includes('429') || e.message.includes('Too Many Requests'))) {
                    try {
                        const fallbackConn = new solanaWeb3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
                        const pubKey = new solanaWeb3.PublicKey(user.depositAddress);
                        const lamports = await fallbackConn.getBalance(pubKey);
                        solOnChain = lamports / solanaWeb3.LAMPORTS_PER_SOL;
                        if (Math.abs(user.balance - solOnChain) > 0.00001) {
                            user.balance = solOnChain;
                            await user.save();
                        }
                    } catch (fallbackErr) {
                        console.error('Sync error in /api/me (fallback):', fallbackErr.message);
                        solOnChain = user.balance || 0;
                    }
                } else {
                    console.error('Sync error in /api/me:', e.message);
                    solOnChain = user.balance || 0;
                }
            }
        } else if (DEV_FREE_PLAY) {
            solOnChain = user.balance || 0;
        }

        const userObj = user.toObject();
        delete userObj.depositSecret;
        // Lägg till onChainBalance för frontend att visa, men ändra INTE DB-balansen här
        userObj.onChainBalance = solOnChain;

        // Map the internal raw SOL balance to what the frontend expects
        userObj.balanceSol = user.balance;
        userObj.balanceUsd = user.balance * SOL_PRICE_USD;
        userObj.solPrice = SOL_PRICE_USD;
        userObj.freePlay = DEV_FREE_PLAY;
        userObj.isAdmin = !!(process.env.ADMIN_USERNAME && user.username === process.env.ADMIN_USERNAME);

        res.json(userObj);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/update-profile', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const { username, walletAddress } = req.body;
        let changed = false;

        if (username !== undefined && username !== user.username) {
            const trimmed = String(username).trim();
            if (trimmed.length < 3 || trimmed.length > 20) {
                return res.status(400).json({ message: 'Username must be 3–20 characters' });
            }
            if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
                return res.status(400).json({ message: 'Username can only contain letters, numbers, and underscores' });
            }
            const taken = await User.findOne({ username: trimmed, _id: { $ne: user._id } });
            if (taken) return res.status(400).json({ message: 'Username already taken' });
            user.username = trimmed;
            changed = true;
        }

        if (walletAddress !== undefined && walletAddress !== (user.walletAddress || '')) {
            const trimmed = String(walletAddress).trim();
            if (trimmed && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
                return res.status(400).json({ message: 'Invalid Solana wallet address' });
            }
            user.walletAddress = trimmed || undefined;
            changed = true;
        }

        if (!changed) {
            return res.status(400).json({ message: 'No changes to save' });
        }

        await user.save();

        const userObj = user.toObject();
        delete userObj.password;
        delete userObj.depositSecret;
        userObj.balanceSol = user.balance;
        userObj.balanceUsd = user.balance * SOL_PRICE_USD;
        userObj.solPrice = SOL_PRICE_USD;
        userObj.freePlay = DEV_FREE_PLAY;

        res.json({ user: userObj });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ message: 'Username already taken' });
        }
        res.status(500).json({ message: err.message });
    }
});

// --- ADMIN MIDDLEWARE ---
const authenticateAdmin = (req, res, next) => {
    authenticateToken(req, res, async () => {
        try {
            const user = await User.findById(req.user.id);
            // Replace with your actual owner/admin identification logic
            if (user && user.username === process.env.ADMIN_USERNAME) {
                next();
            } else {
                res.status(403).json({ message: "Admin access required" });
            }
        } catch (err) { res.sendStatus(500); }
    });
};
function optionalAuthenticatedUserId(req) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return null;
    try {
        return jwt.verify(token, JWT_SECRET)?.id || null;
    } catch {
        return null;
    }
}

async function activateTournament(tournamentId, { forceNow = false } = {}) {
    const now = new Date();
    const update = {
        $set: {
            status: 'live',
            startedAt: now,
            roomId: `tournament-${tournamentId}`,
            ...(forceNow ? {
                startAt: now,
                endAt: new Date(now.getTime() + TOURNAMENT_DURATION_MS),
            } : {}),
        },
    };
    const tournament = await Tournament.findOneAndUpdate(
        { _id: tournamentId, status: 'scheduled' },
        update,
        { new: true },
    );
    if (!tournament) return Tournament.findById(tournamentId);
    createTournamentArenaRoom(tournament);
    console.log(`[Tournament] ${tournament.name} is live until ${tournament.endAt.toISOString()}`);
    return tournament;
}

async function settleTournament(tournamentId) {
    let tournament = await Tournament.findOneAndUpdate(
        { _id: tournamentId, status: 'live' },
        { $set: { status: 'settling' } },
        { new: true },
    );
    if (!tournament) tournament = await Tournament.findOne({ _id: tournamentId, status: 'settling' });
    if (!tournament) return null;

    const room = getTournamentRoom(tournament._id);
    if (room) {
        for (const player of room.players) {
            if (!player.isBot && player.id) {
                io.to(player.id).emit('tournamentEnded', {
                    tournamentId: tournament._id.toString(),
                    name: tournament.name,
                });
            }
        }
        room.players = [];
        room.bots = [];
        room.slitherBots = [];
        room.slitherFood = [];
        room.spectators = [];
        room.isResetting = true;
        tournamentRooms.delete(tournament._id.toString());
    }

    const ranked = [...tournament.participants].sort((a, b) => {
        const diff = (b.tournamentBalanceUsd || 0) - (a.tournamentBalanceUsd || 0);
        if (Math.abs(diff) > 1e-9) return diff;
        const aTime = a.lastCashoutAt ? a.lastCashoutAt.getTime() : Number.MAX_SAFE_INTEGER;
        const bTime = b.lastCashoutAt ? b.lastCashoutAt.getTime() : Number.MAX_SAFE_INTEGER;
        if (aTime !== bTime) return aTime - bTime;
        return a.username.localeCompare(b.username);
    });
    const prizes = calculateTournamentPrizes(
        ranked,
        tournament.totalEntryFeesUsd,
        tournament.totalCollectedLamports,
    );
    const prizesByUser = new Map(prizes.map(prize => [prize.userId.toString(), prize]));

    for (let index = 0; index < ranked.length; index++) {
        const participant = ranked[index];
        const prize = prizesByUser.get(participant.userId.toString());
        participant.placement = index + 1;
        participant.winningsUsd = prize?.winningsUsd || 0;
        participant.winningsLamports = prize?.winningsLamports || 0;

        if (!prize || prize.winningsLamports <= 0) continue;
        const creditId = `tournament:${tournament._id}:${participant.userId}`;
        await User.updateOne(
            { _id: participant.userId, tournamentRewardCreditIds: { $ne: creditId } },
            {
                $inc: {
                    tournamentRewardsBalance: prize.winningsUsd,
                    tournamentRewardsLamports: prize.winningsLamports,
                },
                $addToSet: { tournamentRewardCreditIds: creditId },
            },
        );
        participant.rewardCredited = true;

        await Transaction.findOneAndUpdate(
            { 'meta.event': 'tournament_reward', 'meta.creditId': creditId },
            {
                $setOnInsert: {
                    userId: participant.userId,
                    type: 'game',
                    amount: prize.winningsUsd,
                    currency: 'USD',
                    meta: {
                        event: 'tournament_reward',
                        reason: 'Tournament Prize',
                        tournamentId: tournament._id.toString(),
                        tournamentName: tournament.name,
                        placement: prize.placement,
                        amountUsd: prize.winningsUsd,
                        lamports: prize.winningsLamports,
                        creditId,
                    },
                    status: 'confirmed',
                },
            },
            { upsert: true, new: true },
        );
    }

    tournament.participants = ranked;
    tournament.status = 'ended';
    tournament.endedAt = new Date();
    tournament.displayUntil = new Date(Date.now() + TOURNAMENT_ENDED_VISIBLE_MS);
    await tournament.save();
    console.log(`[Tournament] ${tournament.name} settled with $${tournament.totalEntryFeesUsd.toFixed(2)} prize pot.`);
    return tournament;
}

async function advanceTournamentLifecycle() {
    if (mongoose.connection.readyState !== 1) return;
    const now = new Date();
    const scheduled = await Tournament.find({ status: 'scheduled', startAt: { $lte: now } }).select('_id').limit(20);
    for (const tournament of scheduled) await activateTournament(tournament._id);

    const ended = await Tournament.find({ status: 'live', endAt: { $lte: now } }).select('_id').limit(20);
    for (const tournament of ended) await settleTournament(tournament._id);

    const interrupted = await Tournament.find({ status: 'settling' }).select('_id').limit(20);
    for (const tournament of interrupted) await settleTournament(tournament._id);
}

setInterval(() => {
    advanceTournamentLifecycle().catch(err => console.error('Tournament lifecycle error:', err));
}, 5_000);

app.get('/api/tournaments', async (req, res) => {
    try {
        await advanceTournamentLifecycle();
        const userId = optionalAuthenticatedUserId(req);
        const now = new Date();
        const tournaments = await Tournament.find({
            $or: [
                { status: { $in: ['scheduled', 'live'] } },
                { status: 'ended', displayUntil: { $gt: now } },
            ],
        }).sort({ status: 1, startAt: 1 }).lean();
        res.json({ tournaments: tournaments.map(t => serializeTournament(t, userId)), serverTime: now });
    } catch (err) {
        console.error('Tournament list error:', err);
        res.status(500).json({ error: 'Unable to load tournaments' });
    }
});

app.get('/api/tournaments/:tournamentId', async (req, res) => {
    try {
        await advanceTournamentLifecycle();
        const tournament = await Tournament.findById(req.params.tournamentId).lean();
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
        res.json({ tournament: serializeTournament(tournament, optionalAuthenticatedUserId(req)), serverTime: new Date() });
    } catch (err) {
        if (err.name === 'CastError') return res.status(404).json({ error: 'Tournament not found' });
        res.status(500).json({ error: 'Unable to load tournament' });
    }
});

app.get('/api/admin/tournaments', authenticateAdmin, async (req, res) => {
    await advanceTournamentLifecycle();
    const tournaments = await Tournament.find().sort({ startAt: -1 }).limit(100).lean();
    res.json({ tournaments: tournaments.map(t => serializeTournament(t)) });
});

app.post('/api/admin/tournaments', authenticateAdmin, async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        const startAt = new Date(req.body?.startAt);
        if (name.length < 3 || name.length > 60) return res.status(400).json({ error: 'Name must be 3-60 characters' });
        if (Number.isNaN(startAt.getTime())) return res.status(400).json({ error: 'Choose a valid start time' });
        if (startAt.getTime() < Date.now() - 5_000) return res.status(400).json({ error: 'Start time must be in the future' });

        const tournament = await Tournament.create({
            name,
            startAt,
            endAt: new Date(startAt.getTime() + TOURNAMENT_DURATION_MS),
            createdBy: req.user.id,
        });
        res.status(201).json({ tournament: serializeTournament(tournament, req.user.id) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Unable to schedule tournament' });
    }
});

app.post('/api/admin/tournaments/:tournamentId/start', authenticateAdmin, async (req, res) => {
    try {
        const tournament = await activateTournament(req.params.tournamentId, { forceNow: true });
        if (!tournament || tournament.status !== 'live') return res.status(409).json({ error: 'Only scheduled tournaments can be started' });
        res.json({ tournament: serializeTournament(tournament) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Unable to start tournament' });
    }
});

app.post('/api/admin/tournaments/:tournamentId/cancel', authenticateAdmin, async (req, res) => {
    try {
        const tournament = await Tournament.findOneAndUpdate(
            { _id: req.params.tournamentId, status: 'scheduled' },
            { $set: { status: 'cancelled' } },
            { new: true },
        );
        if (!tournament) return res.status(409).json({ error: 'Only scheduled tournaments can be cancelled' });
        res.json({ tournament: serializeTournament(tournament) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Unable to cancel tournament' });
    }
});


// Public config (no auth) — frontend uses this for test-mode UI
app.get('/api/config', (req, res) => {
    res.json({
        freePlay: DEV_FREE_PLAY,
        entryFeeUsd: DEV_FREE_PLAY ? 0 : DEFAULT_ENTRY_FEE,
        entryFees: DEV_FREE_PLAY ? [0] : ALLOWED_ENTRY_FEES,
        defaultEntryFee: DEFAULT_ENTRY_FEE,
        brEntryFees: DEV_FREE_PLAY ? [0] : BR.entryFees,
        brDefaultEntryFee: BR.defaultEntryFee,
        brMinPlayers: BR.minPlayers,
        brMaxPlayers: BR.maxPlayers,
        competitiveEntryFees: DEV_FREE_PLAY ? [0] : COMPETITIVE_SLITHER_ENTRY_FEES,
        competitiveDefaultEntryFee: DEFAULT_COMPETITIVE_ENTRY_FEE,
    });
});

app.get('/api/health', (req, res) => {
    res.json({ ok: true, freePlay: DEV_FREE_PLAY, uptime: process.uptime() });
});

// --- NYTT: Endpoint för att kolla om användaren är i ett game ---
app.get('/api/game-status', authenticateToken, (req, res) => {
    try {
        const arenaResetting = globalArenaResetting || rooms.some(r => r.isResetting)
            || competitiveSlitherRooms.some(r => r.isResetting)
            || survivRooms.some(r => r.isResetting);
        for (const room of rooms) {
            const player = room.players.find(
                p => p.mongoId && p.mongoId.toString() === req.user.id
            );
            if (player) {
                return res.json({
                    inGame: true,
                    mode: player.mode || 'agar',
                    balance: (player.mode === 'slither' || player.mode === 'agar' || !player.mode)
                        ? (player.dollarBalance ?? player.balance ?? null)
                        : (player.balance ?? null),
                    entryFeeUsd: player.entryFeeUsd ?? room.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
                    disconnected: player.disconnected ?? false,
                    isResetting: arenaResetting,
                    battleRoyale: !!player.isBattleRoyale,
                });
            }
        }
        for (const room of competitiveSlitherRooms) {
            const player = room.players.find(
                p => p.mongoId && p.mongoId.toString() === req.user.id
            );
            if (player) {
                return res.json({
                    inGame: true,
                    mode: 'competitive-slither',
                    balance: player.dollarBalance ?? null,
                    entryFeeUsd: player.entryFeeUsd ?? room.entryFeeUsd ?? DEFAULT_COMPETITIVE_ENTRY_FEE,
                    disconnected: player.disconnected ?? false,
                    isResetting: arenaResetting,
                    battleRoyale: false,
                    competitiveSlither: true,
                });
            }
        }
        for (const room of survivRooms) {
            const player = room.players.find(
                p => p.mongoId && p.mongoId.toString() === req.user.id
            );
            if (player) {
                return res.json({
                    inGame: true,
                    mode: 'surviv',
                    balance: player.dollarBalance ?? null,
                    entryFeeUsd: player.entryFeeUsd ?? room.entryFeeUsd ?? DEFAULT_SURVIV_ENTRY_FEE,
                    disconnected: player.disconnected ?? false,
                    isResetting: arenaResetting,
                    battleRoyale: false,
                    surviv: true,
                });
            }
        }
        const brRoom = getBRMatchForMongo(req.user.id);
        if (brRoom) {
            const brPlayer = brRoom.players.find(p => p.mongoId?.toString() === req.user.id);
            if (brPlayer) {
                return res.json({
                    inGame: true,
                    mode: brRoom.variant === 'slither' ? 'br-slither' : 'br-agar',
                    balance: brPlayer.balance ?? null,
                    entryFeeUsd: brRoom.entryFeeUsd ?? BR.defaultEntryFee,
                    disconnected: brPlayer.disconnected ?? false,
                    isResetting: false,
                    battleRoyale: true,
                    brStatus: brRoom.status,
                });
            }
        }
        res.json({
            inGame: false,
            mode: null,
            balance: null,
            disconnected: false,
            isResetting: arenaResetting,
        });
    } catch (err) {
        res.status(500).json({ inGame: false });
    }
});

// --- NYTT: UTTAG (WITHDRAW) ---
app.post('/api/withdraw', authenticateToken, async (req, res) => {
    const { amountUSD, destinationAddress } = req.body;
    let solToWithdraw = null;

    try {
        solToWithdraw = amountUSD / SOL_PRICE_USD;

        const reserved = await User.findOneAndUpdate(
            { _id: req.user.id, balance: { $gte: solToWithdraw } },
            { $inc: { balance: -solToWithdraw } },
            { new: true },
        );
        if (!reserved) return res.status(400).json({ message: "Insufficient balance" });
        const user = reserved;
        if (!user.depositSecret) {
            await User.findByIdAndUpdate(req.user.id, { $inc: { balance: solToWithdraw } });
            return res.status(500).json({ message: "Account configuration error" });
        }

        const lamports = Math.round(solToWithdraw * solanaWeb3.LAMPORTS_PER_SOL);
        const userKeypair = solanaWeb3.Keypair.fromSecretKey(
            Uint8Array.from(Buffer.from(user.depositSecret, 'hex'))
        );

        const fee = 5000;
        const sendAmount = lamports - fee;
        if (sendAmount <= 0) {
            await User.findByIdAndUpdate(req.user.id, { $inc: { balance: solToWithdraw } });
            return res.status(400).json({ message: "Amount too small to cover fees" });
        }

        const transaction = new solanaWeb3.Transaction().add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: userKeypair.publicKey,
                toPubkey: new solanaWeb3.PublicKey(destinationAddress),
                lamports: sendAmount,
            })
        );

        const signature = await solanaWeb3.sendAndConfirmTransaction(connection, transaction, [userKeypair]);

        await Transaction.create({
            userId: user._id,
            type: 'withdraw',
            amount: solToWithdraw,
            currency: 'SOL',
            meta: { signature, destination: destinationAddress, solAmount: solToWithdraw, amountUsd: amountUSD },
            status: 'confirmed'
        });

        res.json({ success: true, newBalance: user.balance, signature });
    } catch (err) {
        console.error("Withdraw Error:", err.message);
        if (typeof solToWithdraw === 'number' && Number.isFinite(solToWithdraw)) {
            await User.findByIdAndUpdate(req.user.id, { $inc: { balance: solToWithdraw } }).catch(() => { });
        }
        res.status(500).json({ error: "Blockchain transaction failed" });
    }
});

async function ensureRewardWalletLiquidity(requiredLamports) {
    if (!REWARD_WALLET_ADDRESS || !REWARD_WALLET_SECRET) {
        throw new Error('Reward wallet not configured');
    }
    const rewardPubKey = new solanaWeb3.PublicKey(REWARD_WALLET_ADDRESS);
    const feeBuffer = 15_000;
    const rewardBalance = await connection.getBalance(rewardPubKey);
    const shortfall = Math.max(0, requiredLamports + feeBuffer - rewardBalance);
    if (!shortfall) return;

    if (!HOUSE_WALLET_ADDRESS || !HOUSE_WALLET_SECRET) {
        throw new Error('Reward wallet lacks liquidity');
    }
    const pendingRewardLamports = Math.round((getCachedPendingRewardUsd() / SOL_PRICE_USD) * solanaWeb3.LAMPORTS_PER_SOL);
    if (shortfall > pendingRewardLamports) {
        throw new Error('Reward reserve is awaiting the next arena settlement');
    }
    const houseKeypair = solanaWeb3.Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(HOUSE_WALLET_SECRET, 'hex'))
    );
    const houseBalance = await connection.getBalance(houseKeypair.publicKey);
    if (houseBalance < shortfall + feeBuffer) throw new Error('Reward and house wallets lack liquidity');

    const topUpTx = new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.transfer({
            fromPubkey: houseKeypair.publicKey,
            toPubkey: rewardPubKey,
            lamports: shortfall,
        })
    );
    await solanaWeb3.sendAndConfirmTransaction(connection, topUpTx, [houseKeypair]);
    await reducePendingRewardUsd((shortfall / solanaWeb3.LAMPORTS_PER_SOL) * SOL_PRICE_USD, { swept: true });
}


async function getRewardWalletLiabilityUsd() {
    const liabilities = await User.aggregate([{ $group: {
        _id: null,
        sponsoredUsd: { $sum: { $ifNull: ['$sponsoredRewardsBalance', 0] } },
        rentFallbackUsd: { $sum: { $ifNull: ['$rentFallbackBalanceUsd', 0] } },
        reservedUsd: { $sum: { $ifNull: ['$rewardClaimReservedUsd', 0] } },
    } }]);
    return Math.max(0,
        (liabilities[0]?.sponsoredUsd || 0)
        + (liabilities[0]?.rentFallbackUsd || 0)
        + (liabilities[0]?.reservedUsd || 0));
}


async function logConfirmedRewardClaim(claim) {
    const existing = claim.signature
        ? await Transaction.findOne({ 'meta.signature': claim.signature, 'meta.event': 'sponsored_rewards_claim' })
        : null;
    if (existing) return;
    await Transaction.create({
        userId: claim.userId,
        type: 'game',
        amount: claim.solAmount ?? (claim.amountUsd / SOL_PRICE_USD),
        currency: 'SOL',
        meta: {
            event: 'sponsored_rewards_claim',
            amountUsd: claim.amountUsd,
            signature: claim.signature || 'simulated_claim',
            claimId: claim._id.toString(),
            ...(DEV_FREE_PLAY ? { simulated: true } : {}),
        },
        status: 'confirmed',
    });
}

async function reconcileRewardClaims() {
    if (mongoose.connection.readyState !== 1) return;

    // Finish cross-document cleanup that may have been interrupted after the
    // terminal claim status was persisted. The active claim id prevents double restores.
    const lockedUsers = await User.find({
        rewardClaimInProgress: true,
        activeRewardClaimId: { $ne: null },
    }).select('_id activeRewardClaimId').limit(100).lean();
    for (const lockedUser of lockedUsers) {
        const terminalClaim = await RewardClaim.findById(lockedUser.activeRewardClaimId).select('status error');
        if (terminalClaim?.status === 'confirmed') {
            await completeRewardClaim(terminalClaim._id);
        } else if (terminalClaim?.status === 'failed') {
            await failAndReleaseRewardClaim(terminalClaim._id, terminalClaim.error);
        }
    }

    // Reserved claims are never auto-released: a server could have broadcast a
    // transfer and crashed before persisting its signature. Manual review is safer than double-paying.
    const broadcast = await RewardClaim.find({ status: 'broadcast', signature: { $ne: null } }).limit(50);
    for (const claim of broadcast) {
        try {
            const result = await connection.getSignatureStatuses([claim.signature], { searchTransactionHistory: true });
            const status = result.value[0];
            if (!status) continue;
            if (status.err) {
                await failAndReleaseRewardClaim(claim._id, `On-chain claim failed: ${JSON.stringify(status.err)}`);
            } else if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
                const completed = await completeRewardClaim(claim._id);
                await logConfirmedRewardClaim(completed).catch(err => console.error('Claim log error:', err.message));
            }
        } catch (err) {
            console.error('Reward claim reconciliation error:', err.message);
        }
    }
}
setInterval(() => reconcileRewardClaims().catch(err => console.error('Claim reconciliation failed:', err.message)), 30_000);

app.get('/api/user/reward-claim-status', authenticateToken, async (req, res) => {
    const claim = await RewardClaim.findOne({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
    res.json({ claim: claim ? {
        id: claim._id,
        status: claim.status,
        amountUsd: claim.amountUsd,
        signature: claim.signature,
        error: claim.error,
        createdAt: claim.createdAt,
    } : null });
});

app.post('/api/user/claim-rewards', sensitiveRateLimit({ limit: 10, windowMs: 60_000 }), authenticateToken, async (req, res) => {
    if (rewardPoolAdminResetting) return res.status(503).json({ error: 'Reward pool maintenance is in progress' });
    let reserved = null;
    let broadcastSignature = null;
    try {
        reserved = await reserveRewardClaim(req.user.id);
        if (!reserved) {
            const user = await User.findById(req.user.id).lean();
            if (user?.rewardsDisabled) return res.status(403).json({ error: 'Rewards are disabled pending an account review' });
            if (user?.rewardClaimInProgress) return res.status(409).json({ error: 'A reward claim is already processing' });
            return res.status(400).json({ error: 'No unlocked rewards available to claim' });
        }

        const { user, claim } = reserved;
        const amountUsd = claim.amountUsd;

        // Close the narrow race where a shared-wallet alert is raised while a
        // promo claim is being reserved. Real retained winnings are restored.
        if (claim.sponsoredAmountUsd > 0) {
            const currentSecurity = await User.findById(req.user.id).select('rewardsDisabled').lean();
            if (currentSecurity?.rewardsDisabled) {
                await failAndReleaseRewardClaim(claim._id, 'Promotional rewards disabled during linked-wallet review');
                await User.updateOne({ _id: req.user.id }, { $set: { sponsoredRewardsBalance: 0, fundedRewardsUsd: 0 } });
                return res.status(403).json({ error: 'Rewards are disabled pending an account review' });
            }
        }
        if (DEV_FREE_PLAY) {
            const completed = await completeRewardClaim(claim._id);
            await logConfirmedRewardClaim(completed);
            return res.json({ success: true, amount: amountUsd, signature: 'simulated_claim' });
        }

        const solAmount = amountUsd / SOL_PRICE_USD;
        const payoutLamports = Math.round(solAmount * solanaWeb3.LAMPORTS_PER_SOL);
        if (payoutLamports <= 0) throw new Error('Reward amount is too small');
        if (!REWARD_WALLET_SECRET || !REWARD_WALLET_ADDRESS) throw new Error('Reward wallet not configured');
        const rewardKeypair = solanaWeb3.Keypair.fromSecretKey(
            Uint8Array.from(Buffer.from(REWARD_WALLET_SECRET, 'hex'))
        );
        if (rewardKeypair.publicKey.toBase58() !== REWARD_WALLET_ADDRESS) {
            throw new Error('Reward wallet address does not match configured secret');
        }
        const userPubKey = new solanaWeb3.PublicKey(user.depositAddress);
        const [userLamports, rentMinimum] = await Promise.all([
            connection.getBalance(userPubKey),
            getSystemAccountRentLamports(),
        ]);
        if (userLamports + payoutLamports < rentMinimum) {
            await failAndReleaseRewardClaim(claim._id, 'Claim is below the Solana account rent minimum');
            return res.status(409).json({
                error: 'This claim is too small to activate an empty Solana account. Add a small deposit or let rewards accumulate, then claim again.',
            });
        }
        await ensureRewardWalletLiquidity(payoutLamports);
        const transaction = new solanaWeb3.Transaction().add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: rewardKeypair.publicKey,
                toPubkey: userPubKey,
                lamports: payoutLamports,
            })
        );

        broadcastSignature = await connection.sendTransaction(transaction, [rewardKeypair], { maxRetries: 3 });
        await markClaimBroadcast(claim._id, { signature: broadcastSignature, solAmount });
        const confirmation = await connection.confirmTransaction(broadcastSignature, 'confirmed');
        if (confirmation.value.err) {
            await failAndReleaseRewardClaim(claim._id, `On-chain claim failed: ${JSON.stringify(confirmation.value.err)}`);
            return res.status(502).json({ error: 'On-chain reward payment failed' });
        }

        const completed = await completeRewardClaim(claim._id);
        await logConfirmedRewardClaim(completed).catch(err => console.error('Claim log error:', err.message));
        return res.json({ success: true, amount: amountUsd, signature: broadcastSignature });
    } catch (err) {
        await logSolanaTransactionError('Claim rewards error:', err);
        if (reserved?.claim?._id && !broadcastSignature) {
            await failAndReleaseRewardClaim(reserved.claim._id, err.message).catch(() => {});
        }
        if (broadcastSignature) {
            return res.status(202).json({
                success: false,
                processing: true,
                message: 'Payment was submitted and is still being confirmed.',
                signature: broadcastSignature,
            });
        }
        return res.status(500).json({ error: err.message || 'Internal server error' });
    }
});
async function releaseTournamentRewardClaim(claim, error) {
    if (!claim) return;
    await TournamentRewardClaim.updateOne(
        { _id: claim._id, status: { $in: ['reserving', 'reserved'] } },
        { $set: { status: 'failed', error: String(error || 'Claim failed') } },
    );
    await User.updateOne(
        { _id: claim.userId, activeTournamentRewardClaimId: claim._id },
        {
            $inc: {
                tournamentRewardsBalance: claim.amountUsd,
                tournamentRewardsLamports: claim.lamports,
            },
            $set: {
                tournamentRewardClaimInProgress: false,
                tournamentRewardClaimReservedUsd: 0,
                tournamentRewardClaimReservedLamports: 0,
                activeTournamentRewardClaimId: null,
            },
        },
    );
}

async function completeTournamentRewardClaim(claim, signature) {
    await TournamentRewardClaim.updateOne(
        { _id: claim._id },
        { $set: { status: 'confirmed', signature, solAmount: claim.lamports / solanaWeb3.LAMPORTS_PER_SOL } },
    );
    await User.updateOne(
        { _id: claim.userId, activeTournamentRewardClaimId: claim._id },
        {
            $set: {
                tournamentRewardClaimInProgress: false,
                tournamentRewardClaimReservedUsd: 0,
                tournamentRewardClaimReservedLamports: 0,
                activeTournamentRewardClaimId: null,
            },
        },
    );
    await Transaction.findOneAndUpdate(
        { 'meta.event': 'tournament_reward_claim', 'meta.claimId': claim._id.toString() },
        {
            $setOnInsert: {
                userId: claim.userId,
                type: 'game',
                amount: claim.lamports / solanaWeb3.LAMPORTS_PER_SOL,
                currency: 'SOL',
                meta: {
                    event: 'tournament_reward_claim',
                    amountUsd: claim.amountUsd,
                    lamports: claim.lamports,
                    signature,
                    claimId: claim._id.toString(),
                    ...(DEV_FREE_PLAY ? { simulated: true } : {}),
                },
                status: 'confirmed',
            },
        },
        { upsert: true, new: true },
    );
}

app.get('/api/user/tournament-reward-claim-status', authenticateToken, async (req, res) => {
    const claim = await TournamentRewardClaim.findOne({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
    res.json({ claim: claim ? {
        id: claim._id,
        status: claim.status,
        amountUsd: claim.amountUsd,
        signature: claim.signature,
        error: claim.error,
        createdAt: claim.createdAt,
    } : null });
});

app.post('/api/user/claim-tournament-rewards', sensitiveRateLimit({ limit: 10, windowMs: 60_000 }), authenticateToken, async (req, res) => {
    let claim = null;
    let broadcastSignature = null;
    try {
        const snapshot = await User.findOne({
            _id: req.user.id,
            tournamentRewardsBalance: { $gt: 0 },
            tournamentRewardsLamports: { $gt: 0 },
            tournamentRewardClaimInProgress: { $ne: true },
        }).lean();
        if (!snapshot) {
            const current = await User.findById(req.user.id).lean();
            if (current?.tournamentRewardClaimInProgress) return res.status(409).json({ error: 'A tournament reward claim is already processing' });
            return res.status(400).json({ error: 'No tournament winnings available to claim' });
        }

        const amountUsd = Number(snapshot.tournamentRewardsBalance);
        const lamports = Math.floor(Number(snapshot.tournamentRewardsLamports));
        claim = await TournamentRewardClaim.create({ userId: snapshot._id, amountUsd, lamports });
        const reserved = await User.findOneAndUpdate(
            {
                _id: snapshot._id,
                tournamentRewardsBalance: amountUsd,
                tournamentRewardsLamports: lamports,
                tournamentRewardClaimInProgress: { $ne: true },
            },
            {
                $set: {
                    tournamentRewardsBalance: 0,
                    tournamentRewardsLamports: 0,
                    tournamentRewardClaimInProgress: true,
                    tournamentRewardClaimReservedUsd: amountUsd,
                    tournamentRewardClaimReservedLamports: lamports,
                    activeTournamentRewardClaimId: claim._id,
                },
            },
            { new: true },
        );
        if (!reserved) {
            await TournamentRewardClaim.updateOne({ _id: claim._id }, { $set: { status: 'failed', error: 'Reward balance changed before reservation' } });
            return res.status(409).json({ error: 'Reward balance changed. Please try again.' });
        }
        await TournamentRewardClaim.updateOne({ _id: claim._id }, { $set: { status: 'reserved' } });

        if (DEV_FREE_PLAY) {
            await completeTournamentRewardClaim(claim, 'simulated_tournament_claim');
            return res.json({ success: true, amount: amountUsd, signature: 'simulated_tournament_claim' });
        }
        if (!TOURNAMENT_WALLET_ADDRESS || !TOURNAMENT_WALLET_SECRET) throw new Error('Tournament wallet not configured');
        const tournamentKeypair = solanaWeb3.Keypair.fromSecretKey(
            Uint8Array.from(Buffer.from(TOURNAMENT_WALLET_SECRET, 'hex')),
        );
        if (tournamentKeypair.publicKey.toBase58() !== TOURNAMENT_WALLET_ADDRESS) {
            throw new Error('Tournament wallet address does not match configured secret');
        }
        const user = await User.findById(req.user.id).lean();
        const userPubKey = new solanaWeb3.PublicKey(user.depositAddress);
        const walletLamports = await connection.getBalance(tournamentKeypair.publicKey);
        if (walletLamports < lamports + 15_000) throw new Error('Tournament wallet lacks claim liquidity');

        const transaction = new solanaWeb3.Transaction().add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: tournamentKeypair.publicKey,
                toPubkey: userPubKey,
                lamports,
            }),
        );
        broadcastSignature = await connection.sendTransaction(transaction, [tournamentKeypair], { maxRetries: 3 });
        await TournamentRewardClaim.updateOne({ _id: claim._id }, { $set: { status: 'broadcast', signature: broadcastSignature } });
        const confirmation = await connection.confirmTransaction(broadcastSignature, 'confirmed');
        if (confirmation.value.err) throw new Error(`On-chain tournament claim failed: ${JSON.stringify(confirmation.value.err)}`);
        await completeTournamentRewardClaim(claim, broadcastSignature);
        return res.json({ success: true, amount: amountUsd, signature: broadcastSignature });
    } catch (err) {
        await logSolanaTransactionError('Tournament reward claim error:', err);
        if (claim && !broadcastSignature) await releaseTournamentRewardClaim(claim, err.message).catch(() => {});
        if (broadcastSignature) return res.status(202).json({ processing: true, signature: broadcastSignature });
        return res.status(500).json({ error: err.message || 'Tournament claim failed' });
    }
});
// --- NYTT: Endpoint för att verifiera insättning och spara i historik ---
app.post('/api/deposit-verify', sensitiveRateLimit({ limit: 20, windowMs: 60_000 }), authenticateToken, async (req, res) => {
    const { signature } = req.body;
    try {
        if (!signature) return res.status(400).json({ message: 'Missing signature' });

        // A single Solana transaction may legitimately fund several account addresses.
        const existing = await Transaction.findOne({ 'meta.signature': signature, userId: req.user.id });
        if (existing?.meta?.sourceWallet) {
            await recordDepositSource({
                signature,
                userId: req.user.id,
                sourceWallet: existing.meta.sourceWallet,
                destinationWallet: existing.meta.destinationWallet || 'unknown',
                amountLamports: Math.round((existing.meta.solAmount || existing.amount || 0) * solanaWeb3.LAMPORTS_PER_SOL),
            });
            return res.json({ success: true, message: 'Already processed' });
        }

        const txDetails = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
        if (!txDetails || txDetails.meta?.err) {
            return res.status(400).json({ message: 'Invalid on-chain transaction' });
        }

        const user = await User.findById(req.user.id);
        if (!user?.depositAddress) return res.status(404).json({ message: 'Användare hittades ej' });

        const depositPubkey = new solanaWeb3.PublicKey(user.depositAddress);
        const accountKeys = getTransactionAccountKeys(txDetails);
        let creditedLamports = 0;
        for (let i = 0; i < accountKeys.length; i++) {
            if (accountKeys[i].equals(depositPubkey)) {
                const pre = txDetails.meta.preBalances[i];
                const post = txDetails.meta.postBalances[i];
                if (post > pre) {
                    creditedLamports = post - pre;
                    break;
                }
            }
        }
        if (creditedLamports <= 0) {
            return res.status(400).json({ message: 'Deposit address not credited in this transaction' });
        }

        const depositSource = extractNativeDeposit(txDetails, user.depositAddress);
        if (!depositSource) return res.status(400).json({ message: 'Could not identify the funding wallet' });
        const solReceived = creditedLamports / solanaWeb3.LAMPORTS_PER_SOL;
        user.balance = (await connection.getBalance(depositPubkey)) / solanaWeb3.LAMPORTS_PER_SOL;
        await user.save();

        if (existing) {
            existing.meta = {
                ...(existing.meta || {}),
                signature,
                solAmount: solReceived,
                amountUsd: solReceived * SOL_PRICE_USD,
                verifiedOnChain: true,
                sourceWallet: depositSource.sourceWallet,
                destinationWallet: user.depositAddress,
            };
            await existing.save();
        } else {
            await Transaction.create({
                userId: user._id,
                type: 'deposit',
                amount: solReceived,
                currency: 'SOL',
                meta: { signature, solAmount: solReceived, amountUsd: solReceived * SOL_PRICE_USD, verifiedOnChain: true, sourceWallet: depositSource.sourceWallet, destinationWallet: user.depositAddress },
                status: 'confirmed',
            });
        }
        const securityAlert = await recordDepositSource({
            signature,
            userId: user._id,
            sourceWallet: depositSource.sourceWallet,
            destinationWallet: user.depositAddress,
            amountLamports: depositSource.creditedLamports,
        });

        res.json({ success: true, balance: user.balance, solReceived, rewardsReview: securityAlert?.status === 'pending' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Entry fee info (client can request how much SOL to send and where)
app.get('/api/entry-info', authenticateToken, async (req, res) => {
    try {
        const entryUSD = 10.0;
        const solAmount = entryUSD / SOL_PRICE_USD;
        res.json({ entryUSD, solAmount, houseAddress: HOUSE_WALLET_ADDRESS, solPrice: SOL_PRICE_USD });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Verify an on-chain entry payment (client should send the transaction signature)
app.post('/api/entry-pay', authenticateToken, async (req, res) => {
    const { signature, solAmount } = req.body;
    const entryUSD = 10.0;
    try {
        if (!signature) return res.status(400).json({ message: 'Missing signature' });
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Check if we've already processed this signature
        const existing = await Transaction.findOne({ 'meta.signature': signature });
        if (existing) return res.json({ success: true, message: 'Already processed' });

        const txDetails = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
        if (!txDetails || txDetails.meta?.err) return res.status(400).json({ message: 'Invalid on-chain transaction' });

        // Ensure the transfer went to our house wallet and amount matches
        const toPubkey = new solanaWeb3.PublicKey(HOUSE_WALLET_ADDRESS);
        // Find any transfer instructions that credited the house address
        const accountKeys = getTransactionAccountKeys(txDetails);
        let credited = false;
        let creditedLamports = 0;
        for (let i = 0; i < accountKeys.length; i++) {
            if (accountKeys[i].equals(toPubkey)) {
                const pre = txDetails.meta.preBalances[i];
                const post = txDetails.meta.postBalances[i];
                if (post > pre) { credited = true; creditedLamports = post - pre; break; }
            }
        }

        if (!credited) return res.status(400).json({ message: 'House wallet not credited in this transaction' });

        const solReceived = creditedLamports / solanaWeb3.LAMPORTS_PER_SOL;

        // Logic: Credit received SOL directly to user balance
        user.balance += solReceived;
        await user.save();

        await Transaction.create({
            userId: user._id,
            type: 'deposit',
            amount: solReceived,
            currency: 'SOL',
            meta: { signature, solAmount: solReceived, entryFor: 'arena-entry' },
            status: 'confirmed'
        });

        res.json({ success: true, solReceived });
    } catch (err) { console.error('Entry pay error', err); res.status(500).json({ error: err.message }); }
});

// --- ADMIN DASHBOARD ---
/** Transactions / users hidden from admin stats (not deleted). */
const TX_REPORTED = { excludedFromReports: { $ne: true } };
const USER_REPORTED = { excludedFromReports: { $ne: true } };

async function fetchExcludedUserIds() {
    return User.find({ excludedFromReports: true }).distinct('_id');
}

async function reportedTxMatch(extra = {}, { skipUserExclusion = false } = {}) {
    const clauses = [TX_REPORTED];
    if (Object.keys(extra).length) clauses.push(extra);
    if (!skipUserExclusion) {
        const excludedUserIds = await fetchExcludedUserIds();
        if (excludedUserIds.length) {
            clauses.push({
                $or: [
                    { userId: { $exists: false } },
                    { userId: null },
                    { userId: { $nin: excludedUserIds } },
                ],
            });
        }
    }
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

async function buildAdminTxListFilter({ userId, showExcluded } = {}) {
    const clauses = [];
    if (!showExcluded) clauses.push(TX_REPORTED);
    if (userId) {
        clauses.push({ userId });
    } else {
        const excludedUserIds = await fetchExcludedUserIds();
        if (excludedUserIds.length) {
            clauses.push({
                $or: [
                    { userId: { $exists: false } },
                    { userId: null },
                    { userId: { $nin: excludedUserIds } },
                ],
            });
        }
    }
    if (clauses.length === 0) return {};
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function txAmountUsd(tx) {
    const reason = tx.meta?.reason || '';
    if (GAME_CASHOUT_REASON_RE.test(reason)) {
        return tx.amount;
    }
    if (tx.currency === 'SOL' || tx.meta?.solAmount != null) {
        const sol = tx.meta?.solAmount ?? tx.amount;
        return sol * SOL_PRICE_USD;
    }
    return tx.amount;
}

async function sumGameCashoutUsd(extra = {}) {
    const match = await reportedTxMatch({ ...buildGameCashoutTxFilter(), ...extra }, { skipUserExclusion: true });
    const txs = await Transaction.find(match).select('amount currency meta').lean();
    let totalUsd = 0;
    for (const tx of txs) {
        totalUsd += txAmountUsd(tx);
    }
    return Number(totalUsd.toFixed(2));
}

async function refreshGlobalPlayerEarnings() {
    try {
        globalPlayerEarningsUsd = await sumGameCashoutUsd();
        globalPlayerEarningsSol = Number((globalPlayerEarningsUsd / SOL_PRICE_USD).toFixed(6));
    } catch (err) {
        console.error('Failed to refresh global player earnings:', err.message);
    }
}

refreshGlobalPlayerEarnings();
setInterval(refreshGlobalPlayerEarnings, 15000);

function txAmountSol(tx) {
    if (tx.meta?.solAmount != null) return tx.meta.solAmount;
    if (tx.currency === 'SOL') return tx.amount;
    return tx.amount / SOL_PRICE_USD;
}

const OWNER_EARNING_EVENTS = {
    status: 'confirmed',
    $or: [
        { 'meta.event': 'pool_sweep' },
        { 'meta.event': 'br_owner_sweep' },
        { 'meta.event': 'reward_owner_surplus_sweep' },
        { 'meta.event': 'reward_pool_factory_reset' },
    ],
};

async function computeOwnerEarnings() {
    const match = await reportedTxMatch(OWNER_EARNING_EVENTS);
    const txs = await Transaction.find(match).select('amount currency meta').lean();
    let totalSol = 0;
    let totalUsd = 0;
    let arenaSweepSol = 0;
    let brSweepSol = 0;
    for (const tx of txs) {
        const sol = txAmountSol(tx);
        const usd = txAmountUsd(tx);
        totalSol += sol;
        totalUsd += usd;
        if (tx.meta?.event === 'br_owner_sweep') brSweepSol += sol;
        else arenaSweepSol += sol;
    }
    return {
        totalSol: Number(totalSol.toFixed(6)),
        totalUsd: Number(totalUsd.toFixed(2)),
        sweepCount: txs.length,
        arenaSweepSol: Number(arenaSweepSol.toFixed(6)),
        brSweepSol: Number(brSweepSol.toFixed(6)),
    };
}

function objectIdCreatedAt(id) {
    try {
        return new mongoose.Types.ObjectId(id).getTimestamp();
    } catch {
        return null;
    }
}

function sortAdminUsers(users, sortKey) {
    const list = [...users];
    switch (sortKey) {
        case 'balance_asc':
            return list.sort((a, b) => a.balanceSol - b.balanceSol);
        case 'newest':
            return list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        case 'oldest':
            return list.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        case 'deposits_desc':
            return list.sort((a, b) => b.totalDepositedUsd - a.totalDepositedUsd);
        case 'username_asc':
            return list.sort((a, b) => a.username.localeCompare(b.username));
        case 'balance_desc':
        default:
            return list.sort((a, b) => b.balanceSol - a.balanceSol);
    }
}

function classifyTxActivity(tx) {
    const m = tx.meta || {};
    if (tx.type === 'deposit') return 'deposit';
    if (['pool_sweep', 'br_owner_sweep', 'reward_owner_surplus_sweep', 'reward_pool_factory_reset'].includes(m.event)) return 'sweep';
    if (tx.type === 'game') {
        if (m.event === 'join' || m.event === 'br_join') return 'entry';
        if (m.reason === 'Arena Death' || m.reason === 'BR Eliminated' || m.reason === 'Competitive Slither Death') return 'death';
        if (m.event === 'br_refund') return 'refund';
        return 'game';
    }
    if (tx.type === 'withdraw') {
        const r = m.reason || '';
        if (GAME_CASHOUT_REASON_RE.test(r)) return 'cashout';
        return 'withdraw';
    }
    return 'other';
}

function txActivityLabel(tx) {
    const m = tx.meta || {};
    const cat = classifyTxActivity(tx);
    switch (cat) {
        case 'deposit': return 'Deposit';
        case 'withdraw': return 'Withdrawal';
        case 'entry':
            if (m.event === 'br_join') return `BR entry · $${m.entryFeeUsd ?? '?'}`;
            return `Arena entry · ${m.mode || 'agar'} · $${m.entryFeeUsd ?? '?'}`;
        case 'cashout': return m.reason || 'Cashout';
        case 'death': return m.reason || 'Eliminated';
        case 'refund': return 'BR refund';
        case 'sweep': return m.reason || 'Owner sweep';
        default: return m.reason || m.event || tx.type;
    }
}

function buildTxCategoryFilter(category) {
    switch (category) {
        case 'deposit':
            return { type: 'deposit' };
        case 'withdraw':
            return {
                type: 'withdraw',
                'meta.event': { $nin: ['pool_sweep', 'br_owner_sweep', 'reward_owner_surplus_sweep', 'reward_pool_factory_reset'] },
                'meta.reason': { $not: { $regex: GAME_CASHOUT_REASON_RE } },
            };
        case 'entry':
            return { type: 'game', 'meta.event': { $in: ['join', 'br_join'] } };
        case 'cashout':
            return buildGameCashoutTxFilter();
        case 'death':
            return { type: 'game', 'meta.reason': { $in: ['Arena Death', 'BR Eliminated', 'Competitive Slither Death'] } };
        case 'sweep':
            return { $or: [{ 'meta.event': 'pool_sweep' }, { 'meta.event': 'br_owner_sweep' }, { 'meta.event': 'reward_owner_surplus_sweep' }, { 'meta.event': 'reward_pool_factory_reset' }] };
        case 'game':
            return { type: 'game' };
        default:
            return {};
    }
}

function mapTxToAdminRow(tx, userMap) {
    const category = classifyTxActivity(tx);
    return {
        id: tx._id,
        userId: tx.userId?.toString() || null,
        username: tx.userId ? (userMap[tx.userId.toString()] || 'Unknown') : '—',
        type: tx.type,
        category,
        label: txActivityLabel(tx),
        amount: tx.amount,
        currency: tx.currency || 'USD',
        amountUsd: Number(txAmountUsd(tx).toFixed(2)),
        status: tx.status,
        meta: tx.meta,
        excludedFromReports: !!tx.excludedFromReports,
        createdAt: tx.createdAt,
    };
}

async function buildAdminTxQuery({ userId, showExcluded, type, category, search }) {
    const clauses = [];
    if (!showExcluded) clauses.push(TX_REPORTED);

    if (userId) {
        clauses.push({ userId });
    } else if (search?.trim()) {
        const matchingUsers = await User.find({
            username: { $regex: search.trim(), $options: 'i' },
        }).select('_id').lean();
        const ids = matchingUsers.map(u => u._id);
        if (!ids.length) return { _id: null };
        clauses.push({ userId: { $in: ids } });
    } else {
        const excludedUserIds = await fetchExcludedUserIds();
        if (excludedUserIds.length) {
            clauses.push({
                $or: [
                    { userId: { $exists: false } },
                    { userId: null },
                    { userId: { $nin: excludedUserIds } },
                ],
            });
        }
    }

    if (type) clauses.push({ type });
    const catFilter = buildTxCategoryFilter(category);
    if (Object.keys(catFilter).length) clauses.push(catFilter);

    if (clauses.length === 0) return {};
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

app.get('/api/admin/dashboard/overview', authenticateAdmin, async (req, res) => {
    try {
        const depositMatch = await reportedTxMatch({ type: 'deposit', status: 'confirmed' });
        const withdrawMatch = await reportedTxMatch({
            type: 'withdraw',
            status: 'confirmed',
            'meta.event': { $nin: ['pool_sweep', 'br_owner_sweep', 'reward_owner_surplus_sweep', 'reward_pool_factory_reset'] },
        });
        const [depositAgg, withdrawAgg, excludedTxCount, excludedUsersCount, ownerEarnings, userBalanceAgg, ownerAccountAgg, rewardPoolState] = await Promise.all([
            Transaction.aggregate([
                { $match: depositMatch },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
            ]),
            Transaction.aggregate([
                { $match: withdrawMatch },
                { $group: { _id: null, txs: { $push: { amount: '$amount', currency: '$currency', meta: '$meta' } }, count: { $sum: 1 } } },
            ]),
            Transaction.countDocuments({ excludedFromReports: true }),
            User.countDocuments({ excludedFromReports: true }),
            computeOwnerEarnings(),
            User.aggregate([
                { $match: USER_REPORTED },
                {
                    $group: {
                        _id: null,
                        totalBalanceSol: { $sum: { $ifNull: ['$balance', 0] } },
                        accountCount: { $sum: 1 },
                        totalSponsoredRewards: { $sum: { $ifNull: ['$sponsoredRewardsBalance', 0] } },
                        totalRetainedWinnings: { $sum: { $ifNull: ['$rentFallbackBalanceUsd', 0] } },
                        activeSponsoredPlayers: { $sum: { $cond: [{ $gt: ['$sponsoredRewardsBalance', 0] }, 1, 0] } },
                        completedBeginnerChallenges: { $sum: { $cond: [{ $eq: ['$sponsoredRewardsCompleted', true] }, 1, 0] } },
                        unusedFreeTickets: { $sum: { $cond: [{ $and: [{ $eq: ['$hasFreeTicket', true] }, { $ne: ['$freeTicketUsed', true] }] }, 1, 0] } },
                        usedFreeTickets: { $sum: { $cond: [{ $eq: ['$freeTicketUsed', true] }, 1, 0] } }
                    }
                }
            ]),
            User.aggregate([
                { $match: { isOwnerAccount: true } },
                {
                    $group: {
                        _id: null,
                        totalBalanceSol: { $sum: { $ifNull: ['$balance', 0] } },
                        accountCount: { $sum: 1 },
                    }
                }
            ]),
            RewardPoolState.findOne({ key: 'global' }).lean(),
        ]);

        const totalDepositsSol = depositAgg[0]?.total ?? 0;
        const totalDepositsUsd = totalDepositsSol * SOL_PRICE_USD;

        let totalWithdrawalsUsd = 0;
        for (const tx of withdrawAgg[0]?.txs ?? []) {
            totalWithdrawalsUsd += txAmountUsd(tx);
        }

        const totalUserBalanceSol = userBalanceAgg[0]?.totalBalanceSol ?? 0;
        const totalAccounts = userBalanceAgg[0]?.accountCount ?? 0;
        const ownerAccountBalanceSol = ownerAccountAgg[0]?.totalBalanceSol ?? 0;
        const ownerAccountCount = ownerAccountAgg[0]?.accountCount ?? 0;

        res.json({
            totalDepositsUsd: Number(totalDepositsUsd.toFixed(2)),
            totalDepositsSol: Number(totalDepositsSol.toFixed(6)),
            totalWithdrawalsUsd: Number(totalWithdrawalsUsd.toFixed(2)),
            depositCount: depositAgg[0]?.count ?? 0,
            withdrawalCount: withdrawAgg[0]?.count ?? 0,
            ownerEarningsUsd: ownerEarnings.totalUsd,
            ownerEarningsSol: ownerEarnings.totalSol,
            ownerSweepCount: ownerEarnings.sweepCount,
            ownerEarningsArenaSol: ownerEarnings.arenaSweepSol,
            ownerEarningsBrSol: ownerEarnings.brSweepSol,
            rewardPoolBalanceUsd: Number(getCachedPendingRewardUsd().toFixed(2)),
            totalAccounts,
            totalUserBalanceSol: Number(totalUserBalanceSol.toFixed(6)),
            totalUserBalanceUsd: Number((totalUserBalanceSol * SOL_PRICE_USD).toFixed(2)),
            ownerAccountCount,
            ownerAccountBalanceSol: Number(ownerAccountBalanceSol.toFixed(6)),
            ownerAccountBalanceUsd: Number((ownerAccountBalanceSol * SOL_PRICE_USD).toFixed(2)),
            totalSponsoredRewards: userBalanceAgg[0]?.totalSponsoredRewards ?? 0,
            totalRetainedWinnings: userBalanceAgg[0]?.totalRetainedWinnings ?? 0,
            activeSponsoredPlayers: userBalanceAgg[0]?.activeSponsoredPlayers ?? 0,
            completedBeginnerChallenges: userBalanceAgg[0]?.completedBeginnerChallenges ?? 0,
            unusedFreeTickets: userBalanceAgg[0]?.unusedFreeTickets ?? 0,
            usedFreeTickets: userBalanceAgg[0]?.usedFreeTickets ?? 0,
            excludedTxCount,
            excludedUsersCount,
            solPrice: SOL_PRICE_USD,
        });
    } catch (err) {
        console.error('Admin overview error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/dashboard/active-users', authenticateAdmin, async (req, res) => {
    try {
        const inGameUserIds = new Set();
        const inGameUsernames = [];
        let botCount = 0;
        const botList = [];

        // Normal rooms (agar/slither)
        for (const room of rooms) {
            for (const p of room.players) {
                if (p.isBot) {
                    botCount++;
                    botList.push({
                        id: p.id || `bot_${Math.random()}`,
                        username: p.username,
                        mode: room.mode || 'agar',
                        entryFeeUsd: room.entryFeeUsd,
                        isBot: true,
                    });
                } else if (p.mongoId) {
                    const id = p.mongoId.toString();
                    if (!inGameUserIds.has(id)) {
                        inGameUserIds.add(id);
                        inGameUsernames.push({ id, username: p.username, mode: room.mode || 'agar', entryFeeUsd: room.entryFeeUsd, isBot: false });
                    }
                }
            }
            if (room.slitherBots) {
                for (const b of room.slitherBots) {
                    botCount++;
                    botList.push({
                        id: b.id,
                        username: b.username,
                        mode: 'slither',
                        entryFeeUsd: room.entryFeeUsd,
                        isBot: true,
                    });
                }
            }
            if (room.sandboxStaticWorms) {
                for (const b of room.sandboxStaticWorms) {
                    botCount++;
                    botList.push({
                        id: b.id,
                        username: b.username,
                        mode: 'slither',
                        entryFeeUsd: room.entryFeeUsd,
                        isBot: true,
                    });
                }
            }
        }

        // Competitive slither rooms
        for (const room of competitiveSlitherRooms) {
            for (const p of room.players) {
                if (p.isBot) {
                    botCount++;
                    botList.push({
                        id: p.id || `bot_${Math.random()}`,
                        username: p.username,
                        mode: 'competitive-slither',
                        entryFeeUsd: room.entryFeeUsd,
                        isBot: true,
                    });
                } else if (p.mongoId) {
                    const id = p.mongoId.toString();
                    if (!inGameUserIds.has(id)) {
                        inGameUserIds.add(id);
                        inGameUsernames.push({
                            id,
                            username: p.username,
                            mode: 'competitive-slither',
                            entryFeeUsd: room.entryFeeUsd,
                            isBot: false,
                        });
                    }
                }
            }
            if (room.slitherBots) {
                for (const b of room.slitherBots) {
                    botCount++;
                    botList.push({
                        id: b.id,
                        username: b.username,
                        mode: 'competitive-slither',
                        entryFeeUsd: room.entryFeeUsd,
                        isBot: true,
                    });
                }
            }
        }

        // Battle Royale matches
        const brMatches = typeof getActiveBRMatchesRaw === 'function' ? getActiveBRMatchesRaw() : [];
        for (const room of brMatches) {
            for (const p of room.players) {
                if (p.isBot) {
                    botCount++;
                    botList.push({
                        id: p.id || `bot_${Math.random()}`,
                        username: p.username,
                        mode: room.variant === 'slither' ? 'br-slither' : 'br-agar',
                        entryFeeUsd: room.entryFeeUsd,
                        isBot: true,
                    });
                } else if (p.mongoId) {
                    const id = p.mongoId.toString();
                    if (!inGameUserIds.has(id)) {
                        inGameUserIds.add(id);
                        inGameUsernames.push({
                            id,
                            username: p.username,
                            mode: room.variant === 'slither' ? 'br-slither' : 'br-agar',
                            entryFeeUsd: room.entryFeeUsd,
                            isBot: false,
                        });
                    }
                }
            }
        }

        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentMatch = await reportedTxMatch({ createdAt: { $gte: dayAgo } });
        const recentUserIds = await Transaction.distinct('userId', recentMatch);

                const uniquePresence = new Map();
        for (const [k, data] of sitePresence) {
            if (Date.now() - (data.lastSeen || data) >= PRESENCE_TTL_MS) continue;
            
            let ip = data.ip || 'Unknown';
            if (ip.includes(',')) ip = ip.split(',')[0].trim();
            if (ip === '::1' || ip === '::ffff:127.0.0.1') ip = '127.0.0.1';
            
            const existing = uniquePresence.get(ip);
            const seenAt = data.lastSeen || data;
            if (!existing || seenAt > existing.lastSeen) {
                uniquePresence.set(ip, {
                    id: k,
                    ip: ip,
                    country: data.country || 'Unknown',
                    page: data.page || 'unknown',
                    gamemode: data.gamemode || 'none',
                    userAgent: data.userAgent || 'Unknown',
                    lastSeen: seenAt
                });
            }
        }
        const presenceData = Array.from(uniquePresence.values())
            .sort((a, b) => b.lastSeen - a.lastSeen);

        res.json({
            currentlyInGame: inGameUserIds.size,
            currentlyBots: botCount,
            activeLast24h: recentUserIds.length,
            inGamePlayers: inGameUsernames,
            inGameBots: botList,
            sitePresence: presenceData,
        });
    } catch (err) {
        console.error('Admin active-users error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/dashboard/users', authenticateAdmin, async (req, res) => {
    try {
        const showExcluded = req.query.showExcluded === 'true';
        const sortKey = req.query.sort || 'balance_desc';
        const userFilter = showExcluded ? {} : USER_REPORTED;
        const users = await User.find(userFilter).select('username walletAddress depositAddress balance excludedFromReports isOwnerAccount playtime email hasFreeTicket freeTicketUsed completedFiveDollarNormalGames completedTenDollarNormalGames sponsoredRewardsCompleted sponsoredRewardsUnlocked sponsoredRewardsBalance fundedRewardsUsd rentFallbackBalanceUsd rewardsDisabled rewardClaimInProgress rewardClaimReservedUsd tournamentRewardsBalance tournamentRewardsLamports tournamentRewardClaimInProgress tournamentRewardClaimReservedUsd').lean();
        const depositMatch = await reportedTxMatch({ type: 'deposit', status: 'confirmed' });
        const depositTotals = await Transaction.aggregate([
            { $match: depositMatch },
            { $group: { _id: '$userId', totalDepositedSol: { $sum: '$amount' }, depositCount: { $sum: 1 } } },
        ]);
        const depositMap = Object.fromEntries(depositTotals.map(d => [d._id.toString(), d]));

        const result = users.map(u => {
            const dep = depositMap[u._id.toString()];
            const balanceSol = u.balance ?? 0;
            return {
                id: u._id,
                username: u.username,
                email: u.email || null,
                wallet: u.walletAddress || '—',
                depositAddress: u.depositAddress || '—',
                balanceSol: Number(balanceSol.toFixed(6)),
                balanceUsd: Number((balanceSol * SOL_PRICE_USD).toFixed(2)),
                totalDepositedSol: Number((dep?.totalDepositedSol ?? 0).toFixed(6)),
                totalDepositedUsd: Number(((dep?.totalDepositedSol ?? 0) * SOL_PRICE_USD).toFixed(2)),
                depositCount: dep?.depositCount ?? 0,
                playtime: u.playtime ?? 0,
                createdAt: objectIdCreatedAt(u._id),
                excludedFromReports: !!u.excludedFromReports,
                isOwnerAccount: !!u.isOwnerAccount,
                hasFreeTicket: !!u.hasFreeTicket,
                freeTicketUsed: !!u.freeTicketUsed,
                completedFiveDollarNormalGames: u.completedFiveDollarNormalGames ?? 0,
                completedTenDollarNormalGames: u.completedTenDollarNormalGames ?? 0,
                sponsoredRewardsCompleted: !!u.sponsoredRewardsCompleted,
                sponsoredRewardsUnlocked: !!u.sponsoredRewardsUnlocked,
                sponsoredRewardsBalance: Number((u.sponsoredRewardsBalance ?? 0).toFixed(2)),
                fundedRewardsUsd: Number((u.fundedRewardsUsd ?? 0).toFixed(2)),
                retainedRewardsUsd: Number((u.rentFallbackBalanceUsd ?? 0).toFixed(2)),
                tournamentRewardsBalance: Number((u.tournamentRewardsBalance ?? 0).toFixed(2)),
                totalRewardsBalance: Number(((u.sponsoredRewardsBalance ?? 0) + (u.rentFallbackBalanceUsd ?? 0) + (u.tournamentRewardsBalance ?? 0)).toFixed(2)),
                rewardsDisabled: !!u.rewardsDisabled,
                rewardClaimInProgress: !!u.rewardClaimInProgress,
                tournamentRewardClaimInProgress: !!u.tournamentRewardClaimInProgress,
            };
        });

        const sorted = sortAdminUsers(result, sortKey);

        res.json({ users: sorted, total: sorted.length, showExcluded, sort: sortKey });
    } catch (err) {
        console.error('Admin users error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/dashboard/users/:userId', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ message: 'Invalid user id' });
        }

        const user = await User.findById(userId).select('-password -depositSecret').lean();
        if (!user) return res.status(404).json({ message: 'User not found' });

        const uid = user._id;
        const [allTxs, joinTxs, cashoutTxs] = await Promise.all([
            Transaction.find({ userId: uid }).sort({ createdAt: -1 }).limit(500).lean(),
            Transaction.find({ userId: uid, type: 'game', 'meta.event': { $in: ['join', 'br_join'] } }).sort({ createdAt: -1 }).lean(),
            Transaction.find({
                userId: uid,
                type: 'withdraw',
                'meta.reason': { $regex: /Arena Cashout|Admin Forced Cashout|Auto Room Reset|BR Victory/i },
            }).sort({ createdAt: 1 }).lean(),
        ]);

        let totalDepositedSol = 0;
        let totalWithdrawnUsd = 0;
        let depositCount = 0;
        let withdrawalCount = 0;
        let gameJoinCount = 0;
        let deathCount = 0;
        let brWinCount = 0;

        const transactions = allTxs.map(tx => ({
            id: tx._id,
            type: tx.type,
            category: classifyTxActivity(tx),
            label: txActivityLabel(tx),
            amount: tx.amount,
            currency: tx.currency || 'USD',
            amountUsd: Number(txAmountUsd(tx).toFixed(2)),
            amountSol: Number(txAmountSol(tx).toFixed(6)),
            status: tx.status,
            meta: tx.meta,
            excludedFromReports: !!tx.excludedFromReports,
            createdAt: tx.createdAt,
        }));

        for (const tx of allTxs) {
            if (tx.excludedFromReports) continue;
            if (tx.type === 'deposit' && tx.status === 'confirmed') {
                totalDepositedSol += tx.amount;
                depositCount += 1;
            }
            if (tx.type === 'withdraw' && tx.status === 'confirmed' && !['pool_sweep', 'br_owner_sweep', 'reward_owner_surplus_sweep', 'reward_pool_factory_reset'].includes(tx.meta?.event)) {
                totalWithdrawnUsd += txAmountUsd(tx);
                withdrawalCount += 1;
            }
            if (tx.type === 'game' && ['join', 'br_join'].includes(tx.meta?.event)) gameJoinCount += 1;
            if (tx.type === 'game' && ['Arena Death', 'BR Eliminated', 'Competitive Slither Death'].includes(tx.meta?.reason)) deathCount += 1;
            if (tx.type === 'withdraw' && /BR Victory/i.test(tx.meta?.reason || '')) brWinCount += 1;
        }

        const cashoutsByTime = cashoutTxs.map(c => ({ time: new Date(c.createdAt).getTime(), payoutUsd: txAmountUsd(c) }));

        const gameHistory = joinTxs.map(join => {
            const wagerUsd = join.meta?.entryFeeUsd ?? (join.amount * SOL_PRICE_USD);
            const game = join.meta?.mode || join.meta?.variant || 'agar';
            const joinTime = new Date(join.createdAt).getTime();

            let outcome = 'Loss';
            let payoutUsd = 0;
            const match = cashoutsByTime.find(c => c.time >= joinTime);
            if (match) {
                payoutUsd = match.payoutUsd;
                if (payoutUsd > wagerUsd) outcome = 'Win';
                else if (payoutUsd >= wagerUsd * 0.99) outcome = 'Break-even';
                else outcome = 'Loss';
            }

            let eventType = join.meta?.event === 'br_join' ? 'br_join' : 'join';
            if (join.meta?.reason === 'Arena Death' || join.meta?.reason === 'BR Eliminated' || join.meta?.reason === 'Competitive Slither Death') eventType = 'death';

            return {
                id: join._id,
                eventType,
                game,
                wagerUsd: Number(wagerUsd.toFixed(2)),
                payoutUsd: Number(payoutUsd.toFixed(2)),
                outcome,
                entryFeeUsd: join.meta?.entryFeeUsd ?? null,
                createdAt: join.createdAt,
                excludedFromReports: !!join.excludedFromReports,
            };
        });

        const wins = gameHistory.filter(g => g.outcome === 'Win' && !g.excludedFromReports).length;
        const losses = gameHistory.filter(g => g.outcome === 'Loss' && !g.excludedFromReports).length;
        const balanceSol = user.balance ?? 0;

        const modeMap = new Map();
        const ensureMode = (mode) => {
            const key = String(mode || 'unknown').toLowerCase();
            if (!modeMap.has(key)) modeMap.set(key, { mode: key, games: 0, deaths: 0, cashouts: 0, entryUsd: 0, payoutUsd: 0 });
            return modeMap.get(key);
        };
        let sponsoredRewardsClaimedUsd = 0;
        let tournamentRewardsEarnedUsd = 0;
        let tournamentRewardsClaimedUsd = 0;

        for (const tx of allTxs) {
            const event = tx.meta?.event;
            const reason = tx.meta?.reason || '';
            if (tx.type === 'game' && ['join', 'br_join'].includes(event)) {
                const mode = event === 'br_join'
                    ? ('br-' + (tx.meta?.variant || tx.meta?.mode || 'unknown'))
                    : (tx.meta?.mode || 'agar');
                const row = ensureMode(mode);
                row.games += 1;
                row.entryUsd += Number(tx.meta?.entryFeeUsd ?? txAmountUsd(tx)) || 0;
            }
            if (tx.type === 'game' && ['Arena Death', 'BR Eliminated', 'Competitive Slither Death'].includes(reason)) {
                const fallbackMode = reason === 'Competitive Slither Death' ? 'competitive-slither' : reason === 'BR Eliminated' ? 'battle-royale' : 'agar';
                ensureMode(tx.meta?.mode || tx.meta?.variant || fallbackMode).deaths += 1;
            }
            if (tx.type === 'withdraw' && /Arena Cashout|Admin Forced Cashout|Auto Room Reset|BR Victory/i.test(reason)) {
                const fallbackMode = /BR Victory/i.test(reason) ? 'battle-royale' : 'arena';
                const row = ensureMode(tx.meta?.mode || tx.meta?.variant || fallbackMode);
                row.cashouts += 1;
                row.payoutUsd += txAmountUsd(tx);
            }
            if (event === 'sponsored_rewards_claim') sponsoredRewardsClaimedUsd += Number(tx.meta?.amountUsd ?? txAmountUsd(tx)) || 0;
            if (event === 'tournament_reward') tournamentRewardsEarnedUsd += Number(tx.meta?.amountUsd ?? txAmountUsd(tx)) || 0;
            if (event === 'tournament_reward_claim') tournamentRewardsClaimedUsd += Number(tx.meta?.amountUsd ?? txAmountUsd(tx)) || 0;
        }

        const modeBreakdown = [...modeMap.values()]
            .map(row => ({ ...row, entryUsd: Number(row.entryUsd.toFixed(2)), payoutUsd: Number(row.payoutUsd.toFixed(2)) }))
            .sort((a, b) => b.games - a.games || b.cashouts - a.cashouts);
        const latestActivityAt = allTxs[0]?.createdAt || objectIdCreatedAt(user._id);

        res.json({
            user: {
                id: user._id,
                username: user.username,
                email: user.email || null,
                wallet: user.walletAddress || '—',
                depositAddress: user.depositAddress || '—',
                balanceSol: Number(balanceSol.toFixed(6)),
                balanceUsd: Number((balanceSol * SOL_PRICE_USD).toFixed(2)),
                playtime: user.playtime ?? 0,
                createdAt: objectIdCreatedAt(user._id),
                latestActivityAt,
                excludedFromReports: !!user.excludedFromReports,
                isOwnerAccount: !!user.isOwnerAccount,
                rewardsDisabled: !!user.rewardsDisabled,
                rewardsDisabledReason: user.rewardsDisabledReason || '',
            },
            rewards: {
                hasFreeTicket: !!user.hasFreeTicket,
                freeTicketUsed: !!user.freeTicketUsed,
                challengeCompleted: !!user.sponsoredRewardsCompleted,
                challengeUnlocked: !!user.sponsoredRewardsUnlocked,
                completedFiveDollarGames: user.completedFiveDollarNormalGames ?? 0,
                completedTenDollarGames: user.completedTenDollarNormalGames ?? 0,
                sponsoredBalanceUsd: Number((user.sponsoredRewardsBalance ?? 0).toFixed(2)),
                fundedUsd: Number((user.fundedRewardsUsd ?? 0).toFixed(2)),
                retainedWinningsUsd: Number((user.rentFallbackBalanceUsd ?? 0).toFixed(2)),
                sponsoredClaimedUsd: Number(sponsoredRewardsClaimedUsd.toFixed(2)),
                claimInProgress: !!user.rewardClaimInProgress,
                claimReservedUsd: Number((user.rewardClaimReservedUsd ?? 0).toFixed(2)),
                tournamentBalanceUsd: Number((user.tournamentRewardsBalance ?? 0).toFixed(2)),
                tournamentBalanceLamports: user.tournamentRewardsLamports ?? 0,
                tournamentEarnedUsd: Number(tournamentRewardsEarnedUsd.toFixed(2)),
                tournamentClaimedUsd: Number(tournamentRewardsClaimedUsd.toFixed(2)),
                tournamentClaimInProgress: !!user.tournamentRewardClaimInProgress,
                tournamentClaimReservedUsd: Number((user.tournamentRewardClaimReservedUsd ?? 0).toFixed(2)),
                totalAvailableUsd: Number(((user.sponsoredRewardsBalance ?? 0) + (user.rentFallbackBalanceUsd ?? 0) + (user.tournamentRewardsBalance ?? 0)).toFixed(2)),
            },
            stats: {
                totalDepositedSol: Number(totalDepositedSol.toFixed(6)),
                totalDepositedUsd: Number((totalDepositedSol * SOL_PRICE_USD).toFixed(2)),
                totalWithdrawnUsd: Number(totalWithdrawnUsd.toFixed(2)),
                depositCount,
                withdrawalCount,
                gamesPlayed: gameJoinCount,
                wins,
                losses,
                deaths: deathCount,
                brWins: brWinCount,
                modeBreakdown,
                lastActiveAt: latestActivityAt,
                netGameResultUsd: Number((totalWithdrawnUsd - (totalDepositedSol * SOL_PRICE_USD)).toFixed(2)),
            },
            transactions,
            gameHistory,
        });
    } catch (err) {
        console.error('Admin user detail error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users/:userId/sponsored-control', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { action } = req.body; // 'grant_ticket', 'revoke_ticket', 'reset_challenges', 'manual_unlock'
        
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ message: 'Invalid user id' });
        }
        
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        
        if (action === 'grant_ticket') {
            if (user.rewardsDisabled) {
                return res.status(409).json({ message: 'Resolve the linked-wallet alert in Reward Alerts first.' });
            }
            user.hasFreeTicket = true;
            user.freeTicketUsed = false;
            await user.save();
            return res.json({ success: true, message: 'Free ticket granted successfully.', user });
        } else if (action === 'revoke_ticket') {
            user.hasFreeTicket = false;
            user.freeTicketUsed = true;
            await user.save();
            return res.json({ success: true, message: 'Free ticket revoked successfully.', user });
        } else if (action === 'reset_challenges') {
            user.completedFiveDollarNormalGames = 0;
            user.completedTenDollarNormalGames = 0;
            user.sponsoredRewardsUnlocked = false;
            user.sponsoredRewardsCompleted = false;
            await user.save();
            return res.json({ success: true, message: 'Challenge progress reset successfully.', user });
        } else if (action === 'manual_unlock') {
            // Unlock only. Payout must go through the same atomic reward-claim ledger as every user claim.
            if (user.rewardsDisabled) {
                return res.status(409).json({ message: 'Resolve the linked-wallet alert in Reward Alerts first.' });
            }
            user.sponsoredRewardsUnlocked = true;
            user.sponsoredRewardsCompleted = true;
            await user.save();
            return res.json({ success: true, message: 'Sponsored rewards unlocked; user can now claim safely.', user });
        } else {
            return res.status(400).json({ message: 'Invalid action' });
        }
    } catch (err) {
        console.error('Admin sponsored control error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/reward-security-alerts', authenticateAdmin, async (req, res) => {
    try {
        const [alerts, pendingClaims] = await Promise.all([
            RewardSecurityAlert.find({})
                .sort({ status: -1, createdAt: -1 })
                .limit(200)
                .populate('userIds', 'username email depositAddress rewardsDisabled')
                .lean(),
            RewardClaim.find({ status: { $in: ['reserved', 'broadcast'] } })
                .sort({ createdAt: 1 })
                .populate('userId', 'username email')
                .lean(),
        ]);
        res.json({ alerts, pendingClaims });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/reward-security-alerts/:alertId/resolve', authenticateAdmin, async (req, res) => {
    try {
        const alert = await resolveRewardSecurityAlert(
            req.params.alertId,
            req.body?.action,
            req.user.id,
            req.body?.note,
        );
        res.json({ success: true, alert });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});
app.get('/api/admin/dashboard/betting-history', authenticateAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        const joinMatch = await reportedTxMatch({ type: 'game', 'meta.event': 'join' });
        const joins = await Transaction.find(joinMatch)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        const userIds = [...new Set(joins.map(j => j.userId?.toString()).filter(Boolean))];
        const users = await User.find({ _id: { $in: userIds } }).select('username').lean();
        const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u.username]));

        const cashoutMatch = await reportedTxMatch({
            userId: { $in: userIds },
            type: 'withdraw',
            'meta.reason': { $regex: /Arena Cashout|Admin Forced Cashout|Auto Room Reset/i },
        });
        const cashouts = await Transaction.find(cashoutMatch).sort({ createdAt: 1 }).lean();

        const cashoutsByUser = {};
        for (const c of cashouts) {
            const uid = c.userId?.toString();
            if (!uid) continue;
            if (!cashoutsByUser[uid]) cashoutsByUser[uid] = [];
            cashoutsByUser[uid].push(c);
        }

        const history = joins.map(join => {
            const uid = join.userId?.toString();
            const wagerUsd = join.meta?.entryFeeUsd ?? (join.amount * SOL_PRICE_USD);
            const game = join.meta?.mode || 'agar';
            const joinTime = new Date(join.createdAt).getTime();

            let outcome = 'Loss';
            let payoutUsd = 0;

            const userCashouts = cashoutsByUser[uid] || [];
            const match = userCashouts.find(c => new Date(c.createdAt).getTime() >= joinTime);
            if (match) {
                payoutUsd = match.amount;
                outcome = payoutUsd > wagerUsd ? 'Win' : (payoutUsd > 0 ? 'Loss' : 'Loss');
                if (payoutUsd > wagerUsd) outcome = 'Win';
                else if (payoutUsd >= wagerUsd * 0.99) outcome = 'Break-even';
                else outcome = 'Loss';
            }

            return {
                id: join._id,
                userId: uid,
                username: userMap[uid] || 'Unknown',
                game,
                wagerUsd: Number(wagerUsd.toFixed(2)),
                payoutUsd: Number(payoutUsd.toFixed(2)),
                outcome,
                playedAt: join.createdAt,
            };
        });

        res.json({ history, total: history.length });
    } catch (err) {
        console.error('Admin betting-history error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/dashboard/wallets', authenticateAdmin, async (req, res) => {
    try {
        let mainHouse = null;
        if (HOUSE_WALLET_ADDRESS) {
            const lamports = await connection.getBalance(new solanaWeb3.PublicKey(HOUSE_WALLET_ADDRESS));
            mainHouse = {
                label: 'Main Arena House',
                address: HOUSE_WALLET_ADDRESS,
                balanceSol: lamports / solanaWeb3.LAMPORTS_PER_SOL,
                balanceUsd: (lamports / solanaWeb3.LAMPORTS_PER_SOL) * SOL_PRICE_USD,
                sweptOnReset: true,
            };
        }

        const brWallets = [];
        for (const w of listBRHouseWallets()) {
            const lamports = await connection.getBalance(new solanaWeb3.PublicKey(w.address));
            brWallets.push({
                label: `BR ${w.variant} $${w.entryFeeUsd}`,
                variant: w.variant,
                entryFeeUsd: w.entryFeeUsd,
                address: w.address,
                balanceSol: lamports / solanaWeb3.LAMPORTS_PER_SOL,
                balanceUsd: (lamports / solanaWeb3.LAMPORTS_PER_SOL) * SOL_PRICE_USD,
                sweptOnReset: false,
            });
        }

        let ownerVault = null;
        if (OWNER_VAULT_ADDRESS) {
            const lamports = await connection.getBalance(new solanaWeb3.PublicKey(OWNER_VAULT_ADDRESS));
            ownerVault = {
                label: 'Owner Vault',
                address: OWNER_VAULT_ADDRESS,
                balanceSol: lamports / solanaWeb3.LAMPORTS_PER_SOL,
                balanceUsd: (lamports / solanaWeb3.LAMPORTS_PER_SOL) * SOL_PRICE_USD,
            };
        }

        let rewardWallet = null;
        if (REWARD_WALLET_ADDRESS) {
            try {
                const lamports = await connection.getBalance(new solanaWeb3.PublicKey(REWARD_WALLET_ADDRESS));
                rewardWallet = {
                    label: 'Reward Pool',
                    address: REWARD_WALLET_ADDRESS,
                    balanceSol: lamports / solanaWeb3.LAMPORTS_PER_SOL,
                    balanceUsd: (lamports / solanaWeb3.LAMPORTS_PER_SOL) * SOL_PRICE_USD,
                    inMemoryBalanceUsd: Number(getCachedPendingRewardUsd().toFixed(2)),
                };
            } catch (err) {
                console.error('Failed to fetch reward wallet balance:', err.message);
                rewardWallet = {
                    label: 'Reward Pool',
                    address: REWARD_WALLET_ADDRESS,
                    balanceSol: 0,
                    balanceUsd: 0,
                    inMemoryBalanceUsd: Number(getCachedPendingRewardUsd().toFixed(2)),
                    error: err.message,
                };
            }
        }
        let tournamentWallet = null;
        if (TOURNAMENT_WALLET_ADDRESS) {
            try {
                const lamports = await connection.getBalance(new solanaWeb3.PublicKey(TOURNAMENT_WALLET_ADDRESS));
                tournamentWallet = {
                    label: 'Tournament Wallet',
                    address: TOURNAMENT_WALLET_ADDRESS,
                    balanceSol: lamports / solanaWeb3.LAMPORTS_PER_SOL,
                    balanceUsd: (lamports / solanaWeb3.LAMPORTS_PER_SOL) * SOL_PRICE_USD,
                };
            } catch (err) {
                console.error('Failed to fetch tournament wallet balance:', err.message);
                tournamentWallet = {
                    label: 'Tournament Wallet',
                    address: TOURNAMENT_WALLET_ADDRESS,
                    balanceSol: 0,
                    balanceUsd: 0,
                    error: err.message,
                };
            }
        }

        const roomPools = rooms.map(r => ({
            entryFeeUsd: r.entryFeeUsd,
            foodPoolBalance: r.foodPoolBalance,
            aiBudgetBalance: r.aiBudgetBalance,
            ownerBalance: r.ownerBalance,
            playersInRoom: r.players.filter(p => !p.isBot).length,
        }));

        res.json({
            mainHouse,
            brWallets,
            ownerVault,
            rewardWallet,
            tournamentWallet,
            roomPools,
            solPrice: SOL_PRICE_USD,
            devFreePlay: DEV_FREE_PLAY,
        });
    } catch (err) {
        console.error('Admin wallets error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/dashboard/sweeps', authenticateAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        const sweepEvents = {
            $or: [
                { 'meta.event': 'pool_sweep' },
                { 'meta.event': 'br_owner_sweep' },
                { 'meta.event': 'reward_owner_surplus_sweep' },
                { 'meta.event': 'reward_pool_factory_reset' },
                { 'meta.reason': 'Room Reset Wallet Sweep' },
                { 'meta.reason': 'BR Owner Cut Sweep' },
                { 'meta.event': 'reset_start' },
                { 'meta.event': 'reset_complete' },
                { 'meta.event': 'failure', 'meta.reason': 'pool_sweep_failed' },
                { 'meta.event': 'failure', 'meta.reason': 'br_owner_sweep_failed' },
            ],
        };
        const match = await reportedTxMatch(sweepEvents);
        const sweeps = await Transaction.find(match).sort({ createdAt: -1 }).limit(limit).lean();

        const history = sweeps.map(tx => {
            const sol = tx.meta?.solAmount ?? (tx.currency === 'SOL' ? tx.amount : null);
            const usd = sol != null ? sol * SOL_PRICE_USD : tx.amount;
            let kind = 'sweep';
            if (tx.meta?.event === 'br_owner_sweep') kind = 'br_owner_sweep';
            else if (tx.meta?.event === 'reward_owner_surplus_sweep') kind = 'reward_owner_surplus_sweep';
            else if (tx.meta?.event === 'reward_pool_factory_reset') kind = 'reward_pool_factory_reset';
            else if (tx.meta?.event === 'reset_start') kind = 'reset_start';
            else if (tx.meta?.event === 'reset_complete') kind = 'reset_complete';
            else if (tx.meta?.reason === 'pool_sweep_failed' || tx.meta?.reason === 'br_owner_sweep_failed') kind = 'sweep_failed';

            return {
                id: tx._id,
                kind,
                solAmount: sol != null ? Number(sol.toFixed(6)) : null,
                usdAmount: usd != null ? Number(usd.toFixed(2)) : null,
                signature: tx.meta?.signature || null,
                from: tx.meta?.from || HOUSE_WALLET_ADDRESS || null,
                destination: tx.meta?.destination || OWNER_VAULT_ADDRESS || null,
                reason: tx.meta?.reason || tx.meta?.event || '—',
                status: tx.status,
                createdAt: tx.createdAt,
            };
        });

        const ownerEarnings = await computeOwnerEarnings();

        res.json({
            sweeps: history,
            totalSweptUsd: ownerEarnings.totalUsd,
            totalSweptSol: ownerEarnings.totalSol,
            total: history.length,
        });
    } catch (err) {
        console.error('Admin sweeps error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/dashboard/live-feed', authenticateAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
        const sinceRaw = req.query.since;
        const since = sinceRaw ? new Date(sinceRaw) : null;
        const hasSince = since && !Number.isNaN(since.getTime());

        const noiseFilter = {
            'meta.event': { $nin: ['reset_start', 'reset_complete', 'failure'] },
        };
        const baseMatch = await reportedTxMatch(noiseFilter);
        const timeClause = hasSince ? { createdAt: { $gt: since } } : {};
        const filter = Object.keys(timeClause).length
            ? { $and: [baseMatch, timeClause] }
            : baseMatch;

        const [txs, inGamePlayers] = await Promise.all([
            Transaction.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
            (async () => {
                const players = [];
                for (const room of rooms) {
                    for (const p of room.players) {
                        if (!p.isBot && p.mongoId) {
                            players.push({
                                id: p.mongoId.toString(),
                                username: p.username,
                                mode: p.mode || 'agar',
                                entryFeeUsd: room.entryFeeUsd,
                            });
                        }
                    }
                }
                for (const room of competitiveSlitherRooms) {
                    for (const p of room.players) {
                        if (p.mongoId) {
                            players.push({
                                id: p.mongoId.toString(),
                                username: p.username,
                                mode: 'competitive-slither',
                                entryFeeUsd: room.entryFeeUsd,
                            });
                        }
                    }
                }
                return players;
            })(),
        ]);

        const userIds = [...new Set(txs.map(t => t.userId?.toString()).filter(Boolean))];
        const users = await User.find({ _id: { $in: userIds } }).select('username').lean();
        const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u.username]));

        const feed = txs.map(tx => {
            const row = mapTxToAdminRow(tx, userMap);
            return {
                ...row,
                game: tx.meta?.mode || tx.meta?.variant || null,
                entryFeeUsd: tx.meta?.entryFeeUsd ?? null,
            };
        });

        res.json({
            feed,
            inGamePlayers,
            currentlyInGame: inGamePlayers.length,
            serverTime: new Date().toISOString(),
            since: hasSince ? since.toISOString() : null,
        });
    } catch (err) {
        console.error('Admin live-feed error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/dashboard/transactions', authenticateAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);
        const showExcluded = req.query.showExcluded === 'true';
        const filter = await buildAdminTxQuery({
            userId: req.query.userId,
            showExcluded,
            type: req.query.type || '',
            category: req.query.category || '',
            search: req.query.search || '',
        });

        if (filter._id === null) {
            return res.json({ transactions: [], total: 0, showExcluded });
        }

        const txs = await Transaction.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
        const userIds = [...new Set(txs.map(t => t.userId?.toString()).filter(Boolean))];
        const users = await User.find({ _id: { $in: userIds } }).select('username').lean();
        const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u.username]));

        const rows = txs.map(tx => mapTxToAdminRow(tx, userMap));

        res.json({
            transactions: rows,
            total: rows.length,
            showExcluded,
            filters: {
                userId: req.query.userId || null,
                type: req.query.type || null,
                category: req.query.category || null,
                search: req.query.search || null,
            },
        });
    } catch (err) {
        console.error('Admin transactions error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/dashboard/game-history', authenticateAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
        const eventFilter = {
            $or: [
                { type: 'game', 'meta.event': 'join' },
                { type: 'game', 'meta.event': 'br_join' },
                { type: 'game', 'meta.reason': 'Arena Death' },
                { type: 'game', 'meta.reason': 'BR Eliminated' },
                { type: 'game', 'meta.reason': 'Competitive Slither Death' },
                { type: 'game', 'meta.event': 'br_refund' },
                { type: 'withdraw', 'meta.reason': { $regex: /Arena Cashout|Admin Forced Cashout|Auto Room Reset|BR Victory/i } },
            ]
        };
        const skipUserExclusion = !!req.query.userId;
        const reported = await reportedTxMatch({}, { skipUserExclusion });
        const andClauses = [eventFilter, reported];
        if (req.query.userId) andClauses.push({ userId: req.query.userId });

        const eventType = req.query.eventType || '';
        if (eventType === 'entry') {
            andClauses.push({ type: 'game', 'meta.event': { $in: ['join', 'br_join'] } });
        } else if (eventType === 'death') {
            andClauses.push({ type: 'game', 'meta.reason': { $in: ['Arena Death', 'BR Eliminated', 'Competitive Slither Death'] } });
        } else if (eventType === 'cashout') {
            andClauses.push({ type: 'withdraw', 'meta.reason': { $regex: /Arena Cashout|Admin Forced Cashout|Auto Room Reset|BR Victory/i } });
        } else if (eventType === 'refund') {
            andClauses.push({ type: 'game', 'meta.event': 'br_refund' });
        }

        const filter = { $and: andClauses };

        const events = await Transaction.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
        const userIds = [...new Set(events.map(e => e.userId?.toString()).filter(Boolean))];
        const users = await User.find({ _id: { $in: userIds } }).select('username').lean();
        const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u.username]));

        const history = events.map(tx => {
            let eventType = tx.meta?.event || tx.meta?.reason || tx.type;
            if (tx.meta?.event === 'join' || tx.meta?.event === 'br_join') eventType = 'join';
            else if (tx.meta?.reason === 'Arena Death' || tx.meta?.reason === 'BR Eliminated' || tx.meta?.reason === 'Competitive Slither Death') eventType = 'death';
            else if (/BR Victory/i.test(tx.meta?.reason || '')) eventType = 'br_win';
            else if (/Arena Cashout/i.test(tx.meta?.reason || '')) eventType = 'cashout';
            else if (/Auto Room Reset/i.test(tx.meta?.reason || '')) eventType = 'reset_cashout';
            else if (/Admin Forced/i.test(tx.meta?.reason || '')) eventType = 'admin_cashout';

            const mode = tx.meta?.mode || tx.meta?.variant || '—';
            const entryFee = tx.meta?.entryFeeUsd ?? null;

            return {
                id: tx._id,
                userId: tx.userId?.toString() || null,
                username: tx.userId ? (userMap[tx.userId.toString()] || 'Unknown') : '—',
                eventType,
                game: mode,
                amountUsd: Number(txAmountUsd(tx).toFixed(2)),
                entryFeeUsd: entryFee,
                meta: tx.meta,
                createdAt: tx.createdAt,
            };
        });

        res.json({ history, total: history.length });
    } catch (err) {
        console.error('Admin game-history error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/transactions/exclude', authenticateAdmin, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'ids array required' });
        }
        const objectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
        const result = await Transaction.updateMany(
            { _id: { $in: objectIds } },
            { $set: { excludedFromReports: true } }
        );
        res.json({
            success: true,
            modified: result.modifiedCount,
            message: `${result.modifiedCount} transaction(s) excluded from reports (not deleted).`,
        });
    } catch (err) {
        console.error('Admin exclude transactions error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/transactions/restore', authenticateAdmin, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'ids array required' });
        }
        const objectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
        const result = await Transaction.updateMany(
            { _id: { $in: objectIds } },
            { $set: { excludedFromReports: false } }
        );
        res.json({
            success: true,
            modified: result.modifiedCount,
            message: `${result.modifiedCount} transaction(s) restored to reports.`,
        });
    } catch (err) {
        console.error('Admin restore transactions error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users/owner-status', authenticateAdmin, async (req, res) => {
    try {
        const { ids, isOwnerAccount } = req.body;
        if (!Array.isArray(ids) || ids.length === 0 || typeof isOwnerAccount !== 'boolean') {
            return res.status(400).json({ message: 'ids array and isOwnerAccount boolean required' });
        }
        const objectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
        if (objectIds.length === 0) return res.status(400).json({ message: 'No valid user ids' });

        const result = await setOwnerAccountStatus(objectIds, isOwnerAccount);
        res.json({
            success: true,
            modified: result.modifiedCount,
            alertsRemoved: result.alertsRemoved,
            message: isOwnerAccount
                ? `${objectIds.length} account(s) marked as yours and exempted from shared-wallet reward alerts.`
                : `${objectIds.length} account(s) removed from your accounts and checked against shared-wallet rules.`,
        });
    } catch (err) {
        console.error('Admin owner account update error:', err);
        res.status(500).json({ error: err.message });
    }
});
app.post('/api/admin/users/exclude', authenticateAdmin, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'ids array required' });
        }
        const objectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
        const result = await User.updateMany(
            { _id: { $in: objectIds } },
            { $set: { excludedFromReports: true } }
        );
        res.json({
            success: true,
            modified: result.modifiedCount,
            message: `${result.modifiedCount} account(s) excluded from reports — all their transactions are hidden from stats (not deleted).`,
        });
    } catch (err) {
        console.error('Admin exclude users error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users/restore', authenticateAdmin, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'ids array required' });
        }
        const objectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
        const result = await User.updateMany(
            { _id: { $in: objectIds } },
            { $set: { excludedFromReports: false } }
        );
        res.json({
            success: true,
            modified: result.modifiedCount,
            message: `${result.modifiedCount} account(s) restored to reports.`,
        });
    } catch (err) {
        console.error('Admin restore users error:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- ADMIN TOOLS ---
app.get('/api/admin/room-balances', authenticateAdmin, (req, res) => {
    res.json({
        rooms: rooms.map(r => ({
            entryFeeUsd: r.entryFeeUsd,
            foodPoolBalance: r.foodPoolBalance,
            aiBudgetBalance: r.aiBudgetBalance,
            ownerBalance: r.ownerBalance,
            players: r.players.filter(p => !p.isBot).length,
        })),
    });
});

app.post('/api/admin/set-competitive-dollar-balance', authenticateAdmin, async (req, res) => {
    const { userId, dollarBalance } = req.body;
    const balance = Number(dollarBalance);
    if (!userId || !Number.isFinite(balance) || balance < 0) {
        return res.status(400).json({ message: 'userId and non-negative dollarBalance required' });
    }
    try {
        let compFound = null;
        for (const room of competitiveSlitherRooms) {
            const compPlayer = room.players.find(pl => pl.mongoId?.toString() === userId);
            if (compPlayer) {
                compFound = { room, player: compPlayer };
                break;
            }
        }
        if (!compFound) {
            return res.status(404).json({ message: 'Player not active in Competitive Slither' });
        }
        compFound.player.dollarBalance = balance;
        await Transaction.create({
            type: 'game',
            amount: 0,
            meta: {
                event: 'admin_action',
                action: 'set_competitive_dollar_balance',
                target: userId,
                newValue: balance,
            },
        });
        res.json({ success: true, dollarBalance: balance });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.post('/api/admin/set-player-balance', authenticateAdmin, async (req, res) => {
    const { userId, balance } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).send("User not found");
        user.balance = balance;
        await user.save();

        // Also update if they are active in-game
        for (const room of rooms) {
            const p = room.players.find(pl => pl.mongoId.toString() === userId);
            if (p) {
                p.dollarBalance = balance;
                p.balance = balance;
                break;
            }
        }

        await Transaction.create({ type: 'game', amount: 0, meta: { event: 'admin_action', action: 'set_balance', target: userId, newValue: balance } });
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/admin/set-bot-balance', authenticateAdmin, (req, res) => {
    const { botId, balance } = req.body;
    for (const room of rooms) {
        const bot = room.bots.find(b => b.id === botId);
        if (bot) {
            bot.dollarBalance = balance;
            bot.balance = balance;
            return res.json({ success: true, entryFeeUsd: room.entryFeeUsd });
        }
    }
    res.status(404).send("Bot not found");
});

app.get('/api/admin/dashboard/server-status', authenticateAdmin, (req, res) => {
    const now = Date.now();
    const resetAt = GLOBAL_ARENA_START + c.roomDuration;
    const msUntilReset = Math.max(0, resetAt - now);
    const resetting = isArenaResetting();

    res.json({
        serverTime: now,
        arenaStartedAt: GLOBAL_ARENA_START,
        arenaDurationMs: c.roomDuration,
        arenaResetAt: resetAt,
        msUntilReset: resetting ? 0 : msUntilReset,
        msElapsed: now - GLOBAL_ARENA_START,
        isResetting: resetting,
        devFreePlay: DEV_FREE_PLAY,
        sweepScope: 'main_house_wallet_only',
        brUntouchedOnArenaReset: true,
        mainHouseWallet: HOUSE_WALLET_ADDRESS || null,
        ownerVault: OWNER_VAULT_ADDRESS || null,
        arenaRooms: rooms.map(room => ({
            entryFeeUsd: room.entryFeeUsd,
            playerCount: room.players.filter(p => !p.isBot).length,
            foodPoolBalance: room.foodPoolBalance,
            aiBudgetBalance: room.aiBudgetBalance,
            ownerBalance: room.ownerBalance,
            isResetting: room.isResetting,
        })),
        competitiveSlitherRooms: competitiveSlitherRooms.map(room => ({
            entryFeeUsd: room.entryFeeUsd,
            playerCount: room.players.filter(p => !p.disconnected).length,
            isResetting: room.isResetting,
        })),
        battleRoyale: getBRServerStatus(),
    });
});

app.post('/api/admin/trigger-reset', authenticateAdmin, (req, res) => {
    if (globalArenaResetting || rooms.some(r => r.isResetting)) {
        return res.status(409).json({ message: 'Arena reset already in progress' });
    }
    performGlobalArenaReset();
    res.json({
        success: true,
        message: 'Global arena reset started. Main house wallet will be swept. BR wallets and active BR matches are not affected.',
    });
});

app.post('/api/admin/trigger-sweep', authenticateAdmin, async (req, res) => {
    if (globalArenaResetting || rooms.some(r => r.isResetting)) {
        return res.status(409).json({ message: 'Cannot sweep while arena reset is in progress' });
    }
    try {
        const result = await performGlobalArenaReset();
        if (!result?.success) {
            return res.status(409).json({
                message: 'Reset + sweep deferred until every player cashout has settled.',
                reason: result?.reason || 'reset_in_progress',
            });
        }
        res.json({
            success: true,
            message: 'Full arena reset completed: players cashed out, pools cleared, and main house wallet swept. BR wallets were not touched.',
            wallet: HOUSE_WALLET_ADDRESS || null,
        });
    } catch (err) {
        console.error('Admin manual sweep failed:', err);
        res.status(500).json({ error: err.message });
    }
});

async function sweepTournamentWalletToOwner() {
    if (!TOURNAMENT_WALLET_ADDRESS || !TOURNAMENT_WALLET_SECRET || !OWNER_VAULT_ADDRESS) {
        throw new Error('Tournament wallet or Owner Vault is not configured');
    }
    const tournamentPubKey = new solanaWeb3.PublicKey(TOURNAMENT_WALLET_ADDRESS);
    const ownerPubKey = new solanaWeb3.PublicKey(OWNER_VAULT_ADDRESS);
    
    const balanceLamports = await connection.getBalance(tournamentPubKey);
    const rentExempt = await getSystemAccountRentLamports();
    const feeBuffer = 15000;
    
    const sweepLamports = balanceLamports - rentExempt - feeBuffer;
    if (sweepLamports <= 0) {
        throw new Error('Insufficient balance in tournament wallet to sweep (must exceed rent exemption + fee)');
    }
    
    const tournamentKeypair = solanaWeb3.Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(TOURNAMENT_WALLET_SECRET, 'hex'))
    );
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const sweepTx = new solanaWeb3.Transaction({ recentBlockhash: blockhash, feePayer: tournamentPubKey }).add(
        solanaWeb3.SystemProgram.transfer({
            fromPubkey: tournamentPubKey,
            toPubkey: ownerPubKey,
            lamports: sweepLamports,
        })
    );
    
    const signature = await solanaWeb3.sendAndConfirmTransaction(
        connection,
        sweepTx,
        [tournamentKeypair],
        { commitment: 'confirmed', maxRetries: 3, lastValidBlockHeight }
    );
    
    const solAmount = sweepLamports / solanaWeb3.LAMPORTS_PER_SOL;
    const amountUsd = solAmount * SOL_PRICE_USD;
    await Transaction.create({
        type: 'withdraw',
        amount: amountUsd,
        status: 'confirmed',
        user: null,
        meta: {
            event: 'tournament_owner_sweep',
            reason: 'Tournament Wallet Sweep',
            solAmount,
            signature,
            verifiedOnChain: true,
            sourceWallet: TOURNAMENT_WALLET_ADDRESS,
            destinationWallet: OWNER_VAULT_ADDRESS
        }
    });
    
    return { signature, solAmount, amountUsd };
}

app.post('/api/admin/tournaments/trigger-sweep', authenticateAdmin, async (req, res) => {
    try {
        const result = await sweepTournamentWalletToOwner();
        res.json({
            success: true,
            message: `Tournament wallet swept successfully. Sent ${result.solAmount.toFixed(6)} SOL ($${result.amountUsd.toFixed(2)}) to owner vault.`,
            signature: result.signature,
        });
    } catch (err) {
        console.error('Tournament manual sweep failed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/reward-pool/factory-reset', authenticateAdmin, async (req, res) => {
    if (req.body?.confirmation !== 'RESET REWARD POOL') {
        return res.status(400).json({ message: 'Exact confirmation phrase required.' });
    }
    if (rewardPoolAdminResetting) {
        return res.status(409).json({ message: 'Reward pool maintenance is already running.' });
    }

    rewardPoolAdminResetting = true;
    try {
        if (joiningUsers.size > 0) {
            return res.status(409).json({ message: 'Wait for current player joins to finish before resetting.' });
        }
        const activeHumans = [...rooms, ...competitiveSlitherRooms, ...survivRooms]
            .reduce((total, room) => total + room.players.filter(player => !player.isBot).length, 0);
        if (activeHumans > 0) {
            return res.status(409).json({ message: `Cannot reset while ${activeHumans} human arena player(s) are still active.` });
        }

        const [liabilities, activeClaims, currentRewardState] = await Promise.all([
            User.aggregate([{ $group: {
                _id: null,
                sponsoredUsd: { $sum: { $ifNull: ['$sponsoredRewardsBalance', 0] } },
                rentFallbackUsd: { $sum: { $ifNull: ['$rentFallbackBalanceUsd', 0] } },
                reservedUsd: { $sum: { $ifNull: ['$rewardClaimReservedUsd', 0] } },
            } }]),
            RewardClaim.countDocuments({ status: { $in: ['reserved', 'broadcast'] } }),
            RewardPoolState.findOne({ key: 'global' }).lean(),
        ]);
        const liabilityUsd = Math.max(0,
            (liabilities[0]?.sponsoredUsd || 0)
            + (liabilities[0]?.rentFallbackUsd || 0)
            + (liabilities[0]?.reservedUsd || 0));
        if (['reserved', 'broadcast'].includes(currentRewardState?.ownerSurplusSweep?.status)) {
            return res.status(409).json({ message: 'Wait for the active owner-surplus sweep to finish first.' });
        }
        if (activeClaims > 0) {
            await RewardClaim.updateMany(
                { status: { $in: ['reserved', 'broadcast'] } },
                { $set: { status: 'failed', error: 'Cancelled by admin factory reset' } }
            );
        }
        if (!REWARD_WALLET_ADDRESS || !REWARD_WALLET_SECRET || !OWNER_VAULT_ADDRESS) {
            return res.status(400).json({ message: 'Reward wallet or owner vault is not configured.' });
        }

        const rewardKeypair = solanaWeb3.Keypair.fromSecretKey(
            Uint8Array.from(Buffer.from(REWARD_WALLET_SECRET, 'hex'))
        );
        if (rewardKeypair.publicKey.toBase58() !== REWARD_WALLET_ADDRESS) {
            return res.status(500).json({ message: 'Reward wallet address does not match configured secret.' });
        }

        const [walletLamports, rentMinimum, blockhashInfo] = await Promise.all([
            connection.getBalance(rewardKeypair.publicKey),
            getSystemAccountRentLamports(),
            connection.getLatestBlockhash('confirmed'),
        ]);
        const grossSurplus = Math.max(0, walletLamports - rentMinimum);
        const bufferLamports = Math.ceil(grossSurplus * 0.05);
        const retainedLamports = rentMinimum + bufferLamports;
        let signature = null;
        let sweptLamports = 0;

        if (walletLamports > retainedLamports) {
            const feeProbe = new solanaWeb3.Transaction({
                recentBlockhash: blockhashInfo.blockhash,
                feePayer: rewardKeypair.publicKey,
            }).add(solanaWeb3.SystemProgram.transfer({
                fromPubkey: rewardKeypair.publicKey,
                toPubkey: new solanaWeb3.PublicKey(OWNER_VAULT_ADDRESS),
                lamports: 1,
            }));
            const feeResult = await connection.getFeeForMessage(feeProbe.compileMessage(), 'confirmed');
            const feeLamports = feeResult.value ?? 5_000;
            sweptLamports = Math.max(0, walletLamports - retainedLamports - feeLamports);

            if (sweptLamports > 0) {
                if (!await canReceiveSystemTransfer(OWNER_VAULT_ADDRESS, sweptLamports)) {
                    return res.status(409).json({
                        message: 'The amount is below Solana rent minimum for an empty owner vault. Let it accumulate first.',
                    });
                }
                const transaction = new solanaWeb3.Transaction({
                    recentBlockhash: blockhashInfo.blockhash,
                    feePayer: rewardKeypair.publicKey,
                }).add(solanaWeb3.SystemProgram.transfer({
                    fromPubkey: rewardKeypair.publicKey,
                    toPubkey: new solanaWeb3.PublicKey(OWNER_VAULT_ADDRESS),
                    lamports: sweptLamports,
                }));
                signature = await solanaWeb3.sendAndConfirmTransaction(
                    connection,
                    transaction,
                    [rewardKeypair],
                    { commitment: 'confirmed', lastValidBlockHeight: blockhashInfo.lastValidBlockHeight, maxRetries: 3 },
                );
            }
        }

        await User.updateMany({ rewardsDisabled: { $ne: true } }, { $set: {
            hasFreeTicket: true,
            freeTicketUsed: false,
            completedFiveDollarNormalGames: 0,
            completedTenDollarNormalGames: 0,
            sponsoredRewardsUnlocked: false,
            sponsoredRewardsCompleted: false,
            sponsoredRewardsBalance: 0,
            fundedRewardsUsd: 0,
            rentFallbackBalanceUsd: 0,
            rewardClaimInProgress: false,
            rewardClaimReservedUsd: 0,
            activeRewardClaimId: null,
        } });

        await User.updateMany({ rewardsDisabled: true }, { $set: {
            hasFreeTicket: false,
            freeTicketUsed: true,
            completedFiveDollarNormalGames: 0,
            completedTenDollarNormalGames: 0,
            sponsoredRewardsUnlocked: false,
            sponsoredRewardsCompleted: false,
            sponsoredRewardsBalance: 0,
            fundedRewardsUsd: 0,
            rentFallbackBalanceUsd: 0,
            rewardClaimInProgress: false,
            rewardClaimReservedUsd: 0,
            activeRewardClaimId: null,
        } });
        await RewardSecurityAlert.updateMany(
            { 'snapshots.0': { $exists: true } },
            { $set: {
                'snapshots.$[].hasFreeTicket': true,
                'snapshots.$[].freeTicketUsed': false,
                'snapshots.$[].completedFiveDollarNormalGames': 0,
                'snapshots.$[].completedTenDollarNormalGames': 0,
                'snapshots.$[].sponsoredRewardsUnlocked': false,
                'snapshots.$[].sponsoredRewardsCompleted': false,
                'snapshots.$[].sponsoredRewardsBalance': 0,
                'snapshots.$[].fundedRewardsUsd': 0,
            } },
        );
        await resetRewardPoolAccounting();

        await Transaction.create({
            userId: req.user.id,
            type: 'withdraw',
            amount: sweptLamports / solanaWeb3.LAMPORTS_PER_SOL,
            currency: 'SOL',
            meta: {
                event: 'reward_pool_factory_reset',
                reason: 'Admin Reward Pool Factory Reset',
                signature: signature || 'no_transfer_required',
                solAmount: sweptLamports / solanaWeb3.LAMPORTS_PER_SOL,
                amountUsd: (sweptLamports / solanaWeb3.LAMPORTS_PER_SOL) * SOL_PRICE_USD,
                retainedBufferUsd: (bufferLamports / solanaWeb3.LAMPORTS_PER_SOL) * SOL_PRICE_USD,
                discardedPlayerRewardUsd: liabilityUsd,
                from: REWARD_WALLET_ADDRESS,
                destination: OWNER_VAULT_ADDRESS,
            },
            status: 'confirmed',
        }).catch(err => console.error('Reward pool reset audit log failed:', err.message));

        return res.json({
            success: true,
            message: `Reward pool and all account reward states reset to pre-free-ticket. Swept ${(sweptLamports / solanaWeb3.LAMPORTS_PER_SOL).toFixed(6)} SOL and retained a 5% buffer ($${((bufferLamports / solanaWeb3.LAMPORTS_PER_SOL) * SOL_PRICE_USD).toFixed(2)}).`,
            signature,
        });
    } catch (err) {
        await logSolanaTransactionError('Reward pool factory reset failed:', err);
        return res.status(500).json({ message: err.message });
    } finally {
        rewardPoolAdminResetting = false;
    }
});


// Dev-only reset endpoint (no JWT — uses DEV_RESET_SECRET header)
app.post('/api/dev/trigger-reset', async (req, res) => {
    const secret = req.headers['x-dev-reset-secret'];
    if (!process.env.DEV_RESET_SECRET || secret !== process.env.DEV_RESET_SECRET) {
        return res.status(403).json({ message: 'Invalid or missing DEV_RESET_SECRET' });
    }
    if (globalArenaResetting || rooms.some(r => r.isResetting)) {
        return res.status(409).json({ message: 'Reset already in progress' });
    }
    performGlobalArenaReset();
    res.json({ success: true, message: 'Global reset sequence initiated' });
});

app.get('/api/dev/room-status', async (req, res) => {
    const secret = req.headers['x-dev-reset-secret'];
    if (!process.env.DEV_RESET_SECRET || secret !== process.env.DEV_RESET_SECRET) {
        return res.status(403).json({ message: 'Invalid or missing DEV_RESET_SECRET' });
    }
    const arenaResetting = globalArenaResetting || rooms.some(r => r.isResetting);
    let houseBalanceSol = null;
    if (HOUSE_WALLET_ADDRESS) {
        const lamports = await connection.getBalance(new solanaWeb3.PublicKey(HOUSE_WALLET_ADDRESS));
        houseBalanceSol = lamports / solanaWeb3.LAMPORTS_PER_SOL;
    }
    const brHouseWallets = {};
    for (const w of listBRHouseWallets()) {
        const key = `${w.variant}_${w.entryFeeUsd}`;
        const lamports = await connection.getBalance(new solanaWeb3.PublicKey(w.address));
        brHouseWallets[key] = {
            variant: w.variant,
            entryFeeUsd: w.entryFeeUsd,
            address: w.address,
            balanceSol: lamports / solanaWeb3.LAMPORTS_PER_SOL,
        };
    }
    res.json({
        isResetting: arenaResetting,
        globalArenaStart: GLOBAL_ARENA_START,
        roomDurationMs: c.roomDuration,
        rooms: rooms.map(room => ({
            id: room.id,
            entryFeeUsd: room.entryFeeUsd,
            playerCount: room.players.filter(p => !p.isBot).length,
            foodPoolBalance: room.foodPoolBalance,
            aiBudgetBalance: room.aiBudgetBalance,
            ownerBalance: room.ownerBalance,
        })),
        houseWalletSol: houseBalanceSol,
        brHouseWallets,
        ownerVaultConfigured: !!OWNER_VAULT_ADDRESS,
    });
});

app.post('/api/admin/force-cashout', authenticateAdmin, async (req, res) => {
    const { userId } = req.body;
    try {
        let found = null;
        for (const room of rooms) {
            const p = room.players.find(pl => pl.mongoId.toString() === userId);
            if (p) { found = { room, player: p }; break; }
        }
        if (!found) {
            for (const room of competitiveSlitherRooms) {
                const compP = room.players.find(pl => pl.mongoId.toString() === userId);
                if (compP) {
                    found = { room, player: compP };
                    break;
                }
            }
        }
        if (!found) return res.status(404).send("Player not in arena");

        const { room, player: p } = found;
        if (p.mode === 'competitive-slither') {
            if (!acquireCashoutLock(p.mongoId)) {
                return res.status(409).json({ message: 'Cashout already in progress for this player' });
            }
            try {
                await executeCompetitiveCashout(p, room, 'Admin Forced Cashout');
                return res.json({ success: true, competitive: true });
            } finally {
                releaseCashoutLock(p.mongoId);
            }
        }

        if (!acquireCashoutLock(p.mongoId)) {
            return res.status(409).json({ message: 'Cashout already in progress for this player' });
        }

        try {
            await executeArenaCashout(p, room, 'Admin Forced Cashout');
            return res.json({ success: true });
        } finally {
            releaseArenaCashoutReservation(room, p);
            releaseCashoutLock(p.mongoId);
        }
    } catch (err) { res.status(500).send(err.message); }
});

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/agario_db";

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    .then(async () => {
        await hydrateRewardPoolState();
        console.log("Ansluten till databasen och reward-poolen återställd!");
    })
    .catch(err => console.error("Kunde inte ansluta:", err));

// 3. REGISTRERING (Spara ny användare)
app.post('/api/register', sensitiveRateLimit({ limit: 5, windowMs: 60 * 60_000 }), async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const username = String(req.body?.username || '').trim();
        const password = String(req.body?.password || '');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address' });
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ message: 'Username must be 3–20 letters, numbers, or underscores' });
        if (password.length < 8 || password.length > 128) return res.status(400).json({ message: 'Password must be at least 8 characters' });

        const existingUser = await User.findOne({ $or: [{ username }, { email }] });
        if (existingUser) return res.status(400).json({ message: 'Username or email already taken' });
        const keypair = solanaWeb3.Keypair.generate();
        const newUser = new User({
            email,
            username,
            password: await bcrypt.hash(password, 10),
            balance: 0,
            depositAddress: keypair.publicKey.toBase58(),
            depositSecret: Buffer.from(keypair.secretKey).toString('hex'),
        });
        await newUser.save();
        return res.status(201).json({
            message: 'Account created!',
            userId: newUser._id.toString(),
            username: newUser.username,
        });
    } catch (err) {
        console.error('Registration error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});
// 4. INLOGGNING (Verifiera användare)
app.post('/api/login', async (req, res) => {
    console.log("Mottog inloggningsförfrågan:", req.body.username);
    try {
        const { username, password } = req.body;

        // Hitta användaren via username ELLER email
        console.log("Söker efter användare för inloggning:", username);
        const user = await User.findOne({ $or: [{ username: username }, { email: username }] });
        console.log("Användare hittad i DB:", user ? "JA" : "NEJ");

        if (!user) {
            console.log("❌ FAIL: Användaren hittades inte:", username);
            return res.status(400).json({ message: "Användaren finns inte" });
        }

        // Jämför lösenordet med det i databasen
        console.log("Verifierar lösenord...");
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            console.log("❌ FAIL: Fel lösenord för:", username);
            return res.status(400).json({ message: "Fel lösenord" });
        }
        console.log("Lösenord matchar!");
        await ensureUserDepositWallet(user);

        // Skapa en JWT (Inloggningskvitto). Använd en hemlig nyckel från .env
        const secret = JWT_SECRET;
        const token = jwt.sign({ id: user._id }, secret, { expiresIn: '7d' });

        console.log("✅ SUCCESS: Inloggning lyckades, skickar token för:", username);
        res.json({
            token,
            user: {
                id: user._id,
                username: user.username,
                balanceSol: user.balance,
                balanceUsd: user.balance * SOL_PRICE_USD,
                solPrice: SOL_PRICE_USD
            }
        });
    } catch (err) {
        console.error("Fel vid inloggning:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Site-wide presence (pregame + any page polling /api/stats with X-Presence-Id)
const sitePresence = new Map();
const PRESENCE_TTL_MS = 90_000;

function touchSitePresence(req, customKey = null) {
    let ip = 'unknown';
    if (req) {
        let rawIp = (req.headers ? (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) : null) || req.ip;
        if (rawIp) {
            if (rawIp.includes(',')) {
                ip = rawIp.split(',')[0].trim();
            } else {
                ip = rawIp.trim();
            }
        }
    }
    if (ip === '::1' || ip === '::ffff:127.0.0.1') {
        ip = '127.0.0.1';
    }

    // Retrieve presence ID from headers if available
    let presenceId = req && req.headers ? req.headers['x-presence-id'] : null;
    
    // If customKey looks like a valid presence ID (UUID) or is not a socket.id, use it
    if (customKey && !presenceId) {
        if (customKey.includes('-') || customKey.startsWith('p-')) {
            presenceId = customKey;
        }
    }

    // Final key is either the stable presence ID or the IP address. If both are missing, fall back to customKey/unknown.
    const key = presenceId || (ip && ip !== 'unknown' ? ip : (customKey || 'unknown'));
    if (!key || key === 'unknown' || (typeof key === 'string' && key.length === 20 && !key.includes('-'))) {
        // Skip transient socket IDs (alphanumeric, length 20, no hyphens)
        return;
    }

    const existing = sitePresence.get(String(key)) || {};
    let country = existing.country || 'Unknown';
    let userAgent = existing.userAgent || 'Unknown';
    let page = existing.page || 'unknown';
    let gamemode = existing.gamemode || 'none';

    if (req && req.headers) {
        country = req.headers['cf-ipcountry'] || country;
        userAgent = req.headers['user-agent'] || userAgent;
        page = req.headers['x-presence-page'] || page;
        gamemode = req.headers['x-presence-gamemode'] || gamemode;
    }

    sitePresence.set(String(key), {
        lastSeen: Date.now(),
        ip,
        country,
        userAgent,
        page,
        gamemode
    });
}

function getSiteUsersOnline() {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    const uniqueIps = new Set();
    for (const [key, data] of sitePresence) {
        const seenAt = typeof data === 'number' ? data : data.lastSeen;
        if (seenAt < cutoff) {
            sitePresence.delete(key);
        } else {
            let ip = data.ip || 'unknown';
            if (ip.includes(',')) ip = ip.split(',')[0].trim();
            if (ip === '::1' || ip === '::ffff:127.0.0.1') ip = '127.0.0.1';
            
            if (ip && ip !== 'unknown') {
                uniqueIps.add(ip);
            } else {
                uniqueIps.add(key);
            }
        }
    }
    return Math.max(1, uniqueIps.size);
}

app.post('/api/presence/ping', (req, res) => {
    try {
        touchSitePresence(req);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Exponera live stats för lobby och pre-game
app.get('/api/stats', (req, res) => {
    try {
        touchSitePresence(req);

        const modeFilter = req.query.mode === 'slither' ? 'slither' : req.query.mode === 'agar' ? 'agar' : null;
        let filteredHumansOnline = 0;
        let filteredAiOnline = 0;
        let topPlayer = null;
        let topBalance = 0;
        const filteredPlayers = [];
        const agarPlayers = [];
        const slitherPlayers = [];
        const playersByEntryFee = { 5: 0, 10: 0, 20: 0 };
        const playersByModeAndFee = {
            agar: { 5: 0, 10: 0, 20: 0 },
            slither: { 5: 0, 10: 0, 20: 0 },
        };
        const playersByGamemode = { agar: 0, slither: 0, brAgar: 0, brSlither: 0, competitiveSlither: 0, surviv: 0 };
        let totalBotsOnline = 0;

        const pushTop = (list, name, balance) => {
            if (name && balance > 0) list.push({ username: name, balance });
        };

        const considerFilteredTop = (name, balance) => {
            const b = balance || 0;
            if (b > topBalance) {
                topBalance = b;
                topPlayer = name;
            }
            if (name && b > 0) filteredPlayers.push({ username: name, balance: b });
        };

        const countBRForMode = (variant) => {
            const br = getBRPlayerCountsByFee();
            const fees = br[variant] || {};
            return Object.values(fees).reduce((sum, n) => sum + (n || 0), 0);
        };

        rooms.forEach(room => {
            const fee = room.entryFeeUsd ?? DEFAULT_ENTRY_FEE;
            room.players.forEach(player => {
                if (!player.disconnected) {
                    const mode = player.mode === 'slither' ? 'slither' : 'agar';
                    if (!playersByEntryFee[fee]) playersByEntryFee[fee] = 0;
                    playersByEntryFee[fee] += 1;
                    if (playersByModeAndFee[mode]) {
                        playersByModeAndFee[mode][fee] = (playersByModeAndFee[mode][fee] || 0) + 1;
                        playersByGamemode[mode] += 1;
                    }
                    pushTop(mode === 'agar' ? agarPlayers : slitherPlayers, player.username, arenaCashoutUsd(player));
                    if (!modeFilter || mode === modeFilter) {
                        filteredHumansOnline += 1;
                        considerFilteredTop(player.username, arenaCashoutUsd(player));
                    }
                }
            });
            room.bots.forEach(bot => {
                totalBotsOnline += 1;
                const botUsd = bot.dollarBalance ?? bot.balance ?? bot.cells?.reduce((s, c) => s + c.balance, 0) ?? 0;
                playersByGamemode.agar += 1;
                pushTop(agarPlayers, bot.username, botUsd);
                if (!modeFilter || modeFilter === 'agar') {
                    filteredAiOnline += 1;
                    considerFilteredTop(bot.username, botUsd);
                }
            });
            room.slitherBots.forEach(bot => {
                totalBotsOnline += 1;
                playersByGamemode.slither += 1;
                const botUsd = bot.dollarBalance ?? bot.balance;
                pushTop(slitherPlayers, bot.username, botUsd);
                if (!modeFilter || modeFilter === 'slither') {
                    filteredAiOnline += 1;
                    considerFilteredTop(bot.username, botUsd);
                }
            });
        });

        const brPlayersByFee = getBRPlayerCountsByFee();
        playersByGamemode.brAgar = (brPlayersByFee.agar?.[5] || 0) + (brPlayersByFee.agar?.[10] || 0);
        playersByGamemode.brSlither = (brPlayersByFee.slither?.[5] || 0) + (brPlayersByFee.slither?.[10] || 0);
        playersByGamemode.competitiveSlither = competitiveSlitherRooms.reduce(
            (sum, room) => sum + room.players.filter(p => !p.disconnected).length,
            0,
        );
        const survivHumanCount = survivRooms.reduce(
            (sum, room) => sum + room.players.filter(p => !p.disconnected && p.hp > 0).length,
            0,
        );
        const survivBotCount = survivRooms.reduce(
            (sum, room) => sum + room.bots.filter(bot => bot.hp > 0).length,
            0,
        );
        playersByGamemode.surviv = survivHumanCount + survivBotCount;
        totalBotsOnline += survivBotCount;

        const totalPlayersOnline = playersByGamemode.agar + playersByGamemode.slither
            + playersByGamemode.brAgar + playersByGamemode.brSlither
            + playersByGamemode.competitiveSlither + playersByGamemode.surviv;

        if (modeFilter === 'agar') {
            filteredHumansOnline += countBRForMode('agar');
        } else if (modeFilter === 'slither') {
            filteredHumansOnline += countBRForMode('slither');
        }

        const sortTop = (list) => list.sort((a, b) => b.balance - a.balance).slice(0, 3);
        const topPlayers = filteredPlayers.sort((a, b) => b.balance - a.balance).slice(0, 3);
        const topPlayersByGamemode = {
            agar: sortTop(agarPlayers),
            slither: sortTop(slitherPlayers),
        };

        res.json({
            playersOnline: filteredHumansOnline + filteredAiOnline,
            totalPlayersOnline,
            siteUsersOnline: getSiteUsersOnline(),
            totalBotsOnline,
            biggestPayout: Number(topBalance.toFixed(2)),
            topPlayer,
            topBalance: Number(topBalance.toFixed(2)),
            topPlayers,
            topPlayersByGamemode,
            recentBRVictories: getRecentBRVictories(),
            solPrice: SOL_PRICE_USD,
            playersByEntryFee,
            playersByModeAndFee,
            playersByGamemode,
            brPlayersByFee,
            globalPlayerEarningsSol,
            globalPlayerEarningsUsd,
            totalUserBalanceSol: globalPlayerEarningsSol,
            totalUserBalanceUsd: globalPlayerEarningsUsd,
            statsMode: modeFilter,
        });
    } catch (err) {
        console.error('Error fetching stats:', err);
        res.status(500).json({ error: 'Unable to fetch stats' });
    }
});

async function buildLeaderboardRankings({ since = null } = {}) {
    const match = await reportedTxMatch({
        ...buildGameCashoutTxFilter(),
        ...(since ? { createdAt: { $gte: since } } : {}),
    });
    const txs = await Transaction.find(match).select('userId amount currency meta').lean();
    const totalsByUser = {};
    for (const tx of txs) {
        const uid = tx.userId?.toString();
        if (!uid) continue;
        totalsByUser[uid] = (totalsByUser[uid] || 0) + txAmountUsd(tx);
    }

    const sorted = Object.entries(totalsByUser)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    if (!sorted.length) return [];

    const users = await User.find({ _id: { $in: sorted.map(([id]) => id) } }).select('username').lean();
    const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u.username]));

    return sorted.map(([userId, amount]) => ({
        username: userMap[userId] || 'Unknown',
        amount: Number(amount.toFixed(2)),
    }));
}

// 7. Leaderboard - all time and this week
app.get('/api/leaderboard', async (req, res) => {
    try {
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - 7);

        const [alltime, week, globalEarningsUsd] = await Promise.all([
            buildLeaderboardRankings(),
            buildLeaderboardRankings({ since: weekStart }),
            sumGameCashoutUsd(),
        ]);

        res.json({ alltime, week, globalEarningsUsd });
    } catch (err) {
        console.error('Error fetching leaderboard:', err);
        res.status(500).json({ error: 'Unable to fetch leaderboard' });
    }
});

app.get('/api/leaderboard-live', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
        const baseMatch = await reportedTxMatch({
            $or: [
                buildGameCashoutTxFilter(),
                { type: 'game', 'meta.reason': { $in: ['Arena Death', 'BR Eliminated', 'Competitive Slither Death'] } },
            ],
        });

        const txs = await Transaction.find(baseMatch).sort({ createdAt: -1 }).limit(limit).lean();
        const userIds = [...new Set(txs.map(t => t.userId?.toString()).filter(Boolean))];
        const users = await User.find({ _id: { $in: userIds } }).select('username').lean();
        const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u.username]));

        const events = txs.map((tx) => {
            const username = tx.userId ? (userMap[tx.userId.toString()] || 'Unknown') : 'Unknown';
            const amountUsd = Number(txAmountUsd(tx).toFixed(2));
            const isDeath = tx.type === 'game' && ['Arena Death', 'BR Eliminated', 'Competitive Slither Death'].includes(tx.meta?.reason);
            const text = isDeath
                ? `${username} died with $${amountUsd.toFixed(2)}`
                : `${username} cashed out $${amountUsd.toFixed(2)}`;

            return {
                id: tx._id?.toString(),
                userId: tx.userId?.toString() || null,
                username,
                amountUsd,
                type: isDeath ? 'death' : 'cashout',
                text,
                createdAt: tx.createdAt,
            };
        });

        res.json({
            events,
            serverTime: new Date().toISOString(),
        });
    } catch (err) {
        console.error('Error fetching live leaderboard:', err);
        res.status(500).json({ error: 'Unable to fetch live leaderboard' });
    }
});

// Hämta användartransaktioner (deposits, withdrawals, game tx)
app.get('/api/transactions', authenticateToken, async (req, res) => {
    try {
        const { filter } = req.query;
        let query = { userId: req.user.id };

        if (filter === 'external') {
            query.$or = [
                {
                    type: 'deposit',
                    'meta.entryFor': { $ne: 'arena-entry' },
                    'meta.isEntryPayment': { $ne: true }
                },
                {
                    type: 'withdraw',
                    'meta.destination': { $exists: true },
                    'meta.reason': { $not: /Arena Cashout|Admin Forced Cashout|Auto Room Reset|BR Victory|BR Refund/i },
                    'meta.event': { $nin: ['pool_sweep', 'br_owner_sweep', 'reward_owner_surplus_sweep', 'reward_pool_factory_reset'] }
                },
                {
                    type: 'game',
                    'meta.event': { $in: ['sponsored_rewards_claim', 'tournament_reward_claim'] }
                }
            ];
        }

        const txs = await Transaction.find(query).sort({ createdAt: -1 }).limit(200);
        res.json(txs);
    } catch (err) {
        console.error('Error fetching transactions:', err);
        res.status(500).json({ error: 'Unable to fetch transactions' });
    }
});

// Radius beräknas via `util.massToRadius` (sqrt-baserad) för konsistens med klient och Agar.io

function agarFoodDollarValue(f) {
    if (f.dollarValue != null && f.dollarValue > 0) return f.dollarValue;
    return f.balance;
}

function playerMassStart(player) {
    return getEconomy(player?.entryFeeUsd ?? DEFAULT_ENTRY_FEE).massStartBalance;
}

function playerDollarStart(player) {
    return getEconomy(player?.entryFeeUsd ?? DEFAULT_ENTRY_FEE).playerStartBalance;
}

function playerTotalMass(player) {
    if (!Array.isArray(player?.cells)) return 0;
    return player.cells.reduce((sum, cell) => sum + (Number(cell?.balance) || 0), 0);
}

function applyAgarFoodPickup(cell, food, player, room) {
    const eco = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE);
    let massGain = food.balance;
    let dollarGain = food.dollarValue ?? 0;

    if (food.dollarValue == null) {
        dollarGain = food.balance;
        massGain = food.golden ? eco.goldenBlobMass : eco.massPerPellet;
    }

    cell.balance += massGain;
    if (player.dollarBalance != null) {
        player.dollarBalance = (player.dollarBalance || 0) + dollarGain;
    } else {
        cell.balance += dollarGain;
    }
}

function transferAgarDollars(victim, eater, massTaken) {
    if (massTaken <= 1e-9 || victim.dollarBalance == null) return;
    const victimMass = playerTotalMass(victim);
    if (victimMass <= 1e-9) return;
    const share = (victim.dollarBalance || 0) * (massTaken / victimMass);
    if (share <= 1e-9) return;
    if (eater.dollarBalance != null) {
        eater.dollarBalance = (eater.dollarBalance || 0) + share;
    }
    victim.dollarBalance = Math.max(0, victim.dollarBalance - share);
}

function addFood(room, n) {
    const foodBlobValue = foodBlobValueForRoom(room);
    const eco = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE);
    for (let i = 0; i < n; i++) {
        if (room.foodPoolBalance < foodBlobValue) break;
        room.foodPoolBalance -= foodBlobValue;
        room.food.push({
            id: Math.random().toString(36).substr(2, 9),
            x: Math.random() * c.worldWidth,
            y: Math.random() * c.worldHeight,
            hue: Math.floor(Math.random() * 360),
            radius: 5,
            balance: eco.massPerPellet,
            dollarValue: foodBlobValue,
        });
    }
}

function countNormalAgarFood(room) {
    return room.food.filter(f => !f.golden).length;
}

function trimNormalAgarFood(room, targetCount) {
    const golden = room.food.filter(f => f.golden);
    const normal = room.food.filter(f => !f.golden);
    while (normal.length > targetCount) {
        const removed = normal.pop();
        room.foodPoolBalance += agarFoodDollarValue(removed);
    }
    room.food = normal.concat(golden);
}

/** One high-value blob per human join — value already deducted from food allocation. */
function spawnGoldenAgarBlob(room, dollarValue) {
    if (dollarValue <= 1e-9 || room.foodPoolBalance < dollarValue - 1e-9) return;
    room.foodPoolBalance -= dollarValue;
    const eco = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE);
    const pelletMass = eco.massPerPellet;
    room.food.push({
        id: Math.random().toString(36).substr(2, 9),
        x: Math.random() * c.worldWidth,
        y: Math.random() * c.worldHeight,
        hue: 48,
        golden: true,
        radius: Math.min(13, 7 + Math.sqrt(eco.goldenBlobMass / pelletMass) * 1.4),
        balance: eco.goldenBlobMass,
        dollarValue,
    });
}

function applyAgarWealthTax(player, room, minDollars) {
    // Wealth tax decay completely disabled so players do not lose size/balance over time
    return;
}

function addViruses(room, n) {
    for (let i = 0; i < n; i++) {
        room.viruses.push({
            id: Math.random().toString(36).substr(2, 9),
            x: Math.random() * c.worldWidth,
            y: Math.random() * c.worldHeight,
            radius: util.massToRadius(100), // Originalstorlek för virus
            fill: '#33ff33', stroke: '#22cc22', strokeWidth: 4, mass: 100
        });
    }
}

function getModeFoodBudgets(room, agarActive, slitherActive) {
    if (room.isTournament) {
        // Match the amount of score-food a normal $10 join creates, without
        // treating any pellet or bot balance as a real wallet liability.
        return { agar: 0, slither: Math.max(80, slitherActive * 80) };
    }
    const total = agarActive + slitherActive;
    if (total <= 0) {
        return { agar: room.foodPoolBalance, slither: room.foodPoolBalance };
    }
    return {
        agar: room.foodPoolBalance * (agarActive / total),
        slither: room.foodPoolBalance * (slitherActive / total),
    };
}

function getMaxAiBudgetForRoom(room) {
    const stake = botStakeForRoom(room);
    const agarHumans = effectiveHumanCountForBots(room, 'agar');
    const slitherHumans = effectiveHumanCountForBots(room, 'slither');
    return getTargetBots(agarHumans) * stake + getSlitherTargetBots(slitherHumans) * stake;
}

function botStakeForRoom(room) {
    return getEconomy(room.entryFeeUsd).botStartBalance;
}

function foodDensityForRoom(room) {
    return getEconomy(room.entryFeeUsd).foodDensityPerHuman;
}

function foodBlobValueForRoom(room) {
    return getEconomy(room.entryFeeUsd).foodBlobValue;
}

function findPlayerInArena(mongoId) {
    const key = mongoId?.toString();
    for (const room of rooms) {
        const player = room.players.find(p => p.mongoId?.toString() === key);
        if (player) return { room, player };
    }
    for (const room of competitiveSlitherRooms) {
        const player = room.players.find(p => p.mongoId?.toString() === key);
        if (player) return { room, player };
    }
    for (const room of survivRooms) {
        const player = room.players.find(p => p.mongoId?.toString() === key);
        if (player) return { room, player };
    }
    for (const room of tournamentRooms.values()) {
        const player = room.players.find(p => p.mongoId?.toString() === key);
        if (player) return { room, player };
    }
    return null;
}

function getRoomForEntry(entryFeeUsd) {
    const fee = normalizeEntryFee(entryFeeUsd);
    return rooms.find(r => r.entryFeeUsd === fee && !r.isFreeTicketRoom) 
        ?? rooms.find(r => r.entryFeeUsd === DEFAULT_ENTRY_FEE && !r.isFreeTicketRoom);
}

function isArenaResetting() {
    return globalArenaResetting || rooms.some(r => r.isResetting)
        || competitiveSlitherRooms.some(r => r.isResetting)
        || survivRooms.some(r => r.isResetting);
}

function capAiBudget(room) {
    const max = getMaxAiBudgetForRoom(room);
    if (room.aiBudgetBalance > max) {
        room.foodPoolBalance += room.aiBudgetBalance - max;
        room.aiBudgetBalance = max;
    }
}

function acquireCashoutLock(mongoId) {
    const key = mongoId?.toString();
    if (!key || processingCashouts.has(key)) return false;
    processingCashouts.add(key);
    return true;
}

function releaseCashoutLock(mongoId) {
    processingCashouts.delete(mongoId?.toString());
}

function rebuildQuadTree(room, allUsers) {
    room.qt.clear();
    room.food.forEach(f => {
        room.qt.insert(new Point(f.x, f.y, { type: 'food', data: f }));
    });
    room.viruses.forEach(v => {
        room.qt.insert(new Point(v.x, v.y, { type: 'virus', data: v }));
    });
    room.ejected.forEach(e => {
        room.qt.insert(new Point(e.x, e.y, { type: 'ejected', data: e }));
    });
    allUsers.forEach(player => {
        if (!Array.isArray(player.cells)) return;
        for (const cell of player.cells) {
            if (!cell || !Number.isFinite(cell.x) || !Number.isFinite(cell.y)) continue;
            room.qt.insert(new Point(cell.x, cell.y, {
                type: player.isBot ? 'bot' : 'player',
                socketId: player.isBot ? undefined : player.id,
                botId: player.isBot ? player.id : undefined,
                cell,
            }));
        }
    });
}

function addBots(room, n, botStake = null) {
    const botNames = ["Sirius", "Gota", "AgarioMaster", "ProPlayer", "Legit", "Sanic", "Wojak", "Pepe", "Doge", "Spooderman", "U Mad?", "Team Me", "Solo King", "Blobby"];
    const botCost = botStake ?? botStakeForRoom(room);
    const startMass = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE).massStartBalance;
    const spawnCount = Math.min(n, Math.floor(room.aiBudgetBalance / botCost));
    for (let i = 0; i < spawnCount; i++) {
        const id = 'bot_' + Math.random().toString(36).substr(2, 5);
        const randomName = botNames[Math.floor(Math.random() * botNames.length)];
        room.aiBudgetBalance -= botCost;
        room.bots.push({
            id: id,
            username: randomName,
            balance: botCost,
            dollarBalance: botCost,
            botStake: botCost,
            kills: 0,
            color: util.randomColor(),
            isBot: true,
            targetX: Math.random() * c.worldWidth,
            targetY: Math.random() * c.worldHeight,
            lastTargetUpdate: 0,
            cells: [{
                id: Math.random().toString(36).substr(2, 9),
                x: Math.random() * c.worldWidth,
                y: Math.random() * c.worldHeight,
                balance: startMass,
                radius: calculateCellRadius(startMass, startMass, 1, startMass),
            }],
        });
    }
}

// Initiera alla rum
rooms.forEach(room => {
    addViruses(room, c.virusCount);
    // No free AI budget — bots are funded only from entry-fee splits
    room.aiBudgetBalance = 0;
    // Food comes from entry-fee pool when players join — no free seed
    room.foodPoolBalance = 0;
});

function trimAgarBots(room, targetCount) {
    const stake = botStakeForRoom(room);
    while (room.bots.length > targetCount) {
        const index = room.bots.findIndex(b => !b.adminSpawned);
        if (index === -1) break; // Only admin-spawned bots left
        const [removed] = room.bots.splice(index, 1);
        room.aiBudgetBalance += removed?.dollarBalance ?? removed?.botStake ?? removed?.cells?.[0]?.balance ?? stake;
    }
}

function getTargetBots(humanCount) {
    if (humanCount <= 0) return 0;

    // Target a lively arena with a mix of players and bots.
    // The fewer humans, the more bots we spawn to fill the room up to a target size.
    // Max 5 bots per normal game (reduced from 8).
    const targetEntities = 8;
    if (humanCount >= targetEntities) return 0;

    return Math.min(5, targetEntities - humanCount);
}

function countHumansInMode(room, mode) {
    return room.players.filter(p => p.mode === mode || (mode === 'agar' && !p.mode)).length;
}

/** Keep bots alive while humans are disconnected or after death until arena reset. */
function effectiveHumanCountForBots(room, mode) {
    return countActiveHumansByMode(room, mode);
}

function countActiveHumansByMode(room, mode) {
    return room.players.filter(p => !p.disconnected && (p.mode === mode || (mode === 'agar' && !p.mode))).length;
}

// Helper för att beräkna radie med extra tillväxt-effekt
function playerStartBalance(player) {
    return playerDollarStart(player);
}

function ensureAgarMovementInput(player) {
    if (!player || player.isBot || player.mode === 'slither' || player.mode === 'surviv') return;
    const hasRecentInput = player.lastAgarInputAt && Date.now() - player.lastAgarInputAt < 1500;
    const x = Number(player.mouseX);
    const y = Number(player.mouseY);
    if (!Number.isFinite(x) || !Number.isFinite(y) || (!hasRecentInput && Math.hypot(x || 0, y || 0) < 8)) {
        player.mouseX = 220;
        player.mouseY = 0;
    }
}

function resolveAgarOwnCells(player, now, massStart) {
    if (!Array.isArray(player.cells) || player.cells.length < 2) return;

    const cells = player.cells;
    const mergedIds = new Set();
    const mergeDelayMs = c.mergeTimer * 1000;

    for (let i = 0; i < cells.length; i++) {
        const first = cells[i];
        if (mergedIds.has(first.id)) continue;

        for (let j = i + 1; j < cells.length; j++) {
            const second = cells[j];
            if (mergedIds.has(second.id)) continue;

            let dx = second.x - first.x;
            let dy = second.y - first.y;
            let distance = Math.hypot(dx, dy);
            const combinedRadius = first.radius + second.radius;
            if (distance >= combinedRadius) continue;

            if (distance < 0.0001) {
                const direction = first.id < second.id ? 1 : -1;
                dx = direction;
                dy = 0;
                distance = 1;
            }

            const ux = dx / distance;
            const uy = dy / distance;
            const firstMass = Math.max(0.0001, first.balance);
            const secondMass = Math.max(0.0001, second.balance);
            const combinedMass = firstMass + secondMass;
            const firstShare = secondMass / combinedMass;
            const secondShare = firstMass / combinedMass;
            const overlap = combinedRadius - distance;
            const firstAge = now - (first.lastSplit || now);
            const secondAge = now - (second.lastSplit || now);
            const readyToMerge = firstAge >= mergeDelayMs && secondAge >= mergeDelayMs;

            if (!readyToMerge) {
                const mergeReadiness = Math.max(0, Math.min(1, Math.min(firstAge, secondAge) / mergeDelayMs));
                const push = overlap * (0.17 - mergeReadiness * 0.11);
                first.x -= ux * push * firstShare;
                first.y -= uy * push * firstShare;
                second.x += ux * push * secondShare;
                second.y += uy * push * secondShare;
                continue;
            }

            // Ready cells should pull together slightly to create the squishy 'snap' effect
            // when merging, rather than pushing apart.
            const mergeDistance = combinedRadius - Math.min(first.radius, second.radius) * 0.42;
            if (distance > mergeDistance) {
                const pull = 1.5; // Attraction force
                first.x += ux * pull * secondShare;
                first.y += uy * pull * secondShare;
                second.x -= ux * pull * firstShare;
                second.y -= uy * pull * firstShare;
                continue;
            }


            const survivor = firstMass >= secondMass ? first : second;
            const absorbed = survivor === first ? second : first;
            survivor.x = (first.x * firstMass + second.x * secondMass) / combinedMass;
            survivor.y = (first.y * firstMass + second.y * secondMass) / combinedMass;
            survivor.vx = ((first.vx || 0) * firstMass + (second.vx || 0) * secondMass) / combinedMass;
            survivor.vy = ((first.vy || 0) * firstMass + (second.vy || 0) * secondMass) / combinedMass;
            survivor.balance = combinedMass;
            survivor.lastSplit = Math.min(first.lastSplit || now, second.lastSplit || now);
            mergedIds.add(absorbed.id);

            if (absorbed === first) break;
        }
    }

    if (mergedIds.size === 0) return;
    player.cells = cells.filter(cell => !mergedIds.has(cell.id));
    const totalMass = playerTotalMass(player);
    const cellCount = player.cells.length;
    player.cells.forEach(cell => {
        cell.radius = calculateCellRadius(cell.balance, totalMass, cellCount, massStart);
    });
}
function calculateCellRadius(cellMass, playerTotalMass, cellCount, massStart = c.playerStartBalance) {
    const startMassPerCell = massStart / cellCount;
    const extraMass = Math.max(0, cellMass - startMassPerCell);
    const visualMass = cellMass + (extraMass * (c.growthBoost - 1));
    return util.massToRadius(visualMass * c.sizeMult);
}

async function rollbackJoinEconomy(pending, reason) {
    if (!pending) return;
    const { room } = pending;
    room.aiBudgetBalance = pending.aiBudgetBalance;
    room.foodPoolBalance = pending.foodPoolBalance;
    room.fundedEntryUsd = pending.fundedEntryUsd;
    room.ownerBalance = pending.ownerBalance;
    room.bots.splice(0, room.bots.length, ...pending.bots);
    room.slitherBots.splice(0, room.slitherBots.length, ...pending.slitherBots);

    if (pending.rewardFundingUsd > 0) {
        await reducePendingRewardUsd(pending.rewardFundingUsd);
        await Transaction.create({
            userId: pending.userId,
            type: 'game',
            amount: -(pending.rewardFundingUsd / SOL_PRICE_USD),
            currency: 'SOL',
            meta: {
                event: 'reward_pool_correction',
                correctionUsd: -pending.rewardFundingUsd,
                reason: `join_rollback:${String(reason || 'unknown').slice(0, 120)}`,
            },
            status: 'confirmed',
        }).catch(err => console.error('Join rollback correction log failed:', err.message));
    }
}

async function refundPaidJoin(pending, reason) {
    if (!pending || DEV_FREE_PLAY) return;
    try {
        const houseKeypair = solanaWeb3.Keypair.fromSecretKey(
            Uint8Array.from(Buffer.from(HOUSE_WALLET_SECRET, 'hex'))
        );
        const refundTx = new solanaWeb3.Transaction().add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: houseKeypair.publicKey,
                toPubkey: new solanaWeb3.PublicKey(pending.destination),
                lamports: pending.lamports,
            })
        );
        const signature = await solanaWeb3.sendAndConfirmTransaction(connection, refundTx, [houseKeypair]);
        await Transaction.create({
            userId: pending.userId,
            type: 'withdraw',
            amount: pending.lamports / solanaWeb3.LAMPORTS_PER_SOL,
            currency: 'SOL',
            meta: { event: 'entry_refund', reason, originalSignature: pending.signature, signature },
            status: 'confirmed',
        });
    } catch (err) {
        console.error('CRITICAL: automatic paid-entry refund failed:', err.message, pending);
        await Transaction.create({
            userId: pending.userId,
            type: 'game',
            amount: 0,
            meta: { event: 'failure', reason: 'entry_refund_failed', error: err.message, originalSignature: pending.signature },
            status: 'failed',
        }).catch(() => {});
    }
}
async function refundTournamentJoin(pending, reason) {
    if (!pending || DEV_FREE_PLAY || !TOURNAMENT_WALLET_SECRET) return;
    try {
        const tournamentKeypair = solanaWeb3.Keypair.fromSecretKey(
            Uint8Array.from(Buffer.from(TOURNAMENT_WALLET_SECRET, 'hex')),
        );
        const refundTx = new solanaWeb3.Transaction().add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: tournamentKeypair.publicKey,
                toPubkey: new solanaWeb3.PublicKey(pending.destination),
                lamports: pending.lamports,
            }),
        );
        const signature = await solanaWeb3.sendAndConfirmTransaction(connection, refundTx, [tournamentKeypair]);
        await Transaction.create({
            userId: pending.userId,
            type: 'withdraw',
            amount: pending.lamports / solanaWeb3.LAMPORTS_PER_SOL,
            currency: 'SOL',
            meta: { event: 'tournament_entry_refund', reason, tournamentId: pending.tournamentId, signature },
            status: 'confirmed',
        });
    } catch (err) {
        console.error('CRITICAL: tournament entry refund failed:', err.message, pending);
    }
}

io.on('connection', (socket) => {
    const presenceId = socket.handshake.auth?.presenceId || socket.handshake.headers['x-presence-id'] || socket.handshake.address || socket.id;
    touchSitePresence(socket.request, presenceId);

    socket.on('joinTournamentGame', async ({ username, token, tournamentId, skinColor }) => {
        let userKey = null;
        let paidJoin = null;
        let entryRecorded = false;
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            let user = await User.findById(decoded.id);
            if (!user) throw new Error('User not found');
            user = await ensureUserDepositWallet(user);
            userKey = `tournament:${tournamentId}:${user._id}`;
            if (joiningUsers.has(userKey)) throw new Error('Tournament entry is already processing');
            joiningUsers.add(userKey);

            let tournament = await Tournament.findById(tournamentId);
            const now = Date.now();
            if (!tournament || tournament.status !== 'live' || new Date(tournament.endAt).getTime() <= now) {
                throw new Error('This tournament is not live');
            }
            let room = getTournamentRoom(tournament._id);
            if (!room) room = createTournamentArenaRoom(tournament);

            const existingPlayer = room.players.find(p => p.mongoId?.toString() === user._id.toString());
            if (existingPlayer) {
                existingPlayer.id = socket.id;
                existingPlayer.disconnected = false;
                if (existingPlayer.removeTimeout) {
                    clearTimeout(existingPlayer.removeTimeout);
                    delete existingPlayer.removeTimeout;
                }
                socket.roomId = room.id;
                const participant = tournament.participants.find(p => p.userId.toString() === user._id.toString());
                socket.emit('welcome', existingPlayer, {
                    width: SLITHER.worldHalf * 2,
                    height: SLITHER.worldHalf * 2,
                    mode: 'slither',
                    rejoin: true,
                    entryFeeUsd: TOURNAMENT_ENTRY_FEE_USD,
                    solPrice: SOL_PRICE_USD,
                    tournament: true,
                    tournamentId: tournament._id.toString(),
                    tournamentName: tournament.name,
                    tournamentBalanceUsd: participant?.tournamentBalanceUsd || 0,
                    attemptsUsed: participant?.entries || 0,
                    maxAttempts: TOURNAMENT_MAX_ATTEMPTS,
                    tournamentEndAt: tournament.endAt,
                });
                return;
            }

            const activeGame = findPlayerInArena(user._id);
            if (activeGame) throw new Error('Finish or leave your active game before entering the tournament');
            const participant = tournament.participants.find(p => p.userId.toString() === user._id.toString());
            if ((participant?.entries || 0) >= TOURNAMENT_MAX_ATTEMPTS) {
                throw new Error(`You have used all ${TOURNAMENT_MAX_ATTEMPTS} tournament attempts`);
            }

            const feeLamports = Math.round((TOURNAMENT_ENTRY_FEE_USD / SOL_PRICE_USD) * solanaWeb3.LAMPORTS_PER_SOL);
            if (!DEV_FREE_PLAY) {
                if (!TOURNAMENT_WALLET_ADDRESS || !TOURNAMENT_WALLET_SECRET) throw new Error('Tournament wallet not configured');
                const userPubKey = new solanaWeb3.PublicKey(user.depositAddress);
                let currentLamports;
                try {
                    currentLamports = await connection.getBalance(userPubKey);
                } catch (rpcErr) {
                    if (rpcErr.message && (rpcErr.message.includes('429') || rpcErr.message.includes('Too Many Requests'))) {
                        const fallbackConn = new solanaWeb3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
                        currentLamports = await fallbackConn.getBalance(userPubKey);
                    } else {
                        throw rpcErr;
                    }
                }
                const requiredLamports = feeLamports + 15_000 + await getSystemAccountRentLamports();
                if (currentLamports < requiredLamports) {
                    throw new Error('Insufficient SOL for the $1 tournament entry plus the Solana account reserve');
                }
                const userKeypair = solanaWeb3.Keypair.fromSecretKey(
                    Uint8Array.from(Buffer.from(user.depositSecret, 'hex')),
                );
                const tournamentPubKey = new solanaWeb3.PublicKey(TOURNAMENT_WALLET_ADDRESS);
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
                const joinTx = new solanaWeb3.Transaction({ recentBlockhash: blockhash, feePayer: userPubKey }).add(
                    solanaWeb3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
                    solanaWeb3.SystemProgram.transfer({
                        fromPubkey: userPubKey,
                        toPubkey: tournamentPubKey,
                        lamports: feeLamports,
                    }),
                );
                const signature = await solanaWeb3.sendAndConfirmTransaction(
                    connection,
                    joinTx,
                    [userKeypair],
                    { commitment: 'confirmed', maxRetries: 3, lastValidBlockHeight },
                );
                paidJoin = {
                    userId: user._id,
                    destination: user.depositAddress,
                    lamports: feeLamports,
                    tournamentId: tournament._id.toString(),
                    signature,
                };
                // Immediately sync on-chain balance so the UI updates without
                // waiting for the background scanner to run
                try {
                    const newLamports = await getBalanceWithFallback(userPubKey);
                    user.balance = newLamports / solanaWeb3.LAMPORTS_PER_SOL;
                    await user.save();
                } catch (syncErr) {
                    console.warn('[tournament join] post-payment balance sync failed:', syncErr.message);
                }
            } else {
                const feeSol = TOURNAMENT_ENTRY_FEE_USD / SOL_PRICE_USD;
                user.balance = Math.max(0, user.balance - feeSol);
                await user.save();
            }

            const commonUpdate = {
                $inc: {
                    totalEntryFeesUsd: TOURNAMENT_ENTRY_FEE_USD,
                    totalCollectedLamports: feeLamports,
                    totalAttempts: 1,
                },
            };
            tournament = await Tournament.findOneAndUpdate(
                {
                    _id: tournament._id,
                    status: 'live',
                    endAt: { $gt: new Date() },
                    participants: { $elemMatch: { userId: user._id, entries: { $lt: TOURNAMENT_MAX_ATTEMPTS } } },
                },
                { ...commonUpdate, $inc: { ...commonUpdate.$inc, 'participants.$.entries': 1 } },
                { new: true },
            );
            if (!tournament) {
                tournament = await Tournament.findOneAndUpdate(
                    {
                        _id: tournamentId,
                        status: 'live',
                        endAt: { $gt: new Date() },
                        'participants.userId': { $ne: user._id },
                    },
                    {
                        ...commonUpdate,
                        $push: { participants: { userId: user._id, username: user.username, entries: 1 } },
                    },
                    { new: true },
                );
            }
            if (!tournament) {
                await refundTournamentJoin(paidJoin, 'tournament_entry_rejected');
                paidJoin = null;
                throw new Error(`Tournament entry closed or all ${TOURNAMENT_MAX_ATTEMPTS} attempts have been used`);
            }
            entryRecorded = true;

            const economy = getEconomy(TOURNAMENT_GAMEPLAY_ENTRY_FEE_USD);
            const player = createSlitherPlayer(
                socket.id,
                user._id,
                username || user.username,
                typeof skinColor === 'string' ? skinColor : util.randomSlitherColor(),
                room,
                economy.massStartBalance,
                economy.playerStartBalance,
            );
            player.isTournament = true;
            player.tournamentId = tournament._id.toString();
            player.tournamentEntryFeeUsd = TOURNAMENT_ENTRY_FEE_USD;
            player.tournamentAttempt = tournament.participants.find(p => p.userId.toString() === user._id.toString())?.entries || 1;
            room.players.push(player);
            socket.roomId = room.id;

            await Transaction.create({
                userId: user._id,
                type: 'game',
                amount: feeLamports / solanaWeb3.LAMPORTS_PER_SOL,
                currency: 'SOL',
                meta: {
                    event: 'tournament_entry',
                    reason: 'Tournament Entry',
                    tournamentId: tournament._id.toString(),
                    tournamentName: tournament.name,
                    entryFeeUsd: TOURNAMENT_ENTRY_FEE_USD,
                    lamports: feeLamports,
                    attempt: player.tournamentAttempt,
                    signature: paidJoin?.signature || 'simulated_tournament_entry',
                    ...(DEV_FREE_PLAY ? { simulated: true } : {}),
                },
                status: 'confirmed',
            });
            paidJoin = null;

            const latestParticipant = tournament.participants.find(p => p.userId.toString() === user._id.toString());
            socket.emit('welcome', player, {
                width: SLITHER.worldHalf * 2,
                height: SLITHER.worldHalf * 2,
                mode: 'slither',
                rejoin: false,
                entryFeeUsd: TOURNAMENT_ENTRY_FEE_USD,
                solPrice: SOL_PRICE_USD,
                tournament: true,
                tournamentId: tournament._id.toString(),
                tournamentName: tournament.name,
                tournamentBalanceUsd: latestParticipant?.tournamentBalanceUsd || 0,
                attemptsUsed: latestParticipant?.entries || 1,
                maxAttempts: TOURNAMENT_MAX_ATTEMPTS,
                tournamentEndAt: tournament.endAt,
            });
        } catch (err) {
            if (paidJoin) await refundTournamentJoin(paidJoin, err.message || 'tournament_join_failed');
            if (entryRecorded) console.error('Tournament entry was recorded before a later join failure:', err);
            socket.emit('error', err.message || 'Unable to join tournament');
        } finally {
            if (userKey) joiningUsers.delete(userKey);
        }
    });

    socket.on('joinGame', async ({ username, token, mode, entryFeeUsd: rawEntryFee, skinColor, useFreeTicket }) => {
        if (rewardPoolAdminResetting) {
            socket.emit('error', 'Reward pool maintenance is in progress. Try again shortly.');
            return;
        }
        let userKey = null;
        let pendingPaidJoin = null;
        let pendingTicketUserId = null;
        let pendingJoinEconomy = null;
        try {
            if (mode === 'br-agar' || mode === 'br-slither') {
                socket.emit('error', 'Use the Battle Royale queue to join.');
                return;
            }
            let validatedSkinColor = null;
            if (skinColor && typeof skinColor === 'string' && (skinColor === 'random' || /^#[0-9a-fA-F]{6}$/.test(skinColor))) {
                validatedSkinColor = skinColor;
            }
            const decoded = jwt.verify(token, JWT_SECRET);
            let user = await User.findById(decoded.id);
            if (!user) {
                socket.emit('error', 'Account not found — please log in again.');
                return;
            }
            if (user.rewardsDisabled && useFreeTicket) {
                socket.emit('error', 'Rewards are disabled while your linked-wallet review is pending.');
                return;
            }
            user = await ensureUserDepositWallet(user);

            if (getBRMatchForMongo(user._id.toString())) {
                socket.emit('error', 'You are in an active Battle Royale match.');
                return;
            }

            if (isArenaResetting()) {
                socket.emit('error', 'The arena is currently resetting. Please wait a moment.');
                return;
            }

            userKey = user._id.toString();
            if (joiningUsers.has(userKey)) return;
            joiningUsers.add(userKey);

            // ── Competitive Slither ($2 / $5 separate pools) ──
            if (mode === 'competitive-slither') {
                const entryFeeUsd = normalizeCompetitiveEntryFee(rawEntryFee);
                const room = getCompetitiveSlitherRoom(entryFeeUsd);
                removeCompetitiveSpectatorsForUser(room, userKey);
                const existing = findPlayerInArena(userKey);
                if (existing) {
                    if (!existing.room.isCompetitiveSlither) {
                        socket.emit('error', 'You have an active game in another mode. Finish or cash out first.');
                        return;
                    }
                    if (existing.room.entryFeeUsd !== entryFeeUsd) {
                        socket.emit('error', `You have an active $${existing.room.entryFeeUsd} Competitive Slither game. Rejoin that stake tier first.`);
                        return;
                    }
                }

                const existingPlayer = existing?.player ?? null;
                if (existingPlayer) {
                    const oldSocketId = existingPlayer.id;
                    const oldSocket = io.sockets.sockets.get(oldSocketId);
                    if (oldSocket?.connected && oldSocket.id !== socket.id) {
                        oldSocket.emit('forcedDisconnect');
                    }
                    if (existingPlayer.removeTimeout) {
                        clearTimeout(existingPlayer.removeTimeout);
                        delete existingPlayer.removeTimeout;
                    }
                    existingPlayer.id = socket.id;
                    existingPlayer.disconnected = false;
                    socket.roomId = room.id;
                    let remaining = 0;
                    if (existingPlayer.isCashingOut && existingPlayer.cashOutEndTime) {
                        remaining = Math.max(0, Math.ceil((existingPlayer.cashOutEndTime - Date.now()) / 1000));
                    }
                    socket.emit('welcome', existingPlayer, {
                        width: COMPETITIVE_SLITHER.worldHalf * 2,
                        height: COMPETITIVE_SLITHER.worldHalf * 2,
                        cashOutRemaining: remaining,
                        mode: 'competitive-slither',
                        rejoin: true,
                        entryFeeUsd: existingPlayer.entryFeeUsd ?? room.entryFeeUsd,
                        solPrice: SOL_PRICE_USD,
                        competitiveSlither: true,
                        circularMap: true,
                        zone: getCompetitiveZone(room.startTime + c.roomDuration),
                    });
                    return;
                }

                const entryFeeInSol = entryFeeUsd / SOL_PRICE_USD;

                if (!DEV_FREE_PLAY) {
                    const userPubKey = new solanaWeb3.PublicKey(user.depositAddress);
                    const currentLamports = await connection.getBalance(userPubKey);
                    const feeLamports = Math.round(entryFeeInSol * solanaWeb3.LAMPORTS_PER_SOL);
                    const requiredLamports = feeLamports + 15000 + await getSystemAccountRentLamports();
                    if (currentLamports < requiredLamports) {
                        socket.emit('error', `Insufficient SOL for $${entryFeeUsd} entry plus the Solana account reserve. Deposit a little extra SOL and try again.`);
                        return;
                    }
                    try {
                        const userKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(Buffer.from(user.depositSecret, 'hex')));
                        const housePubKey = new solanaWeb3.PublicKey(HOUSE_WALLET_ADDRESS);
                        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
                        const joinTx = new solanaWeb3.Transaction({
                            recentBlockhash: blockhash,
                            feePayer: userPubKey,
                        }).add(
                            solanaWeb3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }),
                            solanaWeb3.SystemProgram.transfer({
                                fromPubkey: userPubKey,
                                toPubkey: housePubKey,
                                lamports: feeLamports,
                            })
                        );
                        const sig = await solanaWeb3.sendAndConfirmTransaction(
                            connection,
                            joinTx,
                            [userKeypair],
                            { commitment: 'confirmed', maxRetries: 3, lastValidBlockHeight }
                        );
                        pendingPaidJoin = { userId: user._id, destination: user.depositAddress, lamports: feeLamports, signature: sig };
                        console.log(`🎟️ Competitive Slither Entry: ${user.username} paid $${entryFeeUsd}. Sig: ${sig}`);
                    } catch (txErr) {
                        await logSolanaTransactionError('Competitive join transaction failed:', txErr);
                        socket.emit('error', 'Blockchain transfer failed. Please try again.');
                        return;
                    }
                } else {
                    user.balance = Math.max(0, user.balance - entryFeeInSol);
                    await user.save();
                    console.log(`🎮 [FREE PLAY] ${user.username} joined Competitive Slither (simulated $${entryFeeUsd} entry)`);
                }

                await Transaction.create({
                    userId: user._id,
                    type: 'game',
                    amount: entryFeeInSol,
                    meta: {
                        event: 'join',
                        roomId: room.id,
                        entryFeeUsd,
                        mode: 'competitive-slither',
                        ...(DEV_FREE_PLAY ? { simulated: true } : {}),
                    },
                    status: 'confirmed',
                });

                socket.roomId = room.id;
                const newPlayer = createCompetitiveSlitherPlayer(
                    socket.id,
                    user._id,
                    username || user.username,
                    validatedSkinColor || util.randomSlitherColor(),
                    room,
                );

                const raced = room.players.find(p => p.mongoId?.toString() === userKey);
                if (raced) {
                    if (pendingPaidJoin) {
                        await refundPaidJoin(pendingPaidJoin, 'duplicate_join_race');
                        pendingPaidJoin = null;
                    }
                    raced.id = socket.id;
                    raced.disconnected = false;
                    socket.emit('welcome', raced, {
                        width: COMPETITIVE_SLITHER.worldHalf * 2,
                        height: COMPETITIVE_SLITHER.worldHalf * 2,
                        mode: 'competitive-slither',
                        rejoin: true,
                        entryFeeUsd,
                        solPrice: SOL_PRICE_USD,
                        competitiveSlither: true,
                        circularMap: true,
                        zone: getCompetitiveZone(room.startTime + c.roomDuration),
                    });
                    return;
                }

                room.players.push(newPlayer);
                pendingPaidJoin = null;
                syncCompetitiveSlitherFood(room, room.players.length);

                socket.emit('welcome', newPlayer, {
                    width: COMPETITIVE_SLITHER.worldHalf * 2,
                    height: COMPETITIVE_SLITHER.worldHalf * 2,
                    mode: 'competitive-slither',
                    rejoin: false,
                    entryFeeUsd,
                    solPrice: SOL_PRICE_USD,
                    competitiveSlither: true,
                    circularMap: true,
                    zone: getCompetitiveZone(room.startTime + c.roomDuration),
                });
                return;
            }

            // ── Surviv ($5 pool) ──
            if (mode === 'surviv') {
                const entryFeeUsd = normalizeSurvivEntryFee(rawEntryFee);
                const room = getSurvivRoom(entryFeeUsd);
                removeSurvivSpectator(room, socket.id);
                const existing = findPlayerInArena(userKey);
                if (existing) {
                    if (!existing.room.isSurviv) {
                        socket.emit('error', 'You have an active game in another mode. Finish or cash out first.');
                        return;
                    }
                }

                const existingPlayer = existing?.player ?? null;
                if (existingPlayer) {
                    const oldSocketId = existingPlayer.id;
                    const oldSocket = io.sockets.sockets.get(oldSocketId);
                    if (oldSocket?.connected && oldSocket.id !== socket.id) {
                        oldSocket.emit('forcedDisconnect');
                    }
                    if (existingPlayer.removeTimeout) {
                        clearTimeout(existingPlayer.removeTimeout);
                        delete existingPlayer.removeTimeout;
                    }
                    existingPlayer.id = socket.id;
                    existingPlayer.disconnected = false;
                    socket.roomId = room.id;
                    let remaining = 0;
                    if (existingPlayer.isCashingOut && existingPlayer.cashOutEndTime) {
                        remaining = Math.max(0, Math.ceil((existingPlayer.cashOutEndTime - Date.now()) / 1000));
                    }
                    socket.emit('welcome', existingPlayer, {
                        width: SURVIV.worldHalf * 2,
                        height: SURVIV.worldHalf * 2,
                        cashOutRemaining: remaining,
                        mode: 'surviv',
                        rejoin: true,
                        entryFeeUsd: existingPlayer.entryFeeUsd ?? room.entryFeeUsd,
                        solPrice: SOL_PRICE_USD,
                        surviv: true,
                        zone: getSurvivZone(room.startTime + c.roomDuration),
                    });
                    return;
                }

                const entryFeeInSol = entryFeeUsd / SOL_PRICE_USD;

                if (!DEV_FREE_PLAY) {
                    const userPubKey = new solanaWeb3.PublicKey(user.depositAddress);
                    const currentLamports = await connection.getBalance(userPubKey);
                    const feeLamports = Math.round(entryFeeInSol * solanaWeb3.LAMPORTS_PER_SOL);
                    const requiredLamports = feeLamports + 15000 + await getSystemAccountRentLamports();
                    if (currentLamports < requiredLamports) {
                        socket.emit('error', `Insufficient SOL for $${entryFeeUsd} entry plus the Solana account reserve. Deposit a little extra SOL and try again.`);
                        return;
                    }
                    try {
                        const userKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(Buffer.from(user.depositSecret, 'hex')));
                        const housePubKey = new solanaWeb3.PublicKey(HOUSE_WALLET_ADDRESS);
                        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
                        const joinTx = new solanaWeb3.Transaction({
                            recentBlockhash: blockhash,
                            feePayer: userPubKey,
                        }).add(
                            solanaWeb3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }),
                            solanaWeb3.SystemProgram.transfer({
                                fromPubkey: userPubKey,
                                toPubkey: housePubKey,
                                lamports: feeLamports,
                            })
                        );
                        const sig = await solanaWeb3.sendAndConfirmTransaction(
                            connection,
                            joinTx,
                            [userKeypair],
                            { commitment: 'confirmed', maxRetries: 3, lastValidBlockHeight }
                        );
                        pendingPaidJoin = { userId: user._id, destination: user.depositAddress, lamports: feeLamports, signature: sig };
                        console.log(`🎟️ Surviv Entry: ${user.username} paid $${entryFeeUsd}. Sig: ${sig}`);
                    } catch (txErr) {
                        await logSolanaTransactionError('Surviv join transaction failed:', txErr);
                        socket.emit('error', 'Blockchain transfer failed. Please try again.');
                        return;
                    }
                } else {
                    user.balance = Math.max(0, user.balance - entryFeeInSol);
                    await user.save();
                    console.log(`🎮 [FREE PLAY] ${user.username} joined Surviv (simulated $${entryFeeUsd} entry)`);
                }

                await Transaction.create({
                    userId: user._id,
                    type: 'game',
                    amount: entryFeeInSol,
                    meta: {
                        event: 'join',
                        roomId: room.id,
                        entryFeeUsd,
                        mode: 'surviv',
                        ...(DEV_FREE_PLAY ? { simulated: true } : {}),
                    },
                    status: 'confirmed',
                });

                socket.roomId = room.id;
                const survivSkinColor = validatedSkinColor === 'random'
                    ? util.randomSlitherColor()
                    : (validatedSkinColor || util.randomSlitherColor());
                const newPlayer = createSurvivPlayer(
                    socket.id,
                    user._id,
                    username || user.username,
                    survivSkinColor,
                    room,
                );

                const raced = room.players.find(p => p.mongoId?.toString() === userKey);
                if (raced) {
                    if (pendingPaidJoin) {
                        await refundPaidJoin(pendingPaidJoin, 'duplicate_join_race');
                        pendingPaidJoin = null;
                    }
                    raced.id = socket.id;
                    raced.disconnected = false;
                    socket.emit('welcome', raced, {
                        width: SURVIV.worldHalf * 2,
                        height: SURVIV.worldHalf * 2,
                        mode: 'surviv',
                        rejoin: true,
                        entryFeeUsd,
                        solPrice: SOL_PRICE_USD,
                        surviv: true,
                        zone: getSurvivZone(room.startTime + c.roomDuration),
                    });
                    return;
                }

                const eco = getSurvivEconomy(entryFeeUsd);
                spawnLootFromPool(room, eco.lootPoolOnJoin);
                room.players.push(newPlayer);
                pendingPaidJoin = null;

                socket.emit('welcome', newPlayer, {
                    width: SURVIV.worldHalf * 2,
                    height: SURVIV.worldHalf * 2,
                    mode: 'surviv',
                    rejoin: false,
                    entryFeeUsd,
                    solPrice: SOL_PRICE_USD,
                    surviv: true,
                    zone: getSurvivZone(room.startTime + c.roomDuration),
                });
                return;
            }

            const entryFeeUsd = normalizeEntryFee(rawEntryFee);
            const gameMode = mode === 'slither' ? 'slither' : 'agar';
            const economy = getEconomy(entryFeeUsd);

            const existing = findPlayerInArena(userKey);
            const isFreeTicketPlay = !!useFreeTicket || !!(existing && existing.room.isFreeTicketRoom);

            if (isFreeTicketPlay && !existing) {
                // First time joining with a free ticket
                if (!user.hasFreeTicket || user.freeTicketUsed) {
                    throw new Error('You do not have an active free ticket or it has already been used.');
                }
                if (entryFeeUsd !== 5) {
                    throw new Error('Free ticket is only valid for $5 games.');
                }
                if (gameMode !== 'agar' && gameMode !== 'slither') {
                    throw new Error('Free ticket is only valid for Agar or Slither normal games.');
                }
            }

            if (existing && existing.room.isCompetitiveSlither) {
                socket.emit('error', 'You have an active Competitive Slither game. Rejoin or cash out first.');
                return;
            }
            if (existing && existing.room.isSurviv) {
                socket.emit('error', 'You have an active Surviv game. Rejoin or cash out first.');
                return;
            }
            if (existing && existing.room.entryFeeUsd !== entryFeeUsd) {
                socket.emit('error', `You have an active $${existing.room.entryFeeUsd} game. Rejoin that stake tier first.`);
                return;
            }
            const existingMode = existing?.player?.mode || null;
            const switchingNormalMode = existing?.room && existingMode && existingMode !== gameMode;

            const room = existing?.room ?? (isFreeTicketPlay ? rooms.find(r => r.id === 'arena-free-ticket') : getRoomForEntry(entryFeeUsd));
            const existingPlayer = switchingNormalMode ? null : (existing?.player ?? null);
            let switchedDollarBalance = null;
            if (switchingNormalMode) {
                const oldPlayer = existing.player;
                switchedDollarBalance = oldPlayer.dollarBalance ?? oldPlayer.balance ?? null;
                if (oldPlayer.removeTimeout) clearTimeout(oldPlayer.removeTimeout);
                const oldSocket = io.sockets.sockets.get(oldPlayer.id);
                if (oldSocket?.connected && oldSocket.id !== socket.id) {
                    oldSocket.emit('forcedDisconnect');
                }
                room.players = room.players.filter(p => p.mongoId?.toString() !== userKey);
                socket.emit('modeSwitched', { from: existingMode, to: gameMode });
            }

            if (existingPlayer) {
                const oldSocketId = existingPlayer.id;
                const oldSocket = io.sockets.sockets.get(oldSocketId);
                if (oldSocket?.connected && oldSocket.id !== socket.id) {
                    console.log(`♻️ User ${user.username} rejoining — replacing live socket ${oldSocketId}`);
                    oldSocket.emit('forcedDisconnect');
                } else {
                    console.log(`♻️ User ${user.username} rejoining session (${existingPlayer.disconnected ? 'was disconnected' : 'same tab'})`);
                }

                if (existingPlayer.removeTimeout) {
                    clearTimeout(existingPlayer.removeTimeout);
                    delete existingPlayer.removeTimeout;
                }

                existingPlayer.id = socket.id;
                existingPlayer.disconnected = false;
                socket.roomId = room.id;
                let remaining = 0;
                if (existingPlayer.isCashingOut && existingPlayer.cashOutEndTime) {
                    remaining = Math.max(0, Math.ceil((existingPlayer.cashOutEndTime - Date.now()) / 1000));
                }
                const rejoinMode = existingPlayer.mode || 'agar';
                socket.emit('welcome', existingPlayer, {
                    width: rejoinMode === 'slither' ? SLITHER.worldHalf * 2 : c.worldWidth,
                    height: rejoinMode === 'slither' ? SLITHER.worldHalf * 2 : c.worldHeight,
                    cashOutRemaining: remaining,
                    mode: rejoinMode,
                    rejoin: true,
                    entryFeeUsd: existingPlayer.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
                    solPrice: SOL_PRICE_USD,
                });
                return;
            }

            // FINANCIAL: Check SOL balance for entry fee
            const entryFeeInSol = entryFeeUsd / SOL_PRICE_USD;

            if (!switchingNormalMode && !DEV_FREE_PLAY && !isFreeTicketPlay) {
                // 1. Kontrollera on-chain balans direkt innan start
                const userPubKey = new solanaWeb3.PublicKey(user.depositAddress);
                const currentLamports = await connection.getBalance(userPubKey);
                const feeLamports = Math.round(entryFeeInSol * solanaWeb3.LAMPORTS_PER_SOL);

                const requiredLamports = feeLamports + 15000 + await getSystemAccountRentLamports();
                if (currentLamports < requiredLamports) {
                    socket.emit('error', `Insufficient SOL for $${entryFeeUsd} entry plus the Solana account reserve. Deposit a little extra SOL and try again.`);
                    return;
                }

                // 2. Utför on-chain transfer: Deposit Address -> House Wallet
                try {
                    const userKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(Buffer.from(user.depositSecret, 'hex')));
                    const housePubKey = new solanaWeb3.PublicKey(HOUSE_WALLET_ADDRESS);
                    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
                    const joinTx = new solanaWeb3.Transaction({
                        recentBlockhash: blockhash,
                        feePayer: userPubKey,
                    }).add(
                        solanaWeb3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }),
                        solanaWeb3.SystemProgram.transfer({
                            fromPubkey: userPubKey,
                            toPubkey: housePubKey,
                            lamports: feeLamports,
                        })
                    );
                    const sig = await solanaWeb3.sendAndConfirmTransaction(
                        connection,
                        joinTx,
                        [userKeypair],
                        { commitment: 'confirmed', maxRetries: 3, lastValidBlockHeight }
                    );
                    pendingPaidJoin = { userId: user._id, destination: user.depositAddress, lamports: feeLamports, signature: sig };
                    console.log(`🎟️ Arena Entry: ${user.username} paid $${entryFeeUsd}. Sig: ${sig}`);
                } catch (txErr) {
                    await logSolanaTransactionError('Join transaction failed:', txErr);
                    socket.emit('error', 'Blockchain transfer failed. Please try again.');
                    return;
                }
            } else if (!switchingNormalMode) {
                if (isFreeTicketPlay) {
                    console.log(`[FREE TICKET] ${user.username} joined Slither/Agar normal $10 match using free ticket.`);
                } else {
                    if (DEV_FREE_PLAY) {
                        user.balance = Math.max(0, user.balance - entryFeeInSol);
                        await user.save();
                    }
                    console.log(`[FREE PLAY] ${user.username} joined (simulated $${entryFeeUsd} entry)`);
                }
            }

            // Log Join
            if (!switchingNormalMode) {
                if (isFreeTicketPlay) {
                    // Atomically consume the ticket across every server instance.
                    const consumedTicket = await User.findOneAndUpdate(
                        { _id: user._id, hasFreeTicket: true, freeTicketUsed: { $ne: true }, rewardsDisabled: { $ne: true } },
                        { $set: { hasFreeTicket: false, freeTicketUsed: true } },
                        { new: true },
                    );
                    if (!consumedTicket) throw new Error('Free ticket is unavailable or already used.');
                    user = consumedTicket;
                    pendingTicketUserId = user._id;

                    await Transaction.create({
                        userId: user._id,
                        type: 'game',
                        amount: 0,
                        meta: {
                            event: 'free_ticket_join',
                            roomId: room.id,
                            entryFeeUsd,
                            mode: mode === 'slither' ? 'slither' : 'agar',
                            isFreeTicketPlay: true,
                        },
                        status: 'confirmed'
                    });
                } else {
                    await Transaction.create({
                        userId: user._id,
                        type: 'game',
                        amount: entryFeeInSol,
                        meta: {
                            event: 'join',
                            roomId: room.id,
                            entryFeeUsd,
                            mode: mode === 'slither' ? 'slither' : 'agar',
                            ...(DEV_FREE_PLAY ? { simulated: true } : {}),
                        },
                        status: 'confirmed'
                    });
                }
            }

            // DYNAMIC ECONOMY SPLIT (scaled to entry tier, per mode population)
            // If user hasn't completed Sponsored Rewards, use reduced split with reward pool contribution
            const modeHumansAfterJoin = countHumansInMode(room, gameMode) + 1;
            const goldenBlobValue = getGoldenBlobValue(entryFeeUsd);
            let foodAlloc, aiAlloc, rewardContribution = 0, ownerContribution = 0;

            if (!user.sponsoredRewardsCompleted && !user.rewardsDisabled && !isFreeTicketPlay) {
                const rpSplit = getRewardPoolSplit(entryFeeUsd);
                foodAlloc = rpSplit.food;
                aiAlloc = rpSplit.ai;
                
                const remainingToFund = Math.max(0, (user.sponsoredRewardsBalance || 0) - (user.fundedRewardsUsd || 0));
                rewardContribution = Math.min(rpSplit.rewardPoolContribution, remainingToFund);
                ownerContribution = rpSplit.ownerVaultContribution + (rpSplit.rewardPoolContribution - rewardContribution);
            } else {
                const stdSplit = getJoinPoolSplit(entryFeeUsd, modeHumansAfterJoin);
                foodAlloc = stdSplit.food;
                aiAlloc = stdSplit.ai;
            }

            const foodToPool = Math.max(0, foodAlloc - goldenBlobValue);

            // Only fund bots up to the cap for current population; surplus → food pool
            const agarAfter = countHumansInMode(room, 'agar') + (gameMode === 'agar' ? 1 : 0);
            const slitherAfter = countHumansInMode(room, 'slither') + (gameMode === 'slither' ? 1 : 0);
            const joinBotStake = economy.botStartBalance;
            const maxAi = getTargetBots(agarAfter) * joinBotStake + getSlitherTargetBots(slitherAfter) * joinBotStake;
            const aiDeficit = Math.max(0, maxAi - room.aiBudgetBalance);
            const aiToAdd = Math.min(aiAlloc, aiDeficit);

            // Snapshot every mutable join-funded field until the player is safely in the room.
            pendingJoinEconomy = {
                room,
                userId: user._id,
                aiBudgetBalance: room.aiBudgetBalance,
                foodPoolBalance: room.foodPoolBalance,
                fundedEntryUsd: room.fundedEntryUsd,
                ownerBalance: room.ownerBalance,
                bots: [...room.bots],
                slitherBots: [...room.slitherBots],
                rewardFundingUsd: 0,
            };

            // Bot budget: if room already has >1 bot, only 10% of AI allocation funds bots
            const existingBotCount = gameMode === 'slither' ? room.slitherBots.length : room.bots.length;
            if (!switchingNormalMode) {
                if (existingBotCount > 1) {
                    const usableAi = aiToAdd * 0.10;
                    const overflowAi = aiToAdd - usableAi;
                    room.aiBudgetBalance += usableAi;
                    room.foodPoolBalance += foodToPool + overflowAi + (aiAlloc - aiToAdd);
                } else {
                    room.aiBudgetBalance += aiToAdd;
                    room.foodPoolBalance += foodToPool + (aiAlloc - aiToAdd);
                }
                room.fundedEntryUsd += entryFeeUsd;

                // Reward pool / owner vault contributions
                if (rewardContribution > 0) {
                    await Promise.all([
                        addRewardFundingUsd(rewardContribution),
                        User.updateOne({ _id: user._id }, { $inc: { fundedRewardsUsd: rewardContribution } })
                    ]);
                    pendingJoinEconomy.rewardFundingUsd = rewardContribution;
                    console.log(`🏆 REWARD POOL: +$${rewardContribution.toFixed(2)} from ${user.username} ($${entryFeeUsd} entry). Pool total: $${getCachedPendingRewardUsd().toFixed(2)}`);
                    Transaction.create({
                        userId: user._id,
                        type: 'game',
                        amount: rewardContribution / SOL_PRICE_USD,
                        meta: {
                            event: 'reward_pool_contribution',
                            entryFeeUsd,
                            contributionUsd: rewardContribution,
                            roomId: room.id,
                            mode: gameMode,
                        },
                        status: 'confirmed',
                    }).catch(err => console.error('Reward pool TX log error:', err.message));
                }
                if (ownerContribution > 0) {
                    room.ownerBalance += ownerContribution;
                    console.log(`💼 OWNER VAULT: +$${ownerContribution.toFixed(2)} from ${user.username} ($${entryFeeUsd} entry)`);
                    Transaction.create({
                        userId: user._id,
                        type: 'game',
                        amount: ownerContribution / SOL_PRICE_USD,
                        meta: {
                            event: 'owner_vault_contribution',
                            entryFeeUsd,
                            contributionUsd: ownerContribution,
                            roomId: room.id,
                            mode: gameMode,
                        },
                        status: 'confirmed',
                    }).catch(err => console.error('Owner vault TX log error:', err.message));
                }
            }

            // DYNAMIC BOT SCALING (mode-specific, max 1 bot spawned per entry)
            let targetBots = gameMode === 'slither'
                ? getSlitherTargetBots(modeHumansAfterJoin)
                : getTargetBots(modeHumansAfterJoin);

            if (gameMode === 'slither') {
                targetBots += room.slitherBots.filter(b => b.adminSpawned).length;
                const botsToSpawn = Math.min(1, Math.max(0, targetBots - room.slitherBots.length));
                if (botsToSpawn > 0) {
                    addSlitherBots(room, botsToSpawn, joinBotStake);
                } else if (room.slitherBots.length > targetBots) {
                    trimSlitherBots(room, targetBots);
                }
            } else {
                targetBots += room.bots.filter(b => b.adminSpawned).length;
                const botsToSpawn = Math.min(1, Math.max(0, targetBots - room.bots.length));
                if (botsToSpawn > 0) {
                    addBots(room, botsToSpawn, joinBotStake);
                } else if (room.bots.length > targetBots) {
                    trimAgarBots(room, targetBots);
                }
            }

            socket.roomId = room.id;
            if (room.spectators) {
                room.spectators = room.spectators.filter(s => s.id !== socket.id);
            }

            const startMass = economy.massStartBalance;
            const startDollars = switchedDollarBalance ?? economy.playerStartBalance;
            let newPlayer;

            if (gameMode === 'slither') {
                newPlayer = createSlitherPlayer(
                    socket.id,
                    user._id,
                    username || user.username,
                    validatedSkinColor || util.randomSlitherColor(),
                    room,
                    startMass,
                    startDollars,
                );
                if (switchedDollarBalance != null) {
                    newPlayer.dollarBalance = switchedDollarBalance;
                    newPlayer.balance = Math.max(newPlayer.balance, getEconomy(room.entryFeeUsd).massStartBalance);
                }
                if (isFreeTicketPlay) {
                    newPlayer.isFreeTicketPlay = true;
                }
            } else {
                const spawnX = Math.random() * c.worldWidth;
                const spawnY = Math.random() * c.worldHeight;
                newPlayer = {
                    id: socket.id,
                    mongoId: user._id,
                    username: username || user.username,
                    mode: 'agar',
                    entryFeeUsd: room.entryFeeUsd,
                    kills: 0,
                    balance: startDollars,
                    dollarBalance: startDollars,
                    startTime: Date.now(),
                    color: (() => {
                        if (validatedSkinColor === 'random') {
                            return { fill: 'rainbow', border: 'rainbow' };
                        }
                        if (validatedSkinColor) {
                            const c = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(validatedSkinColor);
                            if (c) {
                                const r = (parseInt(c[1], 16) - 32) > 0 ? (parseInt(c[1], 16) - 32) : 0;
                                const g = (parseInt(c[2], 16) - 32) > 0 ? (parseInt(c[2], 16) - 32) : 0;
                                const b = (parseInt(c[3], 16) - 32) > 0 ? (parseInt(c[3], 16) - 32) : 0;
                                return {
                                    fill: validatedSkinColor,
                                    border: '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)
                                };
                            }
                        }
                        return util.randomColor();
                    })(),
                    x: spawnX,
                    y: spawnY,
                    mouseX: 220,
                    mouseY: 0,
                    screenWidth: 1920,
                    screenHeight: 1080,
                    cells: [{
                        id: Math.random().toString(36).substr(2, 9),
                        x: spawnX,
                        y: spawnY,
                        balance: startMass,
                        radius: calculateCellRadius(startMass, startMass, 1, startMass),
                        vx: 0,
                        vy: 0,
                        lastSplit: Date.now()
                    }]
                };
                if (switchedDollarBalance != null) {
                    newPlayer.dollarBalance = switchedDollarBalance;
                    newPlayer.balance = switchedDollarBalance;
                }
                if (isFreeTicketPlay) {
                    newPlayer.isFreeTicketPlay = true;
                }
            }

            // Race guard: another join may have completed while we awaited payment
            const raced = room.players.find(p => p.mongoId?.toString() === userKey);
            if (raced) {
                await rollbackJoinEconomy(pendingJoinEconomy, 'duplicate_join_race');
                pendingJoinEconomy = null;
                if (pendingPaidJoin) {
                    await refundPaidJoin(pendingPaidJoin, 'duplicate_join_race');
                    pendingPaidJoin = null;
                }
                if (pendingTicketUserId) {
                    await User.updateOne(
                        { _id: pendingTicketUserId, freeTicketUsed: true, hasFreeTicket: false },
                        { $set: { freeTicketUsed: false, hasFreeTicket: true } },
                    );
                    pendingTicketUserId = null;
                }
                raced.id = socket.id;
                raced.disconnected = false;
                socket.roomId = room.id;
                if (raced.removeTimeout) {
                    clearTimeout(raced.removeTimeout);
                    delete raced.removeTimeout;
                }
                const racedMode = raced.mode || 'agar';
                socket.emit('welcome', raced, {
                    width: racedMode === 'slither' ? SLITHER.worldHalf * 2 : c.worldWidth,
                    height: racedMode === 'slither' ? SLITHER.worldHalf * 2 : c.worldHeight,
                    mode: racedMode,
                    rejoin: true,
                    entryFeeUsd: raced.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
                    solPrice: SOL_PRICE_USD,
                });
                return;
            }

            room.players.push(newPlayer);
            pendingJoinEconomy = null;
            pendingPaidJoin = null;
            pendingTicketUserId = null;

            // Seed arena food from this join's pool share (same as agar — funded by entry, not free)
            {
                const agarActive = countActiveHumansByMode(room, 'agar');
                const slitherActive = countActiveHumansByMode(room, 'slither');
                const budgets = getModeFoodBudgets(room, agarActive, slitherActive);
                if (gameMode === 'slither') {
                    syncSlitherFood(
                        room, foodBlobValueForRoom(room), budgets.slither,
                        countHumansInMode(room, 'slither'),
                        foodDensityForRoom(room),
                    );
                } else {
                    const agarInArena = countHumansInMode(room, 'agar');
                    const pelletValue = foodBlobValueForRoom(room);
                    const agarFoodTarget = Math.min(agarInArena * foodDensityForRoom(room), budgets.agar);
                    const agarTargetFoodCount = Math.floor(agarFoodTarget / pelletValue);
                    const normalCount = countNormalAgarFood(room);
                    if (normalCount < agarTargetFoodCount) {
                        addFood(room, Math.min(50, agarTargetFoodCount - normalCount));
                    }
                }
                if (goldenBlobValue > 1e-9) {
                    if (gameMode === 'slither') {
                        spawnGoldenSlitherBlob(room, goldenBlobValue);
                    } else {
                        spawnGoldenAgarBlob(room, goldenBlobValue);
                    }
                }
            }

            socket.emit('welcome', newPlayer, {
                width: gameMode === 'slither' ? SLITHER.worldHalf * 2 : c.worldWidth,
                height: gameMode === 'slither' ? SLITHER.worldHalf * 2 : c.worldHeight,
                mode: gameMode,
                rejoin: false,
                entryFeeUsd,
                solPrice: SOL_PRICE_USD,
            });
        } catch (err) {
            await rollbackJoinEconomy(pendingJoinEconomy, err.message || 'join_failed');
            pendingJoinEconomy = null;
            if (pendingPaidJoin) await refundPaidJoin(pendingPaidJoin, err.message || 'join_failed_after_payment');
            if (pendingTicketUserId) {
                await User.updateOne(
                    { _id: pendingTicketUserId, freeTicketUsed: true, hasFreeTicket: false },
                    { $set: { freeTicketUsed: false, hasFreeTicket: true } },
                ).catch(restoreErr => console.error('Ticket restore failed:', restoreErr.message));
            }
            console.error('joinGame error:', err.message);
            if (err.name === 'TokenExpiredError') {
                socket.emit('error', 'Session expired — please log in again.');
            } else if (err.name === 'JsonWebTokenError') {
                socket.emit('error', 'Invalid session — please log in again.');
            } else {
                socket.emit('error', err.message || 'Failed to join game');
            }
        } finally {
            if (userKey) joiningUsers.delete(userKey);
        }
    });

    socket.on('adminSpawnBotNearMe', async ({ token, mode }) => {
        console.log(`[Admin Spawn] Received request. Mode parameter: ${mode}, Socket ID: ${socket.id}, Room ID: ${socket.roomId}`);
        try {
            const secret = JWT_SECRET;
            const decoded = jwt.verify(token, secret);
            const user = await User.findById(decoded.id);
            if (!user) {
                console.log(`[Admin Spawn] Rejected: User not found for ID ${decoded.id}`);
                return;
            }
            const isAdmin = user.isAdmin || (process.env.ADMIN_USERNAME && user.username === process.env.ADMIN_USERNAME);
            if (!isAdmin) {
                console.log(`[Admin Spawn] Rejected: User ${user.username} is not an admin`);
                return;
            }

            const room = getArenaRoomById(socket.roomId);
            if (!room) {
                console.log(`[Admin Spawn] Rejected: Room ${socket.roomId} not found`);
                return;
            }
            if (!DEV_FREE_PLAY && !room.isSandbox) {
                console.log(`[Admin Spawn] Rejected: DEV_FREE_PLAY is false and room is not sandbox`);
                return;
            }

            const p = room.players.find(pl => pl.id === socket.id);
            const isSurviv = room.isSurviv;
            const isCompSlither = room.isCompetitiveSlither;
            const isSlither = isCompSlither || mode === 'slither' || (p && p.mode === 'slither') || room.id.includes('slither');
            const stake = botStakeForRoom(room);
            const botNames = ["Sirius", "Gota", "AgarioMaster", "ProPlayer", "Legit", "Sanic", "Wojak", "Pepe", "Doge", "Spooderman", "U Mad?", "Team Me", "Solo King", "Blobby"];
            const startMass = getEconomy(room.entryFeeUsd ?? 0.10).massStartBalance;

            const spawnX = p ? ((isSlither || isSurviv ? p.x : p.cells?.[0]?.x) || 0) : (Math.random() * (isSlither ? SLITHER.worldHalf * 2 : isSurviv ? SURVIV.worldHalf * 0.8 : c.worldWidth));
            const spawnY = p ? ((isSlither || isSurviv ? p.y : p.cells?.[0]?.y) || 0) : (Math.random() * (isSlither ? SLITHER.worldHalf * 2 : isSurviv ? SURVIV.worldHalf * 0.8 : c.worldHeight));

            let finalX = spawnX;
            let finalY = spawnY;

            if (isSurviv) {
                const offsetX = p ? (Math.random() - 0.5) * 600 : 0;
                const offsetY = p ? (Math.random() - 0.5) * 600 : 0;
                finalX = spawnX + offsetX;
                finalY = spawnY + offsetY;
                console.log(`[Admin Spawn] Spawning Surviv bot at (${finalX.toFixed(0)}, ${finalY.toFixed(0)})`);
                spawnSurvivBotNear(room, finalX, finalY);
            } else if (isCompSlither) {
                let foundClear = false;
                for (let attempt = 0; attempt < 50; attempt++) {
                    const r = 250 + Math.random() * 300;
                    const angle = Math.random() * Math.PI * 2;
                    const testX = spawnX + Math.cos(angle) * r;
                    const testY = spawnY + Math.sin(angle) * r;
                    const effectiveRadius = getCompetitiveEffectiveRadius(room.startTime + c.roomDuration);
                    const distToCenter = Math.hypot(testX, testY);
                    if (distToCenter < effectiveRadius - 100 && isCompetitiveSpawnClear(room, testX, testY, 150)) {
                        finalX = testX;
                        finalY = testY;
                        foundClear = true;
                        break;
                    }
                }
                if (!foundClear) {
                    finalX = 0;
                    finalY = 0;
                }
                console.log(`[Admin Spawn] Spawning CompetitiveSlither bot at (${finalX.toFixed(0)}, ${finalY.toFixed(0)})`);
                const effectiveRadius = getCompetitiveEffectiveRadius(room.startTime + c.roomDuration);
                room.players.push(createCompetitiveSlitherAdminBot(
                    room,
                    effectiveRadius,
                    finalX,
                    finalY,
                ));
            } else if (isSlither) {
                let foundClear = false;
                for (let attempt = 0; attempt < 50; attempt++) {
                    const r = 300 + Math.random() * 400;
                    const angle = Math.random() * Math.PI * 2;
                    const testX = spawnX + Math.cos(angle) * r;
                    const testY = spawnY + Math.sin(angle) * r;
                    if (isSpawnClear(room, testX, testY, 180)) {
                        finalX = testX;
                        finalY = testY;
                        foundClear = true;
                        break;
                    }
                }
                if (!foundClear) {
                    const fallback = pickSlitherSpawn(room);
                    finalX = fallback.x;
                    finalY = fallback.y;
                }
                console.log(`[Admin Spawn] Spawning Slither bot at (${finalX.toFixed(0)}, ${finalY.toFixed(0)})`);
                const dollarStart = getEconomy(room.entryFeeUsd ?? 0.10).botStartBalance;
                const angle = Math.random() * Math.PI * 2;
                room.slitherBots.push({
                    id: 'bot_' + Math.random().toString(36).substr(2, 5),
                    username: botNames[Math.floor(Math.random() * botNames.length)],
                    mode: 'slither',
                    kills: 0,
                    balance: startMass,
                    dollarBalance: dollarStart,
                    botStake: stake,
                    entryFeeUsd: room.entryFeeUsd,
                    startTime: Date.now(),
                    color: util.randomSlitherColor(),
                    x: finalX,
                    y: finalY,
                    inputDx: Math.cos(angle),
                    inputDy: Math.sin(angle),
                    boost: false,
                    angle,
                    fam: 0,
                    segments: createSegments(finalX, finalY, startMass, angle),
                    screenWidth: 1920,
                    screenHeight: 1080,
                    isBot: true,
                    adminSpawned: true,
                });
            } else {
                const offsetX = p ? (Math.random() - 0.5) * 600 : 0;
                const offsetY = p ? (Math.random() - 0.5) * 600 : 0;
                room.bots.push({
                    id: 'bot_' + Math.random().toString(36).substr(2, 5),
                    username: botNames[Math.floor(Math.random() * botNames.length)],
                    balance: stake,
                    dollarBalance: stake,
                    botStake: stake,
                    kills: 0,
                    color: util.randomColor(),
                    isBot: true,
                    adminSpawned: true,
                    targetX: spawnX + offsetX,
                    targetY: spawnY + offsetY,
                    lastTargetUpdate: Date.now(),
                    cells: [{
                        id: Math.random().toString(36).substr(2, 9),
                        x: spawnX + offsetX,
                        y: spawnY + offsetY,
                        balance: startMass,
                        radius: util.massToRadius(startMass),
                    }],
                });
            }
        } catch (err) {
            console.error('[Admin Spawn] Error:', err);
        }
    });

    socket.on('adminClearBots', async ({ token }) => {
        try {
            const secret = JWT_SECRET;
            const decoded = jwt.verify(token, secret);
            const user = await User.findById(decoded.id);
            if (!user) return;
            const isAdmin = user.isAdmin || (process.env.ADMIN_USERNAME && user.username === process.env.ADMIN_USERNAME);
            if (!isAdmin) return;

            const room = getArenaRoomById(socket.roomId);
            if (!room) return;
            if (!DEV_FREE_PLAY && !room.isSandbox) return;

            if (room.isCompetitiveSlither) {
                room.players = room.players.filter(pl => !pl.isBot);
            } else {
                room.bots = [];
                room.slitherBots = [];
            }
            console.log(`[Admin Clear] All bots removed from room ${room.id} by ${user.username}`);
            socket.emit('adminClearBotsOk');
        } catch (err) {
            console.error('[Admin Clear] Error:', err);
        }
    });

    // Protokoll-matchning: 0 = rörelse
    socket.on('0', (data) => {
        const br = findBRPlayerBySocket(socket.id);
        if (br) {
            const inputX = Number(data?.x);
            const inputY = Number(data?.y);
            if (Number.isFinite(inputX)) br.player.mouseX = inputX;
            if (Number.isFinite(inputY)) br.player.mouseY = inputY;
            if (Number.isFinite(data.screenWidth) && data.screenWidth > 0) {
                br.player.screenWidth = data.screenWidth;
            }
            if (Number.isFinite(data.screenHeight) && data.screenHeight > 0) {
                br.player.screenHeight = data.screenHeight;
            }
            return;
        }
        const room = getArenaRoomById(socket.roomId);
        const p = room?.players.find(pl => pl.id === socket.id);
        if (p) {
            const inputX = Number(data?.x);
            const inputY = Number(data?.y);
            if (Number.isFinite(inputX)) p.mouseX = inputX;
            if (Number.isFinite(inputY)) p.mouseY = inputY;
            if (Number.isFinite(inputX) || Number.isFinite(inputY)) p.lastAgarInputAt = Date.now();
            if (Number.isFinite(data.screenWidth) && data.screenWidth > 0) {
                p.screenWidth = data.screenWidth;
            }
            if (Number.isFinite(data.screenHeight) && data.screenHeight > 0) {
                p.screenHeight = data.screenHeight;
            }
        }
    });

    // Protokoll-matchning: 2 = split
    socket.on('2', () => {
        const room = rooms.find(r => r.id === socket.roomId);
        const p = room?.players.find(pl => pl.id === socket.id);
        if (!p || p.cells.length >= c.maxCells) return;

        const totalMass = playerTotalMass(p);
        const massStart = playerMassStart(p);
        const availableSlots = c.maxCells - p.cells.length;
        const newCells = [];
        for (const cell of p.cells) {
            if (newCells.length >= availableSlots) break;
            if (cell.balance >= massStart * 2) {
                cell.balance /= 2;
                cell.lastSplit = Date.now(); // Starta timern även för ursprungscellen
                const angle = Math.atan2(p.mouseY, p.mouseX);
                newCells.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: cell.x, y: cell.y,
                    balance: cell.balance,
                    radius: cell.radius,
                    vx: Math.cos(angle) * 25,
                    vy: Math.sin(angle) * 25,
                    lastSplit: Date.now()
                });
            }
        }

        // A multi-split can add several cells at once. Radius depends on the final
        // cell count, so recalculate every piece only after the split is complete.
        p.cells.push(...newCells);
        const finalCellCount = p.cells.length;
        p.cells.forEach(cell => {
            cell.radius = calculateCellRadius(cell.balance, totalMass, finalCellCount, massStart);
        });

    });

    // Protokoll-matchning: 1 = eject mass
    socket.on('1', () => {
        const room = rooms.find(r => r.id === socket.roomId);
        const p = room?.players.find(pl => pl.id === socket.id);
        if (!p) return;
        const s = playerDollarStart(p);
        p.cells.forEach(cell => {
            const massStart = playerMassStart(p);
            const totalMass = playerTotalMass(p);
            if (cell.balance >= massStart * 1.5) {
                cell.balance -= c.ejectMass;
                cell.radius = calculateCellRadius(cell.balance, totalMass, p.cells.length, massStart);
                const angle = Math.atan2(p.mouseY, p.mouseX);
                const dirX = Number.isFinite(Math.cos(angle)) && (p.mouseX || p.mouseY) ? Math.cos(angle) : 1;
                const dirY = Number.isFinite(Math.sin(angle)) && (p.mouseX || p.mouseY) ? Math.sin(angle) : 0;
                
                // Deduct the ejected mass value directly from the player's dollar balance, scaled by the arena tier factor s
                if (p.dollarBalance != null) {
                    p.dollarBalance = Math.max(0, p.dollarBalance - (c.ejectMass * s));
                }
                
                // Recycle the spread (ejectMass − ejectMassGain) from player dollars into the food pool
                const spread = Math.max(0, (c.ejectMass - c.ejectMassGain) * s);
                room.foodPoolBalance += spread;

                room.ejected.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: cell.x + dirX * (cell.radius + 20),
                    y: cell.y + dirY * (cell.radius + 20),
                    radius: 10,
                    vx: dirX * 22,
                    vy: dirY * 22,
                    hue: Math.floor(Math.random() * 360),
                    color: p.color,
                    balance: c.ejectMassGain,
                    dollarValue: c.ejectMassGain * s
                });
            }
        });
    });

    // Cash Out Logik
    socket.on('cashOut', async () => {
        const br = findBRPlayerBySocket(socket.id);
        if (br?.player) {
            socket.emit('error', 'Cash out is disabled in Battle Royale.');
            return;
        }
        const room = getArenaRoomById(socket.roomId);
        const p = room?.players.find(pl => pl.id === socket.id);
        if (!p || p.isCashingOut) return;
        if (!acquireCashoutLock(p.mongoId)) {
            socket.emit('error', 'Cashout already in progress.');
            return;
        }

        console.log(`⏱️ User ${p.username} started cashout timer (${CASHOUT_DURATION_MS / 1000}s)`);
        p.isCashingOut = true;
        const duration = CASHOUT_DURATION_MS;
        p.cashOutEndTime = Date.now() + duration;
        const playerMongoId = p.mongoId.toString();
        const roomId = socket.roomId;
        const isCompetitive = p.mode === 'competitive-slither';
        const isSurviv = p.mode === 'surviv';
        const isTournament = room.isTournament === true || p.isTournament === true;

        // Meddela klienten att timern har börjat
        socket.emit('cashOutStarting', { seconds: duration / 1000 });

        setTimeout(async () => {
            const activeRoom = getArenaRoomById(roomId);
            // Competitive admin bots live in room.players with mongoId=null.
            // Keep this lookup null-safe so bots can never crash the cashout timer.
            const activePlayer = activeRoom?.players.find(pl => pl.mongoId?.toString() === playerMongoId);

            if (!activePlayer || !activePlayer.isCashingOut) {
                console.log(`❌ Cashout cancelled (died or invalid state)`);
                releaseCashoutLock(playerMongoId);
                return;
            }

            if (isTournament || activeRoom?.isTournament || activePlayer.isTournament) {
                try {
                    await executeTournamentCashout(activePlayer, activeRoom);
                } catch (err) {
                    console.error('Tournament cashout error:', err);
                    io.to(activePlayer.id).emit('error', err.message || 'Tournament cashout failed');
                    activePlayer.isCashingOut = false;
                } finally {
                    releaseCashoutLock(playerMongoId);
                }
                return;
            }
            if (isSurviv || activePlayer.mode === 'surviv') {
                try {
                    await executeSurvivCashout(activePlayer, activeRoom, 'Arena Cashout');
                } catch (err) {
                    await logSolanaTransactionError('❌ Surviv cashout error:', err);
                    io.to(activePlayer.id).emit('error', 'Solana transfer failed. Your game balance is still safe; try cashing out again.');
                    activePlayer.isCashingOut = false;
                } finally {
                    releaseCashoutLock(playerMongoId);
                }
                return;
            }

            if (isCompetitive || activePlayer.mode === 'competitive-slither') {
                try {
                    await executeCompetitiveCashout(activePlayer, activeRoom, 'Arena Cashout');
                } catch (err) {
                    await logSolanaTransactionError('❌ Competitive cashout error:', err);
                    io.to(activePlayer.id).emit('error', 'Solana transfer failed. Your game balance is still safe; try cashing out again.');
                    activePlayer.isCashingOut = false;
                } finally {
                    releaseCashoutLock(playerMongoId);
                }
                return;
            }

            try {
                await executeArenaCashout(activePlayer, activeRoom, 'Arena Cashout');
            } catch (err) {
                releaseArenaCashoutReservation(activeRoom, activePlayer);
                await logSolanaTransactionError('❌ Cashout error:', err);
                io.to(activePlayer.id).emit('error', 'Solana transfer failed. Your game balance is still safe; try cashing out again.');
                if (activePlayer) activePlayer.isCashingOut = false;
            } finally {
                releaseCashoutLock(playerMongoId);
            }
        }, duration);
    });

    socket.on('disconnect', (reason) => {
        console.log(`[socket disconnect] id=${socket.id} room=${socket.roomId || 'none'} reason=${reason}`);
        const room = getArenaRoomById(socket.roomId);
        if (!room) return;
        if (room.spectators) {
            room.spectators = room.spectators.filter(s => s.id !== socket.id);
        }
        if (room.isCompetitiveSlither) {
            removeCompetitiveSpectator(room, socket.id);
        }
        if (room.isSurviv) {
            removeSurvivSpectator(room, socket.id);
        }
        const p = room.players.find(pl => pl.id === socket.id);
        if (p) {
            p.disconnected = true;
            p.disconnectedAt = Date.now();
            p.removeTimeout = setTimeout(() => {
                room.players = room.players.filter(x => x !== p);
                console.log(`🗑️ Removed disconnected player ${p.username} after timeout`);
            }, 5 * 60 * 1000);
        }
    });

    socket.on('slitherSpectateCam', ({ x, y }) => {
        const room = getArenaRoomById(socket.roomId);
        if (!room) return;
        if (room.isCompetitiveSlither) {
            const spec = room.competitiveSpectators?.find(s => s.id === socket.id);
            if (spec) {
                spec.x = Number(x) || 0;
                spec.y = Number(y) || 0;
            }
        } else {
            if (!room.spectators) room.spectators = [];
            let spec = room.spectators.find(s => s.id === socket.id);
            if (!spec) {
                spec = { id: socket.id, x: Number(x) || 0, y: Number(y) || 0 };
                room.spectators.push(spec);
            } else {
                spec.x = Number(x) || 0;
                spec.y = Number(y) || 0;
            }
        }
    });

    socket.on('slitherInput', ({ dx, dy, boost }) => {
        const br = findBRPlayerBySocket(socket.id);
        if (br) {
            const p = br.player;
            if (p.isCashingOut) return;
            p.inputDx = Number(dx) || 0;
            p.inputDy = Number(dy) || 0;
            p.boost = !!boost;
            return;
        }
        const room = getArenaRoomById(socket.roomId);
        const p = room?.players.find(pl =>
            pl.id === socket.id && (pl.mode === 'slither' || pl.mode === 'competitive-slither')
        );
        if (!p) return;
        p.inputDx = Number(dx) || 0;
        p.inputDy = Number(dy) || 0;
        p.boost = p.isCashingOut ? false : !!boost;
    });

    socket.on('survivInput', ({ dx, dy, aimAngle, shooting, reload, useMedkit, pickupWeapon, equipSlot, openChestId, takeChestItem, putChestItem, closeChest, dropItem }) => {
        const room = getArenaRoomById(socket.roomId);
        const p = room?.players.find(pl => pl.id === socket.id && pl.mode === 'surviv');
        if (!p) return;
        p.inputDx = Number(dx) || 0;
        p.inputDy = Number(dy) || 0;
        if (Number.isFinite(aimAngle)) p.aimAngle = aimAngle;

        if (p.isCashingOut) {
            p.shooting = false;
            return;
        }

        p.shooting = !!shooting;
        if (useMedkit) p.useMedkit = true;
        if (pickupWeapon) p.pickupWeaponPending = true;
        if (typeof openChestId === 'string' && openChestId.length > 0) p.openChestId = openChestId;
        if (takeChestItem && typeof takeChestItem === 'object') {
            const chestId = typeof takeChestItem.chestId === 'string' ? takeChestItem.chestId : null;
            const itemKey = typeof takeChestItem.itemKey === 'string' ? takeChestItem.itemKey : null;
            if (chestId && itemKey) p.takeChestItem = { chestId, itemKey };
        }
        if (putChestItem && typeof putChestItem === 'object') {
            const chestId = typeof putChestItem.chestId === 'string' ? putChestItem.chestId : null;
            const itemKey = typeof putChestItem.itemKey === 'string' ? putChestItem.itemKey : null;
            const weaponType = typeof putChestItem.weaponType === 'string' ? putChestItem.weaponType : null;
            const slotIdx = Number.isInteger(putChestItem.slotIdx) ? putChestItem.slotIdx : null;
            if (chestId && itemKey) p.putChestItem = { chestId, itemKey, weaponType, slotIdx };
        }
        if (dropItem && typeof dropItem === 'object') {
            const itemKey = typeof dropItem.itemKey === 'string' ? dropItem.itemKey : null;
            const slotIdx = Number.isInteger(dropItem.slotIdx) ? dropItem.slotIdx : null;
            if (itemKey) p.dropItemPending = { itemKey, slotIdx };
        }
        if (closeChest) {
            p.openedContainerId = null;
            p.openedContainer = null;
        }
        if (Number.isInteger(equipSlot) && equipSlot >= 0 && equipSlot <= 3) p.equipSlotPending = equipSlot;
        if (reload) beginSurvivReload(p);
    });

    socket.on('survivSpectateCam', ({ x, y }) => {
        const room = getArenaRoomById(socket.roomId);
        if (!room?.isSurviv) return;
        const spec = room.spectators?.find(s => s.id === socket.id);
        if (!spec) return;
        spec.x = Number(x) || 0;
        spec.y = Number(y) || 0;
    });
});

function getArenaRoomById(roomId) {
    const tournamentRoom = [...tournamentRooms.values()].find(room => room.id === roomId);
    if (tournamentRoom) return tournamentRoom;
    const survivRoom = findSurvivRoomById(roomId);
    if (survivRoom) return survivRoom;
    const compRoom = findCompetitiveSlitherRoomById(roomId);
    if (compRoom) return compRoom;
    const sandboxRoom = getSandboxRoomById(roomId);
    if (sandboxRoom) return sandboxRoom;
    return rooms.find(r => r.id === roomId);
}

function getSandboxRoomById(roomId) {
    if (!roomId?.startsWith('sandbox-')) return null;
    const mode = roomId.replace('sandbox-', '');
    try {
        return getSandboxRoom(mode);
    } catch {
        return null;
    }
}

function processCompetitiveSlitherTick() {
    for (const room of competitiveSlitherRooms) {
        if (room.isResetting) continue;
        const liveEntities = room.players.filter(
            p => p.mode === 'competitive-slither' && p.segments?.length
        ).length;
        const activeHumans = room.players.filter(p => !p.isBot && !p.disconnected).length;
        const spectatorCount = room.competitiveSpectators?.length ?? 0;
        if (liveEntities === 0 && spectatorCount === 0) continue;

        const resetTime = room.startTime + c.roomDuration;
        syncCompetitiveSlitherFood(room, activeHumans);
        const lb = processCompetitiveSlitherRoom(
            room,
            io,
            User,
            Transaction,
            resetTime,
        );
        broadcastCompetitiveSlitherState(room, io, lb, {
            resetTime,
            solPrice: SOL_PRICE_USD,
            isResetting: room.isResetting,
            zone: getCompetitiveZone(resetTime),
            competitiveSlither: true,
        });
    }
}

function processSurvivTick() {
    for (const room of survivRooms) {
        if (room.isResetting) continue;
        const humanCount = room.players.filter(p => !p.disconnected).length;
        const spectatorCount = room.spectators?.length ?? 0;
        if (humanCount === 0 && spectatorCount === 0) continue;

        const resetTime = room.startTime + c.roomDuration;
        const lbData = processSurvivRoom(room, io, resetTime);
        broadcastSurvivState(room, io, lbData, {
            resetTime,
            solPrice: SOL_PRICE_USD,
            isResetting: room.isResetting,
            surviv: true,
        });
    }
}

function getBattleRoyaleDeps() {
    return {
        User,
        Transaction,
        util,
        c,
        addFood,
        calculateCellRadius,
        rooms,
        JWT_SECRET,
        DEV_FREE_PLAY,
        SOL_PRICE_USD,
        connection,
        ensureUserDepositWallet,
        OWNER_VAULT_ADDRESS,
    };
}

setupBattleRoyale(io, getBattleRoyaleDeps());

setupSandbox(io, {
    User,
    Transaction,
    c,
    util,
    QuadTree,
    Rectangle,
    Point,
    calculateCellRadius,
    addBots,
    addViruses,
    rebuildQuadTree,
    processRoom,
    DEFAULT_ENTRY_FEE,
    JWT_SECRET: JWT_SECRET,
});

setInterval(() => {
    try {
        processBRQueues(io, getBattleRoyaleDeps());
    } catch (err) {
        logGameLoopError('battle royale queue', err);
    }
}, 1000);

setInterval(() => {
    try {
        const age = Date.now() - GLOBAL_ARENA_START;
        if (age > c.roomDuration && !isArenaResetting()) {
            performGlobalArenaReset();
            return;
        }
        if (isArenaResetting()) return;

        rooms.forEach(room => {
            try {
                processRoom(room);
            } catch (err) {
                logGameLoopError(`room ${room?.id || 'unknown'}`, err);
            }
        });
        tournamentRooms.forEach(room => {
            try {
                processRoom(room);
            } catch (err) {
                logGameLoopError(`tournament room ${room?.id || 'unknown'}`, err);
            }
        });

        try {
            processCompetitiveSlitherTick();
        } catch (err) {
            logGameLoopError('competitive slither', err);
        }

        try {
            processSurvivTick();
        } catch (err) {
            logGameLoopError('surviv', err);
        }

        try {
            processBattleRoyaleMatches(io, getBattleRoyaleDeps());
        } catch (err) {
            logGameLoopError('battle royale matches', err);
        }
    } catch (err) {
        logGameLoopError('main tick', err);
    }
}, 1000 / 40);

function processRoom(room) {
    if (room.isResetting) return; // Pause during global reset

    const isSandbox = room.isSandbox === true;
    const agarHumans = countActiveHumansByMode(room, 'agar');
    const slitherHumans = countActiveHumansByMode(room, 'slither');

    // IDLE ROOM CLEANUP (Despawn bots after 10 min of no human players, reclaim money to food pool)
    const activeHumans = agarHumans + slitherHumans;
    if (activeHumans > 0) {
        room.lastHumanTime = Date.now();
    } else {
        if (!room.lastHumanTime) {
            room.lastHumanTime = Date.now();
        }
        if (Date.now() - room.lastHumanTime >= 10 * 60 * 1000) {
            const botsCount = room.bots.length + room.slitherBots.length;
            if (botsCount > 0 || room.aiBudgetBalance > 0) {
                console.log(`⏳ Room ${room.id} has been empty of humans for 10 minutes. Despawning bots and reclaiming balances.`);
                let totalReclaimed = room.aiBudgetBalance;

                room.bots.forEach(b => {
                    totalReclaimed += b.dollarBalance ?? b.botStake ?? b.balance ?? 0;
                });

                room.slitherBots.forEach(b => {
                    totalReclaimed += b.dollarBalance ?? b.botStake ?? 0;
                });

                room.bots = [];
                room.slitherBots = [];
                room.aiBudgetBalance = 0;
                room.savedAgarTarget = 0;
                room.savedSlitherTarget = 0;

                room.foodPoolBalance += totalReclaimed;
                console.log(`💰 Reclaimed $${totalReclaimed.toFixed(2)} from idle room bots/budget to foodPool.`);
            }
        }
    }

    // DYNAMIC BOT SCALING (mode-specific, continuously maintained)
    if (!isSandbox || room.sandboxAutoBots) {
        const agarHumansInArena = effectiveHumanCountForBots(room, 'agar');
        const slitherHumansInArena = effectiveHumanCountForBots(room, 'slither');

        let agarTargetBots = getTargetBots(agarHumansInArena);
        if (agarHumansInArena > 0) room.savedAgarTarget = agarTargetBots;
        else agarTargetBots = room.savedAgarTarget || 0;
        agarTargetBots += room.bots.filter(b => b.adminSpawned).length;

        const agarBotStake = botStakeForRoom(room);
        const slitherBotStake = botStakeForRoom(room);

        const activeBotCount = room.bots.length + (room.pendingBotSpawns || 0);
        if (activeBotCount < agarTargetBots) {
            addBots(room, agarTargetBots - activeBotCount, agarBotStake);
        } else if (room.bots.length > agarTargetBots) {
            trimAgarBots(room, agarTargetBots);
        }

        let slitherTargetBots = getSlitherTargetBots(slitherHumansInArena);
        if (slitherHumansInArena > 0) room.savedSlitherTarget = slitherTargetBots;
        else slitherTargetBots = room.savedSlitherTarget || 0;
        slitherTargetBots += room.slitherBots.filter(b => b.adminSpawned).length;

        const activeSlitherBotCount = room.slitherBots.length + (room.pendingSlitherBotSpawns || 0);
        if (activeSlitherBotCount < slitherTargetBots) {
            addSlitherBots(room, slitherTargetBots - activeSlitherBotCount, slitherBotStake);
        } else if (room.slitherBots.length > slitherTargetBots) {
            trimSlitherBots(room, slitherTargetBots);
        }

        capAiBudget(room);
    }

    // Food spawn — funded from pool (entry fees on join), same rules for agar + slither
    if (!isSandbox || room.sandboxAutoFood) {
        const agarInArena = countHumansInMode(room, 'agar');
        const slitherInArena = countHumansInMode(room, 'slither');
        const foodBudgets = getModeFoodBudgets(room, agarHumans, slitherHumans);

        const pelletValue = foodBlobValueForRoom(room);
        const agarFoodTarget = Math.min(agarInArena * foodDensityForRoom(room), foodBudgets.agar);
        const agarTargetFoodCount = Math.floor(agarFoodTarget / pelletValue);
        if (agarInArena <= 0) {
            room.food.length = 0;
        } else {
            const now = Date.now();
            if (!room._lastAgarFoodSync) room._lastAgarFoodSync = 0;
            if (now - room._lastAgarFoodSync >= 750) {
                room._lastAgarFoodSync = now;
                const normalCount = countNormalAgarFood(room);
                if (normalCount < agarTargetFoodCount) {
                    addFood(room, Math.min(30, agarTargetFoodCount - normalCount));
                } else if (normalCount > agarTargetFoodCount + 25) {
                    trimNormalAgarFood(room, agarTargetFoodCount);
                }
            }
        }
        const baseDensity = foodDensityForRoom(room);
        const slitherDensity = room.isTournament ? baseDensity * 4.5 : baseDensity;
        syncSlitherFood(room, pelletValue, foodBudgets.slither, slitherInArena, slitherDensity);

        if (room.viruses.length < c.virusCount) addViruses(room, c.virusCount - room.viruses.length);
    }

    const allUsers = [
        ...room.players.filter(p => p.mode !== 'slither' && !p.disconnected),
        ...room.bots,
    ];
    rebuildQuadTree(room, allUsers);
    const userMap = new Map();
    allUsers.forEach(u => userMap.set(u.id, u));

    allUsers.forEach(player => {
        try {
        if (!Array.isArray(player.cells)) return;
        // Slither players use server-side physics in slither-engine — skip Agar cell physics
        if (player.mode === 'slither') return;

        const massStart = playerMassStart(player);
        const dollarStart = player.isBot
            ? (player.botStake ?? player.dollarBalance ?? c.botStartBalance)
            : playerDollarStart(player);

        // 0. Avancerad AI-logik för bottar
        if (player.isBot) {
            const botCells = player.cells;
            if (botCells.length === 0) return;

            // SJÄLVSANERING: Despawn om botten blir för stor (dollar, not mass)
            const totalBotMass = playerTotalMass(player);
            const botWealth = player.dollarBalance ?? player.balance ?? 0;
            const botMax = getEconomy(room.entryFeeUsd).botMaxBalance;
            if (botWealth > botMax) {
                room.foodPoolBalance += botWealth;
                room.bots = room.bots.filter(b => b.id !== player.id);
                const currentHumans = effectiveHumanCountForBots(room, 'agar');
                const autoBotsCount = room.bots.filter(b => !b.adminSpawned).length;
                if (autoBotsCount < getTargetBots(currentHumans)) addBots(room, 1);
                return;
            }

            // BOT CASHOUT LOGIC (Only in real rooms, not sandbox/freeplay)
            const isFreePlay = room.isSandbox || process.env.DEV_FREE_PLAY === 'true';
            if (!isFreePlay) {
                if (player.isCashingOut) {
                    if (Date.now() >= player.cashOutEndTime) {
                        const entryFee = room.entryFeeUsd ?? DEFAULT_ENTRY_FEE;
                        const botStart = getEconomy(entryFee).botStartBalance;
                        const remaining = Math.max(0, botWealth - botStart);

                        // Resten delas 50/50 till owner och food pool
                        room.ownerBalance = (room.ownerBalance || 0) + remaining * 0.5;
                        room.foodPoolBalance += remaining * 0.5;

                        // 1 bot går till AI budget (som spawnas efter 3 sekunder) endast om det finns riktiga spelare
                        const currentHumans = effectiveHumanCountForBots(room, 'agar');
                        if (currentHumans > 0) {
                            room.aiBudgetBalance += botStart;
                            room.pendingBotSpawns = (room.pendingBotSpawns || 0) + 1;
                            setTimeout(() => {
                                room.pendingBotSpawns = Math.max(0, (room.pendingBotSpawns || 0) - 1);
                            }, 3000);
                        } else {
                            room.ownerBalance = (room.ownerBalance || 0) + botStart;
                        }

                        console.log(`🤖 Agar Bot ${player.username} successfully cashed out $${botWealth.toFixed(2)}. remaining: $${remaining.toFixed(2)} (50/50 split), botStart: $${botStart.toFixed(2)} (delayed spawn: ${currentHumans > 0})`);
                        room.bots = room.bots.filter(b => b.id !== player.id);
                        return;
                    }
                } else {
                    if (player.cashOutThreshold === undefined) {
                        const entryFee = room.entryFeeUsd ?? DEFAULT_ENTRY_FEE;
                        player.cashOutThreshold = entryFee * (1.0 + Math.random() * 0.8);
                    }
                    if (botWealth >= player.cashOutThreshold) {
                        player.isCashingOut = true;
                        player.cashOutEndTime = Date.now() + CASHOUT_DURATION_MS;
                        console.log(`⏱️ Agar Bot ${player.username} started cashout timer (threshold: $${player.cashOutThreshold.toFixed(2)})`);
                    }
                }
            }

            const head = botCells[0];

            if (!player.lastDecisionTime) player.lastDecisionTime = 0;
            if (!player.decisionDelay) player.decisionDelay = 250 + Math.random() * 300; // Human-like reaction time (250-550ms)

            // Uppdatera mål och beslut endast med jämna mellanrum (reaktionstid)
            if (Date.now() - player.lastDecisionTime > player.decisionDelay) {
                player.lastDecisionTime = Date.now();
                player.decisionDelay = 250 + Math.random() * 300;

                let threat = null;
                let targetPrey = null;
                let minDistThreat = 900; // Se faror på lite längre håll
                let minDistPrey = 600;

                // 1. SKANNA OMGIVNING (Hot och Byte)
                allUsers.forEach(u => {
                    if (u.id === player.id) return;
                    u.cells.forEach(c2 => {
                        const d = Math.hypot(c2.x - head.x, c2.y - head.y);
                        const otherTotalMass = playerTotalMass(u);

                        // HOT: Om någon är 10% större
                        if (otherTotalMass > totalBotMass * 1.10 && d < minDistThreat) {
                            minDistThreat = d;
                            threat = c2;
                        }
                        // BYTE: Om någon är liten nog att ätas
                        else if (totalBotMass > otherTotalMass * 1.10 && d < minDistPrey) {
                            minDistPrey = d;
                            targetPrey = c2;
                        }
                    });
                });

                // VIRUS: Undvik om vi är stora nog att sprängas
                if (totalBotMass > 5.0) {
                    room.viruses.forEach(v => {
                        const d = Math.hypot(v.x - head.x, v.y - head.y);
                        if (d < head.radius + 150 && d < minDistThreat) {
                            minDistThreat = d;
                            threat = v;
                        }
                    });
                }

                // 2. BESLUTSFATTANDE (Prioritering)
                if (threat) {
                    // FLY! Beräkna flyktvektor
                    let fleeX = head.x - threat.x;
                    let fleeY = head.y - threat.y;
                    const dist = Math.hypot(fleeX, fleeY) || 1;
                    fleeX /= dist;
                    fleeY /= dist;

                    // Wall avoidance (undvik att fastna i väggar)
                    const wallMargin = 400 + head.radius; // Börja svänga innan väggen
                    if (head.x < wallMargin) fleeX += (wallMargin - head.x) / wallMargin * 1.5;
                    if (head.x > c.worldWidth - wallMargin) fleeX -= (head.x - (c.worldWidth - wallMargin)) / wallMargin * 1.5;
                    if (head.y < wallMargin) fleeY += (wallMargin - head.y) / wallMargin * 1.5;
                    if (head.y > c.worldHeight - wallMargin) fleeY -= (head.y - (c.worldHeight - wallMargin)) / wallMargin * 1.5;

                    const fleeAngle = Math.atan2(fleeY, fleeX);
                    // Lägg till lite "panik-brus" i rörelsen (+- 15 grader)
                    const panicAngle = fleeAngle + (Math.random() - 0.5) * 0.5;
                    player.targetX = head.x + Math.cos(panicAngle) * 600;
                    player.targetY = head.y + Math.sin(panicAngle) * 600;

                } else if (targetPrey) {
                    // JAGA! Spring mot bytet med lite felmarginal för att simulera mänsklighet
                    const preyAngle = Math.atan2(targetPrey.y - head.y, targetPrey.x - head.x) + (Math.random() - 0.5) * 0.2;
                    player.targetX = head.x + Math.cos(preyAngle) * 500;
                    player.targetY = head.y + Math.sin(preyAngle) * 500;

                } else {
                    // MAT: Hitta närmaste matbit
                    let nearestFood = null;
                    let minDistFood = 700;
                    room.food.forEach(f => {
                        const d = Math.hypot(f.x - head.x, f.y - head.y);
                        if (d < minDistFood) { minDistFood = d; nearestFood = f; }
                    });

                    if (nearestFood) {
                        player.targetX = nearestFood.x;
                        player.targetY = nearestFood.y;
                    } else if (Math.hypot((player.targetX || head.x) - head.x, (player.targetY || head.y) - head.y) < 100) {
                        // Vandra slumpmässigt
                        player.targetX = Math.max(200, Math.min(c.worldWidth - 200, head.x + (Math.random() - 0.5) * 1500));
                        player.targetY = Math.max(200, Math.min(c.worldHeight - 200, head.y + (Math.random() - 0.5) * 1500));
                    }
                }
            }

            // Simulera input för fysikmotorn
            player.mouseX = player.targetX - head.x;
            player.mouseY = player.targetY - head.y;
        }

        let totalX = 0;
        let totalY = 0;
        let totalWeight = 0;
        const cellsToDelete = new Set();

        // Calculate absolute target position in the world
        ensureAgarMovementInput(player);
        const targetWorldX = player.isBot ? player.targetX : (player.x + (player.mouseX || 0));
        const targetWorldY = player.isBot ? player.targetY : (player.y + (player.mouseY || 0));

        // 1. Beräkna rörelse för alla celler
        for (let i = 0; i < player.cells.length; i++) {
            const cell = player.cells[i];
            
            // PHYSICS: Movement & Friction
            // Använder balans som bas för hastighet (normaliserad med faktor 50)
            const speed = (6 / Math.pow(Math.max(cell.balance, 1), 0.449)) * c.speedMult * (isSandbox ? (room.sandboxSpeedMultiplier ?? 1) : 1);
            
            // Calculate movement angle from individual cell to absolute mouse position
            const cellMouseX = targetWorldX - cell.x;
            const cellMouseY = targetWorldY - cell.y;
            const angle = Math.atan2(cellMouseY, cellMouseX);
            const distToMouse = Math.hypot(cellMouseX, cellMouseY);
            // Each split blob keeps movement speed based on its own size.
            const moveSpeed = distToMouse < 50 ? (speed * distToMouse / 50) : speed;
            
            const velX = (Math.cos(angle) * moveSpeed) + (cell.vx || 0);
            const velY = (Math.sin(angle) * moveSpeed) + (cell.vy || 0);
            cell.x += velX;
            cell.y += velY;
            cell.vX = velX; // Skicka med hastighet för slime-effekt
            cell.vY = velY;
            cell.vx *= 0.85; cell.vy *= 0.85;

            // BOUNDS
            const r = cell.radius;
            cell.x = Math.max(r, Math.min(c.worldWidth - r, cell.x));
            cell.y = Math.max(r, Math.min(c.worldHeight - r, cell.y));
        }


        resolveAgarOwnCells(player, Date.now(), massStart);
        if (!player.isBot) {
            applyAgarWealthTax(player, room, dollarStart);
        }

        // 2. Hantera kollisioner och merging
        for (let i = 0; i < player.cells.length; i++) {
            const cell = player.cells[i];
            if (cellsToDelete.has(cell.id)) continue;

            const r = cell.radius;
            const range = new Rectangle(cell.x, cell.y, r * 2, r * 2);
            const items = room.qt.query(range);

            for (const item of items) {
                if (cellsToDelete.has(cell.id)) break;

                if (item.type === 'food') {
                    const foodRadius = item.data.radius || 5;
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r + foodRadius * 0.5) {
                        // Quadtree entries are a tick snapshot; another cell may
                        // already have consumed this exact blob.
                        if (!room.food.some(f => f.id === item.data.id)) continue;
                        applyAgarFoodPickup(cell, item.data, player, room);
                        cell.radius = calculateCellRadius(
                            cell.balance,
                            playerTotalMass(player),
                            player.cells.length,
                            massStart,
                        );
                        room.food = room.food.filter(f => f.id !== item.data.id);
                    }
                } else if (item.type === 'ejected') {
                    const ejectRadius = item.data.radius || 10;
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r + ejectRadius * 0.5) {
                        if (!room.ejected.some(e => e.id === item.data.id)) continue;
                        cell.balance += item.data.balance;
                        const s = playerDollarStart(player);
                        const dollarGain = item.data.dollarValue ?? (item.data.balance * s);
                        if (player.dollarBalance != null) {
                            player.dollarBalance = (player.dollarBalance || 0) + dollarGain;
                        }
                        cell.radius = calculateCellRadius(
                            cell.balance,
                            playerTotalMass(player),
                            player.cells.length,
                            massStart,
                        );
                        room.ejected = room.ejected.filter(e => e.id !== item.data.id);
                    }
                } else if (item.type === 'virus') {
                    // Virusexplosion baserat på massa
                    const virusRadius = item.data.radius || 35;
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r + virusRadius * 0.3 && cell.balance > massStart * 2) {
                        if (player.cells.length < c.maxCells) {
                            cell.balance /= 2;
                            cell.radius = calculateCellRadius(
                                cell.balance,
                                playerTotalMass(player),
                                player.cells.length,
                                massStart,
                            );
                            player.cells.push({
                                id: Math.random().toString(36).substr(2, 9),
                                x: cell.x, y: cell.y, balance: cell.balance, radius: cell.radius, vx: Math.random() * 40 - 20, vy: Math.random() * 40 - 20, lastSplit: Date.now()
                            });
                            room.viruses = room.viruses.filter(v => v.id !== item.data.id);
                        }
                    }
                } else if (item.type === 'player' || item.type === 'bot') {
                    const otherCell = item.cell;
                    if (otherCell.id === cell.id || cellsToDelete.has(otherCell.id)) continue;
                    const d = Math.hypot(cell.x - otherCell.x, cell.y - otherCell.y);
                    const r2 = otherCell.radius;

                    if (item.socketId === player.id || item.botId === player.id) {
                        continue;
                    } else {
                        if (isSandbox && room.sandboxInvincible) continue;
                        // EXTERNAL: Eat
                        // Sänkt tröskel till 5% (1.05) och mer förlåtande avstånd (d < r för en mjukare känsla där man äter lättare)
                        if (cell.balance > otherCell.balance * 1.05 && d < r) {
                            const victim = room.players.find(p => p.id === item.socketId)
                                || room.bots.find(b => b.id === item.botId);
                            // Reject stale quadtree cells already consumed by another eater.
                            if (!victim?.cells?.some(c => c.id === otherCell.id)) continue;

                            // EKONOMI: Absorberar 100% av cellmassan + proportionell dollar-andel
                            cell.balance += otherCell.balance;
                            transferAgarDollars(victim, player, otherCell.balance);
                            cell.radius = calculateCellRadius(
                                cell.balance,
                                playerTotalMass(player),
                                player.cells.length,
                                massStart,
                            );
                            if (victim) {
                                const willEliminate = !victim.isBot && victim.cells.length === 1 && victim.cells[0].id === otherCell.id;
                                const balanceAtDeath = willEliminate
                                    ? (victim.dollarBalance ?? victim.cells.reduce((s, c) => s + c.balance, 0))
                                    : 0;

                                victim.cells = victim.cells.filter(c => c.id !== otherCell.id);
                                if (victim.cells.length === 0) {
                                    if (!victim.isBot) {
                                        io.to(victim.id).emit('RIP');
                                        const victimMongoId = victim.mongoId;
                                        const sessionPlaytime = Date.now() - victim.startTime;

                                        User.findByIdAndUpdate(victimMongoId, { $inc: { playtime: sessionPlaytime } })
                                            .catch(err => console.error("Error updating playtime on death:", err));

                                        Transaction.create({
                                            userId: victimMongoId,
                                            type: 'game',
                                            amount: balanceAtDeath,
                                            meta: {
                                                reason: 'Arena Death',
                                                event: 'death',
                                                mode: victim.mode || 'agar',
                                                entryFeeUsd: victim.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
                                                inGameBalanceUsd: balanceAtDeath,
                                                isFreeTicketPlay: !!victim.isFreeTicketPlay,
                                            },
                                            status: 'confirmed',
                                        }).catch(err => console.error("Error logging agar death:", err));

                                        room.players = room.players.filter(p => p.id !== victim.id);
                                    } else {
                                        // Ta bort botten och spawna en ny direkt
                                        room.bots = room.bots.filter(b => b.id !== victim.id);
                                        const currentHumans = effectiveHumanCountForBots(room, 'agar');
                                        const autoBotsCount = room.bots.filter(b => !b.adminSpawned).length;
                                        if (autoBotsCount < getTargetBots(currentHumans)) addBots(room, 1);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 3. Städa upp raderade celler och beräkna nytt centrum
        if (cellsToDelete.size > 0) {
            player.cells = player.cells.filter(c => !cellsToDelete.has(c.id));
        }

        player.cells.forEach(cell => {
            const weight = Math.max(0.0001, cell.balance);
            totalX += cell.x * weight;
            totalY += cell.y * weight;
            totalWeight += weight;
        });

        // HUD / cashout balance is dollars; cell.balance is mass. Coupled directly via tier scale factor.
        const s = player.isBot
            ? (player.botStake ?? player.dollarBalance ?? c.botStartBalance)
            : playerDollarStart(player);

        player.dollarBalance = playerTotalMass(player) * s;
        player.balance = player.dollarBalance;

        if (player.cells.length > 0) {
            player.x = totalX / totalWeight;
            player.y = totalY / totalWeight;
        }
        } catch (err) {
            logGameLoopError('agar player tick ' + (player?.id || 'unknown'), err);
        }
    });

    room.ejected.forEach(e => { e.x += e.vx; e.y += e.vy; e.vx *= 0.9; e.vy *= 0.9; });

    rebuildQuadTree(room, allUsers);

    // Slither server-side physics tick (40Hz) — network broadcast at 40Hz
    const slitherLeaderboard = processSlitherRoom(room, io, User, Transaction);

    const slitherMeta = {
        resetTime: room.startTime + c.roomDuration,
        solPrice: SOL_PRICE_USD,
        isResetting: room.isResetting,
        battleRoyale: room.isBattleRoyale === true,
    };
    broadcastSlitherState(room, io, slitherLeaderboard, slitherMeta);

    // Skicka leaderboard separat för prestanda (Inkludera bottar)
    const leaderboardData = allUsers
        .map(p => ({
            id: p.id,
            name: p.username,
            massTotal: arenaCashoutUsd(p),
            balance: arenaCashoutUsd(p),
        }))
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 10);

    // Skapa en kopia för leaderboard med USD-värden
    const visualLeaderboard = leaderboardData.map(entry => ({
        ...entry,
        massTotal: Number(entry.massTotal).toFixed(2),
        balance: Number(entry.balance).toFixed(2)
    }));

    room.players.forEach(p => {
        if (p.mode === 'slither' || p.disconnected) return;

        io.to(p.id).emit('leaderboard', { leaderboard: visualLeaderboard });

        // Spatial filtering — food range is wider than entity range to reduce edge pop-in.
        const pad = 500;
        const foodPad = 960;
        const rangeX = (p.screenWidth || 1920) / 2 + pad;
        const rangeY = (p.screenHeight || 1080) / 2 + pad;
        const viewRange = new Rectangle(p.x, p.y, rangeX, rangeY);
        const foodRange = new Rectangle(p.x, p.y, rangeX + foodPad, rangeY + foodPad);
        const visibleItems = room.qt.query(viewRange);
        const foodItems = room.qt.query(foodRange);

        const visibleFood = [];
        const visibleViruses = [];
        const visibleEjected = [];
        const visibleUsersSet = new Set();
        visibleUsersSet.add(p);
        visibleItems.forEach(item => {
            if (item.type === 'virus') visibleViruses.push(item.data);
            else if (item.type === 'ejected') visibleEjected.push(item.data);
            else if (item.type === 'player' || item.type === 'bot') {
                const id = item.socketId || item.botId;
                const found = userMap.get(id);
                if (found) visibleUsersSet.add(found);
            }
        });
        foodItems.forEach(item => {
            if (item.type === 'food') visibleFood.push(item.data);
        });
        const minimapHalf = Math.max((p.screenWidth || 1920) / 2, (p.screenHeight || 1080) / 2) * 2.35;
        const threatHalf = minimapHalf * 1.55;
        const minimapRange = new Rectangle(p.x, p.y, minimapHalf, minimapHalf);
        const minimapItems = room.qt.query(minimapRange);

        const minimapPlayers = allUsers
            .filter(u => {
                const dx = u.x - p.x;
                const dy = u.y - p.y;
                return dx * dx + dy * dy <= threatHalf * threatHalf;
            })
            .map(u => ({
                x: Math.round(u.x),
                y: Math.round(u.y),
                you: u.id === p.id,
            }));

        const minimapFood = [];
        const minimapViruses = [];
        const minimapEjected = [];
        minimapItems.forEach(item => {
            if (item.type === 'food') {
                minimapFood.push({
                    x: Math.round(item.data.x),
                    y: Math.round(item.data.y),
                    g: !!item.data.golden,
                    h: item.data.hue,
                });
            } else if (item.type === 'virus') {
                minimapViruses.push({ x: Math.round(item.data.x), y: Math.round(item.data.y) });
            } else if (item.type === 'ejected') {
                minimapEjected.push({ x: Math.round(item.data.x), y: Math.round(item.data.y) });
            }
        });
        if (minimapFood.length > 220) minimapFood.length = 220;

        const minimap = {
            players: minimapPlayers,
            food: minimapFood,
            viruses: minimapViruses,
            ejected: minimapEjected,
        };

        io.to(p.id).emit('serverTellPlayerMove', p, Array.from(visibleUsersSet), visibleFood, visibleEjected, visibleViruses, {
            resetTime: room.startTime + c.roomDuration,
            solPrice: SOL_PRICE_USD,
            minimap,
            ...(isSandbox ? {
                sandbox: true, zone: room.sandboxZone ? {
                    cx: room.sandboxZone.cx,
                    cy: room.sandboxZone.cy,
                    radius: room.sandboxZone.radius,
                    shrinking: room.sandboxZone.shrinking,
                } : null
            } : {}),
        });
    });
}

app.get('/api/admin/sandbox/status', authenticateAdmin, (req, res) => {
    res.json(getSandboxStatus());
});

app.post('/api/admin/sandbox/action', authenticateAdmin, (req, res) => {
    const { mode, action, params } = req.body;
    const gameMode = mode === 'slither' ? 'slither' : 'agar';
    const result = applySandboxAction(gameMode, action, params ?? {});
    if (result?.needsAgarDeps && action === 'spawnBots') {
        const room = getSandboxRoom(gameMode);
        const count = Math.max(1, Math.min(30, Number(params?.count) || 3));
        const stake = Number(params?.balance) || 5;
        room.aiBudgetBalance = 1_000_000;
        addBots(room, count, stake);
    }
    res.json({ status: getSandboxStatus(), result });
});

const PORT = process.env.PORT || 5000;

// Keep CORS headers on unhandled errors (e.g. during Railway restarts)
app.use((err, req, res, next) => {
    applyCorsHeaders(req, res);
    console.error('Unhandled error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

httpServer.listen(PORT, () => console.log(`Servern körs på port ${PORT}`));
