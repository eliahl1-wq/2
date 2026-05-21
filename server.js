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
                x: WORLD_SIZE / 2,
                y: WORLD_SIZE / 2,
                mass: 20,
                balance: 7, // Startkapital i spelet
                color: '#007AFF',
                mouseX: 0,
                mouseY: 0
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
        if (player && player.mass >= 35) {
            player.mass /= 2;
            // Logik för att skjuta iväg en ny cell läggs till i nästa steg
            console.log(`${player.username} split!`);
        }
    });

    socket.on('eject', () => {
        const player = players[socket.id];
        if (player && player.mass >= 25) {
            player.mass -= 5;
            // Skapa en liten matbit som flyger iväg
            console.log(`${player.username} ejected mass`);
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
    });
});

// Game Loop (60 FPS)
setInterval(() => {
    Object.values(players).forEach(player => {
        // Beräkna hastighet baserat på massa (Agar.io fysik)
        const speed = 4 / Math.pow(player.mass, 0.4);
        const angle = Math.atan2(player.mouseY, player.mouseX);
        
        player.x += Math.cos(angle) * speed;
        player.y += Math.sin(angle) * speed;

        // Världsgränser
        player.x = Math.max(0, Math.min(WORLD_SIZE, player.x));
        player.y = Math.max(0, Math.min(WORLD_SIZE, player.y));

        // Kolla mat-kollision
        food = food.filter(f => {
            const dist = Math.hypot(player.x - f.x, player.y - f.y);
            if (dist < Math.sqrt(player.mass * 100)) {
                player.mass += 0.5;
                player.balance += 0.01; // Varje matbit ger lite pengar
                return false;
            }
            return true;
        });

        // Kolla spelar-kollision (85/15 split regler)
        Object.values(players).forEach(other => {
            if (player.id === other.id) return;
            const dist = Math.hypot(player.x - other.x, player.y - other.y);
            const r1 = Math.sqrt(player.mass * 100);
            const r2 = Math.sqrt(other.mass * 100);

            if (dist < r1 && player.mass > other.mass * 1.1) {
                // Player äter Other
                player.mass += other.mass * 0.5;
                player.balance += (other.balance * 0.85); // Killer tar 85%
                // 15% försvinner till plattformen (house fee)
                delete players[other.id];
                io.to(other.id).emit('died');
            }
        });
    });

    // Skicka uppdatering till alla
    io.emit('tick', { players: Object.values(players), food });
}, 1000 / 60);

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Servern körs på port ${PORT}`));