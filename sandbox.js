/**
 * Admin sandbox — isolated rooms for filming gamemode previews.
 * No economy, no global reset, full manual control.
 */
import jwt from 'jsonwebtoken';
import {
    SLITHER,
    COMPETITIVE_SLITHER,
    createSlitherPlayer,
    createSegments,
    randomCoordInRoom,
    addSlitherBots,
    createSlitherBot,
    processSlitherRoom,
    broadcastSlitherState,
    trimSlitherFood,
} from './slither-engine.js';
import { DEFAULT_ENTRY_FEE, getEconomy } from './economy.js';
import * as util from './utils.js';

const SANDBOX_POOL = 1_000_000;
const MAX_SANDBOX_FOOD = 400;
const MAX_SANDBOX_BOTS = 12;
const MAX_SANDBOX_BOTS_PER_SPAWN = 8;
const MAX_SANDBOX_STATIC_WORMS = 10;
const SANDBOX_PAUSED_BROADCAST_INTERVAL = 4;
const SANDBOX_TICK_RATE = 40;
const SANDBOX_NETWORK_TICK_DIVISOR = 2;
const SANDBOX_RECONNECT_GRACE_MS = 45_000;
const SANDBOX_ZONE_DAMAGE_PER_SECOND = 34;
const SANDBOX_ZONE_HEAL_PER_SECOND = 18;

function defaultZone(worldHalf, mode = 'slither') {
    const center = mode === 'agar' ? worldHalf : 0;
    return {
        cx: center,
        cy: center,
        radius: worldHalf,
        shrinking: false,
        shrinkStartAt: null,
        shrinkDurationMs: 120_000,
        startRadius: worldHalf,
        endRadius: Math.max(200, worldHalf * 0.15),
    };
}

function createSandboxRoom(mode) {
    // Match competitive arena size — smaller map, less render/broadcast cost than full Slither.
    const worldHalf = mode === 'slither' ? COMPETITIVE_SLITHER.worldHalf : 3000;
    return {
        id: `sandbox-${mode}`,
        mode,
        isSandbox: true,
        entryFeeUsd: DEFAULT_ENTRY_FEE,
        players: [],
        bots: [],
        slitherBots: [],
        sandboxStaticWorms: [],
        food: [],
        slitherFood: [],
        viruses: [],
        ejected: [],
        foodPoolBalance: SANDBOX_POOL,
        aiBudgetBalance: SANDBOX_POOL,
        ownerBalance: 0,
        startTime: Date.now(),
        isResetting: false,
        sandboxPaused: false,
        sandboxSpeedMultiplier: 1.0,
        sandboxBotAi: true,
        sandboxInvincible: true,
        sandboxAutoBots: false,
        sandboxAutoFood: false,
        sandboxWorldHalf: worldHalf,
        sandboxNetworkTick: 0,
        sandboxLastTickAt: Date.now(),
        sandboxZone: defaultZone(worldHalf, mode),
        qt: null,
    };
}

const sandboxRooms = {
    agar: null,
    slither: null,
};

export function getSandboxRoom(mode) {
    const key = mode === 'slither' ? 'slither' : 'agar';
    if (!sandboxRooms[key]) sandboxRooms[key] = createSandboxRoom(key);
    return sandboxRooms[key];
}

function recoverSandboxStackOverflow(mode, err, socket, deps) {
    const isStackOverflow = err instanceof RangeError
        || /maximum call stack size exceeded/i.test(String(err?.message || err));
    if (!isStackOverflow || socket.sandboxStackRecoveryAttempted) return false;

    socket.sandboxStackRecoveryAttempted = true;
    const key = mode === 'slither' ? 'slither' : 'agar';
    console.error('[Sandbox] Recovering corrupted room after stack overflow:', err?.stack || err);
    sandboxRooms[key] = createSandboxRoom(key);
    if (key === 'agar') {
        initAgarSandboxRoom(sandboxRooms[key], {
            QuadTree: deps.QuadTree,
            Rectangle: deps.Rectangle,
            c: deps.c,
            addViruses: deps.addViruses,
        });
    }
    socket.sandboxMode = null;
    socket.roomId = null;
    socket.emit('sandboxRecovered');
    return true;
}

function initAgarSandboxRoom(room, deps) {
    const { QuadTree, Rectangle, c, addViruses } = deps;
    room.qt = new QuadTree(
        new Rectangle(c.worldWidth / 2, c.worldHeight / 2, c.worldWidth / 2, c.worldHeight / 2),
        4,
    );
    addViruses(room, c.virusCount);
}

/** Wipe both sandbox rooms, kick all connected sandbox clients, recreate fresh state. */
export function abortAllSandbox(io, deps) {
    for (const key of ['agar', 'slither']) {
        const room = sandboxRooms[key];
        if (room?.players?.length) {
            for (const p of room.players) {
                io.to(p.id).emit('sandboxAborted');
                const s = io.sockets.sockets.get(p.id);
                if (s) {
                    s.sandboxMode = null;
                    s.roomId = null;
                }
            }
        }
        sandboxRooms[key] = createSandboxRoom(key);
        if (key === 'agar' && deps) {
            initAgarSandboxRoom(sandboxRooms[key], deps);
        }
    }
    return { aborted: true };
}

function getSandboxZone(room) {
    const zone = room.sandboxZone;
    if (!zone) return null;
    if (!zone.shrinking || !zone.shrinkStartAt) {
        return { cx: zone.cx, cy: zone.cy, radius: zone.radius, shrinking: false };
    }
    const elapsed = Date.now() - zone.shrinkStartAt;
    const t = Math.min(1, elapsed / zone.shrinkDurationMs);
    const startR = zone.startRadius ?? zone.radius;
    const endR = zone.endRadius ?? Math.max(200, startR * 0.15);
    const radius = startR + (endR - startR) * t;
    zone.radius = radius;
    if (t >= 1) {
        zone.shrinking = false;
        zone.shrinkStartAt = null;
    }
    return { cx: zone.cx, cy: zone.cy, radius, shrinking: t < 1 };
}

function sandboxEntityPosition(entity, mode) {
    if (mode === 'slither') {
        const head = entity?.segments?.[0];
        return head ? { x: head.x, y: head.y, radius: head.radius || 10 } : null;
    }
    const cell = entity?.cells?.[0];
    if (cell) return { x: cell.x, y: cell.y, radius: cell.radius || 10 };
    if (Number.isFinite(entity?.x) && Number.isFinite(entity?.y)) {
        return { x: entity.x, y: entity.y, radius: 10 };
    }
    return null;
}

function applySandboxZoneDamage(room, io, dtSeconds) {
    const zone = getSandboxZone(room);
    if (!zone) return;
    room.sandboxVitalsTick = (room.sandboxVitalsTick || 0) + 1;
    const shouldBroadcastVitals = room.sandboxVitalsTick % 5 === 0;
    const eliminated = new Set();
    const groups = room.mode === 'slither'
        ? [room.players, room.slitherBots]
        : [room.players, room.bots];

    for (const group of groups) {
        for (const entity of group) {
            if (entity.disconnected) continue;
            const pos = sandboxEntityPosition(entity, room.mode);
            if (!pos) continue;
            const distance = Math.hypot(pos.x - zone.cx, pos.y - zone.cy);
            const outside = distance + Math.max(0, pos.radius * 0.25) > zone.radius;
            const currentHealth = Number.isFinite(entity.sandboxZoneHealth)
                ? entity.sandboxZoneHealth
                : 100;
            entity.sandboxZoneHealth = Math.max(0, Math.min(100,
                currentHealth + (outside
                    ? -SANDBOX_ZONE_DAMAGE_PER_SECOND * dtSeconds
                    : SANDBOX_ZONE_HEAL_PER_SECOND * dtSeconds)
            ));
            entity.sandboxOutsideZone = outside;

            if (shouldBroadcastVitals && !entity.isBot && !String(entity.id || '').startsWith('bot_')) {
                io.to(entity.id).emit('sandboxVitals', {
                    zoneHealth: entity.sandboxZoneHealth,
                    outsideZone: outside,
                });
            }
            if (entity.sandboxZoneHealth <= 0) eliminated.add(entity);
        }
    }

    if (eliminated.size === 0) return;
    for (const entity of eliminated) {
        if (!entity.isBot && !String(entity.id || '').startsWith('bot_')) {
            io.to(entity.id).emit('sandboxEliminated', {
                reason: 'zone',
                message: 'Eliminated by the zone',
            });
        }
    }
    room.players = room.players.filter(entity => !eliminated.has(entity));
    room.bots = room.bots.filter(entity => !eliminated.has(entity));
    room.slitherBots = room.slitherBots.filter(entity => !eliminated.has(entity));
}

export function getSandboxStatus() {
    const result = {};
    for (const key of ['agar', 'slither']) {
        const room = sandboxRooms[key];
        if (!room) {
            result[key] = { active: false };
            continue;
        }
        result[key] = {
            active: true,
            paused: room.sandboxPaused,
            speedMultiplier: room.sandboxSpeedMultiplier,
            botAi: room.sandboxBotAi,
            invincible: room.sandboxInvincible,
            worldHalf: room.sandboxWorldHalf,
            zone: getSandboxZone(room),
            players: room.players.filter(p => !p.disconnected).length,
            bots: key === 'slither' ? room.slitherBots.length : room.bots.length,
            staticWorms: room.sandboxStaticWorms?.length ?? 0,
            staticWormIds: (room.sandboxStaticWorms || []).map(w => {
                const head = w.segments?.[0];
                return {
                    id: w.id,
                    name: w.username,
                    balance: w.balance,
                    x: head?.x,
                    y: head?.y,
                    angle: w.angle ?? 0,
                    bend: w.bend ?? 0,
                };
            }),
            controllableEntities: key === 'slither' ? buildControllableEntities(room) : [],
            food: key === 'slither' ? room.slitherFood.length : room.food.length,
        };
    }
    return result;
}

async function verifyAdminToken(token, User, jwtSecret) {
    if (!token) return null;
    const decoded = jwt.verify(token, jwtSecret);
    const user = await User.findById(decoded.id);
    if (!user || user.username !== process.env.ADMIN_USERNAME) return null;
    return user;
}

function setSnakeBalance(snake, balance, angle = snake.angle ?? 0, bend = snake.bend ?? 0) {
    const head = snake.segments?.[0];
    const x = head?.x ?? 0;
    const y = head?.y ?? 0;
    snake.balance = Math.max(0.5, balance);
    snake.segments = createSegments(x, y, snake.balance, angle, bend);
    snake.angle = angle;
    snake.bend = bend;
    snake.fam = 0;
    if (snake.dollarBalance != null) snake.dollarBalance = snake.balance;
}

function copySnakeBodyTo(target, source) {
    target.segments = (source.segments || []).map(s => ({ x: s.x, y: s.y }));
    target.balance = source.balance;
    target.dollarBalance = source.dollarBalance ?? source.balance;
    if (source.color) target.color = source.color;
    target.angle = source.angle ?? 0;
    target.bend = source.bend ?? 0;
    target.fam = source.fam ?? 0;
    target.inputDx = Math.cos(target.angle);
    target.inputDy = Math.sin(target.angle);
    target.boost = false;
    const head = target.segments[0];
    if (head) {
        target.x = head.x;
        target.y = head.y;
    }
    if (target.cells?.[0] && head) {
        target.cells[0].x = head.x;
        target.cells[0].y = head.y;
        target.cells[0].balance = target.balance;
    }
}

function playerToStaticWorm(player) {
    const head = player.segments?.[0];
    return createStaticWorm(null, {
        x: head?.x ?? 0,
        y: head?.y ?? 0,
        balance: player.dollarBalance ?? player.balance,
        angle: player.angle ?? 0,
        bend: player.bend ?? 0,
        color: player.color,
        name: `${player.username} (parked)`,
    });
}

function buildControllableEntities(room) {
    const statics = (room.sandboxStaticWorms || []).map(w => {
        const head = w.segments?.[0];
        return {
            id: w.id,
            name: w.username,
            balance: w.balance,
            type: 'static',
            x: head?.x,
            y: head?.y,
            angle: w.angle ?? 0,
            bend: w.bend ?? 0,
        };
    });
    const bots = (room.slitherBots || []).map(b => {
        const head = b.segments?.[0];
        return {
            id: b.id,
            name: b.username,
            balance: b.dollarBalance ?? b.balance,
            type: 'bot',
            x: head?.x,
            y: head?.y,
            angle: b.angle ?? 0,
            bend: b.bend ?? 0,
        };
    });
    return [...statics, ...bots];
}

function createStaticWorm(room, opts = {}) {
    const x = opts.x ?? 0;
    const y = opts.y ?? 0;
    const balance = opts.balance ?? 5;
    const angle = opts.angle ?? 0;
    const bend = opts.bend ?? 0;
    const color = opts.color ?? util.randomSlitherColor();
    return {
        id: 'static_' + Math.random().toString(36).slice(2, 8),
        username: opts.name ?? 'Static Worm',
        isBot: false,
        isStatic: true,
        frozen: true,
        balance,
        dollarBalance: balance,
        color,
        angle,
        bend,
        fam: 0,
        segments: createSegments(x, y, balance, angle, bend),
        boost: false,
    };
}

function findSandboxEntity(room, entityId) {
    if (!entityId) return null;
    const modes = room.mode === 'slither'
        ? [room.players, room.slitherBots, room.sandboxStaticWorms]
        : [room.players, room.bots];
    for (const list of modes) {
        const found = list.find(e => e.id === entityId);
        if (found) return found;
    }
    return null;
}

export function applySandboxAction(mode, action, params = {}) {
    const room = getSandboxRoom(mode);
    const zone = room.sandboxZone;

    switch (action) {
        case 'pause':
            room.sandboxPaused = !!params.paused;
            return { paused: room.sandboxPaused };

        case 'setSpeed':
            room.sandboxSpeedMultiplier = Math.max(0.1, Math.min(5, Number(params.multiplier) || 1));
            return { speedMultiplier: room.sandboxSpeedMultiplier };

        case 'setBotAi':
            room.sandboxBotAi = !!params.enabled;
            return { botAi: room.sandboxBotAi };

        case 'setInvincible':
            room.sandboxInvincible = params.enabled !== false;
            return { invincible: room.sandboxInvincible };

        case 'setWorldSize': {
            const half = Math.max(500, Math.min(5000, Number(params.worldHalf) || room.sandboxWorldHalf));
            room.sandboxWorldHalf = half;
            if (zone) {
                zone.radius = half;
                zone.startRadius = half;
                zone.endRadius = Math.max(200, half * 0.15);
                zone.shrinking = false;
                zone.shrinkStartAt = null;
            }
            return { worldHalf: half };
        }

        case 'setZoneRadius': {
            const r = Math.max(100, Math.min(room.sandboxWorldHalf, Number(params.radius) || zone?.radius || 3000));
            if (zone) {
                zone.radius = r;
                zone.startRadius = r;
                zone.shrinking = false;
                zone.shrinkStartAt = null;
            }
            return { zone: getSandboxZone(room) };
        }

        case 'startZoneShrink': {
            if (!zone) break;
            zone.shrinking = true;
            zone.shrinkStartAt = Date.now();
            zone.startRadius = zone.radius;
            zone.endRadius = Math.max(100, Number(params.endRadius) || zone.endRadius);
            zone.shrinkDurationMs = Math.max(5000, Number(params.durationMs) || zone.shrinkDurationMs);
            return { zone: getSandboxZone(room) };
        }

        case 'stopZoneShrink':
            if (zone) {
                zone.shrinking = false;
                zone.shrinkStartAt = null;
            }
            return { zone: getSandboxZone(room) };

        case 'spawnBots': {
            const count = Math.max(1, Math.min(MAX_SANDBOX_BOTS_PER_SPAWN, Number(params.count) || 3));
            const stake = Number(params.balance) || 5;
            if (room.mode === 'slither') {
                const roomCap = Math.max(0, MAX_SANDBOX_BOTS - room.slitherBots.length);
                const spawnCount = Math.min(count, roomCap);
                for (let i = 0; i < spawnCount; i++) {
                    const bot = createSlitherBot(room, stake);
                    if (params.balance) setSnakeBalance(bot, stake);
                    room.slitherBots.push(bot);
                }
                return { spawned: spawnCount, mode: room.mode, capped: spawnCount < count };
            } else {
                room.aiBudgetBalance = SANDBOX_POOL;
                // addBots is injected via deps in setup — use direct spawn
                for (let i = 0; i < count; i++) {
                    room.slitherBots; // noop — agar uses deps.addBots in handler
                }
            }
            return { spawned: count, mode: room.mode, needsAgarDeps: room.mode === 'agar' };
        }

        case 'spawnFood': {
            const count = Math.max(1, Math.min(500, Number(params.count) || 50));
            const eco = getEconomy(DEFAULT_ENTRY_FEE);
            if (room.mode === 'slither') {
                room.foodPoolBalance = SANDBOX_POOL;
                for (let i = 0; i < count; i++) {
                    const { x, y } = randomCoordInRoom(room);
                    room.slitherFood.push({
                        id: Math.random().toString(36).slice(2, 9),
                        x,
                        y,
                        hue: Math.floor(Math.random() * 360),
                        radius: SLITHER.foodRadius,
                        balance: eco.massPerPellet,
                        dollarValue: eco.foodBlobValue,
                    });
                }
                trimSlitherFood(room, MAX_SANDBOX_FOOD);
            } else {
                const zone = room.sandboxZone;
                for (let i = 0; i < count; i++) {
                    let x;
                    let y;
                    if (zone?.radius) {
                        const maxR = zone.radius * 0.82;
                        const ang = Math.random() * Math.PI * 2;
                        const r = Math.sqrt(Math.random()) * maxR;
                        x = (zone.cx ?? 0) + Math.cos(ang) * r;
                        y = (zone.cy ?? 0) + Math.sin(ang) * r;
                    } else {
                        const w = room.sandboxWorldHalf * 2;
                        x = Math.random() * w;
                        y = Math.random() * w;
                    }
                    room.food.push({
                        id: Math.random().toString(36).slice(2, 9),
                        x,
                        y,
                        hue: Math.floor(Math.random() * 360),
                        radius: 5,
                        balance: eco.massPerPellet,
                        dollarValue: eco.foodBlobValue,
                    });
                }
            }
            return { foodCount: room.mode === 'slither' ? room.slitherFood.length : room.food.length };
        }

        case 'addStaticWorm': {
            if ((room.sandboxStaticWorms?.length ?? 0) >= MAX_SANDBOX_STATIC_WORMS) {
                return { error: `Max ${MAX_SANDBOX_STATIC_WORMS} static worms` };
            }
            const spawnParams = { ...params };
            if (params.bend != null) spawnParams.bend = Number(params.bend);
            const human = room.players.find(p => !p.disconnected && p.segments?.[0]);
            if (human && params.useCustomPosition !== true) {
                const head = human.segments[0];
                const a = params.angle != null ? Number(params.angle) : (human.angle ?? 0);
                const dist = 55 + (Number(params.balance) || 5) * 4;
                spawnParams.x = head.x + Math.cos(a + Math.PI / 2) * dist;
                spawnParams.y = head.y + Math.sin(a + Math.PI / 2) * dist;
                spawnParams.angle = a;
            }
            const worm = createStaticWorm(room, spawnParams);
            room.sandboxStaticWorms.push(worm);
            const wHead = worm.segments[0];
            return {
                id: worm.id,
                staticWorms: room.sandboxStaticWorms.length,
                x: wHead?.x,
                y: wHead?.y,
                angle: worm.angle,
                bend: worm.bend ?? 0,
            };
        }

        case 'moveStaticWorm': {
            const worm = room.sandboxStaticWorms.find(w => w.id === params.id);
            if (!worm) return { error: 'Worm not found' };
            if (params.x != null || params.y != null) {
                const head = worm.segments[0];
                const dx = (params.x ?? head.x) - head.x;
                const dy = (params.y ?? head.y) - head.y;
                for (const seg of worm.segments) {
                    seg.x += dx;
                    seg.y += dy;
                }
            }
            if (params.angle != null || params.bend != null || params.balance != null) {
                const angle = params.angle != null ? Number(params.angle) : (worm.angle ?? 0);
                const bend = params.bend != null ? Number(params.bend) : (worm.bend ?? 0);
                const balance = params.balance != null ? Number(params.balance) : worm.balance;
                setSnakeBalance(worm, balance, angle, bend);
            }
            return { id: worm.id };
        }

        case 'possessEntity': {
            if (room.mode !== 'slither') return { error: 'Slither only' };
            const socketId = params.socketId;
            const player = room.players.find(p => p.id === socketId && !p.disconnected);
            if (!player) return { error: 'Player not found' };
            const target = findSandboxEntity(room, params.id);
            if (!target || target.id === player.id) return { error: 'Invalid target' };

            let parkedId = null;
            if (params.leaveBody !== false) {
                const parked = playerToStaticWorm(player);
                room.sandboxStaticWorms.push(parked);
                parkedId = parked.id;
            }

            room.sandboxStaticWorms = room.sandboxStaticWorms.filter(w => w.id !== target.id);
            room.slitherBots = room.slitherBots.filter(b => b.id !== target.id);

            copySnakeBodyTo(player, target);
            player.frozen = false;
            player.isStatic = false;
            player.isBot = false;

            return { possessedId: params.id, parkedId, playerId: player.id };
        }

        case 'removeStaticWorm': {
            const id = params.id;
            room.sandboxStaticWorms = room.sandboxStaticWorms.filter(w => w.id !== id);
            return { removed: id };
        }

        case 'setEntitySize': {
            let entity = findSandboxEntity(room, params.id);
            if (!entity && room.players.length) {
                entity = room.players.find(p => !p.disconnected) || room.players[0];
            }
            if (!entity) return { error: 'Entity not found' };
            const size = Math.max(0.5, Number(params.balance) || 5);
            if (room.mode === 'slither' && entity.segments) {
                setSnakeBalance(entity, size, params.angle ?? entity.angle, params.bend ?? entity.bend ?? 0);
            } else if (entity.cells?.[0]) {
                entity.balance = size;
                entity.dollarBalance = size;
                for (const cell of entity.cells) {
                    cell.balance = size / entity.cells.length;
                }
            }
            return { id: entity.id, balance: size };
        }

        case 'clearEntities':
            room.bots = [];
            room.slitherBots = [];
            room.sandboxStaticWorms = [];
            room.food = [];
            room.slitherFood = [];
            room.ejected = [];
            room.foodPoolBalance = SANDBOX_POOL;
            room.aiBudgetBalance = SANDBOX_POOL;
            room.sandboxZone = defaultZone(room.sandboxWorldHalf, room.mode);
            for (const player of room.players) {
                player.sandboxZoneHealth = 100;
                player.sandboxOutsideZone = false;
            }
            return { clearedEntities: true };

        case 'clear':
            room.players = [];
            room.bots = [];
            room.slitherBots = [];
            room.sandboxStaticWorms = [];
            room.food = [];
            room.slitherFood = [];
            room.ejected = [];
            room.foodPoolBalance = SANDBOX_POOL;
            room.aiBudgetBalance = SANDBOX_POOL;
            room.sandboxPaused = false;
            room.sandboxZone = defaultZone(room.sandboxWorldHalf, room.mode);
            return { cleared: true };

        case 'removeEntity': {
            const id = params.id;
            room.players = room.players.filter(p => p.id !== id);
            room.bots = room.bots.filter(b => b.id !== id);
            room.slitherBots = room.slitherBots.filter(b => b.id !== id);
            room.sandboxStaticWorms = room.sandboxStaticWorms.filter(w => w.id !== id);
            return { removed: id };
        }

        default:
            return { error: `Unknown action: ${action}` };
    }
}

function buildSlitherMeta(room) {
    const zone = getSandboxZone(room);
    return {
        sandbox: true,
        zone,
        competitiveSlither: !!zone,
        circularMap: !!zone,
        worldHalf: room.sandboxWorldHalf,
        solPrice: 57,
        isResetting: false,
        battleRoyale: false,
    };
}

function buildStaticLeaderboard(room) {
  return [];
}

export function setupSandbox(io, deps) {
    const {
        User,
        Transaction,
        c,
        util: utilDeps,
        QuadTree,
        Rectangle,
        Point,
        calculateCellRadius,
        addBots,
        addViruses,
        rebuildQuadTree,
        processRoom,
        DEFAULT_ENTRY_FEE: entryFee,
    } = deps;

    // Init quadtree for agar sandbox
    const agarRoom = getSandboxRoom('agar');
    initAgarSandboxRoom(agarRoom, { QuadTree, Rectangle, c, addViruses });

    io.on('connection', (socket) => {
        socket.on('sandboxJoin', async ({ token, mode, username }) => {
            const requestedMode = mode === 'slither' ? 'slither' : 'agar';
            try {
                const user = await verifyAdminToken(token, User, deps.JWT_SECRET);
                if (!user) {
                    socket.emit('error', 'Admin access required for sandbox');
                    return;
                }

                const gameMode = mode === 'slither' ? 'slither' : 'agar';
                const room = getSandboxRoom(gameMode);

                const existingPlayer = room.players.find(
                    p => p.mongoId?.toString() === user._id.toString()
                );

                socket.sandboxMode = gameMode;
                socket.roomId = room.id;

                if (existingPlayer) {
                    existingPlayer.id = socket.id;
                    existingPlayer.disconnected = false;
                    existingPlayer.sandboxReconnectUntil = null;
                    existingPlayer.sandboxZoneHealth = Math.max(1, existingPlayer.sandboxZoneHealth ?? 100);
                    const zone = getSandboxZone(room);
                    const reconnectMeta = gameMode === 'slither'
                        ? {
                            width: room.sandboxWorldHalf * 2,
                            height: room.sandboxWorldHalf * 2,
                            mode: 'slither',
                            sandbox: true,
                            reconnected: true,
                            entryFeeUsd: entryFee,
                            zone,
                            competitiveSlither: true,
                            circularMap: true,
                        }
                        : {
                            width: c.worldWidth,
                            height: c.worldHeight,
                            mode: 'agar',
                            sandbox: true,
                            reconnected: true,
                            entryFeeUsd: entryFee,
                            zone,
                        };
                    socket.emit('welcome', existingPlayer, reconnectMeta);
                    socket.emit('sandboxState', {
                        ...getSandboxStatus()[gameMode],
                        reconnected: true,
                    });
                    return;
                }

                const eco = getEconomy(entryFee);
                let player;

                if (gameMode === 'slither') {
                    player = createSlitherPlayer(
                        socket.id,
                        user._id,
                        username || user.username,
                        utilDeps.randomSlitherColor(),
                        room,
                        eco.massStartBalance,
                        eco.playerStartBalance,
                    );
                    player.mode = 'slither';
                    player.spawnGraceUntil = Date.now() + 999999999;
                } else {
                    const spawnX = c.worldWidth / 2;
                    const spawnY = c.worldHeight / 2;
                    const startMass = eco.massStartBalance;
                    const startDollars = eco.playerStartBalance;
                    player = {
                        id: socket.id,
                        mongoId: user._id,
                        username: username || user.username,
                        mode: 'agar',
                        entryFeeUsd: entryFee,
                        kills: 0,
                        balance: startDollars,
                        dollarBalance: startDollars,
                        startTime: Date.now(),
                        color: utilDeps.randomColor(),
                        x: spawnX,
                        y: spawnY,
                        mouseX: 0,
                        mouseY: 0,
                        screenWidth: 1920,
                        screenHeight: 1080,
                        cells: [{
                            id: Math.random().toString(36).slice(2, 9),
                            x: spawnX,
                            y: spawnY,
                            balance: startMass,
                            radius: calculateCellRadius(startMass, startMass, 1, startMass),
                            vx: 0,
                            vy: 0,
                            lastSplit: Date.now(),
                        }],
                    };
                }

                room.players.push(player);

                const zone = getSandboxZone(room);
                const welcomeMeta = gameMode === 'slither'
                    ? {
                        width: room.sandboxWorldHalf * 2,
                        height: room.sandboxWorldHalf * 2,
                        mode: 'slither',
                        sandbox: true,
                        entryFeeUsd: entryFee,
                        zone,
                        competitiveSlither: true,
                        circularMap: true,
                    }
                    : {
                        width: c.worldWidth,
                        height: c.worldHeight,
                        mode: 'agar',
                        sandbox: true,
                        entryFeeUsd: entryFee,
                        zone,
                    };

                socket.emit('welcome', player, welcomeMeta);
                socket.emit('sandboxState', getSandboxStatus()[gameMode]);
            } catch (err) {
                if (recoverSandboxStackOverflow(requestedMode, err, socket, deps)) return;
                console.error('[Sandbox] Join failed:', err?.stack || err);
                socket.emit('error', err.message || 'Sandbox join failed');
            }
        });

        socket.on('sandboxControl', async ({ token, mode, action, params }) => {
            const requestedMode = mode === 'slither' ? 'slither' : 'agar';
            try {
                const user = await verifyAdminToken(token, User, deps.JWT_SECRET);
                if (!user) {
                    socket.emit('error', 'Admin access required');
                    return;
                }

                const gameMode = mode === 'slither' ? 'slither' : 'agar';
                const room = getSandboxRoom(gameMode);

                if (action === 'spawnBots') {
                    const count = Math.max(1, Math.min(MAX_SANDBOX_BOTS_PER_SPAWN, Number(params?.count) || 3));
                    const stake = Number(params?.balance) || 5;
                    if (gameMode === 'slither') {
                        room.aiBudgetBalance = SANDBOX_POOL;
                        const roomCap = Math.max(0, MAX_SANDBOX_BOTS - room.slitherBots.length);
                        addSlitherBots(room, Math.min(count, roomCap), stake);
                    } else {
                        room.aiBudgetBalance = SANDBOX_POOL;
                        const botNames = ['Sirius', 'Gota', 'AgarioMaster', 'ProPlayer', 'Legit', 'Sanic'];
                        const eco = getEconomy(entryFee);
                        const startMass = eco.massStartBalance;
                        const spawnCount = Math.min(count, Math.floor(room.aiBudgetBalance / stake));
                        for (let i = 0; i < spawnCount; i++) {
                            const zone = room.sandboxZone;
                            let x;
                            let y;
                            if (zone?.radius) {
                                const maxR = zone.radius * 0.82;
                                const ang = Math.random() * Math.PI * 2;
                                const r = Math.sqrt(Math.random()) * maxR;
                                x = (zone.cx ?? 0) + Math.cos(ang) * r;
                                y = (zone.cy ?? 0) + Math.sin(ang) * r;
                            } else {
                                x = Math.random() * c.worldWidth;
                                y = Math.random() * c.worldHeight;
                            }
                            room.aiBudgetBalance -= stake;
                            room.bots.push({
                                id: 'bot_' + Math.random().toString(36).slice(2, 7),
                                username: botNames[Math.floor(Math.random() * botNames.length)] + ' [' + utilDeps.randomInRange(10, 99) + ']',
                                balance: stake,
                                dollarBalance: stake,
                                botStake: stake,
                                kills: 0,
                                color: utilDeps.randomColor(),
                                isBot: true,
                                targetX: x,
                                targetY: y,
                                lastTargetUpdate: 0,
                                cells: [{
                                    id: Math.random().toString(36).slice(2, 9),
                                    x,
                                    y,
                                    balance: startMass,
                                    radius: calculateCellRadius(startMass, startMass, 1, startMass),
                                    vx: 0,
                                    vy: 0,
                                    lastSplit: Date.now(),
                                }],
                            });
                        }
                    }
                    socket.emit('sandboxState', { ...getSandboxStatus()[gameMode], lastAction: 'spawnBots' });
                    return;
                }

                if (action === 'abort') {
                    abortAllSandbox(io, { QuadTree, Rectangle, c, addViruses });
                    socket.sandboxMode = null;
                    socket.roomId = null;
                    socket.emit('sandboxAborted');
                    socket.emit('sandboxState', { ...getSandboxStatus()[gameMode], lastAction: 'abort' });
                    return;
                }

                const result = applySandboxAction(gameMode, action, {
                    ...params,
                    ...(action === 'possessEntity' ? { socketId: socket.id } : {}),
                });
                socket.emit('sandboxState', { ...getSandboxStatus()[gameMode], lastAction: action, result });
            } catch (err) {
                if (recoverSandboxStackOverflow(requestedMode, err, socket, deps)) return;
                console.error('[Sandbox] Control failed:', err?.stack || err);
                socket.emit('error', err.message || 'Sandbox control failed');
            }
        });

        socket.on('sandboxMoveStatic', async ({ token, id, x, y }) => {
            try {
                const user = await verifyAdminToken(token, User, deps.JWT_SECRET);
                if (!user) return;
                const room = getSandboxRoom('slither');
                applySandboxAction('slither', 'moveStaticWorm', { id, x, y });
            } catch { /* ignore */ }
        });

        socket.on('disconnect', () => {
            if (!socket.sandboxMode) return;
            const room = getSandboxRoom(socket.sandboxMode);
            const player = room.players.find(p => p.id === socket.id);
            if (!player) return;

            player.disconnected = true;
            player.sandboxReconnectUntil = Date.now() + SANDBOX_RECONNECT_GRACE_MS;
            const mongoId = player.mongoId?.toString();

            setTimeout(() => {
                const currentRoom = getSandboxRoom(socket.sandboxMode);
                const stale = currentRoom.players.find(
                    p => p.mongoId?.toString() === mongoId
                );
                if (!stale?.disconnected || Date.now() < (stale.sandboxReconnectUntil || 0)) return;
                currentRoom.players = currentRoom.players.filter(p => p !== stale);

                if (!currentRoom.players.some(p => !p.disconnected)) {
                    currentRoom.slitherBots = [];
                    currentRoom.bots = [];
                    currentRoom.slitherFood = [];
                    currentRoom.food = [];
                    currentRoom.sandboxStaticWorms = [];
                    currentRoom.ejected = [];
                    currentRoom.sandboxPaused = false;
                }
            }, SANDBOX_RECONNECT_GRACE_MS + 250);
        });
    });

    // Sandbox physics stays responsive while network snapshots are throttled.
    let sandboxTickCounter = 0;
    setInterval(() => {
        sandboxTickCounter += 1;
        const now = Date.now();
        for (const key of ['agar', 'slither']) {
            const room = sandboxRooms[key];
            if (!room || !room.players.some(p => !p.disconnected)) continue;

            const dtSeconds = Math.min(0.1, Math.max(0.001, (now - (room.sandboxLastTickAt || now)) / 1000));
            room.sandboxLastTickAt = now;
            applySandboxZoneDamage(room, io, dtSeconds);

            if (key === 'slither') {
                let lb = buildStaticLeaderboard(room);
                if (!room.sandboxPaused) {
                    lb = processSlitherRoom(room, io, User, null);
                } else if (sandboxTickCounter % SANDBOX_PAUSED_BROADCAST_INTERVAL !== 0) {
                    continue;
                }
                if (sandboxTickCounter % SANDBOX_NETWORK_TICK_DIVISOR === 0 || room.sandboxPaused) {
                    broadcastSlitherState(room, io, lb, buildSlitherMeta(room));
                }
            } else {
                getSandboxZone(room);
                if (!room.sandboxPaused) {
                    processRoom(room);
                } else if (sandboxTickCounter % SANDBOX_PAUSED_BROADCAST_INTERVAL === 0) {
                    broadcastSandboxAgar(room, io, deps);
                }
            }
        }
    }, 1000 / SANDBOX_TICK_RATE);
}

function broadcastSandboxAgar(room, io, deps) {
    const { rebuildQuadTree, Rectangle } = deps;
    const allUsers = [
        ...room.players.filter(p => p.mode !== 'slither' && !p.disconnected),
        ...room.bots,
    ];
    rebuildQuadTree(room, allUsers);
    const userMap = new Map(allUsers.map(u => [u.id, u]));

    room.players.forEach(p => {
        if (p.mode === 'slither' || p.disconnected) return;
        const pad = 500;
        const foodPad = 720;
        const rangeX = (p.screenWidth || 1920) / 2 + pad;
        const rangeY = (p.screenHeight || 1080) / 2 + pad;
        const viewRange = new Rectangle(p.x, p.y, rangeX, rangeY);
        const foodRange = new Rectangle(p.x, p.y, rangeX + foodPad, rangeY + foodPad);
        const visibleItems = room.qt.query(viewRange);
        const foodItems = room.qt.query(foodRange);
        const visibleFood = [];
        const visibleViruses = [];
        const visibleEjected = [];
        const visibleUsersSet = new Set([p]);
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
        io.to(p.id).emit('serverTellPlayerMove', p, Array.from(visibleUsersSet), visibleFood, visibleEjected, visibleViruses, {
            sandbox: true,
            zone: getSandboxZone(room),
        });
    });
}
