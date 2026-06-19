import * as util from './utils.js';
import { getEconomy, DEFAULT_ENTRY_FEE, wealthTaxDecayAmount, getCompetitiveEconomy, getJoinPoolSplit } from './economy.js';

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

export function trimSlitherFood(room, targetCount) {
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

/** Trim only pool-spawned pellets when total count is high — never removes deathDrop or golden loot. */
export function enforceSlitherFoodCap(room, maxTotal = MAX_SLITHER_FOOD_TOTAL) {
    if (!room.slitherFood?.length || room.slitherFood.length <= maxTotal) return;

    const protectedCount = room.slitherFood.filter(f => f.golden || f.deathDrop).length;
    const maxNormal = Math.max(0, maxTotal - protectedCount);
    const normalCount = room.slitherFood.filter(f => !f.golden && !f.deathDrop).length;
    if (normalCount > maxNormal) {
        trimSlitherFood(room, maxNormal);
    }
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

export function createSegments(x, y, balance, angle = 0, bend = 0) {
    const count = balanceToSegmentCount(balance);
    const spacing = segmentSpacingForBalance(balance);
    const segs = [{ x, y }];
    for (let i = 1; i < count; i++) {
        const segAngle = angle + bend * (i - 1);
        const prev = segs[i - 1];
        segs.push({
            x: prev.x - Math.cos(segAngle) * spacing,
            y: prev.y - Math.sin(segAngle) * spacing,
        });
    }
    return segs;
}

/** Random point inside the active play area (sandbox zone, sandbox world, or default arena). */
export function randomCoordInRoom(room) {
    if (room?.isSandbox && room.sandboxZone) {
        const z = room.sandboxZone;
        const maxR = Math.max(40, z.radius * 0.82);
        const ang = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * maxR;
        return {
            x: (z.cx ?? 0) + Math.cos(ang) * r,
            y: (z.cy ?? 0) + Math.sin(ang) * r,
        };
    }
    const half = room?.sandboxWorldHalf ?? SLITHER.worldHalf;
    const h = half * 0.85;
    return {
        x: (Math.random() - 0.5) * 2 * h,
        y: (Math.random() - 0.5) * 2 * h,
    };
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
        const { x, y } = randomCoordInRoom(room);
        if (isSpawnClear(room, x, y, 180)) return { x, y };
    }
    for (let i = 0; i < 40; i++) {
        const { x, y } = randomCoordInRoom(room);
        if (isSpawnClear(room, x, y, 120)) return { x, y };
    }
    return randomCoordInRoom(room);
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
        const { x, y } = randomCoordInRoom(room);
        room.slitherFood.push({
            id: randId(),
            x,
            y,
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
        const { x, y } = randomCoordInRoom(room);
        room.slitherFood.push({
            id: randId(),
            x,
            y,
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

/**
 * Max slither bots for active human count. Bots never count as humans.
 * Matches entry-fee tiers: 2 bots/entry (<3 humans), 1 bot/entry (3–8), none (9+).
 * 1→2, 2→4, 3→5, 4→6, … 8→10
 */
export function getSlitherTargetBots(humanCount) {
    if (humanCount <= 0) return 0;
    if (humanCount > 8) return 0;
    if (humanCount < 3) return humanCount * 2;
    return Math.min(humanCount, 2) * 2 + Math.max(0, humanCount - 2);
}

/** Bots this entry fee funds (20% slice at $10 = $2 or $1 per tier). */
export function slitherBotsFundedPerEntry(entryFeeUsd, activeHumansAfterJoin, botStake) {
    const { ai } = getJoinPoolSplit(entryFeeUsd, activeHumansAfterJoin);
    return Math.floor(ai / botStake);
}

/** How many bots may spawn this tick — throttles when the arena is already bot-heavy. */
export function slitherBotsToSpawn(room, targetBots) {
    const current = room.slitherBots.length;
    if (current >= 7) return 0;
    const needed = Math.max(0, targetBots - current);
    if (needed <= 0) return 0;
    if (current >= 4) return Math.min(needed, 1);
    return needed;
}

/** Spawn slither bots up to the population target; never despawn live bots when humans leave or die. */
export function syncSlitherBots(room, humanCount, botStake = SLITHER.botStartBalance, maxSpawn = Infinity) {
    const target = getSlitherTargetBots(humanCount);
    let toSpawn = slitherBotsToSpawn(room, target);
    if (Number.isFinite(maxSpawn)) {
        toSpawn = Math.min(toSpawn, maxSpawn);
    }
    if (toSpawn > 0) {
        addSlitherBots(room, toSpawn, botStake);
    }
}

function getAllSlitherSnakes(room) {
    const humans = room.players
        .filter(p => p.mode === 'slither' && !p.disconnected && p.segments?.length)
        .map(p => ({ entity: p, isHuman: true }));
    const bots = room.slitherBots.map(b => ({ entity: b, isHuman: false }));
    const statics = (room.sandboxStaticWorms || []).map(s => ({ entity: s, isHuman: false }));
    return [...humans, ...bots, ...statics];
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

/** Normal slither: HUD dollars and snake mass move together. Arena / BR keep them separate. */
function isCoupledSlitherRoom(room) {
    return !!room && !room.isBattleRoyale && !room.isCompetitiveSlither && !room.isSandbox;
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
    const speedMult = room?.sandboxSpeedMultiplier ?? 1;
    const step = speedForBalance(snake.balance, canBoost) * speedMult;
    head.x += mx * step;
    head.y += my * step;

    if (canBoost && room) {
        const cost = Math.min(SLITHER.boostCostPerTick, snake.balance - minBal);
        snake.balance -= cost;
        applyFamShrink(snake, cost);

        let poolCredit = cost;
        // Normal mode: boost spends HUD balance too (size and dollars stay linked).
        if (isCoupledSlitherRoom(room) && snake.dollarBalance != null) {
            const dollarFloor = minDollarsForSnake(snake);
            const dollarCost = Math.min(cost, Math.max(0, snake.dollarBalance - dollarFloor));
            if (dollarCost > 1e-9) {
                snake.dollarBalance -= dollarCost;
            }
            poolCredit = dollarCost;
            if (snake.cells?.[0]) snake.cells[0].balance = snake.dollarBalance;
        }
        room.foodPoolBalance += poolCredit;
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
function findNearestFoodForBot(head, food, foodGrid, minDistFood) {
    let nearestFood = null;
    let nearestFoodDist2 = minDistFood * minDistFood;

    const tryFood = (f) => {
        const fdx = head.x - f.x;
        if (fdx > minDistFood || fdx < -minDistFood) return;
        const fdy = head.y - f.y;
        if (fdy > minDistFood || fdy < -minDistFood) return;
        const d2 = fdx * fdx + fdy * fdy;
        if (d2 < nearestFoodDist2) {
            nearestFoodDist2 = d2;
            nearestFood = f;
        }
    };

    if (foodGrid) {
        const minCx = Math.floor((head.x - minDistFood) / SLITHER_FOOD_CELL);
        const maxCx = Math.floor((head.x + minDistFood) / SLITHER_FOOD_CELL);
        const minCy = Math.floor((head.y - minDistFood) / SLITHER_FOOD_CELL);
        const maxCy = Math.floor((head.y + minDistFood) / SLITHER_FOOD_CELL);
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const bucket = foodGrid.get(`${cx},${cy}`);
                if (!bucket) continue;
                for (const f of bucket) tryFood(f);
            }
        }
    } else {
        for (const f of food) tryFood(f);
    }
    return nearestFood;
}

function runSlitherBotAI(snake, allSnakes, food, foodGrid = null) {
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
        const nearestFood = findNearestFoodForBot(head, food, foodGrid, minDistFood);

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
    const head = snake.segments?.[0];
    if (head) {
        snake._prevHeadX = head.x;
        snake._prevHeadY = head.y;
    }
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
    if (!head) return null;
    const r = headRadiusForBalance(snake.balance);
    const headReach = r * 0.72;
    const px = snake._prevHeadX;
    const py = snake._prevHeadY;
    const hasSweep = px != null && py != null;

    for (const { entity: other } of allSnakes) {
        if (other.id === snake.id) continue;
        if (other.spawnGraceUntil && Date.now() < other.spawnGraceUntil) continue;
        const segs = other.segments;
        if (!segs?.length) continue;

        const otherR = headRadiusForBalance(other.balance);
        const bodyR = otherR * 0.72;
        const spacing = segmentSpacingForBalance(other.balance);
        const bodyReach = segs.length * spacing + otherR + headReach + 40;
        if (dist(head.x, head.y, segs[0].x, segs[0].y) > bodyReach) continue;

        const pointHitHead = headReach + otherR * 0.82 * 0.52;
        const pointHitBody = headReach + bodyR * 0.52;
        const lineHit = headReach + bodyR * 0.48;
        const pointStride = segs.length > 80 ? 2 : 1;

        for (let i = 0; i < segs.length; i += pointStride) {
            const seg = segs[i];
            const hit = i === 0 ? pointHitHead : pointHitBody;
            if (dist(head.x, head.y, seg.x, seg.y) < hit) return other;
            if (hasSweep && distPointToSegment(seg.x, seg.y, px, py, head.x, head.y) < hit) return other;
        }

        const lineStride = segs.length > 120 ? 2 : 1;
        for (let i = 1; i < segs.length; i += lineStride) {
            const prev = segs[i - 1];
            const seg = segs[i];
            const mx = (prev.x + seg.x) * 0.5;
            const my = (prev.y + seg.y) * 0.5;
            if (dist(head.x, head.y, mx, my) > lineHit + spacing * lineStride) continue;
            if (distPointToSegment(head.x, head.y, prev.x, prev.y, seg.x, seg.y) < lineHit) return other;
            if (hasSweep && distPointToSegment(px, py, prev.x, prev.y, seg.x, seg.y) < lineHit) return other;
        }
    }
    return null;
}

const SLITHER_FOOD_CELL = 64;

function buildSlitherFoodGrid(food) {
    const grid = new Map();
    for (const f of food) {
        const cx = Math.floor(f.x / SLITHER_FOOD_CELL);
        const cy = Math.floor(f.y / SLITHER_FOOD_CELL);
        const key = `${cx},${cy}`;
        let bucket = grid.get(key);
        if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
        }
        bucket.push(f);
    }
    return grid;
}

/** Reuse one spatial grid per physics tick — avoids rebuilding in process + broadcast. */
function getSlitherFoodGridForRoom(room) {
    if (!room.slitherFood?.length || room.slitherFood.length <= 80) return null;
    const tick = room._slitherPhysicsTick ?? 0;
    if (room._slitherFoodGrid && room._slitherFoodGridTick === tick) {
        return room._slitherFoodGrid;
    }
    room._slitherFoodGrid = buildSlitherFoodGrid(room.slitherFood);
    room._slitherFoodGridTick = tick;
    return room._slitherFoodGrid;
}

function serializeVisibleSlitherFood(f, radius = SLITHER.foodRadius) {
    return {
        id: f.id,
        x: f.x,
        y: f.y,
        hue: f.hue,
        radius: f.radius || radius,
        golden: !!f.golden,
        deathDrop: !!f.deathDrop,
    };
}

/** Spatial query for network culling — avoids scanning all pellets per player. */
function collectSlitherFoodInView(food, foodGrid, hx, hy, range, maxCount, radius = SLITHER.foodRadius) {
    const inRange = [];
    if (foodGrid) {
        const minCx = Math.floor((hx - range) / SLITHER_FOOD_CELL);
        const maxCx = Math.floor((hx + range) / SLITHER_FOOD_CELL);
        const minCy = Math.floor((hy - range) / SLITHER_FOOD_CELL);
        const maxCy = Math.floor((hy + range) / SLITHER_FOOD_CELL);
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const bucket = foodGrid.get(`${cx},${cy}`);
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) {
                    const f = bucket[i];
                    const dx = f.x - hx;
                    if (Math.abs(dx) > range) continue;
                    const dy = f.y - hy;
                    if (Math.abs(dy) > range) continue;
                    inRange.push(f);
                }
            }
        }
    } else {
        for (let i = 0; i < food.length; i++) {
            const f = food[i];
            if (isInView(hx, hy, f.x, f.y, range)) inRange.push(f);
        }
    }

    if (inRange.length <= maxCount) {
        return inRange.map(f => serializeVisibleSlitherFood(f, radius));
    }
    inRange.sort((a, b) => {
        const da = (a.x - hx) ** 2 + (a.y - hy) ** 2;
        const db = (b.x - hx) ** 2 + (b.y - hy) ** 2;
        return da - db;
    });
    inRange.length = maxCount;
    return inRange.map(f => serializeVisibleSlitherFood(f, radius));
}

function collectMinimapFood(food, foodGrid, hx, hy, range, maxCount) {
    const visible = collectSlitherFoodInView(food, foodGrid, hx, hy, range, maxCount);
    const out = new Array(visible.length);
    for (let i = 0; i < visible.length; i++) {
        const f = visible[i];
        out[i] = {
            x: Math.round(f.x),
            y: Math.round(f.y),
            g: !!f.golden,
            h: f.hue,
        };
    }
    return out;
}

function checkFoodCollisions(snake, room, foodGrid = null) {
    const mouth = snakeMouthPoint(snake);
    const sweep = (snake._prevMouthX != null)
        ? dist(snake._prevMouthX, snake._prevMouthY, mouth.x, mouth.y)
        : 0;
    const maxReach = foodPickupReach(mouth.r, SLITHER.foodRadius) + sweep + 8;

    const tryPickup = (f) => {
        const idx = room.slitherFood.indexOf(f);
        if (idx < 0) return false;
        const foodR = f.radius || SLITHER.foodRadius;
        const reach = foodPickupReach(mouth.r, foodR) + sweep;
        const fdx = mouth.x - f.x;
        if (Math.abs(fdx) > reach) return false;
        const fdy = mouth.y - f.y;
        if (Math.abs(fdy) > reach) return false;
        if (!foodWithinPickup(snake, f.x, f.y, foodR, mouth)) return false;
        applySlitherFoodPickup(snake, f, room);
        room.slitherFood.splice(idx, 1);
        return true;
    };

    if (foodGrid) {
        const minCx = Math.floor((mouth.x - maxReach) / SLITHER_FOOD_CELL);
        const maxCx = Math.floor((mouth.x + maxReach) / SLITHER_FOOD_CELL);
        const minCy = Math.floor((mouth.y - maxReach) / SLITHER_FOOD_CELL);
        const maxCy = Math.floor((mouth.y + maxReach) / SLITHER_FOOD_CELL);
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const bucket = foodGrid.get(`${cx},${cy}`);
                if (!bucket) continue;
                for (let i = bucket.length - 1; i >= 0; i--) {
                    tryPickup(bucket[i]);
                }
            }
        }
        return;
    }

    for (let i = room.slitherFood.length - 1; i >= 0; i--) {
        tryPickup(room.slitherFood[i]);
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
        if (snake.mongoId) {
            User.findByIdAndUpdate(snake.mongoId, { $inc: { playtime: Date.now() - snake.startTime } }).catch(() => {});
        }
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
const MAX_VISIBLE_FOOD = 130;
const MAX_SLITHER_FOOD_TOTAL = 700;
const MAX_MINIMAP_FOOD = 40;
const MAX_COMP_MINIMAP_FOOD = 28;
const SLITHER_MINIMAP_BROADCAST_INTERVAL = 5;
/** Extra beyond snake viewRange — tuned to client viewport (~W/2/zoom + margin), not whole arena. */
const SLITHER_FOOD_VIEW_EXTRA = 200;
const SLITHER_FOOD_BROADCAST_INTERVAL = 5;
/** Physics at 40Hz; network state at ~10Hz — client interpolates between ticks. */
const SLITHER_STATE_BROADCAST_INTERVAL = 4;

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
    const segments = downsampleSegmentsForNetwork(snake.segments, isYou ? MAX_NETWORK_SEGMENTS : 40);
    return {
        id: snake.id,
        name: snake.username,
        balance: snake.balance,
        dollarBalance: snake.dollarBalance ?? snake.balance,
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
    let goldenValueOnMap = 0;
    let normalCount = 0;
    for (const f of room.slitherFood) {
        if (f.golden) goldenValueOnMap += slitherFoodDollarValue(f);
        else if (!f.deathDrop) normalCount++;
    }
    const foodValueTarget = Math.max(0, Math.min(humansInArena * densityPerHuman * densityScale, budget) - goldenValueOnMap);
    const targetFoodCount = Math.floor(foodValueTarget / foodBlobValue);

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
    enforceSlitherFoodCap(room);
}

/**
 * Run one slither physics tick. Returns leaderboard entries for slither mode.
 */
export function processSlitherRoom(room, io, User, Transaction = null) {
    room._slitherPhysicsTick = (room._slitherPhysicsTick ?? 0) + 1;
    const isBR = room.isBattleRoyale === true;
    const slitherHumans = room.players.filter(p => !p.disconnected && p.mode === 'slither');
    const humanCount = slitherHumans.length;

    const allSnakes = getAllSlitherSnakes(room);
    const toRemove = [];
    const sandboxSkipDeathCollisions = room.isSandbox && room.sandboxInvincible;
    const sandboxSkipFoodCollisions = sandboxSkipDeathCollisions && !room.sandboxBotAi;
    const foodGrid = getSlitherFoodGridForRoom(room);

    for (const { entity: snake, isHuman } of allSnakes) {
        if (snake.frozen || snake.isStatic) continue;

        if (snake.isBot && (isBR || !room.isSandbox || room.sandboxBotAi)) {
            if (!isBR && !room.isSandbox) {
                const botMax = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE).botMaxBalance;
                const botWealth = snake.dollarBalance ?? snake.balance;
                if (botWealth > botMax) {
                    toRemove.push({ snake, isHuman, killer: null, respawnBot: true, returnToPool: true });
                    continue;
                }
            }
            runSlitherBotAI(snake, allSnakes, room.slitherFood, foodGrid);
        }

        // Players keep moving while cashing out (no freeze) — getting eaten cancels the cashout
        updateSnakeMovement(snake, room);
        if (!sandboxSkipFoodCollisions) {
            checkFoodCollisions(snake, room, foodGrid);
        }

        if (isHuman && !isBR && !room.isSandbox) {
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

        if (!sandboxSkipDeathCollisions) {
            if (checkWallCollision(snake) || checkSelfCollision(snake)) {
                toRemove.push({ snake, isHuman, killer: null });
                continue;
            }

            const hit = checkSnakeCollisions(snake, allSnakes);
            if (hit) {
                toRemove.push({ snake, isHuman, killer: hit });
            }
        }
    }

    for (const { snake, isHuman, killer, respawnBot, returnToPool = true } of toRemove) {
        eliminateSnake(room, snake, killer, io, User, isHuman, isBR ? false : returnToPool, Transaction);
        if (!isBR && respawnBot) {
            const humansInArena = room.players.filter(p => p.mode === 'slither').length;
            const effectiveHumans = humansInArena > 0 ? humansInArena : (room.slitherBots.length > 0 ? 1 : 0);
            syncSlitherBots(room, effectiveHumans, getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE).botStartBalance);
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

    enforceSlitherFoodCap(room);

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
    const sendStateThisTick = room._slitherBroadcastTick % SLITHER_STATE_BROADCAST_INTERVAL === 0;
    const sendFoodThisTick = room._slitherBroadcastTick % SLITHER_FOOD_BROADCAST_INTERVAL === 0;
    const sendMinimapThisTick = room._slitherBroadcastTick % SLITHER_MINIMAP_BROADCAST_INTERVAL === 0;

    const slitherPlayers = room.players.filter(p => p.mode === 'slither' && !p.disconnected);
    if (!slitherPlayers.length) return;

    const needsImmediateTick = slitherPlayers.some(p => !room._lastSlitherStateAt?.[p.id]);
    if (!sendStateThisTick && !needsImmediateTick) return;

    const needsFoodRefresh = sendFoodThisTick || slitherPlayers.some(p => !room._lastSlitherFoodByPlayer?.[p.id]);
    const broadcastFoodGrid = needsFoodRefresh ? getSlitherFoodGridForRoom(room) : null;

    const physicsTick = room._slitherPhysicsTick ?? 0;
    if (room._slitherSerializeTick !== physicsTick) {
        room._slitherSerializeTick = physicsTick;
        room._slitherSerializedOther = new Map();
        room._slitherSerializedYou = new Map();
        for (const { entity: s } of allSnakes) {
            room._slitherSerializedOther.set(s.id, serializeSnake(s, false));
            room._slitherSerializedYou.set(s.id, serializeSnake(s, true));
        }
    }
    const serializedOther = room._slitherSerializedOther;
    const serializedYou = room._slitherSerializedYou;

    slitherPlayers.forEach(p => {
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
                .map(({ entity: s }) => (
                    s.id === p.id ? serializedYou.get(s.id) : serializedOther.get(s.id)
                ))
                .filter(Boolean);

            let visibleFood = null;
            if (sendFoodThisTick || !room._lastSlitherFoodByPlayer?.[p.id]) {
                visibleFood = collectSlitherFoodInView(
                    room.slitherFood,
                    broadcastFoodGrid,
                    head.x,
                    head.y,
                    foodRange,
                    MAX_VISIBLE_FOOD,
                );
                if (!room._lastSlitherFoodByPlayer) room._lastSlitherFoodByPlayer = {};
                room._lastSlitherFoodByPlayer[p.id] = visibleFood;
            } else {
                visibleFood = room._lastSlitherFoodByPlayer[p.id];
            }

            let minimap = null;
            if (sendMinimapThisTick || !room._lastSlitherMinimapByPlayer?.[p.id]) {
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

                const minimapFood = collectMinimapFood(
                    room.slitherFood,
                    broadcastFoodGrid ?? getSlitherFoodGridForRoom(room),
                    head.x,
                    head.y,
                    SLITHER.minimapRange,
                    MAX_MINIMAP_FOOD,
                );

                minimap = {
                    players: minimapPlayers,
                    food: minimapFood,
                };
                if (!room._lastSlitherMinimapByPlayer) room._lastSlitherMinimapByPlayer = {};
                room._lastSlitherMinimapByPlayer[p.id] = minimap;
            } else {
                minimap = room._lastSlitherMinimapByPlayer[p.id];
            }

            const tickPayload = {
                you: p.id,
                snakes: visibleSnakes,
                worldHalf: room.sandboxWorldHalf ?? SLITHER.worldHalf,
                ...meta,
                ...(meta.battleRoyale ? {} : { balance: p.dollarBalance ?? p.balance }),
            };
            if (visibleFood) tickPayload.food = visibleFood;
            if (minimap) tickPayload.minimap = minimap;

            if (!room._lastSlitherStateAt) room._lastSlitherStateAt = {};
            room._lastSlitherStateAt[p.id] = now;

            io.to(p.id).emit('slitherTick', tickPayload);
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
    const segments = downsampleSegmentsForNetwork(snake.segments, isYou ? MAX_NETWORK_SEGMENTS : 40);
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
    room._slitherPhysicsTick = (room._slitherPhysicsTick ?? 0) + 1;
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
    const sendStateThisTick = room._compSlitherBroadcastTick % SLITHER_STATE_BROADCAST_INTERVAL === 0;
    const sendFoodThisTick = room._compSlitherBroadcastTick % SLITHER_FOOD_BROADCAST_INTERVAL === 0;
    const sendMinimapThisTick = room._compSlitherBroadcastTick % SLITHER_MINIMAP_BROADCAST_INTERVAL === 0;

    const compPlayers = room.players.filter(p => p.mode === 'competitive-slither' && !p.disconnected);
    const compSpecs = room.competitiveSpectators || [];
    const allViewers = [
        ...compPlayers.map(p => p.id),
        ...compSpecs.map(s => s.id),
    ];
    const needsImmediateTick = allViewers.some(id => !room._lastCompStateAt?.[id]);
    if (!sendStateThisTick && !needsImmediateTick) return;

    const needsCompFoodRefresh = sendFoodThisTick
        || compPlayers.some(p => !room._lastCompFoodByPlayer?.[p.id])
        || compSpecs.length > 0;
    const compFoodGrid = needsCompFoodRefresh ? getSlitherFoodGridForRoom(room) : null;

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

        let visibleFood = null;
        const refreshFood = spectating
            || sendFoodThisTick
            || !room._lastCompFoodByPlayer?.[socketId];
        if (refreshFood) {
            visibleFood = collectSlitherFoodInView(
                room.slitherFood,
                compFoodGrid,
                head.x,
                head.y,
                foodRange,
                MAX_VISIBLE_FOOD,
                COMPETITIVE_SLITHER.foodRadius,
            );
            if (!spectating) {
                if (!room._lastCompFoodByPlayer) room._lastCompFoodByPlayer = {};
                room._lastCompFoodByPlayer[socketId] = visibleFood;
            }
        } else if (!spectating) {
            visibleFood = room._lastCompFoodByPlayer?.[socketId];
        }

        let minimap = null;
        if (sendMinimapThisTick || spectating || !room._lastCompMinimapByPlayer?.[socketId]) {
            const minimapPlayers = allSnakes.map(({ entity: s }) => {
                const h = s.segments[0];
                if (!h) return null;
                if (!isInView(head.x, head.y, h.x, h.y, SLITHER.minimapThreatRange * 0.65)) return null;
                return { x: Math.round(h.x), y: Math.round(h.y), you: s.id === youId };
            }).filter(Boolean);

            const minimapFood = collectMinimapFood(
                    room.slitherFood,
                    broadcastFoodGrid ?? getSlitherFoodGridForRoom(room),
                    head.x,
                    head.y,
                    SLITHER.minimapRange * 0.65,
                    MAX_COMP_MINIMAP_FOOD,
                );

            minimap = { players: minimapPlayers, food: minimapFood };
            if (!room._lastCompMinimapByPlayer) room._lastCompMinimapByPlayer = {};
            room._lastCompMinimapByPlayer[socketId] = minimap;
        } else {
            minimap = room._lastCompMinimapByPlayer?.[socketId];
        }

        const tickPayload = {
            you: youId,
            spectating: !!spectating,
            snakes: visibleSnakes,
            worldHalf: COMPETITIVE_SLITHER.worldHalf,
            competitiveSlither: true,
            circularMap: true,
            dollarBalance,
            ...meta,
        };
        if (visibleFood) tickPayload.food = visibleFood;
        if (minimap) tickPayload.minimap = minimap;

        if (!room._lastCompStateAt) room._lastCompStateAt = {};
        room._lastCompStateAt[socketId] = now;

        io.to(socketId).emit('slitherTick', tickPayload);
    };

    compPlayers.forEach(p => {
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

    compSpecs.forEach(spec => {
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
