import test from 'node:test';
import assert from 'node:assert/strict';
import { isSurvivSpawnPositionSafe, processSurvivRoom } from './surviv-engine.js';
const io = { to: () => ({ emit() {} }) };
function fixture(chain = false) {
    const obstacles = Array.from({length: 1000}, (_, i) => ({ id: `remote-${i}`, kind: 'rock', x: 3000 + i * 20, y: 3000, w: 20, h: 20 }));
    for (let i = 0; i < (chain ? 8 : 1); i++) obstacles.push({ id: `target-${i}`, kind: chain ? 'barrel' : 'rock',
        variant: chain ? 'fuel' : null, x: 50 + i * 45, y: 0, w: 20, h: 20, hp: 1, maxHp: 1, destructible: true });
    return { id: 'index-test', isBattleRoyale: true, obstacles, players: [], bots: [], loot: [], spectators: [],
        bullets: [{ id: 'round', x: 0, y: 0, vx: 100, vy: 0, damage: 30, ownerId: 'test', bornAt: Date.now(), maxDistance: 1000 }] };
}
for (const chain of [false, true]) test(`destruction updates existing spatial buckets${chain ? ' through an entire barrel chain' : ''}`, () => {
    const room = fixture(chain);
    assert.equal(isSurvivSpawnPositionSafe(room, 50, 0, 10), false);
    const index = room._survivObstacleIndex;
    processSurvivRoom(room, io, Date.now() + 600000);
    assert.equal(room.obstacles.length, 1000);
    assert.equal(isSurvivSpawnPositionSafe(room, 50, 0, 10), true);
    assert.equal(room._survivObstacleIndex, index);
    assert.equal(index.count, room.obstacles.length);
    for (const grid of [index.all, index.collidable]) {
        assert.ok([...grid.values()].flat().every(o => !o._destroyed));
        assert.ok([...grid.values()].flat().some(o => o.id === 'remote-0'));
    }
    assert.equal(isSurvivSpawnPositionSafe(room, 3000, 3000, 10), false);
    assert.ok(room._survivObstacleRevision > 0);
});
test('out-of-band additions and replacement maps still invalidate the spatial cache', () => {
    const room = fixture();
    isSurvivSpawnPositionSafe(room, 0, 0, 10);
    const first = room._survivObstacleIndex;
    room.obstacles.push({ id: 'new', kind: 'rock', x: -200, y: 0, w: 40, h: 40 });
    assert.equal(isSurvivSpawnPositionSafe(room, -200, 0, 10), false);
    assert.notEqual(room._survivObstacleIndex, first);
    const second = room._survivObstacleIndex;
    room.obstacles = [];
    assert.equal(isSurvivSpawnPositionSafe(room, -200, 0, 10), true);
    assert.notEqual(room._survivObstacleIndex, second);
});
