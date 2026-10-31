// Intentional coarse awareness, never an exact opponent position/range/id.
export function directionalWarnings(viewer, sources, { minDistance = 0, maxDistance = 1800 } = {}) {
    const sectors = new Set();
    for (const source of sources) {
        if (!source || source.id === viewer.id || source.ownerId === viewer.id) continue;
        const dx = source.x - viewer.x, dy = source.y - viewer.y;
        const distance = Math.hypot(dx, dy);
        if (!Number.isFinite(distance) || distance <= minDistance || distance > maxDistance) continue;
        const sector = (Math.round(Math.atan2(dy, dx) / (Math.PI / 8)) + 16) % 16;
        sectors.add(sector);
    }
    return [...sectors].slice(0, 8).map(sector => ({ angle: sector * Math.PI / 8, strength: .85 }));
}
