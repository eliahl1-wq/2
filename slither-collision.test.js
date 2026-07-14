import test from 'node:test';
import assert from 'node:assert/strict';
import {
    randomCoordInRoom,
    radiusScaleForSegmentCount,
    resolveAllSnakeCollisions,
    scangForSegmentCount,
    segmentSpacingForSegmentCount,
    runSlitherBotAI,
    SLITHER,
    syncCompetitiveSlitherFood,
    syncSlitherFood,
} from './slither-engine.js';

test('Slither uses a half-area circular arena and circular spawn distribution', () => {
    const oldSquareArea = 6000 * 6000;
    const circularArea = Math.PI * SLITHER.worldHalf * SLITHER.worldHalf;
    assert.ok(Math.abs(circularArea / oldSquareArea - 0.5) < 0.01);

    for (let i = 0; i < 500; i++) {
        const point = randomCoordInRoom({});
        assert.ok(Math.hypot(point.x, point.y) <= SLITHER.worldHalf * 0.85 + 1e-6);
    }
});
test('spectators keep food after the last Slither player dies', () => {
    const normalRoom = {
        slitherFood: [{ id: 'food', balance: 0.04, dollarValue: 0.04 }],
        foodPoolBalance: 0,
        spectators: [{ id: 'viewer' }],
        players: [],
        slitherBots: [],
    };
    syncSlitherFood(normalRoom, 0.04, 10, 0);
    assert.equal(normalRoom.slitherFood.length, 1);
    assert.equal(normalRoom.foodPoolBalance, 0);

    const competitiveRoom = {
        slitherFood: [{ id: 'food', balance: 1 }],
        competitiveSpectators: [{ id: 'viewer' }],
    };
    syncCompetitiveSlitherFood(competitiveRoom, 0);
    assert.equal(competitiveRoom.slitherFood.length, 1);
});

test('food is cleared only when a Slither room is genuinely empty', () => {
    const room = {
        slitherFood: [{ id: 'food', balance: 0.04, dollarValue: 0.04 }],
        foodPoolBalance: 0,
        spectators: [],
        players: [],
        slitherBots: [],
    };
    syncSlitherFood(room, 0.04, 10, 0);
    assert.equal(room.slitherFood.length, 0);
    assert.equal(room.foodPoolBalance, 0.04);
});
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
test('Slither bots strongly prefer food over weaker prey and keep individual approach arcs', () => {
    const snake = {
        id: 'food-first-bot',
        balance: 10,
        segments: [{ x: 0, y: 0 }, { x: -10, y: 0 }],
        targetX: 0,
        targetY: 0,
        inputDx: 1,
        inputDy: 0,
        angle: 0,
        boost: false,
        _botBrain: {
            reactionMs: 180,
            foodScanMs: 340,
            foodValueBias: 1,
            preyChance: 0,
            caution: 1,
            aimOffset: 12,
            weaveSpeed: 0.003,
            phase: 1,
            wanderDirection: 1,
            wanderTurn: 0.6,
            wanderDistance: 300,
            boostGreed: 0.5,
            nextDecisionAt: 0,
            nextFoodScanAt: 0,
            foodTarget: null,
        },
    };
    const prey = {
        id: 'prey',
        balance: 1,
        segments: [{ x: 90, y: 0 }],
    };
    const food = [{ id: 'pellet', x: 0, y: 110, balance: 0.02, dollarValue: 0.02 }];

    runSlitherBotAI(
        snake,
        [{ entity: snake }, { entity: prey }],
        food,
        null,
        { sandboxWorldHalf: SLITHER.worldHalf },
        1000,
    );

    assert.ok(snake.targetY > 90, 'food should beat an available prey target');
    assert.notEqual(snake.targetX, 0, 'personality should add a subtle individual approach arc');
});

test('Slither bots react quickly but not on every server tick', () => {
    const snake = {
        id: 'reaction-bot',
        balance: 5,
        segments: [{ x: 0, y: 0 }, { x: -10, y: 0 }],
        targetX: 0,
        targetY: 100,
        inputDx: 0,
        inputDy: 100,
        angle: 0,
        boost: false,
        _botBrain: {
            reactionMs: 180,
            foodScanMs: 340,
            foodValueBias: 1,
            preyChance: 0,
            caution: 1,
            aimOffset: 8,
            weaveSpeed: 0.003,
            phase: 0.5,
            wanderDirection: -1,
            wanderTurn: 0.5,
            wanderDistance: 300,
            boostGreed: 0.5,
            nextDecisionAt: 1180,
            nextFoodScanAt: 1300,
            foodTarget: { id: 'pellet', x: 0, y: 100, balance: 0.02 },
        },
    };
    const threat = {
        id: 'threat',
        balance: 20,
        segments: [{ x: 40, y: 0 }],
    };
    const allSnakes = [{ entity: snake }, { entity: threat }];
    const room = { sandboxWorldHalf: SLITHER.worldHalf };

    runSlitherBotAI(snake, allSnakes, [], null, room, 1179);
    assert.equal(snake.targetX, 0, 'the bot should not react before its decision window');
    assert.equal(snake.targetY, 100);

    runSlitherBotAI(snake, allSnakes, [], null, room, 1180);
    assert.ok(snake.targetX < 0, 'the bot should flee once the human-like reaction delay expires');
    assert.ok(snake._botBrain.nextDecisionAt >= 1303);
    assert.ok(snake._botBrain.nextDecisionAt <= 1382);
});
