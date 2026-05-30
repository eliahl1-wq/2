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

const app = express();

// 1. Flytta CORS till toppen och definiera origins centralt
const allowedOrigins = [
    "https://www.agararena.space", 
    "https://agararena.space", 
    "http://localhost:5173", 
    "https://api.agararena.space"
];

app.use(cors({
    origin: function (origin, callback) {
        // Tillåt förfrågningar utan origin (t.ex. server-till-server eller mobil) 
        // eller om ursprunget finns i vår lista
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "bypass-tunnel-reminders"],
    credentials: true,
    optionsSuccessStatus: 200 // Viktigt för preflight-svar
}));

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

// Hälso-check för att se om servern är vaken
app.get('/', (req, res) => {
    console.log("Health check requested at " + new Date().toISOString());
    res.send('<html><body style="font-family:sans-serif;background:#0a0a0c;color:white;text-align:center;padding-top:100px;"><h1>AgarStake Engine v2.0 🎮</h1><p style="color:#007AFF;font-size:1.5rem;">Status: Pro Physics Enabled (v11)</p><p>Full Agar.io clone logic integrated.</p></body></html>');
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

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/agario_db";

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    .then(() => console.log("Ansluten till databasen!"))
    .catch(err => console.error("Kunde inte ansluta:", err));

// 2. Skapa en "User" modell (hur en användare ser ut i databasen)
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 },
    walletAddress: { type: String } // Koppla till användarens Solana-plånbok
});

const User = mongoose.model('User', UserSchema);

// Transaction schema för deposits, withdrawals och game-transactions
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

// 3. REGISTRERING (Spara ny användare)
app.post('/api/register', async (req, res) => {
    console.log("Mottog registreringsförfrågan:", req.body.username);
    try {
        const { username, password } = req.body;

        // Kolla om användaren redan finns
        console.log("Söker efter befintlig användare:", username);
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ message: "Användarnamnet upptaget" });

        // Hasha lösenordet (gör det oläsbart)
        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({
            username,
            password: hashedPassword,
            balance: 0 
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

        // Hitta användaren
        console.log("Söker efter användare för inloggning:", username);
        const user = await User.findOne({ username });
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

// --- AGARSTAKE SPELMOTOR (MULTIPLAYER) ---
const c = {
    worldWidth: 15000, // Ännu lite större för öppen värld
    worldHeight: 15000,
    foodCount: 0, // Ingen mat vid start, spawnas vid join
    virusCount: 40,
    playerStartBalance: 1.0, // Startar på $1.00
    maxCells: 16,
    minMassSplit: 2.0, // Kräver $2.0 i balans för att splitta
    minMassEject: 1.5,
    ejectMass: 0.05,
    ejectMassGain: 0.04,
    massLossRate: 1.0, // Ingen decay i penga-läge
    mergeTimer: 30, // sekunder (justerat för Agar.io-liknande beteende)
    speedMult: 0.8, 
    houseFee: 0.0, // 100% absorption vid ätande
    targetPopulation: 30, // Vi siktar på totalt 30 varelser i arenan
    botStartBalance: 1.0,
    botMaxBalance: 500.0,
    foodValuePerPlayer: 7.0, // Ny konstant: $7 värde av mat per spelare
    foodBlobValue: 0.01,     // Ny konstant: Varje matbit är värd $0.01
    rewardUnlockDelay: 2 * 60 * 1000, // Rewards låses upp efter 2 minuter
    roomDuration: 40 * 60 * 1000,     // Rummet stängs efter 40 minuter
    joinCutoff: 30 * 60 * 1000        // Inga nya spelare efter 30 minuter
};

// Säkerställ att vi har världsstorleken tillgänglig för utils om det behövs
const WORLD_SIZE = c.worldWidth;

// RUMSSYSTEM: Vi skapar 3 separata instanser av spelet
const rooms = [0, 1, 2].map(id => ({
    id,
    players: [],
    bots: [],
    food: [],
    viruses: [],
    ejected: [],
    startTime: Date.now() - (id * (c.roomDuration / 3)), // Tidsförskjut rummen så de inte startar om samtidigt
    qt: new QuadTree(new Rectangle(c.worldWidth / 2, c.worldHeight / 2, c.worldWidth / 2, c.worldHeight / 2), 4)
}));

// Radius beräknas via `util.massToRadius` (sqrt-baserad) för konsistens med klient och Agar.io

function addFood(room, n) {
    for (let i = 0; i < n; i++) {
        room.food.push({
            id: Math.random().toString(36).substr(2, 9),
            x: Math.random() * c.worldWidth,
            y: Math.random() * c.worldHeight,
            hue: Math.floor(Math.random() * 360),
            radius: 7,
            balance: 0.01 // Varje matbit är värd $0.01
        });
    }
}

function addViruses(room, n) {
    for (let i = 0; i < n; i++) {
        room.viruses.push({
            id: Math.random().toString(36).substr(2, 9),
            x: Math.random() * c.worldWidth,
            y: Math.random() * c.worldHeight,
            radius: util.massToRadius(100),
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
                balance: c.botStartBalance, radius: util.massToRadius(c.botStartBalance), vx: 0, vy: 0, lastSplit: Date.now()
            }]
        });
    }
}

// Initiera alla rum
rooms.forEach(room => {
    addViruses(room, c.virusCount);
    addBots(room, c.targetPopulation);
});

function getBestRoom() {
    const now = Date.now();
    // 1. Hitta rum som är öppna för anslutning (under 30 minuter gamla)
    let joinable = rooms.filter(r => (now - r.startTime) < c.joinCutoff);
    
    if (joinable.length === 0) {
        return rooms.sort((a, b) => b.startTime - a.startTime)[0];
    }

    // Matchmaking-prioritet: "prioriterar de rum med minst ai bottar om man bara behöver vänta i typ en minut annars tar den de senaste"
    // Vi tolkar detta som: om ett rum har mer än 1 min kvar till join-cutoff, prioritera rummet med flest spelare (minst bottar).
    const stableRooms = joinable.filter(r => (c.joinCutoff - (now - r.startTime)) > 60 * 1000);
    
    if (stableRooms.length > 0) {
        return stableRooms.sort((a, b) => a.bots.length - b.bots.length)[0];
    }

    // Annars ta det nyaste tillgängliga rummet
    return joinable.sort((a, b) => b.startTime - a.startTime)[0];
}

io.on('connection', (socket) => {
    socket.on('joinGame', async ({ username, token }) => {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig");
            const user = await User.findById(decoded.id);
            
            if (!user || user.balance < 10.0) {
                socket.emit('error', 'Minimum $10 balance required to enter.');
                return;
            }

            // EKONOMI: $10 inträde. $4 till plattform, $1 startbalans, $5 till mat-poolen.
            user.balance -= 10.0;
            await user.save();
            
            const room = getBestRoom();
            socket.roomId = room.id;

            const spawnX = Math.random() * c.worldWidth;
            const spawnY = Math.random() * c.worldHeight;

            const newPlayer = {
                id: socket.id,
                mongoId: user._id,
                username: username || user.username,
                kills: 0, // Behåll variabeln men används ej för rewards längre
                balance: c.playerStartBalance, 
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
                    radius: util.massToRadius(c.playerStartBalance),
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
                cell.radius = util.massToRadius(cell.balance);
                cell.lastSplit = Date.now(); // Starta timern även för ursprungscellen
                const angle = Math.atan2(p.mouseY, p.mouseX);
                newCells.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: cell.x, y: cell.y,
                    balance: cell.balance,
                    radius: util.massToRadius(cell.balance),
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

        console.log(`⏱️ User ${p.username} started cashout timer (30s)`);
        p.isCashingOut = true;
        
        // Meddela klienten att timern har börjat
        socket.emit('cashOutStarting', { seconds: 30 });

        setTimeout(async () => {
            // Hämta färsk referens till rummet och spelaren för att se om de fortfarande lever
            const activeRoom = rooms.find(r => r.id === socket.roomId);
            const activePlayer = activeRoom?.players.find(pl => pl.id === socket.id);

            // Om spelaren inte finns kvar i rummet (uppäten) eller flaggan nollställts, avbryt
            if (!activePlayer || !activePlayer.isCashingOut) {
                console.log(`❌ Cashout cancelled for ${p?.username || 'unknown'} (died or disconnected)`);
                return;
            }

            const age = Date.now() - activeRoom.startTime;
            const rewardsUnlocked = age > c.rewardUnlockDelay;

            // Beräkna leaderboard-bonus vid cashout ($20 för #1, $10 för #2-3)
            const all = [...activeRoom.players, ...activeRoom.bots].sort((a, b) => b.balance - a.balance);
            const rank = all.findIndex(u => u.id === socket.id) + 1;
            
            let rankBonus = 0;
            if (rewardsUnlocked) {
                if (rank === 1) rankBonus = 20.0;
                else if (rank <= 3) rankBonus = 10.0;
            }

            const totalCashout = activePlayer.balance + rankBonus;
            const mongoId = activePlayer.mongoId;
            const username = activePlayer.username;

            // Ta bort spelaren från arenan nu när utbetalningen är säkrad
            activeRoom.players = activeRoom.players.filter(pl => pl.id !== socket.id);

            try {
                const user = await User.findById(mongoId);
                if (user) {
                    user.balance += totalCashout; 
                    await user.save();
                    console.log(`💰 User ${username} cashed out $${totalCashout.toFixed(2)} (Rank: ${rank}, Bonus: $${rankBonus})`);
                    socket.emit('cashOutSuccess', { amount: totalCashout });
                }
            } catch (err) {
                console.error("Cashout error:", err);
            }
        }, 30000); // 30 sekunders fördröjning
    });

    socket.on('disconnect', () => {
        const room = rooms.find(r => r.id === socket.roomId);
        if (!room) return;
        room.players = room.players.filter(p => p.id !== socket.id);
        
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

    // Kontrollera om rummet har kört i 40 minuter och behöver starta om
    if (age > c.roomDuration) {
        console.log(`♻️ Room ${room.id} expired. Restarting...`);
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
                        cell.balance += item.data.balance || 0.01; 
                        cell.radius = util.massToRadius(cell.balance);
                        room.food = room.food.filter(f => f.id !== item.data.id);
                    }
                } else if (item.type === 'ejected') {
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r) {
                        cell.balance += item.data.balance; 
                        cell.radius = util.massToRadius(cell.balance);
                        room.ejected = room.ejected.filter(e => e.id !== item.data.id);
                    }
                } else if (item.type === 'virus') {
                    // Virusexplosion baserat på balans
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r && cell.balance > 2.0) {
                        if (player.cells.length < c.maxCells) {
                            cell.balance /= 2;
                            cell.radius = util.massToRadius(cell.balance);
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
                            // Merga när de överlappar ordentligt (t.ex. center nuddar den andra) för en mjuk "snap"
                            if (d < Math.max(r, r2)) {
                                cell.balance += otherCell.balance;
                                cell.radius = util.massToRadius(cell.balance);
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
                        if (cell.balance > otherCell.balance * 1.10 && d < r - r2 * 0.3) {
                            // EKONOMI: Absorberar 100% av balansen
                            cell.balance += otherCell.balance;
                            cell.radius = util.massToRadius(cell.balance);
                            const victim = room.players.find(p => p.id === item.socketId) || room.bots.find(b => b.id === item.botId);
                            if (victim) {
                                victim.cells = victim.cells.filter(c => c.id !== otherCell.id);
                                if (victim.cells.length === 0) {
                                    if (!victim.isBot) {
                                        io.to(victim.id).emit('RIP');
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

    const rewardsUnlocked = age > c.rewardUnlockDelay;
    
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
        io.to(p.id).emit('serverTellPlayerMove', p, Array.from(visibleUsersSet), visibleFood, visibleEjected, visibleViruses, rewardsUnlocked);
    });
}

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Servern körs på port ${PORT}`));