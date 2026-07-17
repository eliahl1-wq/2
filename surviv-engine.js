/**
 * Surviv — top-down battle royale shooter engine.
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
    rare: ['smg', 'shotgun', 'assault', 'assault', 'dmr'],
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

function addRoad(obstacles, x1, y1, x2, y2, width = 150) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (Math.abs(dx) > 1) addNetworkRoadSegment(obstacles, x1, y1, x2, y1, width);
    if (Math.abs(dy) > 1) addNetworkRoadSegment(obstacles, x2, y1, x2, y2, width);
}

function removeShortNetworkRoadStubs(obstacles, minLength) {
    for (let i = obstacles.length - 1; i >= 0; i--) {
        const road = obstacles[i];
        if (road.kind !== 'road' || road.role !== 'networkRoad') continue;
        if (Math.max(road.w, road.h) >= minLength) continue;
        obstacles.splice(i, 1);
    }
}

function addWall(obstacles, x, y, w, h, variant = 'plaster', opts = {}) {
    return addObstacle(obstacles, 'wall', x, y, w, h, { hue: opts.hue ?? 24, variant, ...opts });
}

function addDestructibleBarrier(obstacles, x, y, w, h, variant = 'stone', opts = {}) {
    const horizontal = w >= h;
    const length = horizontal ? w : h;
    const segmentCount = Math.max(1, Math.ceil(length / (opts.segmentLength || 120)));
    const segmentLength = length / segmentCount;
    const maxHp = opts.maxHp || (Math.min(w, h) <= 12 ? 54 : 90);
    const segments = [];
    for (let index = 0; index < segmentCount; index++) {
        const offset = -length / 2 + segmentLength * (index + 0.5);
        segments.push(addWall(
            obstacles,
            horizontal ? x + offset : x,
            horizontal ? y : y + offset,
            horizontal ? segmentLength : w,
            horizontal ? h : segmentLength,
            variant,
            {
                ...opts,
                role: opts.role || 'breakableBarrier',
                destructible: true,
                maxHp,
            },
        ));
    }
    return segments;
}

function addInteriorWall(obstacles, x, y, w, h, variant = 'plaster', opts = {}) {
    return addObstacle(obstacles, 'interiorWall', x, y, w, h, { hue: opts.hue ?? 24, variant, ...opts });
}

function addRoomZone(obstacles, houseId, x, y, w, h, variant = 'room') {
    return addObstacle(obstacles, 'roomZone', x, y, w, h, {
        collidable: false,
        variant,
        houseId,
    });
}

function addDoor(obstacles, houseId, x, y, w, h, variant = 'wood', side = 'south', entranceRole = 'mainEntrance') {
    return addObstacle(obstacles, 'door', x, y, w, h, {
        collidable: false,
        variant,
        houseId,
        role: side,
        entranceRole,
        orientation: side,
    });
}

function addHorizontalWallWithOpening(obstacles, x, y, w, wall, variant, openingCenterX = x, openingW = 0, opts = {}) {
    const min = x - w / 2;
    const max = x + w / 2;
    const gapMin = clamp(openingCenterX - openingW / 2, min, max);
    const gapMax = clamp(openingCenterX + openingW / 2, min, max);
    const leftW = gapMin - min;
    const rightW = max - gapMax;
    if (leftW > wall * 2) addWall(obstacles, min + leftW / 2, y, leftW, wall, variant, opts);
    if (rightW > wall * 2) addWall(obstacles, gapMax + rightW / 2, y, rightW, wall, variant, opts);
}

function addVerticalWallWithOpening(obstacles, x, y, h, wall, variant, openingCenterY = y, openingH = 0, opts = {}) {
    const min = y - h / 2;
    const max = y + h / 2;
    const gapMin = clamp(openingCenterY - openingH / 2, min, max);
    const gapMax = clamp(openingCenterY + openingH / 2, min, max);
    const topH = gapMin - min;
    const bottomH = max - gapMax;
    if (topH > wall * 2) addWall(obstacles, x, min + topH / 2, wall, topH, variant, opts);
    if (bottomH > wall * 2) addWall(obstacles, x, gapMax + bottomH / 2, wall, bottomH, variant, opts);
}

function addVerticalInteriorWallSegments(obstacles, x, y, h, wall, gaps = [], variant = 'plaster', opts = {}) {
    const min = y - h / 2;
    const max = y + h / 2;
    let cursor = min;
    const sorted = [...gaps].sort((a, b) => a.center - b.center);
    for (const gap of sorted) {
        const gapMin = clamp(y + gap.center - gap.size / 2, min, max);
        const gapMax = clamp(y + gap.center + gap.size / 2, min, max);
        if (gapMin - cursor > wall * 1.5) addInteriorWall(obstacles, x, (cursor + gapMin) / 2, wall, gapMin - cursor, variant, opts);
        cursor = Math.max(cursor, gapMax);
    }
    if (max - cursor > wall * 1.5) addInteriorWall(obstacles, x, (cursor + max) / 2, wall, max - cursor, variant, opts);
}

function addHorizontalInteriorWallSegments(obstacles, x, y, w, wall, gaps = [], variant = 'plaster', opts = {}) {
    const min = x - w / 2;
    const max = x + w / 2;
    let cursor = min;
    const sorted = [...gaps].sort((a, b) => a.center - b.center);
    for (const gap of sorted) {
        const gapMin = clamp(x + gap.center - gap.size / 2, min, max);
        const gapMax = clamp(x + gap.center + gap.size / 2, min, max);
        if (gapMin - cursor > wall * 1.5) addInteriorWall(obstacles, (cursor + gapMin) / 2, y, gapMin - cursor, wall, variant, opts);
        cursor = Math.max(cursor, gapMax);
    }
    if (max - cursor > wall * 1.5) addInteriorWall(obstacles, (cursor + max) / 2, y, max - cursor, wall, variant, opts);
}
function addHouse(obstacles, loot, spawnPoints, x, y, w, h, opts = {}) {
    const wall = opts.wall || 14;
    const hue = opts.hue ?? 22;
    const variant = opts.variant || 'house';
    const doorSide = ['north', 'south', 'east', 'west'].includes(opts.doorSide) ? opts.doorSide : 'south';
    const horizontalDoor = doorSide === 'north' || doorSide === 'south';
    const doorSpan = clamp((horizontalDoor ? w : h) * 0.32, 74, variant === 'mansion' || variant === 'warehouse' ? 132 : 104);
    const doorW = horizontalDoor ? doorSpan : wall * 2.25;
    const doorH = horizontalDoor ? wall * 2.25 : doorSpan;
    const doorX = doorSide === 'west'
        ? x - w / 2 + wall / 2
        : doorSide === 'east' ? x + w / 2 - wall / 2 : x;
    const doorY = doorSide === 'north'
        ? y - h / 2 + wall / 2
        : doorSide === 'south' ? y + h / 2 - wall / 2 : y;
    const floor = addObstacle(obstacles, 'houseFloor', x, y, w, h, {
        collidable: false,
        hue,
        variant,
        label: opts.label,
        role: opts.role || (variant === 'town' ? 'residence' : 'building'),
        landmarkType: opts.landmarkType,
        orientation: opts.orientation || doorSide,
        biome: opts.biome,
    });
    const houseId = floor.id;

    const northY = y - h / 2 + wall / 2;
    const southY = y + h / 2 - wall / 2;
    const westX = x - w / 2 + wall / 2;
    const eastX = x + w / 2 - wall / 2;

    if (doorSide === 'north') addHorizontalWallWithOpening(obstacles, x, northY, w, wall, variant, doorX, doorSpan);
    else addWall(obstacles, x, northY, w, wall, variant);

    if (doorSide === 'south') addHorizontalWallWithOpening(obstacles, x, southY, w, wall, variant, doorX, doorSpan);
    else addWall(obstacles, x, southY, w, wall, variant);

    if (doorSide === 'west') addVerticalWallWithOpening(obstacles, westX, y, h, wall, variant, doorY, doorSpan);
    else addWall(obstacles, westX, y, wall, h, variant);

    if (doorSide === 'east') addVerticalWallWithOpening(obstacles, eastX, y, h, wall, variant, doorY, doorSpan);
    else addWall(obstacles, eastX, y, wall, h, variant);

    addDoor(obstacles, houseId, doorX, doorY, doorW, doorH, variant, doorSide, opts.entranceRole || 'mainEntrance');

    const large = opts.layout === 'corridor' || (opts.layout !== 'open' && (w >= 430 || h >= 330 || variant === 'mansion'));
    if (large) {
        const hallW = clamp(w * 0.22, 98, 170);
        const wingW = (w - hallW - wall * 4) / 2;
        addRoomZone(obstacles, houseId, x, y, hallW, h - wall * 3.5, 'hallway');
        addRoomZone(obstacles, houseId, x - hallW / 2 - wingW / 2 - wall, y - h * 0.27, wingW, h * 0.28, 'north-room');
        addRoomZone(obstacles, houseId, x - hallW / 2 - wingW / 2 - wall, y + h * 0.02, wingW, h * 0.28, 'mid-room');
        addRoomZone(obstacles, houseId, x - hallW / 2 - wingW / 2 - wall, y + h * 0.31, wingW, h * 0.24, 'south-room');
        addRoomZone(obstacles, houseId, x + hallW / 2 + wingW / 2 + wall, y - h * 0.27, wingW, h * 0.28, 'north-room');
        addRoomZone(obstacles, houseId, x + hallW / 2 + wingW / 2 + wall, y + h * 0.02, wingW, h * 0.28, 'mid-room');
        addRoomZone(obstacles, houseId, x + hallW / 2 + wingW / 2 + wall, y + h * 0.31, wingW, h * 0.24, 'south-room');
        addVerticalInteriorWallSegments(obstacles, x - hallW / 2, y, h - wall * 4, wall, [
            { center: -h * 0.27, size: 82 },
            { center: h * 0.02, size: 82 },
            { center: h * 0.31, size: 82 },
        ], variant);
        addVerticalInteriorWallSegments(obstacles, x + hallW / 2, y, h - wall * 4, wall, [
            { center: -h * 0.27, size: 82 },
            { center: h * 0.02, size: 82 },
            { center: h * 0.31, size: 82 },
        ], variant);
        addHorizontalInteriorWallSegments(obstacles, x - hallW / 2 - wingW / 2 - wall, y - h * 0.125, wingW, wall, [], variant);
        addHorizontalInteriorWallSegments(obstacles, x - hallW / 2 - wingW / 2 - wall, y + h * 0.175, wingW, wall, [], variant);
        addHorizontalInteriorWallSegments(obstacles, x + hallW / 2 + wingW / 2 + wall, y - h * 0.125, wingW, wall, [], variant);
        addHorizontalInteriorWallSegments(obstacles, x + hallW / 2 + wingW / 2 + wall, y + h * 0.175, wingW, wall, [], variant);
        addObstacle(obstacles, 'furniture', x - w * 0.32, y - h * 0.28, 54, 32, { collidable: false, variant: 'table' });
        addObstacle(obstacles, 'furniture', x + w * 0.33, y + h * 0.27, 48, 34, { collidable: false, variant: 'bed' });
        addObstacle(obstacles, 'furniture', x - w * 0.31, y + h * 0.06, 42, 30, { collidable: false, variant: 'bed' });
    } else {
        // Small houses: no rooms, no interior walls — single open space
        addObstacle(obstacles, 'furniture', x - w * 0.27, y - h * 0.18, 42, 24, { collidable: false, variant: 'table' });
        addObstacle(obstacles, 'furniture', x + w * 0.27, y + h * 0.12, 36, 28, { collidable: false, variant: 'bed' });
    }

    const chestTier = opts.tier || (Math.random() > 0.78 ? 'rare' : 'common');
    const primaryChestChance = large ? 0.84 : 0.46;
    if (Math.random() < primaryChestChance) {
        loot.push(makeChest(x + w * 0.24, y - h * 0.22, chestTier));
    }
    if (large && Math.random() < 0.24) {
        loot.push(makeChest(x - w * 0.28, y + h * 0.18, chestTier === 'common' ? 'rare' : chestTier));
    }
    const spawnOffset = 70;
    if (doorSide === 'north') spawnPoints.push({ x: doorX, y: y - h / 2 - spawnOffset });
    else if (doorSide === 'south') spawnPoints.push({ x: doorX, y: y + h / 2 + spawnOffset });
    else if (doorSide === 'west') spawnPoints.push({ x: x - w / 2 - spawnOffset, y: doorY });
    else spawnPoints.push({ x: x + w / 2 + spawnOffset, y: doorY });
}

function addMansion(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1500, 1050, {
        collidable: false,
        variant: 'estate',
        role: 'courtyard',
        landmarkType: 'estate',
    });
    addObstacle(obstacles, 'road', x, y + 425, 180, 330, {
        collidable: false,
        variant: 'dirt',
        role: 'driveway',
        landmarkType: 'estate',
    });
    addHouse(obstacles, loot, spawnPoints, x, y, 720, 520, {
        hue: 32, variant: 'mansion', tier: 'rare', wall: 18,
        doorSide: 'south', landmarkType: 'estate', label: 'MANOR', role: 'mainBuilding',
    });
    addHouse(obstacles, loot, spawnPoints, x - 560, y + 240, 320, 260, {
        hue: 28, variant: 'guesthouse', tier: 'rare',
        doorSide: 'east', landmarkType: 'estate', label: 'GUEST', role: 'guesthouse',
    });
    addHouse(obstacles, loot, spawnPoints, x + 570, y + 250, 300, 250, {
        hue: 28, variant: 'garage', tier: 'military',
        doorSide: 'west', landmarkType: 'estate', label: 'GARAGE', role: 'garage',
        entranceRole: 'garageEntrance',
    });
    
    // Perimeter walls with gate on North and South sides
    addDestructibleBarrier(obstacles, x - 500, y - 590, 500, 18, 'stone'); // North wall left segment
    addDestructibleBarrier(obstacles, x + 500, y - 590, 500, 18, 'stone'); // North wall right segment
    addDestructibleBarrier(obstacles, x - 750, y, 18, 1180, 'stone');
    addDestructibleBarrier(obstacles, x + 750, y, 18, 1180, 'stone');
    addDestructibleBarrier(obstacles, x - 500, y + 590, 500, 18, 'stone'); // South wall left segment
    addDestructibleBarrier(obstacles, x + 500, y + 590, 500, 18, 'stone'); // South wall right segment
    
    // Gate pillars South
    addObstacle(obstacles, 'wall', x - 240, y + 590, 40, 40, 'stone');
    addObstacle(obstacles, 'wall', x + 240, y + 590, 40, 40, 'stone');
    // Gate pillars North
    addObstacle(obstacles, 'wall', x - 240, y - 590, 40, 40, 'stone');
    addObstacle(obstacles, 'wall', x + 240, y - 590, 40, 40, 'stone');
    
    // Structured courtyard cover (crates and trees/hedges)
    addObstacle(obstacles, 'crate', x - 260, y - 300, 44, 44, { rotation: 0.1 });
    addObstacle(obstacles, 'crate', x - 300, y - 300, 44, 44, { rotation: -0.15 });
    addObstacle(obstacles, 'crate', x - 280, y - 260, 44, 44, { rotation: 0.05 });
    
    addObstacle(obstacles, 'crate', x + 440, y + 380, 44, 44, { rotation: 0.08 });
    addObstacle(obstacles, 'crate', x + 480, y + 380, 44, 44, { rotation: -0.12 });
    addObstacle(obstacles, 'crate', x + 460, y + 420, 44, 44, { rotation: 0.03 });
    
    addObstacle(obstacles, 'tree', x - 580, y - 350, 46, 46, { hue: 110, rotation: 0.5 });
    addObstacle(obstacles, 'tree', x + 580, y - 350, 46, 46, { hue: 115, rotation: 1.5 });
    
    // Guaranteed high-tier ground loot inside the mansion compound buildings
    loot.push(makeGroundLoot('weapon', x, y - 50, { weaponType: 'assault', source: 'estate-loot' }));
    loot.push(makeGroundLoot('ammo', x - 40, y - 50, { source: 'estate-loot' }));
    loot.push(makeGroundLoot('ammo', x + 40, y - 50, { source: 'estate-loot' }));
    loot.push(makeGroundLoot('medkit', x, y + 100, { source: 'estate-loot' }));
    loot.push(makeGroundLoot('weapon', x - 560, y + 240, { weaponType: 'shotgun', source: 'estate-loot' })); // inside guesthouse
    loot.push(makeGroundLoot('weapon', x + 570, y + 250, { weaponType: 'lmg', source: 'estate-loot' })); // inside garage
    
    // Fairer spawn points at the outskirts of the estate
    spawnPoints.push({ x, y: y + 660 });
    spawnPoints.push({ x, y: y - 660 });
}

function addIronworks(obstacles, loot, spawnPoints, x, y) {
    const w = 1800;
    const h = 1200;
    const wall = 24;
    const northY = y - h / 2 + wall / 2;
    const southY = y + h / 2 - wall / 2;
    const westX = x - w / 2 + wall / 2;
    const eastX = x + w / 2 - wall / 2;

    addObstacle(obstacles, 'field', x, y, 2600, 1900, {
        collidable: false,
        variant: 'industrial',
        role: 'compound',
        landmarkType: 'ironworks',
        label: 'IRONWORKS',
    });
    addObstacle(obstacles, 'field', x, y, 2200, 1550, {
        collidable: false,
        variant: 'courtyard',
        role: 'yard',
        landmarkType: 'ironworks',
    });

    // The eastern apron joins the west N-S highway; the other aprons make every
    // exterior doorway readable and keep combat exits from becoming choke traps.
    addObstacle(obstacles, 'road', x + w / 2 + 250, y, 500, 170, {
        collidable: false, variant: 'asphalt', role: 'driveway', landmarkType: 'ironworks',
    });
    addObstacle(obstacles, 'road', x - w / 2 - 150, y + 280, 300, 120, {
        collidable: false, variant: 'dirt', role: 'path', landmarkType: 'ironworks',
    });
    addObstacle(obstacles, 'road', x - 430, y - h / 2 - 170, 120, 340, {
        collidable: false, variant: 'dirt', role: 'path', landmarkType: 'ironworks',
    });
    addObstacle(obstacles, 'road', x + 430, y + h / 2 + 170, 120, 340, {
        collidable: false, variant: 'dirt', role: 'path', landmarkType: 'ironworks',
    });

    const floor = addObstacle(obstacles, 'houseFloor', x, y, w, h, {
        collidable: false,
        hue: 205,
        variant: 'ironworks',
        label: 'IRONWORKS',
        role: 'mainBuilding',
        landmarkType: 'ironworks',
        orientation: 'east',
    });
    const houseId = floor.id;
    const ironworksMeta = { houseId, landmarkType: 'ironworks' };

    addHorizontalWallWithOpening(obstacles, x, northY, w, wall, 'metal', x - 430, 170, ironworksMeta);
    addHorizontalWallWithOpening(obstacles, x, southY, w, wall, 'metal', x + 430, 170, ironworksMeta);
    addVerticalWallWithOpening(obstacles, westX, y, h, wall, 'metal', y + 280, 210, ironworksMeta);
    addVerticalWallWithOpening(obstacles, eastX, y, h, wall, 'metal', y, 230, ironworksMeta);

    addDoor(obstacles, houseId, x - 430, northY, 170, wall * 2.25, 'metal', 'north', 'serviceEntrance');
    addDoor(obstacles, houseId, x + 430, southY, 170, wall * 2.25, 'metal', 'south', 'serviceEntrance');
    addDoor(obstacles, houseId, westX, y + 280, wall * 2.25, 210, 'metal', 'west', 'loadingEntrance');
    addDoor(obstacles, houseId, eastX, y, wall * 2.25, 230, 'metal', 'east', 'mainEntrance');

    // Two side loops connect through the central factory floor at three points.
    // Players can rotate around fights instead of being forced through one hall.
    addRoomZone(obstacles, houseId, x, y, 300, 1060, 'hallway');
    addRoomZone(obstacles, houseId, x - 255, y, 190, 1060, 'factory-floor');
    addRoomZone(obstacles, houseId, x + 255, y, 190, 1060, 'factory-floor');
    addRoomZone(obstacles, houseId, x - 610, y - 265, 500, 430, 'workshop');
    addRoomZone(obstacles, houseId, x + 610, y - 265, 500, 430, 'control-room');
    addRoomZone(obstacles, houseId, x - 610, y + 265, 500, 430, 'storage');
    addRoomZone(obstacles, houseId, x + 610, y + 265, 500, 430, 'loading-bay');

    addVerticalInteriorWallSegments(obstacles, x - 360, y, h - wall * 4, wall, [
        { center: -400, size: 165 },
        { center: 0, size: 165 },
        { center: 400, size: 165 },
    ], 'metal', ironworksMeta);
    addVerticalInteriorWallSegments(obstacles, x + 360, y, h - wall * 4, wall, [
        { center: -400, size: 165 },
        { center: 0, size: 165 },
        { center: 400, size: 165 },
    ], 'metal', ironworksMeta);
    addHorizontalInteriorWallSegments(obstacles, x - 620, y, 500, wall, [{ center: 0, size: 140 }], 'metal', ironworksMeta);
    addHorizontalInteriorWallSegments(obstacles, x + 620, y, 500, wall, [{ center: 0, size: 140 }], 'metal', ironworksMeta);

    // Soft cover preserves the wide looping lanes. Loading-bay containers are
    // tucked against the exterior wall instead of blocking room connections.
    addObstacle(obstacles, 'furniture', x - 155, y - 245, 110, 170, {
        collidable: true, variant: 'machine', role: 'machine', houseId, landmarkType: 'ironworks',
    });
    addObstacle(obstacles, 'furniture', x + 155, y + 245, 110, 170, {
        collidable: true, variant: 'machine', role: 'machine', houseId, landmarkType: 'ironworks',
    });
    addObstacle(obstacles, 'furniture', x - 610, y - 245, 170, 54, {
        collidable: false, variant: 'workbench', role: 'workbench', houseId, landmarkType: 'ironworks',
    });
    addObstacle(obstacles, 'furniture', x + 610, y - 245, 72, 120, {
        collidable: false, variant: 'locker', role: 'locker', houseId, landmarkType: 'ironworks',
    });
    addObstacle(obstacles, 'container', x + 690, y + 300, 125, 54, {
        hue: 205, variant: 'blue', role: 'indoorCover', houseId, landmarkType: 'ironworks',
    });
    addObstacle(obstacles, 'container', x + 690, y + 390, 125, 54, {
        hue: 15, variant: 'red', role: 'indoorCover', houseId, landmarkType: 'ironworks',
    });

    const ironworksLoot = room => ({ houseId, landmarkType: 'ironworks', room });
    loot.push(makeChest(x - 620, y - 345, 'rare', null, 'map', ironworksLoot('workshop')));
    loot.push(makeChest(x + 620, y - 345, 'rare', null, 'map', ironworksLoot('control-room')));
    loot.push(makeChest(x - 620, y + 345, 'rare', null, 'map', ironworksLoot('storage')));
    loot.push(makeChest(x + 520, y + 345, 'rare', null, 'map', ironworksLoot('loading-bay')));
    loot.push(makeChest(x, y, 'military', null, 'map', ironworksLoot('hallway')));

    addObstacle(obstacles, 'crate', x - 1040, y - 560, 48, 48, { variant: 'industrial', rotation: 0.08 });
    addObstacle(obstacles, 'barrel', x + 1050, y + 500, 36, 36, { variant: 'fuel', hue: 15 });

    spawnPoints.push({ x: x + w / 2 + 330, y: y - 320, role: 'ironworks-east' });
    spawnPoints.push({ x: x + w / 2 + 330, y: y + 320, role: 'ironworks-east' });
    spawnPoints.push({ x: x - w / 2 - 330, y: y - 360, role: 'ironworks-west' });
    spawnPoints.push({ x: x - w / 2 - 330, y: y + 430, role: 'ironworks-west' });
}

function addContainerYard(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1200, 900, { collidable: false, variant: 'industrial' });
    
    // Place containers in structured stacks (groups of 2-3) to create a clear dockyard maze
    const stacks = [
        { x: x - 400, y: y - 250, count: 2, rotation: 0.02, variant: 'red', horizontal: true },
        { x: x - 100, y: y - 250, count: 3, rotation: -0.01, variant: 'blue', horizontal: true },
        { x: x + 250, y: y - 250, count: 2, rotation: 0.03, variant: 'red', horizontal: true },
        { x: x - 250, y: y, count: 2, rotation: Math.PI / 2, variant: 'blue', horizontal: false },
        { x: x + 250, y: y, count: 2, rotation: Math.PI / 2, variant: 'red', horizontal: false },
        { x: x - 400, y: y + 250, count: 3, rotation: -0.02, variant: 'blue', horizontal: true },
        { x: x + 100, y: y + 250, count: 2, rotation: 0.01, variant: 'red', horizontal: true }
    ];
    
    let containerIndex = 0;
    for (const stack of stacks) {
        for (let i = 0; i < stack.count; i++) {
            const cx = stack.horizontal ? stack.x + i * 140 : stack.x;
            const cy = stack.horizontal ? stack.y : stack.y + i * 140;
            addObstacle(obstacles, 'container', cx, cy, 125, 54, {
                hue: 195 + (containerIndex % 4) * 18,
                rotation: stack.rotation,
                variant: stack.variant,
            });
            containerIndex++;
        }
    }
    
    addObstacle(obstacles, 'crate', x, y - 50, 48, 48, { rotation: 0.2 });
    addObstacle(obstacles, 'barrel', x - 80, y + 100, 36, 36, { hue: 15, variant: 'fuel' });
    addObstacle(obstacles, 'barrel', x + 80, y + 120, 36, 36, { hue: 200, variant: 'water' });
    
    loot.push(makeChest(x, y + 20, 'rare', null, 'map', { outdoor: true }));

    addHouse(obstacles, loot, spawnPoints, x + 430, y + 285, 300, 220, { variant: 'warehouse', tier: 'military', hue: 205 });
    addHouse(obstacles, loot, spawnPoints, x - 430, y + 285, 260, 200, { variant: 'warehouse', tier: 'military', hue: 195 });
}

function addForest(obstacles, loot, spawnPoints, x, y, count = 34, radius = 680) {
    addObstacle(obstacles, 'field', x, y, radius * 1.9, radius * 1.55, { collidable: false, variant: 'woods' });
    // Place cabin first so collision checks work for tree placement
    if (Math.random() > 0.35) {
        const cabinX = x + 90;
        const cabinY = y - 60;
        if (!isMapPositionBlocked(obstacles, cabinX, cabinY, 150)) {
            addHouse(obstacles, loot, spawnPoints, cabinX, cabinY, 180, 150, { variant: 'cabin', hue: 18 + Math.floor(Math.random() * 16), tier: Math.random() > 0.5 ? 'rare' : 'common' });
        }
    }
    for (let i = 0; i < count; i++) {
        let placed = false;
        for (let attempt = 0; attempt < 8; attempt++) {
            const a = Math.random() * Math.PI * 2;
            const r = radius * Math.sqrt(Math.random());
            const tx = x + Math.cos(a) * r;
            const ty = y + Math.sin(a) * r;
            const size = 34 + Math.random() * 30;
            if (!isMapPositionBlocked(obstacles, tx, ty, size / 2)) {
                addObstacle(obstacles, 'tree', tx, ty, size, size, {
                    hue: 104 + Math.floor(Math.random() * 30),
                    rotation: Math.random() * Math.PI,
                });
                placed = true;
                break;
            }
        }
    }
    spawnPoints.push({ x: x - 130, y: y + 150 });
}

function addPlannedTown(obstacles, loot, spawnPoints, x, y, size = 6) {
    const roadLength = size * 260 + 180;
    addObstacle(obstacles, 'road', x, y, roadLength, 120, { collidable: false, variant: 'dirt' });
    addObstacle(obstacles, 'field', x, y, roadLength + 100, 680, { collidable: false, variant: 'town' });

    const housesNorth = Math.ceil(size / 2);
    const housesSouth = Math.floor(size / 2);
    
    const spacingN = roadLength / (housesNorth + 1);
    for (let i = 0; i < housesNorth; i++) {
        const hx = x - roadLength / 2 + spacingN * (i + 1);
        const hy = y - 210;
        const w = 190 + Math.random() * 40;
        const h = 170 + Math.random() * 30;
        addHouse(obstacles, loot, spawnPoints, hx, hy, w, h, {
            hue: 18 + Math.floor(Math.random() * 28),
            variant: 'town',
            tier: Math.random() > 0.86 ? 'rare' : 'common',
            doorSide: 'south',
        });
        
        addDestructibleBarrier(obstacles, hx, hy - h / 2 - 20, w + 40, 10, 'stone');
        addDestructibleBarrier(obstacles, hx - w / 2 - 20, hy, 10, h + 40, 'stone');
        addDestructibleBarrier(obstacles, hx + w / 2 + 20, hy, 10, h + 40, 'stone');
    }
    
    const spacingS = roadLength / (housesSouth + 1);
    for (let i = 0; i < housesSouth; i++) {
        const hx = x - roadLength / 2 + spacingS * (i + 1);
        const hy = y + 210;
        const w = 190 + Math.random() * 40;
        const h = 170 + Math.random() * 30;
        addHouse(obstacles, loot, spawnPoints, hx, hy, w, h, {
            hue: 18 + Math.floor(Math.random() * 28),
            variant: 'town',
            tier: Math.random() > 0.86 ? 'rare' : 'common',
            doorSide: 'north',
        });
        
        addDestructibleBarrier(obstacles, hx, hy + h / 2 + 20, w + 40, 10, 'stone');
        addDestructibleBarrier(obstacles, hx - w / 2 - 20, hy, 10, h + 40, 'stone');
        addDestructibleBarrier(obstacles, hx + w / 2 + 20, hy, 10, h + 40, 'stone');
    }
    
    for (let i = 0; i < size; i++) {
        const cx = x - roadLength / 2 + 100 + i * 260;
        if (Math.random() > 0.4) {
            addObstacle(obstacles, 'crate', cx, y + (Math.random() > 0.5 ? 80 : -80), 44, 44, { rotation: Math.random() * 0.4 });
        }
        if (Math.random() > 0.5) {
            addObstacle(obstacles, 'tree', cx + 130, y + (Math.random() > 0.5 ? 90 : -90), 38, 38, { hue: 105, rotation: Math.random() * 3 });
        }
    }
    
    spawnPoints.push({ x: x - roadLength / 2, y: y });
    spawnPoints.push({ x: x + roadLength / 2, y: y });
}

function addSettlement(obstacles, loot, spawnPoints, x, y, size = 5, variant = 'village') {
    if (variant === 'town') {
        addPlannedTown(obstacles, loot, spawnPoints, x, y, size);
        return;
    }
    // Scale field to match house count, wider spacing
    const cols = Math.min(size, 3);
    const rows = Math.ceil(size / 3);
    const fieldW = cols * 320 + 200;
    const fieldH = rows * 290 + 180;
    addObstacle(obstacles, 'field', x, y, fieldW, fieldH, { collidable: false, variant });
    for (let i = 0; i < size; i++) {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const hx = x - (cols - 1) * 160 + col * 320 + (Math.random() - 0.5) * 60;
        const hy = y - (rows - 1) * 145 + row * 290 + (Math.random() - 0.5) * 60;
        addHouse(obstacles, loot, spawnPoints, hx, hy, 190 + Math.random() * 70, 170 + Math.random() * 60, {
            hue: 18 + Math.floor(Math.random() * 28),
            variant,
            tier: Math.random() > 0.86 ? 'rare' : 'common',
        });
    }
    for (let i = 0; i < 3; i++) {
        for (let attempt = 0; attempt < 8; attempt++) {
            const cx = x - fieldW * 0.4 + Math.random() * fieldW * 0.8;
            const cy = y - fieldH * 0.4 + Math.random() * fieldH * 0.8;
            const size = 44 + Math.random() * 22;
            if (!isMapPositionBlocked(obstacles, cx, cy, size / 2)) {
                addObstacle(obstacles, 'crate', cx, cy, size, size, {
                    hue: 28,
                    rotation: (Math.random() - 0.5) * 0.4,
                });
                break;
            }
        }
    }
}

function addCoverPatch(obstacles, loot, spawnPoints, x, y, opts = {}) {
    const radius = opts.radius || (260 + Math.random() * 360);
    const variant = opts.variant || (Math.random() > 0.55 ? 'woods' : 'scrub');
    addObstacle(obstacles, 'field', x, y, radius * 2.1, radius * 1.6, { collidable: false, variant });
    const trees = 5 + Math.floor(Math.random() * 13);
    for (let i = 0; i < trees; i++) {
        for (let attempt = 0; attempt < 8; attempt++) {
            const a = Math.random() * Math.PI * 2;
            const r = radius * Math.sqrt(Math.random());
            const tx = x + Math.cos(a) * r;
            const ty = y + Math.sin(a) * r;
            const size = 28 + Math.random() * 44;
            if (!isMapPositionBlocked(obstacles, tx, ty, size / 2)) {
                addObstacle(obstacles, Math.random() > 0.22 ? 'tree' : 'bush', tx, ty, size, size, {
                    hue: 92 + Math.floor(Math.random() * 38),
                    rotation: Math.random() * Math.PI,
                    collidable: Math.random() > 0.32,
                    variant,
                });
                break;
            }
        }
    }
    const rocks = 2 + Math.floor(Math.random() * 5);
    for (let i = 0; i < rocks; i++) {
        for (let attempt = 0; attempt < 8; attempt++) {
            const rx = x - radius * 0.5 + Math.random() * radius;
            const ry = y - radius * 0.5 + Math.random() * radius;
            const rw = 34 + Math.random() * 36;
            if (!isMapPositionBlocked(obstacles, rx, ry, rw / 2)) {
                addObstacle(obstacles, 'rock', rx, ry, rw, 30 + Math.random() * 34, {
                    hue: 210 + Math.floor(Math.random() * 30),
                    rotation: Math.random() * 0.6,
                });
                break;
            }
        }
    }
    // No ground chests — chests only in buildings
    if (Math.random() > 0.4) spawnPoints.push({ x, y });
}

function addOpenFieldScatter(obstacles, x, y, opts = {}) {
    const radius = opts.radius || (190 + Math.random() * 190);
    const count = opts.count || (6 + Math.floor(Math.random() * 6));
    const variant = opts.variant || 'grass';
    let placedCount = 0;

    for (let i = 0; i < count; i++) {
        for (let attempt = 0; attempt < 8; attempt++) {
            const a = Math.random() * Math.PI * 2;
            const r = radius * Math.sqrt(Math.random());
            const ox = x + Math.cos(a) * r;
            const oy = y + Math.sin(a) * r;
            const size = 28 + Math.random() * 42;
            if (isMapPositionBlocked(obstacles, ox, oy, size / 2)) continue;

            const kindRoll = Math.random();
            const kind = kindRoll < 0.84 ? 'tree' : kindRoll < 0.94 ? 'bush' : 'rock';
            addObstacle(obstacles, kind, ox, oy, size, kind === 'rock' ? 24 + Math.random() * 32 : size, {
                hue: kind === 'rock' ? 212 + Math.floor(Math.random() * 26) : 94 + Math.floor(Math.random() * 42),
                rotation: Math.random() * Math.PI,
                collidable: kind === 'bush' ? Math.random() > 0.35 : true,
                variant,
            });
            placedCount++;
            break;
        }
    }

    return placedCount;
}

function addMicroSite(obstacles, loot, spawnPoints, x, y, biome = 'grass') {
    const roll = Math.random();
    const tier = roll > 0.78 ? 'rare' : 'common';
    if (roll < 0.22) {
        // Cabin site — all loot inside house
        addObstacle(obstacles, 'field', x, y, 650, 520, { collidable: false, variant: 'village' });
        addHouse(obstacles, loot, spawnPoints, x - 80, y - 20, 200 + Math.random() * 70, 170 + Math.random() * 60, { variant: 'cabin', hue: 18 + Math.floor(Math.random() * 20), tier });
        addObstacle(obstacles, 'crate', x + 180, y + 100, 46, 46, { hue: 30, rotation: Math.random() * 0.4 });
    } else if (roll < 0.42) {
        // Checkpoint with guardhouse — chest inside building
        addObstacle(obstacles, 'road', x, y, 760, 78, { collidable: false, variant: 'dirt' });
        for (let i = 0; i < 7; i++) {
            const sx = x - 250 + i * 84;
            addObstacle(obstacles, 'sandbag', sx, y - 92, 58, 28, { rotation: (Math.random() - 0.5) * 0.35, variant: 'checkpoint' });
            if (i % 2 === 0) addObstacle(obstacles, 'barrel', sx + 26, y + 78, 30, 30, { hue: 18 + i * 12, variant: 'fuel' });
        }
        addHouse(obstacles, loot, spawnPoints, x + 200, y - 180, 200, 160, { variant: 'warehouse', tier: Math.random() > 0.55 ? 'military' : 'rare', hue: 195 });
        spawnPoints.push({ x: x - 260, y: y + 160 });
    } else if (roll < 0.6) {
        // Camp with supply tent house
        addObstacle(obstacles, 'field', x, y, 720, 520, { collidable: false, variant: 'camp' });
        for (let i = 0; i < 4; i++) {
            addObstacle(obstacles, 'tent', x - 210 + i * 140, y + (i % 2) * 110 - 55, 92, 64, { hue: 78 + i * 8, rotation: (Math.random() - 0.5) * 0.8, variant: 'camp' });
        }
        addHouse(obstacles, loot, spawnPoints, x + 200, y - 160, 190, 160, { variant: 'cabin', hue: 24, tier });
        addCoverPatch(obstacles, loot, spawnPoints, x - 120, y - 80, { radius: 220, variant: biome === 'snow' ? 'snow-woods' : 'woods' });
    } else if (roll < 0.78) {
        // Farm — all loot inside barn
        addObstacle(obstacles, 'field', x, y, 820, 580, { collidable: false, variant: 'farm' });
        addHouse(obstacles, loot, spawnPoints, x - 160, y - 30, 250, 200, { variant: 'barn', hue: 8, tier });
        for (let i = 0; i < 5; i++) addObstacle(obstacles, 'field', x - 300 + i * 145, y + 210, 110, 240, { collidable: false, variant: 'crop' });
        addObstacle(obstacles, 'crate', x + 190, y - 80, 54, 54, { hue: 34, variant: 'hay' });
    } else if (roll < 0.9) {
        // Pond with a clear shoreline and a fishing shack outside the water footprint.
        const pondW = 460 + Math.random() * 140;
        const pondH = 280 + Math.random() * 90;
        addObstacle(obstacles, 'water', x, y, pondW, pondH, {
            collidable: false, variant: 'pond', rotation: Math.random() * 0.18,
        });
        addHouse(obstacles, loot, spawnPoints, x + pondW / 2 + 155, y - pondH * 0.22, 180, 150, {
            variant: 'cabin', hue: 22, tier: 'common', doorSide: 'west',
        });
        addOpenFieldScatter(obstacles, x - 40, y + 35, {
            radius: Math.max(pondW, pondH) * 0.72,
            count: 8,
            variant: 'wetlands',
        });
    } else {
        // Ruins with shelter
        addObstacle(obstacles, 'field', x, y, 760, 560, { collidable: false, variant: 'ruins' });
        addDestructibleBarrier(obstacles, x - 180, y - 90, 260, 16, 'stone');
        addDestructibleBarrier(obstacles, x - 300, y + 20, 16, 210, 'stone');
        addDestructibleBarrier(obstacles, x + 120, y + 105, 300, 16, 'stone');
        addObstacle(obstacles, 'barrel', x + 160, y - 130, 36, 36, { hue: 210, variant: 'water' });
        addHouse(obstacles, loot, spawnPoints, x - 60, y + 50, 190, 160, { variant: 'cabin', hue: 20, tier: Math.random() > 0.4 ? 'rare' : 'common' });
        spawnPoints.push({ x: x + 230, y: y + 160 });
    }
}

function addFarmstead(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1900, 1250, {
        collidable: false,
        variant: 'farm',
        role: 'farmstead',
        landmarkType: 'farm',
        label: 'EAST FARM',
    });
    addObstacle(obstacles, 'road', x, y, 1700, 110, {
        collidable: false,
        variant: 'dirt',
        role: 'driveway',
        landmarkType: 'farm',
    });

    addHouse(obstacles, loot, spawnPoints, x - 470, y - 270, 470, 300, {
        variant: 'barn', hue: 8, tier: 'rare', doorSide: 'south', layout: 'open',
        landmarkType: 'farm', label: 'BARN', role: 'barn',
    });
    addHouse(obstacles, loot, spawnPoints, x + 80, y - 270, 320, 240, {
        variant: 'house', hue: 25, tier: 'rare', doorSide: 'south',
        landmarkType: 'farm', label: 'FARMHOUSE', role: 'farmhouse',
    });
    addHouse(obstacles, loot, spawnPoints, x + 540, y + 230, 280, 210, {
        variant: 'barn', hue: 12, tier: 'common', doorSide: 'north', layout: 'open',
        landmarkType: 'farm', label: 'SHED', role: 'shed',
    });
    addHouse(obstacles, loot, spawnPoints, x - 250, y + 240, 360, 220, {
        variant: 'warehouse', hue: 122, tier: 'common', doorSide: 'north', layout: 'open',
        landmarkType: 'farm', label: 'GREENHOUSE', role: 'greenhouse',
    });

    for (let i = 0; i < 6; i++) {
        addObstacle(obstacles, 'field', x - 720 + i * 225, y + 500, 170, 230, {
            collidable: false, variant: 'crop', role: 'cropRow', landmarkType: 'farm',
        });
    }
    addObstacle(obstacles, 'crate', x - 760, y - 50, 54, 54, { hue: 34, variant: 'hay', role: 'farmProp' });
    addObstacle(obstacles, 'crate', x - 700, y - 50, 54, 54, { hue: 34, variant: 'hay', role: 'farmProp' });
    addObstacle(obstacles, 'barrel', x + 760, y - 180, 38, 38, { hue: 205, variant: 'water', role: 'farmProp' });

    loot.push(makeChest(x - 560, y - 300, 'rare'));
    loot.push(makeChest(x + 80, y - 290, 'rare'));
    spawnPoints.push({ x: x - 900, y, role: 'farm-road' });
    spawnPoints.push({ x: x + 900, y, role: 'farm-road' });
}

function addResearchCampus(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1900, 1350, {
        collidable: false,
        variant: 'snow-lab',
        role: 'campus',
        landmarkType: 'lab',
        label: 'RESEARCH',
    });
    addObstacle(obstacles, 'road', x, y, 1700, 120, {
        collidable: false,
        variant: 'asphalt',
        role: 'driveway',
        landmarkType: 'lab',
    });
    addObstacle(obstacles, 'field', x, y, 760, 420, {
        collidable: false,
        variant: 'courtyard',
        role: 'plaza',
        landmarkType: 'lab',
    });

    addHouse(obstacles, loot, spawnPoints, x, y - 350, 650, 310, {
        variant: 'warehouse', hue: 195, tier: 'military', doorSide: 'south', layout: 'corridor',
        landmarkType: 'lab', label: 'LAB A', role: 'laboratory',
    });
    addHouse(obstacles, loot, spawnPoints, x - 480, y + 330, 420, 260, {
        variant: 'warehouse', hue: 205, tier: 'rare', doorSide: 'north', layout: 'open',
        landmarkType: 'lab', label: 'LAB B', role: 'laboratory',
    });
    addHouse(obstacles, loot, spawnPoints, x + 500, y + 330, 340, 240, {
        variant: 'warehouse', hue: 45, tier: 'military', doorSide: 'north', layout: 'open',
        landmarkType: 'lab', label: 'POWER', role: 'utility', entranceRole: 'serviceEntrance',
    });

    addObstacle(obstacles, 'container', x + 760, y - 260, 125, 54, {
        hue: 205, variant: 'blue', role: 'serviceYard', landmarkType: 'lab',
    });
    addObstacle(obstacles, 'barrel', x + 730, y - 360, 36, 36, {
        hue: 15, variant: 'fuel', role: 'serviceYard', landmarkType: 'lab',
    });
    addObstacle(obstacles, 'crate', x - 760, y + 210, 46, 46, {
        variant: 'medical', role: 'serviceYard', landmarkType: 'lab',
    });

    loot.push(makeChest(x - 120, y - 390, 'military'));
    loot.push(makeChest(x - 500, y + 330, 'rare'));
    loot.push(makeChest(x + 500, y + 330, 'military'));
    spawnPoints.push({ x: x - 950, y, role: 'lab-road' });
    spawnPoints.push({ x: x + 950, y, role: 'lab-road' });
}

function addRoadsideHamlet(obstacles, loot, spawnPoints, x, y, orientation = 'horizontal') {
    const horizontal = orientation === 'horizontal';
    addObstacle(obstacles, 'field', x, y, horizontal ? 1040 : 720, horizontal ? 720 : 1040, {
        collidable: false,
        variant: 'village',
        role: 'hamlet',
        landmarkType: 'hamlet',
    });
    addObstacle(obstacles, 'road', x, y, horizontal ? 960 : 90, horizontal ? 90 : 960, {
        collidable: false,
        variant: 'dirt',
        role: 'path',
        landmarkType: 'hamlet',
    });

    const homes = horizontal
        ? [
            { x: x - 280, y: y - 210, side: 'south' },
            { x: x + 280, y: y - 210, side: 'south' },
            { x, y: y + 220, side: 'north' },
        ]
        : [
            { x: x - 220, y: y - 280, side: 'east' },
            { x: x - 220, y: y + 280, side: 'east' },
            { x: x + 220, y, side: 'west' },
        ];
    for (const [index, home] of homes.entries()) {
        addHouse(obstacles, loot, spawnPoints, home.x, home.y, 220 + index * 12, 180 + (index % 2) * 22, {
            variant: index === 2 ? 'cabin' : 'house',
            hue: 18 + index * 9,
            tier: index === 2 ? 'rare' : 'common',
            doorSide: home.side,
            landmarkType: 'hamlet',
            role: 'hamletHome',
        });
    }
    addObstacle(obstacles, 'barrel', x + (horizontal ? 390 : 110), y + (horizontal ? 130 : 390), 34, 34, {
        hue: 205, variant: 'water', role: 'well', landmarkType: 'hamlet',
    });
    spawnPoints.push(horizontal ? { x: x - 520, y, role: 'hamlet-road' } : { x, y: y - 520, role: 'hamlet-road' });
    spawnPoints.push(horizontal ? { x: x + 520, y, role: 'hamlet-road' } : { x, y: y + 520, role: 'hamlet-road' });
}

function addMarketVillage(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1900, 1320, {
        collidable: false, variant: 'village', role: 'marketVillage', landmarkType: 'market',
        label: 'GRAND MARKET',
    });
    addObstacle(obstacles, 'road', x, y + 390, 1760, 110, {
        collidable: false, variant: 'dirt', role: 'mainStreet', landmarkType: 'market',
    });
    addObstacle(obstacles, 'field', x, y + 250, 680, 330, {
        collidable: false, variant: 'courtyard', role: 'marketSquare', landmarkType: 'market',
    });

    // Large central hall creates a dense indoor fight, while the surrounding
    // shops form a readable village loop with several exits back to the road.
    addHouse(obstacles, loot, spawnPoints, x, y - 280, 920, 540, {
        variant: 'warehouse', tier: 'military', hue: 32, wall: 16,
        doorSide: 'south', layout: 'corridor', landmarkType: 'market',
        label: 'MARKET HALL', role: 'marketHall', entranceRole: 'mainEntrance',
    });
    const shops = [
        { dx: -720, dy: -350, w: 280, h: 220, side: 'east', hue: 18 },
        { dx: 720, dy: -350, w: 280, h: 220, side: 'west', hue: 28 },
        { dx: -650, dy: 360, w: 300, h: 230, side: 'east', hue: 12 },
        { dx: 650, dy: 360, w: 300, h: 230, side: 'west', hue: 38 },
    ];
    for (const [index, shop] of shops.entries()) {
        addHouse(obstacles, loot, spawnPoints, x + shop.dx, y + shop.dy, shop.w, shop.h, {
            variant: index % 2 ? 'cabin' : 'house',
            tier: index === 3 ? 'rare' : 'common',
            hue: shop.hue,
            doorSide: shop.side,
            landmarkType: 'market',
            label: index === 0 ? 'BAKERY' : index === 1 ? 'TRADER' : index === 2 ? 'WORKSHOP' : 'APOTHECARY',
            role: 'marketShop',
        });
    }
    for (const dx of [-230, -80, 80, 230]) {
        addObstacle(obstacles, 'crate', x + dx, y + 245, 46, 46, {
            hue: 28, variant: 'marketStall', role: 'marketCover', landmarkType: 'market',
        });
    }
    loot.push(makeChest(x - 300, y - 300, 'military'));
    loot.push(makeChest(x + 300, y - 300, 'rare'));
    spawnPoints.push({ x: x - 1040, y: y + 390, role: 'market-road' });
    spawnPoints.push({ x: x + 1040, y: y + 390, role: 'market-road' });
}

function addMilitaryBase(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1600, 1400, {
        collidable: false, variant: 'industrial', role: 'compound', landmarkType: 'military',
    });
    addObstacle(obstacles, 'road', x, y + 458, 160, 464, {
        collidable: false, variant: 'asphalt', role: 'driveway', landmarkType: 'military',
    });
    
    // Perimeter walls with North and South gates
    addDestructibleBarrier(obstacles, x - 500, y - 690, 580, 20, 'stone');
    addDestructibleBarrier(obstacles, x + 500, y - 690, 580, 20, 'stone');
    addDestructibleBarrier(obstacles, x - 790, y, 20, 1400, 'stone');
    addDestructibleBarrier(obstacles, x + 790, y, 20, 1400, 'stone');
    addDestructibleBarrier(obstacles, x - 500, y + 690, 580, 20, 'stone');
    addDestructibleBarrier(obstacles, x + 500, y + 690, 580, 20, 'stone');
    
    // Gate pillars
    addObstacle(obstacles, 'wall', x - 200, y + 690, 36, 36, 'stone');
    addObstacle(obstacles, 'wall', x + 200, y + 690, 36, 36, 'stone');
    addObstacle(obstacles, 'wall', x - 200, y - 690, 36, 36, 'stone');
    addObstacle(obstacles, 'wall', x + 200, y - 690, 36, 36, 'stone');

    // Guard towers at corners
    addObstacle(obstacles, 'wall', x - 770, y - 670, 70, 70, 'stone');
    addObstacle(obstacles, 'wall', x + 770, y - 670, 70, 70, 'stone');
    addObstacle(obstacles, 'wall', x - 770, y + 670, 70, 70, 'stone');
    addObstacle(obstacles, 'wall', x + 770, y + 670, 70, 70, 'stone');

    // Central Warehouse
    addHouse(obstacles, loot, spawnPoints, x, y, 600, 450, {
        variant: 'warehouse', tier: 'military', hue: 205, wall: 16, doorSide: 'south',
        landmarkType: 'military', label: 'ARMORY', role: 'armory', layout: 'corridor',
    });

    // Barracks buildings side-by-side
    addHouse(obstacles, loot, spawnPoints, x - 550, y - 400, 280, 220, {
        variant: 'warehouse', tier: 'military', hue: 195, wall: 14, doorSide: 'east',
        landmarkType: 'military', label: 'BARRACKS', role: 'barracks',
    });
    addHouse(obstacles, loot, spawnPoints, x + 550, y - 400, 280, 220, {
        variant: 'warehouse', tier: 'military', hue: 195, wall: 14, doorSide: 'west',
        landmarkType: 'military', label: 'BARRACKS', role: 'barracks',
    });

    // Decorative container rows (east and west sides)
    for (let i = 0; i < 6; i++) {
        addObstacle(obstacles, 'container', x + 550, y + 100 + i * 90, 125, 54, { hue: 195, rotation: Math.PI / 2, variant: 'blue' });
        addObstacle(obstacles, 'container', x - 550, y + 100 + i * 90, 125, 54, { hue: 210, rotation: Math.PI / 2, variant: 'red' });
    }

    // Sandbags and defensive positions
    for (const offset of [-300, -220, 220, 300]) {
        addObstacle(obstacles, 'sandbag', x + offset, y + 550, 60, 30, {
            rotation: 0, role: 'defense', landmarkType: 'military',
        });
    }

    // Guaranteed military ground loot inside warehouse and barracks
    loot.push(makeGroundLoot('weapon', x, y, { weaponType: 'sniper', source: 'military-loot' }));
    loot.push(makeGroundLoot('ammo', x - 40, y, { source: 'military-loot' }));
    loot.push(makeGroundLoot('ammo', x + 40, y, { source: 'military-loot' }));
    loot.push(makeGroundLoot('weapon', x - 550, y - 400, { weaponType: 'assault', source: 'military-loot' }));
    loot.push(makeGroundLoot('weapon', x + 550, y - 400, { weaponType: 'dmr', source: 'military-loot' }));
    loot.push(makeGroundLoot('medkit', x, y + 100, { source: 'military-loot' }));

    spawnPoints.push({ x: x, y: y + 780 });
    spawnPoints.push({ x: x, y: y - 780 });
}

function addGasStation(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'road', x, y, 1200, 800, { collidable: false, variant: 'asphalt' });

    // Store — all chests inside
    addHouse(obstacles, loot, spawnPoints, x, y - 200, 450, 250, { variant: 'warehouse', tier: 'rare', hue: 10, wall: 12 });

    // Add delivery crates behind store
    addObstacle(obstacles, 'crate', x - 180, y - 350, 44, 44, { rotation: 0.1 });
    addObstacle(obstacles, 'crate', x - 140, y - 350, 44, 44, { rotation: -0.15 });

    // Guaranteed soda (medkit) inside store
    loot.push(makeGroundLoot('medkit', x, y - 200, { amount: 1, source: 'gas-loot' }));

    // Pumps Canopy
    addObstacle(obstacles, 'field', x, y + 150, 500, 200, { collidable: false, variant: 'industrial' });

    // Fuel pumps
    for (let i = 0; i < 4; i++) {
        addObstacle(obstacles, 'barrel', x - 150 + i * 100, y + 150, 36, 36, { hue: 15, variant: 'fuel' });
    }

    // Cars (colored containers)
    addObstacle(obstacles, 'container', x - 400, y + 250, 110, 50, { hue: 0, rotation: 0.2, variant: 'red' });
    addObstacle(obstacles, 'container', x + 350, y + 100, 110, 50, { hue: 200, rotation: -0.1, variant: 'blue' });
}

function addPrison(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1800, 1800, { collidable: false, variant: 'quarry' });

    // High walls with North and South gates
    addDestructibleBarrier(obstacles, x - 500, y - 890, 780, 24, 'stone');
    addDestructibleBarrier(obstacles, x + 500, y - 890, 780, 24, 'stone');
    addDestructibleBarrier(obstacles, x - 500, y + 890, 780, 24, 'stone');
    addDestructibleBarrier(obstacles, x + 500, y + 890, 780, 24, 'stone');
    addDestructibleBarrier(obstacles, x - 890, y, 24, 1800, 'stone');
    addDestructibleBarrier(obstacles, x + 890, y, 24, 1800, 'stone');
    
    // Gate pillars
    addObstacle(obstacles, 'wall', x - 100, y + 890, 50, 50, 'stone');
    addObstacle(obstacles, 'wall', x + 100, y + 890, 50, 50, 'stone');
    addObstacle(obstacles, 'wall', x - 100, y - 890, 50, 50, 'stone');
    addObstacle(obstacles, 'wall', x + 100, y - 890, 50, 50, 'stone');

    // Central Yard
    addObstacle(obstacles, 'field', x, y, 600, 600, { collidable: false, variant: 'estate' });
    for (let i = 0; i < 6; i++) {
        addObstacle(obstacles, 'barrel', x - 200 + Math.random() * 400, y - 200 + Math.random() * 400, 30, 30, { hue: 20, variant: 'water' });
    }

    // Cell blocks — all loot is inside these buildings
    addHouse(obstacles, loot, spawnPoints, x - 500, y - 500, 300, 400, { variant: 'warehouse', tier: 'military', hue: 200, wall: 16 });
    addHouse(obstacles, loot, spawnPoints, x + 500, y - 500, 300, 400, { variant: 'warehouse', tier: 'military', hue: 200, wall: 16 });
    addHouse(obstacles, loot, spawnPoints, x - 500, y + 500, 300, 400, { variant: 'warehouse', tier: 'rare', hue: 200, wall: 16 });
    addHouse(obstacles, loot, spawnPoints, x + 500, y + 500, 300, 400, { variant: 'warehouse', tier: 'rare', hue: 200, wall: 16 });
    // Warden office (center)
    addHouse(obstacles, loot, spawnPoints, x, y, 260, 220, { variant: 'warehouse', tier: 'military', hue: 210, wall: 14 });

    // Guard towers (stone boxes)
    addObstacle(obstacles, 'wall', x - 800, y - 800, 100, 100, 'stone');
    addObstacle(obstacles, 'wall', x + 800, y - 800, 100, 100, 'stone');
    addObstacle(obstacles, 'wall', x - 800, y + 800, 100, 100, 'stone');
    addObstacle(obstacles, 'wall', x + 800, y + 800, 100, 100, 'stone');

    // Warden signature loot
    loot.push(makeGroundLoot('weapon', x, y, { weaponType: 'revolver', source: 'prison-loot' }));
    loot.push(makeGroundLoot('ammo', x - 30, y, { source: 'prison-loot' }));
    loot.push(makeGroundLoot('armor', x + 30, y, { armorValue: 60, source: 'prison-loot' }));

    spawnPoints.push({ x, y: y + 960 });
    spawnPoints.push({ x, y: y - 960 });
}

function addHospital(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1400, 1000, { collidable: false, variant: 'estate' });

    // Main building
    const hFloor = addObstacle(obstacles, 'houseFloor', x, y, 1000, 800, { collidable: false, hue: 0, variant: 'mansion' });
    const houseId = hFloor.id;
    // North wall
    addWall(obstacles, x, y - 400 + 8, 1000, 16, 'plaster');
    // South wall with entrance gap
    addWall(obstacles, x - 300, y + 400 - 8, 400, 16, 'plaster');
    addWall(obstacles, x + 300, y + 400 - 8, 400, 16, 'plaster');
    addDoor(obstacles, houseId, x, y + 400 - 8, 200, 32, 'plaster', 'south');
    // Side walls
    addWall(obstacles, x - 500 + 8, y, 16, 800, 'plaster');
    addWall(obstacles, x + 500 - 8, y, 16, 800, 'plaster');

    // Corridor walls with doorway gaps
    addVerticalInteriorWallSegments(obstacles, x - 200, y, 800, 16, [
        { center: -200, size: 90 },
        { center: 0, size: 90 },
        { center: 200, size: 90 },
    ], 'plaster');
    addVerticalInteriorWallSegments(obstacles, x + 200, y, 800, 16, [
        { center: -200, size: 90 },
        { center: 0, size: 90 },
        { center: 200, size: 90 },
    ], 'plaster');

    // Horizontal dividers with gaps
    addHorizontalInteriorWallSegments(obstacles, x - 350, y, 300, 16, [{ center: 0, size: 80 }], 'plaster');
    addHorizontalInteriorWallSegments(obstacles, x + 350, y, 300, 16, [{ center: 0, size: 80 }], 'plaster');

    // Room zones
    addRoomZone(obstacles, houseId, x - 350, y - 200, 300, 400, 'north-room');
    addRoomZone(obstacles, houseId, x - 350, y + 200, 300, 400, 'south-room');
    addRoomZone(obstacles, houseId, x, y, 400, 800, 'hallway');
    addRoomZone(obstacles, houseId, x + 350, y - 200, 300, 400, 'north-room');
    addRoomZone(obstacles, houseId, x + 350, y + 200, 300, 400, 'south-room');

    // Beds
    for (let i = 0; i < 4; i++) {
        addObstacle(obstacles, 'furniture', x - 400, y - 250 + i * 130, 36, 28, { collidable: false, variant: 'bed' });
        addObstacle(obstacles, 'furniture', x + 400, y - 250 + i * 130, 36, 28, { collidable: false, variant: 'bed' });
    }
    addObstacle(obstacles, 'furniture', x - 100, y - 100, 42, 30, { collidable: false, variant: 'table' });
    addObstacle(obstacles, 'furniture', x + 100, y - 100, 42, 30, { collidable: false, variant: 'table' });

    // The hospital is a high-value landmark, but the crates stay sparse and meaningful.
    loot.push(makeChest(x - 380, y - 240, 'rare', null, 'map', { outdoor: true }));
    loot.push(makeChest(x + 380, y + 220, 'rare', null, 'map', { outdoor: true }));
    loot.push(makeChest(x - 60, y + 250, 'military', null, 'map', { outdoor: true }));
    if (Math.random() < 0.45) loot.push(makeChest(x + 380, y - 220, 'rare', null, 'map', { outdoor: true }));

    // Guaranteed medical supplies on beds
    loot.push(makeGroundLoot('medkit', x - 400, y - 250, { amount: 1, source: 'hospital-loot' }));
    loot.push(makeGroundLoot('medkit', x + 400, y - 250, { amount: 1, source: 'hospital-loot' }));
    loot.push(makeGroundLoot('medkit', x - 400, y + 140, { amount: 1, source: 'hospital-loot' }));

    spawnPoints.push({ x, y: y + 480 });
    spawnPoints.push({ x, y: y - 480 });
}

function addRadioTower(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 800, 800, { collidable: false, variant: 'industrial' });

    // Fence with gate on North and South sides
    addDestructibleBarrier(obstacles, x - 250, y - 390, 280, 10, 'stone');
    addDestructibleBarrier(obstacles, x + 250, y - 390, 280, 10, 'stone');
    addDestructibleBarrier(obstacles, x - 250, y + 390, 280, 10, 'stone');
    addDestructibleBarrier(obstacles, x + 250, y + 390, 280, 10, 'stone');
    addDestructibleBarrier(obstacles, x - 390, y, 10, 800, 'stone');
    addDestructibleBarrier(obstacles, x + 390, y, 10, 800, 'stone');

    // Fence gate posts
    addObstacle(obstacles, 'wall', x - 100, y + 390, 20, 20, 'stone');
    addObstacle(obstacles, 'wall', x + 100, y + 390, 20, 20, 'stone');
    addObstacle(obstacles, 'wall', x - 100, y - 390, 20, 20, 'stone');
    addObstacle(obstacles, 'wall', x + 100, y - 390, 20, 20, 'stone');

    // Tower Base (decorative, not blocking)
    addObstacle(obstacles, 'wall', x, y, 80, 80, 'warehouse');

    // Control buildings
    addHouse(obstacles, loot, spawnPoints, x - 200, y - 200, 200, 180, { variant: 'warehouse', tier: 'rare', hue: 200 });
    addHouse(obstacles, loot, spawnPoints, x + 160, y + 160, 200, 180, { variant: 'warehouse', tier: 'military', hue: 205 });

    // Cover near gate
    addObstacle(obstacles, 'crate', x - 120, y + 340, 44, 44, { rotation: 0.1 });
    addObstacle(obstacles, 'crate', x + 120, y + 340, 44, 44, { rotation: -0.1 });

    // Guaranteed control room loot
    loot.push(makeGroundLoot('weapon', x - 200, y - 200, { weaponType: 'smg', source: 'tower-loot' }));
    loot.push(makeGroundLoot('ammo', x - 200, y - 160, { source: 'tower-loot' }));

    spawnPoints.push({ x, y: y + 460 });
    spawnPoints.push({ x, y: y - 460 });
}

// --- Rivers & Bridges ---

function generateRiverPath(worldHalf, startX, startY, endX, endY, segments = 12) {
    const points = [{ x: startX, y: startY }];
    const dx = endX - startX;
    const dy = endY - startY;
    const length = Math.max(1, Math.hypot(dx, dy));
    const normalX = -dy / length;
    const normalY = dx / length;
    const phase = Math.random() * Math.PI * 2;
    const wander = worldHalf * 0.055;
    for (let i = 1; i < segments; i++) {
        const t = i / segments;
        const baseX = startX + (endX - startX) * t;
        const baseY = startY + (endY - startY) * t;
        const envelope = Math.sin(Math.PI * t);
        const lateral = (
            Math.sin(t * Math.PI * 2.4 + phase) * 0.72
            + Math.sin(t * Math.PI * 5.2 + phase * 0.63) * 0.22
        ) * wander * envelope;
        points.push({
            x: baseX + normalX * lateral,
            y: baseY + normalY * lateral,
        });
    }
    points.push({ x: endX, y: endY });
    return points;
}

function addRiver(obstacles, worldHalf, startX, startY, endX, endY, width = 220) {
    const points = generateRiverPath(worldHalf, startX, startY, endX, endY, 14);
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    // A path-sized bounding box keeps the static spline visible to clients near
    // any part of the river, instead of only near its western start point.
    addObstacle(obstacles, 'river_path', (minX + maxX) / 2, (minY + maxY) / 2, maxX - minX + width, maxY - minY + width, {
        collidable: false,
        variant: 'river_path',
        points,
        width,
        role: 'riverSpline',
    });

    const riverSegments = [];
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const segWidth = width * (0.8 + Math.random() * 0.4);
        
        // These are just for physics now (we won't render them directly on client)
        addObstacle(obstacles, 'river', mx, my, segLen + width * 0.5, segWidth, {
            collidable: false,
            variant: 'river',
            rotation: angle,
        });
        riverSegments.push({ x: mx, y: my, w: segLen + width * 0.5, h: segWidth, angle });
    }
    return { points, segments: riverSegments, width };
}

function addBridge(obstacles, x, y, width, length, rotation = 0) {
    // Road surface
    addObstacle(obstacles, 'bridge', x, y, length, width, {
        collidable: false,
        variant: 'bridge',
        rotation,
    });
    // Railings
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const railOffset = width / 2 - 8;
    addObstacle(obstacles, 'wall', x - sin * railOffset, y + cos * railOffset, length, 12, {
        collidable: false,
        rotation,
        variant: 'stone',
        hue: 210,
        role: 'bridgeRail',
    });
    addObstacle(obstacles, 'wall', x + sin * railOffset, y - cos * railOffset, length, 12, {
        collidable: false,
        rotation,
        variant: 'stone',
        hue: 210,
        role: 'bridgeRail',
    });
}

function addBridgesAlongRiver(obstacles, riverData, roadPositions) {
    // Intersect the spline with each vertical highway. Using a segment midpoint
    // could move a bridge hundreds of units away from the road it should carry.
    for (const rp of roadPositions) {
        let crossing = null;
        for (let i = 0; i < riverData.points.length - 1; i++) {
            const a = riverData.points[i];
            const b = riverData.points[i + 1];
            const dx = b.x - a.x;
            if (Math.abs(dx) < 1) continue;
            const t = (rp.x - a.x) / dx;
            if (t < 0 || t > 1) continue;
            const crossingY = a.y + (b.y - a.y) * t;
            const candidate = {
                x: rp.x,
                y: crossingY,
                distance: Math.abs(crossingY - rp.y),
                angle: Math.atan2(b.y - a.y, dx),
            };
            if (!crossing || candidate.distance < crossing.distance) crossing = candidate;
        }
        if (crossing && crossing.distance < 2200) {
            addBridge(
                obstacles,
                crossing.x,
                crossing.y,
                140,
                riverData.width + 130,
                crossing.angle + Math.PI / 2,
            );
        }
    }
}

// --- Standalone house for filling gaps ---

function addStandaloneHouse(obstacles, loot, spawnPoints, x, y) {
    const variants = ['cabin', 'house', 'barn'];
    const variant = variants[Math.floor(Math.random() * variants.length)];
    const w = 190 + Math.random() * 80;
    const h = 170 + Math.random() * 60;
    const tier = Math.random() > 0.82 ? 'rare' : 'common';
    addHouse(obstacles, loot, spawnPoints, x, y, w, h, {
        variant,
        hue: 14 + Math.floor(Math.random() * 24),
        tier,
    });
    // Some decoration around the house
    if (Math.random() > 0.4) {
        addObstacle(obstacles, 'crate', x + w * 0.5 + 40, y + (Math.random() - 0.5) * h * 0.5, 44, 44, {
            hue: 28, rotation: Math.random() * 0.3,
        });
    }
    if (Math.random() > 0.5) {
        const treeX = x - w * 0.5 - 50 - Math.random() * 40;
        const treeY = y - h * 0.3;
        const treeS = 36 + Math.random() * 20;
        if (!isMapPositionBlocked(obstacles, treeX, treeY, treeS / 2)) {
            addObstacle(obstacles, 'tree', treeX, treeY, treeS, treeS, {
                hue: 108 + Math.floor(Math.random() * 24),
                rotation: Math.random() * Math.PI,
            });
        }
    }
}

function addScatteredGroundLoot(obstacles, loot) {
    const groundItemCount = 22;
    const floors = obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor'
        && obstacle.w >= 170
        && obstacle.h >= 140
    ));
    if (!floors.length) return;

    for (let i = 0; i < groundItemCount; i++) {
        for (let attempt = 0; attempt < 60; attempt++) {
            const floor = floors[(i * 17 + attempt * 11 + Math.floor(Math.random() * floors.length)) % floors.length];
            const insetX = Math.min(52, floor.w * 0.24);
            const insetY = Math.min(52, floor.h * 0.24);
            const pos = {
                x: floor.x + (Math.random() - 0.5) * Math.max(10, floor.w - insetX * 2),
                y: floor.y + (Math.random() - 0.5) * Math.max(10, floor.h - insetY * 2),
            };
            const blocked = obstacles.some(obstacle => (
                obstacle.collidable !== false
                && circleRectCollision(pos.x, pos.y, 20, obstacle)
            ));
            if (blocked) continue;

            const roll = Math.random();
            const metadata = { houseId: floor.id, location: 'interior' };
            if (roll < 0.36) {
                loot.push(makeGroundLoot('ammo', pos.x, pos.y, metadata));
            } else if (roll < 0.62) {
                loot.push(makeGroundLoot('medkit', pos.x, pos.y, metadata));
            } else if (roll < 0.82) {
                loot.push(makeGroundLoot('armor', pos.x, pos.y, { ...metadata, armorValue: 35 }));
            } else {
                const tier = Math.random() < 0.08 ? 'rare' : 'common';
                const weaponType = pickWeaponForTier(tier);
                loot.push(makeGroundLoot('weapon', pos.x, pos.y, {
                    ...metadata,
                    weaponType,
                    tier: WEAPONS[weaponType]?.rarity || tier,
                }));
            }
            break;
        }
    }
}

function rectsOverlap(x1, y1, w1, h1, x2, y2, w2, h2) {
    return Math.abs(x1 - x2) < (w1 + w2) / 2 && Math.abs(y1 - y2) < (h1 + h2) / 2;
}

const CLEARABLE_MAP_PROP_KINDS = new Set([
    'tree', 'bush', 'rock', 'crate', 'barrel', 'container', 'sandbag', 'tent',
]);

function getDoorApproachRect(door) {
    const horizontal = door.role === 'north' || door.role === 'south';
    return {
        x: door.x,
        y: door.y,
        w: horizontal ? Math.max(180, door.w + 120) : 190,
        h: horizontal ? 190 : Math.max(180, door.h + 120),
    };
}

function clearInvalidBuildingProps(obstacles) {
    const floors = obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
    const approaches = obstacles
        .filter(obstacle => obstacle.kind === 'door')
        .map(getDoorApproachRect);

    for (let i = obstacles.length - 1; i >= 0; i--) {
        const obstacle = obstacles[i];
        if (!CLEARABLE_MAP_PROP_KINDS.has(obstacle.kind)) continue;
        const blocksDoor = approaches.some(approach => rectsOverlap(
            obstacle.x, obstacle.y, obstacle.w, obstacle.h,
            approach.x, approach.y, approach.w, approach.h,
        ));
        const embeddedInBuilding = !obstacle.houseId && floors.some(floor => rectsOverlap(
            obstacle.x, obstacle.y, obstacle.w, obstacle.h,
            floor.x, floor.y, floor.w, floor.h,
        ));
        if (blocksDoor || embeddedInBuilding) obstacles.splice(i, 1);
    }
}

function isGeneratedSpawnPointSafe(obstacles, x, y, radius = 30) {
    for (const obstacle of obstacles) {
        const forbiddenSurface = obstacle.kind === 'houseFloor'
            || obstacle.kind === 'water'
            || obstacle.kind === 'river';
        if (!forbiddenSurface && obstacle.collidable === false) continue;
        if (circleRectCollision(x, y, radius, obstacle)) return false;
    }
    return true;
}

function sanitizeGeneratedSpawnPoints(obstacles, spawnPoints, worldHalf) {
    const seen = new Set();
    const safe = [];
    for (const point of spawnPoints) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        if (Math.abs(point.x) > worldHalf - 80 || Math.abs(point.y) > worldHalf - 80) continue;
        if (!isGeneratedSpawnPointSafe(obstacles, point.x, point.y, 28)) continue;
        const key = Math.round(point.x / 40) + ',' + Math.round(point.y / 40);
        if (seen.has(key)) continue;
        seen.add(key);
        safe.push(point);
    }
    spawnPoints.length = 0;
    spawnPoints.push(...safe);
}

function isAreaOverlapping(x, y, w, h, buffer = 200, poiList = []) {
    // 1. Check road overlap
    // West N-S Highway: x = -2500
    if (rectsOverlap(x, y, w, h, -2500, 0, 120 + buffer * 2, 20000)) return true;
    // East N-S Highway: x = 2500
    if (rectsOverlap(x, y, w, h, 2500, 0, 120 + buffer * 2, 20000)) return true;
    // Central E-W Highway: y = 2000
    if (rectsOverlap(x, y, w, h, 0, 2000, 20000, 120 + buffer * 2)) return true;
    // North E-W Highway: y = -4000
    if (rectsOverlap(x, y, w, h, 0, -4000, 20000, 120 + buffer * 2)) return true;

    // 2. Check river overlap
    if (rectsOverlap(x, y, w, h, 0, -1500, 20000, 1200 + buffer * 2)) return true;

    // 3. Check branch roads
    // Center branch: x = 0, y from 0 to 2000
    if (rectsOverlap(x, y, w, h, 0, 1000, 120 + buffer * 2, 2000)) return true;
    // South Villa branch: x = -200, y from 2000 to 5200
    if (rectsOverlap(x, y, w, h, -200, 3600, 120 + buffer * 2, 3200)) return true;
    // Gas station branch: y = -7800, x from -2500 to -1500
    if (rectsOverlap(x, y, w, h, -2000, -7800, 1000, 120 + buffer * 2)) return true;
    // Hospital branch: y = 1500, x from 2500 to 5500
    if (rectsOverlap(x, y, w, h, 4000, 1500, 3000, 120 + buffer * 2)) return true;
    // Container docks branch: x = -5200, y from -800 to 2000
    if (rectsOverlap(x, y, w, h, -5200, 600, 120 + buffer * 2, 2800)) return true;
    // Military branch: x = 3200, y from -5200 to -4000
    if (rectsOverlap(x, y, w, h, 3200, -4600, 120 + buffer * 2, 1200)) return true;
    // Quarry branch: x = 7400, y from -4000 to -3200
    if (rectsOverlap(x, y, w, h, 7400, -3600, 120 + buffer * 2, 800)) return true;
    // Prison branch: x = 5200, y from 2000 to 4800
    if (rectsOverlap(x, y, w, h, 5200, 3400, 120 + buffer * 2, 2800)) return true;
    // Radio tower branch: x = -5400, y from 2000 to 4200
    if (rectsOverlap(x, y, w, h, -5400, 3100, 120 + buffer * 2, 2200)) return true;
    // Pine town branch: x = -4200, y from -4200 to -4000
    if (rectsOverlap(x, y, w, h, -4200, -4100, 120 + buffer * 2, 200)) return true;

    // 4. Check POI overlap
    for (const poi of poiList) {
        if (rectsOverlap(x, y, w, h, poi.x, poi.y, poi.w + buffer * 2, poi.h + buffer * 2)) {
            return true;
        }
    }
    return false;
}

export function generateSurvivMap(worldHalf) {
    const obstacles = [];
    const loot = [];
    const spawnPoints = [];
    const landmarks = [];

    const wh = worldHalf;

    // ─────────────────────────────────────────────────────────────────────────
    // ORGANIC POI COORDINATES & BOUNDING BOXES
    // ─────────────────────────────────────────────────────────────────────────
    const mansionPos = { x: 0, y: 0, w: 1500, h: 1050 };
    const militaryPos = { x: 3200, y: -5200, w: 1600, h: 1400 };
    const hospitalPos = { x: 5500, y: 1500, w: 1400, h: 1000 };
    const villaPos = { x: -200, y: 5200, w: 1500, h: 1050 };
    const yardPos = { x: -5200, y: -800, w: 1200, h: 900 };

    const quarryPos = { x: 7400, y: -3200, w: 1200, h: 900 };
    const prisonPos = { x: 5200, y: 4800, w: 1800, h: 1800 };
    const towerPos = { x: -5400, y: 4200, w: 800, h: 800 };
    const townPos = { x: -4200, y: -4200, w: 2360, h: 680 }; // size 8 town

    const gasPos = { x: -1500, y: -7800, w: 1200, h: 800 };
    const farmPos = { x: 7800, y: -1200, w: 1400, h: 760 }; 
    const bunkerPos = { x: 2400, y: 7800, w: 1200, h: 820 };
    const campPos = { x: -7800, y: -3800, w: 2600, h: 2200 };
    
    const neTownPos = { x: 5800, y: -6800, w: 2000, h: 680 }; // size 7 town
    const seLabPos = { x: 7800, y: 7200, w: 1400, h: 760 };
    const swTownPos = { x: -7200, y: 1800, w: 2000, h: 680 }; // size 7 town
    const nwMansionPos = { x: -7500, y: -7400, w: 1500, h: 1050 };
    const ironworksPos = { x: -3900, y: 7300, w: 2600, h: 1900 };
    const marketPos = { x: -7600, y: 6500, w: 1900, h: 1320 };

    const POI_LIST = [
        mansionPos, militaryPos, hospitalPos, villaPos, yardPos,
        quarryPos, prisonPos, towerPos, townPos, gasPos,
        farmPos, bunkerPos, campPos, neTownPos, seLabPos,
        swTownPos, nwMansionPos, ironworksPos, marketPos
    ];

    // ─────────────────────────────────────────────────────────────────────────
    // GENERATE LANDMARKS
    // ─────────────────────────────────────────────────────────────────────────
    
    // Mansion (Center)
    addMansion(obstacles, loot, spawnPoints, mansionPos.x, mansionPos.y);
    landmarks.push({ name: 'Old Estate', x: mansionPos.x, y: mansionPos.y, type: 'mansion' });

    // Inner Ring POIs
    addMilitaryBase(obstacles, loot, spawnPoints, militaryPos.x, militaryPos.y);
    landmarks.push({ name: 'North Military Base', x: militaryPos.x, y: militaryPos.y, type: 'military' });

    addHospital(obstacles, loot, spawnPoints, hospitalPos.x, hospitalPos.y);
    landmarks.push({ name: 'East Hospital', x: hospitalPos.x, y: hospitalPos.y, type: 'hospital' });

    addMansion(obstacles, loot, spawnPoints, villaPos.x, villaPos.y);
    landmarks.push({ name: 'South Villa', x: villaPos.x, y: villaPos.y, type: 'mansion' });

    addContainerYard(obstacles, loot, spawnPoints, yardPos.x, yardPos.y);
    landmarks.push({ name: 'West Container Docks', x: yardPos.x, y: yardPos.y, type: 'yard' });

    // Mid Ring POIs
    // Quarry
    addObstacle(obstacles, 'field', quarryPos.x, quarryPos.y, 1200, 900, { collidable: false, variant: 'quarry' });
    for (let i = 0; i < 24; i++) {
        addObstacle(obstacles, 'rock', quarryPos.x - 520 + Math.random() * 1040, quarryPos.y - 390 + Math.random() * 780, 54 + Math.random() * 48, 48 + Math.random() * 42, { hue: 220, rotation: Math.random() * 0.4 });
    }
    addHouse(obstacles, loot, spawnPoints, quarryPos.x + 360, quarryPos.y - 260, 300, 230, { variant: 'warehouse', tier: 'military', hue: 205 });
    addHouse(obstacles, loot, spawnPoints, quarryPos.x - 340, quarryPos.y + 200, 280, 210, { variant: 'warehouse', tier: 'military', hue: 200 });
    landmarks.push({ name: 'NE Quarry', x: quarryPos.x, y: quarryPos.y, type: 'quarry' });

    // Prison
    addPrison(obstacles, loot, spawnPoints, prisonPos.x, prisonPos.y);
    landmarks.push({ name: 'SE State Prison', x: prisonPos.x, y: prisonPos.y, type: 'prison' });

    // Radio Tower
    addRadioTower(obstacles, loot, spawnPoints, towerPos.x, towerPos.y);
    landmarks.push({ name: 'SW Radio Tower', x: towerPos.x, y: towerPos.y, type: 'tower' });

    // Pine Town
    addSettlement(obstacles, loot, spawnPoints, townPos.x, townPos.y, 8, 'town');
    landmarks.push({ name: 'NW Pine Town', x: townPos.x, y: townPos.y, type: 'town' });

    // Outer POIs
    // Gas Station
    addGasStation(obstacles, loot, spawnPoints, gasPos.x, gasPos.y);
    landmarks.push({ name: 'North Gas Station', x: gasPos.x, y: gasPos.y, type: 'gas' });

    // Farm
    addFarmstead(obstacles, loot, spawnPoints, farmPos.x, farmPos.y);
    landmarks.push({ name: 'East Farm', x: farmPos.x, y: farmPos.y, type: 'farm' });

    // South Bunker (Ruins)
    addObstacle(obstacles, 'field', bunkerPos.x, bunkerPos.y, 1200, 820, {
        collidable: false, variant: 'ruins', role: 'compound', landmarkType: 'bunker',
    });
    addHouse(obstacles, loot, spawnPoints, bunkerPos.x, bunkerPos.y, 520, 360, {
        variant: 'warehouse', tier: 'military', hue: 205, wall: 18, doorSide: 'north',
        landmarkType: 'bunker', label: 'BUNKER', role: 'mainBuilding', layout: 'corridor',
    });
    addHouse(obstacles, loot, spawnPoints, bunkerPos.x - 380, bunkerPos.y - 200, 260, 200, {
        variant: 'warehouse', tier: 'military', hue: 200, doorSide: 'east',
        landmarkType: 'bunker', label: 'UTILITY', role: 'utility', entranceRole: 'serviceEntrance',
    });
    landmarks.push({ name: 'South Bunker', x: bunkerPos.x, y: bunkerPos.y, type: 'bunker' });

    // West Forest Camp: three distinct clearings around a central access lane.
    // The old five-site row used 280-unit spacing for 600-800-unit sites, which
    // caused ponds, roads, houses, and cover to stack on top of each other.
    const forestCampSites = [
        { x: campPos.x - 900, y: campPos.y - 650 },
        { x: campPos.x + 900, y: campPos.y - 650 },
        { x: campPos.x, y: campPos.y + 720 },
    ];
    for (const site of forestCampSites) {
        addMicroSite(obstacles, loot, spawnPoints, site.x, site.y, 'wetlands');
    }
    addForest(obstacles, loot, spawnPoints, campPos.x, campPos.y, 24, 1050);
    landmarks.push({ name: 'West Forest Camp', x: campPos.x, y: campPos.y, type: 'camp' });

    // NE Town
    addSettlement(obstacles, loot, spawnPoints, neTownPos.x, neTownPos.y, 7, 'town');
    landmarks.push({ name: 'NE Town', x: neTownPos.x, y: neTownPos.y, type: 'town' });

    // SE Lab
    addResearchCampus(obstacles, loot, spawnPoints, seLabPos.x, seLabPos.y);
    landmarks.push({ name: 'SE Lab', x: seLabPos.x, y: seLabPos.y, type: 'lab' });

    // SW Town
    addSettlement(obstacles, loot, spawnPoints, swTownPos.x, swTownPos.y, 7, 'town');
    landmarks.push({ name: 'SW Town', x: swTownPos.x, y: swTownPos.y, type: 'town' });

    // NW Mansion
    addMansion(obstacles, loot, spawnPoints, nwMansionPos.x, nwMansionPos.y);
    landmarks.push({ name: 'NW Mansion', x: nwMansionPos.x, y: nwMansionPos.y, type: 'mansion' });

    // Large indoor landmark with multiple rotations and a direct highway apron.
    addIronworks(obstacles, loot, spawnPoints, ironworksPos.x, ironworksPos.y);
    landmarks.push({ name: 'Ironworks', x: ironworksPos.x, y: ironworksPos.y, type: 'ironworks' });

    addMarketVillage(obstacles, loot, spawnPoints, marketPos.x, marketPos.y);
    landmarks.push({ name: 'Grand Market', x: marketPos.x, y: marketPos.y, type: 'market' });

    // ─────────────────────────────────────────────────────────────────────────
    // ROAD NETWORK (Structured Highways)
    // ─────────────────────────────────────────────────────────────────────────
    const roadW = 120;
    
    // West North-South Highway
    addRoad(obstacles, -2500, -wh * 0.9, -2500, wh * 0.9, roadW);
    // East North-South Highway
    addRoad(obstacles, 2500, -wh * 0.9, 2500, wh * 0.9, roadW);
    // Central East-West Highway
    addRoad(obstacles, -wh * 0.9, 2000, wh * 0.9, 2000, roadW);
    // North East-West Highway
    addRoad(obstacles, -wh * 0.9, -4000, wh * 0.9, -4000, roadW);

    // Branch connectors linking compounds to the highways
    addRoad(obstacles, 0, 0, 0, 2000, roadW);             // Old Estate to E-W Highway
    addRoad(obstacles, -200, 2000, -200, villaPos.y, roadW); // South Villa to E-W Highway
    addRoad(obstacles, -2500, gasPos.y, gasPos.x, gasPos.y, roadW); // North Gas Station to West N-S Highway
    addRoad(obstacles, 2500, hospitalPos.y, hospitalPos.x, hospitalPos.y, roadW); // Hospital to East N-S Highway
    addRoad(obstacles, yardPos.x, 2000, yardPos.x, yardPos.y, roadW); // Container Docks to E-W Highway
    addRoad(obstacles, militaryPos.x, -4000, militaryPos.x, militaryPos.y, roadW); // Military Base to North E-W Highway
    addRoad(obstacles, quarryPos.x, -4000, quarryPos.x, quarryPos.y, roadW); // Quarry to North E-W Highway
    addRoad(obstacles, prisonPos.x, 2000, prisonPos.x, prisonPos.y, roadW); // State Prison to E-W Highway
    addRoad(obstacles, towerPos.x, 2000, towerPos.x, towerPos.y, roadW); // Radio Tower to E-W Highway
    addRoad(obstacles, townPos.x, -4000, townPos.x, townPos.y, roadW); // Pine Town to North E-W Highway
    addRoad(obstacles, 2500, farmPos.y, farmPos.x - 850, farmPos.y, roadW); // East Farm lane
    addRoad(obstacles, 2500, neTownPos.y, neTownPos.x - 1000, neTownPos.y, roadW); // NE Town main street
    addRoad(obstacles, 2500, seLabPos.y, seLabPos.x - 850, seLabPos.y, roadW); // Research campus avenue
    addRoad(obstacles, nwMansionPos.x, -4000, nwMansionPos.x, nwMansionPos.y + 590, roadW); // NW Mansion gate
    addRoad(obstacles, marketPos.x, 2000, marketPos.x, marketPos.y + 390, roadW); // Grand Market main street

    addObstacle(obstacles, 'road', swTownPos.x, 1900, roadW, 200, {
        collidable: false, variant: 'asphalt', role: 'driveway', landmarkType: 'town',
    });
    addObstacle(obstacles, 'road', campPos.x, -3900, roadW, 200, {
        collidable: false, variant: 'dirt', role: 'path', landmarkType: 'camp',
    });
    addObstacle(obstacles, 'road', bunkerPos.x, 7310, roadW, 620, {
        collidable: false, variant: 'dirt', role: 'driveway', landmarkType: 'bunker',
    });

    // Only discard tiny clipping fragments. The previous 1020-unit threshold
    // erased legitimate final approaches to several landmarks.
    removeShortNetworkRoadStubs(obstacles, roadW * 1.1);

    // ─────────────────────────────────────────────────────────────────────────
    // RIVERS & BRIDGES (Aligned with N-S highways)
    // ─────────────────────────────────────────────────────────────────────────
    const riverEW = addRiver(obstacles, wh,
        -wh * 0.9, -wh * 0.18,
         wh * 0.9, -wh * 0.12,
        210 + Math.random() * 60);

    // Bridges placed exactly where the two N-S highways cross the river (around y ≈ -1500)
    addBridgesAlongRiver(obstacles, riverEW, [
        { x: -2500, y: -1500 },
        { x: 2500, y: -1500 }
    ]);

    // ─────────────────────────────────────────────────────────────────────────
    // BIOME COVER & ROAD MARKERS
    // ─────────────────────────────────────────────────────────────────────────
    const roadReservations = obstacles
        .filter(obstacle => obstacle.kind === 'road' && obstacle.role === 'networkRoad')
        .map(road => ({ x: road.x, y: road.y, w: road.w, h: road.h }));
    const placedPositions = [...POI_LIST, ...roadReservations];
    // Curated hamlets create recognizable rotations between major POIs. They
    // replace the old density fallback that sprinkled isolated houses anywhere.
    const hamletPlans = [
        { x: -1200, y: 7600, orientation: 'vertical' },
        { x: 1200, y: -6900, orientation: 'horizontal' },
        { x: 4200, y: -8300, orientation: 'vertical' },
        { x: 7000, y: 3000, orientation: 'horizontal' },
        { x: 700, y: 3600, orientation: 'horizontal' },
    ];
    for (const plan of hamletPlans) {
        const w = plan.orientation === 'horizontal' ? 1040 : 720;
        const h = plan.orientation === 'horizontal' ? 720 : 1040;
        if (isAreaOverlapping(plan.x, plan.y, w, h, 240, placedPositions)) continue;
        addRoadsideHamlet(obstacles, loot, spawnPoints, plan.x, plan.y, plan.orientation);
        placedPositions.push({ x: plan.x, y: plan.y, w, h });
    }


    // NW Pine Forest biome - compact patches that break up empty crossings.
    for (let i = 0; i < 5; i++) {
        const fx = -6500 + i * 2000 + (Math.random() - 0.5) * 400;
        const fy = -6000 + (Math.random() - 0.5) * 400;
        if (!isAreaOverlapping(fx, fy, 800, 800, 200, placedPositions)) {
            addForest(obstacles, loot, spawnPoints, fx, fy, 16, 340);
            placedPositions.push({ x: fx, y: fy, w: 800, h: 800 });
        }
    }

    // SW Wetlands/Swamp biome.
    for (let i = 0; i < 5; i++) {
        const sx = -7000 + i * 1500 + (Math.random() - 0.5) * 300;
        const sy = 4500 + (Math.random() - 0.5) * 300;
        if (!isAreaOverlapping(sx, sy, 600, 600, 200, placedPositions)) {
            addCoverPatch(obstacles, loot, spawnPoints, sx, sy, { radius: 230, variant: 'wetlands' });
            placedPositions.push({ x: sx, y: sy, w: 600, h: 600 });
        }
    }

    // Standalone filler houses, microsites, and cover patches.
    const fillStep = 2750;
    const fillMargin = 1700;
    for (let gx = -wh + fillMargin; gx <= wh - fillMargin; gx += fillStep) {
        for (let gy = -wh + fillMargin; gy <= wh - fillMargin; gy += fillStep) {
            const x = clamp(gx + (Math.random() - 0.5) * 1050, -wh + 1200, wh - 1200);
            const y = clamp(gy + (Math.random() - 0.5) * 1050, -wh + 1200, wh - 1200);
            
            if (Math.hypot(x, y) < 2000) continue;
            
            if (isAreaOverlapping(x, y, 1000, 820, 320, placedPositions)) continue;
            
            placedPositions.push({ x, y, w: 1000, h: 820 });
            const roll = Math.random();
            if (roll < 0.5) {
                addStandaloneHouse(obstacles, loot, spawnPoints, x, y);
            } else if (roll < 0.82) {
                addMicroSite(obstacles, loot, spawnPoints, x, y, 'grass');
            } else {
                addCoverPatch(obstacles, loot, spawnPoints, x, y, { radius: 260, variant: 'woods' });
            }
        }
    }

    // Countryside scatter: loose trees and occasional single houses so the long crossings
    // still feel natural without turning every open field into a dense compound.
    let countrysideHouses = 0;
    const countrysideHouseLimit = 16;
    const scatterStep = 1250;
    const scatterMargin = 950;
    for (let gx = -wh + scatterMargin; gx <= wh - scatterMargin; gx += scatterStep) {
        for (let gy = -wh + scatterMargin; gy <= wh - scatterMargin; gy += scatterStep) {
            if (Math.random() < 0.08) continue;
            const x = clamp(gx + (Math.random() - 0.5) * 620, -wh + 760, wh - 760);
            const y = clamp(gy + (Math.random() - 0.5) * 620, -wh + 760, wh - 760);

            if (Math.hypot(x, y) < 1700) continue;
            if (isAreaOverlapping(x, y, 330, 330, 115, placedPositions)) continue;

            if (countrysideHouses < countrysideHouseLimit && Math.random() < 0.16) {
                addStandaloneHouse(obstacles, loot, spawnPoints, x, y);
                placedPositions.push({ x, y, w: 560, h: 520 });
                countrysideHouses++;
            } else {
                const placed = addOpenFieldScatter(obstacles, x, y, {
                    radius: 190 + Math.random() * 210,
                    count: 6 + Math.floor(Math.random() * 5),
                    variant: y < -4800 ? 'pine' : y > 4200 ? 'scrub' : 'grass',
                });
                if (placed > 0) placedPositions.push({ x, y, w: 300, h: 300 });
            }
        }
    }

    // Forests scattered organically in remaining outer areas
    for (let i = 0; i < 10; i++) {
        const pos = randomSpawnCoord(wh * 0.88);
        if (Math.hypot(pos.x, pos.y) < 2400) continue;
        if (!isAreaOverlapping(pos.x, pos.y, 560, 560, 240, placedPositions)) {
            addForest(obstacles, loot, spawnPoints, pos.x, pos.y, 16, 320);
            placedPositions.push({ x: pos.x, y: pos.y, w: 600, h: 600 });
        }
    }

    addScatteredGroundLoot(obstacles, loot);
    clearInvalidBuildingProps(obstacles);
    sanitizeGeneratedSpawnPoints(obstacles, spawnPoints, worldHalf);

    return { obstacles, loot, spawnPoints, landmarks };
}

export function generateSurvivObstacles(worldHalf) {
    return generateSurvivMap(worldHalf).obstacles;
}

export function getSurvivZone(resetTime, now = Date.now()) {
    const resetAt = Number(resetTime);
    if (!Number.isFinite(resetAt)) return null;

    const duration = Math.max(1, SURVIV.shrinkBeforeResetMs);
    const shrinkStartsAt = resetAt - duration;
    const linearProgress = clamp((now - shrinkStartsAt) / duration, 0, 1);
    const easedProgress = linearProgress * linearProgress * (3 - 2 * linearProgress);
    const startRadius = Math.SQRT2 * SURVIV.worldHalf + SURVIV.playerRadius;
    const radius = startRadius + (SURVIV.minZoneRadius - startRadius) * easedProgress;

    return {
        x: 0,
        y: 0,
        radius,
        targetX: 0,
        targetY: 0,
        targetRadius: SURVIV.minZoneRadius,
        progress: linearProgress,
        shrinking: linearProgress > 0 && linearProgress < 1,
        damagePerSecond: SURVIV.zoneDamagePerSecond,
        startsInMs: Math.max(0, shrinkStartsAt - now),
        endsInMs: Math.max(0, resetAt - now),
    };
}

export function getSurvivEffectiveRadius(resetTime, now = Date.now()) {
    return getSurvivZone(resetTime, now)?.radius ?? SURVIV.worldHalf;
}

function makeWeaponState(typeId) {
    const def = WEAPONS[typeId] || WEAPONS.fists;
    return {
        type: def.id,
        ammo: def.clipSize,
        reloading: false,
        reloadEndAt: 0,
        lastShotAt: 0,
    };
}

export function beginSurvivReload(entity, now = Date.now()) {
    const weapon = entity?.weapon;
    if (!weapon || weapon.reloading) return false;
    const definition = WEAPONS[weapon.type];
    if (!definition || definition.melee || definition.clipSize <= 0) return false;
    if ((Number(weapon.ammo) || 0) >= definition.clipSize) return false;

    const inventory = ensureInventory(entity);
    if (inventory.ammoPacks <= 0) return false;
    inventory.ammoPacks -= 1;
    weapon.reloading = true;
    weapon.reloadEndAt = now + definition.reloadMs;
    return true;
}

function makeInventory() {
    return {
        // Firearms only. Fists are an always-available third/melee slot.
        weapons: [],
        medkits: 0,
        ammoPacks: 0,
        chestsOpened: 0,
    };
}

function ensureInventory(entity) {
    if (!entity.inventory) entity.inventory = makeInventory();
    const currentWeapons = Array.isArray(entity.inventory.weapons) ? entity.inventory.weapons : [];
    const currentSlotAmmo = Array.isArray(entity.weaponSlotAmmo) ? entity.weaponSlotAmmo : [];
    const validWeapons = [];
    const validSlotAmmo = [];
    for (let index = 0; index < currentWeapons.length && validWeapons.length < SURVIV_MAX_WEAPONS; index++) {
        const weapon = currentWeapons[index];
        if (weapon === 'fists' || !WEAPONS[weapon]) continue;
        validWeapons.push(weapon);
        validSlotAmmo.push(currentSlotAmmo[index]);
    }
    entity.inventory.weapons = validWeapons;
    if (Array.isArray(entity.weaponSlotAmmo)) entity.weaponSlotAmmo = validSlotAmmo;
    entity.inventory.medkits = Math.max(0, Math.min(SURVIV_MAX_MEDKITS, Number(entity.inventory.medkits) || 0));
    entity.inventory.ammoPacks = Math.max(0, Math.min(SURVIV_MAX_AMMO_PACKS, Number(entity.inventory.ammoPacks) || 0));
    entity.inventory.chestsOpened = Number(entity.inventory.chestsOpened) || 0;
    return entity.inventory;
}

function ensureWeaponSlotAmmo(entity) {
    const inv = ensureInventory(entity);
    const existing = Array.isArray(entity.weaponSlotAmmo) ? entity.weaponSlotAmmo : [];
    entity.weaponSlotAmmo = inv.weapons.map((weaponType, index) => {
        let ammo = existing[index];
        if (!Number.isFinite(ammo)) ammo = entity.weaponsAmmo?.[weaponType];
        if (entity.activeWeaponSlot === index && entity.weapon?.type === weaponType) ammo = entity.weapon.ammo;
        return Number.isFinite(ammo) ? Math.max(0, Number(ammo)) : WEAPONS[weaponType].clipSize;
    });
    return entity.weaponSlotAmmo;
}

function syncLegacyWeaponAmmo(entity) {
    const inv = ensureInventory(entity);
    const slotAmmo = ensureWeaponSlotAmmo(entity);
    const legacy = {};
    inv.weapons.forEach((weaponType, index) => {
        if (legacy[weaponType] === undefined || entity.activeWeaponSlot === index) legacy[weaponType] = slotAmmo[index];
    });
    entity.weaponsAmmo = legacy;
    return legacy;
}

function saveActiveWeaponAmmo(entity) {
    const inv = ensureInventory(entity);
    const slotAmmo = ensureWeaponSlotAmmo(entity);
    if (!entity.weapon || entity.weapon.type === 'fists') return;
    let index = Number(entity.activeWeaponSlot);
    if (!Number.isInteger(index) || inv.weapons[index] !== entity.weapon.type) index = inv.weapons.indexOf(entity.weapon.type);
    if (index < 0) return;
    entity.activeWeaponSlot = index;
    slotAmmo[index] = Math.max(0, Number(entity.weapon.ammo) || 0);
    syncLegacyWeaponAmmo(entity);
}

function addWeaponToInventory(entity, weaponType, ammo = null) {
    const inv = ensureInventory(entity);
    if (!weaponType || !WEAPONS[weaponType] || inv.weapons.length >= SURVIV_MAX_WEAPONS) return false;
    const slotAmmo = ensureWeaponSlotAmmo(entity);
    inv.weapons.push(weaponType);
    slotAmmo.push(Number.isFinite(ammo) ? Math.max(0, Number(ammo)) : WEAPONS[weaponType].clipSize);
    syncLegacyWeaponAmmo(entity);
    return true;
}
function describeContainerItems(contents = {}) {
    const items = [];
    if (contents.weaponType && WEAPONS[contents.weaponType]) {
        items.push({
            key: 'weapon',
            kind: 'weapon',
            label: WEAPONS[contents.weaponType].label,
            weaponType: contents.weaponType,
            rarity: WEAPONS[contents.weaponType].rarity || contents.rarity || 'common',
            value: 1,
        });
    }
    if (contents.money) {
        items.push({ key: 'money', kind: 'money', label: '$' + Number(contents.money).toFixed(2), value: Number(contents.money) });
    }
    if (contents.medkits) {
        items.push({ key: 'medkits', kind: 'medkit', label: 'Medkit', value: Number(contents.medkits) });
    }
    if (contents.ammoPacks) {
        items.push({ key: 'ammoPacks', kind: 'ammo', label: 'Ammo', value: Number(contents.ammoPacks) });
    }
    if (contents.armor) {
        items.push({ key: 'armor', kind: 'armor', label: 'Armor', value: Number(contents.armor) });
    }
    return items;
}

function isContainerEmpty(contents = {}) {
    return !contents.money && !contents.weaponType && !contents.medkits && !contents.ammoPacks && !contents.armor;
}

function applyLootContents(entity, contents = {}, options = {}) {
    const inv = ensureInventory(entity);
    const summary = {
        money: 0,
        medkits: 0,
        armor: 0,
        ammoPacks: 0,
        weaponType: null,
        weaponLabel: null,
        rarity: contents.rarity || null,
    };
    if (options.countChest !== false) inv.chestsOpened += 1;
    if (contents.money) {
        summary.money = Number(contents.money || 0);
        entity.dollarBalance = (entity.dollarBalance || 0) + summary.money;
    }
    if (contents.medkits) {
        summary.medkits = Math.max(0, Math.min(Number(contents.medkits) || 0, SURVIV_MAX_MEDKITS - inv.medkits));
        inv.medkits += summary.medkits;
    }
    if (contents.armor) {
        summary.armor = Math.max(0, Math.min(Number(contents.armor) || 0, entity.maxArmor - (entity.armor || 0)));
        entity.armor = (entity.armor || 0) + summary.armor;
    }
    if (contents.ammoPacks) {
        const packs = Math.max(0, Math.min(Number(contents.ammoPacks) || 0, SURVIV_MAX_AMMO_PACKS - inv.ammoPacks));
        summary.ammoPacks = packs;
        inv.ammoPacks += packs;
    }
    if (contents.weaponType && WEAPONS[contents.weaponType]) {
        const def = WEAPONS[contents.weaponType];
        const pickupAmmo = Number.isFinite(contents.ammo) ? Math.max(0, Number(contents.ammo)) : def.clipSize;
        saveActiveWeaponAmmo(entity);
        const added = addWeaponToInventory(entity, contents.weaponType, pickupAmmo);
        if (added) {
            const newSlot = ensureInventory(entity).weapons.length - 1;
            equipSurvivWeaponSlot(entity, newSlot);
            summary.weaponType = contents.weaponType;
            summary.weaponLabel = def.label;
        }
    }
    return summary;
}

function beginInventoryMedkit(entity, now) {
    const inv = ensureInventory(entity);
    if (entity.medkitUseEndAt > now) return false;
    if (inv.medkits <= 0 || entity.hp >= entity.maxHp) return false;
    entity.medkitUseEndAt = now + SURVIV.medkitUseMs;
    return true;
}

function updateInventoryMedkit(entity, now) {
    if (!(entity.medkitUseEndAt > 0) || now < entity.medkitUseEndAt) return false;
    entity.medkitUseEndAt = 0;
    const inv = ensureInventory(entity);
    if (inv.medkits <= 0 || entity.hp >= entity.maxHp) return false;
    inv.medkits -= 1;
    entity.hp = Math.min(entity.maxHp, entity.hp + 45);
    return true;
}

function pickupGroundWeapon(entity, room) {
    if (entity.isBot || entity.isCashingOut) return false;
    const inv = ensureInventory(entity);
    const nearby = querySurvivLoot(room, entity.x, entity.y, SURVIV.lootPickupRadius + 24)
        .filter(({ item }) => item.type === 'weapon' && item.weaponType && WEAPONS[item.weaponType])
        .sort((a, b) => dist(entity.x, entity.y, a.item.x, a.item.y) - dist(entity.x, entity.y, b.item.x, b.item.y));
    const candidate = nearby[0];
    if (!candidate) return false;

    const item = candidate.item;
    const nextType = item.weaponType;
    const nextDef = WEAPONS[nextType];
    const nextAmmo = Number.isFinite(item.ammo) ? Math.max(0, Number(item.ammo)) : nextDef.clipSize;
    saveActiveWeaponAmmo(entity);
    const slotAmmo = ensureWeaponSlotAmmo(entity);
    let nextSlot;

    if (inv.weapons.length < SURVIV_MAX_WEAPONS) {
        nextSlot = inv.weapons.length;
        inv.weapons.push(nextType);
        slotAmmo.push(nextAmmo);
        removeSurvivLootAt(room, candidate.index);
    } else {
        const requestedSlot = Number.isInteger(entity.activeWeaponSlot) ? entity.activeWeaponSlot : inv.weapons.indexOf(entity.weapon?.type);
        nextSlot = requestedSlot === SURVIV_MELEE_SLOT ? 0 : requestedSlot;
        if (nextSlot < 0 || nextSlot >= inv.weapons.length) return false;
        const oldType = inv.weapons[nextSlot];
        const oldAmmo = slotAmmo[nextSlot] ?? 0;
        inv.weapons[nextSlot] = nextType;
        slotAmmo[nextSlot] = nextAmmo;
        item.weaponType = oldType;
        item.ammo = oldAmmo;
        item.tier = WEAPONS[oldType]?.rarity || 'common';
    }

    entity.activeWeaponSlot = nextSlot;
    entity.weapon = {
        type: nextType,
        ammo: nextAmmo,
        reloading: false,
        reloadEndAt: 0,
        lastShotAt: 0,
    };
    syncLegacyWeaponAmmo(entity);
    entity.lastLoot = {
        id: `ground-weapon:${entity.id}:${Date.now()}`,
        type: 'ground',
        tier: nextDef.rarity || 'common',
        source: 'ground',
        items: { weaponType: nextType, weaponLabel: nextDef.label },
        pickedAt: Date.now(),
    };
    return true;
}

export function equipSurvivWeaponSlot(entity, slot) {
    const inv = ensureInventory(entity);
    const index = Number(slot);
    if (!Number.isInteger(index)) return false;

    saveActiveWeaponAmmo(entity);
    if (index === SURVIV_MELEE_SLOT) {
        entity.activeWeaponSlot = SURVIV_MELEE_SLOT;
        entity.weapon = makeWeaponState('fists');
        syncLegacyWeaponAmmo(entity);
        return true;
    }
    if (index < 0 || index >= SURVIV_MAX_WEAPONS) return false;

    const slotAmmo = ensureWeaponSlotAmmo(entity);
    const weaponType = inv.weapons[index];
    if (!weaponType || !WEAPONS[weaponType]) return false;

    const targetAmmo = slotAmmo[index] ?? WEAPONS[weaponType].clipSize;
    entity.activeWeaponSlot = index;
    entity.weapon = {
        type: weaponType,
        ammo: targetAmmo,
        reloading: false,
        reloadEndAt: 0,
        lastShotAt: 0,
    };
    syncLegacyWeaponAmmo(entity);
    return true;
}

function removeWeaponSlot(entity, index) {
    const inv = ensureInventory(entity);
    if (!Number.isInteger(index) || index < 0 || index >= inv.weapons.length) return null;
    saveActiveWeaponAmmo(entity);
    const slotAmmo = ensureWeaponSlotAmmo(entity);
    const weaponType = inv.weapons[index];
    const ammo = slotAmmo[index] ?? 0;
    const wasActive = entity.activeWeaponSlot === index;
    inv.weapons.splice(index, 1);
    slotAmmo.splice(index, 1);

    if (wasActive) {
        if (inv.weapons.length > 0) {
            const nextIndex = Math.min(index, inv.weapons.length - 1);
            const nextType = inv.weapons[nextIndex];
            entity.activeWeaponSlot = nextIndex;
            entity.weapon = makeWeaponState(nextType);
            entity.weapon.ammo = slotAmmo[nextIndex] ?? WEAPONS[nextType].clipSize;
            syncLegacyWeaponAmmo(entity);
        } else {
            entity.activeWeaponSlot = SURVIV_MELEE_SLOT;
            entity.weapon = makeWeaponState('fists');
            syncLegacyWeaponAmmo(entity);
        }
    } else {
        if (Number.isInteger(entity.activeWeaponSlot) && entity.activeWeaponSlot !== SURVIV_MELEE_SLOT && entity.activeWeaponSlot > index) entity.activeWeaponSlot -= 1;
        syncLegacyWeaponAmmo(entity);
    }
    return { weaponType, ammo };
}
export function resetSurvivRoomRuntime(room, nextMap = generateSurvivMap(SURVIV.worldHalf)) {
    room.players = [];
    room.bots = [];
    room.bullets = [];
    room.spectators = [];
    room.deathMarkers = [];
    room.lootPoolBalance = 0;
    room.loot = [...(nextMap.loot || [])];
    room.obstacles = nextMap.obstacles || [];
    room.spawnPoints = nextMap.spawnPoints || [];
    room.landmarks = nextMap.landmarks || [];
    room._survivObstacleIndex = null;
    room._survivLootIndex = null;
    room._survivObstacleRevision = 0;
    room._survivLootRevision = 0;
    room._survivViewerPayloadCache = new Map();
    room._survivLeaderboardSignature = null;
    room._lastSurvivLbAt = 0;
    room._nextSurvivBotSyncAt = 0;
    return room;
}
export function createSurvivPlayer(socketId, mongoId, username, color, room) {
    const eco = getSurvivEconomy(room.entryFeeUsd);
    const spawn = pickSurvivSpawn(room);
    return {
        id: socketId,
        mongoId,
        username,
        mode: 'surviv',
        color: color || '#80d0d0',
        x: spawn.x,
        y: spawn.y,
        angle: 0,
        hp: 100,
        maxHp: 100,
        armor: 0,
        maxArmor: 100,
        weapon: makeWeaponState('fists'),
        dollarBalance: eco.playerStartBalance,
        entryFeeUsd: room.entryFeeUsd,
        inputDx: 0,
        inputDy: 0,
        aimAngle: 0,
        shooting: false,
        kills: 0,
        startTime: Date.now(),
        disconnected: false,
        isCashingOut: false,
        isBot: false,
        botThinkAt: 0,
        botTargetId: null,
        inventory: makeInventory(),
        activeWeaponSlot: SURVIV_MELEE_SLOT,
        weaponSlotAmmo: [],
        weaponsAmmo: {},
        useMedkit: false,
        medkitUseEndAt: 0,
        pickupWeaponPending: false,
        openChestId: null,
        lastLoot: null,
        openedContainerId: null,
        openedContainer: null,
        takeChestItem: null,
    };
}

function pickSurvivSpawn(room) {
    const spawnPoints = Array.isArray(room.spawnPoints) ? room.spawnPoints : [];
    for (let i = 0; i < 100; i++) {
        const useStructureSpawn = spawnPoints.length && Math.random() < 0.90;
        const base = useStructureSpawn
            ? spawnPoints[Math.floor(Math.random() * spawnPoints.length)]
            : randomSpawnCoord(SURVIV.worldHalf * 0.94);
        const jitter = useStructureSpawn ? 260 : 220;
        const pos = {
            x: base.x + (Math.random() - 0.5) * jitter,
            y: base.y + (Math.random() - 0.5) * jitter,
        };
        if (isSurvivSpawnPositionSafe(room, pos.x, pos.y, SURVIV.playerRadius + 10)) {
            const clear = [...room.players, ...room.bots].every(p => dist(pos.x, pos.y, p.x, p.y) > 140);
            if (clear) return pos;
        }
    }
    for (let i = 0; i < 200; i++) {
        const fallback = randomSpawnCoord(SURVIV.worldHalf * 0.9);
        if (isSurvivSpawnPositionSafe(room, fallback.x, fallback.y, SURVIV.playerRadius + 10)) {
            return fallback;
        }
    }
    return { x: 0, y: -SURVIV.worldHalf + 500 };
}

function obstacleCellKey(cx, cy) {
    return cx + ':' + cy;
}

function insertObstacleInGrid(grid, obstacle) {
    const minX = Math.floor((obstacle.x - obstacle.w / 2) / SURVIV_OBSTACLE_CELL);
    const maxX = Math.floor((obstacle.x + obstacle.w / 2) / SURVIV_OBSTACLE_CELL);
    const minY = Math.floor((obstacle.y - obstacle.h / 2) / SURVIV_OBSTACLE_CELL);
    const maxY = Math.floor((obstacle.y + obstacle.h / 2) / SURVIV_OBSTACLE_CELL);
    for (let cx = minX; cx <= maxX; cx++) {
        for (let cy = minY; cy <= maxY; cy++) {
            const key = obstacleCellKey(cx, cy);
            let bucket = grid.get(key);
            if (!bucket) {
                bucket = [];
                grid.set(key, bucket);
            }
            bucket.push(obstacle);
        }
    }
}

function buildObstacleIndex(room) {
    const all = new Map();
    const collidable = new Map();
    for (const obstacle of room.obstacles || []) {
        insertObstacleInGrid(all, obstacle);
        if (obstacle.collidable !== false) insertObstacleInGrid(collidable, obstacle);
    }
    room._survivObstacleIndex = {
        all,
        collidable,
        source: room.obstacles,
        count: room.obstacles?.length || 0,
    };
    return room._survivObstacleIndex;
}

function getObstacleIndex(room) {
    const count = room.obstacles?.length || 0;
    if (!room._survivObstacleIndex
        || room._survivObstacleIndex.source !== room.obstacles
        || room._survivObstacleIndex.count !== count) {
        return buildObstacleIndex(room);
    }
    return room._survivObstacleIndex;
}

function queryObstacles(room, x, y, range, collidableOnly = false) {
    const index = getObstacleIndex(room);
    const grid = collidableOnly ? index.collidable : index.all;
    const minX = Math.floor((x - range) / SURVIV_OBSTACLE_CELL);
    const maxX = Math.floor((x + range) / SURVIV_OBSTACLE_CELL);
    const minY = Math.floor((y - range) / SURVIV_OBSTACLE_CELL);
    const maxY = Math.floor((y + range) / SURVIV_OBSTACLE_CELL);
    const seen = new Set();
    const out = [];
    for (let cx = minX; cx <= maxX; cx++) {
        for (let cy = minY; cy <= maxY; cy++) {
            const bucket = grid.get(obstacleCellKey(cx, cy));
            if (!bucket) continue;
            for (const o of bucket) {
                if (seen.has(o.id)) continue;
                seen.add(o.id);
                if (Math.abs(o.x - x) <= range + o.w / 2
                    && Math.abs(o.y - y) <= range + o.h / 2) {
                    out.push(o);
                }
            }
        }
    }
    return out;
}

function getDestructibleObstacleHp(obstacle) {
    if (!obstacle || obstacle.collidable === false || obstacle.destructible === false) return null;
    const defaultHp = SURVIV_DESTRUCTIBLE_OBSTACLE_HP[obstacle.kind];
    const maxHp = Number.isFinite(obstacle.maxHp) ? Math.max(1, obstacle.maxHp) : defaultHp;
    if (!Number.isFinite(maxHp)) return null;
    if (!Number.isFinite(obstacle.maxHp)) obstacle.maxHp = maxHp;
    if (!Number.isFinite(obstacle.hp)) obstacle.hp = maxHp;
    obstacle.destructible = true;
    return { hp: obstacle.hp, maxHp };
}

function markSurvivObstaclesChanged(room) {
    room._survivObstacleRevision = (room._survivObstacleRevision || 0) + 1;
}

function damageSurvivObstacle(room, obstacle, damage) {
    const durability = getDestructibleObstacleHp(obstacle);
    if (!durability || !(damage > 0)) return false;
    obstacle.hp = Math.max(0, durability.hp - damage);
    markSurvivObstaclesChanged(room);
    if (obstacle.hp > 0) return false;

    const index = room.obstacles.indexOf(obstacle);
    if (index >= 0) room.obstacles.splice(index, 1);
    return index >= 0;
}

function markSurvivLootChanged(room) {
    room._survivLootRevision = (room._survivLootRevision || 0) + 1;
}

function buildSurvivLootIndex(room) {
    const loot = room.loot || [];
    const grid = new Map();
    const byId = new Map();
    for (let index = 0; index < loot.length; index++) {
        const item = loot[index];
        const key = obstacleCellKey(
            Math.floor(item.x / SURVIV_LOOT_CELL),
            Math.floor(item.y / SURVIV_LOOT_CELL),
        );
        let bucket = grid.get(key);
        if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
        }
        const entry = { item, index };
        bucket.push(entry);
        if (item.id != null) byId.set(item.id, entry);
    }
    room._survivLootIndex = {
        grid,
        byId,
        source: loot,
        count: loot.length,
        first: loot[0],
        last: loot[loot.length - 1],
        revision: room._survivLootRevision || 0,
    };
    return room._survivLootIndex;
}

function getSurvivLootIndex(room) {
    const loot = room.loot || [];
    const index = room._survivLootIndex;
    if (!index
        || index.source !== loot
        || index.count !== loot.length
        || index.first !== loot[0]
        || index.last !== loot[loot.length - 1]
        || index.revision !== (room._survivLootRevision || 0)) {
        return buildSurvivLootIndex(room);
    }
    return index;
}

function querySurvivLoot(room, x, y, range) {
    const grid = getSurvivLootIndex(room).grid;
    const minX = Math.floor((x - range) / SURVIV_LOOT_CELL);
    const maxX = Math.floor((x + range) / SURVIV_LOOT_CELL);
    const minY = Math.floor((y - range) / SURVIV_LOOT_CELL);
    const maxY = Math.floor((y + range) / SURVIV_LOOT_CELL);
    const out = [];
    for (let cx = minX; cx <= maxX; cx++) {
        for (let cy = minY; cy <= maxY; cy++) {
            const bucket = grid.get(obstacleCellKey(cx, cy));
            if (!bucket) continue;
            for (const entry of bucket) {
                const item = entry.item;
                if (Math.abs(item.x - x) <= range && Math.abs(item.y - y) <= range) {
                    out.push(entry);
                }
            }
        }
    }
    return out;
}

function addSurvivLoot(room, item) {
    room.loot.push(item);
    markSurvivLootChanged(room);
    return item;
}

function removeSurvivLootAt(room, index) {
    if (index < 0 || index >= room.loot.length) return null;
    const [removed] = room.loot.splice(index, 1);
    if (removed) markSurvivLootChanged(room);
    return removed || null;
}

function isPositionBlocked(room, x, y, r) {
    for (const o of queryObstacles(room, x, y, r + 80, true)) {
        if (circleRectCollision(x, y, r, o)) return true;
    }
    return false;
}

function isSurvivSpawnPositionSafe(room, x, y, radius) {
    if (Math.abs(x) > SURVIV.worldHalf - radius || Math.abs(y) > SURVIV.worldHalf - radius) return false;
    for (const obstacle of queryObstacles(room, x, y, radius + 90, false)) {
        const forbiddenSurface = obstacle.kind === 'houseFloor'
            || obstacle.kind === 'water'
            || obstacle.kind === 'river';
        if (!forbiddenSurface && obstacle.collidable === false) continue;
        if (circleRectCollision(x, y, radius, obstacle)) return false;
    }
    return true;
}

function getNearbyObstacles(room, x, y, range) {
    return queryObstacles(room, x, y, range, true);
}

function moveEntity(entity, room, dx, dy, speed) {
    const { dx: nx, dy: ny } = normalize(dx, dy);
    let newX = entity.x + nx * speed;
    let newY = entity.y + ny * speed;

    const r = entity.radius || SURVIV.playerRadius;
    const wh = SURVIV.worldHalf - r;
    newX = clamp(newX, -wh, wh);
    newY = clamp(newY, -wh, wh);

    for (const o of getNearbyObstacles(room, newX, newY, 220)) {
        if (circleRectCollision(newX, newY, r, o)) {
            const resolved = resolveCircleRect(newX, newY, r, o);
            newX = resolved.x;
            newY = resolved.y;
        }
    }

    entity.x = newX;
    entity.y = newY;
}

function tryShoot(entity, room, now) {
    if (entity.isCashingOut || entity.hp <= 0) return;
    const wDef = WEAPONS[entity.weapon.type] || WEAPONS.fists;
    const w = entity.weapon;

    if (wDef.melee) {
        if (now - w.lastShotAt < wDef.fireRateMs) return;
        w.lastShotAt = now;
        entity.meleeStartedAt = now;
        entity.meleeUntil = now + MELEE_ANIMATION_MS;
        entity.meleeHand = entity.meleeHand === 'top' ? 'bottom' : 'top';

        const baseAngle = entity.aimAngle ?? entity.angle ?? 0;
        const targets = [
            ...room.players.filter(p => !p._eliminated),
            ...room.bots,
        ].filter(target => target.id !== entity.id && target.hp > 0);
        let closest = null;
        let closestDistance = Infinity;
        for (const target of targets) {
            const targetDistance = dist(entity.x, entity.y, target.x, target.y);
            if (targetDistance > wDef.meleeReach + SURVIV.playerRadius) continue;
            const targetAngle = Math.atan2(target.y - entity.y, target.x - entity.x);
            const angleDelta = Math.abs(Math.atan2(Math.sin(targetAngle - baseAngle), Math.cos(targetAngle - baseAngle)));
            if (angleDelta > wDef.meleeArc) continue;
            if (targetDistance < closestDistance) {
                closest = target;
                closestDistance = targetDistance;
            }
        }
        let closestObstacle = null;
        for (const obstacle of queryObstacles(room, entity.x, entity.y, wDef.meleeReach + 120, true)) {
            if (!getDestructibleObstacleHp(obstacle)) continue;
            const halfExtent = Math.max(obstacle.w || 0, obstacle.h || 0) / 2;
            const obstacleDistance = Math.max(0, dist(entity.x, entity.y, obstacle.x, obstacle.y) - halfExtent);
            if (obstacleDistance > wDef.meleeReach) continue;
            const obstacleAngle = Math.atan2(obstacle.y - entity.y, obstacle.x - entity.x);
            const angleDelta = Math.abs(Math.atan2(Math.sin(obstacleAngle - baseAngle), Math.cos(obstacleAngle - baseAngle)));
            if (angleDelta > wDef.meleeArc) continue;
            if (obstacleDistance < closestDistance) {
                closest = null;
                closestObstacle = obstacle;
                closestDistance = obstacleDistance;
            }
        }
        if (closestObstacle) {
            damageSurvivObstacle(room, closestObstacle, wDef.damage);
        } else if (closest) {
            applyDamage(closest, wDef.damage, entity);
            if (closest.hp <= 0) eliminateSurvivPlayer(room, closest, room._io, entity);
        }
        return;
    }

    if (w.reloading) {
        if (now >= w.reloadEndAt) {
            w.reloading = false;
            w.ammo = wDef.clipSize;
        } else {
            return;
        }
    }

    if (w.ammo <= 0) {
        beginSurvivReload(entity, now);
        return;
    }

    if (now - w.lastShotAt < wDef.fireRateMs) return;

    w.lastShotAt = now;
    w.ammo -= 1;

    const baseAngle = entity.aimAngle ?? entity.angle ?? 0;
    const pellets = wDef.pellets || 1;

    for (let i = 0; i < pellets; i++) {
        const spread = (Math.random() - 0.5) * wDef.spread * 2;
        const angle = baseAngle + spread;
        room.bullets.push({
            id: randId(),
            ownerId: entity.id,
            ownerIsBot: !!entity.isBot,
            x: entity.x + Math.cos(angle) * (SURVIV.playerRadius + 4),
            y: entity.y + Math.sin(angle) * (SURVIV.playerRadius + 4),
            vx: Math.cos(angle) * wDef.bulletSpeed,
            vy: Math.sin(angle) * wDef.bulletSpeed,
            damage: wDef.damage,
            weaponType: entity.weapon?.type || 'fists',
            bornAt: now,
        });
    }
}

function applyDamage(target, damage, attacker) {
    let remaining = damage;
    if (target.armor > 0) {
        const absorbed = Math.min(target.armor, remaining * 0.7);
        target.armor -= absorbed;
        remaining -= absorbed * 0.5;
    }
    target.hp -= remaining;
    if (target.hp <= 0 && attacker && attacker.id !== target.id) {
        attacker.kills = (attacker.kills || 0) + 1;
    }
}

function dropDeathLoot(room, entity) {
    const inventory = ensureInventory(entity);
    const scatter = (index, total, radius = 36) => {
        const angle = (index / Math.max(1, total)) * Math.PI * 2 + Math.random() * 0.35;
        const distance = 16 + Math.random() * radius;
        return {
            x: entity.x + Math.cos(angle) * distance,
            y: entity.y + Math.sin(angle) * distance,
        };
    };
    const drops = [];
    const money = Math.max(0, Number(entity.dollarBalance || 0));
    if (money > 0) drops.push({ type: 'money', dollarValue: money });
    saveActiveWeaponAmmo(entity);
    const weaponSlotAmmo = ensureWeaponSlotAmmo(entity);
    inventory.weapons.forEach((weaponType, index) => {
        if (weaponType !== 'fists' && WEAPONS[weaponType]) {
            drops.push({
                type: 'weapon',
                weaponType,
                ammo: weaponSlotAmmo[index] ?? WEAPONS[weaponType].clipSize,
                tier: WEAPONS[weaponType].rarity || 'common',
            });
        }
    });
    if (inventory.medkits > 0) drops.push({ type: 'medkit', amount: inventory.medkits });
    if (inventory.ammoPacks > 0) drops.push({ type: 'ammo', amount: inventory.ammoPacks });
    if (entity.armor > 0) drops.push({ type: 'armor', armorValue: Math.round(entity.armor) });

    drops.forEach((drop, index) => {
        const pos = scatter(index, drops.length);
        addSurvivLoot(room, makeGroundLoot(drop.type, pos.x, pos.y, {
            ...drop,
            source: 'death',
            pickupAfter: Date.now() + 900,
        }));
    });

    entity.dollarBalance = 0;
    entity.armor = 0;
    inventory.weapons = [];
    entity.weaponSlotAmmo = [];
    entity.weaponsAmmo = {};
    inventory.medkits = 0;
    inventory.ammoPacks = 0;
}

export function eliminateSurvivPlayer(room, player, io, attacker = null) {
    if (player._eliminated) return;
    player._eliminated = true;
    if (!Array.isArray(room.deathMarkers)) room.deathMarkers = [];
    room.deathMarkers.push({
        id: `grave:${player.id}:${Date.now()}:${randId()}`,
        x: player.x,
        y: player.y,
        victimId: player.id,
        victimName: player.username || (player.isBot ? 'Bot' : 'Player'),
        killerId: attacker?.id || null,
        killerName: attacker?.username || null,
        weaponType: attacker?.weapon?.type || 'fists',
        createdAt: Date.now(),
    });
    dropDeathLoot(room, player);
    const socketId = player.id;
    if (!player.disconnected) {
        if (!room.spectators) room.spectators = [];
        room.spectators = room.spectators.filter(s => s.id !== socketId);
        room.spectators.push({
            id: socketId,
            mongoId: player.mongoId,
            x: player.x,
            y: player.y,
            dollarBalance: player.dollarBalance,
        });
        io.to(socketId).emit('RIP');
        io.to(socketId).emit('died', {
            killer: attacker ? {
                id: attacker.id,
                username: attacker.username || (attacker.isBot ? 'Bot' : 'Player'),
                weapon: attacker.weapon?.type || 'fists',
            } : null,
            balance: player.dollarBalance,
            kills: player.kills || 0,
        });
    }
    if (player.isBot) {
        room.bots = room.bots.filter(b => b.id !== player.id);
    } else {
        room.players = room.players.filter(p => p.id !== player.id);
    }
}

function getLootContainer(room, chestId) {
    const entry = getSurvivLootIndex(room).byId.get(chestId);
    if (!entry || room.loot[entry.index] !== entry.item) return { item: null, index: -1 };
    const { item, index } = entry;
    if (item.type !== 'chest' && item.type !== 'deathCrate') return { item: null, index: -1 };
    return { item, index };
}

function refreshOpenedContainer(entity, room) {
    if (!entity.openedContainerId) {
        entity.openedContainer = null;
        return;
    }
    const { item } = getLootContainer(room, entity.openedContainerId);
    if (!item || dist(entity.x, entity.y, item.x, item.y) > SURVIV.chestOpenRadius + 44) {
        entity.openedContainerId = null;
        entity.openedContainer = null;
        return;
    }
    entity.openedContainer = {
        id: item.id,
        type: item.type,
        tier: item.tier,
        source: item.source,
        x: item.x,
        y: item.y,
        items: describeContainerItems(item.contents || {}),
    };
}

function openLootContainer(entity, room) {
    const chestId = entity.openChestId;
    if (!chestId) return;
    entity.openChestId = null;
    const { item } = getLootContainer(room, chestId);
    if (!item) return;
    if (dist(entity.x, entity.y, item.x, item.y) > SURVIV.chestOpenRadius) return;
    if (!item._openedBy) item._openedBy = new Set();
    if (!item._openedBy.has(entity.id)) {
        ensureInventory(entity).chestsOpened += 1;
        item._openedBy.add(entity.id);
    }
    entity.openedContainerId = item.id;
    refreshOpenedContainer(entity, room);
}

function takeLootContainerItem(entity, room) {
    const request = entity.takeChestItem;
    if (!request) return;
    entity.takeChestItem = null;
    const chestId = request.chestId || entity.openedContainerId;
    const itemKey = request.itemKey;
    if (!chestId || !itemKey) return;
    const { item, index } = getLootContainer(room, chestId);
    if (!item) return;
    if (dist(entity.x, entity.y, item.x, item.y) > SURVIV.chestOpenRadius + 44) return;
    const contents = item.contents || (item.contents = {});
    let picked = null;
    if (itemKey === 'weapon' && contents.weaponType) {
        picked = { weaponType: contents.weaponType, ammo: contents.ammo, rarity: contents.rarity };
    } else if (itemKey === 'money' && contents.money) {
        picked = { money: contents.money, rarity: contents.rarity };
    } else if (itemKey === 'medkits' && contents.medkits) {
        picked = { medkits: contents.medkits, rarity: contents.rarity };
    } else if (itemKey === 'ammoPacks' && contents.ammoPacks) {
        picked = { ammoPacks: contents.ammoPacks, rarity: contents.rarity };
    } else if (itemKey === 'armor' && contents.armor) {
        picked = { armor: contents.armor, rarity: contents.rarity };
    }
    if (!picked) return;
    const summary = applyLootContents(entity, picked, { countChest: false });
    if (summary.weaponType) {
        delete contents.weaponType;
        delete contents.ammo;
    }
    if (summary.money > 0) contents.money = Math.max(0, Number(contents.money || 0) - summary.money);
    if (summary.medkits > 0) contents.medkits = Math.max(0, Number(contents.medkits || 0) - summary.medkits);
    if (summary.ammoPacks > 0) contents.ammoPacks = Math.max(0, Number(contents.ammoPacks || 0) - summary.ammoPacks);
    if (summary.armor > 0) contents.armor = Math.max(0, Number(contents.armor || 0) - summary.armor);
    for (const key of ['money', 'medkits', 'ammoPacks', 'armor']) {
        if (!(Number(contents[key]) > 0)) delete contents[key];
    }
    const accepted = !!summary.weaponType || summary.money > 0 || summary.medkits > 0 || summary.ammoPacks > 0 || summary.armor > 0;
    if (!accepted) {
        refreshOpenedContainer(entity, room);
        return;
    }
    entity.lastLoot = {
        id: item.id + ':' + itemKey + ':' + Date.now(),
        chestId: item.id,
        type: item.type,
        tier: item.tier,
        source: item.source,
        items: summary,
        openedAt: Date.now(),
    };
    if (isContainerEmpty(contents)) {
        removeSurvivLootAt(room, index);
        entity.openedContainerId = null;
        entity.openedContainer = null;
    } else {
        entity.openedContainerId = item.id;
        refreshOpenedContainer(entity, room);
    }
}

function putLootContainerItem(entity, room) {
    const request = entity.putChestItem;
    if (!request) return;
    entity.putChestItem = null;
    const chestId = request.chestId || entity.openedContainerId;
    const itemKey = request.itemKey;
    if (!chestId || !itemKey) return;
    const { item } = getLootContainer(room, chestId);
    if (!item) return;
    if (dist(entity.x, entity.y, item.x, item.y) > SURVIV.chestOpenRadius + 44) return;
    const contents = item.contents || (item.contents = {});
    const inv = ensureInventory(entity);

    if (itemKey === 'weapon') {
        const requestedSlot = Number.isInteger(request.slotIdx) ? request.slotIdx : -1;
        const fallbackType = request.weaponType || (entity.weapon?.type !== 'fists' ? entity.weapon?.type : null);
        const slotIndex = requestedSlot >= 0 ? requestedSlot : inv.weapons.indexOf(fallbackType);
        const removed = !contents.weaponType ? removeWeaponSlot(entity, slotIndex) : null;
        if (removed?.weaponType) {
            contents.weaponType = removed.weaponType;
            contents.ammo = removed.ammo;
            contents.rarity = WEAPONS[removed.weaponType]?.rarity || 'common';
        }
    } else if (itemKey === 'medkits' && inv.medkits > 0) {
        inv.medkits -= 1;
        contents.medkits = (contents.medkits || 0) + 1;
    } else if (itemKey === 'ammoPacks' && inv.ammoPacks > 0) {
        inv.ammoPacks -= 1;
        contents.ammoPacks = (contents.ammoPacks || 0) + 1;
    } else if (itemKey === 'armor' && entity.armor > 0) {
        const transfer = Math.min(35, Math.round(entity.armor));
        entity.armor = Math.max(0, entity.armor - transfer);
        contents.armor = (contents.armor || 0) + transfer;
    }

    refreshOpenedContainer(entity, room);
}

function dropPlayerItem(entity, room) {
    const request = entity.dropItemPending;
    if (!request) return;
    entity.dropItemPending = null;
    const itemKey = request.itemKey;
    const slotIdx = request.slotIdx;
    if (!itemKey) return;

    const inv = ensureInventory(entity);
    const offset = () => (Math.random() - 0.5) * 48;
    const dropX = entity.x + offset();
    const dropY = entity.y + offset();

    if (itemKey === 'weapon') {
        const idx = Number.isInteger(slotIdx) ? slotIdx : entity.activeWeaponSlot;
        const removed = removeWeaponSlot(entity, idx);
        if (removed?.weaponType) {
            addSurvivLoot(room, makeGroundLoot('weapon', dropX, dropY, {
                weaponType: removed.weaponType,
                ammo: removed.ammo,
                tier: WEAPONS[removed.weaponType]?.rarity || 'common',
                source: 'player-drop',
                pickupAfter: Date.now() + 900,
            }));
        }
    } else if (itemKey === 'medkits' && inv.medkits > 0) {
        inv.medkits -= 1;
        addSurvivLoot(room, makeGroundLoot('medkit', dropX, dropY, { amount: 1, source: 'player-drop', pickupAfter: Date.now() + 900 }));
    } else if (itemKey === 'ammoPacks' && inv.ammoPacks > 0) {
        inv.ammoPacks -= 1;
        addSurvivLoot(room, makeGroundLoot('ammo', dropX, dropY, { amount: 1, source: 'player-drop', pickupAfter: Date.now() + 900 }));
    } else if (itemKey === 'armor' && entity.armor > 0) {
        const transfer = Math.min(35, Math.round(entity.armor));
        entity.armor = Math.max(0, entity.armor - transfer);
        addSurvivLoot(room, makeGroundLoot('armor', dropX, dropY, { armorValue: transfer, source: 'player-drop', pickupAfter: Date.now() + 900 }));
    }
}

function pickupLoot(entity, room) {
    if (entity.isCashingOut) return;
    openLootContainer(entity, room);
    takeLootContainerItem(entity, room);
    putLootContainerItem(entity, room);
    dropPlayerItem(entity, room);
    refreshOpenedContainer(entity, room);

    const pickedUp = {
        money: 0,
        medkits: 0,
        armor: 0,
        ammoPacks: 0,
        weaponType: null,
        weaponLabel: null,
    };
    let pickupCount = 0;
    let pickupTier = 'common';
    const now = Date.now();
    const nearbyLoot = querySurvivLoot(room, entity.x, entity.y, SURVIV.lootPickupRadius)
        .sort((a, b) => b.index - a.index);

    for (const candidate of nearbyLoot) {
        const item = candidate.item;
        let index = candidate.index;
        if (room.loot[index] !== item) {
            index = room.loot.indexOf(item);
            if (index < 0) continue;
        }
        if (item.pickupAfter && now < item.pickupAfter) continue;
        if (dist(entity.x, entity.y, item.x, item.y) > SURVIV.lootPickupRadius) continue;

        if (item.type === 'chest' || item.type === 'deathCrate') {
            continue;
        } else {
            if (item.type === 'weapon' && !entity.isBot) continue;
            let requested = null;
            let quantityKey = null;
            if (item.type === 'money') requested = { money: Number(item.dollarValue || item.amount || 0) };
            if (item.type === 'medkit') { requested = { medkits: Math.max(1, Number(item.amount) || 1) }; quantityKey = 'medkits'; }
            if (item.type === 'armor') { requested = { armor: Math.max(1, Number(item.armorValue) || 35) }; quantityKey = 'armor'; }
            if (item.type === 'ammo') { requested = { ammoPacks: Math.max(1, Number(item.amount) || 1) }; quantityKey = 'ammoPacks'; }
            if (item.type === 'weapon' && item.weaponType && WEAPONS[item.weaponType]) requested = { weaponType: item.weaponType };
            if (!requested) continue;

            const accepted = applyLootContents(entity, requested, { countChest: false });
            const acceptedAmount = accepted.money || accepted.medkits || accepted.armor || accepted.ammoPacks || (accepted.weaponType ? 1 : 0);
            if (!(acceptedAmount > 0)) continue;
            pickedUp.money += accepted.money;
            pickedUp.medkits += accepted.medkits;
            pickedUp.armor += accepted.armor;
            pickedUp.ammoPacks += accepted.ammoPacks;
            if (accepted.weaponType) {
                pickedUp.weaponType = accepted.weaponType;
                pickedUp.weaponLabel = accepted.weaponLabel;
            }

            let remaining = 0;
            if (quantityKey) remaining = Math.max(0, Number(requested[quantityKey]) - Number(accepted[quantityKey]));
            if (remaining > 0) {
                if (item.type === 'medkit' || item.type === 'ammo') item.amount = remaining;
                if (item.type === 'armor') item.armorValue = remaining;
            } else {
                removeSurvivLootAt(room, index);
            }
            pickupCount += 1;
            pickupTier = item.tier || pickupTier;
        }
    }

    if (pickupCount > 0) {
        entity.lastLoot = {
            id: `ground:${entity.id}:${now}:${pickupCount}`,
            type: 'ground',
            tier: pickupTier,
            source: 'ground',
            items: pickedUp,
            pickedAt: now,
        };
    }
}

function updateBullets(room, now, effectiveRadius) {
    const allEntities = [...room.players, ...room.bots];
    const entitiesById = new Map(allEntities.map(entity => [entity.id, entity]));
    for (let i = room.bullets.length - 1; i >= 0; i--) {
        const bullet = room.bullets[i];
        const previousX = bullet.x;
        const previousY = bullet.y;
        bullet.x += bullet.vx;
        bullet.y += bullet.vy;

        if (now - bullet.bornAt > SURVIV.bulletLifetimeMs || Math.hypot(bullet.x, bullet.y) > SURVIV.worldHalf) {
            room.bullets.splice(i, 1);
            continue;
        }

        const midX = (previousX + bullet.x) / 2;
        const midY = (previousY + bullet.y) / 2;
        const distanceMoved = Math.hypot(bullet.vx, bullet.vy);
        const queryRange = Math.max(90, distanceMoved / 2 + 10);

        let nearestObstacle = null;
        let obstacleHitT = Infinity;
        for (const obstacle of getNearbyObstacles(room, midX, midY, queryRange)) {
            const hitT = segmentRectHitT(previousX, previousY, bullet.x, bullet.y, obstacle);
            if (hitT != null && hitT < obstacleHitT) {
                nearestObstacle = obstacle;
                obstacleHitT = hitT;
            }
        }

        let nearestEntity = null;
        let entityHitT = Infinity;
        for (const entity of allEntities) {
            if (entity.id === bullet.ownerId || entity.hp <= 0 || entity._eliminated) continue;
            const hitT = segmentCircleHitT(
                previousX,
                previousY,
                bullet.x,
                bullet.y,
                entity.x,
                entity.y,
                SURVIV.playerRadius,
            );
            if (hitT != null && hitT < entityHitT) {
                nearestEntity = entity;
                entityHitT = hitT;
            }
        }

        if (nearestObstacle && obstacleHitT <= entityHitT) {
            damageSurvivObstacle(room, nearestObstacle, bullet.damage);
            room.bullets.splice(i, 1);
            continue;
        }
        if (nearestEntity) {
            const attacker = entitiesById.get(bullet.ownerId);
            applyDamage(nearestEntity, bullet.damage, attacker);
            room.bullets.splice(i, 1);
            if (nearestEntity.hp <= 0) {
                eliminateSurvivPlayer(room, nearestEntity, room._io, attacker);
                entitiesById.delete(nearestEntity.id);
            }
        }
    }
}

function checkZoneDamage(entity, zone, now) {
    if (!zone || entity.hp <= 0) {
        entity.outsideZone = false;
        entity._lastZoneDamageAt = now;
        return;
    }

    const outside = Math.hypot(entity.x - zone.x, entity.y - zone.y) > zone.radius;
    entity.outsideZone = outside;
    const previousAt = Number(entity._lastZoneDamageAt) || now;
    entity._lastZoneDamageAt = now;
    if (!outside) return;

    const elapsedMs = clamp(now - previousAt, 0, 250);
    if (elapsedMs <= 0) return;
    entity.hp = Math.max(0, entity.hp - SURVIV.zoneDamagePerSecond * elapsedMs / 1000);
}


function randomLootSpawn(room) {
    const anchors = room.spawnPoints?.length ? room.spawnPoints : room.landmarks;
    for (let i = 0; i < 44; i++) {
        const useAnchor = anchors?.length && Math.random() < 0.58;
        const base = useAnchor
            ? anchors[Math.floor(Math.random() * anchors.length)]
            : randomSpawnCoord(SURVIV.worldHalf * 0.92);
        const spread = useAnchor ? 1200 : 180;
        const pos = {
            x: base.x + (Math.random() - 0.5) * spread,
            y: base.y + (Math.random() - 0.5) * spread,
        };
        if (!isPositionBlocked(room, pos.x, pos.y, 18)) return pos;
    }
    return randomSpawnCoord(SURVIV.worldHalf * 0.9);
}

export function spawnLootFromPool(room, poolAmount) {
    const centsTotal = Math.max(0, Math.round(Number(poolAmount || 0) * 100));
    if (centsTotal <= 0) return;

    const poolDollars = centsTotal / 100;
    room.lootPoolBalance = Number(((room.lootPoolBalance || 0) + poolDollars).toFixed(2));

    const chunks = [];
    let remainingCents = centsTotal;
    while (remainingCents > 0) {
        const maxChunk = Math.min(200, remainingCents);
        const minChunk = Math.min(maxChunk, remainingCents <= 40 ? remainingCents : 20);
        const averageTarget = remainingCents > 800 ? 120 : 75;
        const softMax = Math.max(minChunk, Math.min(maxChunk, averageTarget + Math.floor(Math.random() * 70)));
        const amountCents = remainingCents <= 200
            ? remainingCents
            : minChunk + Math.floor(Math.random() * (softMax - minChunk + 1));
        chunks.push(amountCents);
        remainingCents -= amountCents;
    }

    for (const amountCents of chunks.sort(() => Math.random() - 0.5)) {
        if (amountCents <= 0) continue;
        const pos = randomLootSpawn(room);
        addSurvivLoot(room, makeChest(pos.x, pos.y, 'common', { rarity: 'common', money: Number((amountCents / 100).toFixed(2)) }, 'join'));
    }

    room.lootPoolBalance = Math.max(0, Number((room.lootPoolBalance - poolDollars).toFixed(2)));
}

function getSurvivBotTarget(humanCount) {
    if (humanCount <= 0) return 0;
    return clamp(Math.max(SURVIV.botMinCount, humanCount * 2), SURVIV.botMinCount, SURVIV.botMaxCount);
}

function syncSurvivBots(room) {
    const now = Date.now();
    if (now < (room._nextSurvivBotSyncAt || 0)) return;
    room._nextSurvivBotSyncAt = now + 1000;

    const humanCount = room.players.filter(player => !player.disconnected && player.hp > 0).length;
    const targetCount = getSurvivBotTarget(humanCount);
    const automaticBots = room.bots.filter(bot => !bot.adminSpawned && bot.hp > 0);
    if (automaticBots.length >= targetCount) return;

    const missing = targetCount - automaticBots.length;
    const spawnCount = automaticBots.length < SURVIV.botMinCount
        ? Math.min(missing, SURVIV.botMinCount - automaticBots.length)
        : Math.min(2, missing);
    for (let i = 0; i < spawnCount; i++) {
        const spawn = pickSurvivSpawn(room);
        spawnSurvivBotNear(room, spawn.x, spawn.y, { adminSpawned: false });
    }
}

export function spawnSurvivBotNear(room, x, y, options = {}) {
    const id = 'surviv_bot_' + randId();
    const bot = {
        id,
        mongoId: null,
        username: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
        mode: 'surviv',
        color: `hsl(${Math.floor(Math.random() * 360)}, 55%, 55%)`,
        x,
        y,
        angle: Math.random() * Math.PI * 2,
        aimAngle: 0,
        hp: 100,
        maxHp: 100,
        armor: 0,
        maxArmor: 100,
        weapon: makeWeaponState('fists'),
        dollarBalance: 0,
        entryFeeUsd: room.entryFeeUsd,
        inputDx: 0,
        inputDy: 0,
        shooting: false,
        kills: 0,
        isBot: true,
        botThinkAt: 0,
        botTargetId: null,
        isCashingOut: false,
        inventory: makeInventory(),
        activeWeaponSlot: SURVIV_MELEE_SLOT,
        weaponSlotAmmo: [],
        weaponsAmmo: {},
        useMedkit: false,
        medkitUseEndAt: 0,
        pickupWeaponPending: false,
        openChestId: null,
        lastLoot: null,
        openedContainerId: null,
        openedContainer: null,
        takeChestItem: null,
        adminSpawned: options.adminSpawned !== false,
    };

    room.bots.push(bot);
    return bot;
}

function getBotLootWaypoint(bot, item, room) {
    const house = queryObstacles(room, item.x, item.y, 1, false).find(obstacle => (
        obstacle.kind === 'houseFloor' && pointInRect(item.x, item.y, obstacle)
    ));
    if (!house || pointInRect(bot.x, bot.y, house)) return item;
    const doorRange = Math.max(house.w || 0, house.h || 0) / 2 + 120;
    const door = queryObstacles(room, house.x, house.y, doorRange, false)
        .find(obstacle => obstacle.kind === 'door' && obstacle.houseId === house.id);
    return door || item;
}

function getBotLootScore(bot, item, itemDistance) {
    const inventory = ensureInventory(bot);
    const distancePenalty = itemDistance * 0.24;
    if (item.type === 'chest' || item.type === 'deathCrate') {
        const contents = item.contents || {};
        const useful = (contents.weaponType && inventory.weapons.length < SURVIV_MAX_WEAPONS)
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
            .map(b => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, ownerId: b.ownerId, weaponType: b.weaponType }));
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
