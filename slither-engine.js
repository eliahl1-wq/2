import * as util from './utils.js';
import { getEconomy, DEFAULT_ENTRY_FEE, wealthTaxDecayAmount, getCompetitiveEconomy } from './economy.js';

export const SLITHER = {
    worldHalf: 3000,
    // Slither.io protocol reference (ClitherProject Protocol v11, scaled to our arena)
    slitherGameRadius: 21600,
    spawnSegments: 12,
    maxSegments: 500,
    segmentsPerCent: 0.055,
    maxScale: 6,
    scaleDivisor: 106,
    baseRadius: 6.2,
    segmentSepFactor: 3.6,
    nsp1: 5.39,
    nsp2: 0.4,
    nsp3: 14,
    slitherTickRate: 125,
    serverTickRate: 40,
    speedMultiplier: 1.2,
    turnRate: 7.2,
    maxInput: 4,
    boostMultiplier: 1.55,
    boostCostPerTick: 0.00125, // $0.05/s at 40Hz
    foodRadius: 2.0,
    /** Extra pickup generosity — mouth point + swept path (see food pickup helpers). */
    foodPickupReachMult: 1.55,
    foodPickupReachPad: 14,
    foodMouthForward: 0.8,
    segmentSpacing: 6,
    baseSegments: 12,
    segmentsPerCentLegacy: 0.1,
    foodBlobValue: 0.02, // baseline at $10; use getEconomy(entryFee).foodBlobValue per room
    botStartBalance: 1.0,
    botMaxBalance: 500.0,
    viewRange: 520,
    minimapRange: 1050,
    minimapThreatRange: 1700,
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

function slitherFoodDollarValue(f) {
    if (f.dollarValue != null && f.dollarValue > 0) return f.dollarValue;
    return f.balance;
}

function getSlitherFoodValue(room) {
    return room.slitherFood.reduce((sum, f) => sum + slitherFoodDollarValue(f), 0);
}

function clearSlitherFood(room) {
    for (const f of room.slitherFood) {
        room.foodPoolBalance += slitherFoodDollarValue(f);
    }
    room.slitherFood.length = 0;
}

function trimSlitherFood(room, targetCount) {
    const protectedFood = room.slitherFood.filter(f => f.golden || f.deathDrop);
    let normal = room.slitherFood.filter(f => !f.golden && !f.deathDrop);

    // Remove farthest pellets first so visible/nearby food stays stable
    const heads = [];
    for (const p of room.players) {
        if (p.mode === 'slither' && p.segments?.[0]) heads.push(p.segments[0]);
    }
    for (const b of room.slitherBots || []) {
        if (b.segments?.[0]) heads.push(b.segments[0]);
    }

    while (normal.length > targetCount) {
        let worstIdx = 0;
        let worstScore = -1;
        for (let i = 0; i < normal.length; i++) {
            const f = normal[i];
            let minDist = Infinity;
            for (const h of heads) {
                const d = dist(f.x, f.y, h.x, h.y);
                if (d < minDist) minDist = d;
            }
            if (minDist > worstScore) {
                worstScore = minDist;
                worstIdx = i;
            }
        }
        const removed = normal.splice(worstIdx, 1)[0];
        room.foodPoolBalance += slitherFoodDollarValue(removed);
    }
    room.slitherFood = normal.concat(protectedFood);
}

function randId() {
    return Math.random().toString(36).substr(2, 9);
}

function dist(x1, y1, x2, y2) {
    return Math.hypot(x1 - x2, y1 - y2);
}

export function segmentCountForBalance(balance, referenceBalance = 1.0) {
    const cents = Math.max(0, (balance - referenceBalance) * 100);
    const extra = Math.floor(cents * SLITHER.segmentsPerCent);
    return Math.min(SLITHER.maxSegments, SLITHER.spawnSegments + extra);
}

export function scaleForSegmentCount(sct) {
    return Math.min(SLITHER.maxScale, 1 + (Math.max(2, sct) - 2) / SLITHER.scaleDivisor);
}

/** Slither.io angular speed scale — thick snakes turn much slower. */
export function scangForSegmentCount(sct) {
    const sc = scaleForSegmentCount(sct);
    return 0.13 + 0.87 * Math.pow((7 - sc) / 6, 2);
}

export function balanceToSegmentCount(balance, referenceBalance = 1.0) {
    return segmentCountForBalance(balance, referenceBalance);
}

export function headRadiusForBalance(balance, referenceBalance = 1.0) {
    const sc = scaleForSegmentCount(segmentCountForBalance(balance, referenceBalance));
    return SLITHER.baseRadius * sc;
}

export function segmentSpacingForSegmentCount(sct) {
    return SLITHER.segmentSepFactor * scaleForSegmentCount(sct);
}

export function headRadiusForSegmentCount(sct) {
    return SLITHER.baseRadius * scaleForSegmentCount(sct);
}

export function segmentSpacingForBalance(balance, referenceBalance = 1.0) {
    const sc = scaleForSegmentCount(segmentCountForBalance(balance, referenceBalance));
    return SLITHER.segmentSepFactor * sc;
}

export function speedForBalance(balance, boosting = false, referenceBalance = 1.0) {
    const sc = scaleForSegmentCount(segmentCountForBalance(balance, referenceBalance));
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

function isSpawnClear(room, x, y, minDist = 200) {
    for (const { entity: s } of getAllSlitherSnakes(room)) {
        const r = headRadiusForBalance(s.balance ?? 1);
        const spacing = segmentSpacingForBalance(s.balance ?? 1);
        const bodyLen = (s.segments?.length ?? 1) * spacing;
        for (let i = 0; i < (s.segments?.length ?? 0); i++) {
            const seg = s.segments[i];
            const segR = i === 0 ? r : r * 0.75;
            const need = minDist + segR + (i === 0 ? 0 : bodyLen * 0.15);
            if (dist(x, y, seg.x, seg.y) < need) return false;
        }
    }
    return true;
}

function pickSlitherSpawn(room) {
    for (let i = 0; i < 80; i++) {
        const x = randomSpawnCoord();
        const y = randomSpawnCoord();
        if (isSpawnClear(room, x, y, 180)) return { x, y };
    }
    for (let i = 0; i < 40; i++) {
        const x = randomSpawnCoord();
        const y = randomSpawnCoord();
        if (isSpawnClear(room, x, y, 120)) return { x, y };
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
    const eco = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE);
    const massPerPellet = eco.massPerPellet;
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
            balance: massPerPellet,
            dollarValue: foodBlobValue,
            hue: Math.floor(Math.random() * 360),
            radius: SLITHER.foodRadius,
        });
    }
}

/** One high-value blob per human join — value already deducted from food allocation. */
export function spawnGoldenSlitherBlob(room, dollarValue) {
    if (dollarValue <= 1e-9 || room.foodPoolBalance < dollarValue - 1e-9) return;
    room.foodPoolBalance -= dollarValue;
    const eco = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE);
    const { x, y } = pickSlitherSpawn(room);
    room.slitherFood.push({
        id: randId(),
        x,
        y,
        balance: eco.goldenBlobMass,
        dollarValue,
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
    const startMass = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE).massStartBalance;
    const angle = Math.random() * Math.PI * 2;
    return {
        id: 'slither_bot_' + randId(),
        username: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + ' [' + util.randomInRange(10, 99) + ']',
        isBot: true,
        balance: startMass,
        dollarBalance: botBalance,
        botStake: botBalance,
        kills: 0,
        color: util.randomSlitherColor(),
        segments: createSegments(x, y, startMass, angle),
        inputDx: Math.cos(angle),
        inputDy: Math.sin(angle),
        boost: false,
        lastTargetUpdate: 0,
        targetX: x,
        targetY: y,
        angle,
        fam: 0,
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
    if (humanCount < 3) return humanCount * 2; // 1 human → 2 bots, 2 humans → 4 bots
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
        return getEconomy(snake.entryFeeUsd ?? DEFAULT_ENTRY_FEE).massStartBalance;
    }
    return getEconomy(snake.entryFeeUsd ?? DEFAULT_ENTRY_FEE).massStartBalance;
}

function minDollarsForSnake(snake) {
    if (snake.isBot) {
        return snake.botStake ?? getEconomy(snake.entryFeeUsd ?? DEFAULT_ENTRY_FEE).botStartBalance;
    }
    return getEconomy(snake.entryFeeUsd ?? DEFAULT_ENTRY_FEE).playerStartBalance;
}

function applySlitherFoodPickup(snake, food, room) {
    const eco = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE);
    let massGain = food.balance;
    let dollarGain = food.dollarValue ?? 0;

    if (food.dollarValue == null) {
        dollarGain = food.balance;
        if (food.golden) {
            massGain = eco.goldenBlobMass;
        } else if (food.deathDrop) {
            const blob = eco.foodBlobValue;
            massGain = blob > 1e-9 ? eco.massPerPellet * (food.balance / blob) : eco.massPerPellet;
        } else {
            massGain = eco.massPerPellet;
        }
    }

    snake.balance += massGain;
    if (snake.dollarBalance != null) {
        snake.dollarBalance = (snake.dollarBalance || 0) + dollarGain;
    } else {
        snake.balance += dollarGain;
    }
    snake.fam = (snake.fam || 0) + massGain / famVolumeForSegment(snake.segments.length);
    applyFamGrowth(snake);
}

/** Slither.io-style gradual length growth via fam fullness before adding a segment. */
function famVolumeForSegment(sct) {
    const sc = scaleForSegmentCount(sct);
    // Higher volume = slower segment adds per pellet (subtle, gradual growth).
    return 0.09 + sc * 0.022 + sct * 0.0016;
}

function applyFamGrowth(snake, maxAdd = 1) {
    if (snake.fam == null) snake.fam = 0;
    let added = 0;
    while (snake.fam >= 1 && snake.segments.length < SLITHER.maxSegments && added < maxAdd) {
        snake.fam -= 1;
        const spacing = segmentSpacingForSegmentCount(snake.segments.length);
        growSnakeSegments(snake.segments, snake.segments.length + 1, spacing);
        added++;
    }
}

function applyFamShrink(snake, massLost) {
    if (snake.fam == null) snake.fam = 0;
    const sct = snake.segments.length;
    const vol = famVolumeForSegment(sct);
    snake.fam -= massLost / vol;
    while (snake.fam < 0 && snake.segments.length > SLITHER.spawnSegments) {
        snake.fam += 1;
        const spacing = segmentSpacingForSegmentCount(snake.segments.length);
        growSnakeSegments(snake.segments, snake.segments.length - 1, spacing);
    }
}

function pathArcLength(path) {
    let arc = 0;
    for (let i = 0; i < path.length - 1; i++) {
        arc += dist(path[i].x, path[i].y, path[i + 1].x, path[i + 1].y);
    }
    return arc;
}

const MAX_SNAKE_PATH_POINTS = 420;
const MIN_HEAD_PATH_DIST = 0.14;

/** Trim oldest path points once the trail is longer than we need for the spine. */
function trimSnakePath(path, maxArcLength) {
    if (path.length <= 2) return;
    let arc = pathArcLength(path);
    while (path.length > 2 && (arc > maxArcLength || path.length > MAX_SNAKE_PATH_POINTS)) {
        const last = path.pop();
        const prev = path[path.length - 1];
        arc -= dist(prev.x, prev.y, last.x, last.y);
    }
}

/** Extend the path tail when the snake outgrows its recorded history (e.g. after eating). */
function ensurePathArcLength(path, segments, spacing, angle = 0) {
    const required = Math.max(spacing, (segments.length - 1) * spacing);
    let arc = pathArcLength(path);
    if (arc >= required * 0.98) return;

    let dirX = 0;
    let dirY = 0;
    if (path.length >= 2) {
        const tail = path[path.length - 1];
        const prev = path[path.length - 2];
        dirX = tail.x - prev.x;
        dirY = tail.y - prev.y;
    } else if (segments.length >= 2) {
        const tail = segments[segments.length - 1];
        const prev = segments[segments.length - 2];
        dirX = tail.x - prev.x;
        dirY = tail.y - prev.y;
    }
    let d = Math.hypot(dirX, dirY);
    if (d < 1e-6) {
        dirX = -Math.cos(angle);
        dirY = -Math.sin(angle);
        d = 1;
    } else {
        dirX /= d;
        dirY /= d;
    }

    let last = path[path.length - 1];
    while (arc < required) {
        const add = Math.min(spacing, required - arc);
        last = { x: last.x + dirX * add, y: last.y + dirY * add };
        path.push(last);
        arc += add;
    }
}

function growSnakeSegments(segments, targetCount, spacing) {
    while (segments.length < targetCount) {
        const tail = segments[segments.length - 1];
        const prev = segments.length >= 2 ? segments[segments.length - 2] : tail;
        let dx = tail.x - prev.x;
        let dy = tail.y - prev.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) {
            dx /= d;
            dy /= d;
        } else {
            dx = 1;
            dy = 0;
        }
        segments.push({ x: tail.x - dx * spacing, y: tail.y - dy * spacing });
    }
    while (segments.length > targetCount) {
        segments.pop();
    }
}

/**
 * Slither.io-style body: each segment sits a fixed spacing behind the previous
 * one along the head's traveled path, so circles stay round and growth does
 * not collapse the tail when history is still catching up.
 */
function updateSnakeBodyFromPath(snake, spacing) {
    const segments = snake.segments;
    const head = segments[0];
    let path = snake.path;

    if (!path || path.length < 2) {
        path = segments.map(s => ({ x: s.x, y: s.y }));
        snake.path = path;
    }

    const minRecord = Math.max(0.12, spacing * MIN_HEAD_PATH_DIST * 0.55);
    if (dist(path[0].x, path[0].y, head.x, head.y) > minRecord) {
        path.unshift({ x: head.x, y: head.y });
    } else {
        path[0].x = head.x;
        path[0].y = head.y;
    }

    ensurePathArcLength(path, segments, spacing, snake.angle || 0);

    let pathIndex = 0;
    let pathOffset = 0;

    for (let i = 1; i < segments.length; i++) {
        let need = spacing;
        let placed = false;

        while (need > 1e-6 && pathIndex < path.length - 1) {
            const ax = path[pathIndex].x;
            const ay = path[pathIndex].y;
            const bx = path[pathIndex + 1].x;
            const by = path[pathIndex + 1].y;
            const edgeLen = dist(ax, ay, bx, by);

            if (edgeLen < 1e-6) {
                pathIndex++;
                pathOffset = 0;
                continue;
            }

            const avail = edgeLen - pathOffset;

            if (avail >= need) {
                const t = (pathOffset + need) / edgeLen;
                segments[i].x = ax + (bx - ax) * t;
                segments[i].y = ay + (by - ay) * t;
                pathOffset += need;
                placed = true;
                need = 0;
            } else {
                need -= avail;
                pathIndex++;
                pathOffset = 0;
            }
        }

        if (!placed) {
            const tail = path[path.length - 1];
            segments[i].x = tail.x;
            segments[i].y = tail.y;
        }
    }

    trimSnakePath(path, segments.length * spacing + spacing * 4);
}

function updateSnakeMovement(snake, room = null) {
    const head = snake.segments[0];
    rememberSnakeMouthBeforeMove(snake);
    const { dx, dy } = normalizeSnakeInput(snake);

    // slither.io-style turn-rate limit: heading rotates toward the cursor
    // instead of snapping. Bigger snakes turn slower.
    const desired = Math.atan2(dy, dx);
    const scang = scangForSegmentCount(snake.segments.length);
    const maxTurn = (SLITHER.turnRate * scang) / SLITHER.serverTickRate;
    const current = snake.angle ?? desired;
    let da = desired - current;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (da > maxTurn) da = maxTurn;
    else if (da < -maxTurn) da = -maxTurn;
    snake.angle = current + da;

    // Boost only works above min balance ($1 size) — at the floor it shuts off entirely
    const minBal = minBalanceForSnake(snake);
    const canBoost = !!snake.boost && snake.balance > minBal * 1.01;

    const mx = Math.cos(snake.angle);
    const my = Math.sin(snake.angle);
    const step = speedForBalance(snake.balance, canBoost);
    head.x += mx * step;
    head.y += my * step;

    if (canBoost && room) {
        const cost = Math.min(SLITHER.boostCostPerTick, snake.balance - minBal);
        snake.balance -= cost;
        room.foodPoolBalance += cost;
        applyFamShrink(snake, cost);
    }

    const spacing = segmentSpacingForSegmentCount(snake.segments.length);
    updateSnakeBodyFromPath(snake, spacing);

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
        let nearestFoodDist2 = minDistFood * minDistFood;

        for (const f of food) {
            const fdx = head.x - f.x;
            if (fdx > minDistFood || fdx < -minDistFood) continue;
            const fdy = head.y - f.y;
            if (fdy > minDistFood || fdy < -minDistFood) continue;
            const d2 = fdx * fdx + fdy * fdy;
            if (d2 < nearestFoodDist2) {
                nearestFoodDist2 = d2;
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

function distPointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) return dist(px, py, ax, ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return dist(px, py, ax + t * dx, ay + t * dy);
}

function snakeMouthPoint(snake) {
    const head = snake.segments[0];
    const r = headRadiusForBalance(snake.balance);
    const angle = snake.angle ?? 0;
    const fwd = r * SLITHER.foodMouthForward;
    return {
        x: head.x + Math.cos(angle) * fwd,
        y: head.y + Math.sin(angle) * fwd,
        r,
    };
}

function rememberSnakeMouthBeforeMove(snake) {
    const mouth = snakeMouthPoint(snake);
    snake._prevMouthX = mouth.x;
    snake._prevMouthY = mouth.y;
}

function foodPickupReach(snakeRadius, foodRadius) {
    return (snakeRadius + foodRadius) * SLITHER.foodPickupReachMult + SLITHER.foodPickupReachPad;
}

function foodWithinPickup(snake, fx, fy, foodRadius, mouth = null) {
    const pick = mouth || snakeMouthPoint(snake);
    const reach = foodPickupReach(pick.r, foodRadius);
    if (dist(pick.x, pick.y, fx, fy) <= reach) return true;

    const px = snake._prevMouthX;
    const py = snake._prevMouthY;
    if (px == null || py == null) return false;
    return distPointToSegment(fx, fy, px, py, pick.x, pick.y) <= reach;
}

function checkSelfCollision(_snake) {
    // Self-overlap is allowed — crossing your own body does not kill you.
    return false;
}

function checkSnakeCollisions(snake, allSnakes) {
    if (snake.spawnGraceUntil && Date.now() < snake.spawnGraceUntil) return null;
    const head = snake.segments[0];
    const r = headRadiusForBalance(snake.balance);
    for (const { entity: other } of allSnakes) {
        if (other.id === snake.id) continue;
        if (other.spawnGraceUntil && Date.now() < other.spawnGraceUntil) continue;
        for (let i = 0; i < other.segments.length; i += (i === 0 ? 1 : 3)) {
            const seg = other.segments[i];
            const segR = i === 0 ? headRadiusForBalance(other.balance) : headRadiusForBalance(other.balance) * 0.7;
            if (dist(head.x, head.y, seg.x, seg.y) < r * 0.65 + segR * 0.45) {
                return other;
            }
        }
    }
    return null;
}

function checkFoodCollisions(snake, room) {
    const mouth = snakeMouthPoint(snake);
    const sweep = (snake._prevMouthX != null)
        ? dist(snake._prevMouthX, snake._prevMouthY, mouth.x, mouth.y)
        : 0;

    for (let i = room.slitherFood.length - 1; i >= 0; i--) {
        const f = room.slitherFood[i];
        const foodR = f.radius || SLITHER.foodRadius;
        const reach = foodPickupReach(mouth.r, foodR) + sweep;
        const fdx = mouth.x - f.x;
        if (Math.abs(fdx) > reach) continue;
        const fdy = mouth.y - f.y;
        if (Math.abs(fdy) > reach) continue;
        if (foodWithinPickup(snake, f.x, f.y, foodR, mouth)) {
            applySlitherFoodPickup(snake, f, room);
            room.slitherFood.splice(i, 1);
        }
    }
}

/** Drop a dead snake's mass as pick-up food along its body (slither.io style). */
function dropSnakeAsFood(room, snake) {
    const mass = Math.max(0, snake.balance || 0);
    const dollars = Math.max(0, snake.dollarBalance ?? snake.balance ?? 0);
    const segs = snake.segments;
    if (mass <= 1e-9 || !segs?.length) return;

    const eco = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE);
    const blob = eco.foodBlobValue;
    const maxPellets = Math.min(segs.length * 4, 150, Math.max(segs.length, Math.floor(mass / eco.massPerPellet)));
    const pelletCount = Math.max(1, maxPellets);
    const massEach = mass / pelletCount;
    const dollarEach = dollars / pelletCount;

    for (let i = 0; i < pelletCount; i++) {
        const seg = segs[i % segs.length];
        const jitter = 14;
        room.slitherFood.push({
            id: randId(),
            x: seg.x + (Math.random() - 0.5) * jitter,
            y: seg.y + (Math.random() - 0.5) * jitter,
            balance: massEach,
            dollarValue: dollarEach,
            hue: Math.floor(Math.random() * 360),
            radius: SLITHER.foodRadius + Math.random() * 1.5,
            deathDrop: true,
        });
    }
}

function eliminateSnake(room, snake, killer, io, User, isHuman, returnToPool = true, Transaction = null) {
    const lostDollars = snake.dollarBalance ?? snake.balance ?? 0;

    if (killer && killer.id !== snake.id) {
        killer.kills = (killer.kills || 0) + 1;
    }

    // slither.io: victim mass drops as pellets; killer does not absorb balance
    if (snake.balance > 0 || lostDollars > 0) {
        if (killer || isHuman) {
            dropSnakeAsFood(room, snake);
        } else if (returnToPool) {
            room.foodPoolBalance += lostDollars;
        }
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
                amount: lostDollars,
                meta: {
                    reason: 'Arena Death',
                    event: 'death',
                    mode: 'slither',
                    entryFeeUsd: snake.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
                },
                status: 'confirmed',
            }).catch(err => console.error('Error logging slither death:', err));
        }
    } else {
        room.slitherBots = room.slitherBots.filter(b => b.id !== snake.id);
    }

    return lostDollars;
}

const MAX_NETWORK_SEGMENTS = 120;
const MAX_VISIBLE_FOOD = 320;
const SLITHER_FOOD_VIEW_EXTRA = 750;
const SLITHER_FOOD_BROADCAST_INTERVAL = 3;

function downsampleSegmentsForNetwork(segments, maxPoints = MAX_NETWORK_SEGMENTS) {
    if (segments.length <= maxPoints) {
        return segments.map(s => ({ x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10 }));
    }
    const step = Math.ceil(segments.length / maxPoints);
    const slim = [];
    for (let i = 0; i < segments.length; i += step) {
        const s = segments[i];
        slim.push({ x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10 });
    }
    const last = segments[segments.length - 1];
    const tail = slim[slim.length - 1];
    if (!tail || tail.x !== Math.round(last.x * 10) / 10 || tail.y !== Math.round(last.y * 10) / 10) {
        slim.push({ x: Math.round(last.x * 10) / 10, y: Math.round(last.y * 10) / 10 });
    }
    return slim;
}

function serializeSnake(snake, isYou) {
    const sct = snake.segments.length;
    const sc = scaleForSegmentCount(sct);
    const segments = downsampleSegmentsForNetwork(snake.segments, isYou ? MAX_NETWORK_SEGMENTS : 72);
    return {
        id: snake.id,
        name: snake.username,
        balance: snake.balance,
        color: snake.color,
        isBot: !!snake.isBot,
        isYou,
        segments,
        sct,
        angle: snake.angle || 0,
        sc,
        fam: snake.fam ?? 0,
        wsep: SLITHER.segmentSepFactor * sc,
        radius: SLITHER.baseRadius * sc,
        boost: !!snake.boost,
        ...(isYou ? { kills: snake.kills || 0 } : {}),
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

    const now = Date.now();
    if (!room._lastSlitherFoodSync) room._lastSlitherFoodSync = 0;
    if (now - room._lastSlitherFoodSync < 750) return;
    room._lastSlitherFoodSync = now;

    const densityScale = slitherFoodDensityScale();
    const goldenValueOnMap = room.slitherFood
        .filter(f => f.golden)
        .reduce((sum, f) => sum + slitherFoodDollarValue(f), 0);
    const foodValueTarget = Math.max(0, Math.min(humansInArena * densityPerHuman * densityScale, budget) - goldenValueOnMap);
    const targetFoodCount = Math.floor(foodValueTarget / foodBlobValue);
    const normalCount = room.slitherFood.filter(f => !f.golden && !f.deathDrop).length;

    const addThreshold = Math.floor(targetFoodCount * 0.94);
    const trimThreshold = Math.ceil(targetFoodCount * 1.12);

    if (normalCount < addThreshold) {
        addSlitherFood(
            room,
            Math.min(12, addThreshold - normalCount),
            foodBlobValue,
            foodValueTarget + goldenValueOnMap,
        );
    } else if (normalCount > trimThreshold) {
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
            const botWealth = snake.dollarBalance ?? snake.balance;
            if (botWealth > botMax) {
                toRemove.push({ snake, isHuman, killer: null, respawnBot: true, returnToPool: true });
                continue;
            }
            runSlitherBotAI(snake, allSnakes, room.slitherFood);
        }

        // Players keep moving while cashing out (no freeze) — getting eaten cancels the cashout
        updateSnakeMovement(snake, room);
        checkFoodCollisions(snake, room);

        if (isHuman && !isBR) {
            const minMass = minBalanceForSnake(snake);
            const minDollars = minDollarsForSnake(snake);
            const currentDollars = snake.dollarBalance ?? snake.balance;
            const decay = wealthTaxDecayAmount(currentDollars, minDollars);
            if (decay > 1e-9) {
                const actual = Math.min(decay, currentDollars - minDollars);
                if (snake.dollarBalance != null) {
                    snake.dollarBalance -= actual;
                } else {
                    snake.balance -= actual;
                }
                room.foodPoolBalance += actual;
                applyFamShrink(snake, actual);
            }
            if (snake.dollarBalance != null) {
                snake.dollarBalance = Math.max(minDollars, snake.dollarBalance);
            } else {
                snake.balance = Math.max(minDollars, snake.balance);
            }
            snake.balance = Math.max(minMass, snake.balance);
            if (snake.cells?.[0]) snake.cells[0].balance = snake.dollarBalance ?? snake.balance;
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
            const humansInArena = room.players.filter(p => p.mode === 'slither').length;
            const effectiveHumans = humansInArena > 0 ? humansInArena : (room.slitherBots.length > 0 ? 1 : 0);
            const targetBots = getSlitherTargetBots(effectiveHumans);
            if (room.slitherBots.length < targetBots) {
                addSlitherBots(room, 1, getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE).botStartBalance);
            }
        }
    }

    const slitherLeaderboard = getAllSlitherSnakes(room)
        .map(({ entity: s }) => ({
            id: s.id,
            name: s.username,
            massTotal: (s.dollarBalance ?? s.balance).toFixed(2),
            balance: (s.dollarBalance ?? s.balance).toFixed(2),
        }))
        .sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance))
        .slice(0, 10);

    return slitherLeaderboard;
}

export function broadcastSlitherState(room, io, slitherLeaderboard, meta) {
    const allSnakes = getAllSlitherSnakes(room);
    const range = SLITHER.viewRange;
    const foodRange = range + SLITHER_FOOD_VIEW_EXTRA;
    const now = Date.now();
    const sendLeaderboard = !room._lastLbAt || now - room._lastLbAt >= 500;
    if (sendLeaderboard) room._lastLbAt = now;

    room._slitherBroadcastTick = (room._slitherBroadcastTick || 0) + 1;
    const sendFoodThisTick = room._slitherBroadcastTick % SLITHER_FOOD_BROADCAST_INTERVAL === 0;

    room.players
        .filter(p => p.mode === 'slither' && !p.disconnected)
        .forEach(p => {
            const head = p.segments?.[0];
            if (!head) return;

            if (sendLeaderboard) {
                io.to(p.id).emit('leaderboard', { leaderboard: slitherLeaderboard, battleRoyale: !!meta.battleRoyale });
            }

            const visibleSnakes = allSnakes
                .filter(({ entity: s }) => {
                    const h = s.segments[0];
                    return isInView(head.x, head.y, h.x, h.y, range);
                })
                .map(({ entity: s }) => serializeSnake(s, s.id === p.id));

            let visibleFood = [];
            if (sendFoodThisTick || !room._lastSlitherFoodByPlayer?.[p.id]) {
                visibleFood = room.slitherFood
                    .filter(f => isInView(head.x, head.y, f.x, f.y, foodRange))
                    .map(f => ({
                        id: f.id,
                        x: f.x,
                        y: f.y,
                        hue: f.hue,
                        radius: f.radius || SLITHER.foodRadius,
                        golden: !!f.golden,
                        deathDrop: !!f.deathDrop,
                    }));
                if (visibleFood.length > MAX_VISIBLE_FOOD) {
                    visibleFood.sort((a, b) => {
                        const da = (a.x - head.x) ** 2 + (a.y - head.y) ** 2;
                        const db = (b.x - head.x) ** 2 + (b.y - head.y) ** 2;
                        return da - db;
                    });
                    visibleFood = visibleFood.slice(0, MAX_VISIBLE_FOOD);
                }
                if (!room._lastSlitherFoodByPlayer) room._lastSlitherFoodByPlayer = {};
                room._lastSlitherFoodByPlayer[p.id] = visibleFood;
            } else {
                visibleFood = room._lastSlitherFoodByPlayer[p.id] || [];
            }

            const minimapPlayers = allSnakes.map(({ entity: s }) => {
                const h = s.segments[0];
                if (!h) return null;
                if (!isInView(head.x, head.y, h.x, h.y, SLITHER.minimapThreatRange)) return null;
                return {
                    x: Math.round(h.x),
                    y: Math.round(h.y),
                    you: s.id === p.id,
                };
            }).filter(Boolean);

            const minimapFood = room.slitherFood
                .filter(f => isInView(head.x, head.y, f.x, f.y, SLITHER.minimapRange))
                .map(f => ({
                    x: Math.round(f.x),
                    y: Math.round(f.y),
                    g: !!f.golden,
                    h: f.hue,
                }));
            if (minimapFood.length > 200) {
                minimapFood.sort((a, b) => {
                    const da = (a.x - head.x) ** 2 + (a.y - head.y) ** 2;
                    const db = (b.x - head.x) ** 2 + (b.y - head.y) ** 2;
                    return da - db;
                });
                minimapFood.length = 200;
            }

            const minimap = {
                players: minimapPlayers,
                food: minimapFood,
            };

            io.to(p.id).emit('slitherTick', {
                you: p.id,
                snakes: visibleSnakes,
                food: visibleFood,
                worldHalf: SLITHER.worldHalf,
                minimap,
                ...meta,
                ...(meta.battleRoyale ? {} : { balance: p.dollarBalance ?? p.balance }),
            });
        });
}

export function createSlitherPlayer(socketId, mongoId, username, color, room, startMass = 1.0, dollarStart = 1.0) {
    const { x, y } = pickSlitherSpawn(room);
    const balance = startMass;
    const angle = Math.random() * Math.PI * 2;
    return {
        id: socketId,
        mongoId,
        username,
        mode: 'slither',
        kills: 0,
        balance,
        dollarBalance: dollarStart,
        entryFeeUsd: room.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
        startTime: Date.now(),
        spawnGraceUntil: Date.now() + 4500,
        color,
        x,
        y,
        inputDx: Math.cos(angle),
        inputDy: Math.sin(angle),
        boost: false,
        angle,
        fam: 0,
        segments: createSegments(x, y, balance, angle),
        screenWidth: 1920,
        screenHeight: 1080,
        cells: [{
            id: randId(),
            x,
            y,
            balance: dollarStart,
            radius: headRadiusForBalance(balance),
            vx: 0,
            vy: 0,
            lastSplit: Date.now(),
        }],
    };
}

// ─── Competitive Slither ───────────────────────────────────────────────────
// Snake mass (balance) and dollar balance are fully independent systems.

export const COMPETITIVE_SLITHER = {
    worldHalf: SLITHER.worldHalf * 0.3,
    shrinkBeforeResetMs: 2 * 60 * 1000,
    foodRadius: SLITHER.foodRadius,
    deathFoodRadius: SLITHER.foodRadius * 1.35,
    foodDensityPerHuman: 125,
};

function competitiveFoodDensityScale() {
    const side = COMPETITIVE_SLITHER.worldHalf * 2;
    return (side * side) / (AGAR_WORLD_SIDE * AGAR_WORLD_SIDE);
}

function randomCompetitiveSpawnCoord() {
    const maxR = COMPETITIVE_SLITHER.worldHalf * 0.85;
    const r = maxR * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function isCompetitiveSpawnClear(room, x, y, minDist = 120) {
    for (const { entity: s } of getCompetitiveSnakes(room)) {
        const r = headRadiusForBalance(s.balance ?? competitiveMinMass(room.entryFeeUsd));
        const spacing = segmentSpacingForBalance(s.balance ?? competitiveMinMass(room.entryFeeUsd));
        const bodyLen = (s.segments?.length ?? 1) * spacing;
        for (let i = 0; i < (s.segments?.length ?? 0); i++) {
            const seg = s.segments[i];
            const segR = i === 0 ? r : r * 0.75;
            const need = minDist + segR + (i === 0 ? 0 : bodyLen * 0.15);
            if (dist(x, y, seg.x, seg.y) < need) return false;
        }
    }
    return true;
}

function pickCompetitiveSpawn(room) {
    for (let i = 0; i < 80; i++) {
        const { x, y } = randomCompetitiveSpawnCoord();
        if (isCompetitiveSpawnClear(room, x, y, 120)) return { x, y };
    }
    return randomCompetitiveSpawnCoord();
}

export function getCompetitiveEffectiveRadius(resetTime) {
    const worldHalf = COMPETITIVE_SLITHER.worldHalf;
    const msUntilReset = resetTime - Date.now();
    const shrinkMs = COMPETITIVE_SLITHER.shrinkBeforeResetMs;
    if (msUntilReset >= shrinkMs) return worldHalf;
    if (msUntilReset <= 0) return 0;
    return worldHalf * (msUntilReset / shrinkMs);
}

export function getCompetitiveZone(resetTime) {
    const radius = getCompetitiveEffectiveRadius(resetTime);
    const msUntilReset = resetTime - Date.now();
    return {
        cx: 0,
        cy: 0,
        radius,
        shrinking: msUntilReset < COMPETITIVE_SLITHER.shrinkBeforeResetMs,
    };
}

function getCompetitiveSnakes(room) {
    return room.players
        .filter(p => p.mode === 'competitive-slither' && !p.disconnected && p.segments?.length)
        .map(p => ({ entity: p, isHuman: true }));
}

function competitiveMinMass(entryFeeUsd) {
    return getCompetitiveEconomy(entryFeeUsd).playerStartBalance;
}

function updateCompetitiveSnakeMovement(snake) {
    const head = snake.segments[0];
    rememberSnakeMouthBeforeMove(snake);
    const { dx, dy } = normalizeSnakeInput(snake);
    const massRef = competitiveMinMass(snake.entryFeeUsd);

    const desired = Math.atan2(dy, dx);
    const scang = scangForSegmentCount(snake.segments.length);
    const maxTurn = (SLITHER.turnRate * scang) / SLITHER.serverTickRate;
    const current = snake.angle ?? desired;
    let da = desired - current;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (da > maxTurn) da = maxTurn;
    else if (da < -maxTurn) da = -maxTurn;
    snake.angle = current + da;

    const minMass = massRef;
    const canBoost = !!snake.boost && snake.balance > minMass * 1.01;

    const mx = Math.cos(snake.angle);
    const my = Math.sin(snake.angle);
    const step = speedForBalance(snake.balance, canBoost, massRef);
    head.x += mx * step;
    head.y += my * step;

    if (canBoost) {
        const cost = Math.min(SLITHER.boostCostPerTick, snake.balance - minMass);
        snake.balance -= cost;
        applyFamShrink(snake, cost);
    }

    const spacing = segmentSpacingForSegmentCount(snake.segments.length);
    updateSnakeBodyFromPath(snake, spacing);

    snake.x = head.x;
    snake.y = head.y;
    snake.balance = Math.max(minMass, snake.balance);
}

function checkCompetitiveBoundary(snake, effectiveRadius) {
    const head = snake.segments[0];
    const r = headRadiusForBalance(snake.balance);
    return Math.hypot(head.x, head.y) + r > effectiveRadius;
}

function checkCompetitiveFoodCollisions(snake, room) {
    const mouth = snakeMouthPoint(snake);
    const sweep = (snake._prevMouthX != null)
        ? dist(snake._prevMouthX, snake._prevMouthY, mouth.x, mouth.y)
        : 0;

    for (let i = room.slitherFood.length - 1; i >= 0; i--) {
        const f = room.slitherFood[i];
        const foodR = f.radius || COMPETITIVE_SLITHER.foodRadius;
        const reach = foodPickupReach(mouth.r, foodR) + sweep;
        const fdx = mouth.x - f.x;
        if (Math.abs(fdx) > reach) continue;
        const fdy = mouth.y - f.y;
        if (Math.abs(fdy) > reach) continue;
        if (foodWithinPickup(snake, f.x, f.y, foodR, mouth)) {
            const gain = f.balance;
            snake.balance += gain;
            if (f.dollarValue > 1e-9) {
                snake.dollarBalance = (snake.dollarBalance || 0) + f.dollarValue;
            }
            snake.fam = (snake.fam || 0) + gain / famVolumeForSegment(snake.segments.length);
            applyFamGrowth(snake);
            room.slitherFood.splice(i, 1);
        }
    }
}

function dropCompetitiveSnakeAsFood(room, snake) {
    const mass = Math.max(0, snake.balance || 0);
    const dollars = Math.max(0, snake.dollarBalance || 0);
    const segs = snake.segments;
    if (mass <= 1e-9 || !segs?.length) return;

    const blob = getCompetitiveEconomy(room.entryFeeUsd).massPerPellet;
    const maxPellets = Math.min(segs.length * 4, 150, Math.max(segs.length, Math.floor(mass / blob)));
    const pelletCount = Math.max(1, maxPellets);
    const massEach = mass / pelletCount;
    const dollarEach = dollars / pelletCount;

    for (let i = 0; i < pelletCount; i++) {
        const seg = segs[i % segs.length];
        const jitter = 14;
        room.slitherFood.push({
            id: randId(),
            x: seg.x + (Math.random() - 0.5) * jitter,
            y: seg.y + (Math.random() - 0.5) * jitter,
            balance: massEach,
            dollarValue: dollarEach,
            hue: 48,
            golden: true,
            deathDrop: true,
            competitiveDeathDrop: true,
            radius: COMPETITIVE_SLITHER.deathFoodRadius,
        });
    }
}

function eliminateCompetitiveSnake(room, snake, killer, io, User, Transaction) {
    if (killer && killer.id !== snake.id) {
        killer.kills = (killer.kills || 0) + 1;
    }

    dropCompetitiveSnakeAsFood(room, snake);

    const socketId = snake.id;
    const head = snake.segments?.[0];
    if (!room.competitiveSpectators) room.competitiveSpectators = [];
    room.competitiveSpectators = room.competitiveSpectators.filter(s => s.id !== socketId);
    room.competitiveSpectators.push({
        id: socketId,
        mongoId: snake.mongoId,
        x: head?.x ?? snake.x ?? 0,
        y: head?.y ?? snake.y ?? 0,
        dollarBalance: snake.dollarBalance,
    });
    if (room._lastCompFoodByPlayer) {
        delete room._lastCompFoodByPlayer[socketId];
    }

    io.to(socketId).emit('RIP');
    room.players = room.players.filter(p => p.id !== snake.id);
    User.findByIdAndUpdate(snake.mongoId, { $inc: { playtime: Date.now() - snake.startTime } }).catch(() => {});
    if (Transaction && snake.mongoId) {
        Transaction.create({
            userId: snake.mongoId,
            type: 'game',
            amount: snake.dollarBalance || 0,
            meta: {
                reason: 'Competitive Slither Death',
                event: 'death',
                mode: 'competitive-slither',
                entryFeeUsd: snake.entryFeeUsd ?? room.entryFeeUsd,
            },
            status: 'confirmed',
        }).catch(err => console.error('Error logging competitive slither death:', err));
    }
}

export function addCompetitiveSlitherFood(room, n) {
    const massPerPellet = getCompetitiveEconomy(room.entryFeeUsd).massPerPellet;
    for (let i = 0; i < n; i++) {
        const { x, y } = randomCompetitiveSpawnCoord();
        room.slitherFood.push({
            id: randId(),
            x,
            y,
            balance: massPerPellet,
            hue: Math.floor(Math.random() * 360),
            radius: COMPETITIVE_SLITHER.foodRadius,
        });
    }
}

export function syncCompetitiveSlitherFood(room, playerCount) {
    if (playerCount <= 0) {
        const protectedFood = room.slitherFood.filter(f => f.competitiveDeathDrop);
        room.slitherFood = protectedFood;
        return;
    }

    const now = Date.now();
    if (!room._lastCompetitiveFoodSync) room._lastCompetitiveFoodSync = 0;
    if (now - room._lastCompetitiveFoodSync < 750) return;
    room._lastCompetitiveFoodSync = now;

    const densityScale = competitiveFoodDensityScale();
    const target = Math.max(40, Math.floor(playerCount * COMPETITIVE_SLITHER.foodDensityPerHuman * densityScale));
    const normalCount = room.slitherFood.filter(f => !f.competitiveDeathDrop).length;

    if (normalCount < target * 0.94) {
        addCompetitiveSlitherFood(room, Math.min(12, Math.floor(target * 0.94) - normalCount));
    } else if (normalCount > target * 1.12) {
        trimSlitherFood(room, target);
    }
}

export function createCompetitiveSlitherPlayer(socketId, mongoId, username, color, room) {
    const eco = getCompetitiveEconomy(room.entryFeeUsd);
    const startMass = eco.playerStartBalance;
    const { x, y } = pickCompetitiveSpawn(room);
    const angle = Math.random() * Math.PI * 2;
    return {
        id: socketId,
        mongoId,
        username,
        mode: 'competitive-slither',
        kills: 0,
        balance: startMass,
        dollarBalance: eco.dollarStart,
        entryFeeUsd: eco.entryFeeUsd,
        startTime: Date.now(),
        spawnGraceUntil: Date.now() + 4500,
        color,
        x,
        y,
        inputDx: Math.cos(angle),
        inputDy: Math.sin(angle),
        boost: false,
        angle,
        fam: 0,
        segments: createSegments(x, y, startMass, angle),
        screenWidth: 1920,
        screenHeight: 1080,
    };
}

function serializeCompetitiveSnake(snake, isYou) {
    const sct = snake.segments.length;
    const sc = scaleForSegmentCount(sct);
    const segments = downsampleSegmentsForNetwork(snake.segments, isYou ? MAX_NETWORK_SEGMENTS : 72);
    return {
        id: snake.id,
        name: snake.username,
        balance: snake.balance,
        dollarBalance: snake.dollarBalance,
        color: snake.color,
        isBot: false,
        isYou,
        segments,
        sct,
        angle: snake.angle || 0,
        sc,
        fam: snake.fam ?? 0,
        wsep: SLITHER.segmentSepFactor * sc,
        radius: SLITHER.baseRadius * sc,
        boost: !!snake.boost,
        ...(isYou ? { kills: snake.kills || 0 } : {}),
    };
}

export function processCompetitiveSlitherRoom(room, io, User, Transaction, resetTime) {
    const effectiveRadius = getCompetitiveEffectiveRadius(resetTime);
    const allSnakes = getCompetitiveSnakes(room);
    const toRemove = [];

    for (const { entity: snake } of allSnakes) {
        updateCompetitiveSnakeMovement(snake);
        checkCompetitiveFoodCollisions(snake, room);

        if (checkCompetitiveBoundary(snake, effectiveRadius) || checkSelfCollision(snake)) {
            toRemove.push({ snake, killer: null });
            continue;
        }

        const hit = checkSnakeCollisions(snake, allSnakes);
        if (hit) {
            toRemove.push({ snake, killer: hit });
        }
    }

    for (const { snake, killer } of toRemove) {
        eliminateCompetitiveSnake(room, snake, killer, io, User, Transaction);
    }

    return getCompetitiveSnakes(room)
        .map(({ entity: s }) => ({
            id: s.id,
            name: s.username,
            massTotal: (s.dollarBalance || 0).toFixed(2),
            balance: (s.dollarBalance || 0).toFixed(2),
        }))
        .sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance))
        .slice(0, 10);
}

export function broadcastCompetitiveSlitherState(room, io, leaderboard, meta) {
    const allSnakes = getCompetitiveSnakes(room);
    const range = SLITHER.viewRange * 0.65;
    const foodRange = range + SLITHER_FOOD_VIEW_EXTRA * 0.65;
    const now = Date.now();
    const sendLeaderboard = !room._lastCompLbAt || now - room._lastCompLbAt >= 500;
    if (sendLeaderboard) room._lastCompLbAt = now;

    room._compSlitherBroadcastTick = (room._compSlitherBroadcastTick || 0) + 1;
    const sendFoodThisTick = room._compSlitherBroadcastTick % SLITHER_FOOD_BROADCAST_INTERVAL === 0;

    const emitTickToViewer = (viewer) => {
        const { socketId, viewX, viewY, youId, dollarBalance, spectating } = viewer;
        const head = { x: viewX, y: viewY };

        if (sendLeaderboard) {
            io.to(socketId).emit('leaderboard', { leaderboard, competitiveSlither: true });
        }

        const visibleSnakes = allSnakes
            .filter(({ entity: s }) => {
                const h = s.segments[0];
                return isInView(head.x, head.y, h.x, h.y, range);
            })
            .map(({ entity: s }) => serializeCompetitiveSnake(s, s.id === youId));

        let visibleFood = [];
        const refreshFood = spectating
            || sendFoodThisTick
            || !room._lastCompFoodByPlayer?.[socketId];
        if (refreshFood) {
            visibleFood = room.slitherFood
                .filter(f => isInView(head.x, head.y, f.x, f.y, foodRange))
                .map(f => ({
                    id: f.id,
                    x: f.x,
                    y: f.y,
                    hue: f.hue,
                    radius: f.radius || COMPETITIVE_SLITHER.foodRadius,
                    golden: !!f.golden,
                    deathDrop: !!f.deathDrop,
                }));
            if (visibleFood.length > MAX_VISIBLE_FOOD) {
                visibleFood.sort((a, b) => {
                    const da = (a.x - head.x) ** 2 + (a.y - head.y) ** 2;
                    const db = (b.x - head.x) ** 2 + (b.y - head.y) ** 2;
                    return da - db;
                });
                visibleFood = visibleFood.slice(0, MAX_VISIBLE_FOOD);
            }
            if (!spectating) {
                if (!room._lastCompFoodByPlayer) room._lastCompFoodByPlayer = {};
                room._lastCompFoodByPlayer[socketId] = visibleFood;
            }
        } else {
            visibleFood = room._lastCompFoodByPlayer[socketId] || [];
        }

        const minimapPlayers = allSnakes.map(({ entity: s }) => {
            const h = s.segments[0];
            if (!h) return null;
            if (!isInView(head.x, head.y, h.x, h.y, SLITHER.minimapThreatRange * 0.65)) return null;
            return { x: Math.round(h.x), y: Math.round(h.y), you: s.id === youId };
        }).filter(Boolean);

        const minimapFood = room.slitherFood
            .filter(f => isInView(head.x, head.y, f.x, f.y, SLITHER.minimapRange * 0.65))
            .map(f => ({
                x: Math.round(f.x),
                y: Math.round(f.y),
                g: !!f.golden,
                h: f.hue,
            }));
        if (minimapFood.length > 200) {
            minimapFood.sort((a, b) => {
                const da = (a.x - head.x) ** 2 + (a.y - head.y) ** 2;
                const db = (b.x - head.x) ** 2 + (b.y - head.y) ** 2;
                return da - db;
            });
            minimapFood.length = 200;
        }

        io.to(socketId).emit('slitherTick', {
            you: youId,
            spectating: !!spectating,
            snakes: visibleSnakes,
            food: visibleFood,
            worldHalf: COMPETITIVE_SLITHER.worldHalf,
            minimap: { players: minimapPlayers, food: minimapFood },
            competitiveSlither: true,
            circularMap: true,
            zone: meta.zone,
            dollarBalance,
            ...meta,
        });
    };

    room.players
        .filter(p => p.mode === 'competitive-slither' && !p.disconnected)
        .forEach(p => {
            const head = p.segments?.[0];
            if (!head) return;
            emitTickToViewer({
                socketId: p.id,
                viewX: head.x,
                viewY: head.y,
                youId: p.id,
                dollarBalance: p.dollarBalance,
                spectating: false,
            });
        });

    (room.competitiveSpectators || []).forEach(spec => {
        emitTickToViewer({
            socketId: spec.id,
            viewX: spec.x,
            viewY: spec.y,
            youId: null,
            dollarBalance: spec.dollarBalance,
            spectating: true,
        });
    });
}
