import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildAgarSpatialTree } from './agar-spatial.js';
import { QuadTree, Rectangle, Point } from './quadtree.js';

test('cached Agar points track movement, reconnect ids, removed food and bot ownership', () => {
    const tree = new QuadTree(new Rectangle(500, 500, 500, 500), 4);
    const room = { food: [{ id: 'food', x: 10, y: 10 }], viruses: [], ejected: [] };
    const player = { id: 'socket-1', cells: [{ id: 'cell', x: 20, y: 20 }] };
    rebuildAgarSpatialTree(tree, room, [player]);
    assert.equal(tree.query(new Rectangle(20, 20, 1, 1))[0].socketId, 'socket-1');
    player.id = 'socket-2'; player.cells[0].x = 300; player.isBot = true;
    room.food = [];
    rebuildAgarSpatialTree(tree, room, [player]);
    assert.deepEqual(tree.query(new Rectangle(10, 10, 5, 5)), []);
    const result = tree.query(new Rectangle(300, 20, 1, 1))[0];
    assert.equal(result.botId, 'socket-2');
    assert.equal(result.socketId, undefined);
    assert.equal(result.type, 'bot');
    assert.deepEqual(Object.keys(player.cells[0]), ['id', 'x', 'y']);
    rebuildAgarSpatialTree(tree, room, [player], true);
    const br = tree.query(new Rectangle(300, 20, 1, 1))[0];
    assert.equal(br.type, 'player', 'BR bot collision protocol remains identical');
    assert.equal(br.socketId, 'socket-2');
});

test('static reuse matches fresh-tree query order through movement, additions and removals', () => {
    const room = { food: Array.from({ length: 500 }, (_, i) => ({ id: `f${i}`, x: (i * 83) % 1000, y: (i * 97) % 1000 })),
        viruses: [{ id: 'v', x: 40, y: 80 }], ejected: [{ id: 'e', x: 600, y: 500 }] };
    const players = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, cells: [{ id: `c${i}`, x: i * 30, y: 400 }] }));
    const tree = new QuadTree(new Rectangle(500, 500, 500, 500), 4);
    const fresh = new QuadTree(new Rectangle(500, 500, 500, 500), 4);
    for (let tick = 0; tick < 60; tick++) {
        if (tick === 10) room.food.push({ id: 'added', x: 300, y: 300 });
        if (tick === 30) room.food = room.food.filter(food => Number(food.id.slice(1)) % 3 !== 0);
        for (const player of players) { player.cells[0].x = (player.cells[0].x + 21) % 1000; player.cells[0].y = (player.cells[0].y + 11) % 1000; }
        room.ejected[0].x = (room.ejected[0].x + 5) % 1000;
        rebuildAgarSpatialTree(tree, room, players);
        fresh.clear();
        for (const [type, entries] of [['food', room.food], ['virus', room.viruses], ['ejected', room.ejected]]) {
            for (const item of entries) fresh.insert(new Point(item.x, item.y, { type, data: item }));
        }
        for (const player of players) for (const cell of player.cells) fresh.insert(new Point(cell.x, cell.y, { type: 'player', socketId: player.id, cell }));
        for (let view = 0; view < 12; view++) {
            const range = new Rectangle((view * 97 + tick * 3) % 1000, (view * 71) % 1000, 180, 140);
            const ids = index => index.query(range).map(item => `${item.type}:${item.data?.id || item.cell.id}`);
            assert.deepEqual(ids(tree), ids(fresh), `same query sequence at tick ${tick}, view ${view}`);
        }
    }
});
