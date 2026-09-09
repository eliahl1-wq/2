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

if (process.env.NODE_ENV === 'production') throw new Error('Playtest must never run in production');
const require = createRequire(new URL('../../phantom-game/package.json', import.meta.url));
const { io: clientIo } = require('socket.io-client');
const app = express();
app.use(cors());
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });
const secret = 'local-surviv-br-fixture-not-an-account-secret';
const userId = 'local-viewer';
const token = jwt.sign({ id: userId }, secret);
const makeUser = id => ({ _id: id, id, username: id === userId ? 'Playtester' : id, balanceSol: 5, balanceUsd: 500, solPrice: 100,
    playtime: 0, freePlay: false, isAdmin: false, async save() {} });
const transactions = [];
const clients = [];
const deps = { DEV_FREE_PLAY: true, SOL_PRICE_USD: 100, JWT_SECRET: secret, rooms: [],
    User: { findById: async id => makeUser(id), findByIdAndUpdate: async () => {} },
    Transaction: { create: async transaction => { transactions.push(transaction); } }, isPersonalFreePlayUser: async () => false };
setupBattleRoyale(io, deps);
io.on('connection', socket => {
    socket.on('survivInput', payload => {
        const found = findBRPlayerBySocket(socket.id);
        if (found?.room.variant === 'surviv' && found.room.status === 'active') applySurvivInputPayload(found.player, payload);
    });
});
app.get('/fixture', (_req, res) => {
    const room = getBRMatchForMongo(userId);
    const player = room?.players.find(p => p.mongoId === userId);
    res.json({ token, status: room?.status, matchId: room?.id, player: player && { id: player.id, x: player.x, y: player.y, hp: player.hp, ammo: player.weapon?.ammo, weapon: player.weapon?.type },
        active: getActiveBRMatchesRaw().length, queue: getBRPlayerCountsByFee().surviv, payouts: transactions.filter(tx => tx.meta?.reason === 'BR Victory').length });
});
app.post('/fixture/fill', async (_req, res) => {
    await Promise.all(Array.from({ length: 9 }, (_, i) => new Promise(resolve => {
        const id = `practice-${clients.length}-${i}`;
        const client = clientIo('http://127.0.0.1:5057', { transports: ['websocket'] });
        clients.push(client);
        client.on('connect', () => client.emit('brJoinQueue', { variant: 'surviv', token: jwt.sign({ id }, secret), entryFeeUsd: 5, username: id }));
        client.once('brQueueStatus', resolve);
        client.on('brMatchCountdown', () => {});
    })));
    res.json({ filled: true });
});
app.post('/fixture/finish', (_req, res) => {
    const room = getBRMatchForMongo(userId);
    if (!room) return res.status(409).json({ error: 'No match' });
    const winner = room.players.find(p => p.mongoId === userId);
    for (const player of [...room.players]) if (player !== winner) { player.hp = 0; eliminateSurvivPlayer(room, player, io, winner); }
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
app.get('/api/me', (_req, res) => res.json(makeUser(userId)));
app.get('/api/game-status', (_req, res) => res.json({ inGame: !!getBRMatchForMongo(userId), mode: 'br-surviv', entryFeeUsd: 5, battleRoyale: true }));
app.get('/api/stats', (_req, res) => res.json({ playersByGamemode: { agar: 0, slither: 0, surviv: 0, brSurviv: getBRPlayerCountsByFee().surviv[5] }, totalPlayers: 0, solPrice: 100 }));
app.get('/api/leaderboard', (_req, res) => res.json([]));
app.get('/api/leaderboard-live', (_req, res) => res.json([]));
app.get('/api/shop/inventory', (_req, res) => res.json({ items: [], skins: [] }));
app.get('/api/shop/catalog', (_req, res) => res.json({ products: [], items: [] }));
app.use((_req, res) => res.json({}));
await prepareSurvivBRMap();
const tick = setInterval(() => { processBRQueues(io, deps); processBattleRoyaleMatches(io, deps); }, 25);
http.listen(5057, '127.0.0.1', () => console.log('Local BR fixture ready on http://127.0.0.1:5057 (simulated funds only)'));
process.on('SIGINT', () => { clearInterval(tick); clients.forEach(client => client.disconnect()); io.close(); http.close(); process.exit(0); });
