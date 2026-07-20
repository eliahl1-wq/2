import * as util from './utils.js';
import { getEconomy, DEFAULT_ENTRY_FEE, wealthTaxDecayAmount, getCompetitiveEconomy } from './economy.js';

export const SLITHER = {
    // A 2400-radius circle is approximately half the playable area of the old
    // 6000x6000 square while still leaving enough room for long snakes.
    worldHalf: 2400,
    speedReferenceHalf: 3000,
    // Slither.io protocol reference (ClitherProject Protocol v11, scaled to our arena)
    slitherGameRadius: 21600,
    spawnSegments: 12,
    maxSegments: 1200,
    segmentsPerCent: 0.125,
    // Length comes mainly from more body points. Width and point spacing flatten
    // out instead of growing linearly until the snake is huge.
    maxScale: 1.65,
    maxRadiusScale: 3.15,
    scaleDivisor: 106,
    radiusScaleDivisor: 90,
    radiusGrowthLogFactor: 0.59,
    spacingGrowthFactor: 0.32,
    baseRadius: 6.2,
    segmentSepFactor: 3.6,
    nsp1: 5.39,
    nsp2: 0.4,
    nsp3: 14,
    slitherTickRate: 125,
    serverTickRate: 40,
    speedMultiplier: 1.2,
    turnRate: 9.0,
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
    foodBlobValue: 0.04, // legacy doc; use getEconomy(entryFee).foodBlobValue per room
    botStartBalance: 1.0,
    botMaxBalance: 500.0,
    // Fast human-like reactions. Decisions are intentionally not made every
    // 25 ms server tick, which made several bots move in perfect lockstep.
    botReactionMinMs: 140,
    botReactionMaxMs: 220,
    viewRange: 520,
    minimapRange: 1050,
    minimapThreatRange: 1700,
    selfCollisionSkip: 4,
    // Slither-style combat: heads are non-lethal; the body core is slightly narrower than the rendered snake.
    bodyCollisionScale: 0.82,
    // Ignore body points still visually inside the head/neck.
    lethalBodyStartRadius: 1.8,
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
const BOT_FOOD_SCAN_MIN_MS = 280;
const BOT_FOOD_SCAN_MAX_MS = 460;

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
    const dx = x1 - x2;
    const dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
}

export function segmentCountForBalance(balance, referenceBalance = 1.0) {
    const cents = Math.max(0, (balance - referenceBalance) * 100);
    const extra = Math.floor(cents * SLITHER.segmentsPerCent);
    return Math.min(SLITHER.maxSegments, SLITHER.spawnSegments + extra);
}

export function scaleForSegmentCount(sct) {
    const radiusSc = radiusScaleForSegmentCount(sct);
    return Math.min(SLITHER.maxScale, 1 + (radiusSc - 1) * SLITHER.spacingGrowthFactor);
}

/** Width grows more slowly than body length as segment count increases. */
export function radiusScaleForSegmentCount(sct) {
    const normalized = Math.max(2, sct);
    const baseSegments = Math.min(normalized, SLITHER.spawnSegments);
    const extraSegments = Math.max(0, normalized - SLITHER.spawnSegments);
    return Math.min(
        SLITHER.maxRadiusScale,
        1 + (baseSegments - 2) / SLITHER.scaleDivisor
            + Math.log1p(extraSegments / SLITHER.radiusScaleDivisor) * SLITHER.radiusGrowthLogFactor,
    );
}

/** Slither.io angular speed scale - thick snakes turn slower, but not too sluggishly. */
export function scangForSegmentCount(sct) {
    const sc = radiusScaleForSegmentCount(sct);
    return Math.max(0.34, 1 / Math.pow(sc, 0.78));
}

export function balanceToSegmentCount(balance, referenceBalance = 1.0) {
    return segmentCountForBalance(balance, referenceBalance);
}

export function headRadiusForBalance(balance, referenceBalance = 1.0) {
    const sc = radiusScaleForSegmentCount(segmentCountForBalance(balance, referenceBalance));
    return SLITHER.baseRadius * sc;
}

export function segmentSpacingForSegmentCount(sct) {
    return SLITHER.segmentSepFactor * scaleForSegmentCount(sct);
}

export function headRadiusForSegmentCount(sct) {
    return SLITHER.baseRadius * radiusScaleForSegmentCount(sct);
}

function headRadiusForSnake(snake) {
    const visualSegments = (snake?.segments?.length || SLITHER.spawnSegments) + Math.max(0, snake?.fam || 0);
    return headRadiusForSegmentCount(visualSegments);
}

export function segmentSpacingForBalance(balance, referenceBalance = 1.0) {
    const sc = scaleForSegmentCount(segmentCountForBalance(balance, referenceBalance));
    return SLITHER.segmentSepFactor * sc;
}

export function speedForBalance(balance, boosting = false, referenceBalance = 1.0) {
    const sc = scaleForSegmentCount(segmentCountForBalance(balance, referenceBalance));
    const worldScale = (SLITHER.speedReferenceHalf * 2) / (SLITHER.slitherGameRadius * 2);
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
    const radius = (room?.sandboxWorldHalf ?? SLITHER.worldHalf) * 0.85;
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.sqrt(Math.random()) * radius;
    return {
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
    };
}

export function isSpawnClear(room, x, y, minDist = 200) {
    for (const { entity: s } of getAllSlitherSnakes(room)) {
        const r = headRadiusForSnake(s);
        const spacing = segmentSpacingForSegmentCount(s.segments?.length || SLITHER.spawnSegments);
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

export function pickSlitherSpawn(room) {
    let bestX = 0;
    let bestY = 0;
    let maxMinDist = -1;

    for (let i = 0; i < 100; i++) {
        const { x, y } = randomCoordInRoom(room);
        let minDistToAnySegment = Infinity;

        for (const { entity: s } of getAllSlitherSnakes(room)) {
            const r = headRadiusForSnake(s);
            for (let j = 0; j < (s.segments?.length ?? 0); j += (j === 0 ? 1 : 8)) {
                const seg = s.segments[j];
                const segR = j === 0 ? r : r * 0.75;
                const d = dist(x, y, seg.x, seg.y) - segR;
                if (d < minDistToAnySegment) {
                    minDistToAnySegment = d;
                }
            }
            const last = s.segments?.[s.segments.length - 1];
            if (last) {
                const d = dist(x, y, last.x, last.y) - (r * 0.75);
                if (d < minDistToAnySegment) minDistToAnySegment = d;
            }
        }

        if (minDistToAnySegment > 180) {
            return { x, y };
        }

        if (minDistToAnySegment > maxMinDist) {
            maxMinDist = minDistToAnySegment;
            bestX = x;
            bestY = y;
        }
    }

    if (maxMinDist > 30) {
        return { x: bestX, y: bestY };
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
        username: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
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
        const index = room.slitherBots.findIndex(b => !b.adminSpawned);
        if (index === -1) break; // Only admin-spawned bots left
        const [removed] = room.slitherBots.splice(index, 1);
        room.aiBudgetBalance += removed?.botStake ?? SLITHER.botStartBalance;
    }
}

export function getSlitherTargetBots(humanCount) {
    if (humanCount <= 0) return 0;
    
    // Target a lively arena with a mix of players and bots.
    // The fewer humans, the more bots we spawn to fill the room up to a target size.
    // Max 5 bots per normal game (reduced from 8).
    const targetEntities = 8;
    if (humanCount >= targetEntities) return 0;
    
    return Math.min(5, targetEntities - humanCount);
}

function getAllSlitherSnakes(room) {
    const humans = room.players
        .filter(p => p.mode === 'slither' && p.segments?.length)
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

    if (snake.dollarBalance != null) {
        snake.balance += massGain;
        snake.dollarBalance = (snake.dollarBalance || 0) + dollarGain;
    } else {
        if (room.isBattleRoyale) {
            snake.balance += massGain;
        } else {
            snake.balance += dollarGain;
        }
    }
    
    snake.fam = (snake.fam || 0) + (room.isBattleRoyale ? massGain : dollarGain) / famVolumeForSegment(snake.segments.length);
    applyFamGrowth(snake);
}

/** Slither.io-style gradual length growth via fam fullness before adding a segment. */
function famVolumeForSegment(sct) {
    // Always grow the same amount in length, independent of current width/scale or segment count.
    // We use the initial volume at spawn to keep growth rate consistent.
    const spawnSc = scaleForSegmentCount(SLITHER.spawnSegments);
    return 0.09 + spawnSc * 0.022 + SLITHER.spawnSegments * 0.0016;
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

const MAX_SNAKE_PATH_POINTS = 3600;
const MIN_HEAD_PATH_DIST = 0.38;

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
    if (arc >= required) return;

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
        // tail - prev already points away from the head, so extend in that
        // direction. Subtracting it spawned the new segment back on top of the
        // previous body segment until the next movement tick corrected it.
        segments.push({ x: tail.x + dx * spacing, y: tail.y + dy * spacing });
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

    const minRecord = Math.max(0.4, spacing * MIN_HEAD_PATH_DIST);
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
            // Never stack an uncovered tail at one point. Besides looking rigid,
            // that produced an invisible lethal collision pile on very long snakes.
            const pathTail = path[path.length - 1];
            const pathPrev = path[Math.max(0, path.length - 2)];
            let dx = pathTail.x - pathPrev.x;
            let dy = pathTail.y - pathPrev.y;
            let d = Math.hypot(dx, dy);
            if (d < 1e-6) {
                dx = -Math.cos(snake.angle || 0);
                dy = -Math.sin(snake.angle || 0);
                d = 1;
            }
            const prev = segments[i - 1];
            segments[i].x = prev.x + (dx / d) * spacing;
            segments[i].y = prev.y + (dy / d) * spacing;
        }
    }

    trimSnakePath(path, segments.length * spacing + spacing * 4);
}

function hueFromColor(color) {
    const raw = typeof color === 'object' && color !== null ? color.fill : color;
    if (!raw || typeof raw !== 'string') return Math.floor(Math.random() * 360);
    const hex = raw.replace('#', '');
    let r = 128, g = 128, b = 128;
    if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length >= 6) {
        r = parseInt(hex.slice(0, 2), 16);
        g = parseInt(hex.slice(2, 4), 16);
        b = parseInt(hex.slice(4, 6), 16);
    }
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d > 0.0001) {
        if (max === rn) h = ((gn - bn) / d) % 6;
        else if (max === gn) h = (bn - rn) / d + 2;
        else h = (rn - gn) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return Math.floor(h);
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
        let dollarCost = 0;
        // Normal mode: boost spends HUD balance too (size and dollars stay linked).
        if (isCoupledSlitherRoom(room) && snake.dollarBalance != null) {
            const eco = getEconomy(snake.entryFeeUsd ?? DEFAULT_ENTRY_FEE);
            const conversionRatio = eco.foodBlobValue / eco.massPerPellet;
            const targetDollarCost = cost * conversionRatio;

            const dollarFloor = minDollarsForSnake(snake);
            dollarCost = Math.min(targetDollarCost, Math.max(0, snake.dollarBalance - dollarFloor));
            if (dollarCost > 1e-9) {
                snake.dollarBalance -= dollarCost;
            }
            poolCredit = dollarCost;
            if (snake.cells?.[0]) snake.cells[0].balance = snake.balance;
        }
        room.foodPoolBalance += poolCredit;

        // Accumulate boost loss and drop food pellets behind the tail
        snake._boostMassAcc = (snake._boostMassAcc || 0) + cost;
        snake._boostDollarAcc = (snake._boostDollarAcc || 0) + dollarCost;

        const eco = getEconomy(snake.entryFeeUsd ?? DEFAULT_ENTRY_FEE);
        const massPerPellet = eco.massPerPellet || 0.02;
        const foodBlobValue = eco.foodBlobValue || 0.02;

        if (snake._boostMassAcc >= massPerPellet) {
            const dropMass = massPerPellet;
            const dropDollar = Math.min(snake._boostDollarAcc, foodBlobValue);

            snake._boostMassAcc -= dropMass;
            snake._boostDollarAcc -= dropDollar;

            // Spawn pellet at the tail
            const tail = snake.segments[snake.segments.length - 1];
            if (tail) {
                // Subtract from foodPoolBalance since we spawn a real pellet in the map
                room.foodPoolBalance = Math.max(0, room.foodPoolBalance - dropDollar);

                const jitter = 5;
                room.slitherFood.push({
                    id: randId(),
                    x: tail.x + (Math.random() - 0.5) * jitter,
                    y: tail.y + (Math.random() - 0.5) * jitter,
                    balance: dropMass,
                    dollarValue: dropDollar,
                    hue: hueFromColor(snake.color),
                    radius: SLITHER.foodRadius * (1 + Math.random() * 0.4),
                    // boost pellets render exactly like normal food, just colored
                });
            }
        }
    }

    const spacing = segmentSpacingForSegmentCount(snake.segments.length);
    updateSnakeBodyFromPath(snake, spacing);

    if (snake.x !== undefined) {
        snake.x = head.x;
        snake.y = head.y;
    }

    // Compute bounding box for fast collision culling
    if (snake.segments && snake.segments.length > 0) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < snake.segments.length; i++) {
            const seg = snake.segments[i];
            if (seg.x < minX) minX = seg.x;
            if (seg.x > maxX) maxX = seg.x;
            if (seg.y < minY) minY = seg.y;
            if (seg.y > maxY) maxY = seg.y;
        }
        snake.minX = minX;
        snake.maxX = maxX;
        snake.minY = minY;
        snake.maxY = maxY;
    }
}

function applyWallAvoidance(snake, room) {
    const head = snake.segments[0];
    const r = headRadiusForSnake(snake);
    const limit = (room?.sandboxWorldHalf ?? SLITHER.worldHalf) - r - 20;
    const margin = 120;
    const distance = Math.hypot(head.x, head.y);
    if (distance < limit - margin || distance < 1e-6) return false;

    const safeDistance = Math.max(0, limit - margin);
    const inwardScale = safeDistance / distance;
    const steerX = head.x * inwardScale - head.x;
    const steerY = head.y * inwardScale - head.y;

    snake.targetX = head.x + steerX * 4;
    snake.targetY = head.y + steerY * 4;
    snake.inputDx = snake.targetX - head.x;
    snake.inputDy = snake.targetY - head.y;
    snake.boost = false;
    return true;
}

/** Bot AI aligned with agar mode: flee → chase → food → wander, plus wall avoidance. */
function findNearestFoodForBot(head, food, foodGrid, minDistFood, predicate = null, scoreFood = null) {
    let nearestFood = null;
    const maxFoodDist2 = minDistFood * minDistFood;
    let bestScore = Infinity;

    const tryFood = (f) => {
        if (predicate && !predicate(f)) return;
        const fdx = head.x - f.x;
        if (fdx > minDistFood || fdx < -minDistFood) return;
        const fdy = head.y - f.y;
        if (fdy > minDistFood || fdy < -minDistFood) return;
        const d2 = fdx * fdx + fdy * fdy;
        const score = scoreFood ? scoreFood(f, d2) : d2;
        if (d2 < maxFoodDist2 && score < bestScore) {
            bestScore = score;
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
                const key = (cx + 2000) + (cy + 2000) * 10000;
                const bucket = foodGrid.get(key);
                if (!bucket) continue;
                for (const f of bucket) tryFood(f);
            }
        }
    } else {
        for (const f of food) tryFood(f);
    }
    return nearestFood;
}

function ensureSlitherBotBrain(snake) {
    if (snake._botBrain) return snake._botBrain;

    const reactionRange = SLITHER.botReactionMaxMs - SLITHER.botReactionMinMs;
    snake._botBrain = {
        reactionMs: SLITHER.botReactionMinMs + Math.random() * reactionRange,
        foodScanMs: BOT_FOOD_SCAN_MIN_MS + Math.random() * (BOT_FOOD_SCAN_MAX_MS - BOT_FOOD_SCAN_MIN_MS),
        foodValueBias: 0.7 + Math.random() * 0.8,
        preyChance: 0.02 + Math.random() * 0.08,
        bigGameDrive: 0.55 + Math.random() * 0.3,
        caution: 0.86 + Math.random() * 0.24,
        aimOffset: 4 + Math.random() * 13,
        weaveSpeed: 0.0025 + Math.random() * 0.0025,
        phase: Math.random() * Math.PI * 2,
        wanderDirection: Math.random() < 0.5 ? -1 : 1,
        wanderTurn: 0.3 + Math.random() * 0.85,
        wanderDistance: 240 + Math.random() * 260,
        boostGreed: Math.random(),
        nextDecisionAt: 0,
        nextFoodScanAt: 0,
        foodTarget: null,
    };
    return snake._botBrain;
}

function scheduleNextBotDecision(brain, now) {
    brain.nextDecisionAt = now + brain.reactionMs * (0.88 + Math.random() * 0.24);
}

function stableBotFoodNoise(snakeId, foodId) {
    const key = String(snakeId) + ':' + String(foodId ?? '');
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 1000) / 1000;
}

function preferredFoodScore(snake, brain, foodItem, distance2) {
    const value = Math.max(0.001, Number(foodItem.dollarValue ?? foodItem.balance) || 0.001);
    let valueWeight = 1 + Math.log1p(value * 18) * brain.foodValueBias;
    if (foodItem.deathDrop || foodItem.competitiveDeathDrop) valueWeight *= 2.8;
    if (foodItem.golden) valueWeight *= 1.9;

    // A small stable per-bot preference prevents every bot from selecting the
    // exact same pellet while still keeping distance and value dominant.
    const individuality = 0.86 + stableBotFoodNoise(snake.id, foodItem.id) * 0.28;
    return (distance2 * individuality) / valueWeight;
}


function chooseLargeSnakeHuntTarget(snake, allSnakes, brain, huntRange) {
    const head = snake.segments[0];
    const ownSegments = Math.max(1, snake.segments?.length || 1);
    const ownBalance = Math.max(0.01, Number(snake.balance) || 0.01);
    let best = null;
    let bestScore = -Infinity;

    for (const { entity: other } of allSnakes) {
        if (other.id === snake.id || other.isStatic || !other.segments?.length) continue;

        const otherHead = other.segments[0];
        const distance = dist(head.x, head.y, otherHead.x, otherHead.y);
        if (distance > huntRange) continue;

        const segmentRatio = other.segments.length / ownSegments;
        const balanceRatio = Math.max(0.01, Number(other.balance) || 0.01) / ownBalance;
        const sizeRatio = Math.max(segmentRatio, balanceRatio);
        if (sizeRatio < 1.55 || other.segments.length < 24) continue;

        // Most, but not every, bot joins a hunt. Bigger targets attract a larger
        // share of the bots, making group pressure emerge without perfect swarms.
        const participation = Math.min(
            1,
            (brain.bigGameDrive ?? 0.7) + Math.min(0.2, (sizeRatio - 1.55) * 0.09),
        );
        const joinRoll = stableBotFoodNoise(snake.id, 'hunt:' + String(other.id));
        if (joinRoll > participation) continue;

        // Size dominates this score, so nearby bots independently converge on
        // the same standout snake instead of scattering across small prey.
        const score = Math.log1p(sizeRatio) * 4.2
            - distance / Math.max(1, huntRange)
            + Math.min(0.7, other.segments.length / 900);
        if (score > bestScore) {
            bestScore = score;
            best = { snake: other, distance, sizeRatio };
        }
    }

    return best;
}

function aimBotAtLargeSnake(snake, hunt, brain, now) {
    const target = hunt.snake;
    const targetHead = target.segments[0];
    const targetAngle = Number.isFinite(target.angle)
        ? target.angle
        : Math.atan2(target.inputDy || 0, target.inputDx || 1);
    const leadDistance = Math.min(210, 90 + Math.sqrt(target.segments.length) * 4.5);
    const sideNoise = stableBotFoodNoise(snake.id, 'side:' + String(target.id));
    const side = sideNoise < 0.5 ? -1 : 1;
    const lateral = 36 + brain.aimOffset * 1.8;

    const leadX = targetHead.x + Math.cos(targetAngle) * leadDistance;
    const leadY = targetHead.y + Math.sin(targetAngle) * leadDistance;
    snake.targetX = leadX - Math.sin(targetAngle) * lateral * side;
    snake.targetY = leadY + Math.cos(targetAngle) * lateral * side;
    snake.boost = hunt.distance > 135;
    brain.huntTargetId = target.id;
    brain.huntSide = side;
    brain.huntUntil = now + 650;
}
function aimBotAtFood(snake, head, target, brain, now) {
    const dx = target.x - head.x;
    const dy = target.y - head.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-6) {
        snake.targetX = target.x;
        snake.targetY = target.y;
        return;
    }

    // Individual, gentle approach arcs make bots look less scripted without
    // steering far enough away to miss the pellet.
    const offset = Math.min(brain.aimOffset, distance * 0.11)
        * Math.sin(now * brain.weaveSpeed + brain.phase);
    snake.targetX = target.x - (dy / distance) * offset;
    snake.targetY = target.y + (dx / distance) * offset;
}

function chooseBotWanderTarget(snake, head, brain) {
    if (Math.random() < 0.18) brain.wanderDirection *= -1;
    const currentAngle = Number.isFinite(snake.angle)
        ? snake.angle
        : Math.atan2(snake.inputDy || 0, snake.inputDx || 1);
    const angle = currentAngle
        + brain.wanderDirection * brain.wanderTurn
        + (Math.random() - 0.5) * 0.38;
    snake.targetX = head.x + Math.cos(angle) * brain.wanderDistance;
    snake.targetY = head.y + Math.sin(angle) * brain.wanderDistance;
}

function keepBotSteering(snake, head, room) {
    if (!applyWallAvoidance(snake, room)) {
        snake.inputDx = snake.targetX - head.x;
        snake.inputDy = snake.targetY - head.y;
    }
}


function botRouteClearance(snake, allSnakes, angle, lookAhead) {
    const head = snake.segments[0];
    const ownRadius = headRadiusForSnake(snake);
    const samples = [0.28, 0.5, 0.72, 0.9, 1];
    let minClearance = lookAhead;

    for (const { entity: other } of allSnakes) {
        if (other.id === snake.id || !other.segments?.length) continue;

        const otherRadius = headRadiusForSnake(other);
        const collisionPadding = (ownRadius + otherRadius) * SLITHER.bodyCollisionScale + 7;
        const first = firstLethalBodySegment(other, otherRadius);
        const stride = other.segments.length > 180 ? 3 : 2;

        for (let i = first; i < other.segments.length; i += stride) {
            const a = other.segments[i];
            const b = other.segments[Math.min(other.segments.length - 1, i + stride)];
            const midX = (a.x + b.x) * 0.5;
            const midY = (a.y + b.y) * 0.5;
            const halfChord = dist(a.x, a.y, b.x, b.y) * 0.5;
            if (dist(head.x, head.y, midX, midY) > lookAhead + collisionPadding + halfChord) continue;

            for (const fraction of samples) {
                const px = head.x + Math.cos(angle) * lookAhead * fraction;
                const py = head.y + Math.sin(angle) * lookAhead * fraction;
                const clearance = distPointToSegment(px, py, a.x, a.y, b.x, b.y)
                    - collisionPadding;
                if (clearance < minClearance) minClearance = clearance;
                if (minClearance < -collisionPadding * 0.5) return minClearance;
            }
        }
    }

    return minClearance;
}

function applyBotBodyAvoidance(snake, allSnakes, brain, now) {
    const head = snake.segments[0];
    const currentAngle = Number.isFinite(snake.angle)
        ? snake.angle
        : Math.atan2(snake.inputDy || 0, snake.inputDx || 1);
    const desiredAngle = Math.atan2(snake.targetY - head.y, snake.targetX - head.x);
    let desiredDelta = Math.atan2(
        Math.sin(desiredAngle - currentAngle),
        Math.cos(desiredAngle - currentAngle),
    );

    const turnPerTick = (SLITHER.turnRate * scangForSegmentCount(snake.segments.length))
        / SLITHER.serverTickRate;
    const planningTurn = Math.min(0.82, Math.max(0.34, turnPerTick * 4.5));
    desiredDelta = Math.max(-planningTurn, Math.min(planningTurn, desiredDelta));

    const lookAhead = Math.min(210, 112 + Math.sqrt(snake.segments.length) * 2.9);
    const plannedAngle = currentAngle + desiredDelta;
    const plannedClearance = botRouteClearance(snake, allSnakes, plannedAngle, lookAhead);
    if (plannedClearance > 24) {
        if ((brain.avoidBodyUntil || 0) <= now) brain.avoidDirection = 0;
        return false;
    }

    const wideTurn = Math.min(1.18, planningTurn * 1.75);
    const candidates = [
        { angle: currentAngle - planningTurn, direction: -1 },
        { angle: currentAngle + planningTurn, direction: 1 },
        { angle: currentAngle - wideTurn, direction: -1 },
        { angle: currentAngle + wideTurn, direction: 1 },
    ];

    let best = null;
    for (const candidate of candidates) {
        const clearance = botRouteClearance(snake, allSnakes, candidate.angle, lookAhead);
        const continuityBonus = brain.avoidDirection === candidate.direction
            && (brain.avoidBodyUntil || 0) > now
            ? 10
            : 0;
        const score = clearance + continuityBonus;
        if (!best || score > best.score) best = { ...candidate, clearance, score };
    }

    if (!best) return false;

    brain.avoidDirection = best.direction;
    brain.avoidBodyUntil = now + 420;
    snake.targetX = head.x + Math.cos(best.angle) * lookAhead * 2.4;
    snake.targetY = head.y + Math.sin(best.angle) * lookAhead * 2.4;
    snake.inputDx = snake.targetX - head.x;
    snake.inputDy = snake.targetY - head.y;
    snake.boost = false;
    return true;
}
export function runSlitherBotAI(
    snake,
    allSnakes,
    food,
    foodGrid = null,
    room = null,
    now = Date.now(),
    deathDrops = null,
    deathDropIds = null,
) {
    const head = snake.segments[0];
    const brain = ensureSlitherBotBrain(snake);
    const availableDeathDrops = deathDrops ?? food.filter(f => f.deathDrop);
    const availableDeathDropIds = deathDropIds ?? new Set(availableDeathDrops.map(f => f.id));
    const cachedDeathDropIsLive = snake._deathDropTarget?.id != null
        && availableDeathDropIds.has(snake._deathDropTarget.id);
    if (availableDeathDrops.length > 0 && !cachedDeathDropIsLive && !brain.deathRushPending) {
        brain.deathRushPending = true;
        brain.nextDecisionAt = Math.min(brain.nextDecisionAt, now + 95);
    } else if (availableDeathDrops.length === 0) {
        brain.deathRushPending = false;
    }
    if (now < brain.nextDecisionAt) {
        keepBotSteering(snake, head, room);
        return;
    }
    scheduleNextBotDecision(brain, now);
    brain.deathRushPending = false;

    const minDistThreat = scaleAgarBotDistance(AGAR_BOT_THREAT_RANGE);
    const minDistPrey = scaleAgarBotDistance(AGAR_BOT_PREY_RANGE);
    const minDistFood = scaleAgarBotDistance(AGAR_BOT_FOOD_RANGE);
    const fleeDistance = scaleAgarBotDistance(AGAR_BOT_FLEE_DISTANCE);

    let threat = null;
    let targetPrey = null;
    let nearestThreatDist = minDistThreat * brain.caution;
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
    const largeHunt = chooseLargeSnakeHuntTarget(
        snake, allSnakes, brain, Math.max(minDistPrey * 2.2, SLITHER.viewRange * 1.65),
    );
    const urgentThreat = threat && nearestThreatDist < fleeDistance * 0.42;
    brain.huntTargetId = null;

    // Death food is scanned across the full map and always beats ambient food
    // and prey. The short cache avoids a full food scan on every server tick.
    let deathDrop = snake._deathDropTarget;
    const deathDropStillExists = deathDrop?.id != null && availableDeathDropIds.has(deathDrop.id);
    if (!deathDropStillExists || now - (snake._lastDeathDropScan || 0) >= 120) {
        deathDrop = findNearestFoodForBot(
            head,
            availableDeathDrops,
            null,
            (room?.sandboxWorldHalf ?? SLITHER.worldHalf) * 2,
            null,
            (f, d2) => preferredFoodScore(snake, brain, f, d2),
        );
        snake._deathDropTarget = deathDrop;
        snake._lastDeathDropScan = now;
    }

    if (urgentThreat) {
        const angle = Math.atan2(head.y - threat.y, head.x - threat.x);
        snake.targetX = head.x + Math.cos(angle) * fleeDistance;
        snake.targetY = head.y + Math.sin(angle) * fleeDistance;
        snake.boost = nearestThreatDist < fleeDistance * 0.3;
    } else if (deathDrop) {
        aimBotAtFood(snake, head, deathDrop, brain, now);
        snake.lastTargetUpdate = now;
        snake.boost = dist(head.x, head.y, deathDrop.x, deathDrop.y) > 45;
    } else if (largeHunt) {
        aimBotAtLargeSnake(snake, largeHunt, brain, now);
        snake.lastTargetUpdate = now;
    } else if (threat) {
        const angle = Math.atan2(head.y - threat.y, head.x - threat.x);
        snake.targetX = head.x + Math.cos(angle) * fleeDistance;
        snake.targetY = head.y + Math.sin(angle) * fleeDistance;
        snake.boost = nearestThreatDist < fleeDistance * 0.3;
    } else {
        const targetReached = brain.foodTarget
            && dist(head.x, head.y, brain.foodTarget.x, brain.foodTarget.y) < 34;
        if (!brain.foodTarget || targetReached || now >= brain.nextFoodScanAt) {
            brain.foodTarget = findNearestFoodForBot(
                head,
                food,
                foodGrid,
                minDistFood,
                f => !f.deathDrop,
                (f, d2) => preferredFoodScore(snake, brain, f, d2),
            );
            brain.nextFoodScanAt = now + brain.foodScanMs;
        }

        // Ambient food is still preferred over hunting, but never over death food.
        if (brain.foodTarget && (!targetPrey || Math.random() >= brain.preyChance)) {
            aimBotAtFood(snake, head, brain.foodTarget, brain, now);
            snake.boost = false;
        } else if (targetPrey) {
            snake.targetX = targetPrey.x;
            snake.targetY = targetPrey.y;
            snake.boost = brain.boostGreed > 0.72 && nearestPreyDist < fleeDistance * 0.25;
        } else if (!Number.isFinite(snake.targetX)
            || dist(head.x, head.y, snake.targetX, snake.targetY) < 50) {
            chooseBotWanderTarget(snake, head, brain);
            snake.boost = false;
        }
        snake.lastTargetUpdate = now;
    }

    applyBotBodyAvoidance(snake, allSnakes, brain, now);
    keepBotSteering(snake, head, room);
}

function applyCompetitiveZoneAvoidance(snake, effectiveRadius, brain, now) {
    const head = snake.segments[0];
    const headDistance = Math.hypot(head.x, head.y);
    if (headDistance < 1e-6) {
        brain.zoneAvoiding = false;
        return false;
    }

    const snakeRadius = headRadiusForSnake(snake);
    const radialAngle = Math.atan2(head.y, head.x);
    const inwardAngle = radialAngle + Math.PI;
    const currentAngle = Number.isFinite(snake.angle) ? snake.angle : inwardAngle;
    const maxTurn = (SLITHER.turnRate * scangForSegmentCount(snake.segments.length))
        / SLITHER.serverTickRate;
    const turnDelta = Math.abs(Math.atan2(
        Math.sin(inwardAngle - currentAngle),
        Math.cos(inwardAngle - currentAngle),
    ));
    const turnTravel = speedForBalance(
        snake.balance,
        false,
        competitiveMinMass(snake.entryFeeUsd),
    ) * Math.min(20, turnDelta / Math.max(0.01, maxTurn));

    // Start the rescue early enough to finish a human-speed turn. Keep extra
    // room while the zone shrinks, but scale down gracefully near the reset.
    const baseMargin = Math.max(110, effectiveRadius * 0.3);
    const maxUsefulMargin = Math.max(35, effectiveRadius * 0.58);
    const safetyMargin = Math.min(260, maxUsefulMargin, baseMargin + turnTravel + 22);
    const safeRadius = Math.max(0, effectiveRadius - snakeRadius - safetyMargin);
    const releaseRadius = Math.max(0, safeRadius - Math.min(55, safetyMargin * 0.28));

    if (!brain.zoneAvoiding && headDistance < safeRadius) return false;
    if (brain.zoneAvoiding && headDistance <= releaseRadius) {
        brain.zoneAvoiding = false;
        brain.zoneTurnDirection = 0;
        return false;
    }

    if (!brain.zoneAvoiding) {
        let delta = Math.atan2(
            Math.sin(inwardAngle - currentAngle),
            Math.cos(inwardAngle - currentAngle),
        );
        if (Math.abs(delta) > Math.PI - 0.08) {
            delta = (brain.wanderDirection || 1) * Math.PI;
        }
        brain.zoneTurnDirection = Math.sign(delta) || brain.wanderDirection || 1;
    }
    brain.zoneAvoiding = true;
    brain.zoneAvoidingSince = brain.zoneAvoidingSince || now;

    // A slight personal tangent prevents every arena bot from stacking on the
    // same radial line, while retaining a very strong inward component.
    const rescueAngle = inwardAngle + brain.zoneTurnDirection * 0.16;
    const rescueDistance = Math.max(260, safetyMargin * 1.8);
    snake.targetX = head.x + Math.cos(rescueAngle) * rescueDistance;
    snake.targetY = head.y + Math.sin(rescueAngle) * rescueDistance;
    snake.inputDx = snake.targetX - head.x;
    snake.inputDy = snake.targetY - head.y;
    snake.boost = false;
    return true;
}
export function runCompetitiveSlitherBotAI(
    snake,
    allSnakes,
    food,
    effectiveRadius,
    paidDeathDrops,
    paidDeathDropIds,
    now = Date.now(),
) {
    const head = snake.segments[0];
    const brain = ensureSlitherBotBrain(snake);
    if (applyCompetitiveZoneAvoidance(snake, effectiveRadius, brain, now)) {
        snake.inputDx = snake.targetX - head.x;
        snake.inputDy = snake.targetY - head.y;
        return;
    }

    const cachedPaidDropIsLive = snake._paidDeathDropTarget?.id != null
        && paidDeathDropIds.has(snake._paidDeathDropTarget.id);
    if (paidDeathDrops.length > 0 && !cachedPaidDropIsLive && !brain.deathRushPending) {
        brain.deathRushPending = true;
        brain.nextDecisionAt = Math.min(brain.nextDecisionAt, now + 95);
    } else if (paidDeathDrops.length === 0) {
        brain.deathRushPending = false;
    }

    if (now < brain.nextDecisionAt) {
        snake.inputDx = snake.targetX - head.x;
        snake.inputDy = snake.targetY - head.y;
        return;
    }
    scheduleNextBotDecision(brain, now);
    brain.deathRushPending = false;

    const minDistThreat = scaleAgarBotDistance(AGAR_BOT_THREAT_RANGE);
    const minDistPrey = scaleAgarBotDistance(AGAR_BOT_PREY_RANGE);
    const minDistFood = scaleAgarBotDistance(AGAR_BOT_FOOD_RANGE);
    const fleeDistance = scaleAgarBotDistance(AGAR_BOT_FLEE_DISTANCE);
    let threat = null;
    let targetPrey = null;
    let nearestThreatDist = minDistThreat * brain.caution;
    let nearestPreyDist = minDistPrey;

    for (const { entity: other } of allSnakes) {
        if (other.id === snake.id) continue;
        const otherHead = other.segments[0];
        const d = dist(head.x, head.y, otherHead.x, otherHead.y);
        if (other.balance > snake.balance * 1.10 && d < nearestThreatDist) {
            nearestThreatDist = d;
            threat = otherHead;
        } else if (snake.balance > other.balance * 1.10 && d < nearestPreyDist) {
            nearestPreyDist = d;
            targetPrey = otherHead;
        }
    }
    const largeHunt = chooseLargeSnakeHuntTarget(
        snake, allSnakes, brain, Math.max(minDistPrey * 2.2, effectiveRadius * 1.35),
    );
    const urgentThreat = threat && nearestThreatDist < fleeDistance * 0.42;
    brain.huntTargetId = null;

    // Paid death drops stay the strongest food target in arena mode. Scanning is
    // cached, while each bot's route and boost appetite remain individual.
    const deathDropRange = Math.max(minDistFood, effectiveRadius * 2);
    let paidDeathDrop = snake._paidDeathDropTarget;
    const targetStillExists = paidDeathDrop?.id != null && paidDeathDropIds.has(paidDeathDrop.id);
    if (!targetStillExists || now - (snake._lastPaidDeathDropScan || 0) >= 120) {
        paidDeathDrop = findNearestFoodForBot(
            head,
            paidDeathDrops,
            null,
            deathDropRange,
            null,
            (f, d2) => preferredFoodScore(snake, brain, f, d2),
        );
        snake._paidDeathDropTarget = paidDeathDrop;
        snake._lastPaidDeathDropScan = now;
    }

    if (urgentThreat) {
        const angle = Math.atan2(head.y - threat.y, head.x - threat.x);
        snake.targetX = head.x + Math.cos(angle) * fleeDistance;
        snake.targetY = head.y + Math.sin(angle) * fleeDistance;
        snake.boost = nearestThreatDist < fleeDistance * 0.3;
    } else if (paidDeathDrop) {
        aimBotAtFood(snake, head, paidDeathDrop, brain, now);
        snake.lastTargetUpdate = now;
        snake.boost = dist(head.x, head.y, paidDeathDrop.x, paidDeathDrop.y) > 45;
    } else if (largeHunt) {
        aimBotAtLargeSnake(snake, largeHunt, brain, now);
        snake.lastTargetUpdate = now;
    } else if (threat) {
        const angle = Math.atan2(head.y - threat.y, head.x - threat.x);
        snake.targetX = head.x + Math.cos(angle) * fleeDistance;
        snake.targetY = head.y + Math.sin(angle) * fleeDistance;
        snake.boost = nearestThreatDist < fleeDistance * 0.3;
    } else {
        const targetReached = brain.foodTarget
            && dist(head.x, head.y, brain.foodTarget.x, brain.foodTarget.y) < 34;
        if (!brain.foodTarget || targetReached || now >= brain.nextFoodScanAt) {
            brain.foodTarget = findNearestFoodForBot(
                head,
                food,
                null,
                minDistFood,
                f => !f.competitiveDeathDrop,
                (f, d2) => preferredFoodScore(snake, brain, f, d2),
            );
            brain.nextFoodScanAt = now + brain.foodScanMs;
        }

        if (brain.foodTarget && (!targetPrey || Math.random() >= brain.preyChance)) {
            aimBotAtFood(snake, head, brain.foodTarget, brain, now);
            snake.boost = false;
        } else if (targetPrey) {
            snake.targetX = targetPrey.x;
            snake.targetY = targetPrey.y;
            snake.boost = brain.boostGreed > 0.72 && nearestPreyDist < fleeDistance * 0.25;
        } else if (!Number.isFinite(snake.targetX)
            || dist(head.x, head.y, snake.targetX, snake.targetY) < 50) {
            const maxTargetRadius = Math.max(0, effectiveRadius - 220);
            chooseBotWanderTarget(snake, head, brain);
            const targetDistance = Math.hypot(snake.targetX, snake.targetY);
            if (targetDistance > maxTargetRadius && targetDistance > 1e-6) {
                snake.targetX *= maxTargetRadius / targetDistance;
                snake.targetY *= maxTargetRadius / targetDistance;
            }
            snake.boost = false;
        }
        snake.lastTargetUpdate = now;
    }

    applyBotBodyAvoidance(snake, allSnakes, brain, now);
    snake.inputDx = snake.targetX - head.x;
    snake.inputDy = snake.targetY - head.y;
}

function checkWallCollision(snake, room) {
    const head = snake.segments[0];
    const r = headRadiusForSnake(snake);
    const limit = (room?.sandboxWorldHalf ?? SLITHER.worldHalf) - r;
    return Math.hypot(head.x, head.y) > limit;
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
    const r = headRadiusForSnake(snake);
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
    return snakeRadius + foodRadius + 6;
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

function firstLethalBodySegment(snake, radius) {
    const spacing = segmentSpacingForSegmentCount(snake.segments?.length || SLITHER.spawnSegments);
    return Math.max(2, Math.ceil((radius * SLITHER.lethalBodyStartRadius) / Math.max(1, spacing)));
}

function headHitsSnakeBody(head, headRadius, other, otherRadius) {
    const segments = other.segments || [];
    const first = firstLethalBodySegment(other, otherRadius);
    const threshold = (headRadius + otherRadius) * SLITHER.bodyCollisionScale;
    // Long snakes are sampled densely. Test short swept body chords instead of
    // every individual point: this keeps the hitbox continuous and halves the
    // hot collision loop without creating gaps between segments.
    const stride = segments.length > 180 ? 2 : 1;
    for (let i = first; i < segments.length; i += stride) {
        const a = segments[i];
        const b = segments[Math.min(segments.length - 1, i + stride)];
        if (distPointToSegment(head.x, head.y, a.x, a.y, b.x, b.y) < threshold) return true;
    }
    return false;
}

function checkSnakeCollisions(snake, allSnakes) {
    if (snake.spawnGraceUntil && Date.now() < snake.spawnGraceUntil) return null;
    const head = snake.segments[0];
    const r = headRadiusForSnake(snake);
    for (const { entity: other } of allSnakes) {
        if (other.id === snake.id) continue;
        if (other.spawnGraceUntil && Date.now() < other.spawnGraceUntil) continue;

        // Bounding box check to cull segment collision checks
        const maxOtherR = headRadiusForSnake(other);
        const pad = r + maxOtherR + 10;
        if (other.minX !== undefined && (
            head.x < other.minX - pad ||
            head.x > other.maxX + pad ||
            head.y < other.minY - pad ||
            head.y > other.maxY + pad
        )) {
            continue;
        }

        if (headHitsSnakeBody(head, r, other, maxOtherR)) return other;
    }
    return null;
}

export function resolveAllSnakeCollisions(allSnakes) {
    const deadSnakes = new Map(); // snakeId -> killerEntity
    
    // First phase: collect all hits for each active snake
    const collisions = new Map(); // snakeId -> { snake, bodyHit: otherEntity, headHit: otherEntity }

    const now = Date.now();

    for (const { entity: snake } of allSnakes) {
        if (snake.frozen || snake.isStatic) continue;
        if (snake.spawnGraceUntil && now < snake.spawnGraceUntil) continue;

        const head = snake.segments?.[0];
        if (!head) continue;

        const r = headRadiusForSnake(snake);

        let bodyHit = null;
        let headHit = null;

        for (const { entity: other } of allSnakes) {
            if (other.id === snake.id) continue;
            if (other.spawnGraceUntil && now < other.spawnGraceUntil) continue;

            // Bounding box check to cull segment collision checks
            const maxOtherR = headRadiusForSnake(other);
            const pad = r + maxOtherR + 10;
            if (other.minX !== undefined && (
                head.x < other.minX - pad ||
                head.x > other.maxX + pad ||
                head.y < other.minY - pad ||
                head.y > other.maxY + pad
            )) {
                continue;
            }

            if (headHitsSnakeBody(head, r, other, maxOtherR)) {
                bodyHit = other;
            }
            if (bodyHit) {
                break; // Found body hit, stop checking other snakes for this one
            }
        }

        if (bodyHit || headHit) {
            collisions.set(snake.id, { snake, bodyHit, headHit });
        }
    }

    // Second phase: process collision rules
    for (const [snakeId, col] of collisions.entries()) {
        const { snake, bodyHit, headHit } = col;

        // 1. If body hit: snake dies immediately.
        if (bodyHit) {
            deadSnakes.set(snakeId, bodyHit);
            continue;
        }

        // 2. If head-to-head hit and no body hit:
        if (headHit) {
            const other = headHit;
            const otherCol = collisions.get(other.id);

            // If the other snake also hit a body segment of someone, then the other snake is dead.
            // In this case, the other snake is the "attacker/loser", so this snake survives.
            if (otherCol && otherCol.bodyHit) {
                continue;
            }

            // Otherwise, we have a head-to-head collision.
            // Check direction of approach to see who is the active collider.
            const headA = snake.segments[0];
            const headB = other.segments[0];
            if (!headA || !headB) continue;

            const dx = headB.x - headA.x;
            const dy = headB.y - headA.y;

            // Heading vectors
            const angleA = snake.angle || 0;
            const angleB = other.angle || 0;
            const cosA = Math.cos(angleA);
            const sinA = Math.sin(angleA);
            const cosB = Math.cos(angleB);
            const sinB = Math.sin(angleB);

            // Dot products to determine if they are moving towards each other
            const dotA = cosA * dx + sinA * dy;
            const dotB = cosB * (-dx) + sinB * (-dy);

            const A_moving_to_B = dotA > 1e-5;
            const B_moving_to_A = dotB > 1e-5;

            if (A_moving_to_B && B_moving_to_A) {
                // True head-on collision. Resolve by balance (size).
                // Larger snake (by > 10% balance) survives; smaller dies.
                const balanceA = snake.balance || 1.0;
                const balanceB = other.balance || 1.0;
                if (balanceA > balanceB * 1.1) {
                    // A is larger, B dies (handled when other is processed)
                    continue;
                } else if (balanceB > balanceA * 1.1) {
                    // B is larger, A dies
                    deadSnakes.set(snakeId, other);
                } else {
                    // Similar size, both die
                    deadSnakes.set(snakeId, other);
                }
            } else if (A_moving_to_B) {
                // Only A is moving towards B (B is moving away or parallel)
                // A dies, B lives
                deadSnakes.set(snakeId, other);
            } else if (B_moving_to_A) {
                // Only B is moving towards A
                // A lives (B will die when B is processed)
                continue;
            } else {
                // Both are turning away. Both survive!
                continue;
            }
        }
    }

    return deadSnakes;
}


const SLITHER_FOOD_CELL = 64;

function buildSlitherFoodGrid(food, existingGrid) {
    const grid = existingGrid || new Map();
    if (existingGrid) {
        for (const bucket of grid.values()) {
            bucket.length = 0;
        }
    }
    for (let i = 0; i < food.length; i++) {
        const f = food[i];
        const cx = Math.floor(f.x / SLITHER_FOOD_CELL);
        const cy = Math.floor(f.y / SLITHER_FOOD_CELL);
        const key = (cx + 2000) + (cy + 2000) * 10000;
        let bucket = grid.get(key);
        if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
        }
        bucket.push(f);
    }
    return grid;
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
                const key = (cx + 2000) + (cy + 2000) * 10000;
                const bucket = foodGrid.get(key);
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
                const key = (cx + 2000) + (cy + 2000) * 10000;
                const bucket = foodGrid.get(key);
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
    const pelletCount = Math.max(1, segs.length); // One pellet per segment for exact shape
    const massEach = mass / pelletCount;
    const dollarEach = dollars / pelletCount;

    const hueMap = [20, 45, 110, 150, 200, 240, 280, 320, 350];
    const defaultColors = ['#c080ff', '#9099ff', '#80d0d0', '#80ff80', '#eeee70', '#ffa060', '#ff9050', '#ff4040', '#e030e0'];
    let cIdx = defaultColors.indexOf(snake.color);
    if (cIdx === -1 && typeof snake.color === 'number') cIdx = snake.color % hueMap.length;
    const snakeHue = cIdx >= 0 ? hueMap[cIdx] : 0;

    for (let i = 0; i < pelletCount; i++) {
        const seg = segs[i];
        const jitter = 4; // Very small jitter to retain snake shape
        room.slitherFood.push({
            id: randId(),
            x: seg.x + (Math.random() - 0.5) * jitter,
            y: seg.y + (Math.random() - 0.5) * jitter,
            balance: massEach,
            dollarValue: dollarEach,
            hue: snakeHue,
            radius: SLITHER.foodRadius + 0.5,
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
        if (snake.removeTimeout) {
            clearTimeout(snake.removeTimeout);
            delete snake.removeTimeout;
        }
        if (!snake.disconnected) {
            if (!room.spectators) room.spectators = [];
            room.spectators = room.spectators.filter(s => s.id !== socketId);
            const head = snake.segments?.[0];
            room.spectators.push({
                id: socketId,
                x: head?.x ?? snake.x ?? 0,
                y: head?.y ?? snake.y ?? 0,
            });

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
        }
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
                    reason: snake.isBattleRoyale
                        ? 'BR Eliminated'
                        : snake.isTournament ? 'Tournament Death' : 'Arena Death',
                    event: 'death',
                    mode: 'slither',
                    entryFeeUsd: snake.isTournament ? 1 : (snake.entryFeeUsd ?? DEFAULT_ENTRY_FEE),
                    isFreeTicketPlay: !!snake.isFreeTicketPlay,
                    ...(snake.isTournament ? { tournamentId: snake.tournamentId, attempt: snake.tournamentAttempt } : {}),
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
const MAX_VISIBLE_FOOD = 800;
// Keep twice as much ambient food available across the arena. The per-player
// visibility cap stays unchanged so this does not double network/render cost.
const MAX_SLITHER_FOOD_TOTAL = 1400;
const TOURNAMENT_SLITHER_FOOD_TOTAL = 4000;
const SLITHER_FOOD_SYNC_INTERVAL_MS = 375;
const SLITHER_FOOD_REFILL_BATCH = 24;
const TOURNAMENT_SLITHER_FOOD_REFILL_BATCH = 120;
const SLITHER_MINIMAP_BROADCAST_INTERVAL = 4;
/** Extra beyond snake viewRange — tuned to client viewport (~W/2/zoom + margin), not whole arena. */
const SLITHER_FOOD_VIEW_EXTRA = 200;
const SLITHER_FOOD_BROADCAST_INTERVAL = 3;

function downsampleSegmentsForNetwork(segments, maxPoints = MAX_NETWORK_SEGMENTS) {
    if (segments.length <= maxPoints) {
        return segments.map(s => ({ x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10 }));
    }
    const slim = [];
    for (let i = 0; i < maxPoints; i++) {
        const idx = Math.round((i * (segments.length - 1)) / (maxPoints - 1));
        const s = segments[idx];
        if (s) {
            slim.push({ x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10 });
        }
    }
    return slim;
}

function serializeSnake(snake, isYou) {
    const sct = snake.segments.length;
    const sc = radiusScaleForSegmentCount(sct);
    const lengthSc = scaleForSegmentCount(sct);
    const segments = downsampleSegmentsForNetwork(snake.segments, isYou ? MAX_NETWORK_SEGMENTS : 72);
    return {
        id: snake.id,
        name: snake.username,
        balance: snake.balance,
        dollarBalance: snake.dollarBalance,
        color: snake.color,
        isBot: !!snake.isBot,
        isYou,
        segments,
        sct,
        angle: snake.angle || 0,
        sc,
        fam: snake.fam ?? 0,
        wsep: SLITHER.segmentSepFactor * lengthSc,
        radius: SLITHER.baseRadius * sc,
        boost: !!snake.boost,
        isCashingOut: !!snake.isCashingOut,
        cashOutEndTime: snake.cashOutEndTime || 0,
        ...(isYou ? { kills: snake.kills || 0 } : {}),
    };
}

function isInView(cx, cy, x, y, range) {
    return Math.abs(x - cx) <= range && Math.abs(y - cy) <= range;
}

export function syncSlitherFood(room, foodBlobValue, budget, humansInArena, densityPerHuman = 250.0) {
    if (humansInArena <= 0) {
        // A dead player remains in this room as a spectator. Keep the current
        // pellets visible until the room is genuinely empty.
        if ((room.spectators?.length || 0) > 0) {
            enforceSlitherFoodCap(room);
            return;
        }
        clearSlitherFood(room);
        return;
    }

    const now = Date.now();
    if (!room._lastSlitherFoodSync) room._lastSlitherFoodSync = 0;
    if (now - room._lastSlitherFoodSync < SLITHER_FOOD_SYNC_INTERVAL_MS) return;
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
            Math.min(
                room.isTournament ? TOURNAMENT_SLITHER_FOOD_REFILL_BATCH : SLITHER_FOOD_REFILL_BATCH,
                addThreshold - normalCount,
            ),
            foodBlobValue,
            foodValueTarget + goldenValueOnMap,
        );
    } else if (normalCount > trimThreshold) {
        trimSlitherFood(room, targetFoodCount);
    }
    enforceSlitherFoodCap(room, room.isTournament ? TOURNAMENT_SLITHER_FOOD_TOTAL : MAX_SLITHER_FOOD_TOTAL);
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
    const sandboxSkipDeathCollisions = room.isSandbox && room.sandboxInvincible;
    const sandboxSkipFoodCollisions = sandboxSkipDeathCollisions && !room.sandboxBotAi;
    room._sharedFoodGrid = room.slitherFood.length > 80 ? buildSlitherFoodGrid(room.slitherFood, room._sharedFoodGrid) : null;
    const foodGrid = room._sharedFoodGrid;
    const deathDrops = room.slitherFood.filter(f => f.deathDrop);
    const deathDropIds = new Set(deathDrops.map(f => f.id));

    // Update golden food blobs movement: float gently and flee from nearby snakes
    const nowTicks = room._slitherBroadcastTick || 0;
    for (const f of room.slitherFood) {
        if (!f.golden) continue;
        
        // Float logic: drift using a wave motion
        if (f.vx === undefined) {
            f.vx = (Math.random() - 0.5) * 0.4;
            f.vy = (Math.random() - 0.5) * 0.4;
            f.floatAngle = Math.random() * Math.PI * 2;
        }
        
        f.floatAngle += 0.04;
        let driftX = Math.cos(f.floatAngle) * 0.16 + f.vx;
        let driftY = Math.sin(f.floatAngle) * 0.16 + f.vy;
        
        // Flee logic: check if any snake head is nearby and flee from it
        let nearestSnake = null;
        let minDist2 = 14400; // 120 units reach
        for (const { entity: snake } of allSnakes) {
            const head = snake.segments?.[0];
            if (!head) continue;
            const dx = f.x - head.x;
            const dy = f.y - head.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < minDist2) {
                minDist2 = d2;
                nearestSnake = head;
            }
        }
        
        if (nearestSnake) {
            // Run away: calculate flee angle and add to speed
            const fleeAngle = Math.atan2(f.y - nearestSnake.y, f.x - nearestSnake.x);
            // Move speed matches the non-boosting speed (~1.3 units per tick at 40Hz)
            const fleeSpeed = 1.25;
            driftX = Math.cos(fleeAngle) * fleeSpeed;
            driftY = Math.sin(fleeAngle) * fleeSpeed;
        }
        
        f.x += driftX;
        f.y += driftY;
        
        // Keep inside arena boundaries
        const limit = (room.sandboxWorldHalf ?? SLITHER.worldHalf) - 40;
        const distance = Math.hypot(f.x, f.y);
        if (distance > limit && distance > 1e-6) {
            const scale = limit / distance;
            f.x *= scale;
            f.y *= scale;
        }
    }

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

                // BOT CASHOUT LOGIC (Only in real rooms, not sandbox/freeplay)
                const isFreePlay = room.isSandbox || process.env.DEV_FREE_PLAY === 'true';
                if (!isFreePlay) {
                    if (snake.isCashingOut) {
                        if (Date.now() >= snake.cashOutEndTime) {
                            toRemove.push({ snake, isHuman, killer: null, respawnBot: true, returnToPool: false, botCashedOut: true });
                            continue;
                        }
                    } else {
                        if (snake.cashOutThreshold === undefined) {
                            const entryFee = room.entryFeeUsd ?? DEFAULT_ENTRY_FEE;
                            snake.cashOutThreshold = entryFee * (1.0 + Math.random() * 0.8);
                        }
                        if (botWealth >= snake.cashOutThreshold) {
                            snake.isCashingOut = true;
                            snake.cashOutEndTime = Date.now() + 5000;
                            console.log(`⏱️ Slither Bot ${snake.username} started cashout timer (threshold: $${snake.cashOutThreshold.toFixed(2)})`);
                        }
                    }
                }
            }
            runSlitherBotAI(
                snake,
                allSnakes,
                room.slitherFood,
                foodGrid,
                room,
                Date.now(),
                deathDrops,
                deathDropIds,
            );
        }

        // Players keep moving while cashing out (no freeze) — getting eaten cancels the cashout
        updateSnakeMovement(snake, room);
        if (!sandboxSkipFoodCollisions) {
            checkFoodCollisions(snake, room, foodGrid);
        }

        if (isHuman && !isBR && !room.isSandbox) {
            const minMass = minBalanceForSnake(snake);
            const minDollars = minDollarsForSnake(snake);
            // wealthTaxDecayAmount removed here so you don't lose size and balance over time

            if (snake.dollarBalance != null) {
                snake.dollarBalance = Math.max(minDollars, snake.dollarBalance);
            } else {
                snake.balance = Math.max(minDollars, snake.balance);
            }
            snake.balance = Math.max(minMass, snake.balance);
            if (snake.cells?.[0]) snake.cells[0].balance = snake.balance;
        }
    }

    const deadSnakes = sandboxSkipDeathCollisions ? new Map() : resolveAllSnakeCollisions(allSnakes);

    for (const { entity: snake, isHuman } of allSnakes) {
        if (snake.frozen || snake.isStatic) continue;

        // Skip check if the snake was already marked for removal (e.g. over-wealthy bot)
        if (toRemove.some(item => item.snake.id === snake.id)) continue;

        if (!sandboxSkipDeathCollisions) {
            if (checkWallCollision(snake, room) || checkSelfCollision(snake)) {
                toRemove.push({ snake, isHuman, killer: null });
                continue;
            }

            const killer = deadSnakes.get(snake.id);
            if (killer) {
                toRemove.push({ snake, isHuman, killer });
            }
        }
    }

    for (const { snake, isHuman, killer, respawnBot, returnToPool = true, botCashedOut } of toRemove) {
        const lostDollars = eliminateSnake(room, snake, killer, io, User, isHuman, isBR ? false : returnToPool, Transaction);
        if (botCashedOut) {
            const entryFee = room.entryFeeUsd ?? DEFAULT_ENTRY_FEE;
            const botStart = getEconomy(entryFee).botStartBalance;
            const remaining = Math.max(0, lostDollars - botStart);

            // Resten delas 50/50 till owner och food pool
            room.ownerBalance = (room.ownerBalance || 0) + remaining * 0.5;
            room.foodPoolBalance += remaining * 0.5;

            // 1 bot går till AI budget (som spawnas efter 3 sekunder) endast om det finns riktiga spelare
            const humansInArena = room.players.filter(p => p.mode === 'slither').length;
            if (humansInArena > 0) {
                room.aiBudgetBalance += botStart;
                room.pendingSlitherBotSpawns = (room.pendingSlitherBotSpawns || 0) + 1;
                setTimeout(() => {
                    room.pendingSlitherBotSpawns = Math.max(0, (room.pendingSlitherBotSpawns || 0) - 1);
                }, 3000);
            } else {
                room.ownerBalance = (room.ownerBalance || 0) + botStart;
            }

            console.log(`🤖 Slither Bot ${snake.username} successfully cashed out $${lostDollars.toFixed(2)}. remaining: $${remaining.toFixed(2)} (50/50 split), botStart: $${botStart.toFixed(2)} (delayed spawn: ${humansInArena > 0})`);
        } else if (!isBR && respawnBot) {
            const humansInArena = room.players.filter(p => p.mode === 'slither').length;
            const effectiveHumans = humansInArena > 0 ? humansInArena : (room.slitherBots.length > 0 ? 1 : 0);
            const targetBots = getSlitherTargetBots(effectiveHumans);
            const activeSlitherBots = room.slitherBots.length + (room.pendingSlitherBotSpawns || 0);
            if (activeSlitherBots < targetBots) {
                addSlitherBots(room, targetBots - activeSlitherBots, getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE).botStartBalance);
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

    enforceSlitherFoodCap(room);

    return slitherLeaderboard;
}

export function broadcastSlitherState(room, io, slitherLeaderboard, meta) {
    const allSnakes = getAllSlitherSnakes(room);
    const range = 1800; // Increased view range for normal slither culling
    const foodRange = range + 500;
    const now = Date.now();
    const sendLeaderboard = !room._lastLbAt || now - room._lastLbAt >= 500;
    if (sendLeaderboard) room._lastLbAt = now;

    room._slitherBroadcastTick = (room._slitherBroadcastTick || 0) + 1;
    const sendFoodThisTick = room._slitherBroadcastTick % SLITHER_FOOD_BROADCAST_INTERVAL === 0;
    const sendMinimapThisTick = room._slitherBroadcastTick % SLITHER_MINIMAP_BROADCAST_INTERVAL === 0;

    const slitherPlayers = room.players.filter(p => p.mode === 'slither' && !p.disconnected);
    const spectators = room.spectators || [];

    const serializedSnakesNotYou = new Map();
    for (const { entity: s } of allSnakes) {
        serializedSnakesNotYou.set(s.id, serializeSnake(s, false));
    }
    const serializedSnakesYou = new Map();
    for (const p of slitherPlayers) {
        serializedSnakesYou.set(p.id, serializeSnake(p, true));
    }

    const needsFoodRefresh = sendFoodThisTick || slitherPlayers.some(p => !room._lastSlitherFoodByPlayer?.[p.id]) || spectators.length > 0;
    const broadcastFoodGrid = needsFoodRefresh && room.slitherFood.length > 80
        ? buildSlitherFoodGrid(room.slitherFood, room._sharedFoodGrid)
        : null;
    if (broadcastFoodGrid) room._sharedFoodGrid = broadcastFoodGrid;

    // Collect all receivers (active players + spectators)
    const receivers = [];
    slitherPlayers.forEach(p => {
        const head = p.segments?.[0];
        if (head) {
            receivers.push({
                id: p.id,
                x: head.x,
                y: head.y,
                isSpectator: false,
                playerObj: p
            });
        }
    });
    spectators.forEach(s => {
        receivers.push({
            id: s.id,
            x: s.x,
            y: s.y,
            isSpectator: true,
            playerObj: null
        });
    });

    receivers.forEach(r => {
        const head = { x: r.x, y: r.y };

        if (sendLeaderboard) {
            io.to(r.id).emit('leaderboard', { leaderboard: slitherLeaderboard, battleRoyale: !!meta.battleRoyale });
        }

        const visibleSnakes = allSnakes
            .filter(({ entity: s }) => {
                const h = s.segments[0];
                if (!h) return false;

                // Bypass culling in Arena modes since the map is small
                if (!room.isBattleRoyale && !meta.battleRoyale) return true;

                // For Battle Royale, check if any segment is in view (with a buffer) so large snakes don't pop out
                const buffer = 400; // Extra buffer to cover large snake body parts
                for (let i = 0; i < s.segments.length; i += 8) {
                    const seg = s.segments[i];
                    if (isInView(head.x, head.y, seg.x, seg.y, range + buffer)) {
                        return true;
                    }
                }
                const last = s.segments[s.segments.length - 1];
                if (last && isInView(head.x, head.y, last.x, last.y, range + buffer)) {
                    return true;
                }
                return false;
            })
            .map(({ entity: s }) => {
                const isYou = !r.isSpectator && s.id === r.id;
                return isYou ? serializedSnakesYou.get(s.id) : serializedSnakesNotYou.get(s.id);
            });

        let visibleFood = null;
        const refreshFood = r.isSpectator || sendFoodThisTick || !room._lastSlitherFoodByPlayer?.[r.id];
        if (refreshFood) {
            visibleFood = collectSlitherFoodInView(
                room.slitherFood,
                broadcastFoodGrid,
                head.x,
                head.y,
                foodRange,
                MAX_VISIBLE_FOOD,
            );
            if (!r.isSpectator) {
                if (!room._lastSlitherFoodByPlayer) room._lastSlitherFoodByPlayer = {};
                room._lastSlitherFoodByPlayer[r.id] = visibleFood;
            }
        }

        let minimap = null;
        const refreshMinimap = r.isSpectator || sendMinimapThisTick || !room._lastSlitherMinimapByPlayer?.[r.id];
        if (refreshMinimap) {
            const minimapPlayers = allSnakes.map(({ entity: s }) => {
                const h = s.segments[0];
                if (!h) return null;
                if (!isInView(head.x, head.y, h.x, h.y, SLITHER.minimapThreatRange)) return null;
                return {
                    x: Math.round(h.x),
                    y: Math.round(h.y),
                    you: !r.isSpectator && s.id === r.id,
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

            minimap = {
                players: minimapPlayers,
                food: minimapFood,
            };
            if (!r.isSpectator) {
                if (!room._lastSlitherMinimapByPlayer) room._lastSlitherMinimapByPlayer = {};
                room._lastSlitherMinimapByPlayer[r.id] = minimap;
            }
        }

        const tickPayload = {
            you: r.isSpectator ? null : r.id,
            snakes: visibleSnakes,
            worldHalf: room.sandboxWorldHalf ?? SLITHER.worldHalf,
            circularMap: true,
            ...meta,
            ...(meta.battleRoyale || r.isSpectator ? {} : { balance: r.playerObj.dollarBalance ?? r.playerObj.balance }),
        };
        if (visibleFood) tickPayload.food = visibleFood;
        if (minimap) tickPayload.minimap = minimap;

        io.to(r.id).emit('slitherTick', tickPayload);
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
        balance: startMass,
        dollarBalance: dollarStart,
        entryFeeUsd: room.entryFeeUsd ?? DEFAULT_ENTRY_FEE,
        startTime: Date.now(),
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
            balance: startMass,
            radius: headRadiusForBalance(startMass),
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

export function isCompetitiveSpawnClear(room, x, y, minDist = 120) {
    for (const { entity: s } of getCompetitiveSnakes(room)) {
        const r = headRadiusForSnake(s);
        const spacing = segmentSpacingForSegmentCount(s.segments?.length || SLITHER.spawnSegments);
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
    let bestX = 0;
    let bestY = 0;
    let maxMinDist = -1;

    for (let i = 0; i < 100; i++) {
        const { x, y } = randomCompetitiveSpawnCoord();
        let minDistToAnySegment = Infinity;

        for (const { entity: s } of getCompetitiveSnakes(room)) {
            const r = headRadiusForSnake(s);
            for (let j = 0; j < (s.segments?.length ?? 0); j += (j === 0 ? 1 : 8)) {
                const seg = s.segments[j];
                const segR = j === 0 ? r : r * 0.75;
                const d = dist(x, y, seg.x, seg.y) - segR;
                if (d < minDistToAnySegment) {
                    minDistToAnySegment = d;
                }
            }
            const last = s.segments?.[s.segments.length - 1];
            if (last) {
                const d = dist(x, y, last.x, last.y) - (r * 0.75);
                if (d < minDistToAnySegment) minDistToAnySegment = d;
            }
        }

        if (minDistToAnySegment > 180) {
            return { x, y };
        }

        if (minDistToAnySegment > maxMinDist) {
            maxMinDist = minDistToAnySegment;
            bestX = x;
            bestY = y;
        }
    }

    if (maxMinDist > 30) {
        return { x: bestX, y: bestY };
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

export function clampCompetitiveSpawnToZone(x, y, effectiveRadius, balance) {
    const distanceFromCenter = Math.hypot(x, y);
    const safeRadius = Math.max(0, effectiveRadius - Math.max(160, headRadiusForBalance(balance) * 6));
    if (distanceFromCenter <= safeRadius || distanceFromCenter < 1e-6) return { x, y };
    const scale = safeRadius / distanceFromCenter;
    return { x: x * scale, y: y * scale };
}

export function createCompetitiveSlitherAdminBot(room, effectiveRadius, nearX = null, nearY = null) {
    const eco = getCompetitiveEconomy(room.entryFeeUsd);
    const startMass = eco.playerStartBalance;
    let spawn;

    if (Number.isFinite(nearX) && Number.isFinite(nearY)) {
        spawn = clampCompetitiveSpawnToZone(nearX, nearY, effectiveRadius, startMass);
    } else {
        const maxRadius = Math.max(0, effectiveRadius - Math.max(180, headRadiusForBalance(startMass) * 6));
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.sqrt(Math.random()) * maxRadius * 0.78;
        spawn = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    }

    const { x, y } = spawn;
    const angle = Math.hypot(x, y) > 1
        ? Math.atan2(-y, -x)
        : Math.random() * Math.PI * 2;
    return {
        id: 'bot_' + randId(),
        mongoId: null,
        username: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
        mode: 'competitive-slither',
        kills: 0,
        balance: startMass,
        dollarBalance: eco.dollarStart,
        entryFeeUsd: eco.entryFeeUsd,
        botStake: eco.dollarStart,
        startTime: Date.now(),
        color: util.randomSlitherColor(),
        x,
        y,
        inputDx: Math.cos(angle),
        inputDy: Math.sin(angle),
        boost: false,
        targetX: 0,
        targetY: 0,
        lastTargetUpdate: 0,
        angle,
        fam: 0,
        segments: createSegments(x, y, startMass, angle),
        screenWidth: 1920,
        screenHeight: 1080,
        isBot: true,
        adminSpawned: true,
    };
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
        .filter(p => p.mode === 'competitive-slither' && p.segments?.length)
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
    const r = headRadiusForSnake(snake);
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
            // Render with the normal dead-snake food shape and clustering,
            // while hue 48 keeps the arena payout unmistakably golden.
            hue: 48,
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

    if (snake.removeTimeout) {
        clearTimeout(snake.removeTimeout);
        delete snake.removeTimeout;
    }
    dropCompetitiveSnakeAsFood(room, snake);
    room.players = room.players.filter(p => p.id !== snake.id);

    // Admin bots are server-owned entities: never turn them into spectators or
    // run account writes for their null mongoId.
    if (snake.isBot) return;

    const socketId = snake.id;
    if (!snake.disconnected) {
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
    }
    if (room._lastCompFoodByPlayer) {
        delete room._lastCompFoodByPlayer[socketId];
    }

    if (!snake.disconnected) io.to(socketId).emit('RIP');
    if (snake.mongoId) {
        User.findByIdAndUpdate(snake.mongoId, { $inc: { playtime: Date.now() - snake.startTime } }).catch(() => {});
    }
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
        // Spectators still need the existing arena state after the last snake dies.
        if ((room.competitiveSpectators?.length || 0) > 0) return;
        const protectedFood = room.slitherFood.filter(f => f.competitiveDeathDrop);
        room.slitherFood = protectedFood;
        return;
    }

    const now = Date.now();
    if (!room._lastCompetitiveFoodSync) room._lastCompetitiveFoodSync = 0;
    if (now - room._lastCompetitiveFoodSync < SLITHER_FOOD_SYNC_INTERVAL_MS) return;
    room._lastCompetitiveFoodSync = now;

    const densityScale = competitiveFoodDensityScale();
    const target = Math.max(80, Math.floor(playerCount * COMPETITIVE_SLITHER.foodDensityPerHuman * densityScale * 2));
    const normalCount = room.slitherFood.filter(f => !f.competitiveDeathDrop).length;

    if (normalCount < target * 0.94) {
        addCompetitiveSlitherFood(room, Math.min(SLITHER_FOOD_REFILL_BATCH, Math.floor(target * 0.94) - normalCount));
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
    const sc = radiusScaleForSegmentCount(sct);
    const lengthSc = scaleForSegmentCount(sct);
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
        wsep: SLITHER.segmentSepFactor * lengthSc,
        radius: SLITHER.baseRadius * sc,
        boost: !!snake.boost,
        isCashingOut: !!snake.isCashingOut,
        cashOutEndTime: snake.cashOutEndTime || 0,
        ...(isYou ? { kills: snake.kills || 0 } : {}),
    };
}

export function processCompetitiveSlitherRoom(room, io, User, Transaction, resetTime) {
    const effectiveRadius = getCompetitiveEffectiveRadius(resetTime);
    const allSnakes = getCompetitiveSnakes(room);
    const toRemove = [];
    const paidDeathDrops = room.slitherFood.filter(
        f => f.competitiveDeathDrop && (f.dollarValue || 0) > 0
    );
    const paidDeathDropIds = new Set(paidDeathDrops.map(f => f.id));

    for (const { entity: snake } of allSnakes) {
        if (snake.isBot) {
            runCompetitiveSlitherBotAI(
                snake,
                allSnakes,
                room.slitherFood,
                effectiveRadius,
                paidDeathDrops,
                paidDeathDropIds,
            );
        }
        updateCompetitiveSnakeMovement(snake);
        checkCompetitiveFoodCollisions(snake, room);
    }

    const deadSnakes = resolveAllSnakeCollisions(allSnakes);

    for (const { entity: snake } of allSnakes) {
        if (toRemove.some(item => item.snake.id === snake.id)) continue;

        if (checkCompetitiveBoundary(snake, effectiveRadius) || checkSelfCollision(snake)) {
            toRemove.push({ snake, killer: null });
            continue;
        }

        const killer = deadSnakes.get(snake.id);
        if (killer) {
            toRemove.push({ snake, killer });
        }
    }

    for (const { snake, killer } of toRemove) {
        const respawnAdminBot = false; // Disable infinite automatic respawning of admin-spawned bots
        eliminateCompetitiveSnake(room, snake, killer, io, User, Transaction);
        if (respawnAdminBot) {
            room.players.push(createCompetitiveSlitherAdminBot(room, effectiveRadius));
        }
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
    const sendMinimapThisTick = room._compSlitherBroadcastTick % SLITHER_MINIMAP_BROADCAST_INTERVAL === 0;

    // Bots have fake IDs, not sockets. Never build or emit viewer payloads for them.
    const compPlayers = room.players.filter(
        p => p.mode === 'competitive-slither' && !p.isBot && !p.disconnected
    );
    const compSpecs = room.competitiveSpectators || [];
    const needsCompFoodRefresh = sendFoodThisTick
        || compPlayers.some(p => !room._lastCompFoodByPlayer?.[p.id])
        || compSpecs.some(s => !room._lastCompFoodByPlayer?.[s.id]);
    const compFoodGrid = needsCompFoodRefresh && room.slitherFood.length > 80
        ? buildSlitherFoodGrid(room.slitherFood, room._sharedCompFoodGrid)
        : null;
    if (compFoodGrid) room._sharedCompFoodGrid = compFoodGrid;

    const emitTickToViewer = (viewer) => {
        const { socketId, viewX, viewY, youId, dollarBalance, spectating } = viewer;
        const head = { x: viewX, y: viewY };

        if (sendLeaderboard) {
            io.to(socketId).emit('leaderboard', { leaderboard, competitiveSlither: true });
        }

        const visibleSnakes = allSnakes
            .filter(({ entity: s }) => s.segments?.[0])
            .map(({ entity: s }) => serializeCompetitiveSnake(s, s.id === youId));

        let visibleFood = null;
        const refreshFood = sendFoodThisTick
            || !room._lastCompFoodByPlayer?.[socketId];
        if (refreshFood) {
            visibleFood = room.slitherFood.map(f => serializeVisibleSlitherFood(f, COMPETITIVE_SLITHER.foodRadius));
            if (!room._lastCompFoodByPlayer) room._lastCompFoodByPlayer = {};
            room._lastCompFoodByPlayer[socketId] = visibleFood;
        }

        let minimap = null;
        if (sendMinimapThisTick || !room._lastCompMinimapByPlayer?.[socketId]) {
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

            minimap = { players: minimapPlayers, food: minimapFood };
            if (!room._lastCompMinimapByPlayer) room._lastCompMinimapByPlayer = {};
            room._lastCompMinimapByPlayer[socketId] = minimap;
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
