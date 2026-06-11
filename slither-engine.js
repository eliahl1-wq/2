import * as util from './utils.js';
import { getEconomy, DEFAULT_ENTRY_FEE, wealthTaxDecayAmount } from './economy.js';

export const SLITHER = {
    worldHalf: 3000,
    // Slither.io protocol reference (ClitherProject Protocol v11, scaled to our arena)
    slitherGameRadius: 21600,
    spawnSegments: 4,
    maxSegments: 400,
    segmentsPerCent: 0.1,
    maxScale: 6,
    scaleDivisor: 106,
    baseRadius: 5.5,
    segmentSepFactor: 6,
    nsp1: 5.39,
    nsp2: 0.4,
    nsp3: 14,
    slitherTickRate: 125,
    serverTickRate: 40,
    speedMultiplier: 1.2,
    maxInput: 4,
    boostMultiplier: 1.55,
    boostCostPerTick: 0.00012,
    foodRadius: 5,
    segmentSpacing: 6,
    baseSegments: 4,
    segmentsPerCentLegacy: 0.1,
    foodBlobValue: 0.01,
    botStartBalance: 1.0,
    botMaxBalance: 500.0,
    viewRange: 520,
    selfCollisionSkip: 4,
};

const BOT_NAMES = [
    'Sirius', 'Gota', 'SnakeMaster', 'ProSlither', 'Legit', 'Sanic',
    'Wojak', 'Pepe', 'Doge', 'Viper', 'Cobra', 'Python', 'Anaconda',
];

// Agar arena is 18000×18000 — scale food count so Slither has the same visual density
const AGAR_WORLD_SIDE = 6000;

// Agar bot AI ranges (px in 18000 world) — scaled for slither arena
const AGAR_BOT_THREAT_RANGE = 800;
const AGAR_BOT_PREY_RANGE = 500;
const AGAR_BOT_FOOD_RANGE = 500;
const AGAR_BOT_FLEE_DISTANCE = 500;
const AGAR_BOT_TARGET_INTERVAL_MS = 1000;

function slitherFoodDensityScale() {
    const slitherSide = SLITHER.worldHalf * 2;
    return (slitherSide * slitherSide) / (AGAR_WORLD_SIDE * AGAR_WORLD_SIDE);
}

function scaleAgarBotDistance(agarDistance) {
    const worldScale = (SLITHER.worldHalf * 2) / AGAR_WORLD_SIDE;
    return Math.max(
        SLITHER.viewRange * (agarDistance / AGAR_BOT_THREAT_RANGE),
        agarDistance * worldScale,
    );
}

function getSlitherFoodValue(room) {
    return room.slitherFood.reduce((sum, f) => sum + f.balance, 0);
}

function clearSlitherFood(room) {
    for (const f of room.slitherFood) {
        room.foodPoolBalance += f.balance;
    }
    room.slitherFood.length = 0;
}

function trimSlitherFood(room, targetCount) {
    const golden = room.slitherFood.filter(f => f.golden);
    const normal = room.slitherFood.filter(f => !f.golden);
    while (normal.length > targetCount) {
        const removed = normal.pop();
        room.foodPoolBalance += removed.balance;
    }
    room.slitherFood = normal.concat(golden);
}

function randId() {
    return Math.random().toString(36).substr(2, 9);
}

function dist(x1, y1, x2, y2) {
    return Math.hypot(x1 - x2, y1 - y2);
}

export function segmentCountForBalance(balance) {
    const cents = Math.max(0, (balance - 1.0) * 100);
    const extra = Math.floor(cents * SLITHER.segmentsPerCent);
    return Math.min(SLITHER.maxSegments, SLITHER.spawnSegments + extra);
}

export function scaleForSegmentCount(sct) {
    return Math.min(SLITHER.maxScale, 1 + (Math.max(2, sct) - 2) / SLITHER.scaleDivisor);
}

export function balanceToSegmentCount(balance) {
    return segmentCountForBalance(balance);
}

export function headRadiusForBalance(balance) {
    const sc = scaleForSegmentCount(segmentCountForBalance(balance));
    return SLITHER.baseRadius * sc;
}

export function segmentSpacingForBalance(balance) {
    const sc = scaleForSegmentCount(segmentCountForBalance(balance));
    return SLITHER.segmentSepFactor * sc;
}

export function speedForBalance(balance, boosting = false) {
    const sc = scaleForSegmentCount(segmentCountForBalance(balance));
    const worldScale = (SLITHER.worldHalf * 2) / (SLITHER.slitherGameRadius * 2);
    const slitherUnitsPerFrame = boosting
        ? SLITHER.nsp3
        : SLITHER.nsp1 + SLITHER.nsp2 * sc;
    const ourUnitsPerSec = slitherUnitsPerFrame * SLITHER.slitherTickRate * worldScale;
    return (ourUnitsPerSec / SLITHER.serverTickRate) * SLITHER.speedMultiplier;
}

export function createSegments(x, y, balance, angle = 0) {
    const count = balanceToSegmentCount(balance);
    const spacing = segmentSpacingForBalance(balance);
    const segs = [];
    for (let i = 0; i < count; i++) {
        segs.push({
            x: x - Math.cos(angle) * i * spacing,
            y: y - Math.sin(angle) * i * spacing,
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
        if (isSpawnClear(room, x, y, 60)) return { x, y };
    }
    return { x: randomSpawnCoord(), y: randomSpawnCoord() };
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

export function addSlitherFood(room, n, foodBlobValue, maxBudgetValue = Infinity) {
    let currentValue = getSlitherFoodValue(room);
    for (let i = 0; i < n; i++) {
        if (currentValue + foodBlobValue > maxBudgetValue + 1e-9) break;
        if (room.foodPoolBalance < foodBlobValue) break;
        room.foodPoolBalance -= foodBlobValue;
        currentValue += foodBlobValue;
        room.slitherFood.push({
            id: randId(),
            x: randomSpawnCoord(),
            y: randomSpawnCoord(),
            balance: foodBlobValue,
            hue: Math.floor(Math.random() * 360),
            radius: SLITHER.foodRadius,
        });
    }
}

/** One high-value blob per human join — value already deducted from food allocation. */
export function spawnGoldenSlitherBlob(room, value) {
    if (value <= 1e-9 || room.foodPoolBalance < value - 1e-9) return;
    room.foodPoolBalance -= value;
    const { x, y } = pickSlitherSpawn(room);
    room.slitherFood.push({
        id: randId(),
        x,
        y,
        balance: value,
        hue: 48,
        golden: true,
        radius: SLITHER.foodRadius * 2.4,
    });
}

/** BR-only pellets: growth mass only, not tied to prize pool or house wallet. */
export function addBRSlitherFood(room, n, massPerPellet = 0.012) {
    for (let i = 0; i < n; i++) {
        room.slitherFood.push({
            id: randId(),
            x: randomSpawnCoord(),
            y: randomSpawnCoord(),
            balance: massPerPellet,
            hue: Math.floor(Math.random() * 360),
            radius: SLITHER.foodRadius,
        });
    }
}

export function syncBRSlitherFood(room, playerCount) {
    const target = Math.max(50, playerCount * 70);
    if (room.slitherFood.length < target) {
        addBRSlitherFood(room, Math.min(35, target - room.slitherFood.length));
    } else if (room.slitherFood.length > target * 1.4) {
        trimSlitherFood(room, target);
    }
}

export function createSlitherBot(room, botBalance = SLITHER.botStartBalance) {
    const { x, y } = pickSlitherSpawn(room);
    const balance = botBalance;
    const angle = Math.random() * Math.PI * 2;
    return {
        id: 'slither_bot_' + randId(),
        username: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + ' [' + util.randomInRange(10, 99) + ']',
        isBot: true,
        balance,
        botStake: botBalance,
        kills: 0,
        color: util.randomColor(),
        segments: createSegments(x, y, balance, angle),
        inputDx: Math.cos(angle),
        inputDy: Math.sin(angle),
        boost: false,
        lastTargetUpdate: 0,
        targetX: x,
        targetY: y,
        angle,
    };
}

export function addSlitherBots(room, n, botStake = SLITHER.botStartBalance) {
    const spawnCount = Math.min(n, Math.floor(room.aiBudgetBalance / botStake));
    for (let i = 0; i < spawnCount; i++) {
        room.aiBudgetBalance -= botStake;
        room.slitherBots.push(createSlitherBot(room, botStake));
    }
}

/** Remove excess bots from the front and return their stake to the AI budget (matches agar economy). */
export function trimSlitherBots(room, targetCount) {
    while (room.slitherBots.length > targetCount) {
        const removed = room.slitherBots.shift();
        room.aiBudgetBalance += removed?.botStake ?? SLITHER.botStartBalance;
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
    } else {
        const mag = Math.hypot(dx, dy) || 1;
        dx /= mag;
        dy /= mag;
    }
    return { dx, dy };
}

function minBalanceForSnake(snake) {
    if (snake.isBot) {
        return snake.botStake ?? SLITHER.botStartBalance;
    }
    return getEconomy(snake.entryFeeUsd ?? DEFAULT_ENTRY_FEE).playerStartBalance;
}

function updateSnakeMovement(snake) {
    const head = snake.segments[0];
    const { dx, dy } = normalizeSnakeInput(snake);
    snake.angle = Math.atan2(dy, dx);

    const step = speedForBalance(snake.balance, snake.boost);
    head.x += dx * step;
    head.y += dy * step;

    if (snake.boost && snake.balance > minBalanceForSnake(snake) * 1.05) {
        snake.balance = Math.max(minBalanceForSnake(snake), snake.balance - SLITHER.boostCostPerTick);
    }

    const spacing = segmentSpacingForBalance(snake.balance);
    for (let i = 1; i < snake.segments.length; i++) {
        const prev = snake.segments[i - 1];
        const cur = snake.segments[i];
        const segDx = cur.x - prev.x;
        const segDy = cur.y - prev.y;
        const d = Math.hypot(segDx, segDy);
        if (d > spacing) {
            const ratio = spacing / d;
            cur.x = prev.x + segDx * ratio;
            cur.y = prev.y + segDy * ratio;
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

function applyWallAvoidance(snake) {
    const head = snake.segments[0];
    const r = headRadiusForBalance(snake.balance);
    const limit = SLITHER.worldHalf - r - 20;
    const margin = 120;
    let steerX = 0;
    let steerY = 0;

    if (head.x < -limit + margin) steerX += (-limit + margin - head.x);
    else if (head.x > limit - margin) steerX += (limit - margin - head.x);
    if (head.y < -limit + margin) steerY += (-limit + margin - head.y);
    else if (head.y > limit - margin) steerY += (limit - margin - head.y);

    if (steerX === 0 && steerY === 0) return false;

    snake.targetX = head.x + steerX * 4;
    snake.targetY = head.y + steerY * 4;
    snake.inputDx = snake.targetX - head.x;
    snake.inputDy = snake.targetY - head.y;
    snake.boost = false;
    return true;
}

/** Bot AI aligned with agar mode: flee → chase → food → wander, plus wall avoidance. */
function runSlitherBotAI(snake, allSnakes, food) {
    const head = snake.segments[0];
    const minDistThreat = scaleAgarBotDistance(AGAR_BOT_THREAT_RANGE);
    const minDistPrey = scaleAgarBotDistance(AGAR_BOT_PREY_RANGE);
    const minDistFood = scaleAgarBotDistance(AGAR_BOT_FOOD_RANGE);
    const fleeDistance = scaleAgarBotDistance(AGAR_BOT_FLEE_DISTANCE);

    let threat = null;
    let targetPrey = null;
    let nearestThreatDist = minDistThreat;
    let nearestPreyDist = minDistPrey;

    for (const { entity: other } of allSnakes) {
        if (other.id === snake.id) continue;
        const oh = other.segments[0];
        const d = dist(head.x, head.y, oh.x, oh.y);

        if (other.balance > snake.balance * 1.10 && d < nearestThreatDist) {
            nearestThreatDist = d;
            threat = oh;
        } else if (snake.balance > other.balance * 1.10 && d < nearestPreyDist) {
            nearestPreyDist = d;
            targetPrey = oh;
        }
    }

    if (threat) {
        const angle = Math.atan2(head.y - threat.y, head.x - threat.x);
        snake.targetX = head.x + Math.cos(angle) * fleeDistance;
        snake.targetY = head.y + Math.sin(angle) * fleeDistance;
        snake.boost = nearestThreatDist < fleeDistance * 0.3;
    } else if (targetPrey) {
        snake.targetX = targetPrey.x;
        snake.targetY = targetPrey.y;
        snake.boost = nearestPreyDist < fleeDistance * 0.25;
    } else if (Date.now() - (snake.lastTargetUpdate || 0) > AGAR_BOT_TARGET_INTERVAL_MS) {
        let nearestFood = null;
        let nearestFoodDist = minDistFood;

        for (const f of food) {
            const d = dist(head.x, head.y, f.x, f.y);
            if (d < nearestFoodDist) {
                nearestFoodDist = d;
                nearestFood = f;
            }
        }

        if (nearestFood) {
            snake.targetX = nearestFood.x;
            snake.targetY = nearestFood.y;
        } else if (dist(head.x, head.y, snake.targetX, snake.targetY) < 50) {
            snake.targetX = randomSpawnCoord();
            snake.targetY = randomSpawnCoord();
        }
        snake.lastTargetUpdate = Date.now();
        snake.boost = false;
    }

    if (!applyWallAvoidance(snake)) {
        snake.inputDx = snake.targetX - head.x;
        snake.inputDy = snake.targetY - head.y;
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

function eliminateSnake(room, snake, killer, io, User, isHuman, returnToPool = true, Transaction = null) {
    const lostBalance = snake.balance;

    if (killer && killer.id !== snake.id) {
        killer.balance += lostBalance;
        killer.kills = (killer.kills || 0) + 1;
        const kCount = balanceToSegmentCount(killer.balance);
        while (killer.segments.length < kCount) {
            const tail = killer.segments[killer.segments.length - 1];
            killer.segments.push({ x: tail.x, y: tail.y });
        }
    } else if (lostBalance > 0 && returnToPool) {
        room.foodPoolBalance += lostBalance;
    }

    if (isHuman) {
        const socketId = snake.id;
        if (snake.isBattleRoyale) {
            const placement = room.players.filter(p => p.id !== snake.id).length + 1;
            io.to(socketId).emit('brEliminated', {
                placement,
                playersRemaining: placement - 1,
                reason: killer ? 'killed' : 'eliminated',
                prizePool: room.prizePool,
            });
        }
        io.to(socketId).emit('RIP');
        room.players = room.players.filter(p => p.id !== snake.id);
        User.findByIdAndUpdate(snake.mongoId, { $inc: { playtime: Date.now() - snake.startTime } }).catch(() => {});
        if (Transaction && snake.mongoId) {
            Transaction.create({
                userId: snake.mongoId,
                type: 'game',
                amount: lostBalance,
                meta: {
                    reason: 'Arena Death',
                    mode: 'slither',
                    entryFeeUsd: snake.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
                },
                status: 'confirmed',
            }).catch(err => console.error('Error logging slither death:', err));
        }
    } else {
        room.slitherBots = room.slitherBots.filter(b => b.id !== snake.id);
    }

    return lostBalance;
}

function serializeSnake(snake, isYou) {
    const sct = snake.segments.length;
    const sc = scaleForSegmentCount(sct);
    return {
        id: snake.id,
        name: snake.username,
        balance: snake.balance,
        color: snake.color,
        isBot: !!snake.isBot,
        isYou,
        segments: snake.segments.map(s => ({ x: s.x, y: s.y })),
        angle: snake.angle || 0,
        sc,
        radius: SLITHER.baseRadius * sc,
        boost: !!snake.boost,
    };
}

function isInView(cx, cy, x, y, range) {
    return Math.abs(x - cx) <= range && Math.abs(y - cy) <= range;
}

export function syncSlitherFood(room, foodBlobValue, budget, humansInArena, densityPerHuman = 250.0) {
    if (humansInArena <= 0) {
        clearSlitherFood(room);
        return;
    }
    const densityScale = slitherFoodDensityScale();
    const goldenValueOnMap = room.slitherFood
        .filter(f => f.golden)
        .reduce((sum, f) => sum + f.balance, 0);
    const foodValueTarget = Math.max(0, Math.min(humansInArena * densityPerHuman * densityScale, budget) - goldenValueOnMap);
    const targetFoodCount = Math.floor(foodValueTarget / foodBlobValue);
    const normalCount = room.slitherFood.filter(f => !f.golden).length;
    if (normalCount < targetFoodCount) {
        addSlitherFood(
            room,
            Math.min(50, targetFoodCount - normalCount),
            foodBlobValue,
            foodValueTarget + goldenValueOnMap,
        );
    } else if (normalCount > targetFoodCount) {
        trimSlitherFood(room, targetFoodCount);
    }
}

/**
 * Run one slither physics tick. Returns leaderboard entries for slither mode.
 */
export function processSlitherRoom(room, io, User, Transaction = null) {
    const isBR = room.isBattleRoyale === true;
    const slitherHumans = room.players.filter(p => !p.disconnected && p.mode === 'slither');
    const humanCount = slitherHumans.length;

    const allSnakes = getAllSlitherSnakes(room);
    const toRemove = [];

    for (const { entity: snake, isHuman } of allSnakes) {
        if (!isBR && snake.isBot) {
            const botMax = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE).botMaxBalance;
            if (snake.balance > botMax) {
                toRemove.push({ snake, isHuman, killer: null, respawnBot: true, returnToPool: false });
                continue;
            }
            runSlitherBotAI(snake, allSnakes, room.slitherFood);
        }

        // Players keep moving while cashing out (no freeze) — getting eaten cancels the cashout
        updateSnakeMovement(snake);
        checkFoodCollisions(snake, room);

        if (isHuman && !isBR) {
            const minBal = minBalanceForSnake(snake);
            const decay = wealthTaxDecayAmount(snake.balance, minBal);
            if (decay > 1e-9) {
                const actual = Math.min(decay, snake.balance - minBal);
                snake.balance -= actual;
                room.foodPoolBalance += actual;
                const targetCount = balanceToSegmentCount(snake.balance);
                while (snake.segments.length > targetCount) snake.segments.pop();
            }
            snake.balance = Math.max(minBal, snake.balance);
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

    for (const { snake, isHuman, killer, respawnBot, returnToPool = true } of toRemove) {
        eliminateSnake(room, snake, killer, io, User, isHuman, isBR ? false : returnToPool, Transaction);
        if (!isBR && respawnBot) {
            const targetBots = getSlitherTargetBots(humanCount);
            if (room.slitherBots.length < targetBots) {
                addSlitherBots(room, 1, getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE).botStartBalance);
            }
        }
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

            io.to(p.id).emit('leaderboard', { leaderboard: slitherLeaderboard, battleRoyale: !!meta.battleRoyale });

            const visibleSnakes = allSnakes
                .filter(({ entity: s }) => {
                    const h = s.segments[0];
                    return isInView(head.x, head.y, h.x, h.y, range);
                })
                .map(({ entity: s }) => serializeSnake(s, s.id === p.id));

            const visibleFood = room.slitherFood
                .filter(f => isInView(head.x, head.y, f.x, f.y, range))
                .map(f => ({
                    id: f.id,
                    x: f.x,
                    y: f.y,
                    hue: f.hue,
                    radius: f.radius || SLITHER.foodRadius,
                    golden: !!f.golden,
                }));

            io.to(p.id).emit('slitherTick', {
                you: p.id,
                snakes: visibleSnakes,
                food: visibleFood,
                worldHalf: SLITHER.worldHalf,
                ...meta,
                ...(meta.battleRoyale ? {} : { balance: p.balance }),
            });
        });
}

export function createSlitherPlayer(socketId, mongoId, username, color, room, startBalance = 1.0) {
    const { x, y } = pickSlitherSpawn(room);
    const balance = startBalance;
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
            radius: headRadiusForBalance(balance),
            vx: 0,
            vy: 0,
            lastSplit: Date.now(),
        }],
    };
}
