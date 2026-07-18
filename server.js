Exit code: 0
Wall time: 0.8 seconds
Total output lines: 8246
Output:
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
import fetch from 'node-fetch'; // Se till att du kÃ¶r 'npm install node-fetch'
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
    eliminateSurvivPlayer,
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
const OWNER_VAULT_ADDRESS = process.env.OWNER_VAULT_ADDRESS; // Din personliga plÃ¥nbok fÃ¶r vinst
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
    console.warn('âš ï¸ DEV_FREE_PLAY is ON â€” join/cashout/reset use simulated money (no real Solana).');
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

// Kontrollera att kritiska miljÃ¶variabler finns
if (!HOUSE_WALLET_ADDRESS || !HOUSE_WALLET_SECRET) {
    console.warn("âš ï¸ VARNING: HOUSE_WALLET_ADDRESS eller HOUSE_WALLET_SECRET saknas i miljÃ¶variablerna!");
    console.warn("Transaktioner och cashouts kommer inte att fungera.");
} else {
    console.log("âœ… Solana House Wallet konfigurerad: " + HOUSE_WALLET_ADDRESS);
}

validateBRWalletsOnStartup({ devFreePlay: DEV_FREE_PLAY });

// Reward wallet startup validation
if (REWARD_WALLET_ADDRESS && REWARD_WALLET_SECRET) {
    console.log('âœ… Reward Wallet configured:', REWARD_WALLET_ADDRESS);
} else if (REWARD_WALLET_ADDRESS || REWARD_WALLET_SECRET) {
    console.warn('âš ï¸  Reward Wallet incomplete â€” set BOTH REWARD_WALLET_ADDRESS and REWARD_WALLET_SECRET.');
} else {
    console.warn('âš ï¸  Reward Wallet not configured â€” reward pool contributions tracked in-memory only (no on-chain transfers).');
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

// --- 1. MODELLER & KONFIGURATION (Flyttade till toppen fÃ¶r att undvika krascher) ---

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, unique: true, sparse: true },
    googleId: { type: String, unique: true, sparse: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 }, // Tracked in raw SOL
    visualBalanceOverrideUsd: { type: Number, default: null }, // UI-only admin override; never used for payments or gameplay
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

/** In-game cashouts only â€” excludes account withdrawals to external wallets. */
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

function createCompetitive…82333 tokens truncated…1.5;

                    const fleeAngle = Math.atan2(fleeY, fleeX);
                    // LÃ¤gg till lite "panik-brus" i rÃ¶relsen (+- 15 grader)
                    const panicAngle = fleeAngle + (Math.random() - 0.5) * 0.5;
                    player.targetX = head.x + Math.cos(panicAngle) * 600;
                    player.targetY = head.y + Math.sin(panicAngle) * 600;

                } else if (targetPrey) {
                    // JAGA! Spring mot bytet med lite felmarginal fÃ¶r att simulera mÃ¤nsklighet
                    const preyAngle = Math.atan2(targetPrey.y - head.y, targetPrey.x - head.x) + (Math.random() - 0.5) * 0.2;
                    player.targetX = head.x + Math.cos(preyAngle) * 500;
                    player.targetY = head.y + Math.sin(preyAngle) * 500;

                } else {
                    // MAT: Hitta nÃ¤rmaste matbit
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
                        // Vandra slumpmÃ¤ssigt
                        player.targetX = Math.max(200, Math.min(c.worldWidth - 200, head.x + (Math.random() - 0.5) * 1500));
                        player.targetY = Math.max(200, Math.min(c.worldHeight - 200, head.y + (Math.random() - 0.5) * 1500));
                    }
                }
            }

            // Simulera input fÃ¶r fysikmotorn
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

        // 1. BerÃ¤kna rÃ¶relse fÃ¶r alla celler
        for (let i = 0; i < player.cells.length; i++) {
            const cell = player.cells[i];
            
            // PHYSICS: Movement & Friction
            // AnvÃ¤nder balans som bas fÃ¶r hastighet (normaliserad med faktor 50)
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
            cell.vX = velX; // Skicka med hastighet fÃ¶r slime-effekt
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
                    // Virusexplosion baserat pÃ¥ massa
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
                        // SÃ¤nkt trÃ¶skel till 5% (1.05) och mer fÃ¶rlÃ¥tande avstÃ¥nd (d < r fÃ¶r en mjukare kÃ¤nsla dÃ¤r man Ã¤ter lÃ¤ttare)
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

        // 3. StÃ¤da upp raderade celler och berÃ¤kna nytt centrum
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

    // Slither server-side physics tick (40Hz) â€” network broadcast at 40Hz
    const slitherLeaderboard = processSlitherRoom(room, io, User, Transaction);

    const slitherMeta = {
        resetTime: room.startTime + c.roomDuration,
        solPrice: SOL_PRICE_USD,
        isResetting: room.isResetting,
        battleRoyale: room.isBattleRoyale === true,
    };
    broadcastSlitherState(room, io, slitherLeaderboard, slitherMeta);

    // Skicka leaderboard separat fÃ¶r prestanda (Inkludera bottar)
    const leaderboardData = allUsers
        .map(p => ({
            id: p.id,
            name: p.username,
            massTotal: arenaCashoutUsd(p),
            balance: arenaCashoutUsd(p),
        }))
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 10);

    // Skapa en kopia fÃ¶r leaderboard med USD-vÃ¤rden
    const visualLeaderboard = leaderboardData.map(entry => ({
        ...entry,
        massTotal: Number(entry.massTotal).toFixed(2),
        balance: Number(entry.balance).toFixed(2)
    }));

    if (isSandbox) {
        room.sandboxNetworkTick = (room.sandboxNetworkTick || 0) + 1;
        if (room.sandboxNetworkTick % 2 !== 0) return;
    }

    room.players.forEach(p => {
        if (p.mode === 'slither' || p.disconnected) return;

        io.to(p.id).emit('leaderboard', { leaderboard: visualLeaderboard });

        // Spatial filtering â€” food range is wider than entity range to reduce edge pop-in.
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

httpServer.listen(PORT, () => console.log(`Servern kÃ¶rs pÃ¥ port ${PORT}`));

