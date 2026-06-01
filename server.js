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
import fetch from 'node-fetch'; // Se till att du kör 'npm install node-fetch'
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';

const app = express();

// --- 1. MODELLER & KONFIGURATION (Flyttade till toppen för att undvika krascher) ---

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, unique: true, sparse: true },
    googleId: { type: String, unique: true, sparse: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 },
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
    status: { type: String, enum: ['pending','confirmed','failed'], default: 'confirmed' },
    createdAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model('Transaction', TransactionSchema);

// --- SOLANA CONNECTION ---
const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new solanaWeb3.Connection(SOLANA_RPC, 'confirmed');
// En fast kurs för enkelhetens skull, eller hämta live nedan
let SOL_PRICE_USD = 150; 
const HOUSE_WALLET_ADDRESS = process.env.HOUSE_WALLET_ADDRESS;

const c = {
    worldWidth: 18000,
    worldHeight: 18000,
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
    foodValuePerPlayer: 7.0,
    foodBlobValue: 0.02,
    rewardUnlockDelay: 10 * 60 * 1000,
    roomDuration: 2 * 60 * 60 * 1000,
};

const rooms = [0].map(id => ({
    id,
    players: [],
    bots: [],
    food: [],
    viruses: [],
    ejected: [],
    startTime: Date.now(), 
    qt: new QuadTree(new Rectangle(c.worldWidth / 2, c.worldHeight / 2, c.worldWidth / 2, c.worldHeight / 2), 4)
}));

// 1. Flytta CORS till toppen och definiera origins centralt
const allowedOrigins = [
    "https://www.agararena.space", 
    "https://agararena.space", 
    "http://localhost:5173", 
    "https://api.agararena.space",
    "https://2-production-9e74.up.railway.app"
];

app.use(cors({
    origin: function (origin, callback) {
        // Använd includes() istället för indexOf() för bättre läsbarhet
        if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.up.railway.app')) {
            callback(null, true);
        } else {
            callback(null, false); // Returnera false istället för ett Error-objekt
        }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "bypass-tunnel-reminders", "Cache-Control", "Pragma"],
    credentials: true,
    optionsSuccessStatus: 200 // Viktigt för preflight-svar
}));

// --- NYTT: AUTOMATISK INSÄTTNINGS-SCANNER ---
async function scanDeposits() {
    try {
        // 1. Uppdatera SOL-kursen (valfritt men bra)
        const priceRes = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT').catch(() => null);
        if (priceRes && priceRes.ok) {
            const priceData = await priceRes.json();
            SOL_PRICE_USD = parseFloat(priceData.price);
        }

        // 2. Hitta alla användare som har en insättningsadress
        const users = await User.find({ depositAddress: { $exists: true } });
        
        for (const user of users) {
            const pubKey = new solanaWeb3.PublicKey(user.depositAddress);
            // Hämta de senaste 5 transaktionerna för denna adress
            const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 5 });

            for (const sigInfo of signatures) {
                // Kolla om vi redan har hanterat denna transaktion
                const existingTx = await Transaction.findOne({ "meta.signature": sigInfo.signature });
                if (existingTx) continue;

                // Hämta detaljer om transaktionen
                const txDetails = await connection.getTransaction(sigInfo.signature, {
                    maxSupportedTransactionVersion: 0
                });

                if (!txDetails || txDetails.meta?.err) continue;

                // Beräkna hur mycket SOL som kom in till just denna adress
                // Vi kollar skillnaden i balans för kontot i transaktionen
                const accountIndex = txDetails.transaction.message.staticAccountKeys.findIndex(k => k.equals(pubKey));
                if (accountIndex === -1) continue;

                const preBalance = txDetails.meta.preBalances[accountIndex];
                const postBalance = txDetails.meta.postBalances[accountIndex];
                const changeLamports = postBalance - preBalance;

                if (changeLamports > 0) {
                    const solAmount = changeLamports / solanaWeb3.LAMPORTS_PER_SOL;
                    const amountUSD = solAmount * SOL_PRICE_USD;

                    // Uppdatera användarens balans
                    user.balance += amountUSD;
                    await user.save();

                    // --- SWEEPER: Skicka SOL vidare till din huvudplånbok ---
                    if (HOUSE_WALLET_ADDRESS) {
                        try {
                            const fromKeypair = solanaWeb3.Keypair.fromSecretKey(
                                Uint8Array.from(Buffer.from(user.depositSecret, 'hex'))
                            );
                            
                            // Vi lämnar en liten mängd (t.ex. 0.001 SOL) för att täcka framtida transaktionsavgifter 
                            // eller så skickar vi allt minus avgiften för denna transaktion.
                            const balance = await connection.getBalance(pubKey);
                            const fee = 5000; // Standardavgift på Solana (lamports)
                            
                            if (balance > fee) {
                                const sweepTx = new solanaWeb3.Transaction().add(
                                    solanaWeb3.SystemProgram.transfer({
                                        fromPubkey: pubKey,
                                        toPubkey: new solanaWeb3.PublicKey(HOUSE_WALLET_ADDRESS),
                                        lamports: balance - fee,
                                    })
                                );
                                await solanaWeb3.sendAndConfirmTransaction(connection, sweepTx, [fromKeypair]);
                                console.log(`💸 SWEEP: Skickade ${solAmount} SOL till hus-plånboken.`);
                            }
                        } catch (sweepErr) {
                            console.error("Sweep Error:", sweepErr.message);
                        }
                    }

                    // Spara transaktionen så vi inte dubbel-krediterar
                    await Transaction.create({
                        userId: user._id,
                        type: 'deposit',
                        amount: amountUSD,
                        meta: {
                            signature: sigInfo.signature,
                            solAmount: solAmount,
                            automated: true,
                            solPrice: SOL_PRICE_USD
                        },
                        status: 'confirmed'
                    });

                    console.log(`✅ AUTO-DEPOSIT: ${user.username} fick $${amountUSD.toFixed(2)} (${solAmount} SOL)`);
                }
            }
        }
    } catch (err) {
        console.error("Scanner Error:", err.message);
    }
}

// Starta scannern var 15:e sekund
setInterval(scanDeposits, 15000);

const httpServer = createServer(app);
const io = new Server(httpServer, { 
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000, // Öka timeout för att undvika att Render bryter anslutningen
    pingInterval: 25000
});

app.use(express.json());
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

// --- NYTT: Endpoint för att kolla om användaren är i ett game ---
app.get('/api/game-status', authenticateToken, (req, res) => {
    try {
        const inGame = rooms[0].players.some(p => p.mongoId && p.mongoId.toString() === req.user.id);
        res.json({ inGame });
    } catch (err) {
        res.status(500).json({ inGame: false });
    }
});

// --- NYTT: Endpoint för att verifiera insättning och spara i historik ---
app.post('/api/deposit-verify', authenticateToken, async (req, res) => {
    const { signature, amountUSD, solAmount } = req.body;
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "Användare hittades ej" });
        
        user.balance += amountUSD;
        await user.save();
        
        const tx = new Transaction({ userId: user._id, type: 'deposit', amount: amountUSD, meta: { signature, solAmount } });
        await tx.save();
        
        res.json({ success: true, balance: user.balance });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

        // Skapa en JWT (Inloggningskvitto). Använd en hemlig nyckel från .env
        const secret = process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig";
        const token = jwt.sign({ id: user._id }, secret, { expiresIn: '1h' });

        console.log("✅ SUCCESS: Inloggning lyckades, skickar token för:", username);
        res.json({
            token,
            user: {
                id: user._id,
                username: user.username,
                balance: user.balance
            }
        });
    } catch (err) {
        console.error("Fel vid inloggning:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 5. Hämta aktuell användare (används vid sidladdning)
app.get('/api/me', authenticateToken, async (req, res) => {
    console.log("Mottog förfrågan om aktuell användare (api/me)");
    try {
        const user = await User.findById(req.user.id).select('-password');
        res.json(user);
    } catch (err) {
        console.error("Fel vid hämtning av aktuell användare:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 6. Exponera live stats för lobby och pre-game
app.get('/api/stats', (req, res) => {
    try {
        const playersOnline = rooms.reduce((sum, room) => sum + room.players.length, 0);
        const biggestPayout = rooms.reduce((max, room) => {
            const roomMax = room.players.reduce((roomMaxValue, player) => Math.max(roomMaxValue, player.balance || 0), 0);
            return Math.max(max, roomMax);
        }, 0);

        res.json({
            playersOnline,
            biggestPayout: Number(biggestPayout.toFixed(2))
        });
    } catch (err) {
        console.error('Error fetching stats:', err);
        res.status(500).json({ error: 'Unable to fetch stats' });
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
    for (let i = 0; i < n; i++) {
        room.food.push({
            id: Math.random().toString(36).substr(2, 9),
            x: Math.random() * c.worldWidth,
            y: Math.random() * c.worldHeight,
            hue: Math.floor(Math.random() * 360),
            radius: 7, // Originalstorlek för mat
            balance: c.foodBlobValue // Använder konstanter för konsekvens
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

function addBots(room, n) {
    const botNames = ["Sirius", "Gota", "AgarioMaster", "ProPlayer", "Legit", "Sanic", "Wojak", "Pepe", "Doge", "Spooderman", "U Mad?", "Team Me", "Solo King", "Blobby"];
    for (let i = 0; i < n; i++) {
        const id = 'bot_' + Math.random().toString(36).substr(2, 5);
        const randomName = botNames[Math.floor(Math.random() * botNames.length)] + " [" + util.randomInRange(10, 99) + "]";
        room.bots.push({
            id: id, username: randomName, balance: 0, kills: 0, color: util.randomColor(), isBot: true,
            targetX: Math.random() * c.worldWidth, targetY: Math.random() * c.worldHeight, lastTargetUpdate: 0,
            cells: [{
                id: Math.random().toString(36).substr(2, 9),
                x: Math.random() * c.worldWidth, y: Math.random() * c.worldHeight,
                balance: c.botStartBalance, radius: util.massToRadius(c.botStartBalance * c.sizeMult), vx: 0, vy: 0, lastSplit: Date.now()
            }] // Bottar använder standard-radie för enkelhetens skull eller kan också uppdateras
        });
    }
}

// Initiera alla rum
rooms.forEach(room => {
    addViruses(room, c.virusCount);
    addBots(room, c.targetPopulation);
});

function getBestRoom() {
    // Eftersom det bara finns en global arena nu tillåter vi anslutning när som helst
    // tills rummet resettas automatiskt varannan timme.
    return rooms[0];
}

// Helper för att beräkna radie med extra tillväxt-effekt
function calculateCellRadius(cellBalance, playerTotalBalance, cellCount) {
    // Vi utgår från att $1.00 (eller $1/antal celler) är baslinjen.
    // Allt över det multipliceras med growthBoost för att man ska se större ut snabbare.
    const startBalancePerCell = c.playerStartBalance / cellCount;
    const extraBalance = Math.max(0, cellBalance - startBalancePerCell);
    const visualMass = cellBalance + (extraBalance * (c.growthBoost - 1));
    return util.massToRadius(visualMass * c.sizeMult);
}

io.on('connection', (socket) => {
    socket.on('joinGame', async ({ username, token }) => {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig");
            const user = await User.findById(decoded.id);
            if (!user) return;

            const room = getBestRoom();
            
            // --- REJOIN LOGIK ---
            const existingPlayer = room.players.find(p => p.mongoId.toString() === user._id.toString());
            if (existingPlayer) {
                console.log(`♻️ User ${user.username} rejoining. Kicking old socket ${existingPlayer.id}`);
                // Meddela det gamla fönstret att det blivit ersatt
                io.to(existingPlayer.id).emit('forcedDisconnect');
                
                existingPlayer.id = socket.id; // Uppdatera till nya socket id
                socket.roomId = room.id;
                let remaining = 0;
                if (existingPlayer.isCashingOut && existingPlayer.cashOutEndTime) {
                    remaining = Math.max(0, Math.ceil((existingPlayer.cashOutEndTime - Date.now()) / 1000));
                }
                socket.emit('welcome', existingPlayer, { width: c.worldWidth, height: c.worldHeight, cashOutRemaining: remaining });
                return;
            }

            if (user.balance < 10.0) {
                socket.emit('error', 'Minimum $10 balance required to enter.');
                return;
            }

            // EKONOMI: $10 inträde. $4 till plattform, $1 startbalans, $5 till mat-poolen.
            user.balance -= 10.0;
            await user.save();
            
            socket.roomId = room.id;

            const spawnX = Math.random() * c.worldWidth;
            const spawnY = Math.random() * c.worldHeight;

            const newPlayer = {
                id: socket.id,
                mongoId: user._id,
                username: username || user.username,
                kills: 0, // Behåll variabeln men används ej för rewards längre
                balance: c.playerStartBalance, 
                startTime: Date.now(),
                color: util.randomColor(),
                x: c.worldWidth / 2, // Startposition för kameran
                y: c.worldHeight / 2,
                mouseX: 0,
                mouseY: 0,
                screenWidth: 1920,
                screenHeight: 1080,
                cells: [{
                    id: Math.random().toString(36).substr(2, 9),
                    x: spawnX,
                    y: spawnY,
                    balance: c.playerStartBalance,
                    radius: calculateCellRadius(c.playerStartBalance, c.playerStartBalance, 1),
                    vx: 0,
                    vy: 0,
                    lastSplit: Date.now()
                }]
            };
            room.players.push(newPlayer);

            // Om vi har bottar inne, ta bort en för att göra plats åt den riktiga spelaren
            if (room.bots.length > 0) room.bots.shift();

            // Skicka 'welcome' som i original-repot, med spelarens initiala data och världsstorlek
            socket.emit('welcome', newPlayer, { width: c.worldWidth, height: c.worldHeight });
        } catch (err) {
            socket.emit('error', 'Authentication failed');
        }
    });

    // Protokoll-matchning: 0 = rörelse
    socket.on('0', (data) => {
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
            if (cell.balance >= c.minMassSplit) {
                cell.balance /= 2;
                cell.radius = calculateCellRadius(cell.balance, p.balance, p.cells.length + 1);
                cell.lastSplit = Date.now(); // Starta timern även för ursprungscellen
                const angle = Math.atan2(p.mouseY, p.mouseX);
                newCells.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: cell.x, y: cell.y,
                    balance: cell.balance,
                    radius: calculateCellRadius(cell.balance, p.balance, p.cells.length + 1),
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
            if (cell.balance >= c.minMassEject) {
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
        socket.emit('cashOutStarting', { seconds: 20 });

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

            const age = Date.now() - activeRoom.startTime;
            const rewardsUnlocked = (age > c.rewardUnlockDelay) && (activeRoom.players.length >= 4);

            // Beräkna leaderboard-bonus vid cashout ($20 för #1, $10 för #2-3)
            const all = [...activeRoom.players, ...activeRoom.bots].sort((a, b) => b.balance - a.balance);
            const rank = all.findIndex(u => u.mongoId?.toString() === playerMongoId) + 1;
            
            let rankBonus = 0;
            if (rewardsUnlocked) {
                if (rank === 1) rankBonus = 20.0;
                else if (rank <= 3) rankBonus = 10.0;
            }

            const totalCashout = activePlayer.balance + rankBonus;
            const mongoId = activePlayer.mongoId;

            // Ta bort spelaren från arenan nu när utbetalningen är säkrad
            activeRoom.players = activeRoom.players.filter(pl => pl.mongoId.toString() !== playerMongoId);

            try {
                const user = await User.findById(mongoId);
                if (user) {
                    const sessionPlaytime = Date.now() - activePlayer.startTime;
                    user.balance += totalCashout; 
                    user.playtime += sessionPlaytime;
                    await user.save();
                    
                    // Spara i transaktionshistorik
                    const tx = new Transaction({ userId: user._id, type: 'withdraw', amount: totalCashout, meta: { reason: 'Arena Cashout', rank } });
                    await tx.save();

                    console.log(`💰 User ${activePlayer.username} cashed out $${totalCashout.toFixed(2)} (Rank: ${rank}, Bonus: $${rankBonus})`);
                    // Skicka till spelarens aktuella socket (som kan ha ändrats vid refresh)
                    io.to(activePlayer.id).emit('cashOutSuccess', { amount: totalCashout });
                }
            } catch (err) {
                console.error("Cashout error:", err);
            }
        }, 20000); // 20 sekunders fördröjning
    });

    socket.on('disconnect', () => {
        const room = rooms.find(r => r.id === socket.roomId);
        if (!room) return;
        // Vi tar INTE bort spelaren här längre för att tillåta rejoin. 
        // De tas bara bort om de blir uppätna eller cashar ut.
        
        // Om en spelare lämnar och vi hamnar under 30 totalt, lägg till en bot
        if (room.players.length + room.bots.length < c.targetPopulation) {
            addBots(room, 1);
        }
    });

    socket.on('playerDied', (data) => {
        const room = rooms.find(r => r.id === socket.roomId);
        if (!room) return;
        // Markera spelaren som inte längre cashing out om de dör
        const p = room.players.find(pl => pl.id === socket.id);
        if (p) p.isCashingOut = false;
    });
});

setInterval(() => {
    rooms.forEach(room => {
        processRoom(room);
    });
}, 1000 / 40);

function processRoom(room) {
    const now = Date.now();
    const age = now - room.startTime;

    // Kontrollera om rummet behöver resettas (var 2:a timme)
    if (age > c.roomDuration) {
        console.log(`♻️ Global Arena reset period reached. Restarting room ${room.id}...`);
        room.players.forEach(p => io.to(p.id).emit('died'));
        room.players = [];
        room.bots = [];
        room.food = [];
        room.viruses = [];
        room.ejected = [];
        room.startTime = now;
        addViruses(room, c.virusCount);
        addBots(room, c.targetPopulation);
        room.qt.clear();
    }

    room.qt.clear();
    room.players.forEach(p => p.cells.forEach(cell => room.qt.insert(new Point(cell.x, cell.y, { type: 'player', socketId: p.id, cell }))));
    room.bots.forEach(b => b.cells.forEach(cell => room.qt.insert(new Point(cell.x, cell.y, { type: 'bot', botId: b.id, cell }))));
    room.food.forEach(f => room.qt.insert(new Point(f.x, f.y, { type: 'food', data: f })));
    room.viruses.forEach(v => room.qt.insert(new Point(v.x, v.y, { type: 'virus', data: v })));
    room.ejected.forEach(e => room.qt.insert(new Point(e.x, e.y, { type: 'ejected', data: e })));

    const allUsers = [...room.players, ...room.bots];
    const userMap = new Map();
    allUsers.forEach(u => userMap.set(u.id, u));

    allUsers.forEach(player => {
        // 0. Avancerad AI-logik för bottar
        if (player.isBot) {
            const botCells = player.cells;
            if (botCells.length === 0) return;

            // SJÄLVSANERING: Despawn om botten blir för stor
            const totalBotBalance = botCells.reduce((sum, cl) => sum + cl.balance, 0);
            if (totalBotBalance > c.botMaxBalance) {
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
                        cell.radius = calculateCellRadius(cell.balance, player.balance, player.cells.length);
                        room.food = room.food.filter(f => f.id !== item.data.id);
                    }
                } else if (item.type === 'ejected') {
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r) {
                        cell.balance += item.data.balance; 
                        cell.radius = calculateCellRadius(cell.balance, player.balance, player.cells.length);
                        room.ejected = room.ejected.filter(e => e.id !== item.data.id);
                    }
                } else if (item.type === 'virus') {
                    // Virusexplosion baserat på balans
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r && cell.balance > 2.0) {
                        if (player.cells.length < c.maxCells) {
                            cell.balance /= 2;
                            cell.radius = calculateCellRadius(cell.balance, player.balance, player.cells.length);
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
                                cell.radius = calculateCellRadius(cell.balance, player.balance, player.cells.length);
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
                            cell.radius = calculateCellRadius(cell.balance, player.balance, player.cells.length);
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

                                        room.players = room.players.filter(p => p.id !== victim.id);
                                        // Logga förlusten av entry fee
                                        Transaction.create({ 
                                            userId: victimMongoId, 
                                            type: 'game', 
                                            amount: -10.00, 
                                            meta: { reason: 'Arena Death' },
                                            status: 'confirmed'
                                        }).catch(err => console.error("Error logging arena death:", err));
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
    // Kontinuerlig mat-spawn: Sträva efter $7 värde av mat per spelare
    const targetFoodCount = room.players.length * (c.foodValuePerPlayer / c.foodBlobValue);
    if (room.food.length < targetFoodCount) {
        // Spawna i små omgångar för att undvika en plötslig flod
        addFood(room, Math.min(5, targetFoodCount - room.food.length)); 
    }
    if (room.viruses.length < c.virusCount) addViruses(room, c.virusCount - room.viruses.length);

    // Skicka leaderboard separat för prestanda (Inkludera bottar)
    const leaderboardData = allUsers
        .map(p => ({ id: p.id, name: p.username, massTotal: p.balance, balance: p.balance }))
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 10);

    const rewardsUnlocked = (age > c.rewardUnlockDelay) && (room.players.length >= 4);
    
    room.players.forEach(p => {
        io.to(p.id).emit('leaderboard', { leaderboard: leaderboardData });
        
        // OPTIMERING: Spatial Filtering. Skicka bara det som syns (plus buffert)
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
            resetTime: room.startTime + c.roomDuration
        });
    });
}

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Servern körs på port ${PORT}`));