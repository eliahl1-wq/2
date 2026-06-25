/**
 * Surviv — top-down battle royale shooter engine.
 * Inspired by surviv.io mechanics: loot, weapons, shrinking zone, contested economy.
 */

import { getSurvivEconomy } from './economy.js';

const TICK_RATE = 40;
const TICK_DT = 1 / TICK_RATE;

export const SURVIV = {
    worldHalf: 20000,
    shrinkBeforeResetMs: 3 * 60 * 1000,

    playerRadius: 14,
    playerSpeed: 5.2,
    viewRange: 1200,
    botTargetCount: 12,
    zoneDamagePerTick: 0,
    bulletLifetimeMs: 800,
    lootPickupRadius: 34,
    chestOpenRadius: 92,
};

export const WEAPONS = {
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
    common: ['revolver', 'smg'],
    rare: ['shotgun', 'assault', 'dmr'],
    military: ['assault', 'dmr', 'sniper', 'lmg'],
};
const LOOT_WEAPON_TYPES = [...new Set(Object.values(WEAPON_RARITY_POOLS).flat().filter(w => w !== 'pistol'))];
const SURVIV_OBSTACLE_CELL = 700;

function randId() {
    return Math.random().toString(36).slice(2, 10);
}

function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
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

function pointInRect(px, py, rect) {
    return px >= rect.x - rect.w / 2 && px <= rect.x + rect.w / 2
        && py >= rect.y - rect.h / 2 && py <= rect.y + rect.h / 2;
}

function circleRectCollision(cx, cy, r, rect) {
    const closestX = clamp(cx, rect.x - rect.w / 2, rect.x + rect.w / 2);
    const closestY = clamp(cy, rect.y - rect.h / 2, rect.y + rect.h / 2);
    return dist(cx, cy, closestX, closestY) < r;
}

function resolveCircleRect(cx, cy, r, rect) {
    const closestX = clamp(cx, rect.x - rect.w / 2, rect.x + rect.w / 2);
    const closestY = clamp(cy, rect.y - rect.h / 2, rect.y + rect.h / 2);
    const d = dist(cx, cy, closestX, closestY);
    if (d >= r) return { x: cx, y: cy };
    if (d < 1e-6) {
        const left = Math.abs(cx - (rect.x - rect.w / 2));
        const right = Math.abs((rect.x + rect.w / 2) - cx);
        const top = Math.abs(cy - (rect.y - rect.h / 2));
        const bottom = Math.abs((rect.y + rect.h / 2) - cy);
        const min = Math.min(left, right, top, bottom);
        if (min === left) return { x: rect.x - rect.w / 2 - r, y: cy };
        if (min === right) return { x: rect.x + rect.w / 2 + r, y: cy };
        if (min === top) return { x: cx, y: rect.y - rect.h / 2 - r };
        return { x: cx, y: rect.y + rect.h / 2 + r };
    }
    const overlap = r - d;
    const nx = (cx - closestX) / d;
    const ny = (cy - closestY) / d;
    return { x: cx + nx * overlap, y: cy + ny * overlap };
}

function randomChestContents(tier = 'common') {
    const contents = { rarity: tier };
    const moneyBase = tier === 'rare' ? 0.85 : tier === 'military' ? 1.25 : 0.42;
    contents.money = Number((moneyBase * (0.55 + Math.random())).toFixed(2));

    const weaponChance = tier === 'military' ? 0.84 : tier === 'rare' ? 0.58 : 0.34;
    if (Math.random() < weaponChance) contents.weaponType = pickWeaponForTier(tier);

    const ammoRoll = Math.random();
    if (tier !== 'common' || ammoRoll > 0.22) {
        contents.ammoPacks = 1 + Math.floor(Math.random() * (tier === 'military' ? 3 : 2));
    }
    if (Math.random() > (tier === 'common' ? 0.54 : 0.38)) contents.medkits = 1;
    if (tier !== 'common' || Math.random() > 0.72) contents.armor = tier === 'military' ? 60 : 35;
    return contents;
}

function makeChest(x, y, tier = 'common', contents = randomChestContents(tier), source = 'map') {
    return {
        id: randId(),
        type: source === 'death' ? 'deathCrate' : 'chest',
        x,
        y,
        tier,
        contents,
        source,
    };
}

function addObstacle(obstacles, kind, x, y, w, h, opts = {}) {
    obstacles.push({
        id: randId(),
        kind,
        x,
        y,
        w,
        h,
        hue: opts.hue,
        rotation: opts.rotation || 0,
        collidable: opts.collidable !== false,
        variant: opts.variant || null,
        biome: opts.biome || null,
        label: opts.label || null,
    });
}

function addRoad(obstacles, x1, y1, x2, y2, width = 150) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    addObstacle(obstacles, 'road', x1 + dx / 2, y1 + dy / 2, Math.abs(dx) + width, width, {
        collidable: false,
        variant: 'asphalt',
    });
    addObstacle(obstacles, 'road', x2, y1 + dy / 2, width, Math.abs(dy) + width, {
        collidable: false,
        variant: 'asphalt',
    });
}

function addWall(obstacles, x, y, w, h, variant = 'plaster') {
    addObstacle(obstacles, 'wall', x, y, w, h, { hue: 24, variant });
}

function addInteriorWall(obstacles, x, y, w, h, variant = 'plaster') {
    addObstacle(obstacles, 'interiorWall', x, y, w, h, { hue: 24, variant });
}

function addHouse(obstacles, loot, spawnPoints, x, y, w, h, opts = {}) {
    const wall = opts.wall || 14;
    const door = Math.min(70, w * 0.34);
    const hue = opts.hue ?? 22;
    const variant = opts.variant || 'house';
    addObstacle(obstacles, 'houseFloor', x, y, w, h, { collidable: false, hue, variant });
    addWall(obstacles, x, y - h / 2 + wall / 2, w, wall, variant);
    addWall(obstacles, x - w / 2 + wall / 2, y, wall, h, variant);
    addWall(obstacles, x + w / 2 - wall / 2, y, wall, h, variant);
    addWall(obstacles, x - door * 0.65, y + h / 2 - wall / 2, w / 2 - door * 0.65, wall, variant);
    addWall(obstacles, x + door * 0.65, y + h / 2 - wall / 2, w / 2 - door * 0.65, wall, variant);

    if (w > 190) addInteriorWall(obstacles, x, y, wall, h * 0.55, variant);
    if (h > 180) addInteriorWall(obstacles, x + w * 0.18, y - h * 0.08, w * 0.38, wall, variant);

    addObstacle(obstacles, 'furniture', x - w * 0.27, y - h * 0.18, 42, 24, { collidable: false, variant: 'table' });
    addObstacle(obstacles, 'furniture', x + w * 0.27, y + h * 0.12, 36, 28, { collidable: false, variant: 'bed' });

    const chestTier = opts.tier || (Math.random() > 0.78 ? 'rare' : 'common');
    loot.push(makeChest(x + w * 0.24, y - h * 0.22, chestTier));
    if (Math.random() > 0.58) loot.push(makeChest(x - w * 0.28, y + h * 0.18, 'common'));
    spawnPoints.push({ x, y: y + h / 2 + 70 });
}

function addMansion(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1500, 1050, { collidable: false, variant: 'estate' });
    addHouse(obstacles, loot, spawnPoints, x, y, 720, 520, { hue: 32, variant: 'mansion', tier: 'rare', wall: 18 });
    addHouse(obstacles, loot, spawnPoints, x - 560, y + 240, 320, 260, { hue: 28, variant: 'guesthouse', tier: 'rare' });
    addHouse(obstacles, loot, spawnPoints, x + 570, y + 250, 300, 250, { hue: 28, variant: 'garage', tier: 'military' });
    addWall(obstacles, x, y - 590, 1500, 18, 'stone');
    addWall(obstacles, x - 750, y, 18, 1180, 'stone');
    addWall(obstacles, x + 750, y, 18, 1180, 'stone');
    addWall(obstacles, x - 260, y + 590, 980, 18, 'stone');
    addWall(obstacles, x + 600, y + 590, 280, 18, 'stone');
    for (let i = 0; i < 9; i++) {
        loot.push(makeChest(x - 320 + i * 80, y - 170 + (i % 3) * 170, i % 3 === 0 ? 'rare' : 'common'));
    }
}

function addContainerYard(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1200, 900, { collidable: false, variant: 'industrial' });
    for (let i = 0; i < 18; i++) {
        const col = i % 6;
        const row = Math.floor(i / 6);
        addObstacle(obstacles, 'container', x - 460 + col * 185, y - 260 + row * 230, 125, 54, {
            hue: 195 + (i % 4) * 18,
            rotation: (i % 2) * 0.02,
            variant: i % 3 === 0 ? 'red' : 'blue',
        });
        if (i % 4 === 0) loot.push(makeChest(x - 430 + col * 185, y - 215 + row * 230, 'military'));
    }
    addHouse(obstacles, loot, spawnPoints, x + 430, y + 285, 300, 220, { variant: 'warehouse', tier: 'military', hue: 205 });
}

function addForest(obstacles, loot, spawnPoints, x, y, count = 34, radius = 680) {
    addObstacle(obstacles, 'field', x, y, radius * 1.9, radius * 1.55, { collidable: false, variant: 'woods' });
    for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = radius * Math.sqrt(Math.random());
        const size = 34 + Math.random() * 30;
        addObstacle(obstacles, 'tree', x + Math.cos(a) * r, y + Math.sin(a) * r, size, size, {
            hue: 104 + Math.floor(Math.random() * 30),
            rotation: Math.random() * Math.PI,
        });
    }
    loot.push(makeChest(x + 90, y - 60, Math.random() > 0.5 ? 'rare' : 'common'));
    spawnPoints.push({ x: x - 130, y: y + 150 });
}

function addSettlement(obstacles, loot, spawnPoints, x, y, size = 5, variant = 'village') {
    addObstacle(obstacles, 'field', x, y, 900, 760, { collidable: false, variant });
    for (let i = 0; i < size; i++) {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const hx = x - 260 + col * 260 + (Math.random() - 0.5) * 70;
        const hy = y - 180 + row * 240 + (Math.random() - 0.5) * 70;
        addHouse(obstacles, loot, spawnPoints, hx, hy, 160 + Math.random() * 80, 140 + Math.random() * 70, {
            hue: 18 + Math.floor(Math.random() * 28),
            variant,
            tier: Math.random() > 0.86 ? 'rare' : 'common',
        });
    }
    for (let i = 0; i < 5; i++) {
        addObstacle(obstacles, 'crate', x - 360 + Math.random() * 720, y - 320 + Math.random() * 640, 44 + Math.random() * 22, 44 + Math.random() * 22, {
            hue: 28,
            rotation: (Math.random() - 0.5) * 0.4,
        });
    }
}

function addCoverPatch(obstacles, loot, spawnPoints, x, y, opts = {}) {
    const radius = opts.radius || (260 + Math.random() * 360);
    const variant = opts.variant || (Math.random() > 0.55 ? 'woods' : 'scrub');
    addObstacle(obstacles, 'field', x, y, radius * 2.1, radius * 1.6, { collidable: false, variant });
    const trees = 5 + Math.floor(Math.random() * 13);
    for (let i = 0; i < trees; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = radius * Math.sqrt(Math.random());
        addObstacle(obstacles, Math.random() > 0.22 ? 'tree' : 'bush', x + Math.cos(a) * r, y + Math.sin(a) * r, 28 + Math.random() * 44, 28 + Math.random() * 44, {
            hue: 92 + Math.floor(Math.random() * 38),
            rotation: Math.random() * Math.PI,
            collidable: Math.random() > 0.32,
            variant,
        });
    }
    const rocks = 2 + Math.floor(Math.random() * 5);
    for (let i = 0; i < rocks; i++) {
        addObstacle(obstacles, 'rock', x - radius * 0.5 + Math.random() * radius, y - radius * 0.5 + Math.random() * radius, 34 + Math.random() * 36, 30 + Math.random() * 34, {
            hue: 210 + Math.floor(Math.random() * 30),
            rotation: Math.random() * 0.6,
        });
    }
    if (Math.random() > 0.55) loot.push(makeChest(x + (Math.random() - 0.5) * radius, y + (Math.random() - 0.5) * radius, Math.random() > 0.86 ? 'rare' : 'common'));
    if (Math.random() > 0.4) spawnPoints.push({ x, y });
}

function addMicroSite(obstacles, loot, spawnPoints, x, y, biome = 'grass') {
    const roll = Math.random();
    const tier = roll > 0.78 ? 'rare' : 'common';
    if (roll < 0.22) {
        addObstacle(obstacles, 'field', x, y, 650, 520, { collidable: false, variant: 'village' });
        addHouse(obstacles, loot, spawnPoints, x - 80, y - 20, 170 + Math.random() * 80, 145 + Math.random() * 70, { variant: 'cabin', hue: 18 + Math.floor(Math.random() * 20), tier });
        addObstacle(obstacles, 'crate', x + 180, y + 100, 46, 46, { hue: 30, rotation: Math.random() * 0.4 });
        loot.push(makeChest(x + 220, y - 115, tier));
    } else if (roll < 0.42) {
        addObstacle(obstacles, 'road', x, y, 760, 78, { collidable: false, variant: 'dirt' });
        for (let i = 0; i < 7; i++) {
            const sx = x - 250 + i * 84;
            addObstacle(obstacles, 'sandbag', sx, y - 92, 58, 28, { rotation: (Math.random() - 0.5) * 0.35, variant: 'checkpoint' });
            if (i % 2 === 0) addObstacle(obstacles, 'barrel', sx + 26, y + 78, 30, 30, { hue: 18 + i * 12, variant: 'fuel' });
        }
        loot.push(makeChest(x + 15, y + 6, Math.random() > 0.55 ? 'military' : 'rare'));
        spawnPoints.push({ x: x - 260, y: y + 160 });
    } else if (roll < 0.6) {
        addObstacle(obstacles, 'field', x, y, 720, 520, { collidable: false, variant: 'camp' });
        for (let i = 0; i < 4; i++) {
            addObstacle(obstacles, 'tent', x - 210 + i * 140, y + (i % 2) * 110 - 55, 92, 64, { hue: 78 + i * 8, rotation: (Math.random() - 0.5) * 0.8, variant: 'camp' });
        }
        addCoverPatch(obstacles, loot, spawnPoints, x + 40, y - 80, { radius: 260, variant: biome === 'snow' ? 'snow-woods' : 'woods' });
        loot.push(makeChest(x + 140, y + 135, tier));
    } else if (roll < 0.78) {
        addObstacle(obstacles, 'field', x, y, 820, 580, { collidable: false, variant: 'farm' });
        addHouse(obstacles, loot, spawnPoints, x - 160, y - 30, 230, 180, { variant: 'barn', hue: 8, tier });
        for (let i = 0; i < 5; i++) addObstacle(obstacles, 'field', x - 300 + i * 145, y + 210, 110, 240, { collidable: false, variant: 'crop' });
        addObstacle(obstacles, 'crate', x + 190, y - 80, 54, 54, { hue: 34, variant: 'hay' });
        loot.push(makeChest(x + 230, y + 35, Math.random() > 0.7 ? 'rare' : 'common'));
    } else if (roll < 0.9) {
        addObstacle(obstacles, 'water', x, y, 420 + Math.random() * 220, 250 + Math.random() * 140, { collidable: false, variant: 'pond', rotation: Math.random() * 0.25 });
        addCoverPatch(obstacles, loot, spawnPoints, x, y, { radius: 420, variant: 'wetlands' });
    } else {
        addObstacle(obstacles, 'field', x, y, 760, 560, { collidable: false, variant: 'ruins' });
        addWall(obstacles, x - 180, y - 90, 260, 16, 'stone');
        addWall(obstacles, x - 300, y + 20, 16, 210, 'stone');
        addWall(obstacles, x + 120, y + 105, 300, 16, 'stone');
        addObstacle(obstacles, 'barrel', x + 160, y - 130, 36, 36, { hue: 210, variant: 'water' });
        loot.push(makeChest(x - 60, y + 50, Math.random() > 0.4 ? 'rare' : 'common'));
        spawnPoints.push({ x: x + 230, y: y + 160 });
    }
}

function addMilitaryBase(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1600, 1400, { collidable: false, variant: 'industrial' });
    addWall(obstacles, x, y - 690, 1600, 20, 'stone');
    addWall(obstacles, x - 790, y, 20, 1400, 'stone');
    addWall(obstacles, x + 790, y, 20, 1400, 'stone');
    addWall(obstacles, x - 400, y + 690, 800, 20, 'stone');
    addWall(obstacles, x + 500, y + 690, 600, 20, 'stone');

    // Central Warehouse
    addHouse(obstacles, loot, spawnPoints, x, y, 600, 450, { variant: 'warehouse', tier: 'military', hue: 205, wall: 16 });
    
    // Tents and barracks
    for (let i = 0; i < 4; i++) {
        addObstacle(obstacles, 'tent', x - 550 + i * 160, y - 450, 120, 80, { hue: 80, rotation: 0, variant: 'camp' });
        loot.push(makeChest(x - 550 + i * 160, y - 450, 'military'));
    }
    
    // Containers
    for (let i = 0; i < 8; i++) {
        addObstacle(obstacles, 'container', x + 550, y - 400 + i * 110, 125, 54, { hue: 195, rotation: Math.PI / 2, variant: 'blue' });
    }
    
    // Sandbags and defensive positions
    for (let i = 0; i < 6; i++) {
        addObstacle(obstacles, 'sandbag', x - 200 + i * 80, y + 550, 60, 30, { rotation: 0 });
    }
    
    spawnPoints.push({ x: x, y: y + 800 });
}

function addGasStation(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'road', x, y, 1200, 800, { collidable: false, variant: 'asphalt' });
    
    // Store
    addHouse(obstacles, loot, spawnPoints, x, y - 200, 450, 250, { variant: 'warehouse', tier: 'rare', hue: 10, wall: 12 });
    
    // Pumps Canopy
    addObstacle(obstacles, 'field', x, y + 150, 500, 200, { collidable: false, variant: 'industrial' });
    
    // Fuel pumps
    for (let i = 0; i < 4; i++) {
        addObstacle(obstacles, 'barrel', x - 150 + i * 100, y + 150, 36, 36, { hue: 15, variant: 'fuel' });
    }
    
    // Cars (colored containers)
    addObstacle(obstacles, 'container', x - 400, y + 250, 110, 50, { hue: 0, rotation: 0.2, variant: 'red' });
    addObstacle(obstacles, 'container', x + 350, y + 100, 110, 50, { hue: 200, rotation: -0.1, variant: 'blue' });

    loot.push(makeChest(x - 100, y + 150, 'common'));
    loot.push(makeChest(x + 100, y + 150, 'common'));
}

function addPrison(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1800, 1800, { collidable: false, variant: 'quarry' });
    
    // High walls
    addWall(obstacles, x, y - 890, 1800, 24, 'stone');
    addWall(obstacles, x, y + 890, 1800, 24, 'stone');
    addWall(obstacles, x - 890, y, 24, 1800, 'stone');
    addWall(obstacles, x + 890, y, 24, 1800, 'stone');

    // Central Yard
    addObstacle(obstacles, 'field', x, y, 600, 600, { collidable: false, variant: 'estate' });
    for (let i = 0; i < 6; i++) {
        addObstacle(obstacles, 'barrel', x - 200 + Math.random() * 400, y - 200 + Math.random() * 400, 30, 30, { hue: 20, variant: 'water' });
    }

    // Cell blocks
    addHouse(obstacles, loot, spawnPoints, x - 500, y - 500, 300, 400, { variant: 'warehouse', tier: 'rare', hue: 200, wall: 16 });
    addHouse(obstacles, loot, spawnPoints, x + 500, y - 500, 300, 400, { variant: 'warehouse', tier: 'rare', hue: 200, wall: 16 });
    addHouse(obstacles, loot, spawnPoints, x - 500, y + 500, 300, 400, { variant: 'warehouse', tier: 'rare', hue: 200, wall: 16 });
    addHouse(obstacles, loot, spawnPoints, x + 500, y + 500, 300, 400, { variant: 'warehouse', tier: 'rare', hue: 200, wall: 16 });

    // Guard towers (stone boxes)
    addObstacle(obstacles, 'wall', x - 800, y - 800, 100, 100, 'stone');
    addObstacle(obstacles, 'wall', x + 800, y - 800, 100, 100, 'stone');
    addObstacle(obstacles, 'wall', x - 800, y + 800, 100, 100, 'stone');
    addObstacle(obstacles, 'wall', x + 800, y + 800, 100, 100, 'stone');

    for (let i = 0; i < 5; i++) loot.push(makeChest(x - 200 + i * 100, y, 'military'));
}

function addHospital(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 1400, 1000, { collidable: false, variant: 'estate' });
    
    // Main building
    addObstacle(obstacles, 'houseFloor', x, y, 1000, 800, { collidable: false, hue: 0, variant: 'mansion' });
    addWall(obstacles, x, y - 400 + 8, 1000, 16, 'plaster');
    addWall(obstacles, x, y + 400 - 8, 1000, 16, 'plaster');
    addWall(obstacles, x - 500 + 8, y, 16, 800, 'plaster');
    addWall(obstacles, x + 500 - 8, y, 16, 800, 'plaster');
    
    // Corridors & Rooms
    addInteriorWall(obstacles, x - 200, y, 16, 800, 'plaster');
    addInteriorWall(obstacles, x + 200, y, 16, 800, 'plaster');
    
    addInteriorWall(obstacles, x - 350, y, 300, 16, 'plaster');
    addInteriorWall(obstacles, x + 350, y, 300, 16, 'plaster');

    // Beds everywhere
    for (let i = 0; i < 4; i++) {
        addObstacle(obstacles, 'furniture', x - 400, y - 250 + i * 80, 36, 28, { collidable: false, variant: 'bed' });
        addObstacle(obstacles, 'furniture', x + 400, y - 250 + i * 80, 36, 28, { collidable: false, variant: 'bed' });
    }

    // Lots of loot
    for (let i = 0; i < 12; i++) {
        loot.push(makeChest(x - 450 + Math.random() * 900, y - 350 + Math.random() * 700, Math.random() > 0.5 ? 'rare' : 'common'));
    }
}

function addRadioTower(obstacles, loot, spawnPoints, x, y) {
    addObstacle(obstacles, 'field', x, y, 800, 800, { collidable: false, variant: 'industrial' });
    
    // Fence
    addWall(obstacles, x, y - 390, 800, 10, 'stone');
    addWall(obstacles, x, y + 390, 800, 10, 'stone');
    addWall(obstacles, x - 390, y, 10, 800, 'stone');
    addWall(obstacles, x + 390, y, 10, 800, 'stone');

    // Tower Base
    addObstacle(obstacles, 'wall', x, y, 150, 150, 'warehouse');
    addInteriorWall(obstacles, x, y, 250, 20, 'warehouse');
    addInteriorWall(obstacles, x, y, 20, 250, 'warehouse');

    // Control building
    addHouse(obstacles, loot, spawnPoints, x - 200, y - 200, 150, 150, { variant: 'warehouse', tier: 'rare', hue: 200 });
    
    loot.push(makeChest(x + 100, y + 100, 'military'));
    loot.push(makeChest(x - 100, y + 100, 'military'));
}

export function generateSurvivMap(worldHalf) {
    const obstacles = [];
    const loot = [];
    const spawnPoints = [];
    const landmarks = [];

    const scale = worldHalf / 40000;
    const pois = [
        { name: 'Old Estate', x: 0, y: 0, type: 'mansion' },
        { name: 'North Lab', x: 0, y: Math.round(-27500 * scale), type: 'lab' },
        { name: 'Pine Town', x: Math.round(-16500 * scale), y: Math.round(-12500 * scale), type: 'town' },
        { name: 'Quarry', x: Math.round(18500 * scale), y: Math.round(-14500 * scale), type: 'quarry' },
        { name: 'West Village', x: Math.round(-30500 * scale), y: Math.round(1500 * scale), type: 'town' },
        { name: 'Dry Farm', x: Math.round(-21500 * scale), y: Math.round(15500 * scale), type: 'farm' },
        { name: 'Container Docks', x: Math.round(22500 * scale), y: Math.round(17500 * scale), type: 'yard' },
        { name: 'East Depot', x: Math.round(31000 * scale), y: Math.round(-4500 * scale), type: 'yard' },
        { name: 'River Camp', x: Math.round(8500 * scale), y: Math.round(25500 * scale), type: 'camp' },
        { name: 'South Bunker', x: Math.round(-4200 * scale), y: Math.round(31500 * scale), type: 'bunker' },
        { name: 'Military Base', x: Math.round(-25000 * scale), y: Math.round(-25000 * scale), type: 'military' },
        { name: 'Crossroads Gas', x: Math.round(12000 * scale), y: Math.round(12000 * scale), type: 'gas' },
        { name: 'State Prison', x: Math.round(28000 * scale), y: Math.round(-25000 * scale), type: 'prison' },
        { name: 'Central Hospital', x: Math.round(-15000 * scale), y: Math.round(28000 * scale), type: 'hospital' },
        { name: 'Radio Tower', x: Math.round(28000 * scale), y: Math.round(28000 * scale), type: 'tower' },
    ];


    for (const poi of pois) {
        landmarks.push({ name: poi.name, x: poi.x, y: poi.y, type: poi.type });
        addRoad(obstacles, 0, 0, poi.x, poi.y, poi.type === 'mansion' ? 190 : 145);
        if (poi.type === 'mansion') addMansion(obstacles, loot, spawnPoints, poi.x, poi.y);
        else if (poi.type === 'yard') addContainerYard(obstacles, loot, spawnPoints, poi.x, poi.y);
        else if (poi.type === 'quarry') {
            addObstacle(obstacles, 'field', poi.x, poi.y, 1200, 900, { collidable: false, variant: 'quarry' });
            for (let i = 0; i < 24; i++) {
                addObstacle(obstacles, 'rock', poi.x - 520 + Math.random() * 1040, poi.y - 390 + Math.random() * 780, 54 + Math.random() * 48, 48 + Math.random() * 42, { hue: 220, rotation: Math.random() * 0.4 });
            }
            addHouse(obstacles, loot, spawnPoints, poi.x + 360, poi.y - 260, 300, 230, { variant: 'warehouse', tier: 'military', hue: 205 });
            for (let i = 0; i < 8; i++) loot.push(makeChest(poi.x - 420 + i * 120, poi.y + 250 + (i % 2) * 70, 'military'));
        } else if (poi.type === 'lab') {
            addSettlement(obstacles, loot, spawnPoints, poi.x, poi.y, 7, 'snow-lab');
            addContainerYard(obstacles, loot, spawnPoints, poi.x + 650, poi.y + 200);
        } else if (poi.type === 'farm') {
            addSettlement(obstacles, loot, spawnPoints, poi.x, poi.y, 6, 'farm');
            for (let i = 0; i < 7; i++) addObstacle(obstacles, 'field', poi.x - 780 + i * 260, poi.y + 560, 190, 420, { collidable: false, variant: 'crop' });
        } else if (poi.type === 'camp') {
            for (let i = 0; i < 7; i++) addMicroSite(obstacles, loot, spawnPoints, poi.x - 700 + i * 220, poi.y + (i % 2) * 260 - 120, 'wetlands');
            addForest(obstacles, loot, spawnPoints, poi.x, poi.y - 380, 38, 760);
        } else if (poi.type === 'bunker') {
            addObstacle(obstacles, 'field', poi.x, poi.y, 1200, 820, { collidable: false, variant: 'ruins' });
            addHouse(obstacles, loot, spawnPoints, poi.x, poi.y, 520, 360, { variant: 'warehouse', tier: 'military', hue: 205, wall: 18 });
            for (let i = 0; i < 10; i++) loot.push(makeChest(poi.x - 340 + i * 78, poi.y - 130 + (i % 3) * 120, i % 2 ? 'rare' : 'military'));
        } else if (poi.type === 'hospital') {
            addHospital(obstacles, loot, spawnPoints, poi.x, poi.y);
        } else if (poi.type === 'prison') {
            addPrison(obstacles, loot, spawnPoints, poi.x, poi.y);
        } else if (poi.type === 'military') {
            addMilitaryBase(obstacles, loot, spawnPoints, poi.x, poi.y);
        } else if (poi.type === 'gas') {
            addGasStation(obstacles, loot, spawnPoints, poi.x, poi.y);
        } else if (poi.type === 'tower') {
            addRadioTower(obstacles, loot, spawnPoints, poi.x, poi.y);
        } else {
            addSettlement(obstacles, loot, spawnPoints, poi.x, poi.y, 8, 'town');
        }
    }

    for (let i = 0; i < pois.length - 1; i++) {
        const a = pois[i];
        const b = pois[i + 1];
        if (Math.random() > 0.25) addRoad(obstacles, a.x, a.y, b.x, b.y, 100);
    }

    for (let i = 0; i < 68; i++) {
        const pos = randomSpawnCoord(worldHalf * 0.88);
        addSettlement(obstacles, loot, spawnPoints, pos.x, pos.y, 3 + Math.floor(Math.random() * 4), i % 5 === 0 ? 'farm' : i % 7 === 0 ? 'camp' : 'village');
    }

    for (let i = 0; i < 46; i++) {
        const pos = randomSpawnCoord(worldHalf * 0.9);
        addForest(obstacles, loot, spawnPoints, pos.x, pos.y, 18 + Math.floor(Math.random() * 22), 360 + Math.random() * 420);
    }

    const step = 3900;
    const margin = 2600;
    for (let gx = -worldHalf + margin; gx <= worldHalf - margin; gx += step) {
        for (let gy = -worldHalf + margin; gy <= worldHalf - margin; gy += step) {
            if (Math.hypot(gx, gy) < 1200) continue;
            const x = clamp(gx + (Math.random() - 0.5) * 1850, -worldHalf + 1200, worldHalf - 1200);
            const y = clamp(gy + (Math.random() - 0.5) * 1850, -worldHalf + 1200, worldHalf - 1200);
            const biome = y < -22000 * scale ? 'snow' : x < -18000 * scale && y > 8500 * scale ? 'dry' : x > 14500 * scale && y > 9500 * scale ? 'pine' : 'grass';

            const roll = Math.random();
            if (roll < 0.36) addMicroSite(obstacles, loot, spawnPoints, x, y, biome);
            else if (roll < 0.40) addGasStation(obstacles, loot, spawnPoints, x, y);
            else if (roll < 0.44) addRadioTower(obstacles, loot, spawnPoints, x, y);
            else if (roll < 0.74) addCoverPatch(obstacles, loot, spawnPoints, x, y, { variant: biome === 'snow' ? 'snow-woods' : biome === 'dry' ? 'scrub' : 'woods' });
        }
    }

    return { obstacles, loot, spawnPoints, landmarks };
}

export function generateSurvivObstacles(worldHalf) {
    return generateSurvivMap(worldHalf).obstacles;
}

export function getSurvivEffectiveRadius() {
    return SURVIV.worldHalf;
}

export function getSurvivZone() {
    return null;
}

function makeWeaponState(typeId) {
    const def = WEAPONS[typeId] || WEAPONS.pistol;
    return {
        type: def.id,
        ammo: def.clipSize,
        reloading: false,
        reloadEndAt: 0,
        lastShotAt: 0,
    };
}

function makeInventory() {
    return {
        weapons: ['pistol'],
        medkits: 0,
        ammoPacks: 0,
        chestsOpened: 0,
    };
}

function ensureInventory(entity) {
    if (!entity.inventory) entity.inventory = makeInventory();
    if (!Array.isArray(entity.inventory.weapons)) entity.inventory.weapons = ['pistol'];
    entity.inventory.medkits = Number(entity.inventory.medkits) || 0;
    entity.inventory.ammoPacks = Number(entity.inventory.ammoPacks) || 0;
    entity.inventory.chestsOpened = Number(entity.inventory.chestsOpened) || 0;
    return entity.inventory;
}

function addWeaponToInventory(entity, weaponType) {
    const inv = ensureInventory(entity);
    if (!weaponType || !WEAPONS[weaponType] || inv.weapons.includes(weaponType)) return;
    if (inv.weapons.length < 4) {
        inv.weapons.push(weaponType);
    } else {
        inv.weapons[3] = weaponType;
    }
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
        summary.medkits = Number(contents.medkits || 0);
        inv.medkits = Math.min(6, inv.medkits + summary.medkits);
    }
    if (contents.armor) {
        summary.armor = Number(contents.armor || 0);
        entity.armor = Math.min(entity.maxArmor, (entity.armor || 0) + summary.armor);
    }
    if (contents.ammoPacks) {
        const packs = Number(contents.ammoPacks || 0);
        summary.ammoPacks = packs;
        inv.ammoPacks = Math.min(9, inv.ammoPacks + packs);
        const wDef = WEAPONS[entity.weapon.type] || WEAPONS.pistol;
        entity.weapon.ammo = Math.min(wDef.clipSize, entity.weapon.ammo + Math.ceil(wDef.clipSize * 0.4 * packs));
    }
    if (contents.weaponType && WEAPONS[contents.weaponType]) {
        entity.weapon = makeWeaponState(contents.weaponType);
        addWeaponToInventory(entity, contents.weaponType);
        summary.weaponType = contents.weaponType;
        summary.weaponLabel = WEAPONS[contents.weaponType].label;
    }
    return summary;
}

function useInventoryMedkit(entity) {
    const inv = ensureInventory(entity);
    if (inv.medkits <= 0 || entity.hp >= entity.maxHp) return;
    inv.medkits -= 1;
    entity.hp = Math.min(entity.maxHp, entity.hp + 45);
}

function equipInventorySlot(entity, slot) {
    const inv = ensureInventory(entity);
    const index = clamp(Number(slot) || 0, 0, 3);
    const weaponType = inv.weapons[index];
    if (!weaponType || !WEAPONS[weaponType]) return;
    if (entity.weapon?.type === weaponType) return;
    entity.weapon = makeWeaponState(weaponType);
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
        weapon: makeWeaponState('pistol'),
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
        useMedkit: false,
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
        const useStructureSpawn = spawnPoints.length && Math.random() < 0.64;
        const base = useStructureSpawn
            ? spawnPoints[Math.floor(Math.random() * spawnPoints.length)]
            : randomSpawnCoord(SURVIV.worldHalf * 0.94);
        const jitter = useStructureSpawn ? 900 : 220;
        const pos = {
            x: base.x + (Math.random() - 0.5) * jitter,
            y: base.y + (Math.random() - 0.5) * jitter,
        };
        if (!isPositionBlocked(room, pos.x, pos.y, SURVIV.playerRadius + 10)) {
            const clear = [...room.players, ...room.bots].every(p => dist(pos.x, pos.y, p.x, p.y) > 140);
            if (clear) return pos;
        }
    }
    return randomSpawnCoord(SURVIV.worldHalf * 0.9);
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

function isPositionBlocked(room, x, y, r) {
    for (const o of queryObstacles(room, x, y, r + 80, true)) {
        if (circleRectCollision(x, y, r, o)) return true;
    }
    return false;
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
    const wDef = WEAPONS[entity.weapon.type] || WEAPONS.pistol;
    const w = entity.weapon;

    if (w.reloading) {
        if (now >= w.reloadEndAt) {
            w.reloading = false;
            w.ammo = wDef.clipSize;
        } else {
            return;
        }
    }

    if (w.ammo <= 0) {
        w.reloading = true;
        w.reloadEndAt = now + wDef.reloadMs;
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
            weaponType: entity.weapon?.type || 'pistol',
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
    const contents = {
        money: Math.max(0, Number(entity.dollarBalance || 0)),
        medkits: ensureInventory(entity).medkits || 0,
        ammoPacks: ensureInventory(entity).ammoPacks || 0,
        weaponType: entity.weapon?.type && entity.weapon.type !== 'pistol' ? entity.weapon.type : null,
    };
    room.loot.push(makeChest(
        entity.x + (Math.random() - 0.5) * 24,
        entity.y + (Math.random() - 0.5) * 24,
        'rare',
        contents,
        'death',
    ));
}

function eliminateSurvivPlayer(room, player, io) {
    if (player._eliminated) return;
    player._eliminated = true;
    dropDeathLoot(room, player);
    const socketId = player.id;
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
        killer: null,
        balance: player.dollarBalance,
        kills: player.kills || 0,
    });
    if (player.isBot) {
        room.bots = room.bots.filter(b => b.id !== player.id);
    } else {
        room.players = room.players.filter(p => p.id !== player.id);
    }
}

function getLootContainer(room, chestId) {
    const index = room.loot.findIndex(l => l.id === chestId);
    if (index < 0) return { item: null, index: -1 };
    const item = room.loot[index];
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
    const contents = item.contents || {};
    let picked = null;
    if (itemKey === 'weapon' && contents.weaponType) {
        picked = { weaponType: contents.weaponType, rarity: contents.rarity };
        delete contents.weaponType;
    } else if (itemKey === 'money' && contents.money) {
        picked = { money: contents.money, rarity: contents.rarity };
        delete contents.money;
    } else if (itemKey === 'medkits' && contents.medkits) {
        picked = { medkits: contents.medkits, rarity: contents.rarity };
        delete contents.medkits;
    } else if (itemKey === 'ammoPacks' && contents.ammoPacks) {
        picked = { ammoPacks: contents.ammoPacks, rarity: contents.rarity };
        delete contents.ammoPacks;
    } else if (itemKey === 'armor' && contents.armor) {
        picked = { armor: contents.armor, rarity: contents.rarity };
        delete contents.armor;
    }
    if (!picked) return;
    const summary = applyLootContents(entity, picked, { countChest: false });
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
        room.loot.splice(index, 1);
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
    const contents = item.contents || {};
    const inv = ensureInventory(entity);

    if (itemKey === 'weapon') {
        const weaponType = request.weaponType || (entity.weapon?.type !== 'pistol' ? entity.weapon?.type : null);
        if (weaponType && weaponType !== 'pistol' && inv.weapons.includes(weaponType)) {
            // Remove from player inventory
            inv.weapons = inv.weapons.filter(w => w !== weaponType);
            // Switch active weapon if player was holding it
            if (entity.weapon?.type === weaponType) {
                entity.weapon = makeWeaponState(inv.weapons[0] || 'pistol');
            }
            // Put into chest contents
            contents.weaponType = weaponType;
            contents.rarity = WEAPONS[weaponType]?.rarity || 'common';
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
        const idx = Number.isInteger(slotIdx) ? slotIdx : inv.weapons.indexOf(entity.weapon?.type);
        if (idx >= 0 && idx < inv.weapons.length) {
            const weaponType = inv.weapons[idx];
            if (weaponType && weaponType !== 'pistol') {
                inv.weapons.splice(idx, 1);
                if (entity.weapon?.type === weaponType) {
                    entity.weapon = makeWeaponState(inv.weapons[0] || 'pistol');
                }
                room.loot.push({
                    id: randId(),
                    type: 'weapon',
                    weaponType: weaponType,
                    x: dropX,
                    y: dropY
                });
            }
        }
    } else if (itemKey === 'medkits' && inv.medkits > 0) {
        inv.medkits -= 1;
        room.loot.push({
            id: randId(),
            type: 'medkit',
            x: dropX,
            y: dropY
        });
    } else if (itemKey === 'ammoPacks' && inv.ammoPacks > 0) {
        inv.ammoPacks -= 1;
        room.loot.push({
            id: randId(),
            type: 'ammo',
            x: dropX,
            y: dropY
        });
    } else if (itemKey === 'armor' && entity.armor > 0) {
        const transfer = Math.min(35, Math.round(entity.armor));
        entity.armor = Math.max(0, entity.armor - transfer);
        room.loot.push({
            id: randId(),
            type: 'armor',
            x: dropX,
            y: dropY
        });
    }
}

function pickupLoot(entity, room) {
    if (entity.isCashingOut) return;
    openLootContainer(entity, room);
    takeLootContainerItem(entity, room);
    putLootContainerItem(entity, room);
    dropPlayerItem(entity, room);
    refreshOpenedContainer(entity, room);

    for (let i = room.loot.length - 1; i >= 0; i--) {
        const item = room.loot[i];
        if (dist(entity.x, entity.y, item.x, item.y) > SURVIV.lootPickupRadius) continue;

        if (item.type === 'chest' || item.type === 'deathCrate') {
            continue;
        } else if (item.type === 'money') {
            entity.dollarBalance = (entity.dollarBalance || 0) + (item.dollarValue || item.amount || 0);
        } else if (item.type === 'medkit') {
            ensureInventory(entity).medkits = Math.min(6, ensureInventory(entity).medkits + 1);
        } else if (item.type === 'armor') {
            entity.armor = Math.min(entity.maxArmor, entity.armor + 35);
        } else if (item.type === 'ammo') {
            applyLootContents(entity, { ammoPacks: 1 }, { countChest: false });
        } else if (item.type === 'weapon' && item.weaponType && WEAPONS[item.weaponType]) {
            applyLootContents(entity, { weaponType: item.weaponType }, { countChest: false });
        }
        room.loot.splice(i, 1);
    }
}

function updateBullets(room, now, effectiveRadius) {
    for (let i = room.bullets.length - 1; i >= 0; i--) {
        const b = room.bullets[i];
        b.x += b.vx;
        b.y += b.vy;

        if (now - b.bornAt > SURVIV.bulletLifetimeMs) {
            room.bullets.splice(i, 1);
            continue;
        }

        if (Math.hypot(b.x, b.y) > SURVIV.worldHalf) {
            room.bullets.splice(i, 1);
            continue;
        }

        let hit = false;
        for (const o of getNearbyObstacles(room, b.x, b.y, 90)) {
            if (pointInRect(b.x, b.y, o)) {
                hit = true;
                break;
            }
        }
        if (hit) {
            room.bullets.splice(i, 1);
            continue;
        }

        const allEntities = [...room.players, ...room.bots];
        for (const ent of allEntities) {
            if (ent.id === b.ownerId || ent.hp <= 0) continue;
            if (dist(b.x, b.y, ent.x, ent.y) < SURVIV.playerRadius) {
                const attacker = allEntities.find(e => e.id === b.ownerId)
                    || room.bots.find(e => e.id === b.ownerId)
                    || room.players.find(e => e.id === b.ownerId);
                applyDamage(ent, b.damage, attacker);
                room.bullets.splice(i, 1);
                if (ent.hp <= 0) {
                    eliminateSurvivPlayer(room, ent, room._io);
                }
                hit = true;
                break;
            }
        }
    }
}

function checkZoneDamage() {
    return;
}

function randomLootSpawn(room) {
    const anchors = room.spawnPoints?.length ? room.spawnPoints : room.landmarks;
    for (let i = 0; i < 30; i++) {
        const base = anchors?.length
            ? anchors[Math.floor(Math.random() * anchors.length)]
            : randomSpawnCoord(SURVIV.worldHalf * 0.88);
        const pos = {
            x: base.x + (Math.random() - 0.5) * 900,
            y: base.y + (Math.random() - 0.5) * 900,
        };
        if (!isPositionBlocked(room, pos.x, pos.y, 18)) return pos;
    }
    return randomSpawnCoord(SURVIV.worldHalf * 0.88);
}

export function spawnLootFromPool(room, poolAmount) {
    if (poolAmount <= 0.01) return;
    room.lootPoolBalance = (room.lootPoolBalance || 0) + poolAmount;

    const moneyCrates = Math.max(2, Math.floor(poolAmount / 0.75));
    const moneyEach = poolAmount * 0.55 / moneyCrates;
    let spent = moneyEach * moneyCrates;

    for (let i = 0; i < moneyCrates; i++) {
        const pos = randomLootSpawn(room);
        room.loot.push(makeChest(pos.x, pos.y, 'common', { money: moneyEach }, 'join'));
    }

    const extras = Math.min(6, Math.floor(poolAmount) + 1);
    for (let i = 0; i < extras; i++) {
        const pos = randomLootSpawn(room);
        const tier = Math.random() > 0.72 ? 'rare' : 'common';
        room.loot.push(makeChest(pos.x, pos.y, tier, randomChestContents(tier), 'join'));
        spent += 0.1;
    }

    room.lootPoolBalance = Math.max(0, room.lootPoolBalance - spent);
}

function syncSurvivBots(room) {
    // Automatic bot spawning disabled per user request
    return;
}

export function spawnSurvivBotNear(room, x, y) {
    const id = 'surviv_bot_' + randId();
    const eco = getSurvivEconomy(room.entryFeeUsd);
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
        weapon: makeWeaponState(Math.random() < 0.5 ? pickWeaponForTier(Math.random() > 0.72 ? 'rare' : 'common') : 'pistol'),
        dollarBalance: eco.playerStartBalance * (0.5 + Math.random()),
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
        useMedkit: false,
        openChestId: null,
        lastLoot: null,
        openedContainerId: null,
        openedContainer: null,
        takeChestItem: null,
        adminSpawned: true,
    };
    addWeaponToInventory(bot, bot.weapon.type);
    room.bots.push(bot);
    return bot;
}

function updateBotAI(bot, room, now, effectiveRadius) {
    if (now < bot.botThinkAt) return;
    bot.botThinkAt = now + 200 + Math.random() * 300;

    const allTargets = [...room.players.filter(p => !p.disconnected), ...room.bots.filter(b => b.id !== bot.id && b.hp > 0)];
    let nearest = null;
    let nearestDist = Infinity;
    for (const t of allTargets) {
        const d = dist(bot.x, bot.y, t.x, t.y);
        if (d < nearestDist) {
            nearestDist = d;
            nearest = t;
        }
    }

    const distFromCenter = Math.hypot(bot.x, bot.y);
    if (distFromCenter > effectiveRadius * 0.75) {
        const { dx, dy } = normalize(-bot.x, -bot.y);
        bot.inputDx = dx;
        bot.inputDy = dy;
    } else if (nearest && nearestDist < 500) {
        bot.botTargetId = nearest.id;
        if (nearestDist > 180) {
            const { dx, dy } = normalize(nearest.x - bot.x, nearest.y - bot.y);
            bot.inputDx = dx;
            bot.inputDy = dy;
        } else if (nearestDist < 100) {
            const { dx, dy } = normalize(bot.x - nearest.x, bot.y - nearest.y);
            bot.inputDx = dx;
            bot.inputDy = dy;
        } else {
            bot.inputDx = 0;
            bot.inputDy = 0;
        }
        bot.aimAngle = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
        bot.shooting = nearestDist < 420;
    } else {
        const nearLoot = room.loot.find(l => dist(bot.x, bot.y, l.x, l.y) < 350);
        if (nearLoot) {
            const nearLootDist = dist(bot.x, bot.y, nearLoot.x, nearLoot.y);
            if (nearLootDist < SURVIV.chestOpenRadius) bot.openChestId = nearLoot.id;
            const { dx, dy } = normalize(nearLoot.x - bot.x, nearLoot.y - bot.y);
            bot.inputDx = dx * 0.7;
            bot.inputDy = dy * 0.7;
        } else {
            bot.inputDx = (Math.random() - 0.5) * 2;
            bot.inputDy = (Math.random() - 0.5) * 2;
        }
        bot.shooting = false;
    }
}

function processEntity(entity, room, now, effectiveRadius) {
    if (entity.hp <= 0) return;
    if (entity.isCashingOut) {
        entity.shooting = false;
        entity.useMedkit = false;
        entity.equipSlotPending = null;
    }

    if (!entity.isCashingOut && entity.useMedkit) {
        useInventoryMedkit(entity);
        entity.useMedkit = false;
    }
    if (!entity.isCashingOut && entity.equipSlotPending != null) {
        equipInventorySlot(entity, entity.equipSlotPending);
        entity.equipSlotPending = null;
    }

    // Process weapon reloading tick independent of shooting
    if (entity.weapon && entity.weapon.reloading) {
        const wDef = WEAPONS[entity.weapon.type] || WEAPONS.pistol;
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
    checkZoneDamage(entity, effectiveRadius);

    if (entity.hp <= 0) {
        eliminateSurvivPlayer(room, entity, room._io);
    }
}

function buildLeaderboard(room) {
    const all = [
        ...room.players.filter(p => !p.disconnected),
        ...room.bots,
    ];
    return all
        .map(p => ({
            username: p.username,
            balance: p.dollarBalance || 0,
            kills: p.kills || 0,
            isBot: !!p.isBot,
        }))
        .sort((a, b) => b.balance - a.balance || b.kills - a.kills)
        .slice(0, 10);
}

function serializePlayer(p, isYou) {
    const wDef = WEAPONS[p.weapon?.type] || WEAPONS.pistol;
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
        weapon: p.weapon?.type || 'pistol',
        ammo: p.weapon?.ammo ?? 0,
        clipSize: wDef.clipSize,
        reloading: !!p.weapon?.reloading,
        reloadEndAt: p.weapon?.reloadEndAt || 0,
        reloadMs: wDef.reloadMs,
        dollarBalance: p.dollarBalance,
        kills: p.kills || 0,
        isBot: !!p.isBot,
        isYou,
        isCashingOut: !!p.isCashingOut,

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

export function processSurvivRoom(room, io, resetTime) {
    room._io = io;
    const now = Date.now();
    const effectiveRadius = getSurvivEffectiveRadius(resetTime);
    const zone = getSurvivZone(resetTime);

    syncSurvivBots(room);

    const entities = [
        ...room.players.filter(p => !p.disconnected && p.hp > 0),
        ...room.bots.filter(b => b.hp > 0),
    ];

    for (const ent of entities) {
        processEntity(ent, room, now, effectiveRadius);
    }

    updateBullets(room, now, effectiveRadius);

    return { leaderboard: buildLeaderboard(room), zone };
}

export function broadcastSurvivState(room, io, lbData, meta) {
    const { leaderboard, zone } = lbData;
    const range = SURVIV.viewRange;
    const now = Date.now();
    const sendLb = !room._lastSurvivLbAt || now - room._lastSurvivLbAt >= 500;
    if (sendLb) room._lastSurvivLbAt = now;

    const allPlayers = [
        ...room.players.filter(p => !p.disconnected && p.hp > 0),
        ...room.bots.filter(b => b.hp > 0),
    ];

    const emitToViewer = (socketId, viewX, viewY, youId, dollarBalance, spectating) => {
        if (sendLb) {
            io.to(socketId).emit('leaderboard', { leaderboard, surviv: true });
        }

        const visiblePlayers = allPlayers
            .filter(p => isInView(viewX, viewY, p.x, p.y, range))
            .map(p => serializePlayer(p, p.id === youId));

        const visibleLoot = room.loot
            .filter(l => isInView(viewX, viewY, l.x, l.y, range))
            .map(l => ({
                id: l.id,
                type: l.type,
                x: l.x,
                y: l.y,
                dollarValue: l.dollarValue,
                weaponType: l.weaponType,
                tier: l.tier,
                source: l.source,
            }));

        const visibleBullets = room.bullets
            .filter(b => isInView(viewX, viewY, b.x, b.y, range))
            .map(b => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, ownerId: b.ownerId, weaponType: b.weaponType }));

        const visibleObstacles = queryObstacles(room, viewX, viewY, range + 200, false)
            .filter(o => isObstacleInView(viewX, viewY, o, range + 200))
            .map(o => ({
                id: o.id,
                x: o.x,
                y: o.y,
                w: o.w,
                h: o.h,
                hue: o.hue,
                kind: o.kind,
                rotation: o.rotation,
                collidable: o.collidable !== false,
                variant: o.variant,
                biome: o.biome,
                label: o.label,
            }));

        io.to(socketId).emit('survivTick', {
            you: youId ? serializePlayer(
                allPlayers.find(p => p.id === youId) || { id: youId, x: viewX, y: viewY, dollarBalance, hp: 0 },
                true,
            ) : null,
            players: visiblePlayers,
            loot: visibleLoot,
            bullets: visibleBullets,
            obstacles: visibleObstacles,
            zone,
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
}

