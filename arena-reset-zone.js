export const RESET_ZONE_DURATION_MS = 10 * 60 * 1000;

export function getArenaResetZone(resetAt, now, { cx = 0, cy = 0, radius }) {
    if (!Number.isFinite(resetAt) || !Number.isFinite(radius)) return null;
    const startsAt = resetAt - RESET_ZONE_DURATION_MS;
    // Close one simulation second before the maintenance boundary so a final
    // death is processed before the existing settlement/reset transaction.
    const progress = Math.max(0, Math.min(1, (now - startsAt) / (RESET_ZONE_DURATION_MS - 1000)));
    return { cx, cy, x: cx, y: cy, radius: radius * (1 - progress), progress,
        shrinking: progress > 0 && progress < 1, fullyClosed: progress >= 1,
        startsInMs: Math.max(0, startsAt - now), endsInMs: Math.max(0, resetAt - now), resetZone: true };
}

export function isResetZoneLethal(entity, x, y, zone, now) {
    if (!zone || zone.progress <= 0 || entity.cashoutSettling || entity._arenaCashoutReservationUsd > 0) {
        entity._resetZoneOutsideAt = null; return false;
    }
    if (zone.fullyClosed) return true;
    if (Math.hypot(x - zone.cx, y - zone.cy) <= zone.radius) {
        entity._resetZoneOutsideAt = null; return false;
    }
    entity._resetZoneOutsideAt ??= now;
    return now - entity._resetZoneOutsideAt >= 3000;
}

export function applyAgarResetZone(room, zone, now, onDeath = () => {}) {
    if (!zone?.progress || room.isBattleRoyale || room.isTournament || room.isSandbox) return;
    for (const entity of [...room.players, ...room.bots]) {
        if (entity.mode === 'slither' || entity.isAgarSpectator || !entity.cells?.length) continue;
        const mass = entity.cells.reduce((s,c) => s + Math.max(.0001, Number(c.balance) || 0), 0);
        const x = entity.cells.reduce((s,c) => s + c.x * Math.max(.0001, Number(c.balance) || 0), 0) / mass;
        const y = entity.cells.reduce((s,c) => s + c.y * Math.max(.0001, Number(c.balance) || 0), 0) / mass;
        if (!isResetZoneLethal(entity, x, y, zone, now)) continue;
        const dollars = Math.max(0, Number(entity.dollarBalance ?? entity.balance) || 0);
        // Move the existing stake back to funded map reserves, never mint or
        // destroy it. The existing reset sweep later owns uncollected value.
        room.foodPoolBalance = (Number(room.foodPoolBalance) || 0) + dollars;
        entity.dollarBalance = 0; entity.balance = 0; entity.cells = [];
        room.players = room.players.filter(p => p !== entity);
        room.bots = room.bots.filter(p => p !== entity);
        onDeath(entity, dollars);
    }
}
