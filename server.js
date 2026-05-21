import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { createServer } from 'http';
import 'dotenv/config';

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
    res.send('<html><body style="font-family:sans-serif;background:#0a0a0c;color:white;text-align:center;padding-top:100px;"><h1>AgarStake Engine v2.0 🎮</h1><p style="color:#007AFF;font-size:1.5rem;">Status: Pro Physics Enabled</p></body></html>');
});

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

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
let players = {};
let food = [];
let ejectedMass = [];
const WORLD_SIZE = 5000;

// Initiera mat
for (let i = 0; i < 300; i++) {
    food.push({ id: i, x: Math.random() * WORLD_SIZE, y: Math.random() * WORLD_SIZE, color: `hsl(${Math.random() * 360}, 70%, 50%)` });
}

io.on('connection', (socket) => {
    console.log(`📡 Nytt anslutningsförsök (Socket ID: ${socket.id})`);
    
    // Kolla om vi fick med auth-token direkt i handskakningen
    if (socket.handshake.auth && socket.handshake.auth.token) {
        console.log(`🔑 Token mottagen vid anslutning för: ${socket.id}`);
    } else {
        console.log(`⚠️ Ingen token hittades i handskakningen för: ${socket.id}`);
    }

    socket.on('joinGame', async ({ username, token }) => {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_hemlighet_byt_ut_mig");
            const user = await User.findById(decoded.id);
            
            if (!user || user.balance < 10) {
                socket.emit('error', 'Minimum $10 balance required.');
                return;
            }

            // DRAG PENGAR: $10 entry ($3 house fee, $7 active balance)
            user.balance -= 10;
            await user.save();

            players[socket.id] = {
                id: socket.id,
                username: user.username,
                balance: 7, // Startkapital i spelet
                color: '#007AFF',
                mouseX: 0,
                mouseY: 0,
                cells: [{ x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, mass: 20, vx: 0, vy: 0, lastSplit: Date.now() }]
            };

            socket.emit('init', { id: socket.id, food });
        } catch (err) {
            socket.emit('error', 'Auth failed');
        }
    });

    socket.on('mouseMove', (data) => {
        if (players[socket.id]) {
            players[socket.id].mouseX = data.x;
            players[socket.id].mouseY = data.y;
        }
    });

    socket.on('split', () => {
        const player = players[socket.id];
        if (!player || player.cells.length >= 16) return;

        let newCells = [];
        player.cells.forEach(cell => {
            if (cell.mass >= 35) {
                cell.mass /= 2;
                const angle = Math.atan2(player.mouseY, player.mouseX);
                newCells.push({
                    x: cell.x,
                    y: cell.y,
                    mass: cell.mass,
                    vx: Math.cos(angle) * 25, // Explosiv fart
                    vy: Math.sin(angle) * 25,
                    lastSplit: Date.now()
                });
            }
        });
        player.cells.push(...newCells);
    });

    socket.on('eject', () => {
        const player = players[socket.id];
        if (!player) return;
        
        player.cells.forEach(cell => {
            if (cell.mass >= 30) {
                cell.mass -= 10;
                const angle = Math.atan2(player.mouseY, player.mouseX);
                ejectedMass.push({
                    x: cell.x + Math.cos(angle) * (Math.sqrt(cell.mass * 100) + 20),
                    y: cell.y + Math.sin(angle) * (Math.sqrt(cell.mass * 100) + 20),
                    vx: Math.cos(angle) * 15,
                    vy: Math.sin(angle) * 15,
                    color: player.color
                });
            }
        });
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
    });
});

// Game Loop (60 FPS)
setInterval(() => {
    Object.values(players).forEach(player => {
        player.cells.forEach((cell, index) => {
            // 1. Grundrörelse (följ musen)
            const speed = 4 / Math.pow(cell.mass, 0.35);
            const angle = Math.atan2(player.mouseY, player.mouseX);
            
            // Applicera fart + fart från split (vx/vy)
            cell.x += (Math.cos(angle) * speed) + cell.vx;
            cell.y += (Math.sin(angle) * speed) + cell.vy;

            // Friktion (saktar ner vx/vy)
            cell.vx *= 0.9;
            cell.vy *= 0.9;

            // 2. Gränser
            cell.x = Math.max(0, Math.min(WORLD_SIZE, cell.x));
            cell.y = Math.max(0, Math.min(WORLD_SIZE, cell.y));

            // 3. Mat-kollision
            food = food.filter(f => {
                const dist = Math.hypot(cell.x - f.x, cell.y - f.y);
                if (dist < Math.sqrt(cell.mass * 100)) {
                    cell.mass += 1;
                    player.balance += 0.01;
                    return false;
                }
                return true;
            });

            // 4. Kollision med andra spelare
            Object.values(players).forEach(other => {
                if (player.id === other.id) {
                    // Re-merge logik för egna celler
                    other.cells.forEach((otherCell, otherIndex) => {
                        if (index === otherIndex) return;
                        const dist = Math.hypot(cell.x - otherCell.x, cell.y - otherCell.y);
                        const canMerge = (Date.now() - cell.lastSplit > 15000) && (Date.now() - otherCell.lastSplit > 15000);
                        
                        if (dist < Math.sqrt(cell.mass * 100) && canMerge) {
                            cell.mass += otherCell.mass;
                            player.cells.splice(otherIndex, 1);
                        }
                    });
                    return;
                }
                
                other.cells.forEach((otherCell, otherIndex) => {
                    const dist = Math.hypot(cell.x - otherCell.x, cell.y - otherCell.y);
                    const r1 = Math.sqrt(cell.mass * 100);
                    if (dist < r1 && cell.mass > otherCell.mass * 1.15) {
                        cell.mass += otherCell.mass * 0.5;
                        player.balance += (other.balance * (otherCell.mass / other.cells.reduce((a,b) => a + b.mass, 0)) * 0.85);
                        other.cells.splice(otherIndex, 1);
                        if (other.cells.length === 0) {
                            delete players[other.id];
                            io.to(other.id).emit('died');
                        }
                    }
                });
            });
        });
    });

    // Uppdatera utskjuten massa
    ejectedMass.forEach((m, i) => {
        m.x += m.vx;
        m.y += m.vy;
        m.vx *= 0.9;
        m.vy *= 0.9;
        // Om någon äter den
        Object.values(players).forEach(p => {
            p.cells.forEach(c => {
                if (Math.hypot(c.x - m.x, c.y - m.y) < Math.sqrt(c.mass * 100)) {
                    c.mass += 8;
                    ejectedMass.splice(i, 1);
                }
            });
        });
    });

    // Fyll på mat om det behövs
    if (food.length < 300) {
        food.push({ id: Date.now(), x: Math.random() * WORLD_SIZE, y: Math.random() * WORLD_SIZE, color: `hsl(${Math.random() * 360}, 70%, 50%)` });
    }

    io.emit('tick', { players: Object.values(players), food, ejectedMass });
}, 1000 / 60);

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Servern körs på port ${PORT}`));