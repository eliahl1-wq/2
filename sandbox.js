/**
 * Admin sandbox — isolated rooms for filming gamemode previews.
 * No economy, no global reset, full manual control.
 */
import jwt from 'jsonwebtoken';
import {
    SLITHER,
    createSlitherPlayer,
    createSegments,
    addSlitherBots,
    createSlitherBot,
    processSlitherRoom,
    broadcastSlitherState,
} from './slither-engine.js';
import { DEFAULT_ENTRY_FEE, getEconomy } from './economy.js';
import * as util from './utils.js';

const SANDBOX_POOL = 1_000_000;

function defaultZone(worldHalf) {
    return {
        cx: 0,
        cy: 0,
        radius: worldHalf,
        shrinking: false,
        shrinkStartAt: null,
        shrinkDurationMs: 120_000,
        startRadius: worldHalf,
        endRadius: Math.max(200, worldHalf * 0.15),
    };
}

function createSandboxRoom(mode) {
    const worldHalf = mode === 'slither' ? SLITHER.worldHalf : 3000;
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
        sandboxZone: defaultZone(worldHalf),
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
    return { cx: zone.cx, cy: zone.cy, radius, shrinking: t < 1 };
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
            players: room.players.length,
            bots: key === 'slither' ? room.slitherBots.length : room.bots.length,
            staticWorms: room.sandboxStaticWorms?.length ?? 0,
            staticWormIds: (room.sandboxStaticWorms || []).map(w => ({ id: w.id, name: w.username, balance: w.balance })),
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

function setSnakeBalance(snake, balance, angle = snake.angle ?? 0) {
    const head = snake.segments?.[0];
    const x = head?.x ?? 0;
    const y = head?.y ?? 0;
    snake.balance = Math.max(0.5, balance);
    snake.segments = createSegments(x, y, snake.balance, angle);
    snake.angle = angle;
    snake.fam = 0;
    if (snake.dollarBalance != null) snake.dollarBalance = snake.balance;
}

function createStaticWorm(room, opts = {}) {
    const x = opts.x ?? 0;
    const y = opts.y ?? 0;
    const balance = opts.balance ?? 5;
    const angle = opts.angle ?? 0;
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
        fam: 0,
        segments: createSegments(x, y, balance, angle),
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
            const count = Math.max(1, Math.min(30, Number(params.count) || 3));
            const stake = Number(params.balance) || 5;
            if (room.mode === 'slither') {
                for (let i = 0; i < count; i++) {
                    const bot = createSlitherBot(room, stake);
                    if (params.balance) setSnakeBalance(bot, stake);
                    room.slitherBots.push(bot);
                }
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
                    const h = room.sandboxWorldHalf * 0.9;
                    room.slitherFood.push({
                        id: Math.random().toString(36).slice(2, 9),
                        x: (Math.random() - 0.5) * 2 * h,
                        y: (Math.random() - 0.5) * 2 * h,
                        hue: Math.floor(Math.random() * 360),
                        radius: SLITHER.foodRadius,
                        balance: eco.massPerPellet,
                        dollarValue: eco.foodBlobValue,
                    });
                }
            } else {
                for (let i = 0; i < count; i++) {
                    const w = room.sandboxWorldHalf * 2;
                    room.food.push({
                        id: Math.random().toString(36).slice(2, 9),
                        x: Math.random() * w,
                        y: Math.random() * w,
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
            const worm = createStaticWorm(room, params);
            room.sandboxStaticWorms.push(worm);
            return { id: worm.id, staticWorms: room.sandboxStaticWorms.length };
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
            if (params.angle != null) {
                setSnakeBalance(worm, worm.balance, params.angle);
            }
            return { id: worm.id };
        }

        case 'setEntitySize': {
            let entity = findSandboxEntity(room, params.id);
            if (!entity && room.players.length) {
                entity = room.players.find(p => !p.disconnected) || room.players[0];
            }
            if (!entity) return { error: 'Entity not found' };
            const size = Math.max(0.5, Number(params.balance) || 5);
            if (room.mode === 'slither' && entity.segments) {
                setSnakeBalance(entity, size, params.angle ?? entity.angle);
            } else if (entity.cells?.[0]) {
                entity.balance = size;
                entity.dollarBalance = size;
                for (const cell of entity.cells) {
                    cell.balance = size / entity.cells.length;
                }
            }
            return { id: entity.id, balance: size };
        }

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
            room.sandboxZone = defaultZone(room.sandboxWorldHalf);
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
            try {
                const user = await verifyAdminToken(token, User, deps.JWT_SECRET);
                if (!user) {
                    socket.emit('error', 'Admin access required for sandbox');
                    return;
                }

                const gameMode = mode === 'slither' ? 'slither' : 'agar';
                const room = getSandboxRoom(gameMode);

                // Remove existing player with same mongo id
                room.players = room.players.filter(p => p.mongoId?.toString() !== user._id.toString());

                socket.sandboxMode = gameMode;
                socket.roomId = room.id;

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
                socket.emit('error', err.message || 'Sandbox join failed');
            }
        });

        socket.on('sandboxControl', async ({ token, mode, action, params }) => {
            try {
                const user = await verifyAdminToken(token, User, deps.JWT_SECRET);
                if (!user) {
                    socket.emit('error', 'Admin access required');
                    return;
                }

                const gameMode = mode === 'slither' ? 'slither' : 'agar';
                const room = getSandboxRoom(gameMode);

                if (action === 'spawnBots') {
                    const count = Math.max(1, Math.min(30, Number(params?.count) || 3));
                    const stake = Number(params?.balance) || 5;
                    if (gameMode === 'slither') {
                        room.aiBudgetBalance = SANDBOX_POOL;
                        addSlitherBots(room, count, stake);
                    } else {
                        room.aiBudgetBalance = SANDBOX_POOL;
                        addBots(room, count, stake);
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

                const result = applySandboxAction(gameMode, action, params);
                socket.emit('sandboxState', { ...getSandboxStatus()[gameMode], lastAction: action, result });
            } catch (err) {
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
            room.players = room.players.filter(p => p.id !== socket.id);
        });
    });

    // Sandbox tick — runs alongside main loop
    setInterval(() => {
        for (const key of ['agar', 'slither']) {
            const room = sandboxRooms[key];
            if (!room || room.players.length === 0) continue;

            const zone = getSandboxZone(room);

            if (key === 'slither') {
                let lb = buildStaticLeaderboard(room);
                if (!room.sandboxPaused) {
                    lb = processSlitherRoom(room, io, User, null);
                }
                broadcastSlitherState(room, io, lb, buildSlitherMeta(room));
            } else {
                getSandboxZone(room);
                if (!room.sandboxPaused) {
                    processRoom(room);
                } else {
                    broadcastSandboxAgar(room, io, deps);
                }
            }
        }
    }, 1000 / 40);
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
