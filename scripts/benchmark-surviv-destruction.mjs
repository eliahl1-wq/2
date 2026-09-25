import { performance } from 'node:perf_hooks';
import { isSurvivSpawnPositionSafe, processSurvivRoom } from '../surviv-engine.js';

// Isolate an already-running room's destruction tick from map generation,
// networking and JIT startup. This is a server CPU check, not a client FPS test.
const io = { to: () => ({ emit() {} }) };
const samples = Math.max(5, Number(process.argv[2]) || 30);
const obstacleCount = 10000;

function makeFixture(targetCount, chain) {
    const obstacles = Array.from({ length: obstacleCount }, (_, i) => ({
        id: `cover-${i}`, kind: 'rock', x: 3000 + (i % 200) * 25,
        y: -9500 + Math.floor(i / 200) * 380, w: 20, h: 20,
        collidable: true, destructible: true, hp: 100, maxHp: 100,
    }));
    for (let i = 0; i < targetCount; i++) obstacles.push({
        id: `target-${i}`, kind: chain ? 'barrel' : 'rock',
        ...(chain ? { variant: 'fuel' } : {}),
        x: chain ? i * 45 : 50, y: chain ? 0 : i * 180,
        w: 20, h: 20, collidable: true, destructible: true, hp: 1, maxHp: 1,
    });
    const bullets = Array.from({ length: chain ? 1 : targetCount }, (_, i) => ({
        id: `bullet-${i}`, ownerId: 'benchmark', x: chain ? -50 : 0,
        y: chain ? 0 : i * 180, vx: 100, vy: 0, damage: 30,
        bornAt: Date.now(), maxDistance: 1000,
    }));
    const room = {
        id: 'benchmark', isBattleRoyale: true, players: [], bots: [],
        loot: [], obstacles, bullets, spectators: [],
    };
    isSurvivSpawnPositionSafe(room, -2000, -2000, 20);
    return room;
}

for (const [label, targets, chain] of [
    ['one destroyed prop', 1, false],
    ['25 simultaneous prop hits', 25, false],
    ['25-barrel chain reaction', 25, true],
]) {
    const times = [];
    for (let i = 0; i < samples + 5; i++) {
        const room = makeFixture(targets, chain);
        const originalIndex = room._survivObstacleIndex;
        const start = performance.now();
        processSurvivRoom(room, io, Date.now() + 600000);
        // Force the next spatial query, as movement/broadcast normally would.
        isSurvivSpawnPositionSafe(room, -2000, -2000, 20);
        const elapsed = performance.now() - start;
        if (room.obstacles.length !== obstacleCount) throw new Error(`Failed to destroy ${targets} targets`);
        if (i >= 5) times.push(elapsed);
        if (i === samples + 4) {
            times.sort((a, b) => a - b);
            console.log(JSON.stringify({
                label, obstacles: obstacleCount, samples,
                medianMs: Number(times[Math.floor(times.length / 2)].toFixed(3)),
                p95Ms: Number(times[Math.min(times.length - 1, Math.floor(times.length * 0.95))].toFixed(3)),
                reusedSpatialIndex: originalIndex === room._survivObstacleIndex,
            }));
        }
    }
}
