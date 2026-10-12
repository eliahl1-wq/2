// World snapshots replace older snapshots. Do not spend the shared game tick
// building a packet that a congested transport cannot send right now.
export function isGameTransportReady(io, socketId) {
    const sockets = io.sockets?.sockets;
    if (!sockets?.get) return true; // Engine fixtures do not have real sockets.
    const socket = sockets.get(socketId);
    return !!socket?.connected
        && socket.conn?.transport?.writable !== false
        && !(socket.conn?.writeBuffer?.length > 0);
}

export function emitGameSnapshot(io, socketId, event, args, { reliable = false } = {}) {
    if (!reliable && !isGameTransportReady(io, socketId)) return false;
    const target = io.to(socketId);
    (reliable ? target : (target.volatile || target)).emit(event, ...args);
    return true;
}

export function usesCompactSlitherSnapshots(io, socketId) {
    return Number(io.sockets?.sockets?.get?.(socketId)?.handshake?.auth?.snapshotProtocol) >= 2;
}

export function packSlitherSnake(snapshot) {
    const { segments, ...metadata } = snapshot;
    const segmentPositions = new Array(segments.length * 2);
    for (let i = 0; i < segments.length; i++) {
        segmentPositions[i * 2] = segments[i].x;
        segmentPositions[i * 2 + 1] = segments[i].y;
    }
    return { ...metadata, segmentPositions };
}

// Keep private account ids, AI state, physics scratch data and Node timer
// objects out of public Agar snapshots. Only send the fields the game draws.
export function serializeAgarPlayer(player) {
    return {
        id: player.id,
        username: player.username || '',
        x: player.x,
        y: player.y,
        color: player.color,
        balance: player.balance,
        dollarBalance: player.dollarBalance,
        kills: player.kills || 0,
        isBot: !!player.isBot,
        cells: (player.cells || []).map(cell => ({
            id: cell.id, x: cell.x, y: cell.y,
            radius: cell.radius, balance: cell.balance,
        })),
        isCashingOut: !!player.isCashingOut,
        cashOutEndTime: player.cashOutEndTime || 0,
        cashoutHoldActive: !!player.cashoutHoldActive,
        cashoutHoldStartedAt: player.cashoutHoldStartedAt || 0,
    };
}

export function getAgarSnapshotSchedule(room, viewer, now) {
    room._agarViewerNetworkState ||= new Map();
    const states = room._agarViewerNetworkState;
    if (now >= (room._agarNetworkPruneAt || 0)) {
        room._agarNetworkPruneAt = now + 10000;
        for (const [id, state] of states) if (now - state.seenAt > 30000) states.delete(id);
    }
    const state = states.get(viewer.id) || {};
    const moved = state.x == null || Math.abs(viewer.x - state.x) > 280 || Math.abs(viewer.y - state.y) > 280;
    const resized = state.w !== viewer.screenWidth || state.h !== viewer.screenHeight;
    const food = moved || resized || state.foodAt == null || now - state.foodAt >= 100;
    const minimap = moved || resized || state.minimapAt == null || now - state.minimapAt >= 250;
    const leaderboard = state.leaderboardAt == null || now - state.leaderboardAt >= 500;
    state.seenAt = now;
    if (food) { state.foodAt = now; state.x = viewer.x; state.y = viewer.y; state.w = viewer.screenWidth; state.h = viewer.screenHeight; }
    if (minimap) state.minimapAt = now;
    if (leaderboard) state.leaderboardAt = now;
    states.set(viewer.id, state);
    return { food, minimap, leaderboard };
}
