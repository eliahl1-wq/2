/**
 * Surviv — top-down battle royale shooter engine.
 * Inspired by surviv.io mechanics: loot, weapons, shrinking zone, contested economy.
 */

import { getSurvivEconomy } from './economy.js';

const TICK_RATE = 40;
const TICK_DT = 1 / TICK_RATE;

export const SURVIV = {
    worldHalf: 2000,
    shrinkBeforeResetMs: 3 * 60 * 1000,
    playerRadius: 14,
    playerSpeed: 5.2,
    viewRange: 900,
    botTargetCount: 12,
    zoneDamagePerTick: 0.35,
    bulletLifetimeMs: 1200,
    lootPickupRadius: 22,
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
    if (d >= r || d < 1e-6) return { x: cx, y: cy };
    const overlap = r - d;
    const nx = (cx - closestX) / d;
    const ny = (cy - closestY) / d;
    return { x: cx + nx * overlap, y: cy + ny * overlap };
}

export function generateSurvivObstacles(worldHalf) {
    const obstacles = [];
    const count = 38 + Math.floor(Math.random() * 14);
    for (let i = 0; i < count; i++) {
        const w = 60 + Math.random() * 120;
        const h = 60 + Math.random() * 120;
        const { x, y } = randomSpawnCoord(worldHalf * 0.9);
        const tooClose = obstacles.some(o => dist(x, y, o.x, o.y) < 100);
        if (tooClose) continue;
        obstacles.push({
            id: randId(),
            x, y, w, h,
            hue: 210 + Math.floor(Math.random() * 30),
        });
    }
    return obstacles;
}

export function getSurvivEffectiveRadius(resetTime) {
    const worldHalf = SURVIV.worldHalf;
    const msUntilReset = resetTime - Date.now();
    const shrinkMs = SURVIV.shrinkBeforeResetMs;
    if (msUntilReset >= shrinkMs) return worldHalf;
    if (msUntilReset <= 0) return 0;
    return worldHalf * (msUntilReset / shrinkMs);
}

export function getSurvivZone(resetTime) {
    const radius = getSurvivEffectiveRadius(resetTime);
    const msUntilReset = resetTime - Date.now();
    return {
        cx: 0,
        cy: 0,
        radius,
        shrinking: msUntilReset < SURVIV.shrinkBeforeResetMs,
    };
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
    };
}

function pickSurvivSpawn(room) {
    for (let i = 0; i < 60; i++) {
        const pos = randomSpawnCoord(SURVIV.worldHalf);
        if (!isPositionBlocked(room, pos.x, pos.y, SURVIV.playerRadius + 8)) {
            const clear = [...room.players, ...room.bots].every(p =>
                dist(pos.x, pos.y, p.x, p.y) > 80
            );
            if (clear) return pos;
        }
    }
    return randomSpawnCoord(SURVIV.worldHalf);
}

function isPositionBlocked(room, x, y, r) {
    for (const o of room.obstacles) {
        if (circleRectCollision(x, y, r, o)) return true;
    }
    return false;
}

function moveEntity(entity, room, dx, dy, speed) {
    const { dx: nx, dy: ny } = normalize(dx, dy);
    let newX = entity.x + nx * speed;
    let newY = entity.y + ny * speed;

    const r = entity.radius || SURVIV.playerRadius;
    const wh = SURVIV.worldHalf - r;
    newX = clamp(newX, -wh, wh);
    newY = clamp(newY, -wh, wh);

    for (const o of room.obstacles) {
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
    const dollars = Math.max(0, entity.dollarBalance || 0);
    if (dollars > 0.01) {
        room.loot.push({
            id: randId(),
            type: 'money',
            x: entity.x + (Math.random() - 0.5) * 20,
            y: entity.y + (Math.random() - 0.5) * 20,
            dollarValue: dollars,
            amount: dollars,
        });
    }
    const wType = entity.weapon?.type;
    if (wType && wType !== 'pistol' && Math.random() < 0.65) {
        room.loot.push({
            id: randId(),
            type: 'weapon',
            x: entity.x + (Math.random() - 0.5) * 24,
            y: entity.y + (Math.random() - 0.5) * 24,
            weaponType: wType,
        });
    }
    if (Math.random() < 0.4) {
        room.loot.push({
            id: randId(),
            type: 'medkit',
            x: entity.x + (Math.random() - 0.5) * 28,
            y: entity.y + (Math.random() - 0.5) * 28,
        });
    }
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

        if (item.type === 'money') {
            entity.dollarBalance = (entity.dollarBalance || 0) + (item.dollarValue || item.amount || 0);
        } else if (item.type === 'medkit') {
            entity.hp = Math.min(entity.maxHp, entity.hp + 50);
        } else if (item.type === 'armor') {
            entity.armor = Math.min(entity.maxArmor, entity.armor + 35);
        } else if (item.type === 'ammo') {
            const wDef = WEAPONS[entity.weapon.type] || WEAPONS.pistol;
            entity.weapon.ammo = Math.min(wDef.clipSize, entity.weapon.ammo + Math.floor(wDef.clipSize * 0.5));
        } else if (item.type === 'weapon' && item.weaponType && WEAPONS[item.weaponType]) {
            entity.weapon = makeWeaponState(item.weaponType);
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
        for (const o of room.obstacles) {
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

function checkZoneDamage(entity, effectiveRadius) {
    if (effectiveRadius <= 0) return;
    if (Math.hypot(entity.x, entity.y) > effectiveRadius - SURVIV.playerRadius) {
        entity.hp -= SURVIV.zoneDamagePerTick;
    }
}

export function spawnLootFromPool(room, poolAmount) {
    if (poolAmount <= 0.01) return;
    room.lootPoolBalance = (room.lootPoolBalance || 0) + poolAmount;

    const moneyCrates = Math.max(2, Math.floor(poolAmount / 0.75));
    const moneyEach = poolAmount * 0.55 / moneyCrates;
    let spent = moneyEach * moneyCrates;

    for (let i = 0; i < moneyCrates; i++) {
        const pos = randomSpawnCoord(SURVIV.worldHalf * 0.88);
        if (isPositionBlocked(room, pos.x, pos.y, 10)) continue;
        room.loot.push({
            id: randId(),
            type: 'money',
            x: pos.x,
            y: pos.y,
            dollarValue: moneyEach,
            amount: moneyEach,
        });
    }

    const extras = Math.min(4, Math.floor(poolAmount));
    for (let i = 0; i < extras; i++) {
        const pos = randomSpawnCoord(SURVIV.worldHalf * 0.88);
        const roll = Math.random();
        if (roll < 0.35) {
            room.loot.push({ id: randId(), type: 'weapon', x: pos.x, y: pos.y, weaponType: LOOT_WEAPON_TYPES[Math.floor(Math.random() * LOOT_WEAPON_TYPES.length)] });
        } else if (roll < 0.55) {
            room.loot.push({ id: randId(), type: 'medkit', x: pos.x, y: pos.y });
        } else if (roll < 0.75) {
            room.loot.push({ id: randId(), type: 'armor', x: pos.x, y: pos.y });
        } else {
            room.loot.push({ id: randId(), type: 'ammo', x: pos.x, y: pos.y });
        }
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
    };
    room.bots.push(bot);
    return bot;
}
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
    };
}

function isInView(vx, vy, x, y, range) {
    return Math.abs(x - vx) <= range && Math.abs(y - vy) <= range;
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
            }));

        const visibleBullets = room.bullets
            .filter(b => isInView(viewX, viewY, b.x, b.y, range))
            .map(b => ({ id: b.id, x: b.x, y: b.y, ownerId: b.ownerId }));

        const visibleObstacles = room.obstacles
            .filter(o => isInView(viewX, viewY, o.x, o.y, range + 200))
            .map(o => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, hue: o.hue }));

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
