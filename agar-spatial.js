import { Point } from './quadtree.js';

// Agar food never moves. Every production mutation replaces the food array or
// changes its length. Preserve those points between changes and only truncate
// the dynamic suffix of touched nodes. No cache fields enter public entities.
const treeStates = new WeakMap();
export function rebuildAgarSpatialTree(tree, { food = [], viruses = [], ejected = [] }, players, allAsPlayers = false) {
    let state = treeStates.get(tree);
    if (!state) { state = { touchedNodes: new Map() }; treeStates.set(tree, state); }
    if (state.food !== food || state.foodCount !== food.length) {
        tree.clear();
        for (const f of food) tree.insert(new Point(f.x, f.y, { type: 'food', data: f }));
        state.food = food;
        state.foodCount = food.length;
    } else {
        for (const [node, staticLength] of state.touchedNodes) node.points.length = staticLength;
    }
    state.touchedNodes.clear();
    const touched = state.touchedNodes;
    for (const virus of viruses) tree.insert(new Point(virus.x, virus.y, { type: 'virus', data: virus }), touched);
    for (const mass of ejected) tree.insert(new Point(mass.x, mass.y, { type: 'ejected', data: mass }), touched);
    for (const player of players) for (const cell of player.cells || []) {
        if (!cell || !Number.isFinite(cell.x) || !Number.isFinite(cell.y)) continue;
        const isBot = !!player.isBot && !allAsPlayers;
        tree.insert(new Point(cell.x, cell.y, {
            type: isBot ? 'bot' : 'player',
            socketId: isBot ? undefined : player.id,
            botId: isBot ? player.id : undefined,
            cell,
        }), touched);
    }
}
