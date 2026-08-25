export function getAgarBotCellCenter(cells) {
    if (!Array.isArray(cells) || cells.length === 0) return null;
    let x = 0;
    let y = 0;
    let weight = 0;
    for (const cell of cells) {
        const mass = Math.max(0.0001, Number(cell?.balance) || 0);
        x += (Number(cell?.x) || 0) * mass;
        y += (Number(cell?.y) || 0) * mass;
        weight += mass;
    }
    return { x: x / weight, y: y / weight };
}

export function planAgarBotSplit({
    cells,
    prey,
    now,
    lastSplitAt = 0,
    maxCells = 16,
    massStart = 1,
}) {
    if (!Array.isArray(cells) || cells.length === 0 || cells.length >= maxCells || !prey) return null;
    if (now - lastSplitAt < 1200) return null;

    const source = cells.reduce((largest, cell) => (
        (Number(cell.balance) || 0) > (Number(largest.balance) || 0) ? cell : largest
    ), cells[0]);
    const sourceMass = Number(source.balance) || 0;
    const preyMass = Number(prey.balance) || 0;
    if (sourceMass < massStart * 2 || sourceMass / 2 <= preyMass * 1.08) return null;

    // The launch impulse travels roughly 165 world units before friction, with
    // normal movement adding useful reach while the piece is in flight.
    const distance = Math.hypot(prey.x - source.x, prey.y - source.y);
    const minDistance = Math.max(30, (Number(source.radius) || 0) * 0.45);
    const maxDistance = (Number(source.radius) || 0) + (Number(prey.radius) || 0) + 235;
    if (!(distance > minDistance && distance < maxDistance)) return null;

    return {
        sourceCellId: source.id,
        angle: Math.atan2(prey.y - source.y, prey.x - source.x),
    };
}

export function planAgarBotEscapeSplit({
    cells,
    threat,
    now,
    lastSplitAt = 0,
    maxCells = 16,
    massStart = 1,
}) {
    if (!Array.isArray(cells) || cells.length !== 1 || cells.length >= maxCells || !threat) return null;
    if (now - lastSplitAt < 1600) return null;

    const source = cells[0];
    if ((Number(source.balance) || 0) < massStart * 3.2) return null;
    const distance = Math.hypot(source.x - threat.x, source.y - threat.y);
    const dangerDistance = (Number(source.radius) || 0) + (Number(threat.radius) || 0) + 115;
    if (distance >= dangerDistance) return null;

    return {
        sourceCellId: source.id,
        angle: Math.atan2(source.y - threat.y, source.x - threat.x),
    };
}
