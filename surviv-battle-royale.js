import { SURVIV, createSurvivPlayer, generateSurvivMap, resetSurvivRoomRuntime, isSurvivSpawnPositionSafe } from './surviv-engine.js';

export const SURVIV_BR = Object.freeze({ minPlayers: 10, maxPlayers: 25, initialRadius: 3400 });
// Arenifi pacing for 10–25 players, not claimed historical Surviv.io values.
export const SURVIV_BR_PHASES = Object.freeze([
    { waitMs: 45000, moveMs: 35000, radius: 2400, damage: 2 },
    { waitMs: 30000, moveMs: 30000, radius: 1500, damage: 3 },
    { waitMs: 25000, moveMs: 25000, radius: 850, damage: 5 },
    { waitMs: 18000, moveMs: 22000, radius: 420, damage: 8 },
    { waitMs: 12000, moveMs: 18000, radius: 150, damage: 12 },
    { waitMs: 8000, moveMs: 16000, radius: 0, damage: 20 },
]);

export function createSurvivBRZonePlan(startedAt, random = Math.random) {
    let previous = { x: 0, y: 0, radius: SURVIV_BR.initialRadius };
    let at = startedAt;
    return SURVIV_BR_PHASES.map((phase, index) => {
        const angle = random() * Math.PI * 2;
        // Every target circle is wholly contained in its predecessor.
        const offset = Math.sqrt(random()) * (previous.radius - phase.radius) * 0.55;
        const target = { x: previous.x + Math.cos(angle) * offset, y: previous.y + Math.sin(angle) * offset, radius: phase.radius };
        const result = { ...phase, phase: index + 1, from: previous, to: target, startsAt: at, movesAt: at + phase.waitMs, endsAt: at + phase.waitMs + phase.moveMs };
        previous = target;
        at = result.endsAt;
        return result;
    });
}

export function getSurvivBRZone(plan, now) {
    const stage = plan.find(phase => now < phase.endsAt) || plan[plan.length - 1];
    const progress = Math.max(0, Math.min(1, (now - stage.movesAt) / stage.moveMs));
    return {
        x: stage.from.x + (stage.to.x - stage.from.x) * progress,
        y: stage.from.y + (stage.to.y - stage.from.y) * progress,
        radius: stage.from.radius + (stage.to.radius - stage.from.radius) * progress,
        targetX: stage.to.x, targetY: stage.to.y, targetRadius: stage.to.radius,
        phase: stage.phase, progress, shrinking: now >= stage.movesAt && now < stage.endsAt,
        damagePerSecond: stage.damage,
        startsInMs: Math.max(0, stage.movesAt - now), endsInMs: Math.max(0, stage.endsAt - now),
        final: now >= plan[plan.length - 1].endsAt,
    };
}

export function initializeSurvivBRRoom(room, map = generateSurvivMap(SURVIV.worldHalf)) {
    resetSurvivRoomRuntime(room, map);
    // Fees belong to the isolated winner pot, never to world loot or balances.
    room.loot = room.loot.filter(item => item.type !== 'money');
    room._brSpawnPoints = (room.spawnPoints || []).filter(point => Math.hypot(point.x, point.y) < SURVIV_BR.initialRadius - 350);
    if (!room.obstacles.length) throw new Error('Surviv BR map needs at least 25 safe spawn points.');
    for (let x = -2700; x <= 2700; x += 320) {
        for (let y = -2700; y <= 2700; y += 320) {
            const point = { x: x + Math.random() * 100, y: y + Math.random() * 100 };
            if (Math.hypot(point.x, point.y) < SURVIV_BR.initialRadius - 350
                && isSurvivSpawnPositionSafe(room, point.x, point.y, 58)) room._brSpawnPoints.push(point);
        }
    }
    if (room._brSpawnPoints.length < SURVIV_BR.maxPlayers) throw new Error('Surviv BR map needs at least 25 safe spawn points.');
    room._brSpawnPoints = [...room._brSpawnPoints];
    for (let i = room._brSpawnPoints.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room._brSpawnPoints[i], room._brSpawnPoints[j]] = [room._brSpawnPoints[j], room._brSpawnPoints[i]];
    }
    room.zonePlan = createSurvivBRZonePlan(room.countdownEndsAt);
    room.zone = getSurvivBRZone(room.zonePlan, Date.now());
    return room;
}

export function createSurvivBRPlayer(entry, room) {
    const color = !entry.skinColor || entry.skinColor === 'random' || entry.skinColor === 'random_color'
        ? ['#c080ff', '#80d0d0', '#d8b878', '#81b6dd', '#de8e88'][Math.floor(Math.random() * 5)] : entry.skinColor;
    const player = createSurvivPlayer(entry.socketId, entry.mongoId, entry.username, color, room);
    const candidates = room._brSpawnPoints;
    // Farthest-point selection prevents players spawning on top of each other.
    let best = candidates[0];
    let separation = -1;
    for (const point of candidates) {
        const distance = room.players.length ? Math.min(...room.players.map(other => Math.hypot(point.x - other.x, point.y - other.y))) : 1;
        if (distance > separation) { separation = distance; best = point; }
    }
    candidates.splice(candidates.indexOf(best), 1);
    Object.assign(player, { x: best.x, y: best.y, dollarBalance: 0, isBattleRoyale: true, brMatchId: room.id });
    return player;
}

export function survivBRMeta(room, now = Date.now()) {
    return {
        width: SURVIV.worldHalf * 2, height: SURVIV.worldHalf * 2,
        mode: 'br-surviv', battleRoyale: true, matchId: room.id,
        matchStatus: room.status, countdownRemainingMs: Math.max(0, room.countdownEndsAt - now),
        prizePool: room.prizePool, playerCount: room.playerCount, entryFeeUsd: room.entryFeeUsd,
        zone: room.zone, resetTime: null, cashOutRemaining: 0, isResetting: false,
        personalFreePlay: !!room.personalFreePlay,
    };
}
