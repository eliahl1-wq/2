/**
 * Surviv — top-down battle royale shooter engine.
 * Inspired by surviv.io mechanics: loot, weapons, shrinking zone, contested economy.
 */

import { getSurvivEconomy } from './economy.js';
import { SURVIV_FIREARM_IDS, SURVIV_WEAPONS } from './surviv-weapons.js';

const TICK_RATE = 40;
const TICK_DT = 1 / TICK_RATE;
const MELEE_ANIMATION_MS = 280;
const SURVIV_MAX_WEAPONS = 2;
const SURVIV_MELEE_SLOT = SURVIV_MAX_WEAPONS;
const SURVIV_MAX_MEDKITS = 6;
const SURVIV_MAX_GRENADES = 3;

export const SURVIV_AMMO = Object.freeze({
    '9mm': { id: '9mm', label: '9mm', color: '#f5d547', max: 180, pickup: 30 },
    '12g': { id: '12g', label: '12 Gauge', color: '#f05a5a', max: 48, pickup: 8 },
    '556': { id: '556', label: '5.56mm', color: '#63d471', max: 180, pickup: 30 },
    '762': { id: '762', label: '7.62mm', color: '#5aa9f8', max: 90, pickup: 15 },
    '45acp': { id: '45acp', label: '.45 ACP', color: '#b6f06a', max: 120, pickup: 24 },
    '50ae': { id: '50ae', label: '.50 AE', color: '#6ee7f2', max: 42, pickup: 7 },
    '308': { id: '308', label: '.308 Subsonic', color: '#33434d', max: 30, pickup: 5 },
    '40mm': { id: '40mm', label: '40mm', color: '#d4a452', max: 12, pickup: 2 },
    flare: { id: 'flare', label: 'Flare', color: '#ff784f', max: 8, pickup: 1 },
    potato: { id: 'potato', label: 'Potato Ammo', color: '#b98a52', max: 90, pickup: 15 },
    heart: { id: 'heart', label: 'Heart Ammo', color: '#ef7ee8', max: 90, pickup: 15 },
    bugle: { id: 'bugle', label: 'Bugle Ammo', color: '#f6c453', max: 30, pickup: 5 },
});
const SURVIV_AMMO_TYPES = Object.keys(SURVIV_AMMO);

export const SURVIV = {
    worldHalf: 10000,
    shrinkBeforeResetMs: 3 * 60 * 1000,

    playerRadius: 14,
    playerSpeed: 5.2,
    waterMoveMultiplier: 0.68,
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
    grenadeMinRange: 70,
    grenadeMaxRange: 440,
    grenadeRadius: 145,
    grenadeDamage: 140,
    grenadeMinDamage: 10,
    grenadeFalloffExponent: 1.7,
};

const LEGACY_WEAPONS = {
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
        automatic: false,
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
        automatic: false,
    },
    pistol: {
        id: 'pistol',
        label: 'M9',
        rarity: 'common',
        damage: 12,
        fireRateMs: 120,
        clipSize: 15,
        reloadMs: 1400,
        spread: 0.06,
        bulletSpeed: 34,
        range: 2500,
        pellets: 1,
        ammoType: '9mm',
        automatic: false,
    },
    smg: {
        id: 'smg',
        label: 'MP5',
        rarity: 'common',
        damage: 7,
        fireRateMs: 90,
        clipSize: 30,
        reloadMs: 1800,
        spread: 0.14,
        bulletSpeed: 38,
        range: 2800,
        pellets: 1,
        ammoType: '9mm',
        automatic: true,
        firingMoveMultiplier: 0.78,
    },
    shotgun: {
        id: 'shotgun',
        label: 'M870',
        rarity: 'rare',
        damage: 5,
        fireRateMs: 750,
        clipSize: 6,
        reloadMs: 2200,
        spread: 0.32,
        bulletSpeed: 30,
        range: 2200,
        pellets: 5,
        ammoType: '12g',
        automatic: false,
    },
    assault: {
        id: 'assault',
        label: 'M416',
        rarity: 'rare',
        damage: 11,
        fireRateMs: 75,
        clipSize: 30,
        reloadMs: 2000,
        spread: 0.09,
        bulletSpeed: 42,
        range: 3100,
        pellets: 1,
        ammoType: '556',
        automatic: true,
        firingMoveMultiplier: 0.74,
    },
    revolver: {
        id: 'revolver',
        label: 'OT-38',
        rarity: 'common',
        damage: 18,
        fireRateMs: 520,
        clipSize: 6,
        reloadMs: 1500,
        spread: 0.035,
        bulletSpeed: 44,
        range: 3200,
        pellets: 1,
        ammoType: '762',
        automatic: false,
    },
    dmr: {
        id: 'dmr',
        label: 'M39 EMR',
        rarity: 'rare',
        damage: 24,
        fireRateMs: 360,
        clipSize: 10,
        reloadMs: 1900,
        spread: 0.025,
        bulletSpeed: 48,
        range: 3500,
        pellets: 1,
        ammoType: '762',
        automatic: false,
    },
    sniper: {
        id: 'sniper',
        label: 'Mosin-Nagant',
        rarity: 'military',
        damage: 48,
        fireRateMs: 950,
        clipSize: 5,
        reloadMs: 2400,
        spread: 0.012,
        bulletSpeed: 58,
        range: 4200,
        pellets: 1,
        ammoType: '762',
        automatic: false,
    },
    lmg: {
        id: 'lmg',
        label: 'M249',
        rarity: 'military',
        damage: 10,
        fireRateMs: 105,
        clipSize: 100,
        reloadMs: 2600,
        spread: 0.13,
        bulletSpeed: 40,
        range: 3200,
        pellets: 1,
        ammoType: '556',
        automatic: true,
        firingMoveMultiplier: 0.66,
    },
};

// Kept above as a readable historical balance reference; gameplay now uses
// the complete named catalog.
void LEGACY_WEAPONS;
export const WEAPONS = SURVIV_WEAPONS;

const BOT_NAMES = [
    'Scout', 'Raider', 'Ghost', 'Viper', 'Hawk', 'Wolf', 'Rogue', 'Blaze',
    'Nomad', 'Cipher', 'Ranger', 'Striker', 'Hunter', 'Ace', 'Reaper',
];

const WEAPON_RARITY_POOLS = {
    common: SURVIV_FIREARM_IDS.filter(id => WEAPONS[id].rarity === 'common'),
    rare: ['knife', ...SURVIV_FIREARM_IDS.filter(id => WEAPONS[id].rarity === 'rare')],
    military: SURVIV_FIREARM_IDS.filter(id => WEAPONS[id].rarity === 'military'),
};
const LOOT_WEAPON_TYPES = [...SURVIV_FIREARM_IDS];
const SURVIV_OBSTACLE_CELL = 700;
const SURVIV_LOOT_CELL = 600;
// Socket.IO is reliable and ordered, so static world data only needs a sparse
// safety refresh while stationary. Movement and obstacle revisions still send
// immediately.
const SURVIV_STATIC_PAYLOAD_INTERVAL_MS = 10000;
const SURVIV_STATIC_PAYLOAD_MOVE_THRESHOLD = 320;
const SURVIV_DESTRUCTIBLE_OBSTACLE_HP = Object.freeze({
    bush: 18,
    signpost: 26,
    furniture: 28,
    stump: 34,
    crate: 36,
    barrel: 42,
    hayBale: 48,
    fallenLog: 62,
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
    'tree', 'bush', 'rock', 'stump', 'fallenLog', 'signpost', 'hayBale',
    'crate', 'barrel', 'sandbag', 'tent', 'lampPost', 'bench', 'mailbox', 'roadMarker', 'picnicTable',
]);
function isMapPositionBlocked(obstacles, x, y, radius = 30) {
    if (isNearRoadOrRiver(x, y, radius) || isNearPlannedTrail(x, y, radius)) return true;

    for (const o of obstacles) {
        if (o.kind === 'trail_path' && Array.isArray(o.points)) {
            const clearance = (o.width || 54) / 2 + radius + 10;
            for (let i = 0; i < o.points.length - 1; i++) {
                if (distanceToSegment(x, y, o.points[i].x, o.points[i].y, o.points[i + 1].x, o.points[i + 1].y) < clearance) {
                    return true;
                }
            }
            continue;
        }
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
function randomChestContents(tier = 'common', options = {}) {
    const outdoor = options.outdoor === true;
    const contents = { rarity: tier };

    // Static map containers only provide gameplay equipment. Currency must
    // always be supplied explicitly by spawnLootFromPool (a funded join) or by
    // another player's existing balance, never generated by map RNG.

    const weaponChanceBase = tier === 'military' ? 1 : tier === 'rare' ? 0.82 : 0.48;
    const weaponChance = outdoor ? weaponChanceBase * 0.68 : weaponChanceBase;
    if (Math.random() < weaponChance) contents.weaponType = pickWeaponForTier(tier);

    const ammoType = WEAPONS[contents.weaponType]?.ammoType
        || SURVIV_AMMO_TYPES[Math.floor(Math.random() * SURVIV_AMMO_TYPES.length)];
    const ammoDefinition = SURVIV_AMMO[ammoType];
    contents.ammoType = ammoType;
    contents.ammoAmount = ammoDefinition.pickup * (tier === 'military' ? 2 : 1);
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

const CONTAINER_PROFILES = Object.freeze({
    wood_crate: { hp: 36, hitRadius: 24 },
    supply_crate: { hp: 44, hitRadius: 25 },
    ammo_crate: { hp: 32, hitRadius: 23 },
    medical_crate: { hp: 38, hitRadius: 23 },
    armory_crate: { hp: 58, hitRadius: 26 },
});

function pickContainerType(tier = 'common', options = {}) {
    if (options.containerType && CONTAINER_PROFILES[options.containerType]) return options.containerType;
    if (tier === 'military') return Math.random() < 0.72 ? 'armory_crate' : 'ammo_crate';
    if (tier === 'rare') return Math.random() < 0.28 ? 'medical_crate' : 'supply_crate';
    const roll = Math.random();
    if (roll < 0.16) return 'ammo_crate';
    if (roll < 0.27) return 'medical_crate';
    return 'wood_crate';
}

function randomContainerContents(containerType, tier, options = {}) {
    if (containerType === 'ammo_crate') {
        const ammoType = SURVIV_AMMO_TYPES[Math.floor(Math.random() * SURVIV_AMMO_TYPES.length)];
        return {
            rarity: tier,
            ammoType,
            ammoAmount: SURVIV_AMMO[ammoType].pickup * (tier === 'military' ? 3 : 2),
            ...(Math.random() < 0.62 ? { grenades: 1 } : {}),
        };
    }
    if (containerType === 'medical_crate') {
        return {
            rarity: tier,
            medkits: tier === 'military' || Math.random() < 0.45 ? 2 : 1,
            armor: tier === 'military' ? 60 : 35,
        };
    }
    const result = randomChestContents(tier, options);
    if (containerType === 'armory_crate' && !result.weaponType) {
        result.weaponType = pickWeaponForTier('military');
        result.ammoType = WEAPONS[result.weaponType]?.ammoType || result.ammoType;
        result.ammoAmount = SURVIV_AMMO[result.ammoType]?.pickup * 2 || result.ammoAmount;
    }
    return result;
}

function makeChest(x, y, tier = 'common', contents = null, source = 'map', options = {}) {
    const containerType = pickContainerType(tier, options);
    const profile = CONTAINER_PROFILES[containerType];
    const chestContents = contents || randomContainerContents(containerType, tier, options);
    return {
        id: randId(),
        type: source === 'death' ? 'deathCrate' : 'chest',
        x,
        y,
        tier,
        containerType,
        hp: profile.hp,
        maxHp: profile.hp,
        hitRadius: profile.hitRadius,
        contents: chestContents,
        source,
        houseId: options.houseId || null,
        landmarkType: options.landmarkType || null,
        room: options.room || null,
    };
}
function normalizeAmmoGroundLoot(item) {
    if (!item || item.type !== 'ammo') return item;
    const ammoType = SURVIV_AMMO[item.ammoType] ? item.ammoType : '9mm';
    const amount = Math.floor(Number(item.amount));
    item.ammoType = ammoType;
    item.amount = amount > 0 ? amount : SURVIV_AMMO[ammoType].pickup;
    return item;
}

function makeGroundLoot(type, x, y, extra = {}) {
    return normalizeAmmoGroundLoot({
        id: randId(),
        type,
        x,
        y,
        source: extra.source || 'ground',
        ...extra,
    });
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
        ...(kind === 'door' ? { isOpen: !!options.isOpen } : {}),
        points: Array.isArray(options.points) ? options.points : null,
        width: Number.isFinite(options.width) ? options.width : null,
        widths: Array.isArray(options.widths) ? options.widths : null,
        ...(Number.isFinite(maxHp) ? {
            destructible: options.destructible !== false,
            hp: Number.isFinite(options.hp) ? clamp(options.hp, 0, maxHp) : maxHp,
            maxHp,
        } : {}),
    };
    obstacles.push(obstacle);
    return obstacle;
}

const NETWORK_ROAD_BLOCKER_KINDS = new Set(['houseFloor', 'wall', 'interiorWall', 'door', 'container', 'road']);

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
        if (o.kind === 'road' && o.role === 'networkRoad') continue;
        const blockerPad = o.kind === 'road' ? -4 : pad;
        const crossMin = (horizontal ? o.y - o.h / 2 : o.x - o.w / 2) - blockerPad;
        const crossMax = (horizontal ? o.y + o.h / 2 : o.x + o.w / 2) + blockerPad;
        if (center < crossMin || center > crossMax) continue;
        cuts.push({
            min: (horizontal ? o.x - o.w / 2 : o.y - o.h / 2) - blockerPad,
            max: (horizontal ? o.x + o.w / 2 : o.y + o.h / 2) + blockerPad,
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

function addRoadJunctions(obstacles) {
    const roads = obstacles.filter(obstacle => (
        obstacle.kind === 'road'
        && obstacle.variant === 'asphalt'
        && obstacle.role === 'networkRoad'
        && (!obstacle.rotation || Math.abs(obstacle.rotation) < 0.001)
    ));
    const horizontal = roads.filter(road => road.w > road.h);
    const vertical = roads.filter(road => road.h > road.w);
    const junctions = new Map();

    for (const hRoad of horizontal) {
        const hMin = hRoad.x - hRoad.w / 2;
        const hMax = hRoad.x + hRoad.w / 2;
        for (const vRoad of vertical) {
            const vMin = vRoad.y - vRoad.h / 2;
            const vMax = vRoad.y + vRoad.h / 2;
            if (vRoad.x < hMin - 2 || vRoad.x > hMax + 2) continue;
            if (hRoad.y < vMin - 2 || hRoad.y > vMax + 2) continue;

            const key = `${Math.round(vRoad.x)},${Math.round(hRoad.y)}`;
            let junction = junctions.get(key);
            if (!junction) {
                junction = {
                    x: vRoad.x,
                    y: hRoad.y,
                    w: vRoad.w + 18,
                    h: hRoad.h + 18,
                    directions: new Set(),
                };
                junctions.set(key, junction);
            }
            const armMin = Math.max(hRoad.h, vRoad.w) * 0.65;
            if (junction.x - hMin > armMin) junction.directions.add('west');
            if (hMax - junction.x > armMin) junction.directions.add('east');
            if (junction.y - vMin > armMin) junction.directions.add('north');
            if (vMax - junction.y > armMin) junction.directions.add('south');
        }
    }

    for (const junction of junctions.values()) {
        const armCount = junction.directions.size;
        addObstacle(obstacles, 'roadJunction', junction.x, junction.y, junction.w, junction.h, {
            collidable: false,
            variant: 'asphalt',
            role: armCount >= 4 ? 'crossIntersection' : armCount === 3 ? 'tIntersection' : 'roadJoin',
            orientation: [...junction.directions].sort().join('-'),
        });
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

function compactDoorSpan(requestedSpan, variant = 'wood') {
    const industrial = ['warehouse', 'mansion', 'metal', 'ironworks'].includes(variant);
    return clamp((Number(requestedSpan) || 52) * 0.56, 42, industrial ? 62 : 54);
}

function addDoor(obstacles, houseId, x, y, w, h, variant = 'wood', side = 'south', entranceRole = 'mainEntrance') {
    const exterior = entranceRole !== 'interiorDoor';
    // Keep an exterior slab slightly proud of the wall. This leaves a readable
    // white lip beyond the roof overhang without detaching it from the opening.
    const outwardOffset = exterior ? Math.max(6, Math.min(12, Math.min(w, h) * 0.65)) : 0;
    const doorX = x + (side === 'west' ? -outwardOffset : side === 'east' ? outwardOffset : 0);
    const doorY = y + (side === 'north' ? -outwardOffset : side === 'south' ? outwardOffset : 0);
    return addObstacle(obstacles, 'door', doorX, doorY, w, h, {
        collidable: true,
        destructible: false,
        isOpen: false,
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
    const sorted = gaps
        .map(gap => ({ ...gap, size: compactDoorSpan(gap.size, opts.doorVariant || variant) }))
        .sort((a, b) => a.center - b.center);
    for (const gap of sorted) {
        const gapMin = clamp(y + gap.center - gap.size / 2, min, max);
        const gapMax = clamp(y + gap.center + gap.size / 2, min, max);
        if (gapMin - cursor > wall * 1.5) addInteriorWall(obstacles, x, (cursor + gapMin) / 2, wall, gapMin - cursor, variant, opts);
        cursor = Math.max(cursor, gapMax);
    }
    if (max - cursor > wall * 1.5) addInteriorWall(obstacles, x, (cursor + max) / 2, wall, max - cursor, variant, opts);
    if (opts.houseId) {
        for (const gap of sorted) {
            addDoor(
                obstacles,
                opts.houseId,
                x,
                y + gap.center,
                wall * 0.90,
                gap.size + 2,
                opts.doorVariant || variant,
                'east',
                'interiorDoor',
            );
        }
    }
}

function addHorizontalInteriorWallSegments(obstacles, x, y, w, wall, gaps = [], variant = 'plaster', opts = {}) {
    const min = x - w / 2;
    const max = x + w / 2;
    let cursor = min;
    const sorted = gaps
        .map(gap => ({ ...gap, size: compactDoorSpan(gap.size, opts.doorVariant || variant) }))
        .sort((a, b) => a.center - b.center);
    for (const gap of sorted) {
        const gapMin = clamp(x + gap.center - gap.size / 2, min, max);
        const gapMax = clamp(x + gap.center + gap.size / 2, min, max);
        if (gapMin - cursor > wall * 1.5) addInteriorWall(obstacles, (cursor + gapMin) / 2, y, gapMin - cursor, wall, variant, opts);
        cursor = Math.max(cursor, gapMax);
    }
    if (max - cursor > wall * 1.5) addInteriorWall(obstacles, (cursor + max) / 2, y, max - cursor, wall, variant, opts);
    if (opts.houseId) {
        for (const gap of sorted) {
            addDoor(
                obstacles,
                opts.houseId,
                x + gap.center,
                y,
                gap.size + 2,
                wall * 0.90,
                opts.doorVariant || variant,
                'south',
                'interiorDoor',
            );
        }
    }
}

function getInteriorDoorSwingRect(door) {
    const horizontal = door.w >= door.h;
    const panelLength = Math.max(door.w, door.h) + 8;
    // Doors can open in either direction depending on which side the player
    // uses. Reserve the complete quarter-circle sweep on both sides.
    return {
        x: door.x,
        y: door.y,
        w: horizontal ? panelLength + 12 : panelLength * 2 + 12,
        h: horizontal ? panelLength * 2 + 12 : panelLength + 12,
    };
}

const BREAKABLE_INTERIOR_VARIANTS = new Set([
    'coffeeTable', 'nightstand', 'dresser', 'armchair', 'floorLamp', 'housePlant',
    'diningTable', 'desk', 'bookshelf', 'displayShelf', 'palletStack', 'toolCabinet',
    'labBench', 'specimenTank', 'serverRack', 'generator', 'weaponRack', 'mapTable',
]);

function resolveHouseInteriorTheme(variant, options = {}) {
    const landmarkType = options.landmarkType || '';
    const role = options.role || '';
    if (landmarkType === 'lab' || role === 'laboratory') return 'lab';
    if (landmarkType === 'hospital' || role === 'clinic') return 'medical';
    if (['military', 'bunker', 'prison'].includes(landmarkType)
        || ['armory', 'barracks', 'guardhouse'].includes(role)) return 'military';
    if (['farm', 'orchard'].includes(landmarkType)
        || ['barn', 'farmhouse', 'greenhouse', 'shed', 'ciderBarn', 'packingShed'].includes(role)) return 'farm';
    if (['warehouse', 'metal', 'ironworks'].includes(variant)
        || ['garage', 'utility', 'workshop', 'sawmill', 'engineShop', 'freightHall'].includes(role)) return 'industrial';
    if (options.layout === 'shop' || ['store', 'harborShop', 'repairShop', 'postOffice'].includes(role)) return 'commercial';
    return 'home';
}

function furnishHouseInterior(obstacles, house, options = {}) {
    const houseId = house.id;
    const theme = options.theme || 'home';
    const lab = theme === 'lab';
    const military = theme === 'military';
    const farm = theme === 'farm';
    const industrial = theme === 'industrial' || lab || military
        || ['warehouse', 'metal', 'ironworks'].includes(house.variant);
    const medical = theme === 'medical';
    const rooms = obstacles.filter(obstacle => obstacle.kind === 'roomZone' && obstacle.houseId === houseId);
    if (!rooms.length) {
        rooms.push({
            id: `${houseId}-open-room`,
            kind: 'roomZone',
            x: house.x,
            y: house.y,
            w: house.w - 34,
            h: house.h - 34,
            variant: industrial ? 'workshop' : 'studio',
            houseId,
        });
    }

    const doorClearances = obstacles
        .filter(obstacle => obstacle.kind === 'door' && obstacle.houseId === houseId)
        .map(getInteriorDoorSwingRect);
    const walls = obstacles.filter(obstacle => obstacle.kind === 'interiorWall' && obstacle.houseId === houseId);
    const occupied = obstacles.filter(obstacle => (
        obstacle.houseId === houseId
        && ['furniture', 'machine', 'container', 'crate', 'barrel'].includes(obstacle.kind)
    ));
    let placedCount = 0;

    const place = (room, spec) => {
        const width = Math.min(spec.w, Math.max(18, room.w - 24));
        const height = Math.min(spec.h, Math.max(18, room.h - 24));
        const x = room.x + room.w * spec.x;
        const y = room.y + room.h * spec.y;
        const margin = spec.margin ?? 9;
        if (Math.abs(x - room.x) + width / 2 > room.w / 2 - margin) return null;
        if (Math.abs(y - room.y) + height / 2 > room.h / 2 - margin) return null;
        if (Math.abs(x - house.x) + width / 2 > house.w / 2 - 18) return null;
        if (Math.abs(y - house.y) + height / 2 > house.h / 2 - 18) return null;
        if (doorClearances.some(clearance => rectsOverlap(
            x, y, width + 8, height + 8,
            clearance.x, clearance.y, clearance.w, clearance.h,
        ))) return null;
        if (walls.some(wall => rectsOverlap(
            x, y, width + 12, height + 12,
            wall.x, wall.y, wall.w, wall.h,
        ))) return null;
        if (occupied.some(prop => rectsOverlap(
            x, y, width + 12, height + 12,
            prop.x, prop.y, prop.w, prop.h,
        ))) return null;

        const furniture = addObstacle(obstacles, 'furniture', x, y, width, height, {
            // Furniture represents raised physical props. Keep it solid by
            // default; only explicit floor-level decorations may opt out.
            collidable: spec.collidable !== false,
            // Fixed interior fixtures should not disappear after one stray hit.
            // Individual lightweight props can opt in when they get a proper
            // break presentation of their own.
            destructible: spec.destructible ?? BREAKABLE_INTERIOR_VARIANTS.has(spec.variant),
            maxHp: spec.maxHp,
            variant: spec.variant,
            role: spec.role || room.variant,
            houseId,
            roomId: room.id,
            landmarkType: house.landmarkType,
            rotation: spec.rotation || 0,
        });
        occupied.push(furniture);
        placedCount++;
        return furniture;
    };

    const horizontalPlan = (room, horizontalSpecs, verticalSpecs) => {
        for (const spec of room.w >= room.h ? horizontalSpecs : verticalSpecs) place(room, spec);
    };

    for (const room of rooms) {
        const roomType = room.variant || 'room';
        if (roomType === 'hallway') continue;

        if (lab) {
            if (['control-room', 'study', 'living-room'].includes(roomType)) {
                horizontalPlan(room, [
                    { variant: 'controlConsole', x: 0.20, y: -0.24, w: 104, h: 34 },
                    { variant: 'serverRack', x: -0.32, y: 0.12, w: 34, h: 82, maxHp: 42 },
                    { variant: 'specimenTank', x: 0.22, y: 0.24, w: 54, h: 54, maxHp: 48 },
                ], [
                    { variant: 'controlConsole', x: -0.24, y: 0.20, w: 34, h: 104 },
                    { variant: 'serverRack', x: 0.12, y: -0.32, w: 82, h: 34, maxHp: 42 },
                    { variant: 'specimenTank', x: 0.24, y: 0.22, w: 54, h: 54, maxHp: 48 },
                ]);
            } else {
                horizontalPlan(room, [
                    { variant: 'labBench', x: -0.12, y: -0.24, w: 112, h: 34, maxHp: 38 },
                    { variant: 'specimenTank', x: 0.29, y: 0.21, w: 56, h: 56, maxHp: 48 },
                    { variant: 'medicalCabinet', x: -0.31, y: 0.20, w: 32, h: 68 },
                ], [
                    { variant: 'labBench', x: -0.24, y: -0.12, w: 34, h: 112, maxHp: 38 },
                    { variant: 'specimenTank', x: 0.21, y: 0.29, w: 56, h: 56, maxHp: 48 },
                    { variant: 'medicalCabinet', x: 0.20, y: -0.31, w: 68, h: 32 },
                ]);
            }
            continue;
        }

        if (military) {
            horizontalPlan(room, [
                { variant: roomType === 'bedroom' ? 'locker' : 'weaponRack', x: -0.28, y: -0.29, w: 86, h: 30, maxHp: 44 },
                { variant: roomType === 'control-room' || roomType === 'study' ? 'mapTable' : 'storageShelf', x: 0.20, y: 0.21, w: 86, h: 50, maxHp: 38 },
                { variant: 'ammoLocker', x: 0.31, y: -0.18, w: 30, h: 64 },
            ], [
                { variant: roomType === 'bedroom' ? 'locker' : 'weaponRack', x: -0.29, y: -0.28, w: 30, h: 86, maxHp: 44 },
                { variant: roomType === 'control-room' || roomType === 'study' ? 'mapTable' : 'storageShelf', x: 0.21, y: 0.20, w: 50, h: 86, maxHp: 38 },
                { variant: 'ammoLocker', x: -0.18, y: 0.31, w: 64, h: 30 },
            ]);
            continue;
        }

        if (medical && ['north-room', 'south-room'].includes(roomType)) {
            const outerSide = room.x < house.x ? -1 : 1;
            place(room, { variant: 'hospitalBed', x: outerSide * 0.28, y: -0.25, w: 54, h: 98, role: 'patient-bed' });
            place(room, { variant: 'hospitalBed', x: outerSide * 0.28, y: 0.25, w: 54, h: 98, role: 'patient-bed' });
            place(room, { variant: 'medicalCabinet', x: -outerSide * 0.28, y: roomType === 'north-room' ? -0.32 : 0.32, w: 34, h: 62 });
            continue;
        }

        if (industrial && ['living-room', 'kitchen'].includes(roomType)) {
            horizontalPlan(room, [
                { variant: 'workbench', x: 0.24, y: -0.26, w: 96, h: 32 },
                { variant: 'toolCabinet', x: -0.32, y: 0.16, w: 28, h: 58 },
                { variant: 'generator', x: 0.22, y: 0.25, w: 62, h: 48, maxHp: 54 },
            ], [
                { variant: 'workbench', x: -0.26, y: 0.24, w: 32, h: 96 },
                { variant: 'toolCabinet', x: 0.16, y: -0.32, w: 58, h: 28 },
                { variant: 'generator', x: 0.25, y: 0.22, w: 48, h: 62, maxHp: 54 },
            ]);
            continue;
        }
        if (industrial && ['bedroom', 'study'].includes(roomType)) {
            horizontalPlan(room, [
                { variant: 'storageShelf', x: 0.25, y: -0.25, w: 82, h: 30 },
                { variant: 'locker', x: -0.31, y: 0.12, w: 28, h: 60 },
            ], [
                { variant: 'storageShelf', x: -0.25, y: 0.25, w: 30, h: 82 },
                { variant: 'locker', x: 0.12, y: -0.31, w: 60, h: 28 },
            ]);
            continue;
        }

        if (roomType === 'living-room') {
            horizontalPlan(room, [
                { variant: 'sofa', x: 0.23, y: -0.25, w: 96, h: 38 },
                { variant: 'coffeeTable', x: 0.16, y: 0.16, w: 58, h: 30 },
                { variant: 'armchair', x: -0.31, y: 0.19, w: 40, h: 40 },
                { variant: 'floorLamp', x: -0.32, y: -0.29, w: 28, h: 28, maxHp: 18 },
            ], [
                { variant: 'sofa', x: -0.25, y: 0.23, w: 38, h: 96 },
                { variant: 'coffeeTable', x: 0.16, y: 0.16, w: 30, h: 58 },
                { variant: 'armchair', x: 0.19, y: -0.31, w: 40, h: 40 },
                { variant: 'floorLamp', x: -0.29, y: -0.32, w: 28, h: 28, maxHp: 18 },
            ]);
        } else if (roomType === 'bedroom') {
            horizontalPlan(room, [
                { variant: 'bed', x: 0.29, y: 0.02, w: 54, h: 82 },
                { variant: 'dresser', x: -0.28, y: -0.29, w: 72, h: 28 },
                { variant: 'nightstand', x: 0.02, y: -0.29, w: 28, h: 28 },
                { variant: 'housePlant', x: -0.30, y: 0.27, w: 30, h: 30, maxHp: 18 },
            ], [
                { variant: 'bed', x: 0.02, y: 0.29, w: 82, h: 54 },
                { variant: 'dresser', x: -0.29, y: -0.28, w: 28, h: 72 },
                { variant: 'nightstand', x: -0.29, y: 0.02, w: 28, h: 28 },
                { variant: 'housePlant', x: 0.27, y: -0.30, w: 30, h: 30, maxHp: 18 },
            ]);
        } else if (roomType === 'kitchen') {
            horizontalPlan(room, [
                { variant: 'kitchenCounter', x: 0.17, y: -0.31, w: 118, h: 34 },
                { variant: 'diningTable', x: 0.25, y: 0.25, w: 72, h: 50 },
            ], [
                { variant: 'kitchenCounter', x: -0.31, y: 0.17, w: 34, h: 118 },
                { variant: 'diningTable', x: 0.25, y: 0.25, w: 50, h: 72 },
            ]);
        } else if (roomType === 'study') {
            horizontalPlan(room, [
                { variant: 'desk', x: -0.25, y: -0.25, w: 72, h: 38 },
                { variant: 'bookshelf', x: 0.30, y: 0.10, w: 30, h: 96 },
                { variant: 'armchair', x: -0.12, y: 0.25, w: 40, h: 40 },
            ], [
                { variant: 'desk', x: -0.25, y: -0.25, w: 38, h: 72 },
                { variant: 'bookshelf', x: 0.10, y: 0.30, w: 96, h: 30 },
                { variant: 'armchair', x: 0.25, y: -0.12, w: 40, h: 40 },
            ]);
        } else if (roomType === 'shop-front') {
            horizontalPlan(room, [
                { variant: 'salesCounter', x: 0.24, y: -0.26, w: 112, h: 38 },
                { variant: 'displayShelf', x: -0.32, y: 0.03, w: 34, h: 104 },
            ], [
                { variant: 'salesCounter', x: -0.26, y: 0.24, w: 38, h: 112 },
                { variant: 'displayShelf', x: 0.03, y: -0.32, w: 104, h: 34 },
            ]);
        } else if (roomType === 'stockroom' || roomType === 'storage') {
            horizontalPlan(room, [
                { variant: 'storageShelf', x: -0.27, y: -0.24, w: 92, h: 34 },
                { variant: 'storageShelf', x: 0.27, y: 0.24, w: 92, h: 34 },
                { variant: 'locker', x: 0.30, y: -0.26, w: 64, h: 30 },
            ], [
                { variant: 'storageShelf', x: -0.24, y: -0.27, w: 34, h: 92 },
                { variant: 'storageShelf', x: 0.24, y: 0.27, w: 34, h: 92 },
                { variant: 'locker', x: -0.26, y: 0.30, w: 30, h: 64 },
            ]);
        } else if (roomType === 'workshop' || (roomType === 'studio' && industrial)) {
            horizontalPlan(room, [
                { variant: 'workbench', x: -0.20, y: -0.31, w: 126, h: 42 },
                { variant: 'toolCabinet', x: 0.31, y: -0.12, w: 36, h: 92 },
                { variant: 'storageShelf', x: 0.12, y: 0.31, w: 96, h: 34 },
                { variant: 'generator', x: -0.28, y: 0.24, w: 64, h: 48, maxHp: 54 },
            ], [
                { variant: 'workbench', x: -0.31, y: -0.20, w: 42, h: 126 },
                { variant: 'toolCabinet', x: -0.12, y: 0.31, w: 92, h: 36 },
                { variant: 'storageShelf', x: 0.31, y: 0.12, w: 34, h: 96 },
                { variant: 'generator', x: 0.24, y: -0.28, w: 48, h: 64, maxHp: 54 },
            ]);
        } else if (roomType === 'control-room') {
            horizontalPlan(room, [
                { variant: 'controlConsole', x: 0.20, y: -0.28, w: 120, h: 40 },
                { variant: 'desk', x: 0.05, y: 0.22, w: 72, h: 40 },
                { variant: 'locker', x: 0.31, y: 0.22, w: 34, h: 72 },
            ], [
                { variant: 'controlConsole', x: -0.28, y: 0.20, w: 40, h: 120 },
                { variant: 'desk', x: 0.22, y: 0.05, w: 40, h: 72 },
                { variant: 'locker', x: 0.22, y: 0.31, w: 72, h: 34 },
            ]);
        } else if (roomType === 'loading-bay') {
            place(room, { variant: 'palletStack', x: 0.23, y: 0.23, w: 104, h: 76 });
            place(room, { variant: 'locker', x: -0.31, y: -0.21, w: 34, h: 80 });
        } else if (roomType === 'studio') {
            const entrance = obstacles.find(obstacle => (
                obstacle.kind === 'door'
                && obstacle.houseId === houseId
                && obstacle.entranceRole !== 'interiorDoor'
            ));
            const side = entrance?.role || house.orientation || 'south';
            if (side === 'north' || side === 'south') {
                const back = side === 'south' ? -0.35 : 0.35;
                place(room, { variant: 'sofa', x: -0.20, y: back, w: 76, h: 32, margin: 6 });
                place(room, { variant: 'kitchenCounter', x: 0.28, y: back, w: 54, h: 28, margin: 6 });
                place(room, { variant: 'coffeeTable', x: -0.20, y: back * 0.28, w: 48, h: 26 });
                place(room, { variant: 'bed', x: 0.30, y: back * 0.20, w: 44, h: 68 });
                place(room, { variant: farm ? 'toolCabinet' : 'housePlant', x: -0.34, y: -back * 0.22, w: 28, h: 28, maxHp: 18 });
            } else {
                const back = side === 'east' ? -0.35 : 0.35;
                place(room, { variant: 'sofa', x: back, y: -0.20, w: 32, h: 76, margin: 6 });
                place(room, { variant: 'kitchenCounter', x: back, y: 0.28, w: 28, h: 54, margin: 6 });
                place(room, { variant: 'coffeeTable', x: back * 0.28, y: -0.20, w: 26, h: 48 });
                place(room, { variant: 'bed', x: back * 0.20, y: 0.30, w: 68, h: 44 });
                place(room, { variant: farm ? 'toolCabinet' : 'housePlant', x: -back * 0.22, y: -0.34, w: 28, h: 28, maxHp: 18 });
            }
        }
    }

    const placedVariants = () => new Set(occupied.map(prop => prop.variant));
    const ensureSignatureProp = (variant, horizontalSize, verticalSize) => {
        if (placedVariants().has(variant)) return;
        const candidates = rooms.filter(room => room.variant !== 'hallway');
        for (const room of candidates) {
            const horizontal = room.w >= room.h;
            const size = horizontal ? horizontalSize : verticalSize;
            const positions = horizontal
                ? [[0, -0.28], [0, 0.28], [-0.27, 0], [0.27, 0]]
                : [[-0.28, 0], [0.28, 0], [0, -0.27], [0, 0.27]];
            for (const [x, y] of positions) {
                if (place(room, {
                    variant,
                    x,
                    y,
                    w: size[0],
                    h: size[1],
                    margin: 5,
                    maxHp: variant === 'specimenTank' ? 48 : 40,
                })) return;
            }
        }
    };

    // Signature fixtures make buildings recognizable at a glance even when a
    // compact procedural room rejected one of the preferred full-size props.
    if (lab) {
        if (house.w >= 560) ensureSignatureProp('labBench', [84, 28], [28, 84]);
        else if (house.w >= 390) ensureSignatureProp('serverRack', [62, 28], [28, 62]);
        else ensureSignatureProp('specimenTank', [44, 44], [44, 44]);
    } else if (military) {
        if (house.role === 'armory' || house.role === 'barracks') {
            ensureSignatureProp('weaponRack', [76, 28], [28, 76]);
        } else {
            ensureSignatureProp('mapTable', [68, 42], [42, 68]);
        }
    } else if (industrial && house.w >= 300) {
        ensureSignatureProp('generator', [56, 38], [38, 56]);
    }

    // Very small cabins can have a door sweep covering most of the central
    // floor. They still receive a compact wall-side piece in the safest corner.
    if (placedCount === 0) {
        const fallbackVariant = industrial ? 'toolCabinet' : medical ? 'medicalCabinet' : 'dresser';
        const candidates = rooms.filter(room => room.variant !== 'hallway');
        for (const room of candidates) {
            const corners = room.w >= room.h
                ? [[-0.36, 0], [0.36, 0], [-0.34, -0.22], [0.34, 0.22]]
                : [[0, -0.36], [0, 0.36], [-0.22, -0.34], [0.22, 0.34]];
            for (const [x, y] of corners) {
                if (place(room, { variant: fallbackVariant, x, y, w: 32, h: 26, margin: 5 })) return;
            }
        }

        // A final compact grid handles unusually narrow procedural room shapes.
        // It still uses the same wall and full door-swing validation.
        const wholeFloor = {
            id: `${houseId}-fallback-room`,
            x: house.x,
            y: house.y,
            w: house.w - 34,
            h: house.h - 34,
            variant: 'wall-storage',
        };
        const edgePositions = [
            [-0.38, -0.32], [0.38, -0.32], [-0.38, 0.32], [0.38, 0.32],
            [-0.38, 0], [0.38, 0], [0, -0.38], [0, 0.38],
            [-0.24, -0.30], [0.24, -0.30], [-0.24, 0.30], [0.24, 0.30],
        ];
        for (const [x, y] of edgePositions) {
            if (place(wholeFloor, { variant: fallbackVariant, x, y, w: 26, h: 22, margin: 4 })) return;
        }
    }
}

function addHouse(obstacles, loot, spawnPoints, x, y, w, h, opts = {}) {
    const wall = opts.wall || 14;
    const hue = opts.hue ?? 22;
    const variant = opts.variant || 'house';
    const doorSide = ['north', 'south', 'east', 'west'].includes(opts.doorSide) ? opts.doorSide : 'south';
    const horizontalDoor = doorSide === 'north' || doorSide === 'south';
    const doorSpan = compactDoorSpan((horizontalDoor ? w : h) * 0.32, variant);
    const doorW = horizontalDoor ? doorSpan + 2 : wall * 0.90;
    const doorH = horizontalDoor ? wall * 0.90 : doorSpan + 2;
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

    const layout = opts.layout || 'auto';
    const large = layout === 'corridor' || (layout === 'auto' && (w >= 430 || h >= 330 || variant === 'mansion'));
    const compactSplit = layout === 'auto' && !large && w >= 230 && h >= 190;
    if (layout === 'shop') {
        // Road-facing shops keep a large readable public room with a smaller
        // stock room at the back. The centered opening prevents dead-end loot.
        if (horizontalDoor) {
            const entryDirection = doorSide === 'south' ? 1 : -1;
            const dividerY = y - entryDirection * h * 0.18;
            addRoomZone(obstacles, houseId, x, y + entryDirection * h * 0.18, w - wall * 3, h * 0.48, 'shop-front');
            addRoomZone(obstacles, houseId, x, y - entryDirection * h * 0.34, w - wall * 3, h * 0.22, 'stockroom');
            addHorizontalInteriorWallSegments(obstacles, x, dividerY, w - wall * 2, wall, [
                { center: 0, size: clamp(w * 0.24, 72, 104) },
            ], variant, { houseId });
        } else {
            const entryDirection = doorSide === 'east' ? 1 : -1;
            const dividerX = x - entryDirection * w * 0.18;
            addRoomZone(obstacles, houseId, x + entryDirection * w * 0.18, y, w * 0.48, h - wall * 3, 'shop-front');
            addRoomZone(obstacles, houseId, x - entryDirection * w * 0.34, y, w * 0.22, h - wall * 3, 'stockroom');
            addVerticalInteriorWallSegments(obstacles, dividerX, y, h - wall * 2, wall, [
                { center: 0, size: clamp(h * 0.24, 72, 104) },
            ], variant, { houseId });
        }
    } else if (layout === 'split' || compactSplit) {
        // A real front-room/back-room plan follows the entrance. This keeps the
        // outside door out of a divider wall and gives the inner door a clear job.
        if (horizontalDoor) {
            const frontDirection = doorSide === 'south' ? 1 : -1;
            const dividerY = y - frontDirection * h * 0.04;
            addRoomZone(obstacles, houseId, x, y + frontDirection * h * 0.24, w - wall * 3, h * 0.40, 'living-room');
            addRoomZone(obstacles, houseId, x, y - frontDirection * h * 0.26, w - wall * 3, h * 0.42, 'bedroom');
            addHorizontalInteriorWallSegments(obstacles, x, dividerY, w - wall * 2, wall, [
                { center: -w * 0.18, size: clamp(w * 0.25, 66, 84) },
            ], variant, { houseId, doorVariant: variant });
        } else {
            const frontDirection = doorSide === 'east' ? 1 : -1;
            const dividerX = x - frontDirection * w * 0.04;
            addRoomZone(obstacles, houseId, x + frontDirection * w * 0.24, y, w * 0.40, h - wall * 3, 'living-room');
            addRoomZone(obstacles, houseId, x - frontDirection * w * 0.26, y, w * 0.42, h - wall * 3, 'bedroom');
            addVerticalInteriorWallSegments(obstacles, dividerX, y, h - wall * 2, wall, [
                { center: -h * 0.18, size: clamp(h * 0.25, 66, 84) },
            ], variant, { houseId, doorVariant: variant });
        }
    } else if (large) {
        if (horizontalDoor) {
            const hallW = clamp(w * 0.22, 98, 170);
            const wingW = (w - hallW - wall * 4) / 2;
            addRoomZone(obstacles, houseId, x, y, hallW, h - wall * 3.5, 'hallway');
            for (const side of [-1, 1]) {
                const roomX = x + side * (hallW / 2 + wingW / 2 + wall);
                addRoomZone(obstacles, houseId, roomX, y - h * 0.22, wingW, h * 0.40, side < 0 ? 'bedroom' : 'kitchen');
                addRoomZone(obstacles, houseId, roomX, y + h * 0.23, wingW, h * 0.40, side < 0 ? 'study' : 'living-room');
                addVerticalInteriorWallSegments(obstacles, x + side * hallW / 2, y, h - wall * 4, wall, [
                    { center: -h * 0.22, size: 76 },
                    { center: h * 0.23, size: 76 },
                ], variant, { houseId, doorVariant: variant });
                addHorizontalInteriorWallSegments(obstacles, roomX, y + h * 0.005, wingW, wall, [], variant);
            }
        } else {
            const hallH = clamp(h * 0.22, 98, 170);
            const wingH = (h - hallH - wall * 4) / 2;
            addRoomZone(obstacles, houseId, x, y, w - wall * 3.5, hallH, 'hallway');
            for (const side of [-1, 1]) {
                const roomY = y + side * (hallH / 2 + wingH / 2 + wall);
                addRoomZone(obstacles, houseId, x - w * 0.22, roomY, w * 0.40, wingH, side < 0 ? 'bedroom' : 'study');
                addRoomZone(obstacles, houseId, x + w * 0.23, roomY, w * 0.40, wingH, side < 0 ? 'kitchen' : 'living-room');
                addHorizontalInteriorWallSegments(obstacles, x, y + side * hallH / 2, w - wall * 4, wall, [
                    { center: -w * 0.22, size: 76 },
                    { center: w * 0.23, size: 76 },
                ], variant, { houseId, doorVariant: variant });
                addVerticalInteriorWallSegments(obstacles, x + w * 0.005, roomY, wingH, wall, [], variant);
            }
        }
    }

    furnishHouseInterior(obstacles, floor, {
        theme: resolveHouseInteriorTheme(variant, opts),
    });

    const chestTier = opts.tier || (Math.random() > 0.78 ? 'rare' : 'common');
    const primaryChestChance = large ? 0.84 : layout === 'shop' ? 0.7 : (layout === 'split' || compactSplit) ? 0.62 : 0.46;
    if (Math.random() < primaryChestChance) {
        loot.push(makeChest(x + w * 0.24, y - h * 0.22, chestTier, null, 'map', {
            houseId,
            landmarkType: opts.landmarkType || null,
            room: large ? 'north-room' : layout === 'shop' ? 'stockroom' : (layout === 'split' || compactSplit) ? 'bedroom' : null,
        }));
    }
    if (large && Math.random() < 0.24) {
        loot.push(makeChest(x - w * 0.28, y + h * 0.18, chestTier === 'common' ? 'rare' : chestTier, null, 'map', {
            houseId, landmarkType: opts.landmarkType || null, room: 'south-room',
        }));
    }
    const spawnOffset = 70;
    if (doorSide === 'north') spawnPoints.push({ x: doorX, y: y - h / 2 - spawnOffset });
    else if (doorSide === 'south') spawnPoints.push({ x: doorX, y: y + h / 2 + spawnOffset });
    else if (doorSide === 'west') spawnPoints.push({ x: x - w / 2 - spawnOffset, y: doorY });
    else spawnPoints.push({ x: x + w / 2 + spawnOffset, y: doorY });
    return floor;
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
    loot.push(makeGroundLoot('weapon', x, y - 50, { weaponType: 'm416', source: 'estate-loot' }));
    loot.push(makeGroundLoot('ammo', x - 40, y - 50, { source: 'estate-loot' }));
    loot.push(makeGroundLoot('ammo', x + 40, y - 50, { source: 'estate-loot' }));
    loot.push(makeGroundLoot('medkit', x, y + 100, { source: 'estate-loot' }));
    loot.push(makeGroundLoot('weapon', x - 560, y + 240, { weaponType: 'm870', source: 'estate-loot' })); // inside guesthouse
    loot.push(makeGroundLoot('weapon', x + 570, y + 250, { weaponType: 'm249', source: 'estate-loot' })); // inside garage
    
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

    const ironworksDoorSpan = compactDoorSpan(170, 'metal');
    addHorizontalWallWithOpening(obstacles, x, northY, w, wall, 'metal', x - 430, ironworksDoorSpan, ironworksMeta);
    addHorizontalWallWithOpening(obstacles, x, southY, w, wall, 'metal', x + 430, ironworksDoorSpan, ironworksMeta);
    addVerticalWallWithOpening(obstacles, westX, y, h, wall, 'metal', y + 280, ironworksDoorSpan, ironworksMeta);
    addVerticalWallWithOpening(obstacles, eastX, y, h, wall, 'metal', y, ironworksDoorSpan, ironworksMeta);

    addDoor(obstacles, houseId, x - 430, northY, ironworksDoorSpan + 2, wall * 0.90, 'metal', 'north', 'serviceEntrance');
    addDoor(obstacles, houseId, x + 430, southY, ironworksDoorSpan + 2, wall * 0.90, 'metal', 'south', 'serviceEntrance');
    addDoor(obstacles, houseId, westX, y + 280, wall * 0.90, ironworksDoorSpan + 2, 'metal', 'west', 'loadingEntrance');
    addDoor(obstacles, houseId, eastX, y, wall * 0.90, ironworksDoorSpan + 2, 'metal', 'east', 'mainEntrance');

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

    // The shared interior planner keeps every factory doorway and circulation
    // loop clear while giving each side room a distinct purpose.
    furnishHouseInterior(obstacles, floor, { theme: 'industrial' });

    // Loading-bay containers stay against the exterior wall instead of blocking
    // room connections.
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
    addObstacle(obstacles, 'road', x, y, roadLength, 120, {
        collidable: false, variant: 'cobblestone', role: 'townMainStreet', landmarkType: 'town',
    });
    addObstacle(obstacles, 'field', x, y, roadLength + 100, 680, { collidable: false, variant: 'town' });

    const housesNorth = Math.ceil(size / 2);
    const housesSouth = Math.floor(size / 2);
    
    const spacingN = roadLength / (housesNorth + 1);
    for (let i = 0; i < housesNorth; i++) {
        const hx = x - roadLength / 2 + spacingN * (i + 1);
        const hy = y - 210;
        const civic = i === Math.floor(housesNorth / 2);
        const w = civic ? 300 : 190 + Math.random() * 40;
        const h = civic ? 210 : 170 + Math.random() * 30;
        addHouse(obstacles, loot, spawnPoints, hx, hy, w, h, {
            hue: civic ? 34 : 18 + Math.floor(Math.random() * 28),
            variant: 'town',
            tier: civic ? 'rare' : Math.random() > 0.86 ? 'rare' : 'common',
            doorSide: 'south',
            layout: civic ? 'shop' : (i % 2 === 0 ? 'split' : 'open'),
            label: civic ? 'GENERAL STORE' : null,
            role: civic ? 'townShop' : 'residence',
        });
        
        addDestructibleBarrier(obstacles, hx, hy - h / 2 - 20, w + 40, 10, 'stone');
        addDestructibleBarrier(obstacles, hx - w / 2 - 20, hy, 10, h + 40, 'stone');
        addDestructibleBarrier(obstacles, hx + w / 2 + 20, hy, 10, h + 40, 'stone');
    }
    
    const spacingS = roadLength / (housesSouth + 1);
    for (let i = 0; i < housesSouth; i++) {
        const hx = x - roadLength / 2 + spacingS * (i + 1);
        const hy = y + 210;
        const civic = i === 0;
        const w = civic ? 280 : 190 + Math.random() * 40;
        const h = civic ? 205 : 170 + Math.random() * 30;
        addHouse(obstacles, loot, spawnPoints, hx, hy, w, h, {
            hue: civic ? 8 : 18 + Math.floor(Math.random() * 28),
            variant: 'town',
            tier: civic ? 'rare' : Math.random() > 0.86 ? 'rare' : 'common',
            doorSide: 'north',
            layout: civic ? 'split' : (i % 2 === 0 ? 'open' : 'split'),
            label: civic ? 'CLINIC' : null,
            role: civic ? 'townClinic' : 'residence',
        });
        
        addDestructibleBarrier(obstacles, hx, hy + h / 2 + 20, w + 40, 10, 'stone');
        addDestructibleBarrier(obstacles, hx - w / 2 - 20, hy, 10, h + 40, 'stone');
        addDestructibleBarrier(obstacles, hx + w / 2 + 20, hy, 10, h + 40, 'stone');
    }
    
    // Short side lanes end between houses instead of cutting through backyards.
    // They create rotations off the main street while keeping every facade legible.
    if (housesNorth >= 2) {
        const northLaneX = x - roadLength / 2 + spacingN * 1.5;
        addObstacle(obstacles, 'road', northLaneX, y - 170, 66, 340, {
            collidable: false, variant: 'cobblestone', role: 'townLane', landmarkType: 'town',
        });
    }
    if (housesSouth >= 2) {
        const southLaneX = x - roadLength / 2 + spacingS * (housesSouth - 0.5);
        addObstacle(obstacles, 'road', southLaneX, y + 170, 66, 340, {
            collidable: false, variant: 'cobblestone', role: 'townLane', landmarkType: 'town',
        });
    }
    addObstacle(obstacles, 'signpost', x - roadLength / 2 + 55, y - 86, 30, 30, {
        collidable: false, variant: 'townMarker', role: 'townEntrance', landmarkType: 'town',
    });
    addObstacle(obstacles, 'signpost', x + roadLength / 2 - 55, y + 86, 30, 30, {
        collidable: false, variant: 'townMarker', role: 'townEntrance', landmarkType: 'town',
    });

    for (let i = 0; i < size; i++) {
        const cx = x - roadLength / 2 + 100 + i * 260;
        if (Math.random() > 0.4) {
            addObstacle(obstacles, 'crate', cx, y + (Math.random() > 0.5 ? 108 : -108), 44, 44, { rotation: Math.random() * 0.4 });
        }
        if (Math.random() > 0.5) {
            addObstacle(obstacles, 'tree', cx + 130, y + (Math.random() > 0.5 ? 126 : -126), 38, 38, { hue: 105, rotation: Math.random() * 3 });
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

function addPondSite(obstacles, loot, spawnPoints, x, y) {
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
        addObstacle(obstacles, 'hayBale', x + 190, y - 80, 70, 38, { hue: 34, variant: 'twine' });
    } else if (roll < 0.9) {
        // Pond with a clear shoreline and a fishing shack outside the water footprint.
        addPondSite(obstacles, loot, spawnPoints, x, y);
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
    addObstacle(obstacles, 'hayBale', x - 760, y - 105, 72, 40, { hue: 34, variant: 'twine', role: 'farmProp' });
    addObstacle(obstacles, 'hayBale', x - 680, y - 105, 72, 40, { hue: 34, variant: 'twine', role: 'farmProp' });
    addObstacle(obstacles, 'hayBale', x - 590, y + 710, 78, 42, { hue: 34, rotation: 0.12, variant: 'twine', role: 'farmProp' });
    addObstacle(obstacles, 'hayBale', x - 80, y + 715, 74, 40, { hue: 34, rotation: -0.18, variant: 'twine', role: 'farmProp' });
    addObstacle(obstacles, 'hayBale', x + 410, y + 700, 76, 42, { hue: 34, rotation: 0.08, variant: 'twine', role: 'farmProp' });
    addObstacle(obstacles, 'wildflowers', x + 720, y + 480, 52, 48, { collidable: false, hue: 48, variant: 'sunflowers', role: 'farmProp' });
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

function addRoadsideServices(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1480, 820, {
        collidable: false, variant: 'town', role: 'serviceStop', landmarkType: 'services',
        label: 'CROSSROADS',
    });
    addObstacle(obstacles, 'field', x, y, 1120, 360, {
        collidable: false, variant: 'courtyard', role: 'parkingLot', landmarkType: 'services',
    });

    addHouse(obstacles, loot, spawnPoints, x - 310, y - 245, 430, 230, {
        variant: 'house', hue: 18, tier: 'rare', doorSide: 'south', layout: 'shop',
        landmarkType: 'services', label: 'DINER', role: 'diner',
    });
    addHouse(obstacles, loot, spawnPoints, x + 300, y - 245, 310, 220, {
        variant: 'house', hue: 42, tier: 'common', doorSide: 'south', layout: 'shop',
        landmarkType: 'services', label: 'STORE', role: 'store',
    });
    addHouse(obstacles, loot, spawnPoints, x + 170, y + 245, 520, 250, {
        variant: 'warehouse', hue: 202, tier: 'rare', doorSide: 'north', layout: 'open',
        landmarkType: 'services', label: 'AUTO SHOP', role: 'garage', entranceRole: 'garageEntrance',
    });

    addObstacle(obstacles, 'signpost', x - 650, y - 115, 34, 34, {
        collidable: false, variant: 'roadMarker', role: 'serviceSign', landmarkType: 'services',
        label: 'CROSSROADS',
    });
    addObstacle(obstacles, 'barrel', x + 610, y + 250, 36, 36, {
        hue: 15, variant: 'fuel', role: 'serviceProp', landmarkType: 'services',
    });
    addObstacle(obstacles, 'barrel', x + 610, y + 310, 36, 36, {
        hue: 205, variant: 'water', role: 'serviceProp', landmarkType: 'services',
    });
    addObstacle(obstacles, 'crate', x - 620, y + 280, 46, 46, {
        rotation: 0.12, role: 'serviceProp', landmarkType: 'services',
    });

    spawnPoints.push({ x: x - 720, y, role: 'services-road' });
    spawnPoints.push({ x: x + 720, y, role: 'services-road' });
}

function addFireStation(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1500, 1050, {
        collidable: false, variant: 'industrial', role: 'fireStation', landmarkType: 'fire-station',
        label: 'FIRE STATION',
    });
    const drivewayStartX = 2500;
    const buildingWestEdge = x - 650 / 2;
    addObstacle(obstacles, 'road', (drivewayStartX + buildingWestEdge) / 2, y, buildingWestEdge - drivewayStartX, 112, {
        collidable: false, variant: 'asphalt', role: 'driveway', landmarkType: 'fire-station',
    });
    addObstacle(obstacles, 'field', x - 280, y, 470, 310, {
        collidable: false, variant: 'courtyard', role: 'apron', landmarkType: 'fire-station',
    });

    const engineHall = addHouse(obstacles, loot, spawnPoints, x, y, 650, 340, {
        variant: 'warehouse', hue: 6, tier: 'military', doorSide: 'west', layout: 'shop', wall: 16,
        landmarkType: 'fire-station', label: 'FIRE STATION', role: 'engineHall',
        entranceRole: 'garageEntrance',
    });
    addHouse(obstacles, loot, spawnPoints, x + 430, y + 370, 280, 220, {
        variant: 'house', hue: 25, tier: 'rare', doorSide: 'north', layout: 'split',
        landmarkType: 'fire-station', label: 'WATCH', role: 'watchHouse',
    });

    addObstacle(obstacles, 'container', x - 430, y + 330, 125, 54, {
        hue: 12, variant: 'red', role: 'trainingYard', landmarkType: 'fire-station',
    });
    addObstacle(obstacles, 'barrel', x - 515, y + 405, 36, 36, {
        hue: 205, variant: 'water', role: 'trainingYard', landmarkType: 'fire-station',
    });
    addObstacle(obstacles, 'sandbag', x - 360, y - 360, 76, 28, {
        rotation: 0.08, variant: 'training', role: 'trainingYard', landmarkType: 'fire-station',
    });
    addObstacle(obstacles, 'signpost', x - 610, y - 115, 34, 34, {
        collidable: false, variant: 'roadMarker', role: 'stationSign', landmarkType: 'fire-station',
        label: 'FIRE',
    });

    loot.push(makeChest(x + 190, y - 70, 'military', null, 'map', {
        houseId: engineHall.id,
        landmarkType: 'fire-station',
        room: 'stockroom',
        containerType: 'medical_crate',
    }));
    spawnPoints.push({ x: drivewayStartX + 90, y: y - 150, role: 'fire-road' });
    spawnPoints.push({ x: drivewayStartX + 90, y: y + 150, role: 'fire-road' });
}

function addOrchardCooperative(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1900, 1280, {
        collidable: false, variant: 'farm', role: 'orchard', landmarkType: 'orchard',
        label: 'OLD ORCHARD',
    });
    const laneWest = x - 980;
    const laneEast = -2500;
    addObstacle(obstacles, 'road', (laneWest + laneEast) / 2, y, laneEast - laneWest, 92, {
        collidable: false, variant: 'gravel', role: 'orchardLane', landmarkType: 'orchard',
    });

    addHouse(obstacles, loot, spawnPoints, x + 410, y - 255, 350, 235, {
        variant: 'house', hue: 26, tier: 'rare', doorSide: 'south', layout: 'split',
        landmarkType: 'orchard', label: 'FARMHOUSE', role: 'farmhouse',
    });
    addHouse(obstacles, loot, spawnPoints, x - 260, y + 275, 500, 270, {
        variant: 'barn', hue: 8, tier: 'rare', doorSide: 'north', layout: 'open',
        landmarkType: 'orchard', label: 'CIDER BARN', role: 'ciderBarn',
    });
    addHouse(obstacles, loot, spawnPoints, x - 650, y - 250, 310, 220, {
        variant: 'warehouse', hue: 34, tier: 'common', doorSide: 'south', layout: 'shop',
        landmarkType: 'orchard', label: 'PACKING', role: 'packingShed',
    });

    for (const rowY of [y - 500, y + 520]) {
        for (let treeX = x - 720; treeX <= x + 650; treeX += 220) {
            if (isMapPositionBlocked(obstacles, treeX, rowY, 28)) continue;
            addObstacle(obstacles, 'tree', treeX, rowY, 46, 46, {
                hue: 88 + Math.floor((treeX - x + 800) / 220) * 3,
                variant: 'orchard', role: 'orchardTree', landmarkType: 'orchard',
            });
        }
    }
    addObstacle(obstacles, 'hayBale', x + 760, y + 310, 72, 40, {
        hue: 34, variant: 'twine', role: 'orchardProp', landmarkType: 'orchard',
    });
    addObstacle(obstacles, 'wildflowers', x + 760, y - 440, 58, 52, {
        collidable: false, hue: 42, variant: 'sunflowers', role: 'orchardProp', landmarkType: 'orchard',
    });
    addObstacle(obstacles, 'barrel', x - 760, y + 350, 36, 36, {
        hue: 205, variant: 'water', role: 'orchardProp', landmarkType: 'orchard',
    });

    spawnPoints.push({ x: laneEast - 120, y: y - 150, role: 'orchard-road' });
    spawnPoints.push({ x: laneWest + 120, y: y + 150, role: 'orchard-road' });
}
function addSunsetMotel(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1700, 1180, {
        collidable: false, variant: 'town', role: 'motelGrounds', landmarkType: 'motel',
        label: 'SUNSET MOTEL',
    });
    addObstacle(obstacles, 'field', x, y + 80, 1060, 560, {
        collidable: false, variant: 'courtyard', role: 'parkingCourt', landmarkType: 'motel',
    });
    addObstacle(obstacles, 'road', x, y + 585, 1120, 90, {
        collidable: false, variant: 'asphalt', role: 'motelDrive', landmarkType: 'motel',
    });

    // A U-shaped set of buildings makes the parking court useful for short
    // rotations while every wing still has a direct exterior escape.
    const northWing = addHouse(obstacles, loot, spawnPoints, x, y - 390, 720, 260, {
        variant: 'brick', tier: 'rare', hue: 10, doorSide: 'south', layout: 'split',
        landmarkType: 'motel', label: 'ROOMS 1-8', role: 'northWing',
    });
    const westWing = addHouse(obstacles, loot, spawnPoints, x - 590, y + 65, 300, 500, {
        variant: 'brick', tier: 'rare', hue: 12, doorSide: 'east', layout: 'split',
        landmarkType: 'motel', label: 'ROOMS 9-12', role: 'westWing',
    });
    const eastWing = addHouse(obstacles, loot, spawnPoints, x + 590, y + 65, 300, 500, {
        variant: 'brick', tier: 'rare', hue: 8, doorSide: 'west', layout: 'split',
        landmarkType: 'motel', label: 'ROOMS 13-16', role: 'eastWing',
    });
    const reception = addHouse(obstacles, loot, spawnPoints, x - 250, y + 430, 360, 190, {
        variant: 'brick', tier: 'rare', hue: 14, doorSide: 'north', layout: 'shop',
        landmarkType: 'motel', label: 'RECEPTION', role: 'reception',
    });
    addHouse(obstacles, loot, spawnPoints, x + 300, y + 430, 300, 190, {
        variant: 'garage', tier: 'common', hue: 205, doorSide: 'north', layout: 'shop',
        landmarkType: 'motel', label: 'LAUNDRY', role: 'laundry',
    });

    addObstacle(obstacles, 'water', x, y + 120, 280, 155, {
        collidable: false, variant: 'pool', role: 'motelPool', landmarkType: 'motel',
    });
    addObstacle(obstacles, 'signpost', x - 760, y + 465, 42, 42, {
        collidable: false, variant: 'roadMarker', role: 'motelSign',
        landmarkType: 'motel', label: 'SUNSET MOTEL',
    });
    const parkedCars = [
        { dx: -360, dy: 105, hue: 4, rotation: 0.04 },
        { dx: 345, dy: -30, hue: 208, rotation: -0.05 },
        { dx: 365, dy: 230, hue: 42, rotation: 0.03 },
    ];
    for (const car of parkedCars) {
        addObstacle(obstacles, 'container', x + car.dx, y + car.dy, 112, 50, {
            hue: car.hue, rotation: car.rotation, variant: 'car',
            role: 'parkedCar', landmarkType: 'motel',
        });
    }

    loot.push(makeChest(x + 210, y - 390, 'rare', null, 'map', {
        houseId: northWing.id, landmarkType: 'motel', room: 'bedroom',
    }));
    loot.push(makeChest(x - 590, y - 25, 'common', null, 'map', {
        houseId: westWing.id, landmarkType: 'motel', room: 'living-room',
    }));
    loot.push(makeChest(x + 590, y + 160, 'rare', null, 'map', {
        houseId: eastWing.id, landmarkType: 'motel', room: 'bedroom',
    }));
    loot.push(makeChest(x - 250, y + 430, 'rare', null, 'map', {
        houseId: reception.id, landmarkType: 'motel', room: 'stockroom',
    }));
    spawnPoints.push({ x: x - 740, y: y + 585, role: 'motel-road' });
    spawnPoints.push({ x: x + 740, y: y + 585, role: 'motel-road' });
}

function addRangerLodge(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1600, 1100, {
        collidable: false, variant: 'woods', role: 'rangerGrounds', landmarkType: 'ranger-lodge',
        label: 'CEDAR LODGE',
    });
    addObstacle(obstacles, 'field', x, y + 235, 520, 280, {
        collidable: false, variant: 'courtyard', role: 'campCircle', landmarkType: 'ranger-lodge',
    });
    addObstacle(obstacles, 'road', x + 400, y + 500, 800, 88, {
        collidable: false, variant: 'gravel', role: 'lodgeDrive', landmarkType: 'ranger-lodge',
    });
    addObstacle(obstacles, 'road', x, y + 375, 88, 250, {
        collidable: false, variant: 'gravel', role: 'lodgeDrive', landmarkType: 'ranger-lodge',
    });

    const lodge = addHouse(obstacles, loot, spawnPoints, x, y - 220, 650, 380, {
        variant: 'lodge', tier: 'military', hue: 116, wall: 16, doorSide: 'south', layout: 'corridor',
        landmarkType: 'ranger-lodge', label: 'CEDAR LODGE', role: 'mainLodge',
    });
    const westCabin = addHouse(obstacles, loot, spawnPoints, x - 555, y + 235, 270, 220, {
        variant: 'cabin', tier: 'rare', hue: 24, doorSide: 'east', layout: 'split',
        landmarkType: 'ranger-lodge', label: 'CABIN A', role: 'guestCabin',
    });
    const eastCabin = addHouse(obstacles, loot, spawnPoints, x + 555, y + 235, 270, 220, {
        variant: 'cabin', tier: 'rare', hue: 20, doorSide: 'west', layout: 'split',
        landmarkType: 'ranger-lodge', label: 'CABIN B', role: 'guestCabin',
    });
    addHouse(obstacles, loot, spawnPoints, x - 555, y - 300, 250, 190, {
        variant: 'garage', tier: 'rare', hue: 105, doorSide: 'south', layout: 'shop',
        landmarkType: 'ranger-lodge', label: 'GEAR SHED', role: 'gearShed',
    });

    // A small stone fire ring and wood piles give the courtyard readable cover.
    for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        addObstacle(obstacles, 'rock', x + Math.cos(angle) * 58, y + 235 + Math.sin(angle) * 58, 26, 22, {
            hue: 220, variant: 'fireRing', role: 'campCover', landmarkType: 'ranger-lodge',
        });
    }
    addObstacle(obstacles, 'fallenLog', x - 235, y + 260, 96, 25, {
        rotation: 0.12, variant: 'birch', role: 'campCover', landmarkType: 'ranger-lodge',
    });
    addObstacle(obstacles, 'fallenLog', x + 235, y + 260, 96, 25, {
        rotation: -0.12, variant: 'mossy', role: 'campCover', landmarkType: 'ranger-lodge',
    });
    for (const [dx, dy] of [[-710, -420], [700, -390], [-720, 430], [710, 435]]) {
        addObstacle(obstacles, 'tree', x + dx, y + dy, 52, 52, {
            hue: 108, variant: 'pine', role: 'lodgeTree', landmarkType: 'ranger-lodge',
        });
    }

    loot.push(makeChest(x + 205, y - 230, 'military', null, 'map', {
        houseId: lodge.id, landmarkType: 'ranger-lodge', room: 'north-room',
    }));
    loot.push(makeChest(x - 555, y + 235, 'rare', null, 'map', {
        houseId: westCabin.id, landmarkType: 'ranger-lodge', room: 'bedroom',
    }));
    loot.push(makeChest(x + 555, y + 235, 'rare', null, 'map', {
        houseId: eastCabin.id, landmarkType: 'ranger-lodge', room: 'bedroom',
    }));
    spawnPoints.push({ x: x + 820, y: y + 500, role: 'lodge-road' });
}

function addLumberWorks(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1750, 1200, {
        collidable: false, variant: 'industrial', role: 'lumberYard', landmarkType: 'lumberworks',
        label: 'SOUTH LUMBERWORKS',
    });
    addObstacle(obstacles, 'field', x, y + 105, 1420, 430, {
        collidable: false, variant: 'courtyard', role: 'millYard', landmarkType: 'lumberworks',
    });
    addObstacle(obstacles, 'road', x - 75, y + 115, 1420, 96, {
        collidable: false, variant: 'service', role: 'serviceLane', landmarkType: 'lumberworks',
    });
    addObstacle(obstacles, 'road', x - 720, y + 350, 90, 470, {
        collidable: false, variant: 'service', role: 'serviceLane', landmarkType: 'lumberworks',
    });

    const sawmill = addHouse(obstacles, loot, spawnPoints, x + 220, y - 310, 720, 340, {
        variant: 'warehouse', tier: 'military', hue: 28, wall: 16, doorSide: 'south', layout: 'corridor',
        landmarkType: 'lumberworks', label: 'SAWMILL', role: 'sawmill',
    });
    const office = addHouse(obstacles, loot, spawnPoints, x - 620, y - 315, 300, 230, {
        variant: 'lodge', tier: 'rare', hue: 106, doorSide: 'south', layout: 'shop',
        landmarkType: 'lumberworks', label: 'OFFICE', role: 'millOffice',
    });
    addHouse(obstacles, loot, spawnPoints, x - 410, y + 410, 380, 250, {
        variant: 'garage', tier: 'rare', hue: 34, doorSide: 'north', layout: 'shop',
        landmarkType: 'lumberworks', label: 'WORKSHOP', role: 'workshop',
    });
    const dryingShed = addHouse(obstacles, loot, spawnPoints, x + 570, y + 410, 430, 250, {
        variant: 'barn', tier: 'rare', hue: 12, doorSide: 'north', layout: 'split',
        landmarkType: 'lumberworks', label: 'DRYING SHED', role: 'dryingShed',
    });

    const logStacks = [
        { dx: -655, dy: 55, rotation: 0 }, { dx: -655, dy: 95, rotation: 0 },
        { dx: 720, dy: -80, rotation: Math.PI / 2 }, { dx: 760, dy: -80, rotation: Math.PI / 2 },
        { dx: 80, dy: 350, rotation: 0.04 }, { dx: 80, dy: 390, rotation: -0.03 },
    ];
    for (const log of logStacks) {
        addObstacle(obstacles, 'fallenLog', x + log.dx, y + log.dy, 118, 28, {
            rotation: log.rotation, variant: 'millStack', role: 'logStack', landmarkType: 'lumberworks',
        });
    }
    addObstacle(obstacles, 'container', x + 730, y + 300, 125, 54, {
        hue: 32, variant: 'rust', role: 'millCover', landmarkType: 'lumberworks',
    });
    addObstacle(obstacles, 'crate', x - 120, y + 260, 48, 48, {
        variant: 'industrial', role: 'millCover', landmarkType: 'lumberworks',
    });
    addObstacle(obstacles, 'signpost', x - 815, y + 520, 38, 38, {
        collidable: false, variant: 'roadMarker', role: 'millSign',
        landmarkType: 'lumberworks', label: 'LUMBERWORKS',
    });

    loot.push(makeChest(x + 235, y - 315, 'military', null, 'map', {
        houseId: sawmill.id, landmarkType: 'lumberworks', room: 'hallway',
    }));
    loot.push(makeChest(x - 620, y - 315, 'rare', null, 'map', {
        houseId: office.id, landmarkType: 'lumberworks', room: 'stockroom',
    }));
    loot.push(makeChest(x + 570, y + 410, 'rare', null, 'map', {
        houseId: dryingShed.id, landmarkType: 'lumberworks', room: 'bedroom',
    }));
    spawnPoints.push({ x: x - 900, y: y + 520, role: 'mill-road' });
    spawnPoints.push({ x: x + 900, y: y + 115, role: 'mill-yard' });
}

function addUrbanBorough(obstacles, loot, spawnPoints, x, y, opts = {}) {
    const landmarkType = opts.landmarkType || 'borough';
    const label = opts.label || 'BOROUGH';
    const roadVariant = opts.roadVariant || 'asphalt';
    addObstacle(obstacles, 'field', x, y, 2240, 1540, {
        collidable: false, variant: 'town', role: 'urbanDistrict', landmarkType, label,
    });
    addObstacle(obstacles, 'road', x, y, 2120, 112, {
        collidable: false, variant: roadVariant, role: 'boroughMainStreet', landmarkType,
    });
    addObstacle(obstacles, 'road', x, y, 96, 1420, {
        collidable: false, variant: roadVariant, role: 'boroughCrossStreet', landmarkType,
    });
    addObstacle(obstacles, 'field', x, y, 520, 340, {
        collidable: false, variant: 'courtyard', role: 'boroughSquare', landmarkType,
    });

    const names = opts.buildingLabels || [
        'BAKERY', 'ROW HOMES', 'GROCERY', 'WATCH HOUSE',
        'APARTMENTS', 'PUB', 'WORKSHOP', 'BOARDING HOUSE',
    ];
    const variants = opts.variants || ['brick', 'brick', 'house', 'brick', 'house', 'brick', 'garage', 'lodge'];
    const offsets = [-790, -270, 270, 790];
    const buildings = [];
    for (const [rowIndex, rowY] of [-455, 455].entries()) {
        for (const [columnIndex, offsetX] of offsets.entries()) {
            const index = rowIndex * offsets.length + columnIndex;
            const commercial = index === 0 || index === 2 || index === 5 || index === 6;
            const width = columnIndex % 2 === 0 ? 350 : 330;
            const height = commercial ? 255 : 275;
            buildings.push(addHouse(obstacles, loot, spawnPoints, x + offsetX, y + rowY, width, height, {
                variant: variants[index % variants.length],
                hue: (opts.baseHue || 12) + index * 5,
                tier: commercial || index === 3 ? 'rare' : 'common',
                doorSide: rowIndex === 0 ? 'south' : 'north',
                layout: commercial ? 'shop' : 'split',
                landmarkType,
                label: names[index] || `BLOCK ${index + 1}`,
                role: commercial ? 'boroughBusiness' : 'boroughHome',
            }));
        }
    }

    for (const [dx, dy, kind] of [
        [-520, -135, 'crate'], [520, 145, 'barrel'], [-145, 590, 'tree'], [155, -600, 'tree'],
    ]) {
        addObstacle(obstacles, kind, x + dx, y + dy, kind === 'tree' ? 46 : 38, kind === 'tree' ? 46 : 38, {
            hue: kind === 'barrel' ? 205 : kind === 'tree' ? 108 : 28,
            rotation: kind === 'crate' ? 0.12 : 0,
            variant: kind === 'barrel' ? 'water' : kind === 'tree' ? 'streetTree' : 'marketCrate',
            role: 'boroughProp', landmarkType,
        });
    }
    addObstacle(obstacles, 'signpost', x - 1010, y - 95, 40, 40, {
        collidable: false, variant: 'roadMarker', role: 'boroughSign', landmarkType, label,
    });
    spawnPoints.push({ x: x - 1160, y, role: 'borough-road' });
    spawnPoints.push({ x: x + 1160, y, role: 'borough-road' });
    spawnPoints.push({ x, y: y + 790, role: 'borough-cross-street' });
    return buildings;
}

function addWestportVillage(obstacles, loot, spawnPoints, x, y) {
    const landmarkType = 'westport';
    addObstacle(obstacles, 'field', x, y, 1940, 1420, {
        collidable: false, variant: 'village', role: 'harborVillage', landmarkType, label: 'WESTPORT',
    });
    addObstacle(obstacles, 'road', x, y + 80, 1840, 102, {
        collidable: false, variant: 'gravel', role: 'harborRoad', landmarkType,
    });
    addObstacle(obstacles, 'road', x, y - 285, 88, 730, {
        collidable: false, variant: 'gravel', role: 'ferryLane', landmarkType,
    });
    addObstacle(obstacles, 'field', x, y + 80, 430, 300, {
        collidable: false, variant: 'courtyard', role: 'harborSquare', landmarkType,
    });

    const homes = [
        { dx: -720, dy: -390, w: 310, h: 240, side: 'south', variant: 'cabin', label: 'NET HOUSE', role: 'fisherHome' },
        { dx: -245, dy: -410, w: 330, h: 260, side: 'south', variant: 'brick', label: 'FERRY INN', role: 'ferryInn', shop: true },
        { dx: 245, dy: -410, w: 330, h: 260, side: 'south', variant: 'house', label: 'BAKERY', role: 'harborShop', shop: true },
        { dx: 720, dy: -390, w: 310, h: 240, side: 'south', variant: 'cabin', label: 'LIGHT HOUSE', role: 'fisherHome' },
        { dx: -600, dy: 470, w: 360, h: 260, side: 'north', variant: 'barn', label: 'BOAT SHED', role: 'boatShed' },
        { dx: 0, dy: 475, w: 370, h: 270, side: 'north', variant: 'brick', label: 'FISH MARKET', role: 'fishMarket', shop: true },
        { dx: 610, dy: 465, w: 350, h: 255, side: 'north', variant: 'garage', label: 'REPAIR', role: 'repairShop', shop: true },
    ];
    for (const [index, home] of homes.entries()) {
        addHouse(obstacles, loot, spawnPoints, x + home.dx, y + home.dy, home.w, home.h, {
            variant: home.variant, hue: 16 + index * 7, tier: home.shop ? 'rare' : 'common',
            doorSide: home.side, layout: home.shop ? 'shop' : 'split', landmarkType,
            label: home.label, role: home.role,
        });
    }
    for (const dx of [-180, -60, 60, 180]) {
        addObstacle(obstacles, 'crate', x + dx, y - 70, 42, 42, {
            hue: 28, variant: 'marketStall', role: 'harborCrate', landmarkType,
        });
    }
    addObstacle(obstacles, 'signpost', x - 895, y - 15, 38, 38, {
        collidable: false, variant: 'roadMarker', role: 'harborSign', landmarkType, label: 'WESTPORT',
    });
    spawnPoints.push({ x: x - 1040, y: y + 80, role: 'westport-road' });
    spawnPoints.push({ x: x + 1040, y: y + 80, role: 'westport-road' });
}

function addRailDepot(obstacles, loot, spawnPoints, x, y) {
    const landmarkType = 'rail-depot';
    addObstacle(obstacles, 'field', x, y, 1860, 1320, {
        collidable: false, variant: 'industrial', role: 'railYard', landmarkType, label: 'SOUTH RAIL DEPOT',
    });
    for (const offsetY of [-105, 105]) {
        addObstacle(obstacles, 'road', x, y + offsetY, 1740, 62, {
            collidable: false, variant: 'rail', role: 'railTrack', landmarkType,
        });
    }
    addObstacle(obstacles, 'road', x - 920, y + 250, 92, 1000, {
        collidable: false, variant: 'asphalt', role: 'depotApproach', landmarkType,
    });

    const freightHall = addHouse(obstacles, loot, spawnPoints, x + 360, y - 410, 760, 300, {
        variant: 'warehouse', hue: 202, tier: 'military', doorSide: 'south', layout: 'corridor',
        landmarkType, label: 'FREIGHT HALL', role: 'freightHall',
    });
    addHouse(obstacles, loot, spawnPoints, x - 610, y - 400, 320, 250, {
        variant: 'brick', hue: 12, tier: 'rare', doorSide: 'south', layout: 'shop',
        landmarkType, label: 'STATION', role: 'stationHouse',
    });
    addHouse(obstacles, loot, spawnPoints, x - 620, y + 440, 330, 250, {
        variant: 'lodge', hue: 105, tier: 'common', doorSide: 'north', layout: 'split',
        landmarkType, label: 'CREW HOUSE', role: 'crewHouse',
    });
    addHouse(obstacles, loot, spawnPoints, x + 60, y + 440, 390, 250, {
        variant: 'garage', hue: 205, tier: 'rare', doorSide: 'north', layout: 'shop',
        landmarkType, label: 'ENGINE SHOP', role: 'engineShop',
    });
    addHouse(obstacles, loot, spawnPoints, x + 650, y + 435, 330, 240, {
        variant: 'warehouse', hue: 34, tier: 'rare', doorSide: 'north', layout: 'open',
        landmarkType, label: 'PARCEL SHED', role: 'parcelShed',
    });
    for (const [dx, dy, hue] of [[-360, -100, 205], [-120, 105, 8], [330, 100, 34], [650, -105, 195]]) {
        addObstacle(obstacles, 'container', x + dx, y + dy, 155, 54, {
            hue, variant: hue === 8 ? 'red' : 'rust', role: 'freightCar', landmarkType,
        });
    }
    loot.push(makeChest(x + 360, y - 410, 'military', null, 'map', {
        houseId: freightHall.id, landmarkType, room: 'hallway',
    }));
    spawnPoints.push({ x: x - 980, y: y + 350, role: 'depot-road' });
    spawnPoints.push({ x: x + 960, y, role: 'rail-yard' });
}

function addCivicQuarter(obstacles, loot, spawnPoints, x, y) {
    const landmarkType = 'civic-quarter';
    addObstacle(obstacles, 'field', x, y, 1900, 1500, {
        collidable: false, variant: 'town', role: 'civicQuarter', landmarkType, label: 'CIVIC QUARTER',
    });
    addObstacle(obstacles, 'road', x, y + 50, 1800, 108, {
        collidable: false, variant: 'cobblestone', role: 'civicStreet', landmarkType,
    });
    addObstacle(obstacles, 'field', x, y + 50, 470, 320, {
        collidable: false, variant: 'courtyard', role: 'civicPlaza', landmarkType,
    });
    const buildings = [
        { dx: -610, dy: -430, w: 430, h: 285, label: 'SCHOOL', role: 'school', variant: 'brick', shop: false },
        { dx: 0, dy: -435, w: 420, h: 290, label: 'LIBRARY', role: 'library', variant: 'brick', shop: true },
        { dx: 610, dy: -425, w: 390, h: 270, label: 'TOWN HALL', role: 'townHall', variant: 'brick', shop: true },
        { dx: -610, dy: 485, w: 370, h: 260, label: 'TEACHER HOMES', role: 'civicHome', variant: 'house', shop: false },
        { dx: 0, dy: 490, w: 400, h: 270, label: 'CHAPEL', role: 'chapel', variant: 'lodge', shop: false },
        { dx: 610, dy: 480, w: 380, h: 260, label: 'POST OFFICE', role: 'postOffice', variant: 'brick', shop: true },
    ];
    for (const [index, building] of buildings.entries()) {
        addHouse(obstacles, loot, spawnPoints, x + building.dx, y + building.dy, building.w, building.h, {
            variant: building.variant, hue: 12 + index * 6, tier: index < 3 ? 'rare' : 'common',
            doorSide: building.dy < 0 ? 'south' : 'north',
            layout: building.shop ? 'shop' : 'split', landmarkType,
            label: building.label, role: building.role,
        });
    }
    addObstacle(obstacles, 'signpost', x - 850, y - 20, 40, 40, {
        collidable: false, variant: 'roadMarker', role: 'civicSign', landmarkType, label: 'CIVIC QUARTER',
    });
    spawnPoints.push({ x: x - 1000, y: y + 50, role: 'civic-road' });
    spawnPoints.push({ x: x + 1000, y: y + 50, role: 'civic-road' });
}

function addMarketVillage(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1900, 1320, {
        collidable: false, variant: 'village', role: 'marketVillage', landmarkType: 'market',
        label: 'GRAND MARKET',
    });
    addObstacle(obstacles, 'road', x, y + 550, 1760, 110, {
        collidable: false, variant: 'cobblestone', role: 'mainStreet', landmarkType: 'market',
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
    spawnPoints.push({ x: x - 1040, y: y + 550, role: 'market-road' });
    spawnPoints.push({ x: x + 1040, y: y + 550, role: 'market-road' });
}

function addSupplyCacheSite(obstacles, loot, spawnPoints, x, y, theme = 'supply') {
    const industrial = theme === 'armory' || theme === 'checkpoint';
    addObstacle(obstacles, 'field', x, y, 620, 420, {
        collidable: false,
        variant: industrial ? 'industrial' : 'scrub',
        role: 'supplyCache',
        landmarkType: 'supply-cache',
    });
    addObstacle(obstacles, 'container', x - 150, y - 45, 150, 58, {
        hue: industrial ? 205 : 28,
        variant: industrial ? 'blue' : 'rust',
        role: 'cacheCover',
        landmarkType: 'supply-cache',
    });
    addObstacle(obstacles, 'sandbag', x + 135, y + 85, 105, 24, {
        rotation: theme === 'checkpoint' ? 0 : 0.16,
        role: 'cacheCover',
        landmarkType: 'supply-cache',
    });
    addObstacle(obstacles, 'barrel', x - 35, y + 115, 34, 34, {
        variant: industrial ? 'fuel' : 'rust',
        hue: industrial ? 16 : 30,
        landmarkType: 'supply-cache',
    });
    if (theme === 'medical') {
        addObstacle(obstacles, 'tent', x + 120, y - 95, 115, 82, {
            variant: 'medical', role: 'aidTent', landmarkType: 'supply-cache',
        });
    } else {
        addObstacle(obstacles, 'crate', x + 185, y - 100, 44, 44, {
            variant: industrial ? 'industrial' : 'wood', rotation: -0.08,
            landmarkType: 'supply-cache',
        });
    }

    const primaryType = theme === 'armory' ? 'armory_crate'
        : theme === 'medical' ? 'medical_crate'
            : theme === 'checkpoint' ? 'ammo_crate' : 'supply_crate';
    const primaryTier = theme === 'armory' ? 'military' : 'rare';
    loot.push(makeChest(x + 55, y - 35, primaryTier, null, 'map', {
        containerType: primaryType, outdoor: true, landmarkType: 'supply-cache',
    }));
    loot.push(makeChest(x - 40, y + 55, 'common', null, 'map', {
        containerType: theme === 'medical'
            ? 'supply_crate'
            : theme === 'supply'
                ? 'wood_crate'
                : 'medical_crate',
        outdoor: true,
        landmarkType: 'supply-cache',
    }));
    spawnPoints.push({ x: x + 330, y }, { x: x - 330, y });
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
    loot.push(makeGroundLoot('weapon', x, y, { weaponType: 'sv98', source: 'military-loot' }));
    loot.push(makeGroundLoot('ammo', x - 40, y, { source: 'military-loot' }));
    loot.push(makeGroundLoot('ammo', x + 40, y, { source: 'military-loot' }));
    loot.push(makeGroundLoot('weapon', x - 550, y - 400, { weaponType: 'm4a1s', source: 'military-loot' }));
    loot.push(makeGroundLoot('weapon', x + 550, y - 400, { weaponType: 'mk20ssr', source: 'military-loot' }));
    loot.push(makeGroundLoot('medkit', x, y + 100, { source: 'military-loot' }));

    spawnPoints.push({ x: x, y: y + 780 });
    spawnPoints.push({ x: x, y: y - 780 });
}

function addGasStation(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1200, 800, {
        collidable: false, variant: 'parkingLot', role: 'gasForecourt', landmarkType: 'gas',
    });

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
    loot.push(makeGroundLoot('weapon', x, y, { weaponType: 'ots38', source: 'prison-loot' }));
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
    const hospitalDoorSpan = compactDoorSpan(202, 'plaster');
    const hospitalWallSpan = (1000 - hospitalDoorSpan) / 2;
    const hospitalWallOffset = (1000 + hospitalDoorSpan) / 4;
    addWall(obstacles, x - hospitalWallOffset, y + 400 - 8, hospitalWallSpan, 16, 'plaster');
    addWall(obstacles, x + hospitalWallOffset, y + 400 - 8, hospitalWallSpan, 16, 'plaster');
    addDoor(obstacles, houseId, x, y + 400 - 8, hospitalDoorSpan + 2, 14.4, 'plaster', 'south');
    // Side walls
    addWall(obstacles, x - 500 + 8, y, 16, 800, 'plaster');
    addWall(obstacles, x + 500 - 8, y, 16, 800, 'plaster');

    // Corridor walls with doorway gaps
    addVerticalInteriorWallSegments(obstacles, x - 200, y, 800, 16, [
        { center: -200, size: 90 },
        { center: 0, size: 90 },
        { center: 200, size: 90 },
    ], 'plaster', { houseId, doorVariant: 'plaster' });
    addVerticalInteriorWallSegments(obstacles, x + 200, y, 800, 16, [
        { center: -200, size: 90 },
        { center: 0, size: 90 },
        { center: 200, size: 90 },
    ], 'plaster', { houseId, doorVariant: 'plaster' });

    // Horizontal dividers with gaps
    addHorizontalInteriorWallSegments(obstacles, x - 350, y, 300, 16, [{ center: 0, size: 80 }], 'plaster', { houseId, doorVariant: 'plaster' });
    addHorizontalInteriorWallSegments(obstacles, x + 350, y, 300, 16, [{ center: 0, size: 80 }], 'plaster', { houseId, doorVariant: 'plaster' });

    // Room zones
    addRoomZone(obstacles, houseId, x - 350, y - 200, 300, 400, 'north-room');
    addRoomZone(obstacles, houseId, x - 350, y + 200, 300, 400, 'south-room');
    addRoomZone(obstacles, houseId, x, y, 400, 800, 'hallway');
    addRoomZone(obstacles, houseId, x + 350, y - 200, 300, 400, 'north-room');
    addRoomZone(obstacles, houseId, x + 350, y + 200, 300, 400, 'south-room');

    furnishHouseInterior(obstacles, hFloor, { theme: 'medical' });

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
    loot.push(makeGroundLoot('weapon', x - 200, y - 200, { weaponType: 'cz3a1', source: 'tower-loot' }));
    loot.push(makeGroundLoot('ammo', x - 200, y - 160, { source: 'tower-loot' }));

    spawnPoints.push({ x, y: y + 460 });
    spawnPoints.push({ x, y: y - 460 });
}

function pathBounds(points, padding = 0) {
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const minX = Math.min(...xs) - padding;
    const maxX = Math.max(...xs) + padding;
    const minY = Math.min(...ys) - padding;
    const maxY = Math.max(...ys) + padding;
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

function addTrailPath(obstacles, points, opts = {}) {
    const width = opts.width || 54;
    const bounds = pathBounds(points, width / 2 + 18);
    return addObstacle(obstacles, 'trail_path', bounds.x, bounds.y, bounds.w, bounds.h, {
        collidable: false,
        variant: opts.variant || 'footpath',
        role: opts.role || 'wildernessTrail',
        landmarkType: opts.landmarkType || null,
        label: opts.label || null,
        points,
        width,
    });
}

const WILDERNESS_TRAIL_PLANS = [
    { points: [
        { x: 700, y: -7200 }, { x: 790, y: -7010 }, { x: 860, y: -6840 },
        { x: 1080, y: -6460 }, { x: 1200, y: -6100 },
    ], opts: { width: 58, variant: 'gravel', role: 'supplyAccess', landmarkType: 'supply-cache', label: 'Ranger Cache Track' } },
    { points: [
        { x: 8600, y: 3600 }, { x: 8460, y: 3440 }, { x: 8320, y: 3260 },
        { x: 8120, y: 2700 }, { x: 8000, y: 2000 },
    ], opts: { width: 56, variant: 'gravel', role: 'supplyAccess', landmarkType: 'supply-cache', label: 'Aid Station Track' } },
    { points: [
        { x: -1200, y: 8500 }, { x: -1300, y: 8240 }, { x: -1400, y: 7950 },
        { x: -1680, y: 7100 }, { x: -1900, y: 6200 },
    ], opts: { width: 54, variant: 'forest', role: 'supplyAccess', landmarkType: 'supply-cache', label: 'Smuggler Trail' } },
    { points: [
        { x: 4100, y: -2700 }, { x: 3990, y: -2870 }, { x: 3890, y: -3060 },
        { x: 3540, y: -3500 }, { x: 3200, y: -4000 },
    ], opts: { width: 58, variant: 'gravel', role: 'supplyAccess', landmarkType: 'supply-cache', label: 'Checkpoint Track' } },
    { points: [
        { x: -870, y: 520 }, { x: -1120, y: 920 }, { x: -980, y: 1370 },
        { x: -520, y: 1680 }, { x: -200, y: 1940 },
    ], opts: { width: 58, label: 'Estate Walk' } },
    { points: [
        { x: -8950, y: -5250 }, { x: -8240, y: -5150 }, { x: -7420, y: -5200 },
        { x: -6500, y: -5200 }, { x: -6100, y: -4700 }, { x: -5900, y: -4200 },
    ], opts: { width: 62, variant: 'forest', label: 'Pine Trail' } },
    { points: [
        { x: -7700, y: -6760 }, { x: -6940, y: -6480 }, { x: -6120, y: -6200 },
        { x: -5350, y: -5740 }, { x: -4700, y: -5050 },
    ], opts: { width: 52, variant: 'forest', label: 'North Ridge' } },
    { points: [
        { x: 5880, y: -3050 }, { x: 6300, y: -3300 }, { x: 6800, y: -3420 },
        { x: 7200, y: -3340 }, { x: 7420, y: -3100 },
    ], opts: { width: 56, variant: 'gravel', label: 'Quarry Track' } },
    { points: [
        { x: -7900, y: 2460 }, { x: -8280, y: 3260 }, { x: -8340, y: 4130 },
        { x: -8170, y: 5020 }, { x: -7820, y: 5920 },
    ], opts: { width: 48, variant: 'boardwalk', label: 'Wetland Walk' } },
    { points: [
        { x: -7000, y: 6370 }, { x: -6250, y: 6580 }, { x: -5700, y: 6850 },
        { x: -5250, y: 7100 }, { x: -4940, y: 7300 },
    ], opts: { width: 60, variant: 'gravel', label: 'Market Track' } },
    { points: [
        { x: 480, y: 5690 }, { x: 880, y: 6260 }, { x: 1380, y: 6820 },
        { x: 1900, y: 7280 }, { x: 2350, y: 7490 },
    ], opts: { width: 56, label: 'South Ridge' } },
    { points: [
        { x: 6060, y: 5300 }, { x: 6420, y: 5700 }, { x: 6720, y: 6150 },
        { x: 6900, y: 6650 }, { x: 6950, y: 7100 },
    ], opts: { width: 54, variant: 'gravel', label: 'Research Trail' } },
    { points: [
        { x: 6600, y: -600 }, { x: 7040, y: -220 }, { x: 7500, y: 60 },
        { x: 8120, y: 120 }, { x: 8560, y: -180 },
    ], opts: { width: 50, variant: 'farm', label: 'Orchard Path' } },
    { points: [
        { x: -3600, y: 2900 }, { x: -3180, y: 3400 }, { x: -2800, y: 3920 },
        { x: -2480, y: 4470 }, { x: -2210, y: 5060 },
    ], opts: { width: 50, variant: 'forest', label: 'Birch Path' } },
    { points: [
        { x: 3420, y: 2980 }, { x: 3800, y: 3300 }, { x: 4200, y: 3540 },
        { x: 4650, y: 3700 }, { x: 5150, y: 3820 },
    ], opts: { width: 48, label: 'Prison Footpath' } },
];

function isNearPlannedTrail(x, y, radius = 30) {
    for (const plan of WILDERNESS_TRAIL_PLANS) {
        const clearance = (plan.opts.width || 54) / 2 + radius + 12;
        for (let i = 0; i < plan.points.length - 1; i++) {
            const a = plan.points[i];
            const b = plan.points[i + 1];
            if (distanceToSegment(x, y, a.x, a.y, b.x, b.y) < clearance) return true;
        }
    }
    return false;
}

function areaOverlapsPlannedTrail(x, y, w, h, buffer = 0) {
    for (const plan of WILDERNESS_TRAIL_PLANS) {
        const clearance = (plan.opts.width || 54) / 2 + buffer;
        const expanded = { x, y, w: w + clearance * 2, h: h + clearance * 2 };
        for (let i = 0; i < plan.points.length - 1; i++) {
            const a = plan.points[i];
            const b = plan.points[i + 1];
            if (lineSegmentRectIntersects(a.x, a.y, b.x, b.y, expanded)) return true;
        }
    }
    return false;
}

function addWildernessTrailNetwork(obstacles) {
    const trails = WILDERNESS_TRAIL_PLANS.map(plan => addTrailPath(obstacles, plan.points, plan.opts));
    for (const [trailIndex, trail] of trails.entries()) {
        const points = trail.points || [];
        for (let i = 1; i < points.length - 1; i += 2) {
            const prev = points[i - 1];
            const next = points[i + 1];
            const length = Math.max(1, Math.hypot(next.x - prev.x, next.y - prev.y));
            const side = (trailIndex + i) % 2 === 0 ? 1 : -1;
            const offset = (trail.width || 54) / 2 + 72 + Math.random() * 26;
            const dx = (-(next.y - prev.y) / length) * offset * side;
            const dy = ((next.x - prev.x) / length) * offset * side;
            const x = points[i].x + dx;
            const y = points[i].y + dy;
            if (isMapPositionBlocked(obstacles, x, y, 22)) continue;
            const variant = trail.variant === 'forest' ? 'juniper' : trail.variant === 'boardwalk' ? 'willow' : 'berry';
            addObstacle(obstacles, 'bush', x, y, 34 + Math.random() * 18, 30 + Math.random() * 15, {
                collidable: false,
                hue: variant === 'willow' ? 126 : 96 + Math.floor(Math.random() * 24),
                rotation: Math.random() * Math.PI,
                variant,
                role: 'trailEdge',
            });
            addObstacle(obstacles, i % 3 === 0 ? 'wildflowers' : 'grassTuft', x - dx * 0.42, y - dy * 0.42, 24, 22, {
                collidable: false,
                hue: 38 + ((trailIndex * 37 + i * 23) % 220),
                rotation: Math.random() * Math.PI,
                variant: i % 3 === 0 ? 'meadow' : 'trailGrass',
                role: 'trailEdge',
            });
        }

        const first = points[0];
        const second = points[1];
        if (first && second && trailIndex % 2 === 0) {
            addObstacle(obstacles, 'signpost', first.x + 34, first.y + 34, 30, 30, {
                collidable: false,
                rotation: Math.atan2(second.y - first.y, second.x - first.x),
                variant: 'trailMarker',
                role: 'trailMarker',
                label: trail.label,
            });
        }
    }
    return trails;
}

function addRiverbankDetails(obstacles, riverData) {
    for (let i = 1; i < riverData.points.length - 1; i += 2) {
        const point = riverData.points[i];
        const prev = riverData.points[i - 1];
        const next = riverData.points[i + 1];
        const length = Math.max(1, Math.hypot(next.x - prev.x, next.y - prev.y));
        const nx = -(next.y - prev.y) / length;
        const ny = (next.x - prev.x) / length;
        for (const side of [-1, 1]) {
            const bankOffset = (riverData.widths?.[i] || riverData.width) / 2 + 22 + Math.random() * 20;
            addObstacle(obstacles, 'reeds', point.x + nx * bankOffset * side, point.y + ny * bankOffset * side, 34, 30, {
                collidable: false,
                hue: 74 + Math.floor(Math.random() * 24),
                rotation: Math.atan2(next.y - prev.y, next.x - prev.x),
                variant: i % 4 === 1 ? 'cattails' : 'riverGrass',
                role: 'riverbank',
            });
        }
    }
}

function addPondDetails(obstacles) {
    const ponds = obstacles.filter(obstacle => obstacle.kind === 'water' && obstacle.variant === 'pond');
    for (const pond of ponds) {
        const count = 9;
        for (let i = 0; i < count; i++) {
            const angle = (i / count) * Math.PI * 2 + (pond.rotation || 0);
            const x = pond.x + Math.cos(angle) * (pond.w / 2 + 12);
            const y = pond.y + Math.sin(angle) * (pond.h / 2 + 10);
            addObstacle(obstacles, 'reeds', x, y, 28 + Math.random() * 12, 24 + Math.random() * 10, {
                collidable: false,
                hue: 72 + Math.floor(Math.random() * 24),
                rotation: angle + Math.PI / 2,
                variant: i % 3 === 0 ? 'cattails' : 'pondGrass',
                role: 'pondEdge',
            });
        }
    }
}

function addCanopyInfill(obstacles, worldHalf, targetCount = 80) {
    let added = 0;
    const margin = 850;
    const step = 1450;
    for (let gx = -worldHalf + margin; gx <= worldHalf - margin && added < targetCount; gx += step) {
        for (let gy = -worldHalf + margin; gy <= worldHalf - margin && added < targetCount; gy += step) {
            if (Math.hypot(gx, gy) < 1900) continue;
            for (let attempt = 0; attempt < 5; attempt++) {
                const x = clamp(gx + (Math.random() - 0.5) * 760, -worldHalf + 620, worldHalf - 620);
                const y = clamp(gy + (Math.random() - 0.5) * 760, -worldHalf + 620, worldHalf - 620);
                const size = 38 + Math.random() * 24;
                if (isMapPositionBlocked(obstacles, x, y, size / 2 + 18)) continue;
                addObstacle(obstacles, 'tree', x, y, size, size, {
                    hue: y < -4800 ? 112 : 96 + Math.floor(Math.random() * 34),
                    rotation: Math.random() * Math.PI,
                    variant: y < -4800 ? 'pine' : y > 4300 ? 'scrub' : 'grove',
                    role: 'canopyInfill',
                });
                added++;
                break;
            }
        }
    }
    return added;
}

function addNaturalDetailScatter(obstacles, worldHalf, exclusionAreas = []) {
    const bushVariants = ['bramble', 'berry', 'flowering', 'juniper'];
    const step = 650;
    const margin = 620;
    for (let gx = -worldHalf + margin; gx <= worldHalf - margin; gx += step) {
        for (let gy = -worldHalf + margin; gy <= worldHalf - margin; gy += step) {
            if (Math.random() < 0.28) continue;
            const baseX = gx + (Math.random() - 0.5) * step * 0.68;
            const baseY = gy + (Math.random() - 0.5) * step * 0.68;
            if (exclusionAreas.some(area => rectsOverlap(baseX, baseY, 80, 80, area.x, area.y, area.w + 360, area.h + 360))) continue;
            const clusterCount = Math.random() < 0.36 ? 2 : 1;
            for (let cluster = 0; cluster < clusterCount; cluster++) {
                const x = baseX + (Math.random() - 0.5) * 105;
                const y = baseY + (Math.random() - 0.5) * 105;
                const roll = Math.random();
                const size = 22 + Math.random() * 28;
                if (isMapPositionBlocked(obstacles, x, y, size / 2)) continue;

                if (roll < 0.50) {
                    const variant = bushVariants[Math.floor(Math.random() * bushVariants.length)];
                    addObstacle(obstacles, 'bush', x, y, size + 10, size, {
                        collidable: Math.random() < 0.32,
                        hue: variant === 'juniper' ? 126 : 92 + Math.floor(Math.random() * 36),
                        rotation: Math.random() * Math.PI,
                        variant,
                        role: 'naturalDetail',
                    });
                } else if (roll < 0.69) {
                    addObstacle(obstacles, 'grassTuft', x, y, size, size * 0.72, {
                        collidable: false, hue: 74 + Math.floor(Math.random() * 34),
                        rotation: Math.random() * Math.PI, variant: gy > 4300 ? 'dry' : 'meadow', role: 'naturalDetail',
                    });
                } else if (roll < 0.82) {
                    addObstacle(obstacles, 'wildflowers', x, y, size, size, {
                        collidable: false, hue: Math.floor(Math.random() * 360),
                        rotation: Math.random() * Math.PI, variant: 'meadow', role: 'naturalDetail',
                    });
                } else if (roll < 0.90) {
                    addObstacle(obstacles, 'stump', x, y, 26 + Math.random() * 15, 24 + Math.random() * 12, {
                        rotation: Math.random() * Math.PI, variant: 'mossy', role: 'naturalDetail',
                    });
                } else if (roll < 0.97) {
                    addObstacle(obstacles, 'fallenLog', x, y, 62 + Math.random() * 42, 20 + Math.random() * 8, {
                        rotation: Math.random() * Math.PI, variant: Math.random() < 0.55 ? 'mossy' : 'birch', role: 'naturalDetail',
                    });
                } else {
                    addObstacle(obstacles, 'mushrooms', x, y, 30, 26, {
                        collidable: false, hue: 18 + Math.floor(Math.random() * 28),
                        rotation: Math.random() * Math.PI, variant: 'forestRing', role: 'naturalDetail',
                    });
                }
            }
        }
    }
}

function addLandmarkTrees(obstacles, worldHalf, targetCount = 38) {
    let added = 0;
    const margin = 920;
    const step = 1480;
    for (let gx = -worldHalf + margin; gx <= worldHalf - margin && added < targetCount; gx += step) {
        for (let gy = -worldHalf + margin; gy <= worldHalf - margin && added < targetCount; gy += step) {
            if (Math.hypot(gx, gy) < 1550) continue;
            for (let attempt = 0; attempt < 5; attempt++) {
                const x = clamp(gx + (Math.random() - 0.5) * 820, -worldHalf + 520, worldHalf - 520);
                const y = clamp(gy + (Math.random() - 0.5) * 820, -worldHalf + 520, worldHalf - 520);
                const size = 82 + Math.random() * 42;
                if (isMapPositionBlocked(obstacles, x, y, size * 0.46 + 24)) continue;

                let variant = 'ancientOak';
                let hue = 104 + Math.floor(Math.random() * 18);
                if (y < -4400) {
                    variant = 'giantPine';
                    hue = 116 + Math.floor(Math.random() * 12);
                } else if (Math.abs(y + 1500) < 1400 || added % 7 === 2) {
                    variant = 'willowTree';
                    hue = 88 + Math.floor(Math.random() * 16);
                } else if ((added + Math.round(x / step)) % 4 === 0) {
                    variant = 'birch';
                    hue = 96 + Math.floor(Math.random() * 18);
                }
                addObstacle(obstacles, 'tree', x, y, size, size, {
                    hue, rotation: Math.random() * Math.PI, variant, role: 'landmarkTree',
                });
                added++;
                break;
            }
        }
    }
    return added;
}

function addWorldFurnitureDetails(obstacles) {
    const roadMarkers = [];
    const lamps = [];
    const mailboxes = [];
    const picnicTables = [];
    const benches = [];
    const networkRoads = obstacles.filter(obstacle => (
        obstacle.kind === 'road'
        && obstacle.role === 'networkRoad'
        && Math.max(obstacle.w, obstacle.h) >= 900
    ));

    // Sparse mile markers make long rotations readable without becoming
    // expensive clutter. Positions are anchored to each road segment.
    for (const [roadIndex, road] of networkRoads.entries()) {
        const horizontal = road.w > road.h;
        const length = horizontal ? road.w : road.h;
        const width = horizontal ? road.h : road.w;
        const count = Math.min(5, Math.floor(length / 1850));
        for (let index = 0; index < count; index++) {
            const axis = -length / 2 + ((index + 1) / (count + 1)) * length;
            const side = (roadIndex + index) % 2 === 0 ? -1 : 1;
            const offset = width / 2 + 42;
            const x = horizontal ? road.x + axis : road.x + side * offset;
            const y = horizontal ? road.y + side * offset : road.y + axis;
            if (isMapPositionBlocked(obstacles, x, y, 9)) continue;
            roadMarkers.push(addObstacle(obstacles, 'roadMarker', x, y, 18, 34, {
                collidable: false,
                rotation: horizontal ? 0 : Math.PI / 2,
                variant: index % 3 === 0 ? 'reflector' : 'milestone',
                role: 'roadsideDetail',
            }));
        }
    }

    const urbanTypes = new Set(['riverside', 'eastgate', 'westport', 'civic-quarter', 'motel']);
    const urbanRoads = obstacles.filter(obstacle => (
        obstacle.kind === 'road'
        && urbanTypes.has(obstacle.landmarkType)
        && Math.max(obstacle.w, obstacle.h) >= 500
    ));
    for (const [roadIndex, road] of urbanRoads.entries()) {
        const horizontal = road.w > road.h;
        const length = horizontal ? road.w : road.h;
        const width = horizontal ? road.h : road.w;
        const count = Math.min(5, Math.max(2, Math.floor(length / 430)));
        for (let index = 0; index < count; index++) {
            const axis = -length / 2 + 120 + index * Math.max(180, (length - 240) / Math.max(1, count - 1));
            const side = index % 2 === 0 ? -1 : 1;
            const offset = width / 2 + 34;
            const x = horizontal ? road.x + axis : road.x + side * offset;
            const y = horizontal ? road.y + side * offset : road.y + axis;
            if (isMapPositionBlocked(obstacles, x, y, 10)) continue;
            lamps.push(addObstacle(obstacles, 'lampPost', x, y, 22, 42, {
                collidable: false, rotation: horizontal ? 0 : Math.PI / 2,
                variant: roadIndex % 2 === 0 ? 'streetLamp' : 'industrialLamp',
                role: 'streetFurniture', landmarkType: road.landmarkType,
            }));
        }
    }

    const doorsByHouse = new Map(obstacles
        .filter(obstacle => obstacle.kind === 'door' && obstacle.entranceRole !== 'interiorDoor')
        .map(door => [door.houseId, door]));
    const mailboxHomes = obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor'
        && ['house', 'cabin', 'town', 'lodge', 'brick'].includes(obstacle.variant)
        && doorsByHouse.has(obstacle.id)
    ));
    for (let index = 0; index < mailboxHomes.length && mailboxes.length < 24; index += 5) {
        const home = mailboxHomes[index];
        const door = doorsByHouse.get(home.id);
        const side = door.role;
        const lateral = 145;
        const outward = 64;
        const x = side === 'east' ? home.x + home.w / 2 + outward
            : side === 'west' ? home.x - home.w / 2 - outward
                : door.x + (side === 'south' ? lateral : -lateral);
        const y = side === 'south' ? home.y + home.h / 2 + outward
            : side === 'north' ? home.y - home.h / 2 - outward
                : door.y + (side === 'east' ? lateral : -lateral);
        const blockedByOtherStructure = obstacles.some(obstacle => {
            if (!BLOCKED_KINDS.has(obstacle.kind) || obstacle.id === home.id || obstacle.houseId === home.id) return false;
            if (obstacle.kind === 'road' || obstacle.kind === 'trail_path') return false;
            const pad = 18;
            return x >= obstacle.x - obstacle.w / 2 - pad && x <= obstacle.x + obstacle.w / 2 + pad
                && y >= obstacle.y - obstacle.h / 2 - pad && y <= obstacle.y + obstacle.h / 2 + pad;
        });
        if (blockedByOtherStructure) continue;
        mailboxes.push(addObstacle(obstacles, 'mailbox', x, y, 28, 34, {
            collidable: false,
            rotation: side === 'east' || side === 'west' ? Math.PI / 2 : 0,
            variant: index % 2 === 0 ? 'rural' : 'painted',
            hue: 8 + (index * 17) % 210,
            role: 'homeDetail', houseId: home.id,
        }));
    }

    const landmarkTrees = obstacles.filter(obstacle => obstacle.kind === 'tree' && obstacle.role === 'landmarkTree');
    for (let index = 0; index < landmarkTrees.length && picnicTables.length < 8; index += 5) {
        const tree = landmarkTrees[index];
        const angle = (index * 2.399) % (Math.PI * 2);
        const distance = Math.max(tree.w, tree.h) / 2 + 112;
        const x = tree.x + Math.cos(angle) * distance;
        const y = tree.y + Math.sin(angle) * distance;
        if (isMapPositionBlocked(obstacles, x, y, 34)) continue;
        picnicTables.push(addObstacle(obstacles, 'picnicTable', x, y, 70, 48, {
            collidable: false, rotation: angle, variant: 'wood', role: 'scenicDetail',
        }));
        const benchX = x - Math.sin(angle) * 96;
        const benchY = y + Math.cos(angle) * 96;
        if (!isMapPositionBlocked(obstacles, benchX, benchY, 28)) {
            benches.push(addObstacle(obstacles, 'bench', benchX, benchY, 62, 26, {
                collidable: false, rotation: angle, variant: 'park', role: 'scenicDetail',
            }));
        }
    }

    return {
        roadMarkers: roadMarkers.length,
        lamps: lamps.length,
        mailboxes: mailboxes.length,
        picnicTables: picnicTables.length,
        benches: benches.length,
    };
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
    // Keep the river organic without letting a random seed swing it hundreds
    // of units into curated districts. The old 550-unit wander could put the
    // east farm, Eastgate houses, and their roads directly in the water.
    const wander = Math.min(220, worldHalf * 0.022);
    for (let i = 1; i < segments; i++) {
        const t = i / segments;
        const baseX = startX + (endX - startX) * t;
        const baseY = startY + (endY - startY) * t;
        const envelope = Math.sin(Math.PI * t);
        // The broad northward arc keeps the middle channel above Riverside,
        // before the endpoint bends south beneath the east farm and Eastgate.
        const routeArcY = envelope * Math.min(600, worldHalf * 0.06);
        const lateral = (
            Math.sin(t * Math.PI * 2.4 + phase) * 0.72
            + Math.sin(t * Math.PI * 5.2 + phase * 0.63) * 0.22
        ) * wander * envelope;
        points.push({
            x: baseX + normalX * lateral,
            y: baseY + routeArcY + normalY * lateral,
        });
    }
    points.push({ x: endX, y: endY });
    return points;
}

function addRiver(obstacles, worldHalf, startX, startY, endX, endY, width = 220) {
    const points = generateRiverPath(worldHalf, startX, startY, endX, endY, 20);
    const widthPhase = Math.random() * Math.PI * 2;
    const widths = points.map((point, index) => {
        const t = index / Math.max(1, points.length - 1);
        return width * (0.94 + Math.sin(t * Math.PI * 3.2 + widthPhase) * 0.12 + Math.sin(t * Math.PI * 7.4) * 0.045);
    });
    const maxWidth = Math.max(...widths);
    const bounds = pathBounds(points, maxWidth / 2 + 12);

    // A path-sized bounding box keeps the static spline visible to clients near
    // any part of the river, instead of only near its western start point.
    addObstacle(obstacles, 'river_path', bounds.x, bounds.y, bounds.w, bounds.h, {
        collidable: false,
        variant: 'river_path',
        points,
        width,
        widths,
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
        const segWidth = (widths[i] + widths[i + 1]) / 2;
        
        // These are just for physics now (we won't render them directly on client)
        addObstacle(obstacles, 'river', mx, my, segLen + width * 0.5, segWidth, {
            collidable: false,
            variant: 'river',
            rotation: angle,
        });
        riverSegments.push({ x: mx, y: my, w: segLen + width * 0.5, h: segWidth, angle });
    }
    return { points, segments: riverSegments, width, widths };
}

function addBridge(obstacles, x, y, width, length, rotation = 0) {
    // Road surface
    addObstacle(obstacles, 'bridge', x, y, length, width, {
        collidable: false,
        variant: 'bridge',
        rotation,
        role: 'roadBridge',
    });
    // Collision rails use the exact same transform as the deck. The client
    // draws them as part of the bridge sprite, so they stay visually welded to
    // the bridge while remaining server-authoritative barriers.
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const railOffset = width / 2 - 8;
    addObstacle(obstacles, 'wall', x - sin * railOffset, y + cos * railOffset, length, 12, {
        collidable: true,
        destructible: false,
        rotation,
        variant: 'bridgeRail',
        hue: 210,
        role: 'bridgeRail',
    });
    addObstacle(obstacles, 'wall', x + sin * railOffset, y - cos * railOffset, length, 12, {
        collidable: true,
        destructible: false,
        rotation,
        variant: 'bridgeRail',
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
                riverWidth: (riverData.widths?.[i] ?? riverData.width) * (1 - t)
                    + (riverData.widths?.[i + 1] ?? riverData.width) * t,
            };
            if (!crossing || candidate.distance < crossing.distance) crossing = candidate;
        }
        if (crossing && crossing.distance < 2200) {
            addBridge(
                obstacles,
                crossing.x,
                crossing.y,
                (rp.width || 120) + 20,
                crossing.riverWidth + 150,
                rp.rotation ?? Math.PI / 2,
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
    'tree', 'bush', 'rock', 'stump', 'fallenLog', 'signpost', 'hayBale', 'reeds', 'grassTuft', 'wildflowers', 'mushrooms', 'crate', 'barrel', 'container', 'sandbag', 'tent',
    'lampPost', 'bench', 'mailbox', 'roadMarker', 'picnicTable',
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
    const networkRoads = obstacles.filter(obstacle => obstacle.kind === 'road' && obstacle.role === 'networkRoad');
    const approaches = obstacles
        .filter(obstacle => obstacle.kind === 'door' && obstacle.entranceRole !== 'interiorDoor')
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
        const blocksNetworkRoad = !obstacle.houseId && networkRoads.some(road => rectsOverlap(
            obstacle.x, obstacle.y, obstacle.w, obstacle.h,
            road.x, road.y, road.w + 16, road.h + 16,
        ));
        if (blocksDoor || embeddedInBuilding || blocksNetworkRoad) obstacles.splice(i, 1);
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

    if (areaOverlapsPlannedTrail(x, y, w, h, buffer)) return true;

    // 4. Check POI overlap
    for (const poi of poiList) {
        if (rectsOverlap(x, y, w, h, poi.x, poi.y, poi.w + buffer * 2, poi.h + buffer * 2)) {
            return true;
        }
    }
    return false;
}

const SPARSE_FILL_KINDS = new Set([
    'houseFloor', 'tree', 'bush', 'rock', 'stump', 'fallenLog', 'hayBale',
    'crate', 'barrel', 'sandbag', 'tent', 'water',
]);

function addSparseAreaFill(obstacles, loot, spawnPoints, worldHalf, placedPositions) {
    const candidates = [];
    const step = 1800;
    const sampleRadius = step * 0.48;
    const margin = 1100;

    for (let x = -worldHalf + margin; x <= worldHalf - margin; x += step) {
        for (let y = -worldHalf + margin; y <= worldHalf - margin; y += step) {
            if (Math.hypot(x, y) < 1650) continue;
            let houses = 0;
            let details = 0;
            for (const obstacle of obstacles) {
                if (!SPARSE_FILL_KINDS.has(obstacle.kind)) continue;
                if (Math.abs(obstacle.x - x) > sampleRadius || Math.abs(obstacle.y - y) > sampleRadius) continue;
                if (obstacle.kind === 'houseFloor') houses++;
                else details++;
            }
            candidates.push({ x, y, houses, details, score: houses * 12 + details });
        }
    }

    // Fill the emptiest cells first. A stable coordinate tie-break keeps the
    // overall distribution broad even though individual props remain varied.
    candidates.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x);
    let housesAdded = 0;
    let detailClustersAdded = 0;
    const houseLimit = 20;
    const detailClusterLimit = 22;

    for (const candidate of candidates) {
        if (housesAdded >= houseLimit && detailClustersAdded >= detailClusterLimit) break;
        const preferHouse = housesAdded < houseLimit
            && candidate.houses === 0
            && (candidate.details < 14 || detailClustersAdded >= detailClusterLimit);

        for (let attempt = 0; attempt < 7; attempt++) {
            const x = clamp(candidate.x + (Math.random() - 0.5) * 620, -worldHalf + 760, worldHalf - 760);
            const y = clamp(candidate.y + (Math.random() - 0.5) * 620, -worldHalf + 760, worldHalf - 760);
            const areaW = preferHouse ? 620 : 440;
            const areaH = preferHouse ? 560 : 440;
            const buffer = preferHouse ? 145 : 80;
            if (isAreaOverlapping(x, y, areaW, areaH, buffer, placedPositions)) continue;
            if (isMapPositionBlocked(obstacles, x, y, preferHouse ? 155 : 48)) continue;

            if (preferHouse) {
                addStandaloneHouse(obstacles, loot, spawnPoints, x, y);
                placedPositions.push({ x, y, w: areaW, h: areaH });
                housesAdded++;
            } else if (detailClustersAdded < detailClusterLimit) {
                const placed = addOpenFieldScatter(obstacles, x, y, {
                    radius: 135 + Math.random() * 75,
                    count: 4 + Math.floor(Math.random() * 4),
                    variant: y < -4800 ? 'pine' : y > 4200 ? 'scrub' : 'grass',
                });
                if (placed <= 0) continue;
                placedPositions.push({ x, y, w: areaW, h: areaH });
                detailClustersAdded++;
            }
            break;
        }
    }

    return { housesAdded, detailClustersAdded };
}

const GAP_COVER_KINDS = new Set([
    'houseFloor', 'tree', 'bush', 'rock', 'stump', 'fallenLog', 'hayBale',
    'crate', 'barrel', 'container', 'sandbag', 'tent', 'picnicTable',
]);
const GAP_BLOCKED_SURFACE_KINDS = new Set(['road', 'water', 'river', 'houseFloor']);

function pointToObstacleDistance(x, y, obstacle) {
    const angle = -(Number(obstacle.rotation) || 0);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = x - obstacle.x;
    const dy = y - obstacle.y;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const outsideX = Math.max(0, Math.abs(localX) - (obstacle.w || 0) / 2);
    const outsideY = Math.max(0, Math.abs(localY) - (obstacle.h || 0) / 2);
    return Math.hypot(outsideX, outsideY);
}

function isGapSampleBlocked(blockedSurfaces, x, y) {
    return blockedSurfaces.some(obstacle => (
        GAP_BLOCKED_SURFACE_KINDS.has(obstacle.kind)
        && pointToObstacleDistance(x, y, obstacle) < 95
    ));
}

function addGapCoverCluster(obstacles, x, y, variant) {
    // Every gap cluster deliberately mixes hard and soft cover. This keeps open
    // crossings interesting instead of creating another group of only trees.
    const kinds = ['tree', 'rock', 'tree', 'bush', 'tree', 'rock'];
    kinds.push(Math.random() < 0.52 ? 'fallenLog' : 'stump');
    if (Math.random() < 0.58) kinds.push('tree');
    let placed = 0;

    for (let index = 0; index < kinds.length; index++) {
        const kind = kinds[index];
        for (let attempt = 0; attempt < 12; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = index === 0 ? Math.random() * 38 : 58 + Math.random() * 165;
            const ox = x + Math.cos(angle) * radius;
            const oy = y + Math.sin(angle) * radius;
            const size = kind === 'fallenLog'
                ? 72 + Math.random() * 42
                : kind === 'tree' ? 38 + Math.random() * 48 : 30 + Math.random() * 38;
            const width = size;
            const height = kind === 'rock'
                ? 26 + Math.random() * 26
                : kind === 'fallenLog' ? 20 + Math.random() * 8 : size;
            if (isMapPositionBlocked(obstacles, ox, oy, Math.max(width, height) / 2 + 8)) continue;

            const treeVariant = variant === 'pine'
                ? (Math.random() < 0.22 ? 'giantPine' : 'pine')
                : Math.random() < 0.16 ? 'birch'
                    : Math.random() < 0.08 ? 'ancientOak' : variant;
            addObstacle(obstacles, kind, ox, oy, width, height, {
                hue: kind === 'rock' ? 212 + Math.floor(Math.random() * 26) : 96 + Math.floor(Math.random() * 36),
                rotation: Math.random() * Math.PI,
                collidable: kind === 'bush' ? Math.random() > 0.35 : true,
                variant: kind === 'fallenLog' ? (Math.random() < 0.55 ? 'mossy' : 'birch')
                    : kind === 'stump' ? (Math.random() < 0.55 ? 'mossy' : 'cut')
                        : kind === 'tree' ? treeVariant : variant,
                role: 'gapCover',
            });
            placed++;
            break;
        }
    }

    return placed;
}

function addAdaptiveGapFill(obstacles, loot, spawnPoints, worldHalf, placedPositions) {
    const cover = obstacles.filter(obstacle => GAP_COVER_KINDS.has(obstacle.kind));
    const houses = obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
    const blockedSurfaces = obstacles.filter(obstacle => GAP_BLOCKED_SURFACE_KINDS.has(obstacle.kind));
    const candidates = [];
    const step = 440;
    const margin = 600;

    for (let x = -worldHalf + margin; x <= worldHalf - margin; x += step) {
        for (let y = -worldHalf + margin; y <= worldHalf - margin; y += step) {
            if (isGapSampleBlocked(blockedSurfaces, x, y)) continue;
            let nearestCover = Infinity;
            for (const obstacle of cover) {
                nearestCover = Math.min(nearestCover, pointToObstacleDistance(x, y, obstacle));
                if (nearestCover <= 410) break;
            }
            if (nearestCover <= 410) continue;

            let nearestHouse = Infinity;
            for (const house of houses) {
                nearestHouse = Math.min(nearestHouse, pointToObstacleDistance(x, y, house));
            }
            candidates.push({ x, y, nearestCover, nearestHouse });
        }
    }

    candidates.sort((a, b) => b.nearestCover - a.nearestCover || a.y - b.y || a.x - b.x);
    const anchors = [];
    let housesAdded = 0;
    let clustersAdded = 0;
    const houseLimit = 18;
    const clusterLimit = 82;

    for (const candidate of candidates) {
        if (housesAdded >= houseLimit && clustersAdded >= clusterLimit) break;
        if (anchors.some(anchor => Math.hypot(anchor.x - candidate.x, anchor.y - candidate.y) < 380)) continue;

        const preferHouse = housesAdded < houseLimit
            && candidate.nearestCover > 560
            && candidate.nearestHouse > 720;
        let completed = false;
        for (let attempt = 0; attempt < 8 && !completed; attempt++) {
            const x = clamp(candidate.x + (Math.random() - 0.5) * 170, -worldHalf + 700, worldHalf - 700);
            const y = clamp(candidate.y + (Math.random() - 0.5) * 170, -worldHalf + 700, worldHalf - 700);

            const tryingHouse = preferHouse && attempt < 4;
            if (tryingHouse) {
                const areaW = 600;
                const areaH = 540;
                // Candidate distance already excludes finished POIs and other
                // houses. Keep the actual road/river/trail checks here without
                // reusing broad planning boxes that cover otherwise empty land.
                if (isAreaOverlapping(x, y, areaW, areaH, 105, [])) continue;
                if (houses.some(house => rectsOverlap(
                    x, y, areaW, areaH,
                    house.x, house.y, house.w + 300, house.h + 300,
                ))) continue;
                if (isMapPositionBlocked(obstacles, x, y, 150)) continue;
                const obstacleCountBeforeHouse = obstacles.length;
                addStandaloneHouse(obstacles, loot, spawnPoints, x, y);
                placedPositions.push({ x, y, w: areaW, h: areaH });
                const addedHouse = obstacles
                    .slice(obstacleCountBeforeHouse)
                    .find(obstacle => obstacle.kind === 'houseFloor');
                if (addedHouse) {
                    addedHouse.role = 'gapHouse';
                    houses.push(addedHouse);
                    blockedSurfaces.push(addedHouse);
                }
                housesAdded++;
                completed = true;
            } else if (clustersAdded < clusterLimit) {
                if (isGapSampleBlocked(blockedSurfaces, x, y)) continue;
                const placed = addGapCoverCluster(
                    obstacles,
                    x,
                    y,
                    y < -4800 ? 'pine' : y > 4200 ? 'scrub' : 'grass',
                );
                if (placed < 3) continue;
                placedPositions.push({ x, y, w: 420, h: 420 });
                clustersAdded++;
                completed = true;
            }

            if (completed) anchors.push({ x, y });
        }
    }

    return { housesAdded, clustersAdded };
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
    const northCachePos = { x: 700, y: -7200, w: 620, h: 420 };
    const eastCachePos = { x: 8600, y: 3600, w: 620, h: 420 };
    const southCachePos = { x: -1200, y: 8500, w: 620, h: 420 };
    const checkpointPos = { x: 4100, y: -2700, w: 620, h: 420 };
    const servicesPos = { x: -700, y: -4000, w: 1480, h: 820 };
    const fireStationPos = { x: 3350, y: 4300, w: 1500, h: 1050 };
    const orchardPos = { x: -3900, y: 5000, w: 1900, h: 1280 };
    const motelPos = { x: 6000, y: -5200, w: 1700, h: 1180 };
    const rangerLodgePos = { x: -4700, y: -8000, w: 1600, h: 1100 };
    const lumberworksPos = { x: 5200, y: 8200, w: 1750, h: 1200 };
    const riversidePos = { x: -600, y: -2700, w: 2240, h: 1540 };
    const eastgatePos = { x: 5200, y: -300, w: 2240, h: 1540 };
    const westportPos = { x: -7000, y: 200, w: 1940, h: 1420 };
    const railDepotPos = { x: 700, y: 8200, w: 1860, h: 1320 };
    const civicQuarterPos = { x: -900, y: 3600, w: 1900, h: 1500 };

    const POI_LIST = [
        mansionPos, militaryPos, hospitalPos, villaPos, yardPos,
        quarryPos, prisonPos, towerPos, townPos, gasPos,
        farmPos, bunkerPos, campPos, neTownPos, seLabPos,
        swTownPos, nwMansionPos, ironworksPos, marketPos,
        northCachePos, eastCachePos, southCachePos, checkpointPos,
        servicesPos, fireStationPos, orchardPos,
        motelPos, rangerLodgePos, lumberworksPos,
        riversidePos, eastgatePos, westportPos, railDepotPos, civicQuarterPos,
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
    addSettlement(obstacles, loot, spawnPoints, townPos.x, townPos.y, 11, 'town');
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
    addHouse(obstacles, loot, spawnPoints, bunkerPos.x - 430, bunkerPos.y - 200, 260, 200, {
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
        { x: campPos.x, y: campPos.y + 720, pond: true },
    ];
    for (const site of forestCampSites) {
        if (site.pond) addPondSite(obstacles, loot, spawnPoints, site.x, site.y);
        else addMicroSite(obstacles, loot, spawnPoints, site.x, site.y, 'wetlands');
    }
    addForest(obstacles, loot, spawnPoints, campPos.x, campPos.y, 24, 1050);
    landmarks.push({ name: 'West Forest Camp', x: campPos.x, y: campPos.y, type: 'camp' });

    // NE Town
    addSettlement(obstacles, loot, spawnPoints, neTownPos.x, neTownPos.y, 10, 'town');
    landmarks.push({ name: 'NE Town', x: neTownPos.x, y: neTownPos.y, type: 'town' });

    // SE Lab
    addResearchCampus(obstacles, loot, spawnPoints, seLabPos.x, seLabPos.y);
    landmarks.push({ name: 'SE Lab', x: seLabPos.x, y: seLabPos.y, type: 'lab' });

    // SW Town
    addSettlement(obstacles, loot, spawnPoints, swTownPos.x, swTownPos.y, 10, 'town');
    landmarks.push({ name: 'SW Town', x: swTownPos.x, y: swTownPos.y, type: 'town' });

    // NW Mansion
    addMansion(obstacles, loot, spawnPoints, nwMansionPos.x, nwMansionPos.y);
    landmarks.push({ name: 'NW Mansion', x: nwMansionPos.x, y: nwMansionPos.y, type: 'mansion' });

    // Large indoor landmark with multiple rotations and a direct highway apron.
    addIronworks(obstacles, loot, spawnPoints, ironworksPos.x, ironworksPos.y);
    landmarks.push({ name: 'Ironworks', x: ironworksPos.x, y: ironworksPos.y, type: 'ironworks' });

    addMarketVillage(obstacles, loot, spawnPoints, marketPos.x, marketPos.y);
    landmarks.push({ name: 'Grand Market', x: marketPos.x, y: marketPos.y, type: 'market' });

    addSupplyCacheSite(obstacles, loot, spawnPoints, northCachePos.x, northCachePos.y, 'supply');
    landmarks.push({ name: 'North Ranger Cache', x: northCachePos.x, y: northCachePos.y, type: 'supply-cache' });
    addSupplyCacheSite(obstacles, loot, spawnPoints, eastCachePos.x, eastCachePos.y, 'medical');
    landmarks.push({ name: 'East Aid Station', x: eastCachePos.x, y: eastCachePos.y, type: 'supply-cache' });
    addSupplyCacheSite(obstacles, loot, spawnPoints, southCachePos.x, southCachePos.y, 'armory');
    landmarks.push({ name: 'South Smuggler Cache', x: southCachePos.x, y: southCachePos.y, type: 'supply-cache' });
    addSupplyCacheSite(obstacles, loot, spawnPoints, checkpointPos.x, checkpointPos.y, 'checkpoint');
    landmarks.push({ name: 'East Road Checkpoint', x: checkpointPos.x, y: checkpointPos.y, type: 'supply-cache' });

    addRoadsideServices(obstacles, loot, spawnPoints, servicesPos.x, servicesPos.y);
    landmarks.push({ name: 'Crossroads Services', x: servicesPos.x, y: servicesPos.y, type: 'services' });
    addFireStation(obstacles, loot, spawnPoints, fireStationPos.x, fireStationPos.y);
    landmarks.push({ name: 'South Fire Station', x: fireStationPos.x, y: fireStationPos.y, type: 'fire-station' });
    addOrchardCooperative(obstacles, loot, spawnPoints, orchardPos.x, orchardPos.y);
    landmarks.push({ name: 'Old Orchard Cooperative', x: orchardPos.x, y: orchardPos.y, type: 'orchard' });

    addSunsetMotel(obstacles, loot, spawnPoints, motelPos.x, motelPos.y);
    landmarks.push({ name: 'Sunset Motel', x: motelPos.x, y: motelPos.y, type: 'motel' });
    addRangerLodge(obstacles, loot, spawnPoints, rangerLodgePos.x, rangerLodgePos.y);
    landmarks.push({ name: 'Cedar Ranger Lodge', x: rangerLodgePos.x, y: rangerLodgePos.y, type: 'ranger-lodge' });
    addLumberWorks(obstacles, loot, spawnPoints, lumberworksPos.x, lumberworksPos.y);
    landmarks.push({ name: 'South Lumberworks', x: lumberworksPos.x, y: lumberworksPos.y, type: 'lumberworks' });

    addUrbanBorough(obstacles, loot, spawnPoints, riversidePos.x, riversidePos.y, {
        landmarkType: 'riverside', label: 'RIVERSIDE BOROUGH', baseHue: 10,
        roadVariant: 'cobblestone',
        buildingLabels: ['RIVER CAFE', 'ROW HOMES', 'BAKERY', 'WATCH HOUSE', 'APARTMENTS', 'THE ANCHOR', 'WORKSHOP', 'BOARDING HOUSE'],
    });
    landmarks.push({ name: 'Riverside Borough', x: riversidePos.x, y: riversidePos.y, type: 'riverside' });
    addUrbanBorough(obstacles, loot, spawnPoints, eastgatePos.x, eastgatePos.y, {
        landmarkType: 'eastgate', label: 'EASTGATE', baseHue: 20,
        roadVariant: 'service',
        variants: ['brick', 'house', 'brick', 'lodge', 'house', 'brick', 'garage', 'brick'],
        buildingLabels: ['GROCERY', 'EASTGATE HOMES', 'PHARMACY', 'APARTMENTS', 'DINER', 'LAUNDRY', 'AUTO GARAGE', 'ROW HOMES'],
    });
    landmarks.push({ name: 'Eastgate District', x: eastgatePos.x, y: eastgatePos.y, type: 'eastgate' });
    addWestportVillage(obstacles, loot, spawnPoints, westportPos.x, westportPos.y);
    landmarks.push({ name: 'Westport Village', x: westportPos.x, y: westportPos.y, type: 'westport' });
    addRailDepot(obstacles, loot, spawnPoints, railDepotPos.x, railDepotPos.y);
    landmarks.push({ name: 'South Rail Depot', x: railDepotPos.x, y: railDepotPos.y, type: 'rail-depot' });
    addCivicQuarter(obstacles, loot, spawnPoints, civicQuarterPos.x, civicQuarterPos.y);
    landmarks.push({ name: 'Civic Quarter', x: civicQuarterPos.x, y: civicQuarterPos.y, type: 'civic-quarter' });

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
    // Secondary cross-map routes reduce the long empty rotations in the outer rings.
    addRoad(obstacles, -wh * 0.9, -6100, wh * 0.9, -6100, roadW);
    addRoad(obstacles, -wh * 0.9, 6200, wh * 0.9, 6200, roadW);

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
    addRoad(obstacles, marketPos.x, 2000, marketPos.x, marketPos.y + 550, roadW); // Grand Market main street
    addRoad(obstacles, motelPos.x, -4000, motelPos.x, motelPos.y + 590, roadW); // Sunset Motel approach
    addRoad(obstacles, -2500, rangerLodgePos.y + 500, rangerLodgePos.x + 800, rangerLodgePos.y + 500, roadW); // Ranger lodge forest road
    addRoad(obstacles, 2500, lumberworksPos.y + 520, lumberworksPos.x - 875, lumberworksPos.y + 520, roadW); // Lumberworks freight road
    addRoad(obstacles, riversidePos.x, -4000, riversidePos.x, riversidePos.y, roadW); // Riverside cross street
    addRoad(obstacles, 2500, eastgatePos.y, eastgatePos.x - 1120, eastgatePos.y, roadW); // Eastgate avenue
    addRoad(obstacles, -2500, westportPos.y + 80, westportPos.x + 920, westportPos.y + 80, roadW); // Westport road
    addRoad(obstacles, railDepotPos.x - 920, 6200, railDepotPos.x - 920, railDepotPos.y, roadW); // Rail depot approach
    addRoad(obstacles, -2500, civicQuarterPos.y + 50, civicQuarterPos.x - 900, civicQuarterPos.y + 50, roadW); // Civic boulevard

    // SW Town's south cobblestone lane already reaches the cross-map highway.
    // A second center driveway used to cut straight through a residence.
    addObstacle(obstacles, 'road', campPos.x, -3900, roadW, 200, {
        collidable: false, variant: 'dirt', role: 'path', landmarkType: 'camp',
    });
    addObstacle(obstacles, 'road', bunkerPos.x + 50, 7490, 220, roadW, {
        collidable: false, variant: 'dirt', role: 'driveway', landmarkType: 'bunker',
    });
    addObstacle(obstacles, 'road', bunkerPos.x - 10, 7555, 100, 130, {
        collidable: false, variant: 'dirt', role: 'driveway', landmarkType: 'bunker',
    });

    // Only discard tiny clipping fragments. The previous 1020-unit threshold
    // erased legitimate final approaches to several landmarks.
    removeShortNetworkRoadStubs(obstacles, roadW * 1.1);
    addRoadJunctions(obstacles);

    // ─────────────────────────────────────────────────────────────────────────
    // RIVERS & BRIDGES (Aligned with N-S highways)
    // ─────────────────────────────────────────────────────────────────────────
    const riverEW = addRiver(obstacles, wh,
        -wh * 0.9, -wh * 0.18,
         wh * 0.9, -wh * 0.24,
        210 + Math.random() * 60);

    // Bridges placed exactly where the two N-S highways cross the river (around y ≈ -1500)
    addBridgesAlongRiver(obstacles, riverEW, [
        { x: -2500, y: -1500, width: roadW, rotation: Math.PI / 2 },
        { x: 2500, y: -1500, width: roadW, rotation: Math.PI / 2 },
    ]);
    addRiverbankDetails(obstacles, riverEW);
    addPondDetails(obstacles);

    addWildernessTrailNetwork(obstacles);
    addLandmarkTrees(obstacles, wh);
    addWorldFurnitureDetails(obstacles);

    // ─────────────────────────────────────────────────────────────────────────
    // BIOME COVER & ROAD MARKERS
    // ─────────────────────────────────────────────────────────────────────────
    const roadReservations = obstacles
        .filter(obstacle => obstacle.kind === 'road' && obstacle.role === 'networkRoad')
        .map(road => ({ x: road.x, y: road.y, w: road.w, h: road.h }));
    // Later filler houses and hamlets must reserve the real curved river, not
    // an old hard-coded horizontal estimate. Axis-aligned segment bounds are
    // deliberately padded to leave a readable shoreline around buildings.
    const riverReservations = riverEW.segments.map(segment => {
        const cos = Math.abs(Math.cos(segment.angle));
        const sin = Math.abs(Math.sin(segment.angle));
        const padding = 110;
        return {
            x: segment.x,
            y: segment.y,
            w: cos * segment.w + sin * segment.h + padding * 2,
            h: sin * segment.w + cos * segment.h + padding * 2,
        };
    });
    const placedPositions = [...POI_LIST, ...roadReservations, ...riverReservations];
    // Curated hamlets create recognizable rotations between major POIs. They
    // replace the old density fallback that sprinkled isolated houses anywhere.
    const hamletPlans = [
        { x: -1200, y: 7600, orientation: 'vertical' },
        { x: 1200, y: -6900, orientation: 'horizontal' },
        { x: 4200, y: -8300, orientation: 'vertical' },
        { x: 7000, y: 3000, orientation: 'horizontal' },
        { x: 700, y: 3600, orientation: 'horizontal' },
        { x: 1500, y: 1000, orientation: 'horizontal' },
        { x: -4000, y: 500, orientation: 'horizontal' },
        { x: -4300, y: 3000, orientation: 'horizontal' },
        { x: 4000, y: 7000, orientation: 'horizontal' },
        { x: -3500, y: -2000, orientation: 'horizontal' },
        { x: 8500, y: 1000, orientation: 'vertical' },
        { x: -6500, y: 8500, orientation: 'horizontal' },
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
    const fillStep = 2350;
    const fillMargin = 1550;
    for (let gx = -wh + fillMargin; gx <= wh - fillMargin; gx += fillStep) {
        for (let gy = -wh + fillMargin; gy <= wh - fillMargin; gy += fillStep) {
            const x = clamp(gx + (Math.random() - 0.5) * 1050, -wh + 1200, wh - 1200);
            const y = clamp(gy + (Math.random() - 0.5) * 1050, -wh + 1200, wh - 1200);
            
            if (Math.hypot(x, y) < 2000) continue;
            
            if (isAreaOverlapping(x, y, 1000, 820, 320, placedPositions)) continue;
            
            placedPositions.push({ x, y, w: 1000, h: 820 });
            const roll = Math.random();
            if (roll < 0.62) {
                addStandaloneHouse(obstacles, loot, spawnPoints, x, y);
            } else if (roll < 0.88) {
                addMicroSite(obstacles, loot, spawnPoints, x, y, 'grass');
            } else {
                addCoverPatch(obstacles, loot, spawnPoints, x, y, { radius: 260, variant: 'woods' });
            }
        }
    }

    // Countryside scatter: loose trees and occasional single houses so the long crossings
    // still feel natural without turning every open field into a dense compound.
    let countrysideHouses = 0;
    const countrysideHouseLimit = 28;
    const scatterStep = 1250;
    const scatterMargin = 950;
    for (let gx = -wh + scatterMargin; gx <= wh - scatterMargin; gx += scatterStep) {
        for (let gy = -wh + scatterMargin; gy <= wh - scatterMargin; gy += scatterStep) {
            if (Math.random() < 0.08) continue;
            const x = clamp(gx + (Math.random() - 0.5) * 620, -wh + 760, wh - 760);
            const y = clamp(gy + (Math.random() - 0.5) * 620, -wh + 760, wh - 760);

            if (Math.hypot(x, y) < 1700) continue;
            if (isAreaOverlapping(x, y, 330, 330, 115, placedPositions)) continue;

            if (countrysideHouses < countrysideHouseLimit && Math.random() < 0.23) {
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

    // Add small points of interest only where the completed layout is still sparse.
    addSparseAreaFill(obstacles, loot, spawnPoints, wh, placedPositions);
    addCanopyInfill(obstacles, wh);
    addNaturalDetailScatter(obstacles, wh, POI_LIST);
    addAdaptiveGapFill(obstacles, loot, spawnPoints, wh, placedPositions);
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
        reloadAmount: 0,
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
    const ammoType = definition.ammoType;
    const available = Math.max(0, Number(inventory.ammoReserves[ammoType]) || 0);
    const missing = Math.max(0, definition.clipSize - (Number(weapon.ammo) || 0));
    const reloadAmount = Math.min(missing, available);
    if (reloadAmount <= 0) return false;
    inventory.ammoReserves[ammoType] -= reloadAmount;
    weapon.reloadAmount = reloadAmount;
    weapon.reloading = true;
    weapon.reloadEndAt = now + definition.reloadMs;
    return true;
}

function finishSurvivReload(entity) {
    const weapon = entity?.weapon;
    const definition = WEAPONS[weapon?.type];
    if (!weapon || !definition) return false;
    const amount = Math.max(0, Number(weapon.reloadAmount) || 0);
    weapon.reloading = false;
    weapon.reloadEndAt = 0;
    weapon.reloadAmount = 0;
    weapon.ammo = Math.min(definition.clipSize, (Number(weapon.ammo) || 0) + amount);
    return amount > 0;
}

function makeAmmoReserves() {
    return Object.fromEntries(SURVIV_AMMO_TYPES.map(ammoType => [ammoType, 0]));
}

function makeInventory() {
    return {
        // Firearms only. The third slot is a replaceable melee weapon.
        weapons: [],
        meleeWeapon: 'fists',
        medkits: 0,
        ammoReserves: makeAmmoReserves(),
        grenades: 0,
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
        if (weapon === 'fists' || weapon === 'knife' || !WEAPONS[weapon]) continue;
        validWeapons.push(weapon);
        validSlotAmmo.push(currentSlotAmmo[index]);
    }
    entity.inventory.weapons = validWeapons;
    entity.inventory.meleeWeapon = entity.inventory.meleeWeapon === 'knife' ? 'knife' : 'fists';
    if (Array.isArray(entity.weaponSlotAmmo)) entity.weaponSlotAmmo = validSlotAmmo;
    entity.inventory.medkits = Math.max(0, Math.min(SURVIV_MAX_MEDKITS, Number(entity.inventory.medkits) || 0));
    if (!entity.inventory.ammoReserves || typeof entity.inventory.ammoReserves !== 'object') {
        entity.inventory.ammoReserves = makeAmmoReserves();
        const legacyPacks = Math.max(0, Number(entity.inventory.ammoPacks) || 0);
        if (legacyPacks > 0) {
            const legacyType = WEAPONS[entity.weapon?.type]?.ammoType || '9mm';
            entity.inventory.ammoReserves[legacyType] = legacyPacks * SURVIV_AMMO[legacyType].pickup;
        }
    }
    for (const ammoType of SURVIV_AMMO_TYPES) {
        entity.inventory.ammoReserves[ammoType] = Math.max(0, Math.min(
            SURVIV_AMMO[ammoType].max,
            Math.floor(Number(entity.inventory.ammoReserves[ammoType]) || 0),
        ));
    }
    delete entity.inventory.ammoPacks;
    entity.inventory.grenades = Math.max(0, Math.min(SURVIV_MAX_GRENADES, Number(entity.inventory.grenades) || 0));
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
    if (contents.ammoType && contents.ammoAmount && SURVIV_AMMO[contents.ammoType]) {
        items.push({ key: 'ammo', kind: 'ammo', label: `${SURVIV_AMMO[contents.ammoType].label} Ammo`, ammoType: contents.ammoType, color: SURVIV_AMMO[contents.ammoType].color, value: Number(contents.ammoAmount) });
    }
    if (contents.grenades) {
        items.push({ key: 'grenades', kind: 'grenade', label: 'Grenade', value: Number(contents.grenades) });
    }
    if (contents.armor) {
        items.push({ key: 'armor', kind: 'armor', label: 'Armor', value: Number(contents.armor) });
    }
    return items;
}

function isContainerEmpty(contents = {}) {
    return !contents.money && !contents.weaponType && !contents.medkits && !contents.ammoAmount && !contents.grenades && !contents.armor;
}

function applyLootContents(entity, contents = {}, options = {}) {
    const inv = ensureInventory(entity);
    const summary = {
        money: 0,
        medkits: 0,
        armor: 0,
        ammoType: null,
        ammoAmount: 0,
        grenades: 0,
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
    if (contents.ammoType && contents.ammoAmount && SURVIV_AMMO[contents.ammoType]) {
        const ammoType = contents.ammoType;
        const amount = Math.max(0, Math.min(Number(contents.ammoAmount) || 0, SURVIV_AMMO[ammoType].max - inv.ammoReserves[ammoType]));
        summary.ammoType = ammoType;
        summary.ammoAmount = amount;
        inv.ammoReserves[ammoType] += amount;
    }
    if (contents.grenades) {
        const grenades = Math.max(0, Math.min(Number(contents.grenades) || 0, SURVIV_MAX_GRENADES - inv.grenades));
        summary.grenades = grenades;
        inv.grenades += grenades;
    }
    if (contents.weaponType && WEAPONS[contents.weaponType]) {
        const def = WEAPONS[contents.weaponType];
        if (def.melee) {
            if (contents.weaponType === 'knife' && inv.meleeWeapon !== 'knife') {
                inv.meleeWeapon = 'knife';
                summary.weaponType = 'knife';
                summary.weaponLabel = def.label;
            }
            return summary;
        }
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
    if (nextDef.melee) {
        if (nextType !== 'knife' || inv.meleeWeapon === 'knife') return false;
        inv.meleeWeapon = 'knife';
        removeSurvivLootAt(room, candidate.index);
        entity.activeWeaponSlot = SURVIV_MELEE_SLOT;
        entity.weapon = makeWeaponState('knife');
        entity.lastLoot = {
            id: `ground-knife:${entity.id}:${Date.now()}`,
            type: 'ground',
            tier: nextDef.rarity,
            source: 'ground',
            items: { weaponType: 'knife', weaponLabel: nextDef.label },
            pickedAt: Date.now(),
        };
        return true;
    }
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
        entity.weapon = makeWeaponState(inv.meleeWeapon || 'fists');
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
            entity.weapon = makeWeaponState(inv.meleeWeapon || 'fists');
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
    room._pendingKillFeed = [];
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
        aimDistance: 300,
        shooting: false,
        _receivedFirePressId: 0,
        _releasedFirePressId: 0,
        _pendingFirePressId: null,
        // Enabled as soon as a real network input packet is received. Engine
        // tests and legacy callers can still use the older held-state path.
        _usesQueuedFireInput: false,
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
        toggleDoorId: null,
        openChestId: null,
        chestHoldId: null,
        chestHoldStartedAt: 0,
        chestHoldSeenAt: 0,
        lastLoot: null,
        openedContainerId: null,
        openedContainer: null,
        takeChestItem: null,
    };
}

export function applySurvivFireInput(entity, shooting, firePressId) {
    if (!entity) return false;
    const pressed = shooting === true;
    const parsedId = Number(firePressId);
    if (!Number.isSafeInteger(parsedId) || parsedId < 0) {
        // Compatibility for older clients that do not send press ids.
        entity.shooting = pressed;
        entity._usesQueuedFireInput = false;
        return false;
    }

    entity._usesQueuedFireInput = true;
    const receivedId = Number.isSafeInteger(entity._receivedFirePressId)
        ? entity._receivedFirePressId
        : -1;

    // Ignore packets from an older press completely. Also ignore a delayed
    // down packet for an id whose up packet already arrived; this was the
    // source of the extra final melee swing after a click sequence.
    if (parsedId < receivedId
        || (pressed && parsedId === entity._releasedFirePressId)) return false;

    if (parsedId > receivedId) {
        entity._receivedFirePressId = parsedId;
        entity.firePressId = parsedId;
        if (pressed) entity._pendingFirePressId = parsedId;
    }

    if (!pressed) {
        entity._releasedFirePressId = Math.max(Number(entity._releasedFirePressId) || 0, parsedId);
    }
    entity.shooting = pressed;
    return pressed && parsedId > receivedId;
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

function getObstacleAabbHalfExtents(obstacle) {
    const halfW = Math.abs(Number(obstacle.w) || 0) / 2;
    const halfH = Math.abs(Number(obstacle.h) || 0) / 2;
    if (obstacle.kind === 'door') {
        // The spatial index is static between map revisions, while a door can
        // swing to either side of either hinge. Index its complete swing
        // envelope so bullets and players can still find the moved leaf.
        const length = Math.max(halfW * 2, halfH * 2);
        const thickness = Math.min(halfW * 2, halfH * 2);
        const swingExtent = length + thickness / 2;
        return { halfW: swingExtent, halfH: swingExtent };
    }
    const rotation = Number(obstacle.rotation) || 0;
    if (Math.abs(rotation) < 1e-9) return { halfW, halfH };
    const cos = Math.abs(Math.cos(rotation));
    const sin = Math.abs(Math.sin(rotation));
    return {
        halfW: cos * halfW + sin * halfH,
        halfH: sin * halfW + cos * halfH,
    };
}

function insertObstacleInGrid(grid, obstacle) {
    const { halfW, halfH } = getObstacleAabbHalfExtents(obstacle);
    const minX = Math.floor((obstacle.x - halfW) / SURVIV_OBSTACLE_CELL);
    const maxX = Math.floor((obstacle.x + halfW) / SURVIV_OBSTACLE_CELL);
    const minY = Math.floor((obstacle.y - halfH) / SURVIV_OBSTACLE_CELL);
    const maxY = Math.floor((obstacle.y + halfH) / SURVIV_OBSTACLE_CELL);
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
                const { halfW, halfH } = getObstacleAabbHalfExtents(o);
                if (Math.abs(o.x - x) <= range + halfW
                    && Math.abs(o.y - y) <= range + halfH) {
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

function recordSolidObjectImpact(attacker, obstacle) {
    if (!attacker || !obstacle) return;
    attacker._objectImpactSequence = (Number(attacker._objectImpactSequence) || 0) + 1;
    attacker._objectImpact = {
        id: `${attacker.id}:${attacker._objectImpactSequence}`,
        x: obstacle.x,
        y: obstacle.y,
        kind: obstacle.kind || 'object',
        variant: obstacle.variant || null,
    };
}

function damageSurvivObstacle(room, obstacle, damage, attacker = null) {
    if (!obstacle || !(damage > 0)) return false;
    const durability = getDestructibleObstacleHp(obstacle);
    if (!durability) {
        recordSolidObjectImpact(attacker, obstacle);
        return false;
    }
    obstacle.hp = Math.max(0, durability.hp - damage);
    markSurvivObstaclesChanged(room);
    if (obstacle.hp > 0) return false;

    const index = room.obstacles.indexOf(obstacle);
    if (index >= 0) room.obstacles.splice(index, 1);
    if (index >= 0 && obstacle.kind === 'crate') {
        const droppedCrate = makeChest(obstacle.x, obstacle.y, 'common', null, 'map', {
            containerType: obstacle.variant === 'industrial' ? 'supply_crate' : 'wood_crate',
            houseId: obstacle.houseId || null,
            room: obstacle.roomId || null,
        });
        addSurvivLoot(room, droppedCrate);
        breakLootContainer(attacker, room, droppedCrate);
    }
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

function isSolidLootContainer(item) {
    return item?.type === 'chest' || item?.type === 'deathCrate';
}

function getLootContainerHitRadius(item) {
    return Number(item?.hitRadius)
        || CONTAINER_PROFILES[item?.containerType]?.hitRadius
        || 24;
}

function resolveCircleLootContainer(cx, cy, radius, item, fallbackDx = 1, fallbackDy = 0) {
    const itemRadius = getLootContainerHitRadius(item);
    const dx = cx - item.x;
    const dy = cy - item.y;
    const distance = Math.hypot(dx, dy);
    const minimumDistance = radius + itemRadius;
    if (distance >= minimumDistance) return { x: cx, y: cy };
    if (distance < 0.0001) {
        const fallback = normalize(-fallbackDx, -fallbackDy);
        const pushX = fallback.dx || 1;
        const pushY = fallback.dy || 0;
        return { x: item.x + pushX * minimumDistance, y: item.y + pushY * minimumDistance };
    }
    const scale = minimumDistance / distance;
    return { x: item.x + dx * scale, y: item.y + dy * scale };
}

function addSurvivLoot(room, item) {
    room.loot.push(normalizeAmmoGroundLoot(item));
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
    for (const { item } of querySurvivLoot(room, x, y, r + 32)) {
        if (!isSolidLootContainer(item)) continue;
        if (dist(x, y, item.x, item.y) < r + getLootContainerHitRadius(item)) return true;
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
    for (const { item } of querySurvivLoot(room, x, y, radius + 32)) {
        if (!isSolidLootContainer(item)) continue;
        if (dist(x, y, item.x, item.y) < radius + getLootContainerHitRadius(item)) return false;
    }
    return true;
}

function getNearbyObstacles(room, x, y, range) {
    return queryObstacles(room, x, y, range, true);
}

function getEntitySurfaceKind(room, entity) {
    const nearby = queryObstacles(room, entity.x, entity.y, 40, false);
    // A bridge must override the river pieces beneath it or crossing a bridge
    // would incorrectly slow the player and play water footsteps.
    if (nearby.some(obstacle => obstacle.kind === 'bridge' && pointInRect(entity.x, entity.y, obstacle))) {
        return 'ground';
    }
    const inWater = nearby.some(obstacle => {
        if (obstacle.kind === 'river') return pointInRect(entity.x, entity.y, obstacle);
        if (obstacle.kind !== 'water') return false;
        if (obstacle.variant !== 'pond') return pointInRect(entity.x, entity.y, obstacle);
        const rx = Math.max(1, obstacle.w * 0.46);
        const ry = Math.max(1, obstacle.h * 0.46);
        const nx = (entity.x - obstacle.x) / rx;
        const ny = (entity.y - obstacle.y) / ry;
        return nx * nx + ny * ny <= 1;
    });
    if (inWater) return 'water';
    if (nearby.some(obstacle => obstacle.kind === 'houseFloor' && pointInRect(entity.x, entity.y, obstacle))) {
        return 'indoor';
    }
    return 'ground';
}

function moveEntity(entity, room, dx, dy, speed) {
    const inputX = Number(dx) || 0;
    const inputY = Number(dy) || 0;
    const inputLength = Math.hypot(inputX, inputY);
    const inputMagnitude = Math.min(1, inputLength);
    const nx = inputLength > 0.0001 ? inputX / inputLength : 0;
    const ny = inputLength > 0.0001 ? inputY / inputLength : 0;
    let newX = entity.x + nx * speed * inputMagnitude;
    let newY = entity.y + ny * speed * inputMagnitude;

    const r = entity.radius || SURVIV.playerRadius;
    const wh = SURVIV.worldHalf - r;
    newX = clamp(newX, -wh, wh);
    newY = clamp(newY, -wh, wh);

    for (const o of getNearbyObstacles(room, newX, newY, 220)) {
        const collisionShape = o.kind === 'door' ? getSurvivDoorCollisionRect(o) : o;
        if (circleRectCollision(newX, newY, r, collisionShape)) {
            // Bots should understand doorways instead of getting pinned against
            // a closed door forever. Human players deliberately use F.
            if (o.kind === 'door' && entity.isBot && !o.isOpen) {
                o.openDirection = getDoorOpenDirection(entity, o);
                o.isOpen = true;
                o.doorChangedAt = Date.now();
                markSurvivObstaclesChanged(room);
                continue;
            }
            const resolved = resolveCircleRect(newX, newY, r, collisionShape);
            newX = resolved.x;
            newY = resolved.y;
        }
    }

    for (const { item } of querySurvivLoot(room, newX, newY, r + 40)) {
        if (!isSolidLootContainer(item)) continue;
        const resolved = resolveCircleLootContainer(newX, newY, r, item, nx, ny);
        newX = resolved.x;
        newY = resolved.y;
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
        entity.meleeAttackId = (Number(entity.meleeAttackId) || 0) + 1;
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
            const collisionShape = obstacle.kind === 'door' ? getSurvivDoorCollisionRect(obstacle) : obstacle;
            const local = toRectLocal(entity.x, entity.y, collisionShape);
            const contactPoint = fromRectLocal(
                clamp(local.x, -collisionShape.w / 2, collisionShape.w / 2),
                clamp(local.y, -collisionShape.h / 2, collisionShape.h / 2),
                collisionShape,
            );
            const obstacleDistance = dist(entity.x, entity.y, contactPoint.x, contactPoint.y);
            if (obstacleDistance > wDef.meleeReach) continue;
            const obstacleAngle = Math.atan2(contactPoint.y - entity.y, contactPoint.x - entity.x);
            const angleDelta = Math.abs(Math.atan2(Math.sin(obstacleAngle - baseAngle), Math.cos(obstacleAngle - baseAngle)));
            if (angleDelta > wDef.meleeArc) continue;
            if (obstacleDistance < closestDistance) {
                closest = null;
                closestObstacle = obstacle;
                closestDistance = obstacleDistance;
            }
        }
        let closestContainer = null;
        for (const { item } of querySurvivLoot(room, entity.x, entity.y, wDef.meleeReach + 64)) {
            if (item.type !== 'chest' && item.type !== 'deathCrate') continue;
            const hitRadius = Number(item.hitRadius) || CONTAINER_PROFILES[item.containerType]?.hitRadius || 24;
            const containerDistance = Math.max(0, dist(entity.x, entity.y, item.x, item.y) - hitRadius);
            if (containerDistance > wDef.meleeReach) continue;
            const containerAngle = Math.atan2(item.y - entity.y, item.x - entity.x);
            const angleDelta = Math.abs(Math.atan2(Math.sin(containerAngle - baseAngle), Math.cos(containerAngle - baseAngle)));
            if (angleDelta > wDef.meleeArc) continue;
            if (containerDistance < closestDistance) {
                closest = null;
                closestObstacle = null;
                closestContainer = item;
                closestDistance = containerDistance;
            }
        }
        if (closestContainer) {
            damageLootContainer(room, closestContainer, wDef.damage, entity);
        } else if (closestObstacle) {
            damageSurvivObstacle(room, closestObstacle, wDef.damage, entity);
        } else if (closest) {
            applyDamage(closest, wDef.damage, entity);
            if (closest.hp <= 0) eliminateSurvivPlayer(room, closest, room._io, entity);
        }
        return;
    }

    if (w.reloading) {
        if (now >= w.reloadEndAt) {
            finishSurvivReload(entity);
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
            maxDistance: wDef.range || wDef.bulletSpeed * TICK_RATE * (SURVIV.bulletLifetimeMs / 1000),
            distanceTravelled: 0,
            bornAt: now,
        });
    }
}

function applyDamage(target, damage, attacker, source = null) {
    const hpBefore = Number(target.hp) || 0;
    let remaining = damage;
    if (target.armor > 0) {
        const absorbed = Math.min(target.armor, remaining * 0.7);
        target.armor -= absorbed;
        remaining -= absorbed * 0.5;
    }
    target.hp -= remaining;
    const damageDealt = Math.max(0, hpBefore - target.hp);
    if (damageDealt > 0 && attacker && attacker.id !== target.id) {
        const previous = attacker._hitConfirm;
        const sameTarget = previous?.targetId === target.id;
        attacker._hitConfirm = {
            targetId: target.id,
            targetX: target.x,
            targetY: target.y,
            damage: damageDealt + (sameTarget ? Number(previous.damage) || 0 : 0),
            kill: target.hp <= 0,
        };
        const sourceX = Number.isFinite(source?.x) ? source.x : attacker.x;
        const sourceY = Number.isFinite(source?.y) ? source.y : attacker.y;
        const sourceKind = source?.kind || 'player';
        const previousDamage = target._damageTaken;
        const sameSource = previousDamage?.sourceId === attacker.id && previousDamage?.kind === sourceKind;
        target._damageTaken = {
            sourceId: attacker.id,
            sourceX,
            sourceY,
            kind: sourceKind,
            damage: damageDealt + (sameSource ? Number(previousDamage.damage) || 0 : 0),
        };
    }
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
    if (inventory.meleeWeapon === 'knife') drops.push({ type: 'weapon', weaponType: 'knife', tier: WEAPONS.knife.rarity });
    if (inventory.medkits > 0) drops.push({ type: 'medkit', amount: inventory.medkits });
    for (const ammoType of SURVIV_AMMO_TYPES) {
        const amount = Math.max(0, Number(inventory.ammoReserves[ammoType]) || 0);
        if (amount > 0) drops.push({ type: 'ammo', ammoType, amount });
    }
    if (inventory.grenades > 0) drops.push({ type: 'grenade', amount: inventory.grenades });
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
    inventory.ammoReserves = makeAmmoReserves();
    inventory.grenades = 0;
    inventory.meleeWeapon = 'fists';
}

export function eliminateSurvivPlayer(room, player, io, attacker = null) {
    if (player._eliminated) return;
    player._eliminated = true;
    const eliminatedDollarBalance = Number(player.dollarBalance) || 0;
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
    if (!Array.isArray(room._pendingKillFeed)) room._pendingKillFeed = [];
    room._pendingKillFeed.push({
        id: 'kill:' + player.id + ':' + Date.now() + ':' + randId(),
        killer: attacker?.username || (attacker?.isBot ? 'Bot' : 'Zone'),
        victim: player.username || (player.isBot ? 'Bot' : 'Player'),
        weapon: attacker?.weapon?.type || (attacker ? 'fists' : 'zone'),
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
        Promise.resolve(room.onHumanEliminated?.(player, {
            attacker,
            dollarBalance: eliminatedDollarBalance,
        })).catch(error => console.error('Surviv elimination callback failed:', error));
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

function getContainerDropSurface(item, room) {
    if (!item.houseId) return null;
    const roomZones = (room.obstacles || []).filter(obstacle => (
        obstacle.kind === 'roomZone'
        && obstacle.houseId === item.houseId
        && (!item.room || obstacle.variant === item.room)
    ));
    const containingRoom = roomZones.find(zone => {
        const local = toRectLocal(item.x, item.y, zone);
        return Math.abs(local.x) <= zone.w / 2 && Math.abs(local.y) <= zone.h / 2;
    });
    if (containingRoom) return containingRoom;
    return (room.obstacles || []).find(obstacle => (
        obstacle.kind === 'houseFloor' && obstacle.id === item.houseId
    )) || null;
}

function clampPointToRectInset(x, y, rect, inset) {
    const local = toRectLocal(x, y, rect);
    const halfW = Math.max(0, rect.w / 2 - inset);
    const halfH = Math.max(0, rect.h / 2 - inset);
    return fromRectLocal(clamp(local.x, -halfW, halfW), clamp(local.y, -halfH, halfH), rect);
}

function isContainerDropPositionClear(room, x, y) {
    return !queryObstacles(room, x, y, 34, true).some(obstacle => (
        obstacle.kind !== 'houseFloor'
        && obstacle.kind !== 'roomZone'
        && obstacle.kind !== 'door'
        && circleRectCollision(x, y, 14, obstacle)
    ));
}

function findContainerDropPosition(item, room, angle, scatter) {
    const surface = getContainerDropSurface(item, room);
    if (!surface) {
        return {
            x: item.x + Math.cos(angle) * scatter,
            y: item.y + Math.sin(angle) * scatter,
        };
    }

    // Search inward around the intended throw direction. Clamping every candidate
    // to the same convex room/floor also keeps the complete flight path indoors.
    const angleOffsets = [0, 0.42, -0.42, 0.84, -0.84, 1.26, -1.26, Math.PI];
    const radii = [scatter, scatter * 0.76, scatter * 0.52, 22, 10];
    for (const radius of radii) {
        for (const offset of angleOffsets) {
            const candidate = clampPointToRectInset(
                item.x + Math.cos(angle + offset) * radius,
                item.y + Math.sin(angle + offset) * radius,
                surface,
                22,
            );
            if (isContainerDropPositionClear(room, candidate.x, candidate.y)) return candidate;
        }
    }
    return clampPointToRectInset(item.x, item.y, surface, 22);
}
function breakLootContainer(entity, room, item) {
    if (!item || (item.type !== 'chest' && item.type !== 'deathCrate')) return false;
    const index = room.loot.indexOf(item);
    if (index < 0) return false;
    const now = Date.now();
    const contents = item.contents || {};
    const drops = [];
    if (contents.weaponType && WEAPONS[contents.weaponType]) {
        drops.push({
            type: 'weapon',
            weaponType: contents.weaponType,
            ammo: Number.isFinite(contents.ammo) ? contents.ammo : WEAPONS[contents.weaponType].clipSize,
            tier: WEAPONS[contents.weaponType].rarity || contents.rarity || item.tier || 'common',
        });
    }
    if (Number(contents.money) > 0) drops.push({ type: 'money', dollarValue: Number(contents.money) });
    if (Number(contents.medkits) > 0) drops.push({ type: 'medkit', amount: Number(contents.medkits) });
    if (contents.ammoType && Number(contents.ammoAmount) > 0) {
        drops.push({ type: 'ammo', ammoType: contents.ammoType, amount: Number(contents.ammoAmount) });
    }
    if (Number(contents.grenades) > 0) drops.push({ type: 'grenade', amount: Number(contents.grenades) });
    if (Number(contents.armor) > 0) drops.push({ type: 'armor', armorValue: Number(contents.armor) });

    removeSurvivLootAt(room, index);
    drops.forEach((drop, dropIndex) => {
        const angle = (dropIndex / Math.max(1, drops.length)) * Math.PI * 2 + Math.random() * 0.3;
        const scatter = 42 + Math.random() * 18;
        const landing = findContainerDropPosition(item, room, angle, scatter);
        addSurvivLoot(room, makeGroundLoot(drop.type, landing.x, landing.y, {
            ...drop,
            source: item.source === 'death' ? 'death' : 'chest',
            tier: drop.tier || item.tier || contents.rarity || 'common',
            pickupAfter: now + 700,
            spawnedAt: now,
            spawnX: item.x,
            spawnY: item.y,
            burstIndex: dropIndex,
            burstCount: drops.length,
            houseId: item.houseId || null,
            room: item.room || null,
        }));
    });
    if (entity) {
        ensureInventory(entity).chestsOpened += 1;
        entity.openedContainerId = null;
        entity.openedContainer = null;
    }
    return true;
}

function damageLootContainer(room, item, damage, attacker = null) {
    if (!item || (item.type !== 'chest' && item.type !== 'deathCrate') || !(damage > 0)) return false;
    const containerType = CONTAINER_PROFILES[item.containerType] ? item.containerType : 'wood_crate';
    const profile = CONTAINER_PROFILES[containerType];
    const maxHp = Number.isFinite(item.maxHp) ? Math.max(1, item.maxHp) : profile.hp;
    const hp = Number.isFinite(item.hp) ? item.hp : maxHp;
    item.containerType = containerType;
    item.maxHp = maxHp;
    item.hitRadius = Number.isFinite(item.hitRadius) ? item.hitRadius : profile.hitRadius;
    item.hp = Math.max(0, hp - damage);
    markSurvivLootChanged(room);
    return item.hp <= 0 ? breakLootContainer(attacker, room, item) : false;
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
    } else if (itemKey === 'ammo' && contents.ammoType && contents.ammoAmount) {
        picked = { ammoType: contents.ammoType, ammoAmount: contents.ammoAmount, rarity: contents.rarity };
    } else if (itemKey === 'grenades' && contents.grenades) {
        picked = { grenades: contents.grenades, rarity: contents.rarity };
    } else if (itemKey === 'armor' && contents.armor) {
        picked = { armor: contents.armor, rarity: contents.rarity };
    }
    if (!picked) return;

    // A chest weapon can be dropped directly onto a firearm slot. When that
    // slot is occupied, exchange the two weapons instead of silently refusing
    // the take because the backpack is full.
    const targetSlot = Number.isInteger(request.targetSlot) ? request.targetSlot : null;
    if (itemKey === 'weapon' && targetSlot != null && !WEAPONS[contents.weaponType]?.melee) {
        const inv = ensureInventory(entity);
        if (targetSlot >= 0 && targetSlot < inv.weapons.length) {
            saveActiveWeaponAmmo(entity);
            const slotAmmo = ensureWeaponSlotAmmo(entity);
            const outgoingType = inv.weapons[targetSlot];
            const outgoingAmmo = slotAmmo[targetSlot] ?? 0;
            const incomingType = contents.weaponType;
            const incomingAmmo = Number.isFinite(contents.ammo)
                ? Math.max(0, Number(contents.ammo))
                : WEAPONS[incomingType].clipSize;

            inv.weapons[targetSlot] = incomingType;
            slotAmmo[targetSlot] = incomingAmmo;
            contents.weaponType = outgoingType;
            contents.ammo = outgoingAmmo;
            contents.rarity = WEAPONS[outgoingType]?.rarity || 'common';
            if (entity.activeWeaponSlot === targetSlot) {
                entity.weapon = makeWeaponState(incomingType);
                entity.weapon.ammo = incomingAmmo;
            }
            syncLegacyWeaponAmmo(entity);
            entity.lastLoot = {
                id: item.id + ':weapon-swap:' + Date.now(),
                chestId: item.id,
                type: item.type,
                tier: item.tier,
                source: item.source,
                items: { weaponType: incomingType, weaponLabel: WEAPONS[incomingType].label },
                openedAt: Date.now(),
            };
            entity.openedContainerId = item.id;
            refreshOpenedContainer(entity, room);
            return;
        }
    }
    // A normal click on a full firearm inventory must not replace a gun by
    // accident. The UI sends targetSlot when the player intentionally drops
    // the chest weapon on a slot to exchange it.
    if (itemKey === 'weapon' && !WEAPONS[contents.weaponType]?.melee && ensureInventory(entity).weapons.length >= SURVIV_MAX_WEAPONS) {
        refreshOpenedContainer(entity, room);
        return;
    }
    const summary = applyLootContents(entity, picked, { countChest: false });
    if (summary.weaponType) {
        delete contents.weaponType;
        delete contents.ammo;
    }
    if (summary.money > 0) contents.money = Math.max(0, Number(contents.money || 0) - summary.money);
    if (summary.medkits > 0) contents.medkits = Math.max(0, Number(contents.medkits || 0) - summary.medkits);
    if (summary.ammoAmount > 0) contents.ammoAmount = Math.max(0, Number(contents.ammoAmount || 0) - summary.ammoAmount);
    if (summary.grenades > 0) contents.grenades = Math.max(0, Number(contents.grenades || 0) - summary.grenades);
    if (summary.armor > 0) contents.armor = Math.max(0, Number(contents.armor || 0) - summary.armor);
    for (const key of ['money', 'medkits', 'ammoAmount', 'grenades', 'armor']) {
        if (!(Number(contents[key]) > 0)) delete contents[key];
    }
    if (!contents.ammoAmount) delete contents.ammoType;
    const accepted = !!summary.weaponType || summary.money > 0 || summary.medkits > 0 || summary.ammoAmount > 0 || summary.grenades > 0 || summary.armor > 0;
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
        if (requestedSlot === SURVIV_MELEE_SLOT) {
            if (inv.meleeWeapon === 'knife' && !contents.weaponType) {
                inv.meleeWeapon = 'fists';
                if (entity.activeWeaponSlot === SURVIV_MELEE_SLOT) entity.weapon = makeWeaponState('fists');
                contents.weaponType = 'knife';
                contents.rarity = WEAPONS.knife.rarity;
            }
            refreshOpenedContainer(entity, room);
            return;
        }
        const fallbackType = request.weaponType || (entity.weapon?.type !== 'fists' ? entity.weapon?.type : null);
        const slotIndex = requestedSlot >= 0 ? requestedSlot : inv.weapons.indexOf(fallbackType);
        // Swapping a chest weapon is an explicit drag-and-drop action. Do not
        // exchange it merely because a legacy click request omitted slotIdx.
        if (contents.weaponType && (requestedSlot < 0 || slotIndex >= inv.weapons.length)) {
            refreshOpenedContainer(entity, room);
            return;
        }
        if (contents.weaponType && slotIndex >= 0 && slotIndex < inv.weapons.length) {
            saveActiveWeaponAmmo(entity);
            const slotAmmo = ensureWeaponSlotAmmo(entity);
            const outgoingType = inv.weapons[slotIndex];
            const outgoingAmmo = slotAmmo[slotIndex] ?? 0;
            const incomingType = contents.weaponType;
            const incomingAmmo = Number.isFinite(contents.ammo)
                ? Math.max(0, Number(contents.ammo))
                : WEAPONS[incomingType].clipSize;

            inv.weapons[slotIndex] = incomingType;
            slotAmmo[slotIndex] = incomingAmmo;
            contents.weaponType = outgoingType;
            contents.ammo = outgoingAmmo;
            contents.rarity = WEAPONS[outgoingType]?.rarity || 'common';
            if (entity.activeWeaponSlot === slotIndex) {
                entity.weapon = makeWeaponState(incomingType);
                entity.weapon.ammo = incomingAmmo;
            }
            syncLegacyWeaponAmmo(entity);
        } else {
            const removed = !contents.weaponType ? removeWeaponSlot(entity, slotIndex) : null;
            if (removed?.weaponType) {
                contents.weaponType = removed.weaponType;
                contents.ammo = removed.ammo;
                contents.rarity = WEAPONS[removed.weaponType]?.rarity || 'common';
            }
        }
    } else if (itemKey === 'medkits' && inv.medkits > 0) {
        inv.medkits -= 1;
        contents.medkits = (contents.medkits || 0) + 1;
    } else if (itemKey === 'ammo' && SURVIV_AMMO[request.ammoType]) {
        const ammoType = request.ammoType;
        if (contents.ammoType && contents.ammoType !== ammoType) {
            refreshOpenedContainer(entity, room);
            return;
        }
        const transfer = Math.min(SURVIV_AMMO[ammoType].pickup, inv.ammoReserves[ammoType]);
        if (transfer > 0) {
            inv.ammoReserves[ammoType] -= transfer;
            contents.ammoType = ammoType;
            contents.ammoAmount = (contents.ammoAmount || 0) + transfer;
        }
    } else if (itemKey === 'grenades' && inv.grenades > 0) {
        inv.grenades -= 1;
        contents.grenades = (contents.grenades || 0) + 1;
    } else if (itemKey === 'armor' && entity.armor > 0) {
        const transfer = Math.min(35, Math.round(entity.armor));
        entity.armor = Math.max(0, entity.armor - transfer);
        contents.armor = (contents.armor || 0) + transfer;
    }

    refreshOpenedContainer(entity, room);
}

function throwSurvivGrenade(entity, room, now) {
    if (entity.isCashingOut || entity.hp <= 0) return false;
    const inventory = ensureInventory(entity);
    if (inventory.grenades <= 0) return false;
    inventory.grenades -= 1;
    const angle = entity.aimAngle ?? entity.angle ?? 0;
    const throwDistance = clamp(
        Number(entity.aimDistance) || 300,
        SURVIV.grenadeMinRange,
        SURVIV.grenadeMaxRange,
    );
    const spawnOffset = SURVIV.playerRadius + 8;
    const flightTicks = Math.max(1, Math.round(SURVIV.grenadeFuseMs / (1000 / TICK_RATE)));
    const drag = 0.96;
    const travelMultiplier = (1 - Math.pow(drag, flightTicks)) / (1 - drag);
    const throwSpeed = Math.max(1, (throwDistance - spawnOffset) / travelMultiplier);
    room.bullets.push({
        id: randId(),
        ownerId: entity.id,
        ownerIsBot: !!entity.isBot,
        x: entity.x + Math.cos(angle) * spawnOffset,
        y: entity.y + Math.sin(angle) * spawnOffset,

        vx: Math.cos(angle) * throwSpeed,
        vy: Math.sin(angle) * throwSpeed,
        throwDistance,
        damage: SURVIV.grenadeDamage,
        weaponType: 'grenade',
        isGrenade: true,
        bornAt: now,
        detonateAt: now + SURVIV.grenadeFuseMs,
    });
    return true;
}

function detonateGrenade(room, grenade, entitiesById) {
    const allEntities = [...room.players.filter(player => !player.cashoutSettling), ...room.bots];
    const attacker = entitiesById.get(grenade.ownerId) || null;
    for (const target of allEntities) {
        if (target.hp <= 0 || target._eliminated) continue;
        const distance = dist(grenade.x, grenade.y, target.x, target.y);
        if (distance > SURVIV.grenadeRadius) continue;
        const proximity = clamp(1 - distance / SURVIV.grenadeRadius, 0, 1);
        const minimumDamage = SURVIV.grenadeMinDamage;
        const blastDamage = minimumDamage
            + (grenade.damage - minimumDamage) * Math.pow(proximity, SURVIV.grenadeFalloffExponent);
        applyDamage(target, blastDamage, attacker, { x: grenade.x, y: grenade.y, kind: 'grenade' });
        if (target.hp <= 0) eliminateSurvivPlayer(room, target, room._io, attacker);
    }
    for (const obstacle of queryObstacles(room, grenade.x, grenade.y, SURVIV.grenadeRadius, true)) {
        if (!getDestructibleObstacleHp(obstacle)) continue;
        const distance = Math.max(0, dist(grenade.x, grenade.y, obstacle.x, obstacle.y) - Math.max(obstacle.w || 0, obstacle.h || 0) / 2);
        if (distance <= SURVIV.grenadeRadius) damageSurvivObstacle(room, obstacle, Math.max(12, grenade.damage * (1 - distance / SURVIV.grenadeRadius)), attacker);
    }
    for (const { item } of querySurvivLoot(room, grenade.x, grenade.y, SURVIV.grenadeRadius + 32)) {
        if (item.type !== 'chest' && item.type !== 'deathCrate') continue;
        const hitRadius = Number(item.hitRadius) || CONTAINER_PROFILES[item.containerType]?.hitRadius || 24;
        const distance = Math.max(0, dist(grenade.x, grenade.y, item.x, item.y) - hitRadius);
        if (distance <= SURVIV.grenadeRadius) {
            damageLootContainer(room, item, Math.max(12, grenade.damage * (1 - distance / SURVIV.grenadeRadius)), attacker);
        }
    }
}

function swapSurvivWeaponSlots(entity) {
    const request = entity.swapWeaponSlots;
    if (!request) return;
    entity.swapWeaponSlots = null;
    const fromSlot = Number(request.fromSlot);
    const toSlot = Number(request.toSlot);
    if (!Number.isInteger(fromSlot) || !Number.isInteger(toSlot) || fromSlot === toSlot) return;

    const inv = ensureInventory(entity);
    if (fromSlot < 0 || toSlot < 0 || fromSlot >= inv.weapons.length || toSlot >= inv.weapons.length) return;
    saveActiveWeaponAmmo(entity);
    const slotAmmo = ensureWeaponSlotAmmo(entity);
    [inv.weapons[fromSlot], inv.weapons[toSlot]] = [inv.weapons[toSlot], inv.weapons[fromSlot]];
    [slotAmmo[fromSlot], slotAmmo[toSlot]] = [slotAmmo[toSlot], slotAmmo[fromSlot]];
    if (entity.activeWeaponSlot === fromSlot) entity.activeWeaponSlot = toSlot;
    else if (entity.activeWeaponSlot === toSlot) entity.activeWeaponSlot = fromSlot;
    syncLegacyWeaponAmmo(entity);
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
        if (idx === SURVIV_MELEE_SLOT) {
            if (inv.meleeWeapon !== 'knife') return;
            inv.meleeWeapon = 'fists';
            entity.activeWeaponSlot = SURVIV_MELEE_SLOT;
            entity.weapon = makeWeaponState('fists');
            addSurvivLoot(room, makeGroundLoot('weapon', dropX, dropY, {
                weaponType: 'knife',
                tier: WEAPONS.knife.rarity,
                source: 'player-drop',
                pickupAfter: Date.now() + 900,
            }));
            return;
        }
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
    } else if (itemKey === 'ammo' && SURVIV_AMMO[request.ammoType]) {
        const ammoType = request.ammoType;
        const amount = Math.min(SURVIV_AMMO[ammoType].pickup, inv.ammoReserves[ammoType]);
        if (amount <= 0) return;
        inv.ammoReserves[ammoType] -= amount;
        addSurvivLoot(room, makeGroundLoot('ammo', dropX, dropY, { ammoType, amount, source: 'player-drop', pickupAfter: Date.now() + 900 }));
    } else if (itemKey === 'grenades' && inv.grenades > 0) {
        inv.grenades -= 1;
        addSurvivLoot(room, makeGroundLoot('grenade', dropX, dropY, { amount: 1, source: 'player-drop', pickupAfter: Date.now() + 900 }));
    } else if (itemKey === 'armor' && entity.armor > 0) {
        const transfer = Math.min(35, Math.round(entity.armor));
        entity.armor = Math.max(0, entity.armor - transfer);
        addSurvivLoot(room, makeGroundLoot('armor', dropX, dropY, { armorValue: transfer, source: 'player-drop', pickupAfter: Date.now() + 900 }));
    }
}

function pickupLoot(entity, room) {
    if (entity.isCashingOut) return;
    swapSurvivWeaponSlots(entity);
    dropPlayerItem(entity, room);

    const pickedUp = {
        money: 0,
        medkits: 0,
        armor: 0,
        ammoType: null,
        ammoAmount: 0,
        grenades: 0,
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
        normalizeAmmoGroundLoot(item);
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
            if (item.type === 'ammo' && SURVIV_AMMO[item.ammoType]) { requested = { ammoType: item.ammoType, ammoAmount: Math.max(1, Number(item.amount) || 1) }; quantityKey = 'ammoAmount'; }
            if (item.type === 'grenade') { requested = { grenades: Math.max(1, Number(item.amount) || 1) }; quantityKey = 'grenades'; }
            if (item.type === 'weapon' && item.weaponType && WEAPONS[item.weaponType]) requested = { weaponType: item.weaponType };
            if (!requested) continue;

            const accepted = applyLootContents(entity, requested, { countChest: false });
            const acceptedAmount = accepted.money || accepted.medkits || accepted.armor || accepted.ammoAmount || accepted.grenades || (accepted.weaponType ? 1 : 0);
            if (!(acceptedAmount > 0)) continue;
            pickedUp.money += accepted.money;
            pickedUp.medkits += accepted.medkits;
            pickedUp.armor += accepted.armor;
            if (accepted.ammoAmount > 0) {
                pickedUp.ammoType = accepted.ammoType;
                pickedUp.ammoAmount += accepted.ammoAmount;
            }
            pickedUp.grenades = (pickedUp.grenades || 0) + accepted.grenades;
            if (accepted.weaponType) {
                pickedUp.weaponType = accepted.weaponType;
                pickedUp.weaponLabel = accepted.weaponLabel;
            }

            let remaining = 0;
            if (quantityKey) remaining = Math.max(0, Number(requested[quantityKey]) - Number(accepted[quantityKey]));
            if (remaining > 0) {
                if (item.type === 'medkit' || item.type === 'ammo' || item.type === 'grenade') item.amount = remaining;
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
    const allEntities = [...room.players.filter(player => !player.cashoutSettling), ...room.bots];
    const entitiesById = new Map(allEntities.map(entity => [entity.id, entity]));
    for (let i = room.bullets.length - 1; i >= 0; i--) {
        const bullet = room.bullets[i];
        const previousX = bullet.x;
        const previousY = bullet.y;
        bullet.x += bullet.vx;
        bullet.y += bullet.vy;

        if (bullet.isGrenade) {
            bullet.vx *= 0.96;
            bullet.vy *= 0.96;
            if (now >= bullet.detonateAt
                || Math.abs(bullet.x) > SURVIV.worldHalf
                || Math.abs(bullet.y) > SURVIV.worldHalf) {
                detonateGrenade(room, bullet, entitiesById);
                room.bullets.splice(i, 1);
            }
            continue;
        }

        const distanceMoved = Math.hypot(bullet.vx, bullet.vy);
        bullet.distanceTravelled = (Number(bullet.distanceTravelled) || 0) + distanceMoved;
        const fallbackRange = distanceMoved * TICK_RATE * (SURVIV.bulletLifetimeMs / 1000);
        const maxDistance = Math.max(distanceMoved, Number(bullet.maxDistance) || fallbackRange);
        const rangeExceeded = bullet.distanceTravelled >= maxDistance;
        // Distance, rather than wall-clock time, owns firearm range. A delayed
        // server tick must never make a round expire early after travelling less.
        if (now - bullet.bornAt > 8000
            || Math.abs(bullet.x) > SURVIV.worldHalf
            || Math.abs(bullet.y) > SURVIV.worldHalf) {
            room.bullets.splice(i, 1);
            continue;
        }

        const midX = (previousX + bullet.x) / 2;
        const midY = (previousY + bullet.y) / 2;
        const queryRange = Math.max(90, distanceMoved / 2 + 10);

        let nearestObstacle = null;
        let obstacleHitT = Infinity;
        for (const obstacle of getNearbyObstacles(room, midX, midY, queryRange)) {
            const collisionShape = obstacle.kind === 'door' ? getSurvivDoorCollisionRect(obstacle) : obstacle;
            const hitT = segmentRectHitT(previousX, previousY, bullet.x, bullet.y, collisionShape);
            if (hitT != null && hitT < obstacleHitT) {
                nearestObstacle = obstacle;
                obstacleHitT = hitT;
            }
        }

        let nearestContainer = null;
        let containerHitT = Infinity;
        for (const { item } of querySurvivLoot(room, midX, midY, queryRange + 32)) {
            if (item.type !== 'chest' && item.type !== 'deathCrate') continue;
            const hitRadius = Number(item.hitRadius) || CONTAINER_PROFILES[item.containerType]?.hitRadius || 24;
            const hitT = segmentCircleHitT(
                previousX,
                previousY,
                bullet.x,
                bullet.y,
                item.x,
                item.y,
                hitRadius,
            );
            if (hitT != null && hitT < containerHitT) {
                nearestContainer = item;
                containerHitT = hitT;
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

        const attacker = entitiesById.get(bullet.ownerId);
        if (nearestObstacle && obstacleHitT <= entityHitT && obstacleHitT <= containerHitT) {
            damageSurvivObstacle(room, nearestObstacle, bullet.damage, attacker);
            room.bullets.splice(i, 1);
            continue;
        }
        if (nearestContainer && containerHitT <= entityHitT) {
            damageLootContainer(room, nearestContainer, bullet.damage, attacker);
            room.bullets.splice(i, 1);
            continue;
        }
        if (nearestEntity) {
            applyDamage(nearestEntity, bullet.damage, attacker);
            room.bullets.splice(i, 1);
            if (nearestEntity.hp <= 0) {
                eliminateSurvivPlayer(room, nearestEntity, room._io, attacker);
                entitiesById.delete(nearestEntity.id);
            }
            continue;
        }
        if (rangeExceeded) room.bullets.splice(i, 1);
    }
}

function distanceToObstacleRect(entity, obstacle) {
    const local = toRectLocal(entity.x, entity.y, obstacle);
    const dx = Math.max(0, Math.abs(local.x) - obstacle.w / 2);
    const dy = Math.max(0, Math.abs(local.y) - obstacle.h / 2);
    return Math.hypot(dx, dy);
}

export function getSurvivDoorCollisionRect(door) {
    if (!door?.isOpen) return door;
    const horizontal = door.w >= door.h;
    const length = horizontal ? door.w : door.h;
    const thickness = horizontal ? door.h : door.w;
    const baseRotation = (Number(door.rotation) || 0) + (horizontal ? 0 : Math.PI / 2);
    const swing = (Number(door.openDirection) === -1 ? -1 : 1) * Math.PI / 2;
    const baseCos = Math.cos(baseRotation);
    const baseSin = Math.sin(baseRotation);
    const hingeX = door.x - baseCos * length / 2;
    const hingeY = door.y - baseSin * length / 2;
    const openRotation = baseRotation + swing;
    return {
        ...door,
        x: hingeX + Math.cos(openRotation) * length / 2,
        y: hingeY + Math.sin(openRotation) * length / 2,
        w: length,
        h: thickness,
        rotation: openRotation,
    };
}

function getDoorOpenDirection(entity, door) {
    const local = toRectLocal(entity.x, entity.y, door);
    // The renderer normalizes vertical doors by rotating them 90 degrees.
    // Measure the player on that same local axis, then swing away from them.
    const playerSide = door.w >= door.h ? local.y : -local.x;
    return playerSide >= 0 ? -1 : 1;
}

export function toggleSurvivDoor(entity, room, now) {
    const requestedId = entity.toggleDoorId;
    entity.toggleDoorId = null;
    if (!requestedId || now - (entity._lastDoorToggleAt || 0) < 220) return false;

    const door = queryObstacles(room, entity.x, entity.y, 280, false)
        .find(obstacle => obstacle.id === requestedId && obstacle.kind === 'door');
    if (!door) return false;
    const interactionShape = door.isOpen ? getSurvivDoorCollisionRect(door) : door;
    const interactionDistance = door.isOpen
        ? Math.min(distanceToObstacleRect(entity, door), distanceToObstacleRect(entity, interactionShape))
        : distanceToObstacleRect(entity, door);
    if (interactionDistance > 58) return false;

    if (door.isOpen) {
        const occupants = [
            ...room.players.filter(player => !player.cashoutSettling && !player._eliminated),
            ...room.bots.filter(bot => !bot._eliminated),
        ];
        if (occupants.some(candidate => candidate.hp > 0 && circleRectCollision(
            candidate.x,
            candidate.y,
            candidate.radius || SURVIV.playerRadius,
            door,
        ))) return false;
    }

    if (!door.isOpen) door.openDirection = getDoorOpenDirection(entity, door);
    door.isOpen = !door.isOpen;
    door.doorChangedAt = now;
    entity._lastDoorToggleAt = now;
    markSurvivObstaclesChanged(room);
    return true;
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
        chestHoldId: null,
        chestHoldStartedAt: 0,
        chestHoldSeenAt: 0,
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
        .find(obstacle => obstacle.kind === 'door'
            && obstacle.houseId === house.id
            && obstacle.entranceRole !== 'interiorDoor');
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
            || (SURVIV_AMMO[contents.ammoType] && Number(contents.ammoAmount) > 0 && inventory.ammoReserves[contents.ammoType] < SURVIV_AMMO[contents.ammoType].max);
        return useful ? 1120 - distancePenalty : -Infinity;
    }
    if (item.type === 'weapon') {
        return inventory.weapons.length < SURVIV_MAX_WEAPONS ? 980 - distancePenalty : -Infinity;
    }
    if (item.type === 'money') return 820 - distancePenalty;
    if (item.type === 'armor') return bot.armor < bot.maxArmor - 2 ? 760 - distancePenalty : -Infinity;
    if (item.type === 'medkit') return inventory.medkits < SURVIV_MAX_MEDKITS ? 700 - distancePenalty : -Infinity;
    if (item.type === 'ammo' && SURVIV_AMMO[item.ammoType]) return inventory.ammoReserves[item.ammoType] < SURVIV_AMMO[item.ammoType].max ? 640 - distancePenalty : -Infinity;
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
    const family = WEAPONS[weaponType]?.family || weaponType;
    if (family === 'shotgun') return { preferredMin: 120, preferredMax: 250, fireRange: 390 };
    if (family === 'sniper' || family === 'dmr') return { preferredMin: 420, preferredMax: 650, fireRange: 1050 };
    if (family === 'assault' || family === 'lmg') return { preferredMin: 250, preferredMax: 440, fireRange: 900 };
    if (family === 'smg') return { preferredMin: 150, preferredMax: 310, fireRange: 680 };
    if (family === 'pistol' || family === 'revolver') return { preferredMin: 180, preferredMax: 350, fireRange: 760 };
    return { preferredMin: 20, preferredMax: 54, fireRange: 76 };
}

function updateBotAI(bot, room, now, effectiveRadius) {
    if (now < bot.botThinkAt) return;
    bot.botThinkAt = now + 90 + Math.random() * 100;
    bot.chestHoldId = null;
    bot.chestHoldSeenAt = now;

    const allTargets = [
        ...room.players.filter(player => !player.cashoutSettling && !player._eliminated && player.hp > 0),
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
        const waypoint = getBotLootWaypoint(bot, item, room);
        const direction = normalize(waypoint.x - bot.x, waypoint.y - bot.y);
        if (item.type === 'chest' || item.type === 'deathCrate') {
            const weaponDef = WEAPONS[bot.weapon?.type] || WEAPONS.fists;
            const hitRadius = Number(item.hitRadius) || CONTAINER_PROFILES[item.containerType]?.hitRadius || 24;
            const attackRange = weaponDef.melee
                ? weaponDef.meleeReach + hitRadius - 4
                : Math.min(620, weaponDef.range || 620);
            bot.aimAngle = Math.atan2(item.y - bot.y, item.x - bot.x);
            bot.inputDx = lootDistance > attackRange * 0.78 ? direction.dx : 0;
            bot.inputDy = lootDistance > attackRange * 0.78 ? direction.dy : 0;
            bot.shooting = lootDistance <= attackRange;
            return;
        }
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
    if (entity.cashoutHoldActive) {
        entity.inputDx = 0;
        entity.inputDy = 0;
        entity.shooting = false;
        entity.useMedkit = false;
        entity.pickupWeaponPending = false;
        entity.toggleDoorId = null;
        entity.equipSlotPending = null;
        entity.throwGrenadePending = false;
        entity.swapWeaponSlots = null;
        entity.dropItemPending = null;
        entity.openChestId = null;
        entity.takeChestItem = null;
        checkZoneDamage(entity, zone, now);
        if (entity.hp <= 0) eliminateSurvivPlayer(room, entity, room._io);
        return;
    }
    if (entity.disconnected) {
        entity.inputDx = 0;
        entity.inputDy = 0;
        entity.shooting = false;
        entity.useMedkit = false;
        entity.pickupWeaponPending = false;
        entity.toggleDoorId = null;
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
    if (!entity.isCashingOut && entity.toggleDoorId) {
        toggleSurvivDoor(entity, room, now);
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
            finishSurvivReload(entity);
        }
    }


    if (entity.isBot) {
        updateBotAI(entity, room, now, effectiveRadius);
    }

    const activeWeaponDef = WEAPONS[entity.weapon?.type] || WEAPONS.fists;
    const firingAutomaticWeapon = !!(
        entity.shooting
        && activeWeaponDef.automatic
        && Number(entity.weapon?.ammo) > 0
        && !entity.weapon?.reloading
    );
    const movementSurface = getEntitySurfaceKind(room, entity);
    const movementSpeed = SURVIV.playerSpeed
        * (movementSurface === 'water' ? SURVIV.waterMoveMultiplier : 1)
        * (firingAutomaticWeapon ? activeWeaponDef.firingMoveMultiplier || 0.75 : 1);
    moveEntity(entity, room, entity.inputDx, entity.inputDy, movementSpeed);
    entity.surface = getEntitySurfaceKind(room, entity);
    entity.angle = entity.aimAngle ?? entity.angle;

    if (!activeWeaponDef.automatic && !entity.isBot && entity._usesQueuedFireInput) {
        const pendingFirePressId = entity._pendingFirePressId;
        entity._pendingFirePressId = null;
        if (Number.isSafeInteger(pendingFirePressId)
            && entity._processedFirePressId !== pendingFirePressId) {
            tryShoot(entity, room, now);
            entity._processedFirePressId = pendingFirePressId;
        }
        entity._meleeInputLatched = false;
    } else if (entity.shooting) {
        if (!activeWeaponDef.automatic && !entity.isBot) {
            // Modern clients attach one stable id to each physical press. That
            // makes duplicate/delayed shooting=true packets harmless instead
            // of letting one click restart a melee or semi-auto attack.
            if (Number.isSafeInteger(entity.firePressId)) {
                if (entity._processedFirePressId !== entity.firePressId) {
                    tryShoot(entity, room, now);
                    entity._processedFirePressId = entity.firePressId;
                }
            } else {
                // Compatibility for older clients and direct engine tests.
                if (!entity._meleeInputLatched) tryShoot(entity, room, now);
                entity._meleeInputLatched = true;
            }
        } else {
            tryShoot(entity, room, now);
            entity._meleeInputLatched = false;
        }
    } else {
        entity._meleeInputLatched = false;
    }

    pickupLoot(entity, room);
    checkZoneDamage(entity, zone, now);

    if (entity.hp <= 0) {
        eliminateSurvivPlayer(room, entity, room._io);
    }
}

function getActiveSurvivEntities(room) {
    return [
        ...room.players.filter(p => !p.cashoutSettling && !p._eliminated && p.hp > 0),
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
        meleeAttackId: Number(p.meleeAttackId) || 0,
        reloadEndAt: p.weapon?.reloadEndAt || 0,
        reloadRemainingMs: p.weapon?.reloading ? Math.max(0, (p.weapon.reloadEndAt || 0) - Date.now()) : 0,
        reloadMs: wDef.reloadMs,
        medkitRemainingMs: p.medkitUseEndAt > Date.now() ? Math.max(0, p.medkitUseEndAt - Date.now()) : 0,
        medkitUseMs: SURVIV.medkitUseMs,
        dollarBalance: p.dollarBalance,
        kills: p.kills || 0,
        isBot: !!p.isBot,
        isYou,
        cashoutHoldActive: !!p.cashoutHoldActive,
        cashoutHoldStartedAt: p.cashoutHoldStartedAt || 0,
        isCashingOut: !!p.isCashingOut,
        outsideZone: !!p.outsideZone,
        surface: p.surface || 'ground',

        activeWeaponSlot: Number.isInteger(p.activeWeaponSlot) ? p.activeWeaponSlot : 0,
        weaponSlotAmmo: ensureWeaponSlotAmmo(p),
        weaponsAmmo: syncLegacyWeaponAmmo(p),
        inventory: ensureInventory(p),
        lastLoot: isYou ? (p.lastLoot || null) : null,
        openedContainer: null,
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
        ...(o.kind === 'door' ? { isOpen: !!o.isOpen } : {}),
        ...(o.kind === 'door' && Number.isFinite(o.openDirection) ? { openDirection: o.openDirection } : {}),
        ...(Array.isArray(o.points) ? { points: o.points } : {}),
        ...(Number.isFinite(o.width) ? { width: o.width } : {}),
        ...(Array.isArray(o.widths) ? { widths: o.widths } : {}),
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
    const pendingKillFeed = Array.isArray(room._pendingKillFeed) ? room._pendingKillFeed : [];
    const aliveCount = Number.isFinite(lbData.aliveCount) ? lbData.aliveCount : allPlayers.length;
    room.deathMarkers = (room.deathMarkers || []).filter(marker => now - marker.createdAt < 30000).slice(-40);

    const emitToViewer = (socketId, viewX, viewY, youId, dollarBalance, spectating) => {
        if (sendLb) {
            io.to(socketId).emit('leaderboard', { leaderboard, aliveCount, surviv: true });
        }
        const sendStaticPayload = shouldSendSurvivStaticPayload(room, socketId, viewX, viewY, now);

        const visiblePlayers = allPlayers
            .filter(p => p.id !== youId && isInView(viewX, viewY, p.x, p.y, range))
            .map(p => serializePlayer(p, false));

        const visibleLoot = querySurvivLoot(room, viewX, viewY, range)
            .map(({ item: l }) => {
                normalizeAmmoGroundLoot(l);
                return {
                id: l.id,
                type: l.type,
                x: l.x,
                y: l.y,
                dollarValue: l.dollarValue,
                weaponType: l.weaponType,
                tier: l.tier,
                source: l.source,
                containerType: l.containerType,
                hp: l.hp,
                maxHp: l.maxHp,
                hitRadius: l.hitRadius,
                amount: l.amount,
                ammoType: l.ammoType,
                armorValue: l.armorValue,
                ...(Number.isFinite(l.spawnedAt) && now - l.spawnedAt < 700 ? {
                    spawnX: l.spawnX,
                    spawnY: l.spawnY,
                    burstIndex: l.burstIndex,
                    burstCount: l.burstCount,
                    burstRemainingMs: Math.max(0, 700 - (now - l.spawnedAt)),
                } : {}),
            };
            });

        const visibleBullets = room.bullets
            .filter(b => b.ownerId === youId || isInView(viewX, viewY, b.x, b.y, range + 300))
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
            const minimapObstacleKinds = new Set(['road', 'roadJunction', 'trail_path', 'river_path', 'houseFloor', 'wall', 'interiorWall', 'water', 'container']);
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
            staticPayload.obstaclePatch = {
                x: viewX,
                y: viewY,
                range: range + 200,
                retainRange: range + 900,
            };
            staticPayload.minimap = {
                players: minimapPlayers,
                food: minimapLoot,
                obstacles: minimapObstacles,
            };
        }

        const viewerEntity = youId ? allPlayers.find(player => player.id === youId) : null;
        io.to(socketId).emit('survivTick', {
            you: youId ? serializePlayer(
                viewerEntity || { id: youId, x: viewX, y: viewY, dollarBalance, hp: 0 },
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
            ...(pendingKillFeed.length ? { killFeed: pendingKillFeed.map(entry => ({ ...entry })) } : {}),
            ...(viewerEntity?._hitConfirm ? { hitConfirm: { ...viewerEntity._hitConfirm } } : {}),
            ...(viewerEntity?._damageTaken ? { damageTaken: { ...viewerEntity._damageTaken } } : {}),
            ...(viewerEntity?._objectImpact ? { objectImpact: { ...viewerEntity._objectImpact } } : {}),
            ...(spectating ? {
                spectateTargets: allPlayers.map(p => ({
                    id: p.id,
                    name: p.username || p.name || 'Player',
                    x: p.x,
                    y: p.y,
                })),
            } : {}),
            ...meta,
        });
    };

    for (const p of room.players.filter(pl => !pl.disconnected && !pl.cashoutSettling && pl.hp > 0)) {
        emitToViewer(p.id, p.x, p.y, p.id, p.dollarBalance, false);
    }

    for (const spec of room.spectators || []) {
        emitToViewer(spec.id, spec.x, spec.y, null, spec.dollarBalance, true);
    }
    for (const entity of allPlayers) {
        entity._hitConfirm = null;
        entity._damageTaken = null;
        entity._objectImpact = null;
    }
    room._pendingKillFeed = [];
    pruneSurvivViewerPayloadCache(room, now);
}
