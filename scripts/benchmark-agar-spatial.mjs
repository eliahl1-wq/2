import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { QuadTree, Rectangle, Point } from '../quadtree.js';
import { rebuildAgarSpatialTree } from '../agar-spatial.js';
// Interleaved old/new rebuilds of identical entities. No services or accounts.
const source = execFileSync('git', ['show', 'HEAD:quadtree.js'], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
const old = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const food = Array.from({ length: 8000 }, (_, i) => ({ id: `f${i}`, x: (i * 83) % 6000, y: (i * 127) % 6000 }));
const players = Array.from({ length: 32 }, (_, i) => ({ id: `p${i}`, cells: Array.from({ length: 8 }, (_, j) => ({ id: `c${i}-${j}`, x: (i * 73 + j * 9) % 6000, y: (i * 211 + j * 7) % 6000 })) }));
const room = { food, viruses: [], ejected: [] };
const trees = [new old.QuadTree(new old.Rectangle(3000, 3000, 3000, 3000), 16), new QuadTree(new Rectangle(3000, 3000, 3000, 3000), 16), new QuadTree(new Rectangle(3000, 3000, 3000, 3000), 16)];
const samples = [[], [], []];
for (let run = 0; run < 140; run++) {
    for (const player of players) for (const cell of player.cells) cell.x = (cell.x + 2) % 6000;
    for (const variant of run % 2 ? [2, 1, 0] : [0, 1, 2]) {
        const tree = trees[variant];
        const begin = performance.now();
        if (variant === 1) rebuildAgarSpatialTree(tree, room, players);
        else {
            tree.clear();
            const P = variant === 0 ? old.Point : Point;
            for (const f of food) tree.insert(new P(f.x, f.y, { type: 'food', data: f }));
            for (const player of players) for (const cell of player.cells) tree.insert(new P(cell.x, cell.y, { type: 'player', socketId: player.id, cell }));
        }
        if (run >= 20) samples[variant].push(performance.now() - begin);
    }
    const viewport = new Rectangle(2000 + run, 1800, 960, 540);
    const ids = tree => tree.query(viewport).map(item => item.data?.id || item.cell.id).sort();
    if (JSON.stringify(ids(trees[0])) !== JSON.stringify(ids(trees[1]))) throw new Error('Spatial membership changed');
}
const stats = values => { values.sort((a, b) => a - b); return { medianMs: +values[Math.floor(values.length / 2)].toFixed(3), p95Ms: +values[Math.floor(values.length * .95)].toFixed(3) }; };
console.log(JSON.stringify({ food: food.length, players: players.length, cells: players.length * 8, samples: samples[0].length, baseline: stats(samples[0]), cachedFood: stats(samples[1]), fullRebuild: stats(samples[2]), identicalQueries: true }));
