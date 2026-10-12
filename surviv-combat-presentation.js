// Ephemeral presentation only. Damage, ammunition and cadence stay in the engine.
const REPLAY_MS = 400;
const MAX_EVENTS = 192;

export function survivImpactMaterial(object) {
    const kind = String(object?.kind || '').toLowerCase();
    const variant = String(object?.variant || '').toLowerCase();
    if (kind === 'player') return 'blood';
    if (['tree', 'log'].includes(kind) || variant === 'wood'
        || object?.containerType === 'wood_crate') return 'wood';
    if (['bush', 'plant'].includes(kind) || variant === 'houseplant') return 'foliage';
    if (['sandbag', 'tent', 'haybale'].includes(kind)
        || ['sofa', 'armchair', 'bed', 'hospitalbed', 'bunkbed'].includes(variant)) return 'soft';
    if (['rock', 'wall', 'interiorwall'].includes(kind)
        || ['stone', 'concrete', 'toilet', 'bathtub', 'vanity'].includes(variant)) return 'stone';
    if (['barrel', 'container', 'machine', 'locker', 'chest', 'deathcrate'].includes(kind)
        || ['metal', 'industrial', 'labbench', 'controlconsole', 'generator', 'serverrack'].includes(variant)) return 'metal';
    return 'wood';
}

export function recordSurvivCombatEvent(room, event, now) {
    if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
    room._survivCombatSequence = (room._survivCombatSequence || 0) + 1;
    const events = room._survivCombatEvents || [];
    events.push({ ...event, id: `combat:${room._survivCombatSequence}`, createdAt: now });
    while (events.length && now - events[0].createdAt >= REPLAY_MS) events.shift();
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    room._survivCombatEvents = events;
}

export function recordSurvivBulletImpact(room, bullet, previousX, previousY, hitT, object, now) {
    recordSurvivCombatEvent(room, {
        type: 'impact', ownerId: bullet.ownerId, weaponType: bullet.weaponType,
        bulletId: bullet.id, fromX: previousX, fromY: previousY,
        x: previousX + (bullet.x - previousX) * hitT,
        y: previousY + (bullet.y - previousY) * hitT,
        angle: Math.atan2(bullet.vy, bullet.vx), material: survivImpactMaterial(object),
        ...(object?.kind !== 'player' && object?.id ? { objectId: object.id } : {}),
    }, now);
}

export function collectSurvivCombatEvents(room, now, visibleOwners, isPointVisible) {
    const events = room._survivCombatEvents || [];
    return events.filter(event => now - event.createdAt < REPLAY_MS
        && visibleOwners.has(event.ownerId) && isPointVisible(event))
        .map(({ createdAt, ...event }) => ({ ...event, ageMs: Math.max(0, now - createdAt) }));
}
