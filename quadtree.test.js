import test from 'node:test';
import assert from 'node:assert/strict';
import { QuadTree, Rectangle, Point } from './quadtree.js';

test('clear/rebuild retains exact query membership as points move', () => {
    const tree = new QuadTree(new Rectangle(0, 0, 1000, 1000), 4);
    const points = Array.from({ length: 400 }, (_, i) => new Point((i * 83 % 1900) - 950, (i * 97 % 1900) - 950, i));
    points.forEach(point => tree.insert(point));
    for (let tick = 0; tick < 50; tick++) {
        tree.clear();
        points.forEach(point => { point.x = -point.x; tree.insert(point); });
        const viewport = new Rectangle(tick - 100, 80, 220, 280);
        assert.deepEqual(tree.query(viewport).sort((a, b) => a - b), points.filter(point => viewport.contains(point)).map(point => point.data).sort((a, b) => a - b));
    }
    tree.clear();
    assert.deepEqual(tree.query(new Rectangle(0, 0, 1000, 1000)), []);
});

test('coincident death drops cannot subdivide forever or lose funded objects', () => {
    const tree = new QuadTree(new Rectangle(0, 0, 1000, 1000), 4);
    for (let i = 0; i < 2000; i++) assert.equal(tree.insert(new Point(0, 0, i)), true);
    assert.equal(tree.query(new Rectangle(0, 0, 1, 1)).length, 2000);
    tree.clear();
    assert.equal(tree.insert(new Point(900, 900, 'new')), true);
    assert.deepEqual(tree.query(new Rectangle(900, 900, 1, 1)), ['new']);
});
