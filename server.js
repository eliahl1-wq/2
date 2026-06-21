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
import { randomUUID } from 'crypto';
import fetch from 'node-fetch'; // Se till att du kör 'npm install node-fetch'
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import {
    SLITHER,
    COMPETITIVE_SLITHER,
    createSlitherPlayer,
    createCompetitiveSlitherPlayer,
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
    getCompetitiveZone,
    addSlitherFood,
    createSegments,
} from './slither-engine.js';
import {
    ALLOWED_ENTRY_FEES,
    DEFAULT_ENTRY_FEE,
    COMPETITIVE_SLITHER_ENTRY_FEES,
    DEFAULT_COMPETITIVE_ENTRY_FEE,
    normalizeEntryFee,
    normalizeCompetitiveEntryFee,
    getEconomy,
    getCompetitiveEconomy,
    getJoinPoolSplit,
    getGoldenBlobValue,
    wealthTaxDecayAmount,
} from './economy.js';
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
import { validateBRWalletsOnStartup, listBRHouseWallets } from './br-wallets.js';

// --- SOLANA KONFIGURATION ---
const HOUSE_WALLET_ADDRESS = process.env.HOUSE_WALLET_ADDRESS;
const HOUSE_WALLET_SECRET = process.env.HOUSE_WALLET_SECRET;
const OWNER_VAULT_ADDRESS = process.env.OWNER_VAULT_ADDRESS; // Din personliga plånbok för vinst
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || solanaWeb3.clusterApiUrl('mainnet-beta');
const connection = new solanaWeb3.Connection(SOLANA_RPC_URL, 'confirmed');
const DEV_FREE_PLAY = process.env.DEV_FREE_PLAY === 'true';
let SOL_PRICE_USD = 57; // Default fallback price, updated by market scanner

if (DEV_FREE_PLAY) {
    console.warn('⚠️ DEV_FREE_PLAY is ON — join/cashout/reset use simulated money (no real Solana).');
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

const Transaction = mongoose.model('Transaction', TransactionSchema);

/** In-game cashouts only — excludes account withdrawals to external wallets. */
const GAME_CASHOUT_REASON_RE = /Arena Cashout|Admin Forced Cashout|Auto Room Reset|BR Victory/i;

function buildGameCashoutTxFilter() {
    return {
        type: 'withdraw',
        'meta.reason': { $regex: GAME_CASHOUT_REASON_RE },
        'meta.destination': { $exists: false },
        'meta.event': { $nin: ['pool_sweep', 'br_owner_sweep'] },
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
    ejectMassGain: 0.04,
    massLossRate: 1.0,
    mergeTimer: 30,
    speedMult: 1.1,
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

const CASHOUT_DURATION_MS = 10_000;
const joiningUsers = new Set();

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
        viruses: [],
        ejected: [],
        foodPoolBalance: 0,
        aiBudgetBalance: 0,
        ownerBalance: 0,
        startTime: GLOBAL_ARENA_START,
        isResetting: false,
        qt: new QuadTree(new Rectangle(c.worldWidth / 2, c.worldHeight / 2, c.worldWidth / 2, c.worldHeight / 2), 4),
        lastHumanTime: Date.now(),
    };
}

const rooms = ALLOWED_ENTRY_FEES.map(fee => createArenaRoom(fee));

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
        user.playtime += (Date.now() - player.startTime);
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
    if (totalLamports < payoutLamports + feeLamports + feeBuffer) {
        throw new Error('House wallet lacks liquidity');
    }

    const transaction = new solanaWeb3.Transaction();
    transaction.add(
        solanaWeb3.SystemProgram.transfer({
            fromPubkey: housePubKey,
            toPubkey: new solanaWeb3.PublicKey(user.depositAddress),
            lamports: payoutLamports,
        })
    );
    if (feeLamports > 0 && OWNER_VAULT_ADDRESS) {
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
            feeSolAmount: feeLamports / solanaWeb3.LAMPORTS_PER_SOL,
            feeDestination: OWNER_VAULT_ADDRESS || null,
        },
        status: 'confirmed',
    });

    console.log(`💰 COMPETITIVE CASHOUT: $${playerPayout.toFixed(2)} to ${user.depositAddress}, fee $${platformFee.toFixed(2)}, sig ${signature}`);
    io.to(playerId).emit('cashOutSuccess', { amount: playerPayout, signature });
    return { playerPayout, platformFee, signature };
}

async function cashOutCompetitiveRoomPlayers(room) {
    const playersToProcess = [...room.players];
    for (const p of playersToProcess) {
        if (p.isCashingOut) continue;
        const mongoId = p.mongoId?.toString();
        if (!acquireCashoutLock(mongoId)) continue;
        try {
            await executeCompetitiveCashout(p, room, 'Auto Room Reset');
        } catch (err) {
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
    room.players = [];
}

// --- RESET FLOW LOGIC ---
async function cashOutRoomPlayers(room) {
    const playersToProcess = [...room.players];
    for (const p of playersToProcess) {
        if (p.isCashingOut || !acquireCashoutLock(p.mongoId)) {
            console.log(`⏭️ Reset skip cashout for ${p.username} (cashout in progress)`);
            continue;
        }
        try {
            const user = await User.findById(p.mongoId);
            if (!user) continue;

            if (DEV_FREE_PLAY) {
                user.playtime += (Date.now() - p.startTime);
                await user.save();
                await Transaction.create({
                    userId: user._id,
                    type: 'withdraw',
                    amount: arenaCashoutUsd(p),
                    meta: {
                        simulated: true,
                        reason: 'Auto Room Reset (Free Play)',
                        roomId: room.id,
                        entryFeeUsd: room.entryFeeUsd,
                    },
                });
                io.to(p.id).emit('cashOutSuccess', { amount: arenaCashoutUsd(p), reason: 'Room Reset', signature: 'simulated' });
            } else if (user.depositAddress && HOUSE_WALLET_SECRET) {
                const cashoutUsd = arenaCashoutUsd(p);
                const solToTransfer = cashoutUsd / SOL_PRICE_USD;
                const lamports = Math.round(solToTransfer * solanaWeb3.LAMPORTS_PER_SOL);

                const houseKeypair = solanaWeb3.Keypair.fromSecretKey(
                    Uint8Array.from(Buffer.from(HOUSE_WALLET_SECRET, 'hex'))
                );
                const transaction = new solanaWeb3.Transaction().add(
                    solanaWeb3.SystemProgram.transfer({
                        fromPubkey: houseKeypair.publicKey,
                        toPubkey: new solanaWeb3.PublicKey(user.depositAddress),
                        lamports: lamports,
                    })
                );
                const sig = await solanaWeb3.sendAndConfirmTransaction(connection, transaction, [houseKeypair]);

                user.playtime += (Date.now() - p.startTime);
                await user.save();

                await Transaction.create({
                    userId: user._id,
                    type: 'withdraw',
                    amount: arenaCashoutUsd(p),
                    currency: 'USD',
                    meta: {
                        signature: sig,
                        reason: 'Auto Room Reset to Account Address',
                        destination: user.depositAddress,
                        roomId: room.id,
                        entryFeeUsd: room.entryFeeUsd,
                    },
                });

                io.to(p.id).emit('cashOutSuccess', { amount: cashoutUsd, reason: 'Room Reset', signature: sig });
            } else {
                console.warn(`⚠️ Reset cashout skipped for ${p.username}: no depositAddress or house wallet`);
                await Transaction.create({
                    type: 'game',
                    amount: 0,
                    meta: { event: 'failure', reason: 'auto_cashout_no_wallet', userId: p.mongoId, balance: p.balance },
                });
            }
        } catch (err) {
            await Transaction.create({
                type: 'game',
                amount: 0,
                meta: { event: 'failure', reason: 'auto_cashout_failed', userId: p.mongoId, error: err.message },
            });
        } finally {
            releaseCashoutLock(p.mongoId);
        }
    }
    room.players = [];
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
}

async function sweepHouseWalletOnReset() {
    // Only the main arena house wallet — BR house wallets are separate env keys and never touched here.
    if (DEV_FREE_PLAY || !HOUSE_WALLET_ADDRESS || !HOUSE_WALLET_SECRET || !OWNER_VAULT_ADDRESS) return;

    const housePubKey = new solanaWeb3.PublicKey(HOUSE_WALLET_ADDRESS);
    const totalLamports = await connection.getBalance(housePubKey);
    const solPrice = Number(SOL_PRICE_USD || 64);
    const bufferLamports = Math.round((1.0 / solPrice) * solanaWeb3.LAMPORTS_PER_SOL);
    const sweepLamports = totalLamports - bufferLamports;

    if (sweepLamports <= 0) return;

    const houseKeypair = solanaWeb3.Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(HOUSE_WALLET_SECRET, 'hex'))
    );
    const sweepTx = new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.transfer({
            fromPubkey: houseKeypair.publicKey,
            toPubkey: new solanaWeb3.PublicKey(OWNER_VAULT_ADDRESS),
            lamports: sweepLamports,
        })
    );
    const sig = await solanaWeb3.sendAndConfirmTransaction(connection, sweepTx, [houseKeypair]);

    await Transaction.create({
        type: 'withdraw',
        amount: (sweepLamports / solanaWeb3.LAMPORTS_PER_SOL) * SOL_PRICE_USD,
        currency: 'SOL',
        meta: {
            event: 'pool_sweep',
            signature: sig,
            reason: 'Room Reset Wallet Sweep',
            solAmount: sweepLamports / solanaWeb3.LAMPORTS_PER_SOL,
            from: HOUSE_WALLET_ADDRESS,
            destination: OWNER_VAULT_ADDRESS,
        },
    });
    console.log(`💸 Wallet Sweep: ${sweepLamports / solanaWeb3.LAMPORTS_PER_SOL} SOL sent to owner.`);
}

async function performGlobalArenaReset() {
    if (globalArenaResetting) return;
    globalArenaResetting = true;
    for (const room of rooms) room.isResetting = true;
    for (const room of competitiveSlitherRooms) room.isResetting = true;

    console.log('🚨 GLOBAL ARENA RESET STARTED (all stake tiers — BR matches unaffected)');
    await Transaction.create({
        type: 'game',
        amount: 0,
        meta: { event: 'reset_start', roomId: 'all', tiers: ALLOWED_ENTRY_FEES },
        status: 'confirmed',
    });

    try {
        for (const room of rooms) {
            await cashOutRoomPlayers(room);
        }
        for (const room of competitiveSlitherRooms) {
            await cashOutCompetitiveRoomPlayers(room);
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
        }

        for (const room of rooms) {
            resetRoomEntities(room);
        }
        for (const room of competitiveSlitherRooms) {
            room.players = [];
            room.slitherFood = [];
            room.competitiveSpectators = [];
        }

        GLOBAL_ARENA_START = Date.now();
        for (const room of rooms) {
            room.startTime = GLOBAL_ARENA_START;
        }
        for (const room of competitiveSlitherRooms) {
            room.startTime = GLOBAL_ARENA_START;
        }

        console.log('✅ GLOBAL ARENA RESET COMPLETE');
        await Transaction.create({
            type: 'game',
            amount: 0,
            meta: { event: 'reset_complete', roomId: 'all', tiers: ALLOWED_ENTRY_FEES },
            status: 'confirmed',
        });
    } finally {
        for (const room of rooms) room.isResetting = false;
        for (const room of competitiveSlitherRooms) room.isResetting = false;
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
                const lamports = await connection.getBalance(pubKey);
                const solOnChain = lamports / solanaWeb3.LAMPORTS_PER_SOL;

                // AUTOMATISK SYNK: Databasen speglar alltid vad som finns på plånboken
                if (Math.abs(user.balance - solOnChain) > 0.00001) {
                    user.balance = solOnChain;
                    await user.save();
                }
            } catch (e) { console.error(`Sync error for ${user.username}:`, e.message); }
        }
    } catch (err) {
        console.error("Scanner Error:", err.message);
    } finally {
        isScanningDeposits = false;
    }
}

// Starta scannern var 15:e sekund
setInterval(async () => {
    if (!isScanningDeposits) await scanDeposits();
}, 15000);

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
        const secret = process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig";
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

    const jwtSecret = process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig";

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
        if (user.depositAddress) {
            try {
                const pubKey = new solanaWeb3.PublicKey(user.depositAddress);
                const lamports = await connection.getBalance(pubKey);
                solOnChain = lamports / solanaWeb3.LAMPORTS_PER_SOL;

                if (Math.abs(user.balance - solOnChain) > 0.00001) {
                    user.balance = solOnChain;
                    await user.save();
                }
            } catch (e) { console.error("Sync error in /api/me:", e.message); }
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
            || competitiveSlitherRooms.some(r => r.isResetting);
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

// --- NYTT: Endpoint för att verifiera insättning och spara i historik ---
app.post('/api/deposit-verify', authenticateToken, async (req, res) => {
    const { signature } = req.body;
    try {
        if (!signature) return res.status(400).json({ message: 'Missing signature' });

        const existing = await Transaction.findOne({ 'meta.signature': signature });
        if (existing) return res.json({ success: true, message: 'Already processed' });

        const txDetails = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
        if (!txDetails || txDetails.meta?.err) {
            return res.status(400).json({ message: 'Invalid on-chain transaction' });
        }

        const user = await User.findById(req.user.id);
        if (!user?.depositAddress) return res.status(404).json({ message: 'Användare hittades ej' });

        const depositPubkey = new solanaWeb3.PublicKey(user.depositAddress);
        const accountKeys = txDetails.transaction.message.staticAccountKeys;
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

        const solReceived = creditedLamports / solanaWeb3.LAMPORTS_PER_SOL;
        user.balance += solReceived;
        await user.save();

        await Transaction.create({
            userId: user._id,
            type: 'deposit',
            amount: solReceived,
            currency: 'SOL',
            meta: { signature, solAmount: solReceived, amountUsd: solReceived * SOL_PRICE_USD, verifiedOnChain: true },
            status: 'confirmed',
        });

        res.json({ success: true, balance: user.balance, solReceived });
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
        const accountKeys = txDetails.transaction.message.staticAccountKeys;
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
    if (m.event === 'pool_sweep' || m.event === 'br_owner_sweep') return 'sweep';
    if (tx.type === 'game') {
        if (m.event === 'join' || m.event === 'br_join') return 'entry';
        if (m.reason === 'Arena Death' || m.reason === 'BR Eliminated') return 'death';
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
                'meta.event': { $nin: ['pool_sweep', 'br_owner_sweep'] },
                'meta.reason': { $not: { $regex: GAME_CASHOUT_REASON_RE } },
            };
        case 'entry':
            return { type: 'game', 'meta.event': { $in: ['join', 'br_join'] } };
        case 'cashout':
            return buildGameCashoutTxFilter();
        case 'death':
            return { type: 'game', 'meta.reason': { $in: ['Arena Death', 'BR Eliminated'] } };
        case 'sweep':
            return { $or: [{ 'meta.event': 'pool_sweep' }, { 'meta.event': 'br_owner_sweep' }] };
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
            'meta.event': { $nin: ['pool_sweep', 'br_owner_sweep'] },
        });
        const [depositAgg, withdrawAgg, excludedTxCount, excludedUsersCount, ownerEarnings, userBalanceAgg] = await Promise.all([
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
                { $group: { _id: null, totalBalanceSol: { $sum: { $ifNull: ['$balance', 0] } }, accountCount: { $sum: 1 } } },
            ]),
        ]);

        const totalDepositsSol = depositAgg[0]?.total ?? 0;
        const totalDepositsUsd = totalDepositsSol * SOL_PRICE_USD;

        let totalWithdrawalsUsd = 0;
        for (const tx of withdrawAgg[0]?.txs ?? []) {
            totalWithdrawalsUsd += txAmountUsd(tx);
        }

        const totalUserBalanceSol = userBalanceAgg[0]?.totalBalanceSol ?? 0;
        const totalAccounts = userBalanceAgg[0]?.accountCount ?? 0;

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
            totalAccounts,
            totalUserBalanceSol: Number(totalUserBalanceSol.toFixed(6)),
            totalUserBalanceUsd: Number((totalUserBalanceSol * SOL_PRICE_USD).toFixed(2)),
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

        const presenceData = Array.from(sitePresence.entries())
            .filter(([_, data]) => Date.now() - (data.lastSeen || data) < PRESENCE_TTL_MS)
            .map(([k, data]) => ({
                id: k,
                ip: data.ip || 'Unknown',
                country: data.country || 'Unknown',
                page: data.page || 'unknown',
                gamemode: data.gamemode || 'none',
                userAgent: data.userAgent || 'Unknown',
                lastSeen: data.lastSeen || data
            }))
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
        const users = await User.find(userFilter).select('username walletAddress depositAddress balance excludedFromReports playtime email').lean();
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
            if (tx.type === 'withdraw' && tx.status === 'confirmed' && !['pool_sweep', 'br_owner_sweep'].includes(tx.meta?.event)) {
                totalWithdrawnUsd += txAmountUsd(tx);
                withdrawalCount += 1;
            }
            if (tx.type === 'game' && ['join', 'br_join'].includes(tx.meta?.event)) gameJoinCount += 1;
            if (tx.type === 'game' && ['Arena Death', 'BR Eliminated'].includes(tx.meta?.reason)) deathCount += 1;
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
            if (join.meta?.reason === 'Arena Death' || join.meta?.reason === 'BR Eliminated') eventType = 'death';

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
                excludedFromReports: !!user.excludedFromReports,
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
            andClauses.push({ type: 'game', 'meta.reason': { $in: ['Arena Death', 'BR Eliminated'] } });
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
            else if (tx.meta?.reason === 'Arena Death' || tx.meta?.reason === 'BR Eliminated') eventType = 'death';
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
        await sweepHouseWalletOnReset();
        res.json({
            success: true,
            message: 'Main house wallet sweep completed. BR house wallets were not touched.',
            wallet: HOUSE_WALLET_ADDRESS || null,
        });
    } catch (err) {
        console.error('Admin manual sweep failed:', err);
        res.status(500).json({ error: err.message });
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

        const amount = arenaCashoutUsd(p);
        if (!acquireCashoutLock(p.mongoId)) {
            return res.status(409).json({ message: 'Cashout already in progress for this player' });
        }

        try {
            const user = await User.findById(userId);
            if (!user) return res.status(404).send("User not found");

            if (DEV_FREE_PLAY) {
                room.players = room.players.filter(pl => pl.mongoId.toString() !== userId);
                await Transaction.create({
                    userId: user._id,
                    type: 'withdraw',
                    amount,
                    meta: { simulated: true, reason: 'Admin Forced Cashout' },
                });
                io.to(p.id).emit('cashOutSuccess', { amount });
                return res.json({ success: true, simulated: true });
            }

            const userWithWallet = await ensureUserDepositWallet(user);
            if (!userWithWallet.depositAddress || !HOUSE_WALLET_SECRET) {
                return res.status(500).json({ message: 'House wallet or player deposit address not configured' });
            }

            const solToWithdraw = amount / SOL_PRICE_USD;
            const lamports = Math.round(solToWithdraw * solanaWeb3.LAMPORTS_PER_SOL);
            const houseKeypair = solanaWeb3.Keypair.fromSecretKey(
                Uint8Array.from(Buffer.from(HOUSE_WALLET_SECRET, 'hex'))
            );
            const transaction = new solanaWeb3.Transaction().add(
                solanaWeb3.SystemProgram.transfer({
                    fromPubkey: houseKeypair.publicKey,
                    toPubkey: new solanaWeb3.PublicKey(userWithWallet.depositAddress),
                    lamports,
                })
            );
            const signature = await solanaWeb3.sendAndConfirmTransaction(connection, transaction, [houseKeypair]);

            room.players = room.players.filter(pl => pl.mongoId.toString() !== userId);
            await Transaction.create({
                userId: user._id,
                type: 'withdraw',
                amount,
                meta: { signature, reason: 'Admin Forced Cashout', entryFeeUsd: room.entryFeeUsd },
            });
            io.to(p.id).emit('cashOutSuccess', { amount, signature });
            res.json({ success: true, signature });
        } finally {
            releaseCashoutLock(p.mongoId);
        }
    } catch (err) { res.status(500).send(err.message); }
});

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/agario_db";

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    .then(() => console.log("Ansluten till databasen!"))
    .catch(err => console.error("Kunde inte ansluta:", err));

// 3. REGISTRERING (Spara ny användare)
app.post('/api/register', async (req, res) => {
    try {
        const { email, username, password } = req.body;

        // Kolla om användaren redan finns
        const existingUser = await User.findOne({ $or: [{ username }, { email }] });
        if (existingUser) return res.status(400).json({ message: "Username or Email already taken" });

        // Hasha lösenordet (gör det oläsbart)
        const hashedPassword = await bcrypt.hash(password, 10);

        // Generera unik Solana-plånbok för insättningar
        const keypair = solanaWeb3.Keypair.generate();

        const newUser = new User({
            email,
            username,
            password: hashedPassword,
            balance: 0,
            depositAddress: keypair.publicKey.toBase58(),
            depositSecret: Buffer.from(keypair.secretKey).toString('hex')
        });

        await newUser.save();
        console.log("✅ SUCCESS: Användare skapad i databasen:", newUser.username);
        res.status(201).json({
            message: "Användare skapad!",
            userId: newUser._id.toString(),
            username: newUser.username,
        });
    } catch (err) {
        console.error("Fel vid registrering:", err.message);
        res.status(500).json({ error: err.message });
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
        const secret = process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig";
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
    const key = customKey || (req && req.headers ? req.headers['x-presence-id'] : null) || (req ? req.ip : 'unknown');
    if (!key) return;

    const existing = sitePresence.get(String(key)) || {};
    let ip = existing.ip;
    let country = existing.country || 'Unknown';
    let userAgent = existing.userAgent || 'Unknown';
    let page = existing.page || 'unknown';
    let gamemode = existing.gamemode || 'none';

    if (req && req.headers) {
        ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || ip;
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
    for (const [key, data] of sitePresence) {
        const seenAt = typeof data === 'number' ? data : data.lastSeen;
        if (seenAt < cutoff) sitePresence.delete(key);
    }
    return sitePresence.size;
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
        const playersByGamemode = { agar: 0, slither: 0, brAgar: 0, brSlither: 0, competitiveSlither: 0 };
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

        const totalPlayersOnline = playersByGamemode.agar + playersByGamemode.slither
            + playersByGamemode.brAgar + playersByGamemode.brSlither
            + playersByGamemode.competitiveSlither;

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
                { type: 'game', 'meta.reason': { $in: ['Arena Death', 'BR Eliminated'] } },
            ],
        });

        const txs = await Transaction.find(baseMatch).sort({ createdAt: -1 }).limit(limit).lean();
        const userIds = [...new Set(txs.map(t => t.userId?.toString()).filter(Boolean))];
        const users = await User.find({ _id: { $in: userIds } }).select('username').lean();
        const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u.username]));

        const events = txs.map((tx) => {
            const username = tx.userId ? (userMap[tx.userId.toString()] || 'Unknown') : 'Unknown';
            const amountUsd = Number(txAmountUsd(tx).toFixed(2));
            const isDeath = tx.type === 'game' && ['Arena Death', 'BR Eliminated'].includes(tx.meta?.reason);
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
        const txs = await Transaction.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(200);
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
    return player.cells.reduce((sum, cell) => sum + cell.balance, 0);
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
    const total = player.dollarBalance ?? player.balance ?? 0;
    const decay = wealthTaxDecayAmount(total, minDollars);
    if (decay <= 1e-9) return;
    const actual = Math.min(decay, total - minDollars);
    room.foodPoolBalance += actual;
    if (player.dollarBalance != null) {
        player.dollarBalance = Math.max(minDollars, player.dollarBalance - actual);
    } else {
        const cellTotal = playerTotalMass(player);
        if (cellTotal <= 1e-9) return;
        for (const cell of player.cells) {
            cell.balance -= actual * (cell.balance / cellTotal);
            cell.radius = calculateCellRadius(
                cell.balance,
                playerTotalMass(player),
                player.cells.length,
                playerMassStart(player),
            );
        }
    }
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
    return null;
}

function getRoomForEntry(entryFeeUsd) {
    const fee = normalizeEntryFee(entryFeeUsd);
    return rooms.find(r => r.entryFeeUsd === fee) ?? rooms.find(r => r.entryFeeUsd === DEFAULT_ENTRY_FEE);
}

function isArenaResetting() {
    return globalArenaResetting || rooms.some(r => r.isResetting)
        || competitiveSlitherRooms.some(r => r.isResetting);
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
        for (const cell of player.cells) {
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
    const targetEntities = 12;
    if (humanCount >= targetEntities) return 0;

    return Math.min(8, targetEntities - humanCount);
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

function calculateCellRadius(cellMass, playerTotalMass, cellCount, massStart = c.playerStartBalance) {
    const startMassPerCell = massStart / cellCount;
    const extraMass = Math.max(0, cellMass - startMassPerCell);
    const visualMass = cellMass + (extraMass * (c.growthBoost - 1));
    return util.massToRadius(visualMass * c.sizeMult);
}

io.on('connection', (socket) => {
    touchSitePresence(socket.request, socket.id);

    socket.on('joinGame', async ({ username, token, mode, entryFeeUsd: rawEntryFee }) => {
        let userKey = null;
        try {
            if (mode === 'br-agar' || mode === 'br-slither') {
                socket.emit('error', 'Use the Battle Royale queue to join.');
                return;
            }
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig");
            let user = await User.findById(decoded.id);
            if (!user) {
                socket.emit('error', 'Account not found — please log in again.');
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
                    if (currentLamports < (feeLamports + 15000)) { // +15000 lamports for tx fee buffer
                        socket.emit('error', `Insufficient SOL on your account address for $${entryFeeUsd} entry.`);
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
                        console.log(`🎟️ Competitive Slither Entry: ${user.username} paid $${entryFeeUsd}. Sig: ${sig}`);
                    } catch (txErr) {
                        console.error('Competitive join transaction failed:', txErr.message);
                        socket.emit('error', 'Blockchain transfer failed. Please try again.');
                        return;
                    }
                } else {
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
                    util.randomSlitherColor(),
                    room,
                );

                const raced = room.players.find(p => p.mongoId?.toString() === userKey);
                if (raced) {
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

            const entryFeeUsd = normalizeEntryFee(rawEntryFee);
            const economy = getEconomy(entryFeeUsd);

            const existing = findPlayerInArena(userKey);
            if (existing && existing.room.isCompetitiveSlither) {
                socket.emit('error', 'You have an active Competitive Slither game. Rejoin or cash out first.');
                return;
            }
            if (existing && existing.room.entryFeeUsd !== entryFeeUsd) {
                socket.emit('error', `You have an active $${existing.room.entryFeeUsd} game. Rejoin that stake tier first.`);
                return;
            }

            const room = existing?.room ?? getRoomForEntry(entryFeeUsd);
            const existingPlayer = existing?.player ?? null;

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

            if (!DEV_FREE_PLAY) {
                // 1. Kontrollera on-chain balans direkt innan start
                const userPubKey = new solanaWeb3.PublicKey(user.depositAddress);
                const currentLamports = await connection.getBalance(userPubKey);
                const feeLamports = Math.round(entryFeeInSol * solanaWeb3.LAMPORTS_PER_SOL);

                if (currentLamports < (feeLamports + 15000)) { // +15000 lamports for tx fee buffer
                    socket.emit('error', `Insufficient SOL on your account address for $${entryFeeUsd} entry.`);
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
                    console.log(`🎟️ Arena Entry: ${user.username} paid $${entryFeeUsd}. Sig: ${sig}`);
                } catch (txErr) {
                    console.error("Join transaction failed:", txErr.message);
                    socket.emit('error', 'Blockchain transfer failed. Please try again.');
                    return;
                }
            } else {
                console.log(`🎮 [FREE PLAY] ${user.username} joined (simulated $${entryFeeUsd} entry)`);
            }

            // Log Join
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

            // DYNAMIC ECONOMY SPLIT (scaled to entry tier, per mode population)
            const gameMode = mode === 'slither' ? 'slither' : 'agar';
            const modeHumansAfterJoin = countHumansInMode(room, gameMode) + 1;
            const { food: foodAlloc, ai: aiAlloc } = getJoinPoolSplit(entryFeeUsd, modeHumansAfterJoin);
            const goldenBlobValue = getGoldenBlobValue(entryFeeUsd);
            const foodToPool = Math.max(0, foodAlloc - goldenBlobValue);

            // Only fund bots up to the cap for current population; surplus → food pool
            const agarAfter = countHumansInMode(room, 'agar') + (gameMode === 'agar' ? 1 : 0);
            const slitherAfter = countHumansInMode(room, 'slither') + (gameMode === 'slither' ? 1 : 0);
            const joinBotStake = economy.botStartBalance;
            const maxAi = getTargetBots(agarAfter) * joinBotStake + getSlitherTargetBots(slitherAfter) * joinBotStake;
            const aiDeficit = Math.max(0, maxAi - room.aiBudgetBalance);
            const aiToAdd = Math.min(aiAlloc, aiDeficit);
            room.aiBudgetBalance += aiToAdd;
            room.foodPoolBalance += foodToPool + (aiAlloc - aiToAdd);

            room.ownerBalance += economy.ownerCut;

            // DYNAMIC BOT SCALING (mode-specific)
            let targetBots = gameMode === 'slither'
                ? getSlitherTargetBots(modeHumansAfterJoin)
                : getTargetBots(modeHumansAfterJoin);

            if (gameMode === 'slither') {
                targetBots += room.slitherBots.filter(b => b.adminSpawned).length;
                if (room.slitherBots.length < targetBots) {
                    addSlitherBots(room, targetBots - room.slitherBots.length, joinBotStake);
                } else if (room.slitherBots.length > targetBots) {
                    trimSlitherBots(room, targetBots);
                }
            } else {
                targetBots += room.bots.filter(b => b.adminSpawned).length;
                if (room.bots.length < targetBots) {
                    addBots(room, targetBots - room.bots.length, joinBotStake);
                } else if (room.bots.length > targetBots) {
                    trimAgarBots(room, targetBots);
                }
            }

            socket.roomId = room.id;

            const startMass = economy.massStartBalance;
            const startDollars = economy.playerStartBalance;
            let newPlayer;

            if (gameMode === 'slither') {
                newPlayer = createSlitherPlayer(
                    socket.id,
                    user._id,
                    username || user.username,
                    util.randomSlitherColor(),
                    room,
                    startMass,
                    startDollars,
                );
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
                    color: util.randomColor(),
                    x: c.worldWidth / 2,
                    y: c.worldHeight / 2,
                    mouseX: 0,
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
            }

            // Race guard: another join may have completed while we awaited payment
            const raced = room.players.find(p => p.mongoId?.toString() === userKey);
            if (raced) {
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
            const secret = process.env.JWT_SECRET || "464163655a063465904c19aed8d3566cc5dfe1627dce6857e70abb1efad0c193";
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
            const isCompSlither = room.isCompetitiveSlither;
            const isSlither = isCompSlither || mode === 'slither' || (p && p.mode === 'slither') || room.id.includes('slither');
            const stake = botStakeForRoom(room);
            const botNames = ["Sirius", "Gota", "AgarioMaster", "ProPlayer", "Legit", "Sanic", "Wojak", "Pepe", "Doge", "Spooderman", "U Mad?", "Team Me", "Solo King", "Blobby"];
            const startMass = getEconomy(room.entryFeeUsd ?? 0.10).massStartBalance;

            const spawnX = p ? ((isSlither ? p.x : p.cells?.[0]?.x) || 0) : (Math.random() * (isSlither ? SLITHER.worldHalf * 2 : c.worldWidth));
            const spawnY = p ? ((isSlither ? p.y : p.cells?.[0]?.y) || 0) : (Math.random() * (isSlither ? SLITHER.worldHalf * 2 : c.worldHeight));

            const offsetX = p ? (Math.random() - 0.5) * 600 : 0;
            const offsetY = p ? (Math.random() - 0.5) * 600 : 0;

            console.log(`[Admin Spawn] Spawning ${isCompSlither ? 'CompetitiveSlither' : isSlither ? 'Slither' : 'Agar'} bot at (${(spawnX + offsetX).toFixed(0)}, ${(spawnY + offsetY).toFixed(0)})`);

            if (isCompSlither) {
                // Competitive slither: bots live in room.players (no slitherBots array)
                const eco = getEconomy(room.entryFeeUsd ?? 2);
                const angle = Math.random() * Math.PI * 2;
                const bx = spawnX + offsetX;
                const by = spawnY + offsetY;
                room.players.push({
                    id: 'bot_' + Math.random().toString(36).substr(2, 5),
                    mongoId: null,
                    username: botNames[Math.floor(Math.random() * botNames.length)],
                    mode: 'competitive-slither',
                    kills: 0,
                    balance: startMass,
                    dollarBalance: eco.botStartBalance ?? stake,
                    entryFeeUsd: room.entryFeeUsd,
                    botStake: stake,
                    startTime: Date.now(),
                    spawnGraceUntil: Date.now() + 4500,
                    color: util.randomSlitherColor(),
                    x: bx,
                    y: by,
                    inputDx: Math.cos(angle),
                    inputDy: Math.sin(angle),
                    boost: false,
                    angle,
                    fam: 0,
                    segments: createSegments(bx, by, startMass, angle),
                    screenWidth: 1920,
                    screenHeight: 1080,
                    isBot: true,
                    adminSpawned: true,
                });
            } else if (isSlither) {
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
                    spawnGraceUntil: Date.now() + 4500,
                    color: util.randomSlitherColor(),
                    x: spawnX + offsetX,
                    y: spawnY + offsetY,
                    inputDx: Math.cos(angle),
                    inputDy: Math.sin(angle),
                    boost: false,
                    angle,
                    fam: 0,
                    segments: createSegments(spawnX + offsetX, spawnY + offsetY, startMass, angle),
                    screenWidth: 1920,
                    screenHeight: 1080,
                    isBot: true,
                    adminSpawned: true,
                });
            } else {
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
            const secret = process.env.JWT_SECRET || "464163655a063465904c19aed8d3566cc5dfe1627dce6857e70abb1efad0c193";
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
            br.player.mouseX = data.x;
            br.player.mouseY = data.y;
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
            p.mouseX = data.x;
            p.mouseY = data.y;
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

        let newCells = [];
        p.cells.forEach(cell => {
            const massStart = playerMassStart(p);
            const totalMass = playerTotalMass(p);
            if (cell.balance >= massStart * 2) {
                cell.balance /= 2;
                cell.radius = calculateCellRadius(cell.balance, totalMass, p.cells.length + 1, massStart);
                cell.lastSplit = Date.now(); // Starta timern även för ursprungscellen
                const angle = Math.atan2(p.mouseY, p.mouseX);
                newCells.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: cell.x, y: cell.y,
                    balance: cell.balance,
                    radius: calculateCellRadius(cell.balance, totalMass, p.cells.length + 1, massStart),
                    vx: Math.cos(angle) * 25,
                    vy: Math.sin(angle) * 25,
                    lastSplit: Date.now()
                });
            }
        });
        p.cells.push(...newCells);
    });

    // Protokoll-matchning: 1 = eject mass
    socket.on('1', () => {
        const room = rooms.find(r => r.id === socket.roomId);
        const p = room?.players.find(pl => pl.id === socket.id);
        if (!p) return;
        p.cells.forEach(cell => {
            const massStart = playerMassStart(p);
            const totalMass = playerTotalMass(p);
            if (cell.balance >= massStart * 1.5) {
                cell.balance -= c.ejectMass;
                cell.radius = calculateCellRadius(cell.balance, totalMass, p.cells.length, massStart);
                const angle = Math.atan2(p.mouseY, p.mouseX);
                const dirX = Number.isFinite(Math.cos(angle)) && (p.mouseX || p.mouseY) ? Math.cos(angle) : 1;
                const dirY = Number.isFinite(Math.sin(angle)) && (p.mouseX || p.mouseY) ? Math.sin(angle) : 0;
                // Recycle the spread (ejectMass − ejectMassGain) from player dollars into the food pool
                const spread = Math.max(0, c.ejectMass - c.ejectMassGain);
                const dollarStart = playerDollarStart(p);
                const dollarDrain = Math.min(spread, Math.max(0, (p.dollarBalance ?? 0) - dollarStart));
                if (dollarDrain > 1e-9) {
                    room.foodPoolBalance += dollarDrain;
                    p.dollarBalance = (p.dollarBalance ?? 0) - dollarDrain;
                }
                room.ejected.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: cell.x + dirX * (cell.radius + 20),
                    y: cell.y + dirY * (cell.radius + 20),
                    radius: 10,
                    vx: dirX * 22,
                    vy: dirY * 22,
                    hue: Math.floor(Math.random() * 360),
                    color: p.color,
                    balance: c.ejectMassGain
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

        // Meddela klienten att timern har börjat
        socket.emit('cashOutStarting', { seconds: duration / 1000 });

        setTimeout(async () => {
            const activeRoom = getArenaRoomById(roomId);
            const activePlayer = activeRoom?.players.find(pl => pl.mongoId.toString() === playerMongoId);

            if (!activePlayer || !activePlayer.isCashingOut) {
                console.log(`❌ Cashout cancelled (died or invalid state)`);
                releaseCashoutLock(playerMongoId);
                return;
            }

            if (isCompetitive || activePlayer.mode === 'competitive-slither') {
                try {
                    await executeCompetitiveCashout(activePlayer, activeRoom, 'Arena Cashout');
                } catch (err) {
                    console.error('❌ Competitive cashout error:', err.message);
                    io.to(activePlayer.id).emit('error', err.message || 'Transfer failed.');
                    activePlayer.isCashingOut = false;
                } finally {
                    releaseCashoutLock(playerMongoId);
                }
                return;
            }

            // REMOVE RANK BONUS: Pay out only the server-side balance
            const totalCashout = arenaCashoutUsd(activePlayer);
            const mongoId = activePlayer.mongoId;

            try {
                let user = await User.findById(mongoId);
                if (!user) {
                    console.log(`❌ Cashout failed: User ${activePlayer.username} not found in DB.`);
                    io.to(activePlayer.id).emit('error', 'Account not found.');
                    activePlayer.isCashingOut = false;
                    releaseCashoutLock(playerMongoId);
                    return;
                }

                if (DEV_FREE_PLAY) {
                    activeRoom.players = activeRoom.players.filter(pl => pl.mongoId.toString() !== playerMongoId);
                    user.playtime += (Date.now() - activePlayer.startTime);
                    await user.save();
                    await Transaction.create({
                        userId: user._id,
                        type: 'withdraw',
                        amount: totalCashout,
                        meta: {
                            simulated: true,
                            reason: 'Arena Cashout',
                            mode: activePlayer.mode || 'agar',
                            entryFeeUsd: activePlayer.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
                        },
                        status: 'confirmed',
                    });
                    console.log(`🎮 [FREE PLAY] Cashout: $${totalCashout.toFixed(2)} (simulated)`);
                    io.to(activePlayer.id).emit('cashOutSuccess', { amount: totalCashout, signature: 'simulated' });
                    releaseCashoutLock(playerMongoId);
                    return;
                }

                user = await ensureUserDepositWallet(user);
                if (!user.depositAddress) {
                    console.log(`❌ Cashout failed: User ${activePlayer.username} has no internal deposit address.`);
                    io.to(activePlayer.id).emit('error', 'Account internal error.');
                    activePlayer.isCashingOut = false;
                    releaseCashoutLock(playerMongoId);
                    return;
                }

                // 1. RAW SOL: Game balance is already in SOL units (cryptomass)
                const solToWithdraw = totalCashout / SOL_PRICE_USD; // Konvertera USD-massa till SOL för utbetalning
                const lamports = Math.round(solToWithdraw * solanaWeb3.LAMPORTS_PER_SOL);

                // Pre-flight liquidity check
                if (!HOUSE_WALLET_ADDRESS) throw new Error("House wallet not configured");
                const housePubKey = new solanaWeb3.PublicKey(HOUSE_WALLET_ADDRESS);
                const totalLamports = await connection.getBalance(housePubKey);
                const feeBuffer = Math.round(0.005 * solanaWeb3.LAMPORTS_PER_SOL);
                if (totalLamports < (lamports + feeBuffer)) {
                    console.error('[CASHOUT ERROR] House wallet lacks liquidity');
                    io.to(activePlayer.id).emit('error', 'House wallet lacks liquidity. Try again later.');
                    activePlayer.isCashingOut = false;
                    releaseCashoutLock(playerMongoId);
                    return;
                }

                // 2. Skapa transaktionen on-chain till användarens insättningsadress
                const houseKeypair = solanaWeb3.Keypair.fromSecretKey(
                    Uint8Array.from(Buffer.from(HOUSE_WALLET_SECRET, 'hex'))
                );

                const transaction = new solanaWeb3.Transaction().add(
                    solanaWeb3.SystemProgram.transfer({
                        fromPubkey: houseKeypair.publicKey,
                        toPubkey: new solanaWeb3.PublicKey(user.depositAddress),
                        lamports: lamports,
                    })
                );

                // 3. Robust Blockchain execution with error recovery
                let signature;
                try {
                    signature = await solanaWeb3.sendAndConfirmTransaction(connection, transaction, [houseKeypair]);
                } catch (err) {
                    console.error("Cashout transaction failed on-chain:", err.message);
                    io.to(activePlayer.id).emit('error', 'Blockchain transfer failed. Your game balance remains intact.');
                    activePlayer.isCashingOut = false;
                    releaseCashoutLock(playerMongoId);
                    return;
                }

                // Success: Remove player from arena only AFTER confirmed blockchain success
                activeRoom.players = activeRoom.players.filter(pl => pl.mongoId.toString() !== playerMongoId);

                // 4. Uppdatera playtime och logga i DB
                // OBS: Vi uppdaterar INTE user.balance här manuellt, 
                // eftersom scanDeposits() kommer upptäcka detta och göra det automatiskt.
                user.playtime += (Date.now() - activePlayer.startTime);
                await user.save();

                await Transaction.create({
                    userId: user._id,
                    type: 'withdraw',
                    amount: totalCashout,
                    meta: {
                        signature,
                        reason: 'Arena Cashout',
                        solAmount: solToWithdraw,
                        mode: activePlayer.mode || 'agar',
                        entryFeeUsd: activePlayer.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
                    },
                    status: 'confirmed'
                });

                console.log(`💰 CASHOUT TO ACCOUNT: $${totalCashout.toFixed(2)} moved to ${user.depositAddress}`);
                io.to(activePlayer.id).emit('cashOutSuccess', { amount: totalCashout, signature });

            } catch (err) {
                console.error("❌ Cashout error:", err.message);
                io.to(activePlayer.id).emit('error', 'Transfer failed.');
                if (activePlayer) activePlayer.isCashingOut = false;
            } finally {
                releaseCashoutLock(playerMongoId);
            }
        }, duration);
    });

    socket.on('disconnect', () => {
        const room = getArenaRoomById(socket.roomId);
        if (!room) return;
        if (room.isCompetitiveSlither) {
            removeCompetitiveSpectator(room, socket.id);
        }
        const p = room.players.find(pl => pl.id === socket.id);
        if (p) {
            p.disconnected = true;
            p.disconnectedAt = Date.now();
            const mongoId = p.mongoId?.toString();
            p.removeTimeout = setTimeout(() => {
                room.players = room.players.filter(x => x.mongoId?.toString() !== mongoId);
                console.log(`🗑️ Removed disconnected player ${p.username} after timeout`);
            }, 5 * 60 * 1000);
        }
    });

    socket.on('slitherSpectateCam', ({ x, y }) => {
        const room = getArenaRoomById(socket.roomId);
        if (!room?.isCompetitiveSlither) return;
        const spec = room.competitiveSpectators?.find(s => s.id === socket.id);
        if (!spec) return;
        spec.x = Number(x) || 0;
        spec.y = Number(y) || 0;
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
});

function getArenaRoomById(roomId) {
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
        const humanCount = room.players.filter(p => !p.disconnected).length;
        const spectatorCount = room.competitiveSpectators?.length ?? 0;
        if (humanCount === 0 && spectatorCount === 0) continue;

        const resetTime = room.startTime + c.roomDuration;
        syncCompetitiveSlitherFood(room, humanCount);
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

function getBattleRoyaleDeps() {
    return {
        User,
        Transaction,
        util,
        c,
        addFood,
        calculateCellRadius,
        rooms,
        JWT_SECRET: process.env.JWT_SECRET,
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
    JWT_SECRET: process.env.JWT_SECRET || 'fallback_hemlighet_byt_ut_mig',
});

setInterval(() => {
    processBRQueues(io, getBattleRoyaleDeps());
}, 1000);

setInterval(() => {
    const age = Date.now() - GLOBAL_ARENA_START;
    if (age > c.roomDuration && !isArenaResetting()) {
        performGlobalArenaReset();
        return;
    }
    if (isArenaResetting()) return;

    rooms.forEach(room => {
        processRoom(room);
    });
    processCompetitiveSlitherTick();
    processBattleRoyaleMatches(io, getBattleRoyaleDeps());
}, 1000 / 40);

function processRoom(room) {
    if (room.isResetting) return; // Pause during global reset

    const isSandbox = room.isSandbox === true;
    const agarHumans = countActiveHumansByMode(room, 'agar');
    const slitherHumans = countActiveHumansByMode(room, 'slither');

    // IDLE ROOM CLEANUP (Despawn bots after 10 min of no human players, reclaim money to ownerBalance)
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

                room.ownerBalance += totalReclaimed;
                console.log(`💰 Reclaimed $${totalReclaimed.toFixed(2)} from idle room bots/budget to ownerBalance.`);
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

        if (room.bots.length < agarTargetBots) {
            addBots(room, agarTargetBots - room.bots.length, agarBotStake);
        } else if (room.bots.length > agarTargetBots) {
            trimAgarBots(room, agarTargetBots);
        }

        let slitherTargetBots = getSlitherTargetBots(slitherHumansInArena);
        if (slitherHumansInArena > 0) room.savedSlitherTarget = slitherTargetBots;
        else slitherTargetBots = room.savedSlitherTarget || 0;
        slitherTargetBots += room.slitherBots.filter(b => b.adminSpawned).length;

        if (room.slitherBots.length < slitherTargetBots) {
            addSlitherBots(room, slitherTargetBots - room.slitherBots.length, slitherBotStake);
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
            const normalCount = countNormalAgarFood(room);
            if (normalCount < agarTargetFoodCount) {
                addFood(room, Math.min(50, agarTargetFoodCount - normalCount));
            } else if (normalCount > agarTargetFoodCount + 25) {
                trimNormalAgarFood(room, agarTargetFoodCount);
            }
        }
        syncSlitherFood(room, pelletValue, foodBudgets.slither, slitherInArena, foodDensityForRoom(room));

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

            const head = botCells[0];
            let threat = null;
            let targetPrey = null;
            let minDistThreat = 800; // Bottar ser faror på långt håll
            let minDistPrey = 500;

            // 1. SKANNA OMGIVNING (Hot och Byte)
            allUsers.forEach(u => {
                if (u.id === player.id) return;
                u.cells.forEach(c2 => {
                    const d = Math.hypot(c2.x - head.x, c2.y - head.y);
                    const otherTotalMass = playerTotalMass(u);

                    // HOT: Om någon är 10% större (enligt tidigare önskemål)
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
                // FLY! Rör oss i rakt motsatt riktning från faran
                const angle = Math.atan2(head.y - threat.y, head.x - threat.x);
                player.targetX = head.x + Math.cos(angle) * 500;
                player.targetY = head.y + Math.sin(angle) * 500;
            } else if (targetPrey) {
                // JAGA! Spring mot bytet
                player.targetX = targetPrey.x;
                player.targetY = targetPrey.y;
            } else if (Date.now() - player.lastTargetUpdate > 1000) {
                // MAT: Om inget annat händer, leta efter närmaste matbit
                let nearestFood = null;
                let minDistFood = 500;
                room.food.forEach(f => {
                    const d = Math.hypot(f.x - head.x, f.y - head.y);
                    if (d < minDistFood) { minDistFood = d; nearestFood = f; }
                });

                if (nearestFood) {
                    player.targetX = nearestFood.x;
                    player.targetY = nearestFood.y;
                } else if (Math.hypot(player.targetX - head.x, player.targetY - head.y) < 50) {
                    // Vandra slumpmässigt om ingen mat hittas i närheten
                    player.targetX = Math.random() * c.worldWidth;
                    player.targetY = Math.random() * c.worldHeight;
                }
                player.lastTargetUpdate = Date.now();
            }

            // Simulera input för fysikmotorn
            player.mouseX = player.targetX - head.x;
            player.mouseY = player.targetY - head.y;
        }

        let totalX = 0;
        let totalY = 0;
        const cellsToDelete = new Set();

        // 1. Beräkna rörelse för alla celler
        for (let i = 0; i < player.cells.length; i++) {
            const cell = player.cells[i];
            // PHYSICS: Movement & Friction
            // Använder balans som bas för hastighet (normaliserad med faktor 50)
            const speed = (6 / Math.pow(Math.max(cell.balance, 1), 0.449)) * c.speedMult * (isSandbox ? (room.sandboxSpeedMultiplier ?? 1) : 1);
            const angle = Math.atan2(player.mouseY, player.mouseX);
            const distToMouse = Math.hypot(player.mouseX, player.mouseY);

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
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r) {
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
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r) {
                        cell.balance += item.data.balance;
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
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r && cell.balance > massStart * 2) {
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
                        // INTERNAL: Merge or Push
                        const canMerge = (Date.now() - cell.lastSplit > c.mergeTimer * 1000) && (Date.now() - otherCell.lastSplit > c.mergeTimer * 1000);

                        if (canMerge) {
                            // INTERNAL sammanslagning: Ingen 5% regel.
                            // Om din mittpunkt är inne i den andra cellen
                            if (d < Math.max(r, r2) * 0.9) {
                                cell.balance += otherCell.balance;
                                cell.radius = calculateCellRadius(
                                    cell.balance,
                                    playerTotalMass(player),
                                    player.cells.length,
                                    massStart,
                                );
                                cellsToDelete.add(otherCell.id);
                            }
                            // Ingen repulsion när vi kan merga, så de kan "pressas ihop" mjukt
                        } else if (d < r + r2) {
                            // Om vi INTE kan merga än: Knuffa bort dem mjukare (delat med 25 istället för 10)
                            const pushAngle = Math.atan2(cell.y - otherCell.y, cell.x - otherCell.x);
                            const force = (r + r2 - d) / 25;
                            cell.vx += Math.cos(pushAngle) * force;
                            cell.vy += Math.sin(pushAngle) * force;
                        }
                    } else if (item.type === 'player' || item.type === 'bot') {
                        if (isSandbox && room.sandboxInvincible) continue;
                        // EXTERNAL: Eat
                        // Sänkt tröskel till 5% (1.05) och mer förlåtande avstånd (d < r + r2 * 0.2)
                        if (cell.balance > otherCell.balance * 1.05 && d < (r + r2 * 0.1)) {
                            // EKONOMI: Absorberar 100% av cellmassan + proportionell dollar-andel
                            cell.balance += otherCell.balance;
                            const victim = room.players.find(p => p.id === item.socketId) || room.bots.find(b => b.id === item.botId);
                            if (victim) transferAgarDollars(victim, player, otherCell.balance);
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
            totalX += cell.x;
            totalY += cell.y;
        });

        // HUD / cashout balance is dollars; cell.balance is mass
        player.balance = player.dollarBalance ?? player.cells.reduce((s, cell) => s + cell.balance, 0);

        if (player.cells.length > 0) {
            player.x = totalX / player.cells.length;
            player.y = totalY / player.cells.length;
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
