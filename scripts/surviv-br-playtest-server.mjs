// Local-only fixture: real Socket.IO, BR queue and authoritative Surviv engine.
// No database, wallets, main server, external services or real payments.
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { setupBattleRoyale, processBattleRoyaleMatches, processBRQueues, findBRPlayerBySocket, getActiveBRMatchesRaw, getBRMatchForMongo, getBRPlayerCountsByFee } from '../battle-royale.js';
import { prepareSurvivBRMap } from '../surviv-br-map-cache.js';
import { eliminateSurvivPlayer } from '../surviv-engine.js';
import { applySurvivInputPayload } from '../surviv-input.js';
import * as util from '../utils.js';

if (process.env.NODE_ENV === 'production') throw new Error('Playtest must never run in production');
const require = createRequire(new URL('../../phantom-game/package.json', import.meta.url));
const { io: clientIo } = require('socket.io-client');
const app = express();
app.get('/ready', (_req, res) => res.json({ ready: true, status: 'ready' }));
app.use(cors());
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });
const secret = 'local-surviv-br-fixture-not-an-account-secret';
const userId = 'local-viewer';
const token = jwt.sign({ id: userId }, secret);
const makeUser = id => ({ _id: id, id, username: id === userId ? 'Playtester' : id, balanceSol: 5, balanceUsd: 500, solPrice: 100,
    playtime: 0, freePlay: false, isAdmin: process.env.GAME_FIXTURE_ADMIN === 'true', async save() {} });
const transactions = [];
const clients = [];
const deps = { DEV_FREE_PLAY: true, SOL_PRICE_USD: 100, JWT_SECRET: secret, rooms: [], util,
    c: { worldWidth: 6000, worldHeight: 6000, playerStartBalance: 1, speedMult: 1.45, foodBlobValue: 0.04 },
    calculateCellRadius: (mass, _total, count, start = 1) => util.massToRadius((mass + Math.max(0, mass - start / count)) * 18),
    User: { findById: async id => makeUser(id), findByIdAndUpdate: async () => {} },
    Transaction: { create: async transaction => { transactions.push(transaction); } }, isPersonalFreePlayUser: async () => false };
setupBattleRoyale(io, deps);
io.on('connection', socket => {
    socket.on('0', payload => {
        const found = findBRPlayerBySocket(socket.id);
        if (found?.room.variant !== 'agar' || found.room.status !== 'active') return;
        for (const key of ['x', 'y']) if (!Number.isFinite(Number(payload?.[key]))) return;
        found.player.mouseX = Number(payload.x); found.player.mouseY = Number(payload.y);
        for (const key of ['screenWidth', 'screenHeight']) if (Number.isFinite(Number(payload[key]))) found.player[key] = Math.min(8000, Math.max(100, Number(payload[key])));
    });
    socket.on('slitherInput', payload => {
        const found = findBRPlayerBySocket(socket.id);
        if (found?.room.variant !== 'slither' || found.room.status !== 'active') return;
        const dx = Number(payload?.dx), dy = Number(payload?.dy);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const scale = Math.min(1, 4 / Math.max(1, Math.hypot(dx, dy)));
        found.player.inputDx = dx * scale; found.player.inputDy = dy * scale; found.player.boost = !!payload.boost;
    });
    socket.on('survivInput', payload => {
        const found = findBRPlayerBySocket(socket.id);
        if (found?.room.variant === 'surviv' && found.room.status === 'active') applySurvivInputPayload(found.player, payload);
    });
});
app.get('/fixture', (_req, res) => {
    const room = getBRMatchForMongo(userId);
    const player = room?.players.find(p => p.mongoId === userId);
    res.json({ token, status: room?.status, matchId: room?.id, player: player && { id: player.id, x: player.segments?.[0]?.x ?? player.x, y: player.segments?.[0]?.y ?? player.y, hp: player.hp, ammo: player.weapon?.ammo, weapon: player.weapon?.type,
        reloading: !!player.weapon?.reloading, ammoReserves: player.inventory?.ammoReserves, boost: !!player.boost,
        healing: player.medkitUseEndAt > Date.now(), medkits: player.inventory?.medkits },
        active: getActiveBRMatchesRaw().length, queue: getBRPlayerCountsByFee().surviv, payouts: transactions.filter(tx => tx.meta?.reason === 'BR Victory').length });
});
app.post('/fixture/fill', async (req, res) => {
    if (getBRMatchForMongo(userId)) return res.json({ alreadyStarted: true });
    const variant = ['agar', 'slither', 'surviv'].includes(req.query.variant) ? req.query.variant : 'surviv';
    await Promise.all(Array.from({ length: 9 }, (_, i) => new Promise(resolve => {
        const id = `practice-${clients.length}-${i}`;
        const client = clientIo('http://127.0.0.1:5057', { transports: ['websocket'] });
        clients.push(client);
        client.on('connect', () => client.emit('brJoinQueue', { variant, token: jwt.sign({ id }, secret), entryFeeUsd: 5, username: id }));
        client.once('brQueueStatus', resolve);
        client.once('brMatchCountdown', resolve);
    })));
    res.json({ filled: true });
});
app.post('/fixture/finish', (_req, res) => {
    const room = getBRMatchForMongo(userId);
    if (!room) return res.status(409).json({ error: 'No match' });
    const winner = room.players.find(p => p.mongoId === userId);
    if (!winner) return res.status(409).json({ error: 'Fixture player was eliminated before finish.' });
    if (room.variant === 'surviv') {
        for (const player of [...room.players]) if (player !== winner) { player.hp = 0; eliminateSurvivPlayer(room, player, io, winner); }
    } else room.players = [winner];
    res.json({ finishing: true });
});
app.post('/fixture/defeat', (_req, res) => {
    const room = getBRMatchForMongo(userId);
    const player = room?.players.find(p => p.mongoId === userId);
    if (player) { player.hp = 0; eliminateSurvivPlayer(room, player, io, room.players.find(p => p !== player)); }
    res.json({ defeated: !!player });
});
app.post('/fixture/loot', (_req, res) => {
    const room = getBRMatchForMongo(userId);
    const player = room?.players.find(p => p.mongoId === userId);
    if (player) {
        room.loot.push({ id: 'fixture-m416', type: 'weapon', weaponType: 'm416', x: player.x + 18, y: player.y, tier: 'common' });
        room._survivLootIndex = null;
    }
    res.json({ ready: !!player });
});
app.post('/fixture/healing', (_req, res) => {
    const room = getBRMatchForMongo(userId);
    const player = room?.players.find(p => p.mongoId === userId);
    if (player) {
        player.hp = 60; player.inventory.medkits = 2;
        // Isolate the inventory assertion from incidental automatic ground loot.
        room.loot = room.loot.filter(item => item.type !== 'medkit'
            || Math.hypot(item.x - player.x, item.y - player.y) > 150);
        room._survivLootIndex = null;
    }
    res.json({ ready: !!player });
});
app.get('/api/me', (_req, res) => res.json(makeUser(userId)));
app.get('/api/game-status', (_req, res) => {
    const room = getBRMatchForMongo(userId);
    res.json({ inGame: !!room, mode: `br-${room?.variant || 'surviv'}`, entryFeeUsd: 5, battleRoyale: true });
});
app.get('/api/stats', (_req, res) => res.json({ playersByGamemode: { agar: 0, slither: 0, surviv: 0, brSurviv: getBRPlayerCountsByFee().surviv[5] }, totalPlayers: 0, solPrice: 100 }));
app.get('/api/leaderboard', (_req, res) => res.json([]));
app.get('/api/leaderboard-live', (_req, res) => res.json([]));
app.get('/api/shop/inventory', (_req, res) => res.json({ items: [], skins: [] }));
app.get('/api/shop/catalog', (_req, res) => res.json({ products: [], items: [] }));
app.use((_req, res) => res.json({}));
await prepareSurvivBRMap();
const tick = setInterval(() => {
    processBRQueues(io, deps);
    // Recording/resize smoke tests inspect rendering and input, not random
    // deaths. Keep the Slither fixture on screen; collisions are unit-tested.
    if (process.env.GAME_FIXTURE_ADMIN === 'true') for (const room of getActiveBRMatchesRaw()) {
        if (room.variant !== 'slither') continue;
        room.isSandbox = true; room.sandboxInvincible = true; room.sandboxBotAi = true;
        if (!room._fixtureCentered && room.status === 'active') {
            const player = room.players.find(candidate => candidate.mongoId === userId);
            const head = player?.segments?.[0];
            if (head) {
                const dx = -head.x, dy = -head.y;
                for (const segment of player.segments) { segment.x += dx; segment.y += dy; }
                room._fixtureCentered = true;
            }
        }
    }
    processBattleRoyaleMatches(io, deps);
}, 25);
http.listen(5057, '127.0.0.1', () => console.log('Local BR fixture ready on http://127.0.0.1:5057 (simulated funds only)'));
process.on('SIGINT', () => { clearInterval(tick); clients.forEach(client => client.disconnect()); io.close(); http.close(); process.exit(0); });
