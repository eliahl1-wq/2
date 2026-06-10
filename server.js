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
    createSlitherPlayer,
    addSlitherBots,
    getSlitherTargetBots,
    trimSlitherBots,
    processSlitherRoom,
    broadcastSlitherState,
    syncSlitherFood,
} from './slither-engine.js';
import {
    ALLOWED_ENTRY_FEES,
    DEFAULT_ENTRY_FEE,
    normalizeEntryFee,
    getEconomy,
    getJoinPoolSplit,
} from './economy.js';
import {
    setupBattleRoyale,
    processBattleRoyaleMatches,
    findBRPlayerBySocket,
    getBRMatchForMongo,
    isPlayerInBR,
    getBRPlayerCountsByFee,
    BR,
} from './battle-royale.js';
import { validateBRWalletsOnStartup, listBRHouseWallets } from './br-wallets.js';

const app = express();

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
];

function isOriginAllowed(origin) {
    if (!origin) return true;
    return allowedOrigins.some(o => (typeof o === 'string' ? o === origin : o.test(origin)));
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
    allowedHeaders: ['Content-Type', 'Authorization', 'bypass-tunnel-reminders', 'Cache-Control', 'Pragma'],
};

// Always answer preflight + attach ACAO even if a route throws (e.g. during Railway restarts)
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, bypass-tunnel-reminders, Cache-Control, Pragma');
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
    playtime: { type: Number, default: 0 }
});

const User = mongoose.model('User', UserSchema);

const TransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: { type: String, enum: ['deposit', 'withdraw', 'game'], required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    meta: { type: Object, default: {} },
    status: { type: String, enum: ['pending', 'confirmed', 'failed'], default: 'confirmed' },
    createdAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model('Transaction', TransactionSchema);

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
    foodBlobValue: 0.01,
    rewardUnlockDelay: 10 * 60 * 1000,
    roomDuration: process.env.DEV_ROOM_DURATION_MS
        ? parseInt(process.env.DEV_ROOM_DURATION_MS, 10)
        : 3 * 60 * 60 * 1000,
};

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
    };
}

const rooms = ALLOWED_ENTRY_FEES.map(fee => createArenaRoom(fee));

// In-memory locks and maps for idempotency / processing
const processingCashouts = new Set(); // mongoId strings

// --- RESET FLOW LOGIC ---
async function cashOutRoomPlayers(room) {
    const playersToProcess = [...room.players];
    for (const p of playersToProcess) {
        try {
            const user = await User.findById(p.mongoId);
            if (!user) continue;

            if (DEV_FREE_PLAY) {
                user.playtime += (Date.now() - p.startTime);
                await user.save();
                await Transaction.create({
                    userId: user._id,
                    type: 'withdraw',
                    amount: p.balance,
                    meta: {
                        simulated: true,
                        reason: 'Auto Room Reset (Free Play)',
                        roomId: room.id,
                        entryFeeUsd: room.entryFeeUsd,
                    },
                });
                io.to(p.id).emit('cashOutSuccess', { amount: p.balance, reason: 'Room Reset', signature: 'simulated' });
            } else if (user.depositAddress && HOUSE_WALLET_SECRET) {
                const solToTransfer = p.balance / SOL_PRICE_USD;
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
                    amount: p.balance,
                    currency: 'SOL',
                    meta: {
                        signature: sig,
                        reason: 'Auto Room Reset to Account Address',
                        roomId: room.id,
                        entryFeeUsd: room.entryFeeUsd,
                    },
                });

                io.to(p.id).emit('cashOutSuccess', { amount: p.balance, reason: 'Room Reset', signature: sig });
            }
        } catch (err) {
            await Transaction.create({
                type: 'game',
                amount: 0,
                meta: { event: 'failure', reason: 'auto_cashout_failed', userId: p.mongoId, error: err.message },
            });
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
        meta: { event: 'pool_sweep', signature: sig, reason: 'Room Reset Wallet Sweep' },
    });
    console.log(`💸 Wallet Sweep: ${sweepLamports / solanaWeb3.LAMPORTS_PER_SOL} SOL sent to owner.`);
}

async function performGlobalArenaReset() {
    if (globalArenaResetting) return;
    globalArenaResetting = true;
    for (const room of rooms) room.isResetting = true;

    console.log('🚨 GLOBAL ARENA RESET STARTED (all stake tiers)');
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

        GLOBAL_ARENA_START = Date.now();
        for (const room of rooms) {
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
        globalArenaResetting = false;
    }
}

async function performRoomReset(_room) {
    await performGlobalArenaReset();
}

// In-memory lock for scanDeposits to prevent concurrent runs
let isScanningDeposits = false;

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
    pingTimeout: 60000, // Öka timeout för att undvika att Render bryter anslutningen
    pingInterval: 25000
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

// Hälso-check för att se om servern är vaken
app.get('/', (req, res) => {
    console.log("Health check requested at " + new Date().toISOString());
    res.send('<html><body style="font-family:sans-serif;background:#0a0a0c;color:white;text-align:center;padding-top:100px;"><h1>AgarStake Engine v2.0 🎮</h1><p style="color:#007AFF;font-size:1.5rem;">Status: Pro Physics Enabled (v11)</p><p>Full Agar.io clone logic integrated.</p><p style="color:#00ff7f;">Ready for redeploy on Railway.</p></body></html>');
});

const authenticateToken = (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    }
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    // Använd en fallback hemlighet om JWT_SECRET inte är satt (endast för utveckling)
    const jwtSecret = process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig";

    jwt.verify(token, jwtSecret, (err, user) => {
        if (err) return res.sendStatus(403);
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

        res.json(userObj);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
    });
});

app.get('/api/health', (req, res) => {
    res.json({ ok: true, freePlay: DEV_FREE_PLAY, uptime: process.uptime() });
});

// --- NYTT: Endpoint för att kolla om användaren är i ett game ---
app.get('/api/game-status', authenticateToken, (req, res) => {
    try {
        const arenaResetting = globalArenaResetting || rooms.some(r => r.isResetting);
        for (const room of rooms) {
            const player = room.players.find(
                p => p.mongoId && p.mongoId.toString() === req.user.id
            );
            if (player) {
                return res.json({
                    inGame: true,
                    mode: player.mode || 'agar',
                    balance: player.balance ?? null,
                    entryFeeUsd: player.entryFeeUsd ?? room.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
                    disconnected: player.disconnected ?? false,
                    isResetting: arenaResetting,
                    battleRoyale: !!player.isBattleRoyale,
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

    try {
        const user = await User.findById(req.user.id);
        // Calculate SOL amount to deduct (balance is already in SOL)
        const solToWithdraw = amountUSD / SOL_PRICE_USD;

        if (!user || user.balance < solToWithdraw) return res.status(400).json({ message: "Insufficient balance" });
        if (!user.depositSecret) return res.status(500).json({ message: "Account configuration error" });

        const lamports = Math.round(solToWithdraw * solanaWeb3.LAMPORTS_PER_SOL);
        const userKeypair = solanaWeb3.Keypair.fromSecretKey(
            Uint8Array.from(Buffer.from(user.depositSecret, 'hex'))
        );

        // Vi drar av en liten mängd för transaktionsavgiften (0.000005 SOL)
        const fee = 5000;
        const sendAmount = lamports - fee;
        if (sendAmount <= 0) return res.status(400).json({ message: "Amount too small to cover fees" });

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
            meta: { signature, destination: destinationAddress, solAmount: solToWithdraw },
            status: 'confirmed'
        });

        res.json({ success: true, newBalance: user.balance, signature });
    } catch (err) {
        console.error("Withdraw Error:", err.message);
        res.status(500).json({ error: "Blockchain transaction failed" });
    }
});

// --- NYTT: Endpoint för att verifiera insättning och spara i historik ---
app.post('/api/deposit-verify', authenticateToken, async (req, res) => {
    const { signature, amountUSD, solAmount } = req.body;
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "Användare hittades ej" });

        user.balance += solAmount; // TRACK RAW SOL
        await user.save();

        const tx = new Transaction({ userId: user._id, type: 'deposit', amount: solAmount, meta: { signature, solAmount } });
        await tx.save();

        res.json({ success: true, balance: user.balance });
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
                p.balance = balance;
                p.cells.forEach(c => { c.balance = balance / p.cells.length; });
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
            bot.balance = balance;
            bot.cells.forEach(c => { c.balance = balance / bot.cells.length; });
            return res.json({ success: true, entryFeeUsd: room.entryFeeUsd });
        }
    }
    res.status(404).send("Bot not found");
});

app.post('/api/admin/trigger-reset', authenticateAdmin, (req, res) => {
    performGlobalArenaReset();
    res.json({ success: true, message: "Global reset sequence initiated" });
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
        if (!found) return res.status(404).send("Player not in arena");

        const { room, player: p } = found;
        const amount = p.balance;
        const user = await User.findById(userId);
        user.balance += amount;
        await user.save();

        room.players = room.players.filter(pl => pl.mongoId.toString() !== userId);

        await Transaction.create({ userId: user._id, type: 'withdraw', amount: amount, meta: { reason: 'Admin Forced Cashout' } });
        io.to(p.id).emit('cashOutSuccess', { amount });

        res.json({ success: true });
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
        res.status(201).json({ message: "Användare skapad!" });
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
        const token = jwt.sign({ id: user._id }, secret, { expiresIn: '1h' });

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

// 6. Exponera live stats för lobby och pre-game
app.get('/api/stats', (req, res) => {
    try {
        let humansOnline = 0;
        let aiOnline = 0;
        let topPlayer = null;
        let topBalance = 0;
        let topIsBot = false;
        const playersByEntryFee = { 5: 0, 10: 0, 20: 0 };

        const considerTop = (name, balance, isBot = false) => {
            const b = balance || 0;
            if (b > topBalance) {
                topBalance = b;
                topPlayer = name;
                topIsBot = isBot;
            }
        };

        rooms.forEach(room => {
            const fee = room.entryFeeUsd ?? DEFAULT_ENTRY_FEE;
            room.players.forEach(player => {
                if (!player.disconnected) {
                    humansOnline += 1;
                    if (!playersByEntryFee[fee]) playersByEntryFee[fee] = 0;
                    playersByEntryFee[fee] += 1;
                    considerTop(player.username, player.balance, false);
                }
            });
            room.bots.forEach(bot => {
                aiOnline += 1;
                const botBalance = bot.cells?.reduce((s, c) => s + c.balance, 0) ?? bot.balance ?? 0;
                considerTop(bot.username, botBalance, true);
            });
            room.slitherBots.forEach(bot => {
                aiOnline += 1;
                considerTop(bot.username, bot.balance, true);
            });
        });

        const brPlayersByFee = getBRPlayerCountsByFee();

        res.json({
            playersOnline: humansOnline + aiOnline,
            biggestPayout: Number(topBalance.toFixed(2)),
            topPlayer,
            topBalance: Number(topBalance.toFixed(2)),
            topIsBot,
            solPrice: SOL_PRICE_USD,
            playersByEntryFee,
            brPlayersByFee,
        });
    } catch (err) {
        console.error('Error fetching stats:', err);
        res.status(500).json({ error: 'Unable to fetch stats' });
    }
});

// 7. Leaderboard - all time and this week
app.get('/api/leaderboard', async (req, res) => {
    try {
        // All time: sum cashout transactions per user
        const alltimePipeline = [
            { $match: { type: 'withdraw', 'meta.reason': { $regex: 'Arena Cashout' } } },
            { $group: { _id: '$userId', total: { $sum: '$amount' } } },
            { $sort: { total: -1 } },
            { $limit: 10 },
            { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
            { $unwind: '$user' },
            { $project: { username: '$user.username', amount: '$total' } }
        ];

        // This week
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - 7);
        const weekPipeline = [
            { $match: { type: 'withdraw', 'meta.reason': { $regex: 'Arena Cashout' }, createdAt: { $gte: weekStart } } },
            { $group: { _id: '$userId', total: { $sum: '$amount' } } },
            { $sort: { total: -1 } },
            { $limit: 10 },
            { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
            { $unwind: '$user' },
            { $project: { username: '$user.username', amount: '$total' } }
        ];

        const [alltime, week] = await Promise.all([
            Transaction.aggregate(alltimePipeline),
            Transaction.aggregate(weekPipeline)
        ]);

        res.json({ alltime, week });
    } catch (err) {
        console.error('Error fetching leaderboard:', err);
        res.status(500).json({ error: 'Unable to fetch leaderboard' });
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

function addFood(room, n) {
    const foodBlobValue = c.foodBlobValue;
    for (let i = 0; i < n; i++) {
        if (room.foodPoolBalance < foodBlobValue) break;
        room.foodPoolBalance -= foodBlobValue;
        room.food.push({
            id: Math.random().toString(36).substr(2, 9),
            x: Math.random() * c.worldWidth,
            y: Math.random() * c.worldHeight,
            hue: Math.floor(Math.random() * 360),
            radius: 7, // Originalstorlek för mat
            balance: foodBlobValue
        });
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
    const agarHumans = countHumansInMode(room, 'agar');
    const slitherHumans = countHumansInMode(room, 'slither');
    return getTargetBots(agarHumans) * stake + getSlitherTargetBots(slitherHumans) * stake;
}

function botStakeForRoom(room) {
    return getEconomy(room.entryFeeUsd).botStartBalance;
}

function foodDensityForRoom(room) {
    return getEconomy(room.entryFeeUsd).foodDensityPerHuman;
}

function findPlayerInArena(mongoId) {
    const key = mongoId?.toString();
    for (const room of rooms) {
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
    return globalArenaResetting || rooms.some(r => r.isResetting);
}

function capAiBudget(room) {
    room.aiBudgetBalance = Math.min(room.aiBudgetBalance, getMaxAiBudgetForRoom(room));
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
    const spawnCount = Math.min(n, Math.floor(room.aiBudgetBalance / botCost));
    for (let i = 0; i < spawnCount; i++) {
        const id = 'bot_' + Math.random().toString(36).substr(2, 5);
        const randomName = botNames[Math.floor(Math.random() * botNames.length)] + " [" + util.randomInRange(10, 99) + "]";
        room.aiBudgetBalance -= botCost;
        room.bots.push({
            id: id, username: randomName, balance: botCost, kills: 0, color: util.randomColor(), isBot: true,
            targetX: Math.random() * c.worldWidth, targetY: Math.random() * c.worldHeight, lastTargetUpdate: 0,
            cells: [{
                id: Math.random().toString(36).substr(2, 9),
                x: Math.random() * c.worldWidth, y: Math.random() * c.worldHeight,
                balance: botCost, radius: calculateCellRadius(botCost, botCost, 1, botCost)
            }]
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

function getTargetBots(humanCount) {
    if (humanCount <= 0) return 0;
    if (humanCount >= 8) return 0;
    if (humanCount < 3) return 4; // 1–2 humans: fuller arena
    return Math.min(humanCount * 2, 12);
}

function countHumansInMode(room, mode) {
    return room.players.filter(p => p.mode === mode || (mode === 'agar' && !p.mode)).length;
}

function countActiveHumansByMode(room, mode) {
    return room.players.filter(p => !p.disconnected && (p.mode === mode || (mode === 'agar' && !p.mode))).length;
}

// Helper för att beräkna radie med extra tillväxt-effekt
function playerStartBalance(player) {
    return getEconomy(player?.entryFeeUsd).playerStartBalance;
}

function calculateCellRadius(cellBalance, playerTotalBalance, cellCount, startBalance = c.playerStartBalance) {
    // Spelet körs nu i USD-enheter internt
    const balanceInUsd = cellBalance;
    const startUsdPerCell = startBalance / cellCount;
    const extraUsd = Math.max(0, balanceInUsd - startUsdPerCell);
    const visualMass = balanceInUsd + (extraUsd * (c.growthBoost - 1));
    return util.massToRadius(visualMass * c.sizeMult);
}

io.on('connection', (socket) => {
    socket.on('joinGame', async ({ username, token, mode, entryFeeUsd: rawEntryFee }) => {
        let userKey = null;
        try {
            if (mode === 'br-agar' || mode === 'br-slither') {
                socket.emit('error', 'Use the Battle Royale queue to join.');
                return;
            }
            const entryFeeUsd = normalizeEntryFee(rawEntryFee);
            const economy = getEconomy(entryFeeUsd);
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig");
            const user = await User.findById(decoded.id);
            if (!user) return;

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

            const existing = findPlayerInArena(userKey);
            if (existing && existing.room.entryFeeUsd !== entryFeeUsd) {
                socket.emit('error', `You have an active $${existing.room.entryFeeUsd} game. Rejoin that stake tier first.`);
                return;
            }

            const room = existing?.room ?? getRoomForEntry(entryFeeUsd);

            // --- REJOIN LOGIK ---
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

            if (currentLamports < (feeLamports + 5000)) { // +5000 för gas
                socket.emit('error', `Insufficient SOL on your account address for $${entryFeeUsd} entry.`);
                return;
            }

            // 2. Utför on-chain transfer: Deposit Address -> House Wallet
            try {
                const userKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(Buffer.from(user.depositSecret, 'hex')));
                const housePubKey = new solanaWeb3.PublicKey(HOUSE_WALLET_ADDRESS);
                const joinTx = new solanaWeb3.Transaction().add(
                    solanaWeb3.SystemProgram.transfer({
                        fromPubkey: userPubKey,
                        toPubkey: housePubKey,
                        lamports: feeLamports,
                    })
                );
                const sig = await solanaWeb3.sendAndConfirmTransaction(connection, joinTx, [userKeypair]);
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

            // DYNAMIC ECONOMY SPLIT (scaled to entry tier)
            const gameMode = mode === 'slither' ? 'slither' : 'agar';
            const activeHumansCount = room.players.filter(p => !p.disconnected).length + 1;
            const { food: foodAlloc, ai: aiAlloc } = getJoinPoolSplit(entryFeeUsd, activeHumansCount);

            // Only fund bots up to the cap for current population; surplus → food pool
            const agarAfter = countHumansInMode(room, 'agar') + (gameMode === 'agar' ? 1 : 0);
            const slitherAfter = countHumansInMode(room, 'slither') + (gameMode === 'slither' ? 1 : 0);
            const joinBotStake = economy.botStartBalance;
            const maxAi = getTargetBots(agarAfter) * joinBotStake + getSlitherTargetBots(slitherAfter) * joinBotStake;
            const aiDeficit = Math.max(0, maxAi - room.aiBudgetBalance);
            const aiToAdd = Math.min(aiAlloc, aiDeficit);
            room.aiBudgetBalance += aiToAdd;
            room.foodPoolBalance += foodAlloc + (aiAlloc - aiToAdd);

            room.ownerBalance += economy.ownerCut;

            // DYNAMIC BOT SCALING (mode-specific)
            const modeHumansAfterJoin = countHumansInMode(room, gameMode) + 1;
            const targetBots = gameMode === 'slither'
                ? getSlitherTargetBots(modeHumansAfterJoin)
                : getTargetBots(modeHumansAfterJoin);

            if (gameMode === 'slither') {
                if (room.slitherBots.length < targetBots) {
                    addSlitherBots(room, targetBots - room.slitherBots.length, joinBotStake);
                } else if (room.slitherBots.length > targetBots) {
                    trimSlitherBots(room, targetBots);
                }
            } else {
                if (room.bots.length < targetBots) {
                    addBots(room, targetBots - room.bots.length, joinBotStake);
                } else if (room.bots.length > targetBots) {
                    room.bots.splice(0, room.bots.length - targetBots);
                }
            }

            socket.roomId = room.id;

            const startBalanceUsd = economy.playerStartBalance;
            let newPlayer;

            if (gameMode === 'slither') {
                newPlayer = createSlitherPlayer(socket.id, user._id, username || user.username, util.randomColor(), room, startBalanceUsd);
                newPlayer.entryFeeUsd = room.entryFeeUsd;
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
                    balance: startBalanceUsd,
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
                        balance: startBalanceUsd,
                        radius: calculateCellRadius(startBalanceUsd, startBalanceUsd, 1, startBalanceUsd),
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
                        room, c.foodBlobValue, budgets.slither,
                        countHumansInMode(room, 'slither'),
                        foodDensityForRoom(room),
                    );
                } else {
                    const agarInArena = countHumansInMode(room, 'agar');
                    const agarFoodTarget = Math.min(agarInArena * foodDensityForRoom(room), budgets.agar);
                    const agarTargetFoodCount = Math.floor(agarFoodTarget / c.foodBlobValue);
                    if (room.food.length < agarTargetFoodCount) {
                        addFood(room, Math.min(50, agarTargetFoodCount - room.food.length));
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
            socket.emit('error', 'Authentication failed');
        } finally {
            if (userKey) joiningUsers.delete(userKey);
        }
    });

    // Protokoll-matchning: 0 = rörelse
    socket.on('0', (data) => {
        const br = findBRPlayerBySocket(socket.id);
        if (br) {
            br.player.mouseX = data.x;
            br.player.mouseY = data.y;
            return;
        }
        const room = rooms.find(r => r.id === socket.roomId);
        const p = room?.players.find(pl => pl.id === socket.id);
        if (p) { p.mouseX = data.x; p.mouseY = data.y; }
    });

    // Protokoll-matchning: 2 = split
    socket.on('2', () => {
        const room = rooms.find(r => r.id === socket.roomId);
        const p = room?.players.find(pl => pl.id === socket.id);
        if (!p || p.cells.length >= c.maxCells) return;

        let newCells = [];
        p.cells.forEach(cell => {
            const startBal = playerStartBalance(p);
            if (cell.balance >= startBal * 2) {
                cell.balance /= 2;
                cell.radius = calculateCellRadius(cell.balance, p.balance, p.cells.length + 1, startBal);
                cell.lastSplit = Date.now(); // Starta timern även för ursprungscellen
                const angle = Math.atan2(p.mouseY, p.mouseX);
                newCells.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: cell.x, y: cell.y,
                    balance: cell.balance,
                    radius: calculateCellRadius(cell.balance, p.balance, p.cells.length + 1, startBal),
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
            const startBal = playerStartBalance(p);
            if (cell.balance >= startBal * 1.5) {
                cell.balance -= c.ejectMass;
                const angle = Math.atan2(p.mouseY, p.mouseX);
                room.ejected.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: cell.x + Math.cos(angle) * (cell.radius + 20),
                    y: cell.y + Math.sin(angle) * (cell.radius + 20),
                    radius: 10,
                    vx: Math.cos(angle) * 15,
                    vy: Math.sin(angle) * 15,
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
        const room = rooms.find(r => r.id === socket.roomId);
        const p = room?.players.find(pl => pl.id === socket.id);
        if (!p || p.isCashingOut) return;

        console.log(`⏱️ User ${p.username} started cashout timer (20s)`);
        p.isCashingOut = true;
        const duration = 20000;
        p.cashOutEndTime = Date.now() + duration;
        const playerMongoId = p.mongoId.toString();
        const roomId = socket.roomId;

        // Meddela klienten att timern har börjat
        socket.emit('cashOutStarting', { seconds: duration / 1000 });

        setTimeout(async () => {
            // Hämta färsk referens till rummet och spelaren för att se om de fortfarande lever
            const activeRoom = rooms.find(r => r.id === roomId);
            // Hitta spelaren via mongoId för att hantera reconnects korrekt
            const activePlayer = activeRoom?.players.find(pl => pl.mongoId.toString() === playerMongoId);

            // Om spelaren inte finns kvar i rummet (uppäten) eller flaggan nollställts, avbryt
            if (!activePlayer || !activePlayer.isCashingOut) {
                console.log(`❌ Cashout cancelled (died or invalid state)`);
                return;
            }

            // REMOVE RANK BONUS: Pay out only the server-side balance
            const totalCashout = activePlayer.balance;
            const mongoId = activePlayer.mongoId;

            try {
                let user = await User.findById(mongoId);
                if (!user) {
                    console.log(`❌ Cashout failed: User ${activePlayer.username} not found in DB.`);
                    io.to(activePlayer.id).emit('error', 'Account not found.');
                    activePlayer.isCashingOut = false;
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
                    return;
                }

                user = await ensureUserDepositWallet(user);
                if (!user.depositAddress) {
                    console.log(`❌ Cashout failed: User ${activePlayer.username} has no internal deposit address.`);
                    io.to(activePlayer.id).emit('error', 'Account internal error.');
                    activePlayer.isCashingOut = false;
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
                    // DO NOT remove player from room; allow them to continue playing or retry.
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
            }
        }, duration);
    });

    socket.on('disconnect', () => {
        const room = rooms.find(r => r.id === socket.roomId);
        if (!room) return;
        // Mark player as disconnected but preserve their entity/state for 5 minutes
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
        const room = rooms.find(r => r.id === socket.roomId);
        const p = room?.players.find(pl => pl.id === socket.id && pl.mode === 'slither');
        if (!p || p.isCashingOut) return;
        p.inputDx = Number(dx) || 0;
        p.inputDy = Number(dy) || 0;
        p.boost = !!boost;
    });
});

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
    };
}

setupBattleRoyale(io, getBattleRoyaleDeps());

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
    processBattleRoyaleMatches(io, getBattleRoyaleDeps());
}, 1000 / 40);

function processRoom(room) {
    if (room.isResetting) return; // Pause during global reset

    // DYNAMIC BOT SCALING (mode-specific, continuously maintained)
    const agarHumans = countActiveHumansByMode(room, 'agar');
    const slitherHumans = countActiveHumansByMode(room, 'slither');
    const agarHumansInArena = countHumansInMode(room, 'agar');
    const slitherHumansInArena = countHumansInMode(room, 'slither');

    const agarTargetBots = getTargetBots(agarHumansInArena);
    const agarBotStake = botStakeForRoom(room);
    const slitherBotStake = botStakeForRoom(room);
    if (room.bots.length < agarTargetBots) {
        addBots(room, agarTargetBots - room.bots.length, agarBotStake);
    } else if (room.bots.length > agarTargetBots) {
        room.bots.splice(0, room.bots.length - agarTargetBots);
    }

    const slitherTargetBots = getSlitherTargetBots(slitherHumansInArena);
    if (room.slitherBots.length < slitherTargetBots) {
        addSlitherBots(room, slitherTargetBots - room.slitherBots.length, slitherBotStake);
    } else if (room.slitherBots.length > slitherTargetBots) {
        trimSlitherBots(room, slitherTargetBots);
    }

    capAiBudget(room);

    // Food spawn — funded from pool (entry fees on join), same rules for agar + slither
    const agarInArena = countHumansInMode(room, 'agar');
    const slitherInArena = countHumansInMode(room, 'slither');
    const foodBudgets = getModeFoodBudgets(room, agarHumans, slitherHumans);

    const agarFoodTarget = Math.min(agarInArena * foodDensityForRoom(room), foodBudgets.agar);
    const agarTargetFoodCount = Math.floor(agarFoodTarget / c.foodBlobValue);
    if (agarInArena <= 0) {
        room.food.length = 0;
    } else if (room.food.length < agarTargetFoodCount) {
        addFood(room, Math.min(50, agarTargetFoodCount - room.food.length));
    } else if (room.food.length > agarTargetFoodCount) {
        room.food.splice(agarTargetFoodCount);
    }
    syncSlitherFood(room, c.foodBlobValue, foodBudgets.slither, slitherInArena, foodDensityForRoom(room));

    if (room.viruses.length < c.virusCount) addViruses(room, c.virusCount - room.viruses.length);

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

        const pStartBal = player.isBot
            ? (player.botStake ?? player.cells[0]?.balance ?? c.botStartBalance)
            : playerStartBalance(player);

        // 0. Avancerad AI-logik för bottar
        if (player.isBot) {
            const botCells = player.cells;
            if (botCells.length === 0) return;

            // SJÄLVSANERING: Despawn om botten blir för stor
            const totalBotBalance = botCells.reduce((sum, cl) => sum + cl.balance, 0);
            const botMax = getEconomy(room.entryFeeUsd).botMaxBalance;
            if (totalBotBalance > botMax) {
                room.bots = room.bots.filter(b => b.id !== player.id);
                if (room.players.length + room.bots.length < c.targetPopulation) addBots(room, 1);
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
                    const otherTotalBalance = u.cells.reduce((s, cl) => s + cl.balance, 0);

                    // HOT: Om någon är 10% större (enligt tidigare önskemål)
                    if (otherTotalBalance > totalBotBalance * 1.10 && d < minDistThreat) {
                        minDistThreat = d;
                        threat = c2;
                    }
                    // BYTE: Om någon är liten nog att ätas
                    else if (totalBotBalance > otherTotalBalance * 1.10 && d < minDistPrey) {
                        minDistPrey = d;
                        targetPrey = c2;
                    }
                });
            });

            // VIRUS: Undvik om vi är stora nog att sprängas
            if (totalBotBalance > 5.0) {
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

        // 1. Beräkna rörelse och decay för alla celler
        for (let i = 0; i < player.cells.length; i++) {
            const cell = player.cells[i];
            // PHYSICS: Movement & Friction
            // Använder balans som bas för hastighet (normaliserad med faktor 50)
            const speed = (6 / Math.pow(Math.max(cell.balance, 1), 0.449)) * c.speedMult;
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

            // DECAY: Ingen decay nu
            if (c.massLossRate > 1.0 && cell.balance > 5.0) cell.balance /= c.massLossRate;

            // BOUNDS
            const r = cell.radius;
            cell.x = Math.max(r, Math.min(c.worldWidth - r, cell.x));
            cell.y = Math.max(r, Math.min(c.worldHeight - r, cell.y));
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
                        cell.balance += item.data.balance || c.foodBlobValue;
                        cell.radius = calculateCellRadius(cell.balance, player.balance, player.cells.length, pStartBal);
                        room.food = room.food.filter(f => f.id !== item.data.id);
                    }
                } else if (item.type === 'ejected') {
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r) {
                        cell.balance += item.data.balance;
                        cell.radius = calculateCellRadius(cell.balance, player.balance, player.cells.length, pStartBal);
                        room.ejected = room.ejected.filter(e => e.id !== item.data.id);
                    }
                } else if (item.type === 'virus') {
                    // Virusexplosion baserat på balans
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r && cell.balance > pStartBal * 2) {
                        if (player.cells.length < c.maxCells) {
                            cell.balance /= 2;
                            cell.radius = calculateCellRadius(cell.balance, player.balance, player.cells.length, pStartBal);
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
                                cell.radius = calculateCellRadius(cell.balance, player.balance, player.cells.length, pStartBal);
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
                        // EXTERNAL: Eat
                        // Sänkt tröskel till 5% (1.05) och mer förlåtande avstånd (d < r + r2 * 0.2)
                        if (cell.balance > otherCell.balance * 1.05 && d < (r + r2 * 0.1)) {
                            // EKONOMI: Absorberar 100% av balansen
                            cell.balance += otherCell.balance;
                            cell.radius = calculateCellRadius(cell.balance, player.balance, player.cells.length, pStartBal);
                            const victim = room.players.find(p => p.id === item.socketId) || room.bots.find(b => b.id === item.botId);
                            if (victim) {
                                victim.cells = victim.cells.filter(c => c.id !== otherCell.id);
                                if (victim.cells.length === 0) {
                                    if (!victim.isBot) {
                                        io.to(victim.id).emit('RIP');
                                        const victimMongoId = victim.mongoId;
                                        const sessionPlaytime = Date.now() - victim.startTime;

                                        // Uppdatera playtime i DB vid död
                                        User.findByIdAndUpdate(victimMongoId, { $inc: { playtime: sessionPlaytime } })
                                            .catch(err => console.error("Error updating playtime on death:", err));

                                        Transaction.create({
                                            userId: victimMongoId,
                                            type: 'game',
                                            amount: victim.balance,
                                            meta: {
                                                reason: 'Arena Death',
                                                mode: victim.mode || 'agar',
                                                entryFeeUsd: victim.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
                                            },
                                            status: 'confirmed',
                                        }).catch(err => console.error("Error logging agar death:", err));

                                        room.players = room.players.filter(p => p.id !== victim.id);
                                    } else {
                                        // Ta bort botten och spawna en ny direkt
                                        // Kill rewards är borttagna, så ingen ökning av kills
                                        room.bots = room.bots.filter(b => b.id !== victim.id);
                                        if (room.players.length + room.bots.length < c.targetPopulation) addBots(room, 1);
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

        // Balansen är summan av cellernas balans
        player.balance = player.cells.reduce((s, cell) => s + cell.balance, 0);

        if (player.cells.length > 0) {
            player.x = totalX / player.cells.length;
            player.y = totalY / player.cells.length;
        }
    });

    room.ejected.forEach(e => { e.x += e.vx; e.y += e.vy; e.vx *= 0.9; e.vy *= 0.9; });

    rebuildQuadTree(room, allUsers);

    // Slither server-side physics tick
    const slitherLeaderboard = processSlitherRoom(room, io, User, Transaction);

    const slitherMeta = {
        resetTime: room.startTime + c.roomDuration,
        solPrice: SOL_PRICE_USD,
        isResetting: room.isResetting,
    };
    broadcastSlitherState(room, io, slitherLeaderboard, slitherMeta);

    // Skicka leaderboard separat för prestanda (Inkludera bottar)
    const leaderboardData = allUsers
        .map(p => ({ id: p.id, name: p.username, massTotal: p.balance, balance: p.balance }))
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 10);

    const age = Date.now() - room.startTime;
    const rewardsUnlocked = (age > c.rewardUnlockDelay) && (room.players.length >= 4);

    // Skapa en kopia för leaderboard med USD-värden
    const visualLeaderboard = leaderboardData.map(entry => ({
        ...entry,
        massTotal: Number(entry.massTotal).toFixed(2),
        balance: Number(entry.balance).toFixed(2)
    }));

    room.players.forEach(p => {
        if (p.mode === 'slither' || p.disconnected) return;

        io.to(p.id).emit('leaderboard', { leaderboard: visualLeaderboard });

        // OPTIMERING: Spatial Filtering.
        const rangeX = (p.screenWidth || 1920) / 2 + 500;
        const rangeY = (p.screenHeight || 1080) / 2 + 500;
        const viewRange = new Rectangle(p.x, p.y, rangeX, rangeY);
        const visibleItems = room.qt.query(viewRange);

        const visibleFood = [];
        const visibleViruses = [];
        const visibleEjected = [];
        const visibleUsersSet = new Set();
        visibleUsersSet.add(p);
        visibleItems.forEach(item => {
            if (item.type === 'food') visibleFood.push(item.data);
            else if (item.type === 'virus') visibleViruses.push(item.data);
            else if (item.type === 'ejected') visibleEjected.push(item.data);
            else if (item.type === 'player' || item.type === 'bot') {
                const id = item.socketId || item.botId;
                const found = userMap.get(id);
                if (found) visibleUsersSet.add(found);
            }
        });
        io.to(p.id).emit('serverTellPlayerMove', p, Array.from(visibleUsersSet), visibleFood, visibleEjected, visibleViruses, {
            unlocked: rewardsUnlocked,
            unlockTime: room.startTime + c.rewardUnlockDelay,
            playerCount: room.players.length,
            resetTime: room.startTime + c.roomDuration,
            solPrice: SOL_PRICE_USD
        });
    });
}

const PORT = process.env.PORT || 5000;

// Keep CORS headers on unhandled errors (e.g. during Railway restarts)
app.use((err, req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    }
    console.error('Unhandled error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

httpServer.listen(PORT, () => console.log(`Servern körs på port ${PORT}`));
