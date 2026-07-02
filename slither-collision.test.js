import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAllSnakeCollisions } from './slither-engine.js';

test('Side collision: A runs into B body, A dies and B lives', () => {
    // Snake A (head at 0,0)
    const snakeA = {
        id: 'A',
        balance: 1.0,
        angle: 0,
        segments: [{ x: 0, y: 0 }, { x: -4, y: 0 }]
    };

    // Snake B (head at 0, 12, body segment 3 at 0, 0)
    const snakeB = {
        id: 'B',
        balance: 1.0,
        angle: Math.PI / 2,
        segments: [{ x: 0, y: 12 }, { x: 0, y: 8 }, { x: 0, y: 4 }, { x: 0, y: 0 }]
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

test('Side impact with neck/head overlap: B neck hit by A, only A dies', () => {
    // Snake A (head at 0,0)
    const snakeA = {
        id: 'A',
        balance: 1.0,
        angle: 0,
        segments: [{ x: 0, y: 0 }, { x: -4, y: 0 }]
    };

    // Snake B (head at 4, 4, body segment 1 at 4, 0)
    // Distance from A head to B segment 1 is 4.
    // Distance from B head to A head is sqrt(32) ≈ 5.66, within the head-to-head threshold.
    const snakeB = {
        id: 'B',
        balance: 1.0,
        angle: Math.PI / 2,
        segments: [{ x: 4, y: 4 }, { x: 4, y: 0 }]
    };

    const allSnakes = [
        { entity: snakeA, isHuman: true },
        { entity: snakeB, isHuman: true }
    ];

    const dead = resolveAllSnakeCollisions(allSnakes);

    assert.ok(dead.has('A'), 'Snake A should be dead');
    assert.equal(dead.get('A').id, 'B', 'B should be the killer of A');
    assert.ok(!dead.has('B'), 'Snake B should survive');
});

test('Head-on collision (same size): both die', () => {
    // Head distance is 5 (which is < head-head threshold of ~7.46)
    const snakeA = {
        id: 'A',
        balance: 1.0,
        angle: 0,
        segments: [{ x: 0, y: 0 }, { x: -4, y: 0 }]
    };

    const snakeB = {
        id: 'B',
        balance: 1.0,
        angle: Math.PI,
        segments: [{ x: 5, y: 0 }, { x: 9, y: 0 }]
    };

    const allSnakes = [
        { entity: snakeA, isHuman: true },
        { entity: snakeB, isHuman: true }
    ];

    const dead = resolveAllSnakeCollisions(allSnakes);

    assert.ok(dead.has('A'), 'Snake A should die');
    assert.ok(dead.has('B'), 'Snake B should die');
});

test('Head-on collision (different size): larger survives', () => {
    // Snake A is 2x larger than B
    const snakeA = {
        id: 'A',
        balance: 2.0,
        angle: 0,
        segments: [{ x: 0, y: 0 }, { x: -4, y: 0 }]
    };

    const snakeB = {
        id: 'B',
        balance: 1.0,
        angle: Math.PI,
        segments: [{ x: 5, y: 0 }, { x: 9, y: 0 }]
    };

    const allSnakes = [
        { entity: snakeA, isHuman: true },
        { entity: snakeB, isHuman: true }
    ];

    const dead = resolveAllSnakeCollisions(allSnakes);

    assert.ok(!dead.has('A'), 'Larger Snake A should survive');
    assert.ok(dead.has('B'), 'Smaller Snake B should die');
    assert.equal(dead.get('B').id, 'A', 'Snake A should be the killer of B');
});

test('Grazing / Turning away: both survive', () => {
    // Heads are close (distance 5), but they are moving away from each other
    const snakeA = {
        id: 'A',
        balance: 1.0,
        angle: 3 * Math.PI / 4, // moving up-left
        segments: [{ x: 0, y: 0 }, { x: 2.8, y: -2.8 }]
    };

    const snakeB = {
        id: 'B',
        balance: 1.0,
        angle: -Math.PI / 4, // moving down-right
        segments: [{ x: 5, y: 0 }, { x: 2.2, y: 2.8 }]
    };

    const allSnakes = [
        { entity: snakeA, isHuman: true },
        { entity: snakeB, isHuman: true }
    ];

    const dead = resolveAllSnakeCollisions(allSnakes);

    assert.ok(!dead.has('A'), 'Snake A should survive');
    assert.ok(!dead.has('B'), 'Snake B should survive');
});
