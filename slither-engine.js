import * as util from './utils.js';

export const SLITHER = {
    worldHalf: 1000,
    baseSpeed: 2.0,
    maxInput: 4,
    boostMultiplier: 1.75,
    boostCostPerTick: 0.00015,
    headRadius: 10,
    foodRadius: 5,
    segmentSpacing: 7,
    baseSegments: 40,
    segmentsPerCent: 0.15,
    foodBlobValue: 0.01,
    botStartBalance: 1.0,
    botMaxBalance: 500.0,
    viewRange: 900,
    selfCollisionSkip: 8,
};

const BOT_NAMES = [
    'Sirius', 'Gota', 'SnakeMaster', 'ProSlither', 'Legit', 'Sanic',
    'Wojak', 'Pepe', 'Doge', 'Viper', 'Cobra', 'Python', 'Anaconda',
];

function randId() {
    return Math.random().toString(36).substr(2, 9);
}

function dist(x1, y1, x2, y2) {
    return Math.hypot(x1 - x2, y1 - y2);
}

export function balanceToSegmentCount(balance) {
    const cents = Math.max(0, (balance - 1.0) * 100);
    return Math.min(500, Math.round(SLITHER.baseSegments + cents * SLITHER.segmentsPerCent));
}

export function createSegments(x, y, balance, angle = 0) {
    const count = balanceToSegmentCount(balance);
    const segs = [];
    for (let i = 0; i < count; i++) {
        segs.push({
            x: x - Math.cos(angle) * i * SLITHER.segmentSpacing,
            y: y - Math.sin(angle) * i * SLITHER.segmentSpacing,
        });
    }
    return segs;
}

function isSpawnClear(room, x, y, minDist = 100) {
    for (const { entity: s } of getAllSlitherSnakes(room)) {
        const h = s.segments?.[0];
        if (h && dist(x, y, h.x, h.y) < minDist) return false;
    }
    return true;
}

function pickSlitherSpawn(room) {
    for (let i = 0; i < 30; i++) {
        const x = randomSpawnCoord();
        const y = randomSpawnCoord();
        if (isSpawnClear(room, x, y)) return { x, y };
    }
    return { x: randomSpawnCoord(), y: randomSpawnCoord() };
}

export function headRadiusForBalance(balance) {
    const cents = Math.max(0, (balance - 1.0) * 100);
    return SLITHER.headRadius * (1 + Math.pow(cents / 200, 0.35));
}

function clampInput(dx, dy) {
    const mag = Math.hypot(dx, dy);
    if (mag > SLITHER.maxInput) {
        const s = SLITHER.maxInput / mag;
        return { dx: dx * s, dy: dy * s };
    }
    return { dx, dy };
}

function randomSpawnCoord() {
    const h = SLITHER.worldHalf * 0.85;
    return (Math.random() - 0.5) * 2 * h;
}

export function addSlitherFood(room, n, foodBlobValue) {
    for (let i = 0; i < n; i++) {
        if (room.foodPoolBalance < foodBlobValue) break;
        room.foodPoolBalance -= foodBlobValue;
        room.slitherFood.push({
            id: randId(),
            x: randomSpawnCoord(),
            y: randomSpawnCoord(),
            balance: foodBlobValue,
            hue: Math.floor(Math.random() * 360),
        });
    }
}

export function createSlitherBot(room) {
    const { x, y } = pickSlitherSpawn(room);
    const balance = SLITHER.botStartBalance;
    const angle = Math.random() * Math.PI * 2;
    return {
        id: 'slither_bot_' + randId(),
        username: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + ' [' + util.randomInRange(10, 99) + ']',
        isBot: true,
        balance,
        kills: 0,
        color: util.randomColor(),
        segments: createSegments(x, y, balance, angle),
        inputDx: Math.cos(angle),
        inputDy: Math.sin(angle),
        boost: false,
        aiTimer: Math.floor(10 + Math.random() * 30),
        angle,
    };
}

export function addSlitherBots(room, n) {
    const spawnCount = Math.min(n, Math.floor(room.aiBudgetBalance / SLITHER.botStartBalance));
    for (let i = 0; i < spawnCount; i++) {
        room.aiBudgetBalance -= SLITHER.botStartBalance;
        room.slitherBots.push(createSlitherBot(room));
    }
}

export function getSlitherTargetBots(humanCount) {
    if (humanCount <= 0) return 0;
    if (humanCount >= 8) return 0;
    if (humanCount < 3) return 4;
    return Math.min(humanCount * 2, 12);
}

function getAllSlitherSnakes(room) {
    const humans = room.players
        .filter(p => p.mode === 'slither' && !p.disconnected && p.segments?.length)
        .map(p => ({ entity: p, isHuman: true }));
    const bots = room.slitherBots.map(b => ({ entity: b, isHuman: false }));
    return [...humans, ...bots];
}

function normalizeSnakeInput(snake) {
    let { dx, dy } = clampInput(snake.inputDx || 0, snake.inputDy || 0);
    if (dx === 0 && dy === 0) {
        dx = Math.cos(snake.angle || 0);
        dy = Math.sin(snake.angle || 0);
    }
    return { dx, dy };
}

function updateSnakeMovement(snake) {
    const head = snake.segments[0];
    const { dx, dy } = normalizeSnakeInput(snake);
    snake.angle = Math.atan2(dy, dx);

    const speedMult = snake.boost ? SLITHER.boostMultiplier : 1;
    const step = SLITHER.baseSpeed * speedMult;
    head.x += dx * step;
    head.y += dy * step;

    if (snake.boost && snake.balance > 1.05) {
        snake.balance = Math.max(1.0, snake.balance - SLITHER.boostCostPerTick);
    }

    for (let i = 1; i < snake.segments.length; i++) {
        const prev = snake.segments[i - 1];
        const cur = snake.segments[i];
        const d = dist(prev.x, prev.y, cur.x, cur.y);
        if (d > SLITHER.segmentSpacing) {
            const t = 0.45;
            cur.x += (prev.x - cur.x) * t;
            cur.y += (prev.y - cur.y) * t;
        }
    }

    const targetCount = balanceToSegmentCount(snake.balance);
    while (snake.segments.length < targetCount) {
        const tail = snake.segments[snake.segments.length - 1];
        snake.segments.push({ x: tail.x, y: tail.y });
    }
    while (snake.segments.length > targetCount) {
        snake.segments.pop();
    }

    if (snake.x !== undefined) {
        snake.x = head.x;
        snake.y = head.y;
    }
}

function runSlitherBotAI(snake, allSnakes, food) {
    snake.aiTimer = (snake.aiTimer || 0) - 1;
    const head = snake.segments[0];
    let threat = null;
    let prey = null;
    let nearestFood = null;
    let minThreat = 350;
    let minPrey = 300;
    let minFood = 400;

    for (const { entity: other } of allSnakes) {
        if (other.id === snake.id) continue;
        const oh = other.segments[0];
        const d = dist(head.x, head.y, oh.x, oh.y);
        if (other.balance > snake.balance * 1.1 && d < minThreat) {
            minThreat = d;
            threat = oh;
        } else if (snake.balance > other.balance * 1.1 && d < minPrey) {
            minPrey = d;
            prey = oh;
        }
    }

    for (const f of food) {
        const d = dist(head.x, head.y, f.x, f.y);
        if (d < minFood) {
            minFood = d;
            nearestFood = f;
        }
    }

    if (threat) {
        snake.inputDx = head.x - threat.x;
        snake.inputDy = head.y - threat.y;
        snake.boost = minThreat < 150;
    } else if (prey) {
        snake.inputDx = prey.x - head.x;
        snake.inputDy = prey.y - head.y;
        snake.boost = minPrey < 120;
    } else if (nearestFood) {
        snake.inputDx = nearestFood.x - head.x;
        snake.inputDy = nearestFood.y - head.y;
        snake.boost = false;
    } else if (snake.aiTimer <= 0) {
        snake.aiTimer = Math.floor(15 + Math.random() * 25);
        snake.inputDx = Math.random() * 2 - 1;
        snake.inputDy = Math.random() * 2 - 1;
        snake.boost = false;
    }
}

function checkWallCollision(snake) {
    const head = snake.segments[0];
    const r = headRadiusForBalance(snake.balance);
    const limit = SLITHER.worldHalf - r;
    return head.x < -limit || head.x > limit || head.y < -limit || head.y > limit;
}

function checkSelfCollision(snake) {
    if (snake.spawnGraceUntil && Date.now() < snake.spawnGraceUntil) return false;
    const head = snake.segments[0];
    const r = headRadiusForBalance(snake.balance);
    for (let i = SLITHER.selfCollisionSkip; i < snake.segments.length; i++) {
        const seg = snake.segments[i];
        if (dist(head.x, head.y, seg.x, seg.y) < r * 0.85) return true;
    }
    return false;
}

function checkSnakeCollisions(snake, allSnakes) {
    if (snake.spawnGraceUntil && Date.now() < snake.spawnGraceUntil) return null;
    const head = snake.segments[0];
    const r = headRadiusForBalance(snake.balance);
    for (const { entity: other } of allSnakes) {
        if (other.id === snake.id) continue;
        for (let i = 0; i < other.segments.length; i += (i === 0 ? 1 : 3)) {
            const seg = other.segments[i];
            const segR = i === 0 ? headRadiusForBalance(other.balance) : headRadiusForBalance(other.balance) * 0.7;
            if (dist(head.x, head.y, seg.x, seg.y) < r + segR * 0.5) {
                return other;
            }
        }
    }
    return null;
}

function checkFoodCollisions(snake, room) {
    const head = snake.segments[0];
    const r = headRadiusForBalance(snake.balance);
    for (let i = room.slitherFood.length - 1; i >= 0; i--) {
        const f = room.slitherFood[i];
        if (dist(head.x, head.y, f.x, f.y) < r + SLITHER.foodRadius) {
            snake.balance += f.balance;
            room.slitherFood.splice(i, 1);
        }
    }
}

function eliminateSnake(room, snake, killer, io, User, isHuman) {
    const lostBalance = snake.balance;

    if (killer && killer.id !== snake.id) {
        killer.balance += lostBalance;
        killer.kills = (killer.kills || 0) + 1;
        const kCount = balanceToSegmentCount(killer.balance);
        while (killer.segments.length < kCount) {
            const tail = killer.segments[killer.segments.length - 1];
            killer.segments.push({ x: tail.x, y: tail.y });
        }
    }

    if (isHuman) {
        const socketId = snake.id;
        io.to(socketId).emit('RIP');
        room.players = room.players.filter(p => p.id !== snake.id);
        User.findByIdAndUpdate(snake.mongoId, { $inc: { playtime: Date.now() - snake.startTime } }).catch(() => {});
    } else {
        room.slitherBots = room.slitherBots.filter(b => b.id !== snake.id);
    }

    return lostBalance;
}

function serializeSnake(snake, isYou) {
    return {
        id: snake.id,
        name: snake.username,
        balance: snake.balance,
        color: snake.color,
        isBot: !!snake.isBot,
        isYou,
        segments: snake.segments.map(s => ({ x: Math.round(s.x), y: Math.round(s.y) })),
        angle: snake.angle || 0,
    };
}

function isInView(cx, cy, x, y, range) {
    return Math.abs(x - cx) <= range && Math.abs(y - cy) <= range;
}

/**
 * Run one slither physics tick. Returns leaderboard entries for slither mode.
 */
export function processSlitherRoom(room, io, User, foodBlobValue) {
    const slitherHumans = room.players.filter(p => !p.disconnected && p.mode === 'slither');
    const humanCount = slitherHumans.length;

    const targetBots = getSlitherTargetBots(humanCount);
    if (room.slitherBots.length < targetBots) {
        addSlitherBots(room, targetBots - room.slitherBots.length);
    } else if (room.slitherBots.length > targetBots) {
        room.slitherBots.splice(0, room.slitherBots.length - targetBots);
    }

    const foodValueTarget = Math.min(humanCount * 250.0, room.foodPoolBalance);
    const targetFoodCount = Math.floor(foodValueTarget / foodBlobValue);
    if (room.slitherFood.length < targetFoodCount) {
        addSlitherFood(room, Math.min(50, targetFoodCount - room.slitherFood.length), foodBlobValue);
    }

    const allSnakes = getAllSlitherSnakes(room);
    const toRemove = [];

    for (const { entity: snake, isHuman } of allSnakes) {
        if (snake.isCashingOut) continue;

        if (snake.isBot) {
            if (snake.balance > SLITHER.botMaxBalance) {
                toRemove.push({ snake, isHuman, killer: null });
                continue;
            }
            runSlitherBotAI(snake, allSnakes, room.slitherFood);
        }

        updateSnakeMovement(snake);
        checkFoodCollisions(snake, room);

        if (isHuman) {
            snake.balance = Math.max(1.0, snake.balance);
            if (snake.cells?.[0]) snake.cells[0].balance = snake.balance;
        }

        if (checkWallCollision(snake) || checkSelfCollision(snake)) {
            toRemove.push({ snake, isHuman, killer: null });
            continue;
        }

        const hit = checkSnakeCollisions(snake, allSnakes);
        if (hit) {
            toRemove.push({ snake, isHuman, killer: hit });
        }
    }

    for (const { snake, isHuman, killer } of toRemove) {
        eliminateSnake(room, snake, killer, io, User, isHuman);
    }

    const slitherLeaderboard = getAllSlitherSnakes(room)
        .map(({ entity: s }) => ({
            id: s.id,
            name: s.username,
            massTotal: s.balance.toFixed(2),
            balance: s.balance.toFixed(2),
        }))
        .sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance))
        .slice(0, 10);

    return slitherLeaderboard;
}

export function broadcastSlitherState(room, io, slitherLeaderboard, meta) {
    const allSnakes = getAllSlitherSnakes(room);
    const range = SLITHER.viewRange;

    room.players
        .filter(p => p.mode === 'slither' && !p.disconnected)
        .forEach(p => {
            const head = p.segments?.[0];
            if (!head) return;

            io.to(p.id).emit('leaderboard', { leaderboard: slitherLeaderboard });

            const visibleSnakes = allSnakes
                .filter(({ entity: s }) => {
                    const h = s.segments[0];
                    return isInView(head.x, head.y, h.x, h.y, range);
                })
                .map(({ entity: s }) => serializeSnake(s, s.id === p.id));

            const visibleFood = room.slitherFood
                .filter(f => isInView(head.x, head.y, f.x, f.y, range))
                .map(f => ({ id: f.id, x: f.x, y: f.y, hue: f.hue }));

            io.to(p.id).emit('slitherTick', {
                you: p.id,
                snakes: visibleSnakes,
                food: visibleFood,
                balance: p.balance,
                worldHalf: SLITHER.worldHalf,
                ...meta,
            });
        });
}

export function createSlitherPlayer(socketId, mongoId, username, color, room) {
    const { x, y } = pickSlitherSpawn(room);
    const balance = 1.0;
    const angle = Math.random() * Math.PI * 2;
    return {
        id: socketId,
        mongoId,
        username,
        mode: 'slither',
        kills: 0,
        balance,
        startTime: Date.now(),
        spawnGraceUntil: Date.now() + 1500,
        color,
        x,
        y,
        inputDx: Math.cos(angle),
        inputDy: Math.sin(angle),
        boost: false,
        angle,
        segments: createSegments(x, y, balance, angle),
        screenWidth: 1920,
        screenHeight: 1080,
        cells: [{
            id: randId(),
            x,
            y,
            balance,
            radius: 10,
            vx: 0,
            vy: 0,
            lastSplit: Date.now(),
        }],
    };
}
