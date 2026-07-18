Exit code: 0
Wall time: 0.7 seconds
Total output lines: 4396
Output:
/**
 * Surviv â€” top-down battle royale shooter engine.
 * Inspired by surviv.io mechanics: loot, weapons, shrinking zone, contested economy.
 */

import { getSurvivEconomy } from './economy.js';

const TICK_RATE = 40;
const TICK_DT = 1 / TICK_RATE;
const MELEE_ANIMATION_MS = 280;
const SURVIV_MAX_WEAPONS = 2;
const SURVIV_MELEE_SLOT = SURVIV_MAX_WEAPONS;
const SURVIV_MAX_MEDKITS = 6;
const SURVIV_MAX_AMMO_PACKS = 9;
const SURVIV_MAX_GRENADES = 3;

export const SURVIV = {
    worldHalf: 10000,
    shrinkBeforeResetMs: 3 * 60 * 1000,

    playerRadius: 14,
    playerSpeed: 5.2,
    viewRange: 1200,
    botMinCount: 2,
    botMaxCount: 8,
    minZoneRadius: 1150,
    zoneDamagePerSecond: 12,
    reconnectGraceMs: 20 * 1000,
    bulletLifetimeMs: 1800,
    lootPickupRadius: 34,
    chestOpenRadius: 92,
    medkitUseMs: 2500,
    grenadeFuseMs: 850,
    grenadeSpeed: 15,
    grenadeRadius: 145,
    grenadeDamage: 62,
};

export const WEAPONS = {
    fists: {
        id: 'fists',
        label: 'Fists',
        rarity: 'common',
        damage: 18,
        fireRateMs: 430,
        melee: true,
        meleeReach: 58,
        meleeArc: 0.95,
        clipSize: 0,
        reloadMs: 0,
        spread: 0,
        bulletSpeed: 0,
        pellets: 0,
    },
    knife: {
        id: 'knife',
        label: 'Combat Knife',
        rarity: 'rare',
        damage: 34,
        fireRateMs: 340,
        melee: true,
        meleeReach: 76,
        meleeArc: 0.78,
        clipSize: 0,
        reloadMs: 0,
        spread: 0,
        bulletSpeed: 0,
        pellets: 0,
    },
    pistol: {
        id: 'pistol',
        label: 'Pistol',
        rarity: 'common',
        damage: 11,
        fireRateMs: 380,
        clipSize: 15,
        reloadMs: 1400,
        spread: 0.06,
        bulletSpeed: 34,
        pellets: 1,
    },
    smg: {
        id: 'smg',
        label: 'SMG',
        rarity: 'common',
        damage: 7,
        fireRateMs: 90,
        clipSize: 30,
        reloadMs: 1800,
        spread: 0.14,
        bulletSpeed: 38,
        pellets: 1,
    },
    shotgun: {
        id: 'shotgun',
        label: 'Shotgun',
        rarity: 'rare',
        damage: 5,
        fireRateMs: 750,
        clipSize: 6,
        reloadMs: 2200,
        spread: 0.32,
        bulletSpeed: 30,
        pellets: 5,
    },
    assault: {
        id: 'assault',
        label: 'Assault',
        rarity: 'rare',
        damage: 14,
        fireRateMs: 160,
        clipSize: 22,
        reloadMs: 2000,
        spread: 0.09,
        bulletSpeed: 42,
        pellets: 1,
    },
    revolver: {
        id: 'revolver',
        label: 'Revolver',
        rarity: 'common',
        damage: 18,
        fireRateMs: 520,
        clipSize: 6,
        reloadMs: 1500,
        spread: 0.035,
        bulletSpeed: 44,
        pellets: 1,
    },
    dmr: {
        id: 'dmr',
        label: 'DMR',
        rarity: 'rare',
        damage: 24,
        fireRateMs: 360,
        clipSize: 10,
        reloadMs: 1900,
        spread: 0.025,
        bulletSpeed: 48,
        pellets: 1,
    },
    sniper: {
        id: 'sniper',
        label: 'Sniper',
        rarity: 'military',
        damage: 48,
        fireRateMs: 950,
        clipSize: 5,
        reloadMs: 2400,
        spread: 0.012,
        bulletSpeed: 58,
        pellets: 1,
    },
    lmg: {
        id: 'lmg',
        label: 'LMG',
        rarity: 'military',
        damage: 10,
        fireRateMs: 105,
        clipSize: 45,
        reloadMs: 2600,
        spread: 0.13,
        bulletSpeed: 40,
        pellets: 1,
    },
};

const BOT_NAMES = [
    'Scout', 'Raider', 'Ghost', 'Viper', 'Hawk', 'Wolf', 'Rogue', 'Blaze',
    'Nomad', 'Cipher', 'Ranger', 'Striker', 'Hunter', 'Ace', 'Reaper',
];

const WEAPON_RARITY_POOLS = {
    common: ['revolver', 'revolver', 'smg', 'shotgun'],
    rare: ['knife', 'smg', 'shotgun', 'assault', 'assault', 'dmr'],
    military: ['assault', 'dmr', 'dmr', 'sniper', 'lmg'],
};
const LOOT_WEAPON_TYPES = [...new Set(Object.values(WEAPON_RARITY_POOLS).flat().filter(w => w !== 'pistol'))];
const SURVIV_OBSTACLE_CELL = 700;
const SURVIV_LOOT_CELL = 600;
const SURVIV_STATIC_PAYLOAD_INTERVAL_MS = 1500;
const SURVIV_STATIC_PAYLOAD_MOVE_THRESHOLD = 320;
const SURVIV_DESTRUCTIBLE_OBSTACLE_HP = Object.freeze({
    bush: 18,
    furniture: 28,
    crate: 36,
    barrel: 42,
    tent: 54,
    door: 60,
    tree: 84,
    sandbag: 96,
    rock: 132,
});

function randId() {
    return Math.random().toString(36).slice(2, 10);
}

function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq <= 1e-9) return dist(px, py, x1, y1);
    const t = clamp(((px - x1) * dx + (py - y1) * dy) / lengthSq, 0, 1);
    return dist(px, py, x1 + dx * t, y1 + dy * t);
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function normalize(dx, dy) {
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { dx: 0, dy: 0 };
    return { dx: dx / len, dy: dy / len };
}

function randomSpawnCoord(worldHalf) {
    const maxR = worldHalf * 0.82;
    const r = maxR * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function pickWeaponForTier(tier = 'common') {
    const pool = WEAPON_RARITY_POOLS[tier] || WEAPON_RARITY_POOLS.common;
    return pool[Math.floor(Math.random() * pool.length)];
}

function toRectLocal(px, py, rect) {
    const angle = -(Number(rect.rotation) || 0);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = px - rect.x;
    const dy = py - rect.y;
    return {
        x: dx * cos - dy * sin,
        y: dx * sin + dy * cos,
    };
}

function fromRectLocal(px, py, rect) {
    const angle = Number(rect.rotation) || 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
        x: rect.x + px * cos - py * sin,
        y: rect.y + px * sin + py * cos,
    };
}

function pointInRect(px, py, rect) {
    const local = toRectLocal(px, py, rect);
    return Math.abs(local.x) <= rect.w / 2 && Math.abs(local.y) <= rect.h / 2;
}

function lineSegmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
    const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (Math.abs(d) < 1e-9) return false;
    const u = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
    const v = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

function lineSegmentRectIntersects(x1, y1, x2, y2, rect) {
    const start = toRectLocal(x1, y1, rect);
    const end = toRectLocal(x2, y2, rect);
    const rxMin = -rect.w / 2;
    const rxMax = rect.w / 2;
    const ryMin = -rect.h / 2;
    const ryMax = rect.h / 2;
    const startInside = start.x >= rxMin && start.x <= rxMax && start.y >= ryMin && start.y <= ryMax;
    const endInside = end.x >= rxMin && end.x <= rxMax && end.y >= ryMin && end.y <= ryMax;
    if (startInside || endInside) return true;

    return lineSegmentsIntersect(start.x, start.y, end.x, end.y, rxMin, ryMin, rxMin, ryMax)
        || lineSegmentsIntersect(start.x, start.y, end.x, end.y, rxMax, ryMin, rxMax, ryMax)
        || lineSegmentsIntersect(start.x, start.y, end.x, end.y, rxMin, ryMin, rxMax, ryMin)
        || lineSegmentsIntersect(start.x, start.y, end.x, end.y, rxMin, ryMax, rxMax, ryMax);
}

function segmentRectHitT(x1, y1, x2, y2, rect) {
    const start = toRectLocal(x1, y1, rect);
    const end = toRectLocal(x2, y2, rect);
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const minX = -rect.w / 2;
    const maxX = rect.w / 2;
    const minY = -rect.h / 2;
    const maxY = rect.h / 2;
    let enter = 0;
    let exit = 1;

    const clipAxis = (origin, delta, min, max) => {
        if (Math.abs(delta) < 1e-9) return origin >= min && origin <= max;
        let first = (min - origin) / delta;
        let second = (max - origin) / delta;
        if (first > second) [first, second] = [second, first];
        enter = Math.max(enter, first);
        exit = Math.min(exit, second);
        return enter <= exit;
    };

    if (!clipAxis(start.x, deltaX, minX, maxX)) return null;
    if (!clipAxis(start.y, deltaY, minY, maxY)) return null;
    return enter >= 0 && enter <= 1 ? enter : null;
}

function segmentCircleHitT(x1, y1, x2, y2, cx, cy, radius) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const fx = x1 - cx;
    const fy = y1 - cy;
    const a = dx * dx + dy * dy;
    if (a <= 1e-9) return Math.hypot(fx, fy) <= radius ? 0 : null;
    const c = fx * fx + fy * fy - radius * radius;
    if (c <= 0) return 0;
    const b = 2 * (fx * dx + fy * dy);
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    const first = (-b - root) / (2 * a);
    const second = (-b + root) / (2 * a);
    if (first >= 0 && first <= 1) return first;
    if (second >= 0 && second <= 1) return second;
    return null;
}

function circleRectCollision(cx, cy, r, rect) {
    const local = toRectLocal(cx, cy, rect);
    const closestX = clamp(local.x, -rect.w / 2, rect.w / 2);
    const closestY = clamp(local.y, -rect.h / 2, rect.h / 2);
    return Math.hypot(local.x - closestX, local.y - closestY) < r;
}
function isNearRoadOrRiver(x, y, radius = 30) {
    const roadHalfW = 60 + radius + 10; // 10 units extra buffer
    // West N-S Highway: x = -2500
    if (Math.abs(x - (-2500)) < roadHalfW) return true;
    // East N-S Highway: x = 2500
    if (Math.abs(x - 2500) < roadHalfW) return true;
    // Central E-W Highway: y = 2000
    if (Math.abs(y - 2000) < roadHalfW) return true;
    // North E-W Highway: y = -4000
    if (Math.abs(y - (-4000)) < roadHalfW) return true;

    // Center branch: x = 0, y from 0 to 2000
    if (Math.abs(x) < roadHalfW && y >= -60 && y <= 2060) return true;
    // South Villa branch: x = -200, y from 2000 to 5200
    if (Math.abs(x - (-200)) < roadHalfW && y >= 1940 && y <= 5260) return true;
    // Gas station branch: y = -7800, x from -2500 to -1500
    if (Math.abs(y - (-7800)) < roadHalfW && x >= -2560 && x <= -1440) return true;
    // Hospital branch: y = 1500, x from 2500 to 5500
    if (Math.abs(y - 1500) < roadHalfW && x >= 2440 && x <= 5560) return true;
    // Container docks branch: x = -5200, y from -800 to 2000
    if (Math.abs(x - (-5200)) < roadHalfW && y >= -860 && y <= 2060) return true;
    // Military branch: x = 3200, y from -5200 to -4000
    if (Math.abs(x - 3200) < roadHalfW && y >= -5260 && y <= -3940) return true;
    // Quarry branch: x = 7400, y from -4000 to -3200
    if (Math.abs(x - 7400) < roadHalfW && y >= -4060 && y <= -3140) return true;
    // Prison branch: x = 5200, y from 2000 to 4800
    if (Math.abs(x - 5200) < roadHalfW && y >= 1940 && y <= 4860) return true;
    // Radio tower branch: x = -5400, y from 2000 to 4200
    if (Math.abs(x - (-5400)) < roadHalfW && y >= 1940 && y <= 4260) return true;
    // Pine town branch: x = -4200, y from -4200 to -4000
    if (Math.abs(x - (-4200)) < roadHalfW && y >= -4260 && y <= -3940) return true;

    // River path: roughly at y between -2200 and -800
    if (y >= -2100 && y <= -900) return true;

    return false;
}

// Prevent generated cover from piling onto structures, terrain, roads, or other solid props.
// This is intentionally broader than player collision: it keeps map composition readable.
const BLOCKED_KINDS = new Set([
    'houseFloor', 'wall', 'interiorWall', 'door', 'furniture', 'container', 'house',
    'road', 'water', 'river', 'bridge',
    'tree', 'rock', 'crate', 'barrel', 'sandbag', 'tent',
]);
function isMapPositionBlocked(obstacles, x, y, radius = 30) {
    if (isNearRoadOrRiver(x, y, radius)) return true;

    for (const o of obstacles) {
        if (!BLOCKED_KINDS.has(o.kind)) continue;
        // Expand the rect by the placement radius so trees don't clip edges
        const pad = radius + 12;
        if (x >= o.x - o.w / 2 - pad && x <= o.x + o.w / 2 + pad
            && y >= o.y - o.h / 2 - pad && y <= o.y + o.h / 2 + pad) {
            return true;
        }
    }
    return false;
}

function resolveCircleRect(cx, cy, r, rect) {
    const local = toRectLocal(cx, cy, rect);
    const halfW = rect.w / 2;
    const halfH = rect.h / 2;
    const closestX = clamp(local.x, -halfW, halfW);
    const closestY = clamp(local.y, -halfH, halfH);
    const dx = local.x - closestX;
    const dy = local.y - closestY;
    const distance = Math.hypot(dx, dy);
    if (distance >= r) return { x: cx, y: cy };

    let resolvedX = local.x;
    let resolvedY = local.y;
    if (distance < 1e-6) {
        const left = Math.abs(local.x + halfW);
        const right = Math.abs(halfW - local.x);
        const top = Math.abs(local.y + halfH);
        const bottom = Math.abs(halfH - local.y);
        const nearestEdge = Math.min(left, right, top, bottom);
        if (nearestEdge === left) resolvedX = -halfW - r;
        else if (nearestEdge === right) resolvedX = halfW + r;
        else if (nearestEdge === top) resolvedY = -halfH - r;
        else resolvedY = halfH + r;
    } else {
        const overlap = r - distance;
        resolvedX += (dx / distance) * overlap;
        resolvedY += (dy / distance) * overlap;
    }
    return fromRectLocal(resolvedX, resolvedY, rect);
}
function randomMoneyAmount(minCents = 20, maxCents = 200) {
    const min = Math.max(1, Math.round(minCents));
    const max = Math.max(min, Math.round(maxCents));
    return Number(((min + Math.floor(Math.random() * (max - min + 1))) / 100).toFixed(2));
}

function randomChestContents(tier = 'common', options = {}) {
    const outdoor = options.outdoor === true;
    const contents = { rarity: tier };

    const baseMoneyChance = tier === 'military' ? 0.42 : tier === 'rare' ? 0.34 : 0.24;
    const moneyChance = options.includeMoney === false
        ? 0
        : options.includeMoney === true
            ? 1
            : baseMoneyChance * (outdoor ? 0.58 : 1);
    if (Math.random() < moneyChance) {
        contents.money = randomMoneyAmount(20, outdoor ? 125 : 200);
    }

    const weaponChanceBase = tier === 'military' ? 1 : tier === 'rare' ? 0.82 : 0.48;
    const weaponChance = outdoor ? weaponChanceBase * 0.68 : weaponChanceBase;
    if (Math.random() < weaponChance) contents.weaponType = pickWeaponForTier(tier);

    contents.ammoPacks = tier === 'military'
        ? 2 + Math.floor(Math.random() * 2)
        : tier === 'rare' ? 2 : 1;
    if (Math.random() < (tier === 'military' ? 0.55 : tier === 'rare' ? 0.35 : 0.16)) {
        contents.grenades = 1;
    }
    const medkitChance = (tier === 'military' ? 0.86 : tier === 'rare' ? 0.68 : 0.36) * (outdoor ? 0.78 : 1);
    if (Math.random() < medkitChance) {
        contents.medkits = tier === 'military' && Math.random() > 0.55 ? 2 : 1;
    }
    const armorChance = (tier === 'military' ? 0.9 : tier === 'rare' ? 0.62 : 0.24) * (outdoor ? 0.72 : 1);
    if (Math.random() < armorChance) {
        contents.armor = tier === 'military' ? 60 : 35;
    }
    return contents;
}

function makeChest(x, y, tier = 'common', contents = null, source = 'map', options = {}) {
    const chestContents = contents || randomChestContents(tier, options);
    return {
        id: randId(),
        type: source === 'death' ? 'deathCrate' : 'chest',
        x,
        y,
        tier,
        contents: chestContents,
        source,
        houseId: options.houseId || null,
        landmarkType: options.landmarkType || null,
        room: options.room || null,
    };
}

function makeGroundLoot(type, x, y, extra = {}) {
    return {
        id: randId(),
        type,
        x,
        y,
        source: extra.source || 'ground',
        ...extra,
    };
}

function addObstacle(obstacles, kind, x, y, w, h, opts = {}) {
    const options = typeof opts === 'string' ? { variant: opts } : (opts || {});
    const defaultHp = options.collidable === false ? null : SURVIV_DESTRUCTIBLE_OBSTACLE_HP[kind];
    const maxHp = Number.isFinite(options.maxHp) ? Math.max(1, options.maxHp) : defaultHp;
    const obstacle = {
        id: randId(),
        kind,
        x,
        y,
        w,
        h,
        hue: options.hue,
        rotation: options.rotation || 0,
        collidable: options.collidable !== false,
        variant: options.variant || null,
        biome: options.biome || null,
        label: options.label || null,
        houseId: options.houseId || null,
        roomId: options.roomId || null,
        role: options.role || null,
        landmarkType: options.landmarkType || null,
        entranceRole: options.entranceRole || null,
        orientation: options.orientation || null,
        points: Array.isArray(options.points) ? options.points : null,
        width: Number.isFinite(options.width) ? options.width : null,
        ...(Number.isFinite(maxHp) ? {
            destructible: options.destructible !== false,
            hp: Number.isFinite(options.hp) ? clamp(options.hp, 0, maxHp) : maxHp,
            maxHp,
        } : {}),
    };
    obstacles.push(obstacle);
    return obstacle;
}

const NETWORK_ROAD_BLOCKER_KINDS = new Set(['houseFloor', 'wall', 'interiorWall', 'door', 'container']);

function subtractRoadCuts(intervals, cuts) {
    let remaining = intervals;
    for (const cut of cuts) {
        const next = [];
        for (const span of remaining) {
            if (cut.max <= span.min || cut.min >= span.max) {
                next.push(span);
                continue;
            }
            if (cut.min > span.min) next.push({ min: span.min, max: Math.min(cut.min, span.max) });
            if (cut.max < span.max) next.push({ min: Math.max(cut.max, span.min), max: span.max });
        }
        remaining = next;
        if (!remaining.length) break;
    }
    return remaining;
}

function addNetworkRoadSegment(obstacles, x1, y1, x2, y2, width) {
    const horizontal = Math.abs(x2 - x1) > Math.abs(y2 - y1);
    const min = Math.min(horizontal ? x1 : y1, horizontal ? x2 : y2) - width / 2;
    const max = Math.max(horizontal ? x1 : y1, horizontal ? x2 : y2) + width / 2;
    const center = horizontal ? y1 : x1;
    const pad = width * 0.72;
    const cuts = [];

    for (const o of obstacles) {
        if (!NETWORK_ROAD_BLOCKER_KINDS.has(o.kind)) continue;
        const crossMin = (horizontal ? o.y - o.h / 2 : o.x - o.w / 2) - pad;
        const crossMax = (horizontal ? o.y + o.h / 2 : o.x + o.w / 2) + pad;
        if (center < crossMin || center > crossMax) continue;
        cuts.push({
            min: (horizontal ? o.x - o.w / 2 : o.y - o.h / 2) - pad,
            max: (horizontal ? o.x + o.w / 2 : o.y + o.h / 2) + pad,
        });
    }

    const spans = subtractRoadCuts([{ min, max }], cuts.sort((a, b) => a.min - b.min));
    for (const span of spans) {
        const length = span.max - span.min;
        if (length < width * 0.9) continue;
        addObstacle(obstacles, 'road',
            horizontal ? (span.min + span.max) / 2 : center,
            horizontal ? center : (span.min + span.max) / 2,
            horizontal ? length : width,
            horizontal ? width : length,
            { collidable: false, variant: 'asphalt', role: 'networkRoad' }
        );
    }
}

function addRoad(obstacles, x1, y…39095 tokens truncated…y.weapons.length < SURVIV_MAX_WEAPONS)
            || Number(contents.money) > 0
            || (Number(contents.armor) > 0 && bot.armor < bot.maxArmor)
            || (Number(contents.medkits) > 0 && inventory.medkits < SURVIV_MAX_MEDKITS)
            || (Number(contents.ammoPacks) > 0 && inventory.ammoPacks < SURVIV_MAX_AMMO_PACKS);
        return useful ? 1120 - distancePenalty : -Infinity;
    }
    if (item.type === 'weapon') {
        return inventory.weapons.length < SURVIV_MAX_WEAPONS ? 980 - distancePenalty : -Infinity;
    }
    if (item.type === 'money') return 820 - distancePenalty;
    if (item.type === 'armor') return bot.armor < bot.maxArmor - 2 ? 760 - distancePenalty : -Infinity;
    if (item.type === 'medkit') return inventory.medkits < SURVIV_MAX_MEDKITS ? 700 - distancePenalty : -Infinity;
    if (item.type === 'ammo') return inventory.ammoPacks < SURVIV_MAX_AMMO_PACKS ? 640 - distancePenalty : -Infinity;
    return -Infinity;
}

function findBestBotLoot(bot, room, range = 2400) {
    let best = null;
    let bestScore = -Infinity;
    for (const { item } of querySurvivLoot(room, bot.x, bot.y, range)) {
        if (item.pickupAfter && Date.now() < item.pickupAfter) continue;
        const itemDistance = dist(bot.x, bot.y, item.x, item.y);
        const score = getBotLootScore(bot, item, itemDistance);
        if (score > bestScore) {
            best = { item, distance: itemDistance };
            bestScore = score;
        }
    }
    return best;
}

function getBotCombatProfile(weaponType) {
    if (weaponType === 'shotgun') return { preferredMin: 120, preferredMax: 250, fireRange: 390 };
    if (weaponType === 'sniper' || weaponType === 'dmr') return { preferredMin: 420, preferredMax: 650, fireRange: 1050 };
    if (weaponType === 'assault' || weaponType === 'lmg') return { preferredMin: 250, preferredMax: 440, fireRange: 900 };
    if (weaponType === 'smg') return { preferredMin: 150, preferredMax: 310, fireRange: 680 };
    if (weaponType === 'pistol' || weaponType === 'revolver') return { preferredMin: 180, preferredMax: 350, fireRange: 760 };
    return { preferredMin: 20, preferredMax: 54, fireRange: 76 };
}

function updateBotAI(bot, room, now, effectiveRadius) {
    if (now < bot.botThinkAt) return;
    bot.botThinkAt = now + 90 + Math.random() * 100;

    const allTargets = [
        ...room.players.filter(player => !player._eliminated && player.hp > 0),
        ...room.bots.filter(candidate => candidate.id !== bot.id && candidate.hp > 0),
    ];
    let nearest = null;
    let nearestDist = Infinity;
    let bestTargetScore = Infinity;
    for (const target of allTargets) {
        const targetDistance = dist(bot.x, bot.y, target.x, target.y);
        const targetScore = targetDistance - (target.isBot ? 0 : 140);
        if (targetScore < bestTargetScore) {
            nearest = target;
            nearestDist = targetDistance;
            bestTargetScore = targetScore;
        }
    }

    const inventory = ensureInventory(bot);
    if (bot.medkitUseEndAt > now) {
        bot.inputDx = 0;
        bot.inputDy = 0;
        bot.shooting = false;
        return;
    }
    if (bot.hp <= 48 && inventory.medkits > 0 && (!nearest || nearestDist > 430)) {
        bot.useMedkit = true;
        bot.inputDx = 0;
        bot.inputDy = 0;
        bot.shooting = false;
        return;
    }

    if (bot.openedContainer?.items?.length) {
        const wanted = bot.openedContainer.items.find(item => (
            item.kind === 'weapon' && inventory.weapons.length < SURVIV_MAX_WEAPONS
        ))
            || bot.openedContainer.items.find(item => item.kind === 'money')
            || bot.openedContainer.items.find(item => item.kind === 'armor' && bot.armor < bot.maxArmor)
            || bot.openedContainer.items.find(item => item.kind === 'medkit' && inventory.medkits < SURVIV_MAX_MEDKITS)
            || bot.openedContainer.items.find(item => item.kind === 'ammo' && inventory.ammoPacks < SURVIV_MAX_AMMO_PACKS);
        if (wanted) bot.takeChestItem = { chestId: bot.openedContainer.id, itemKey: wanted.key };
        bot.inputDx = 0;
        bot.inputDy = 0;
        bot.shooting = false;
        return;
    }

    const distFromCenter = Math.hypot(bot.x, bot.y);
    if (distFromCenter > effectiveRadius * 0.82) {
        const direction = normalize(-bot.x, -bot.y);
        bot.inputDx = direction.dx;
        bot.inputDy = direction.dy;
        bot.shooting = false;
        return;
    }

    const bestLoot = findBestBotLoot(bot, room);
    const melee = !!WEAPONS[bot.weapon?.type]?.melee;
    const shouldFight = nearest && nearestDist < 1100 && (!melee || !bestLoot || nearestDist < 260);
    if (shouldFight) {
        bot.botTargetId = nearest.id;
        const weaponDef = WEAPONS[bot.weapon?.type] || WEAPONS.fists;
        const profile = getBotCombatProfile(weaponDef.id);
        const leadTicks = weaponDef.bulletSpeed > 0 ? clamp(nearestDist / weaponDef.bulletSpeed, 0, 18) : 0;
        const aimX = nearest.x + (nearest.inputDx || 0) * SURVIV.playerSpeed * leadTicks * 0.65;
        const aimY = nearest.y + (nearest.inputDy || 0) * SURVIV.playerSpeed * leadTicks * 0.65;
        const direction = normalize(nearest.x - bot.x, nearest.y - bot.y);
        if (nearestDist > profile.preferredMax) {
            bot.inputDx = direction.dx;
            bot.inputDy = direction.dy;
        } else if (nearestDist < profile.preferredMin) {
            bot.inputDx = -direction.dx * (melee ? 0.15 : 0.9);
            bot.inputDy = -direction.dy * (melee ? 0.15 : 0.9);
        } else {
            const strafeSide = Math.sin(now / 420 + bot.id.length) >= 0 ? 1 : -1;
            bot.inputDx = -direction.dy * 0.72 * strafeSide;
            bot.inputDy = direction.dx * 0.72 * strafeSide;
        }
        bot.aimAngle = Math.atan2(aimY - bot.y, aimX - bot.x);
        bot.shooting = nearestDist <= profile.fireRange;
        return;
    }

    bot.botTargetId = null;
    if (bestLoot) {
        const { item, distance: lootDistance } = bestLoot;
        if ((item.type === 'chest' || item.type === 'deathCrate') && lootDistance < SURVIV.chestOpenRadius) {
            bot.openChestId = item.id;
        }
        const waypoint = getBotLootWaypoint(bot, item, room);
        const direction = normalize(waypoint.x - bot.x, waypoint.y - bot.y);
        bot.inputDx = direction.dx;
        bot.inputDy = direction.dy;
    } else if (nearest) {
        const direction = normalize(nearest.x - bot.x, nearest.y - bot.y);
        bot.inputDx = direction.dx * 0.78;
        bot.inputDy = direction.dy * 0.78;
    } else {
        bot.inputDx = (Math.random() - 0.5) * 2;
        bot.inputDy = (Math.random() - 0.5) * 2;
    }
    bot.shooting = false;
}
function processEntity(entity, room, now, effectiveRadius, zone) {
    if (entity.hp <= 0) return;
    if (entity.disconnected) {
        entity.inputDx = 0;
        entity.inputDy = 0;
        entity.shooting = false;
        entity.useMedkit = false;
        entity.pickupWeaponPending = false;
        entity.openChestId = null;
        entity.takeChestItem = null;
    }
    if (entity.isCashingOut) {
        entity.shooting = false;
        entity.useMedkit = false;
        entity.medkitUseEndAt = 0;
        entity.pickupWeaponPending = false;
        entity.equipSlotPending = null;
    }

    if (!entity.isCashingOut && entity.useMedkit) {
        beginInventoryMedkit(entity, now);
        entity.useMedkit = false;
    }
    if (entity.medkitUseEndAt > 0) {
        if (now >= entity.medkitUseEndAt) updateInventoryMedkit(entity, now);
        else entity.shooting = false;
    }
    if (!entity.isCashingOut && entity.pickupWeaponPending) {
        pickupGroundWeapon(entity, room);
        entity.pickupWeaponPending = false;
    }
    if (!entity.isCashingOut && entity.equipSlotPending != null) {
        equipSurvivWeaponSlot(entity, entity.equipSlotPending);
        entity.equipSlotPending = null;
    }
    if (!entity.isCashingOut && entity.throwGrenadePending) {
        throwSurvivGrenade(entity, room, now);
        entity.throwGrenadePending = false;
    }

    // Process weapon reloading tick independent of shooting
    if (entity.weapon && entity.weapon.reloading) {
        const wDef = WEAPONS[entity.weapon.type] || WEAPONS.fists;
        if (now >= entity.weapon.reloadEndAt) {
            entity.weapon.reloading = false;
            entity.weapon.ammo = wDef.clipSize;
        }
    }


    if (entity.isBot) {
        updateBotAI(entity, room, now, effectiveRadius);
    }

    moveEntity(entity, room, entity.inputDx, entity.inputDy, SURVIV.playerSpeed);
    entity.angle = entity.aimAngle ?? entity.angle;

    if (entity.shooting) {
        tryShoot(entity, room, now);
    }

    pickupLoot(entity, room);
    checkZoneDamage(entity, zone, now);

    if (entity.hp <= 0) {
        eliminateSurvivPlayer(room, entity, room._io);
    }
}

function getActiveSurvivEntities(room) {
    return [
        ...room.players.filter(p => !p._eliminated && p.hp > 0),
        ...room.bots.filter(b => !b.disconnected && !b._eliminated && b.hp > 0),
    ];
}

function buildLeaderboard(room, activeEntities = getActiveSurvivEntities(room)) {
    return activeEntities
        .map(p => ({
            id: p.id,
            username: p.username,
            balance: p.dollarBalance || 0,
            kills: p.kills || 0,
            isBot: !!p.isBot,
        }))
        .sort((a, b) => b.balance - a.balance || b.kills - a.kills)
        .slice(0, 10);
}

function serializePlayer(p, isYou) {
    const wDef = WEAPONS[p.weapon?.type] || WEAPONS.fists;
    return {
        id: p.id,
        username: p.username,
        x: p.x,
        y: p.y,
        angle: p.aimAngle ?? p.angle ?? 0,
        color: p.color,
        hp: p.hp,
        maxHp: p.maxHp,
        armor: p.armor,
        weapon: p.weapon?.type || 'fists',
        ammo: p.weapon?.ammo ?? 0,
        clipSize: wDef.clipSize,
        reloading: !!p.weapon?.reloading,
        meleeStartedAt: p.meleeStartedAt || 0,
        meleeUntil: p.meleeUntil || 0,
        meleeRemainingMs: p.meleeUntil > Date.now() ? Math.max(0, p.meleeUntil - Date.now()) : 0,
        meleeHand: p.meleeHand || 'top',
        reloadEndAt: p.weapon?.reloadEndAt || 0,
        reloadRemainingMs: p.weapon?.reloading ? Math.max(0, (p.weapon.reloadEndAt || 0) - Date.now()) : 0,
        reloadMs: wDef.reloadMs,
        medkitRemainingMs: p.medkitUseEndAt > Date.now() ? Math.max(0, p.medkitUseEndAt - Date.now()) : 0,
        medkitUseMs: SURVIV.medkitUseMs,
        dollarBalance: p.dollarBalance,
        kills: p.kills || 0,
        isBot: !!p.isBot,
        isYou,
        isCashingOut: !!p.isCashingOut,
        outsideZone: !!p.outsideZone,

        activeWeaponSlot: Number.isInteger(p.activeWeaponSlot) ? p.activeWeaponSlot : 0,
        weaponSlotAmmo: ensureWeaponSlotAmmo(p),
        weaponsAmmo: syncLegacyWeaponAmmo(p),
        inventory: ensureInventory(p),
        lastLoot: isYou ? (p.lastLoot || null) : null,
        openedContainer: isYou ? (p.openedContainer || null) : null,
    };
}

function isInView(vx, vy, x, y, range) {
    return Math.abs(x - vx) <= range && Math.abs(y - vy) <= range;
}

function isObstacleInView(vx, vy, obstacle, range) {
    return Math.abs((obstacle.x || 0) - vx) <= range + (obstacle.w || 0) / 2
        && Math.abs((obstacle.y || 0) - vy) <= range + (obstacle.h || 0) / 2;
}

function serializeSurvivObstacle(o) {
    return {
        id: o.id,
        x: o.x,
        y: o.y,
        w: o.w,
        h: o.h,
        kind: o.kind,
        collidable: o.collidable !== false,
        ...(o.hue != null ? { hue: o.hue } : {}),
        ...(o.rotation ? { rotation: o.rotation } : {}),
        ...(o.variant ? { variant: o.variant } : {}),
        ...(o.biome ? { biome: o.biome } : {}),
        ...(o.label ? { label: o.label } : {}),
        ...(o.houseId ? { houseId: o.houseId } : {}),
        ...(o.roomId ? { roomId: o.roomId } : {}),
        ...(o.role ? { role: o.role } : {}),
        ...(o.landmarkType ? { landmarkType: o.landmarkType } : {}),
        ...(o.entranceRole ? { entranceRole: o.entranceRole } : {}),
        ...(o.orientation ? { orientation: o.orientation } : {}),
        ...(Array.isArray(o.points) ? { points: o.points } : {}),
        ...(Number.isFinite(o.width) ? { width: o.width } : {}),
        ...(o.destructible ? { destructible: true, hp: o.hp, maxHp: o.maxHp } : {}),
    };
}

function shouldSendSurvivStaticPayload(room, socketId, viewX, viewY, now) {
    if (!(room._survivViewerPayloadCache instanceof Map)) {
        room._survivViewerPayloadCache = new Map();
    }
    const cache = room._survivViewerPayloadCache;
    const state = cache.get(socketId) || {};
    const movedPastMargin = state.staticX == null
        || Math.abs(viewX - state.staticX) > SURVIV_STATIC_PAYLOAD_MOVE_THRESHOLD
        || Math.abs(viewY - state.staticY) > SURVIV_STATIC_PAYLOAD_MOVE_THRESHOLD;
    const obstaclesChanged = state.obstaclesSource !== room.obstacles
        || state.obstaclesCount !== (room.obstacles?.length || 0)
        || state.obstaclesRevision !== (room._survivObstacleRevision || 0);
    const intervalElapsed = state.lastStaticAt == null
        || now < state.lastStaticAt
        || now - state.lastStaticAt >= SURVIV_STATIC_PAYLOAD_INTERVAL_MS;
    const shouldSend = movedPastMargin || obstaclesChanged || intervalElapsed;

    state.lastSeenAt = now;
    if (shouldSend) {
        state.lastStaticAt = now;
        state.staticX = viewX;
        state.staticY = viewY;
        state.obstaclesSource = room.obstacles;
        state.obstaclesCount = room.obstacles?.length || 0;
        state.obstaclesRevision = room._survivObstacleRevision || 0;
    }
    cache.set(socketId, state);
    return shouldSend;
}

function pruneSurvivViewerPayloadCache(room, now) {
    if (now < (room._nextSurvivViewerPayloadPruneAt || 0)) return;
    room._nextSurvivViewerPayloadPruneAt = now + 10000;
    const cache = room._survivViewerPayloadCache;
    if (!(cache instanceof Map)) return;
    for (const [socketId, state] of cache) {
        if (now - (state.lastSeenAt || 0) > 10000) cache.delete(socketId);
    }
}

export function processSurvivRoom(room, io, resetTime) {
    room._io = io;
    const now = Date.now();
    const zone = getSurvivZone(resetTime, now);
    const effectiveRadius = zone?.radius ?? SURVIV.worldHalf;

    syncSurvivBots(room);

    const entities = getActiveSurvivEntities(room);

    for (const ent of entities) {
        processEntity(ent, room, now, effectiveRadius, zone);
    }

    updateBullets(room, now, effectiveRadius);

    const activeEntities = getActiveSurvivEntities(room);
    return {
        leaderboard: buildLeaderboard(room, activeEntities),
        aliveCount: activeEntities.length,
        zone,
    };
}

export function broadcastSurvivState(room, io, lbData, meta) {
    const { leaderboard, zone } = lbData;
    const range = SURVIV.viewRange;
    const now = Date.now();
    const leaderboardSignature = leaderboard.map(entry => entry.id).join('|');
    const leaderboardChanged = room._survivLeaderboardSignature !== leaderboardSignature;
    const sendLb = leaderboardChanged || !room._lastSurvivLbAt || now - room._lastSurvivLbAt >= 500;
    if (sendLb) {
        room._lastSurvivLbAt = now;
        room._survivLeaderboardSignature = leaderboardSignature;
    }

    const allPlayers = getActiveSurvivEntities(room);
    const aliveCount = Number.isFinite(lbData.aliveCount) ? lbData.aliveCount : allPlayers.length;
    room.deathMarkers = (room.deathMarkers || []).filter(marker => now - marker.createdAt < 30000).slice(-40);

    const emitToViewer = (socketId, viewX, viewY, youId, dollarBalance, spectating) => {
        if (sendLb) {
            io.to(socketId).emit('leaderboard', { leaderboard, aliveCount, surviv: true });
        }
        const sendStaticPayload = shouldSendSurvivStaticPayload(room, socketId, viewX, viewY, now);

        const visiblePlayers = allPlayers
            .filter(p => isInView(viewX, viewY, p.x, p.y, range))
            .map(p => serializePlayer(p, p.id === youId));

        const visibleLoot = querySurvivLoot(room, viewX, viewY, range)
            .map(({ item: l }) => ({
                id: l.id,
                type: l.type,
                x: l.x,
                y: l.y,
                dollarValue: l.dollarValue,
                weaponType: l.weaponType,
                tier: l.tier,
                source: l.source,
                amount: l.amount,
                armorValue: l.armorValue,
            }));

        const visibleBullets = room.bullets
            .filter(b => isInView(viewX, viewY, b.x, b.y, range))
            .map(b => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, ownerId: b.ownerId, weaponType: b.weaponType, isGrenade: !!b.isGrenade, detonateAt: b.detonateAt || 0 }));
        const visibleDeathMarkers = room.deathMarkers
            .filter(marker => isInView(viewX, viewY, marker.x, marker.y, range))
            .map(marker => ({ ...marker }));

        const staticPayload = {};
        if (sendStaticPayload) {
            const visibleObstacles = queryObstacles(room, viewX, viewY, range + 200, false)
                .filter(o => isObstacleInView(viewX, viewY, o, range + 200))
                .map(serializeSurvivObstacle);
            const minimapRange = range * 3.35;
            const minimapObstacleKinds = new Set(['road', 'houseFloor', 'wall', 'interiorWall', 'water', 'container']);
            const minimapObstacles = queryObstacles(room, viewX, viewY, minimapRange, false)
                .filter(o => minimapObstacleKinds.has(o.kind))
                .filter(o => isObstacleInView(viewX, viewY, o, minimapRange))
                .slice(0, 220)
                .map(serializeSurvivObstacle);
            const minimapLoot = querySurvivLoot(room, viewX, viewY, minimapRange)
                .filter(({ item: l }) => l.type === 'chest' || l.type === 'deathCrate' || l.type === 'money')
                .slice(0, 90)
                .map(({ item: l }) => ({ x: l.x, y: l.y, golden: l.type !== 'chest' }));
            const minimapPlayers = allPlayers
                .filter(p => isInView(viewX, viewY, p.x, p.y, minimapRange))
                .map(p => ({ x: p.x, y: p.y, isYou: p.id === youId, isBot: !!p.isBot }));
            staticPayload.obstacles = visibleObstacles;
            staticPayload.minimap = {
                players: minimapPlayers,
                food: minimapLoot,
                obstacles: minimapObstacles,
            };
        }

        io.to(socketId).emit('survivTick', {
            you: youId ? serializePlayer(
                allPlayers.find(p => p.id === youId) || { id: youId, x: viewX, y: viewY, dollarBalance, hp: 0 },
                true,
            ) : null,
            players: visiblePlayers,
            loot: visibleLoot,
            bullets: visibleBullets,
            deathMarkers: visibleDeathMarkers,
            ...staticPayload,
            zone,
            aliveCount,
            dollarBalance,
            spectating,
            ...meta,
        });
    };

    for (const p of room.players.filter(pl => !pl.disconnected && pl.hp > 0)) {
        emitToViewer(p.id, p.x, p.y, p.id, p.dollarBalance, false);
    }

    for (const spec of room.spectators || []) {
        emitToViewer(spec.id, spec.x, spec.y, null, spec.dollarBalance, true);
    }
    pruneSurvivViewerPayloadCache(room, now);
}

