import test from 'node:test';
import assert from 'node:assert/strict';
import {
    radiusScaleForSegmentCount,
    resolveAllSnakeCollisions,
    scangForSegmentCount,
    segmentSpacingForSegmentCount,
} from './slither-engine.js';

test('Large snakes gain far more length than width and keep useful steering', () => {
    const smallRadiusScale = radiusScaleForSegmentCount(12);
    const hugeRadiusScale = radiusScaleForSegmentCount(1200);
    const hugeSpacing = segmentSpacingForSegmentCount(1200);

    assert.ok(hugeRadiusScale < 3, 'maximum-length snake should stay below 3x spawn width');
    assert.ok(hugeRadiusScale > smallRadiusScale, 'width should still grow gradually');
    assert.ok(hugeSpacing < 6, 'large body points must stay dense enough for round turns');
    assert.ok(scangForSegmentCount(1200) >= 0.34, 'large snakes must retain useful turning speed');
});

test('Collision radius follows visible segments instead of future balance growth', () => {
    const growing = {
        id: 'growing', balance: 100, angle: 0,
        segments: [{ x: 0, y: 0 }, { x: -15, y: 0 }],
    };
    const passing = {
        id: 'passing', balance: 1, angle: 0,
        segments: [
            { x: 30, y: 11.3 }, { x: 20, y: 11.3 }, { x: 10, y: 11.3 },
            { x: 0, y: 11.3 }, { x: -10, y: 11.3 }, { x: -20, y: 11.3 },
        ],
    };
    const dead = resolveAllSnakeCollisions([
        { entity: growing, isHuman: true },
        { entity: passing, isHuman: true },
    ]);
    assert.ok(!dead.has('growing'), 'unrendered future growth must not create an oversized hitbox');
});

test('Side collision: A runs into B body, A dies and B lives', () => {
    // Snake A (head at 0,0, tail at -10,0)
    const snakeA = {
        id: 'A',
        balance: 1.0,
        angle: 0,
        segments: [{ x: 0, y: 0 }, { x: -10, y: 0 }]
    };

    // Snake B (head at 0, 20, body segment 5 at 0, 0)
    // Distance from A head to B segment 5 is 0.
    // Distance from B head to A segments is > 20, well outside any collision range.
    const snakeB = {
        id: 'B',
        balance: 1.0,
        angle: Math.PI / 2,
        segments: [{ x: 0, y: 20 }, { x: 0, y: 16 }, { x: 0, y: 12 }, { x: 0, y: 8 }, { x: 0, y: 4 }, { x: 0, y: 0 }]
    };

    const allSnakes = [
        { entity: snakeA, isHuman: true },
        { entity: snakeB, isHuman: true }
    ];

    const dead = resolveAllSnakeCollisions(allSnakes);

    assert.ok(dead.has('A'), 'Snake A should be dead');
    assert.equal(dead.get('A').id, 'B', 'Snake B should be the killer of A');
    assert.ok(!dead.has('B'), 'Snake B should survive');
});

test('Side impact inside the neck area is non-lethal', () => {
    // Snake A (head at 0,0, tail at -15,0)
    const snakeA = {
        id: 'A',
        balance: 1.0,
        angle: 0,
        segments: [{ x: 0, y: 0 }, { x: -15, y: 0 }]
    };

    // Snake B (head at 4, 10, body segment 1 at 4, 0)
    // Distance from A head to B segment 1 is 4 (triggers body hit for A).
    // Distance from B head to A head is sqrt(16+100) ≈ 10.77 (within head-to-head threshold 11.53).
    // B head is far from A tail (21.47 > 12.89 body threshold).
    // Since B is not moving towards A (B moving up, A moving right), B survives head-to-head.
    const snakeB = {
        id: 'B',
        balance: 1.0,
        angle: Math.PI / 2,
        segments: [{ x: 4, y: 10 }, { x: 4, y: 0 }]
    };

    const allSnakes = [
        { entity: snakeA, isHuman: true },
        { entity: snakeB, isHuman: true }
    ];

    const dead = resolveAllSnakeCollisions(allSnakes);

    assert.ok(!dead.has('A'), 'Snake A should survive overlap inside B neck area');
    assert.ok(!dead.has('B'), 'Snake B should survive');
});

test('Head-on collision (same size): head contact alone is non-lethal', () => {
    // Head distance is 10 (which is < head-head threshold of ~11.53)
    // Tails are at -10 and 20 respectively, so they are far from heads (> 20, no body collision).
    const snakeA = {
        id: 'A',
        balance: 1.0,
        angle: 0,
        segments: [{ x: 0, y: 0 }, { x: -10, y: 0 }]
    };

    const snakeB = {
        id: 'B',
        balance: 1.0,
        angle: Math.PI,
        segments: [{ x: 10, y: 0 }, { x: 20, y: 0 }]
    };

    const allSnakes = [
        { entity: snakeA, isHuman: true },
        { entity: snakeB, isHuman: true }
    ];

    const dead = resolveAllSnakeCollisions(allSnakes);

    assert.ok(!dead.has('A'), 'Snake A should survive pure head contact');
    assert.ok(!dead.has('B'), 'Snake B should survive pure head contact');
});

test('Head-on collision (different size): head contact alone is non-lethal', () => {
    // Snake A is 2x larger than B
    // Head distance is 10 (which is < head-head threshold of ~11.95)
    // Tails are far, preventing body collision.
    const snakeA = {
        id: 'A',
        balance: 2.0,
        angle: 0,
        segments: [{ x: 0, y: 0 }, { x: -10, y: 0 }]
    };

    const snakeB = {
        id: 'B',
        balance: 1.0,
        angle: Math.PI,
        segments: [{ x: 10, y: 0 }, { x: 20, y: 0 }]
    };

    const allSnakes = [
        { entity: snakeA, isHuman: true },
        { entity: snakeB, isHuman: true }
    ];

    const dead = resolveAllSnakeCollisions(allSnakes);

    assert.ok(!dead.has('A'), 'Larger Snake A should survive');
    assert.ok(!dead.has('B'), 'Smaller Snake B should also survive pure head contact');
});

test('Grazing / Turning away: both survive', () => {
    // Heads are close (distance 11 < 11.53), but they are moving away from each other
    // Tails are at (0, -15) and (11, 15) respectively (distance 18.6 > 12.89, no body collision).
    const snakeA = {
        id: 'A',
        balance: 1.0,
        angle: Math.PI / 2, // moving up
        segments: [{ x: 0, y: 0 }, { x: 0, y: -15 }]
    };

    const snakeB = {
        id: 'B',
        balance: 1.0,
        angle: -Math.PI / 2, // moving down
        segments: [{ x: 11, y: 0 }, { x: 11, y: 15 }]
    };

    const allSnakes = [
        { entity: snakeA, isHuman: true },
        { entity: snakeB, isHuman: true }
    ];

    const dead = resolveAllSnakeCollisions(allSnakes);

    assert.ok(!dead.has('A'), 'Snake A should survive');
    assert.ok(!dead.has('B'), 'Snake B should survive');
});

test('Parallel brushing past: moving parallel, both survive', () => {
    // Heads are at (0, 0) and (10, 14). Distance is 17.2 > 11.53 (no head-to-head collision).
    // Tail segments are far enough to avoid body collisions (> 14).
    const snakeA = {
        id: 'A',
        balance: 1.0,
        angle: 0, // moving right
        segments: [{ x: 0, y: 0 }, { x: -15, y: 0 }]
    };

    const snakeB = {
        id: 'B',
        balance: 1.0,
        angle: 0, // moving right
        segments: [{ x: 10, y: 14 }, { x: -5, y: 14 }]
    };

    const allSnakes = [
        { entity: snakeA, isHuman: true },
        { entity: snakeB, isHuman: true }
    ];

    const dead = resolveAllSnakeCollisions(allSnakes);

    assert.ok(!dead.has('A'), 'Snake A should survive parallel brushing');
    assert.ok(!dead.has('B'), 'Snake B should survive parallel brushing');
});

test('Close side pass inside the visible edges survives', () => {
    const snakeA = { id: 'A', balance: 1.0, angle: 0, segments: [{ x: 0, y: 0 }, { x: -15, y: 0 }] };
    const snakeB = { id: 'B', balance: 1.0, angle: 0, segments: [{ x: 15, y: 11.3 }, { x: 0, y: 11.3 }, { x: -15, y: 11.3 }] };
    const dead = resolveAllSnakeCollisions([{ entity: snakeA, isHuman: true }, { entity: snakeB, isHuman: true }]);
    assert.ok(!dead.has('A'), 'A should be able to skim close to B without dying');
    assert.ok(!dead.has('B'), 'B should survive the close parallel pass');
});
test('Head and neck crossing resolves as a single cut-off death', () => {
    const snakeA = { id: 'A', balance: 1.0, angle: 0, segments: [{ x: 8, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 0 }, { x: -4, y: 0 }, { x: -8, y: 0 }] };
    const snakeB = { id: 'B', balance: 1.0, angle: Math.PI / 2, segments: [{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 0, y: 8 }, { x: 0, y: 12 }, { x: 0, y: 16 }] };
    const dead = resolveAllSnakeCollisions([{ entity: snakeA, isHuman: true }, { entity: snakeB, isHuman: true }]);
    assert.equal(dead.size, 1, 'The crossing must not become a double death');
    assert.ok(dead.has('B'), 'The snake driving into A established body should die');
    assert.ok(!dead.has('A'), 'The snake making the cut-off should survive');
});

test('A snake that reaches established body still dies', () => {
    const cutter = { id: 'cutter', balance: 1.0, angle: 0, segments: [{ x: 20, y: 0 }, { x: 16, y: 0 }, { x: 12, y: 0 }, { x: 8, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 0 }] };
    const incoming = { id: 'incoming', balance: 1.0, angle: Math.PI / 2, segments: [{ x: 0, y: 2 }, { x: 0, y: 6 }, { x: 0, y: 10 }, { x: 0, y: 14 }, { x: 0, y: 18 }] };
    const dead = resolveAllSnakeCollisions([{ entity: cutter, isHuman: true }, { entity: incoming, isHuman: true }]);
    assert.ok(dead.has('incoming'), 'The snake driving into established body should die');
    assert.ok(!dead.has('cutter'), 'The snake that completed the cut-off should survive');
});
