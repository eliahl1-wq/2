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
const httpServer = createServer(app);
const io = new Server(httpServer, { 
    cors: { origin: "*" },
    pingTimeout: 60000, // Öka timeout för att undvika att Render bryter anslutningen
    pingInterval: 25000
});

app.use(express.json());
app.use(cors());

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
    
    jwt.verify(token, process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig", (err, user) => {
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
        if (!user) {
            console.log("❌ FAIL: Användaren hittades inte:", username);
            return res.status(400).json({ message: "Användaren finns inte" });
        }

        // Jämför lösenordet med det i databasen
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            console.log("❌ FAIL: Fel lösenord för:", username);
            return res.status(400).json({ message: "Fel lösenord" });
        }

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

// --- AGARSTAKE SPELMOTOR (MULTIPLAYER) ---
const c = {
    worldWidth: 5000,
    worldHeight: 5000,
    foodCount: 500,
    virusCount: 20,
    playerStartMass: 20,
    maxCells: 16,
    minMassSplit: 35,
    minMassEject: 30,
    ejectMass: 12,
    ejectMassGain: 10,
    massLossRate: 1.002, 
    mergeTimer: 15, // sekunder
    speedMult: 2.1,
    houseFee: 0.15 
};

// Säkerställ att vi har världsstorleken tillgänglig för utils om det behövs
const WORLD_SIZE = c.worldWidth;

let gamePlayers = [];
let gameFood = [];
let gameViruses = [];
let gameEjected = [];
const qt = new QuadTree(new Rectangle(c.worldWidth / 2, c.worldHeight / 2, c.worldWidth / 2, c.worldHeight / 2), 4);

function addFood(n) {
    for (let i = 0; i < n; i++) {
        gameFood.push({
            id: Math.random().toString(36).substr(2, 9),
            x: Math.random() * c.worldWidth,
            y: Math.random() * c.worldHeight,
            color: `hsl(${Math.random() * 360}, 100%, 50%)`,
            mass: 1
        });
    }
}

function addViruses(n) {
    for (let i = 0; i < n; i++) {
        gameViruses.push({
            id: Math.random().toString(36).substr(2, 9),
            x: Math.random() * c.worldWidth,
            y: Math.random() * c.worldHeight,
            mass: 100,
            color: '#33ff33'
        });
    }
}

addFood(c.foodCount);
addViruses(c.virusCount);

io.on('connection', (socket) => {
    socket.on('joinGame', async ({ username, token }) => {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig");
            const user = await User.findById(decoded.id);
            
            if (!user || user.balance < 10) {
                socket.emit('error', 'Minimum $10 balance required to enter.');
                return;
            }

            user.balance -= 10; // Drar $10 vid start (entry fee)
            await user.save();

            const newPlayer = {
                id: socket.id,
                username: user.username,
                balance: 7, // Börjar med $7 i arenan efter fee
                color: util.randomColor(),
                mouseX: 0,
                mouseY: 0,
                screenWidth: 1920,
                screenHeight: 1080,
                cells: [{
                    id: Math.random().toString(36).substr(2, 9),
                    x: util.randomInRange(100, c.worldWidth - 100),
                    y: util.randomInRange(100, c.worldHeight - 100),
                    mass: c.playerStartMass,
                    radius: util.massToRadius(c.playerStartMass),
                    speed: 0,
                    lastSplit: Date.now()
                }]
            };
            gamePlayers.push(newPlayer);
            // Skicka 'welcome' som i original-repot, med spelarens initiala data och världsstorlek
            socket.emit('welcome', newPlayer, { width: c.worldWidth, height: c.worldHeight });
        } catch (err) {
            socket.emit('error', 'Authentication failed');
        }
    });

    // Protokoll-matchning: 0 = rörelse
    socket.on('0', (data) => {
        const p = gamePlayers.find(pl => pl.id === socket.id);
        if (p) { p.mouseX = data.x; p.mouseY = data.y; }
    });

    // Protokoll-matchning: 2 = split
    socket.on('2', () => {
        const p = gamePlayers.find(pl => pl.id === socket.id);
        if (!p || p.cells.length >= c.maxCells) return;
        
        let newCells = [];
        p.cells.forEach(cell => {
            if (cell.mass >= c.minMassSplit) {
                cell.mass /= 2;
                cell.radius = util.massToRadius(cell.mass);
                const angle = Math.atan2(p.mouseY, p.mouseX);
                newCells.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: cell.x, y: cell.y,
                    mass: cell.mass,
                    radius: cell.radius,
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
        const p = gamePlayers.find(pl => pl.id === socket.id);
        if (!p) return;
        p.cells.forEach(cell => {
            if (cell.mass >= c.minMassEject) {
                cell.mass -= c.ejectMass;
                const angle = Math.atan2(p.mouseY, p.mouseX);
                gameEjected.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: cell.x + Math.cos(angle) * (cell.radius + 20),
                    y: cell.y + Math.sin(angle) * (cell.radius + 20),
                    radius: 10,
                    vx: Math.cos(angle) * 15,
                    vy: Math.sin(angle) * 15,
                    color: p.color,
                    mass: c.ejectMassGain
                });
            }
        });
    });

    socket.on('disconnect', () => {
        gamePlayers = gamePlayers.filter(p => p.id !== socket.id);
    });
});

setInterval(() => {
    qt.clear();
    gamePlayers.forEach(p => p.cells.forEach(cell => qt.insert(new Point(cell.x, cell.y, { type: 'player', socketId: p.id, cell }))));
    gameFood.forEach(f => qt.insert(new Point(f.x, f.y, { type: 'food', data: f })));
    gameViruses.forEach(v => qt.insert(new Point(v.x, v.y, { type: 'virus', data: v })));
    gameEjected.forEach(e => qt.insert(new Point(e.x, e.y, { type: 'ejected', data: e })));

    gamePlayers.forEach(player => {
        player.cells.forEach((cell, index) => {
            // PHYSICS: Movement & Friction
            const speed = (60 / Math.pow(cell.mass, 0.44)) * c.speedMult;
            const angle = Math.atan2(player.mouseY, player.mouseX);
            const distToMouse = Math.hypot(player.mouseX, player.mouseY);
            
            const moveSpeed = distToMouse < 50 ? (speed * distToMouse / 50) : speed;
            cell.x += (Math.cos(angle) * moveSpeed) + (cell.vx || 0); // Lägg till vx/vy för impuls
            cell.y += (Math.sin(angle) * moveSpeed) + cell.vy;
            cell.vx *= 0.85; cell.vy *= 0.85;

            // DECAY
            if (cell.mass > c.playerStartMass) cell.mass /= c.massLossRate;

            // BOUNDS
            const r = cell.radius;
            cell.x = Math.max(r, Math.min(c.worldWidth - r, cell.x));
            cell.y = Math.max(r, Math.min(c.worldHeight - r, cell.y));

            // SPATIAL COLLISIONS
            const range = new Rectangle(cell.x, cell.y, r * 2, r * 2);
            const items = qt.query(range);

            items.forEach(item => {
                if (item.type === 'food') {
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r) {
                        cell.mass += 1; 
                        cell.radius = util.massToRadius(cell.mass); // Uppdatera radien
                        player.balance += 0.01;
                        gameFood = gameFood.filter(f => f.id !== item.data.id);
                    }
                } else if (item.type === 'ejected') {
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r) {
                        cell.mass += item.data.mass; 
                        cell.radius = util.massToRadius(cell.mass);
                        gameEjected = gameEjected.filter(e => e.id !== item.data.id);
                    }
                } else if (item.type === 'virus') {
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r && cell.mass > item.data.mass * 1.1) {
                        if (player.cells.length < c.maxCells) {
                            cell.mass /= 2;
                            cell.radius = util.massToRadius(cell.mass);
                            player.cells.push({
                                id: Math.random().toString(36).substr(2, 9), 
                                x: cell.x, y: cell.y, mass: cell.mass, radius: cell.radius, vx: Math.random() * 40 - 20, vy: Math.random() * 40 - 20, lastSplit: Date.now() 
                            });
                            gameViruses = gameViruses.filter(v => v.id !== item.data.id);
                        }
                    }
                } else if (item.type === 'player') {
                    const otherCell = item.cell;
                    if (otherCell.id === cell.id) return;
                    const d = Math.hypot(cell.x - otherCell.x, cell.y - otherCell.y);
                    const r2 = otherCell.radius;

                    if (item.socketId === player.id) {
                        // INTERNAL: Merge or Push
                        const canMerge = (Date.now() - cell.lastSplit > c.mergeTimer * 1000) && (Date.now() - otherCell.lastSplit > c.mergeTimer * 1000);
                        if (canMerge && d < (r + r2) * 0.5) {
                            cell.mass += otherCell.mass;
                            cell.radius = util.massToRadius(cell.mass); // Uppdatera radien
                            player.cells = player.cells.filter(c => c.id !== otherCell.id);
                        } else if (d < r + r2) {
                            const pushAngle = Math.atan2(cell.y - otherCell.y, cell.x - otherCell.x);
                            const force = (r + r2 - d) / 15;
                            cell.vx += Math.cos(pushAngle) * force; cell.vy += Math.sin(pushAngle) * force;
                        }
                    } else {
                        // EXTERNAL: Eat
                        if (cell.mass > otherCell.mass * 1.15 && d < r - r2 * 0.3) {
                            cell.mass += otherCell.mass;
                            cell.radius = util.massToRadius(cell.mass); // Uppdatera radien
                            const victim = gamePlayers.find(p => p.id === item.socketId);
                            if (victim) {
                                const weight = otherCell.mass / victim.cells.reduce((a, b) => a + b.mass, 0);
                                // Överför balans: Killer tar 85%, 15% försvinner (fee)
                                const prize = victim.balance * weight * (1 - c.houseFee);
                                player.balance += prize;
                                victim.balance -= (victim.balance * weight);
                                victim.cells = victim.cells.filter(c => c.id !== otherCell.id);
                                if (victim.cells.length === 0) {
                                    // Spara slutbalans till DB här om man vill
                                    io.to(victim.id).emit('died');
                                }
                            }
                        }
                    }
                }
            });
        });
    });

    gameEjected.forEach(e => { e.x += e.vx; e.y += e.vy; e.vx *= 0.9; e.vy *= 0.9; });
    if (gameFood.length < c.foodCount) addFood(c.foodCount - gameFood.length);
    if (gameViruses.length < c.virusCount) addViruses(c.virusCount - gameViruses.length);

    // Skicka leaderboard separat för prestanda
    const leaderboard = gamePlayers
        .map(p => ({ id: p.id, name: p.username, massTotal: p.cells.reduce((s, c) => s + c.mass, 0), balance: p.balance }))
        .sort((a, b) => b.massTotal - a.massTotal)
        .slice(0, 10);
    io.emit('leaderboard', { leaderboard });

    // Agario-logik: Skicka individuell data till varje spelare så kameran hamnar rätt (player-centric view)
    gamePlayers.forEach(p => {
        io.to(p.id).emit('serverTellPlayerMove', p, gamePlayers, gameFood, gameEjected, gameViruses);
    });
}, 1000 / 60);

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Servern körs på port ${PORT}`));