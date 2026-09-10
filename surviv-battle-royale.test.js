import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { BR, getBRRules, setupBattleRoyale, getActiveBRMatchesRaw, getBRMatchForMongo, findBRPlayerBySocket, processBattleRoyaleMatches, processBRQueues, getBRPlayerCountsByFee } from './battle-royale.js';
import { SURVIV_BR, createSurvivBRZonePlan, getSurvivBRZone, initializeSurvivBRRoom } from './surviv-battle-royale.js';
import { eliminateSurvivPlayer, processSurvivRoom } from './surviv-engine.js';
import { brWalletEnvPrefix } from './br-wallets.js';
import { prepareSurvivBRMap } from './surviv-br-map-cache.js';
import { applySurvivInputPayload } from './surviv-input.js';

test('Surviv rules are 10–25, existing BR rules and wallet tiers stay separate', () => {
    assert.equal(getBRRules('surviv').minPlayers, 10);
    assert.equal(getBRRules('surviv').maxPlayers, 25);
    assert.equal(getBRRules('agar').minPlayers, 5);
    assert.equal(getBRRules('slither').maxPlayers, 10);
    assert.equal(brWalletEnvPrefix('surviv', 5), 'BR_SURVIV');
    assert.equal(brWalletEnvPrefix('surviv', 10), 'BR_SURVIV_10');
});

test('zone waits, moves continuously, stays nested, and eventually closes completely', () => {
    const plan = createSurvivBRZonePlan(1000, () => .37);
    assert.equal(getSurvivBRZone(plan, 1000).radius, SURVIV_BR.initialRadius);
    for (const stage of plan) {
        assert.ok(Math.hypot(stage.to.x - stage.from.x, stage.to.y - stage.from.y) + stage.to.radius <= stage.from.radius + .001);
        const before = getSurvivBRZone(plan, stage.movesAt - 1);
        assert.equal(before.shrinking, false);
        const half = getSurvivBRZone(plan, stage.movesAt + stage.moveMs / 2);
        assert.equal(half.shrinking, true);
        assert.equal(half.radius, (stage.from.radius + stage.to.radius) / 2);
        const end = getSurvivBRZone(plan, stage.endsAt);
        assert.equal(end.radius, stage.to.radius);
        assert.ok(Number.isFinite(end.x) && Number.isFinite(end.y));
    }
    const final = getSurvivBRZone(plan, plan.at(-1).endsAt + 100000);
    assert.equal(final.radius, 0);
    assert.equal(final.final, true);
    assert.equal(final.damagePerSecond, 20);
});

test('invalid maps fail closed rather than spawning a paid match into walls', () => {
    assert.throws(() => initializeSurvivBRRoom({ players: [] }, { obstacles: [], loot: [], spawnPoints: [] }), /25 safe spawn/);
});

function fakeNetwork() {
    const sockets = new Map();
    const io = {
        sockets: { sockets },
        on(event, handler) { if (event === 'connection') this.onConnect = handler; },
        to(target) { return { emit(event, ...args) {
            for (const socket of sockets.values()) if (socket.connected && (socket.id === target || socket.rooms.has(target))) socket.emit(event, ...args);
        } }; },
        connect(id) {
            const handlers = new Map();
            const socket = { id, connected: true, rooms: new Set(), events: [],
                on(event, handler) { handlers.set(event, handler); },
                emit(event, ...args) { this.events.push({ event, args }); },
                join(room) { this.rooms.add(room); }, leave(room) { this.rooms.delete(room); },
                async receive(event, ...args) { return handlers.get(event)?.(...args); },
                async disconnect() { this.connected = false; await this.receive('disconnect'); },
                last(event) { return this.events.findLast(entry => entry.event === event)?.args[0]; },
            };
            sockets.set(id, socket); io.onConnect(socket); return socket;
        },
    };
    return io;
}

test('public queue, refund, max cap, rejoin, zero world money, elimination and one winner payout', async t => {
    await prepareSurvivBRMap();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1900000000000 });
    const io = fakeNetwork();
    const transactions = [];
    const users = new Map();
    const deps = { DEV_FREE_PLAY: true, JWT_SECRET: 'local-br-test-only', SOL_PRICE_USD: 100, rooms: [],
        User: { async findById(id) { return users.get(String(id)); }, async findByIdAndUpdate() {} },
        Transaction: { async create(value) { transactions.push(value); } },
        isPersonalFreePlayUser: async () => false,
    };
    setupBattleRoyale(io, deps);
    const join = async id => {
        users.set(id, { _id: id, username: id, playtime: 0, async save() {} });
        const socket = io.connect(id);
        await socket.receive('brJoinQueue', { variant: 'surviv', token: jwt.sign({ id }, deps.JWT_SECRET), username: id, entryFeeUsd: 5 });
        assert.equal(socket.last('error'), undefined);
        return socket;
    };
    const players = [];
    for (let i = 0; i < 9; i++) players.push(await join(`player-${i}`));
    assert.equal(getActiveBRMatchesRaw().length, 0);
    assert.equal(players[0].last('brQueueStatus').playersInQueue, 9);
    assert.equal(players[0].last('brQueueStatus').minPlayers, 10);
    const tenth = await join('tenth');
    assert.ok(tenth.last('brQueueStatus').graceRemainingMs > 0);
    await tenth.receive('brLeaveQueue');
    t.mock.timers.tick(BR.gracePeriodMs + 1);
    processBRQueues(io, deps);
    assert.equal(getActiveBRMatchesRaw().length, 0, 'dropping below ten cancels grace');
    assert.equal(transactions.filter(tx => tx.meta.event === 'br_refund').length, 1);
    for (let i = 9; i < 25; i++) players.push(await join(`player-${i}`));
    const [room] = getActiveBRMatchesRaw();
    assert.ok(room);
    assert.equal(room.status, 'countdown');
    assert.equal(room.players.length, 25);
    assert.equal(room.prizePool, 230);
    assert.ok(room.players.every(player => !player.isBot && player.dollarBalance === 0));
    assert.equal(room.bots.length, 0);
    assert.ok(room.players.every(player => Math.hypot(player.x, player.y) < SURVIV_BR.initialRadius));
    assert.ok(room.loot.every(item => item.type !== 'money' && !(item.contents?.money > 0)));
    const initialPositions = room.players.map(p => ({ x: p.x, y: p.y }));
    processBattleRoyaleMatches(io, deps);
    assert.deepEqual(room.players.map(p => ({ x: p.x, y: p.y })), initialPositions, 'countdown freezes the simulation');
    const extra = await join('overflow');
    assert.equal(extra.last('brQueueStatus').playersInQueue, 1);
    assert.equal(room.players.length, 25, 'late join stays in next queue');
    await extra.receive('brLeaveQueue');

    room.bullets.push({ id: 'owned-before-rejoin', ownerId: players[0].id });
    await players[0].disconnect();
    const resumed = io.connect('new-socket');
    await resumed.receive('brRejoinMatch', { token: jwt.sign({ id: 'player-0' }, deps.JWT_SECRET) });
    assert.equal(resumed.last('welcome').id, 'new-socket');
    assert.equal(findBRPlayerBySocket('player-0'), null);
    assert.equal(findBRPlayerBySocket('new-socket').room, room);
    assert.equal(room.bullets[0].ownerId, 'new-socket');
    assert.equal(resumed.last('brMatchStart'), undefined, 'rejoining countdown does not start combat');
    room.bullets = [];
    t.mock.timers.tick(3000);
    assert.equal(room.status, 'active');
    assert.equal(resumed.last('brMatchStart').variant, 'surviv');
    assert.equal(getBRPlayerCountsByFee().surviv[10], 25);
    processBattleRoyaleMatches(io, deps);
    assert.equal(resumed.last('survivTick').aliveCount, 25);
    assert.deepEqual(resumed.last('survivTick').activityZones, [], 'BR does not expose opponent heatmaps');
    assert.equal(room.bots.length, 0, 'normal Surviv bot sync never pads a BR match');
    for (const player of [...room.players].slice(2)) {
        player.hp = 0;
        eliminateSurvivPlayer(room, player, io, room.players[0]);
    }
    await players[1].disconnect();
    processBattleRoyaleMatches(io, deps);
    assert.equal(room.status, 'active', 'disconnect is not a free elimination or premature victory');
    assert.equal(resumed.last('survivTick').aliveCount, 2);
    const runnerUp = room.players.find(player => player.id !== resumed.id);
    runnerUp.hp = 0;
    eliminateSurvivPlayer(room, runnerUp, io, room.players[0]);
    processBattleRoyaleMatches(io, deps);
    // Payout is asynchronous but no external services are touched in this test.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(resumed.last('brVictory').amount, 230);
    assert.equal(transactions.filter(tx => tx.meta.reason === 'BR Victory').length, 1);
    assert.equal(getBRMatchForMongo('player-0'), null);
    assert.equal(getActiveBRMatchesRaw().length, 0);
    assert.equal(players[2].last('brEliminated').placement, 25);
    assert.equal(getBRPlayerCountsByFee().surviv[10], 0);
});

test('BR zone damage uses its phase rather than normal server reset damage', t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1900000000000 });
    const room = { isBattleRoyale: true, players: [], bots: [], bullets: [], loot: [], obstacles: [], spectators: [],
        zone: { x: 1000, y: 1000, radius: 20, damagePerSecond: 20 }, _nextSurvivAirdropAt: Infinity };
    const entity = { id: 'offline', x: 0, y: 0, hp: 100, maxHp: 100, disconnected: true,
        cashoutSettling: false, weapon: { type: 'fists' }, inventory: { weapons: [], ammoReserves: {} }, _lastZoneDamageAt: Date.now() };
    room.players.push(entity);
    const io = { to: () => ({ emit() {} }) };
    t.mock.timers.tick(200);
    processSurvivRoom(room, io, Date.now() + 10000000);
    assert.equal(entity.hp, 96);
    assert.equal(room.bots.length, 0);
});

test('Surviv network inputs clamp movement and reject actions from dead players', () => {
    const player = { hp: 100, weapon: { type: 'fists' }, inventory: {}, _receivedFirePressId: 0 };
    applySurvivInputPayload(player, { dx: 999, dy: -999, aimAngle: Infinity, shooting: true, firePressId: 1, equipSlot: 99, pickupWeapon: 'loot-123', dropItem: { itemKey: 'weapon', slotIdx: 99 } });
    assert.equal(player.inputDx, 1);
    assert.equal(player.inputDy, -1);
    assert.equal(player.aimAngle, undefined);
    assert.equal(player.equipSlotPending, undefined);
    assert.equal(player.pickupWeaponPending, 'loot-123');
    assert.equal(player.dropItemPending.slotIdx, null);
    player.hp = 0;
    applySurvivInputPayload(player, { dx: 0, shooting: false, firePressId: 2 });
    assert.equal(player.inputDx, 1, 'dead input is ignored');
});

test('simultaneous final deaths refund all entries once, without naming a dead winner', async t => {
    await prepareSurvivBRMap();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1900100000000 });
    const io = fakeNetwork();
    const transactions = [];
    const deps = { DEV_FREE_PLAY: true, JWT_SECRET: 'draw-test', SOL_PRICE_USD: 100, rooms: [],
        User: { findById: async id => ({ _id: id, username: id }), findByIdAndUpdate: async () => {} },
        Transaction: { create: async tx => { transactions.push(tx); } }, isPersonalFreePlayUser: async () => false };
    setupBattleRoyale(io, deps);
    const sockets = [];
    for (let i = 0; i < 10; i++) {
        const id = `draw-${i}`;
        const socket = io.connect(id); sockets.push(socket);
        await socket.receive('brJoinQueue', { variant: 'surviv', token: jwt.sign({ id }, deps.JWT_SECRET), entryFeeUsd: 10 });
    }
    t.mock.timers.tick(BR.gracePeriodMs);
    const [room] = getActiveBRMatchesRaw();
    assert.equal(room.players.length, 10, 'minimum lobby launches after grace');
    t.mock.timers.tick(3000);
    const victims = [...room.players];
    victims.forEach(player => { player.hp = 0; });
    victims.forEach(player => eliminateSurvivPlayer(room, player, io));
    processBattleRoyaleMatches(io, deps);
    processBattleRoyaleMatches(io, deps);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.ok(sockets.every(socket => socket.last('brEliminated').placement === 2));
    assert.ok(sockets.every(socket => socket.last('brMatchEnd').cancelled && socket.last('brMatchEnd').refunded));
    assert.equal(transactions.filter(tx => tx.meta.event === 'br_refund').length, 10);
    assert.equal(transactions.filter(tx => tx.meta.reason === 'BR Victory').length, 0);
    assert.equal(getActiveBRMatchesRaw().length, 0);
});

test('public free Surviv waits 15 quiet seconds, fills only missing slots, and runs real bots without payments', async t => {
    await prepareSurvivBRMap();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1900200000000 });
    const io = fakeNetwork();
    const transactions = [];
    const deps = { DEV_FREE_PLAY: false, JWT_SECRET: 'public-free-br-test', SOL_PRICE_USD: 100, rooms: [],
        User: { findById: async id => ({ _id: id, username: id }), findByIdAndUpdate: async () => {} },
        Transaction: { create: async tx => { transactions.push(tx); } },
        isPersonalFreePlayUser: async () => false,
        ensureUserDepositWallet: async () => { throw new Error('Free queue must never touch wallets'); },
    };
    setupBattleRoyale(io, deps);
    const join = async id => {
        const socket = io.connect(id);
        await socket.receive('brJoinQueue', { variant: 'surviv', token: jwt.sign({ id }, deps.JWT_SECRET), entryFeeUsd: 5, publicFreeMode: true });
        assert.equal(socket.last('error'), undefined);
        return socket;
    };
    const cancelled = await join('cancel-free');
    await cancelled.receive('brLeaveQueue');
    t.mock.timers.tick(16000);
    processBRQueues(io, deps);
    assert.equal(getActiveBRMatchesRaw().length, 0, 'cancelled empty queue never starts bots');
    for (const humanCount of [1, 2]) {
        const first = await join(`free-${humanCount}-first`);
        t.mock.timers.tick(14000);
        processBRQueues(io, deps);
        assert.equal(first.last('brQueueStatus').playersInQueue, 1);
        if (humanCount === 2) {
            await join('free-second');
            t.mock.timers.tick(14000);
            processBRQueues(io, deps);
            assert.equal(first.last('brQueueStatus').playersInQueue, 2, 'new human restarts quiet wait');
        }
        t.mock.timers.tick(1000);
        processBRQueues(io, deps);
        assert.equal(first.last('brQueueStatus').playersInQueue, 10);
        t.mock.timers.tick(3000);
        const room = getBRMatchForMongo(`free-${humanCount}-first`);
        assert.ok(room.personalFreePlay);
        assert.equal(room.entryFeeUsd, 10, 'server overrides a stale $5 practice request');
        assert.equal(room.prizePool, 92);
        assert.equal(room.players.filter(p => p.isBot).length, 10 - humanCount);
        assert.equal(room.players.length, 10);
        t.mock.timers.tick(3000);
        const bots = room.players.filter(p => p.isBot);
        const before = bots.map(p => [p.x, p.y]);
        for (let i = 0; i < 10; i++) { t.mock.timers.tick(25); processBattleRoyaleMatches(io, deps); }
        assert.ok(bots.some((p, i) => p.x !== before[i][0] || p.y !== before[i][1]), 'bots actually move under Surviv AI');
        for (const player of [...room.players]) { player.hp = 0; eliminateSurvivPlayer(room, player, io); }
        processBattleRoyaleMatches(io, deps);
        for (let i = 0; i < 12; i++) await Promise.resolve();
    }
    assert.ok(transactions.every(tx => tx.meta.simulated), 'all joins/refunds are simulated');
});
