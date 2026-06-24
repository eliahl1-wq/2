/**
 * Surviv — top-down battle royale shooter engine.
 * Inspired by surviv.io mechanics: loot, weapons, shrinking zone, contested economy.
 */

import { getSurvivEconomy } from './economy.js';

const TICK_RATE = 40;
const TICK_DT = 1 / TICK_RATE;

export const SURVIV = {
    worldHalf: 40000,
    shrinkBeforeResetMs: 3 * 60 * 1000,
    playerRadius: 14,
    playerSpeed: 5.2,
    viewRange: 1200,
    botTargetCount: 12,
    zoneDamagePerTick: 0,
    bulletLifetimeMs: 1200,
    lootPickupRadius: 34,
};

export const WEAPONS = {
    pistol: {
        id: 'pistol',
        label: 'Pistol',
        damage: 11,
        fireRateMs: 380,
        clipSize: 15,
        reloadMs: 1400,
        spread: 0.06,
        bulletSpeed: 19,
        pellets: 1,
    },
    smg: {
        id: 'smg',
        label: 'SMG',
        damage: 7,
        fireRateMs: 90,
        clipSize: 30,
        reloadMs: 1800,
        spread: 0.14,
        bulletSpeed: 21,
        pellets: 1,
    },
    shotgun: {
        id: 'shotgun',
        label: 'Shotgun',
        damage: 5,
        fireRateMs: 750,
        clipSize: 6,
        reloadMs: 2200,
        spread: 0.32,
        bulletSpeed: 17,
        pellets: 5,
    },
    assault: {
        id: 'assault',
        label: 'Assault',
        damage: 14,
        fireRateMs: 160,
        clipSize: 22,
        reloadMs: 2000,
        spread: 0.09,
        bulletSpeed: 23,
        pellets: 1,
    },
};

const BOT_NAMES = [
    'Scout', 'Raider', 'Ghost', 'Viper', 'Hawk', 'Wolf', 'Rogue', 'Blaze',
    'Nomad', 'Cipher', 'Ranger', 'Striker', 'Hunter', 'Ace', 'Reaper',
];

const LOOT_WEAPON_TYPES = ['smg', 'shotgun', 'assault'];

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
    const contents = {};
    const moneyBase = tier === 'rare' ? 0.85 : tier === 'military' ? 1.2 : 0.45;
    contents.money = Number((moneyBase * (0.5 + Math.random())).toFixed(2));

    const roll = Math.random();
    if (tier === 'military' || roll < 0.25) {
        contents.weaponType = LOOT_WEAPON_TYPES[Math.floor(Math.random() * LOOT_WEAPON_TYPES.length)];
    }
    if (tier === 'rare' || tier === 'military' || roll > 0.35) {
        contents.ammoPacks = 1 + Math.floor(Math.random() * (tier === 'military' ? 3 : 2));
    }
    if (roll > 0.48) contents.medkits = 1;
    if (tier !== 'common' || roll > 0.68) contents.armor = tier === 'military' ? 55 : 35;
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

    if (w > 190) addWall(obstacles, x, y, wall, h * 0.55, variant);
    if (h > 180) addWall(obstacles, x + w * 0.18, y - h * 0.08, w * 0.38, wall, variant);

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

export function generateSurvivMap(worldHalf) {
    const obstacles = [];
    const loot = [];
    const spawnPoints = [];
    const landmarks = [];

    const pois = [
        { name: 'Old Estate', x: 0, y: 0, type: 'mansion' },
        { name: 'North Lab', x: 0, y: -27500, type: 'lab' },
        { name: 'Pine Town', x: -16500, y: -12500, type: 'town' },
        { name: 'Quarry', x: 18500, y: -14500, type: 'quarry' },
        { name: 'West Village', x: -30500, y: 1500, type: 'town' },
        { name: 'Dry Farm', x: -21500, y: 15500, type: 'farm' },
        { name: 'Container Docks', x: 22500, y: 17500, type: 'yard' },
        { name: 'East Depot', x: 31000, y: -4500, type: 'yard' },
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
        } else {
            addSettlement(obstacles, loot, spawnPoints, poi.x, poi.y, 8, 'town');
        }
    }

    for (let i = 0; i < 46; i++) {
        const pos = randomSpawnCoord(worldHalf * 0.88);
        addSettlement(obstacles, loot, spawnPoints, pos.x, pos.y, 3 + Math.floor(Math.random() * 4), i % 5 === 0 ? 'farm' : 'village');
    }

    for (let i = 0; i < 28; i++) {
        const pos = randomSpawnCoord(worldHalf * 0.9);
        addForest(obstacles, loot, spawnPoints, pos.x, pos.y, 18 + Math.floor(Math.random() * 22), 360 + Math.random() * 420);
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

function applyLootContents(entity, contents = {}) {
    const inv = ensureInventory(entity);
    inv.chestsOpened += 1;
    if (contents.money) {
        entity.dollarBalance = (entity.dollarBalance || 0) + Number(contents.money || 0);
    }
    if (contents.medkits) {
        inv.medkits = Math.min(6, inv.medkits + Number(contents.medkits || 0));
    }
    if (contents.armor) {
        entity.armor = Math.min(entity.maxArmor, (entity.armor || 0) + Number(contents.armor || 0));
    }
    if (contents.ammoPacks) {
        const packs = Number(contents.ammoPacks || 0);
        inv.ammoPacks = Math.min(9, inv.ammoPacks + packs);
        const wDef = WEAPONS[entity.weapon.type] || WEAPONS.pistol;
        entity.weapon.ammo = Math.min(wDef.clipSize, entity.weapon.ammo + Math.ceil(wDef.clipSize * 0.4 * packs));
    }
    if (contents.weaponType && WEAPONS[contents.weaponType]) {
        entity.weapon = makeWeaponState(contents.weaponType);
        addWeaponToInventory(entity, contents.weaponType);
    }
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
    };
}

function pickSurvivSpawn(room) {
    const spawnPoints = Array.isArray(room.spawnPoints) ? room.spawnPoints : [];
    for (let i = 0; i < 80; i++) {
        const base = spawnPoints.length && Math.random() < 0.88
            ? spawnPoints[Math.floor(Math.random() * spawnPoints.length)]
            : randomSpawnCoord(SURVIV.worldHalf * 0.92);
        const pos = {
            x: base.x + (Math.random() - 0.5) * 220,
            y: base.y + (Math.random() - 0.5) * 220,
        };
        if (!isPositionBlocked(room, pos.x, pos.y, SURVIV.playerRadius + 10)) {
            const clear = [...room.players, ...room.bots].every(p => dist(pos.x, pos.y, p.x, p.y) > 95);
            if (clear) return pos;
        }
    }
    return randomSpawnCoord(SURVIV.worldHalf * 0.86);
}

function isPositionBlocked(room, x, y, r) {
    for (const o of room.obstacles) {
        if (o.collidable === false) continue;
        if (circleRectCollision(x, y, r, o)) return true;
    }
    return false;
}

function getNearbyObstacles(room, x, y, range) {
    return room.obstacles.filter(o => o.collidable !== false
        && Math.abs(o.x - x) <= range + o.w / 2
        && Math.abs(o.y - y) <= range + o.h / 2);
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

function pickupLoot(entity, room) {
    for (let i = room.loot.length - 1; i >= 0; i--) {
        const item = room.loot[i];
        if (dist(entity.x, entity.y, item.x, item.y) > SURVIV.lootPickupRadius) continue;

        if (item.type === 'chest' || item.type === 'deathCrate') {
            applyLootContents(entity, item.contents || {});
        } else if (item.type === 'money') {
            entity.dollarBalance = (entity.dollarBalance || 0) + (item.dollarValue || item.amount || 0);
        } else if (item.type === 'medkit') {
            ensureInventory(entity).medkits = Math.min(6, ensureInventory(entity).medkits + 1);
        } else if (item.type === 'armor') {
            entity.armor = Math.min(entity.maxArmor, entity.armor + 35);
        } else if (item.type === 'ammo') {
            applyLootContents(entity, { ammoPacks: 1 });
        } else if (item.type === 'weapon' && item.weaponType && WEAPONS[item.weaponType]) {
            applyLootContents(entity, { weaponType: item.weaponType });
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
        weapon: makeWeaponState(Math.random() < 0.3 ? LOOT_WEAPON_TYPES[Math.floor(Math.random() * 3)] : 'pistol'),
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
        return;
    }

    if (entity.useMedkit) {
        useInventoryMedkit(entity);
        entity.useMedkit = false;
    }
    if (entity.equipSlotPending != null) {
        equipInventorySlot(entity, entity.equipSlotPending);
        entity.equipSlotPending = null;
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
        dollarBalance: p.dollarBalance,
        kills: p.kills || 0,
        isBot: !!p.isBot,
        isYou,
        isCashingOut: !!p.isCashingOut,
        inventory: ensureInventory(p),
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
            .map(b => ({ id: b.id, x: b.x, y: b.y, ownerId: b.ownerId }));

        const visibleObstacles = room.obstacles
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
