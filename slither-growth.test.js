import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SLITHER, radiusScaleForSegmentCount, segmentSpacingForSegmentCount,
    downsampleSegmentsForNetwork, relaxSnakeTrail, updateSnakeBodyFromPath,
} from './slither-engine.js';
import {
    continuousSc, continuousArcLength, densifySpine,
} from '../phantom-game/src/game/slither/snakePath.js';

test('width continues smoothly beyond the segment budget and agrees on client/server', () => {
    let previous = 0;
    for (const fullness of [0, 1, 100, 1000, 10000, 100000]) {
        const scale = radiusScaleForSegmentCount(1200 + fullness);
        assert.ok(scale > previous);
        assert.equal(continuousSc(1200, fullness), scale);
        assert.equal(continuousArcLength(1200, fullness), continuousArcLength(1200, 0),
            'excess fullness cannot manufacture a long rigid display tail');
        previous = scale;
    }
    assert.ok(radiusScaleForSegmentCount(1200.001) - radiusScaleForSegmentCount(1200) < 0.00001);
});

for (const count of [12, 120, 600, 1200]) {
    for (const minimumPoints of [72, 120]) {
        test(`${count} segments / ${minimumPoints} baseline preserve tight circular bends over the full body`, () => {
            const width = SLITHER.baseRadius * radiusScaleForSegmentCount(count);
            const circleRadius = width * 2;
            const step = segmentSpacingForSegmentCount(count);
            const segments = Array.from({ length: count }, (_, i) => ({
                x: Math.cos(i * step / circleRadius) * circleRadius,
                y: Math.sin(i * step / circleRadius) * circleRadius,
            }));
            const network = downsampleSegmentsForNetwork(segments, minimumPoints);
            assert.ok(network.length <= count, 'transmission must stay bounded by real points');
            if (count === 1200) assert.ok(network.length > 120, 'giants need more than a fixed short spine');
            const rendered = densifySpine(network, width * 0.55);
            for (const p of rendered) {
                const error = Math.abs(Math.hypot(p.x, p.y) - circleRadius);
                assert.ok(error < width * 0.04, `curve flattened by ${error} at width ${width}`);
            }
            assert.ok(Math.hypot(network.at(-1).x - segments.at(-1).x,
                network.at(-1).y - segments.at(-1).y) < 0.08, 'full tail is retained');
        });
    }
}

test('trail settles slightly inward over time without moving the head or deforming straight travel', () => {
    const circle = Array.from({ length: 150 }, (_, i) => ({
        x: Math.cos(i * 0.04) * 50, y: Math.sin(i * 0.04) * 50,
    }));
    const head = { ...circle[0] };
    const neck = { ...circle[1] };
    const straight = Array.from({ length: 1200 }, (_, i) => ({ x: -i * 5, y: 10 }));
    const before = structuredClone(straight);
    for (let tick = 0; tick < 200; tick++) {
        relaxSnakeTrail(circle);
        relaxSnakeTrail(straight);
    }
    const radius = Math.hypot(circle[70].x, circle[70].y);
    assert.ok(radius < 50 && radius > 49.5, 'settling must stay below 1% over five seconds');
    assert.deepEqual(circle[0], head);
    assert.deepEqual(circle[1], neck);
    assert.deepEqual(straight, before);
});

test('a giant moving in circles keeps its complete tail distributed for many ticks', () => {
    const count = 1200;
    const spacing = segmentSpacingForSegmentCount(count);
    const radius = 60;
    const segments = Array.from({ length: count }, (_, i) => ({
        x: Math.cos(-i * spacing / radius) * radius,
        y: Math.sin(-i * spacing / radius) * radius,
    }));
    const snake = { segments, angle: Math.PI / 2 };
    for (let tick = 1; tick <= 400; tick++) {
        const angle = tick * 2 / radius;
        segments[0].x = Math.cos(angle) * radius;
        segments[0].y = Math.sin(angle) * radius;
        snake.angle = angle + Math.PI / 2;
        updateSnakeBodyFromPath(snake, spacing);
    }
    for (let i = 1; i < segments.length; i++) {
        const gap = Math.hypot(segments[i].x - segments[i - 1].x, segments[i].y - segments[i - 1].y);
        assert.ok(gap > spacing * 0.9 && gap <= spacing * 1.001, `bad segment gap ${gap}`);
    }
    assert.ok(snake.path.length <= 3600);
});
