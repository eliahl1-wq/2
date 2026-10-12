import test from 'node:test';
import assert from 'node:assert/strict';
import { broadcastSurvivState, createSurvivPlayer } from './surviv-engine.js';

function fixture() {
    const room = { id: 'network-test', entryFeeUsd: 5, players: [], bots: [], bullets: [],
        obstacles: [], loot: [], spawnPoints: [], landmarks: [], spectators: [] };
    for (const id of ['you', 'other']) {
        const player = createSurvivPlayer(id, id, id, '#a78bfa', room);
        Object.assign(player, { x: id === 'you' ? 0 : 100, y: 0 });
        room.players.push(player);
    }
    const packets = [];
    const sockets = new Map(room.players.map(player => [player.id, {
        connected: true, conn: { transport: { writable: true }, writeBuffer: [] },
    }]));
    const io = { sockets: { sockets }, to: id => ({
        emit: (event, data) => packets.push({ id, event, data, reliable: true }),
        volatile: { emit: (event, data) => packets.push({ id, event, data, reliable: false }) },
    }) };
    const broadcast = () => broadcastSurvivState(room, io, {
        leaderboard: [], aliveCount: 2, zone: { x: 0, y: 0, radius: 10000 },
    }, {});
    return { room, sockets, packets, broadcast };
}

test('Surviv keeps the complete own HUD but does not repeatedly serialize remote inventories', () => {
    const { packets, broadcast } = fixture();
    broadcast();
    const packet = packets.find(packet => packet.id === 'you' && packet.event === 'survivTick');
    assert.equal(packet.reliable, true, 'initial terrain/map must be reliable');
    assert.ok(packet.data.fullMap);
    assert.ok(packet.data.you.inventory);
    assert.ok(Array.isArray(packet.data.you.weaponSlotAmmo));
    const remote = packet.data.players.find(player => player.id === 'other');
    assert.ok(remote);
    for (const key of ['inventory', 'weaponSlotAmmo', 'weaponsAmmo', 'lastLoot', 'ammo', 'clipSize']) {
        assert.equal(key in remote, false, key);
    }
    assert.equal(typeof remote.angle, 'number');
    assert.equal(typeof remote.reloadRemainingMs, 'number');
    packets.length = 0;
    broadcast();
    assert.equal(packets.find(packet => packet.id === 'you' && packet.event === 'survivTick').reliable, false);
});

test('a blocked first snapshot is retried with its map, while one-shot damage stays reliable', () => {
    const { room, sockets, packets, broadcast } = fixture();
    const socket = sockets.get('you');
    socket.conn.writeBuffer.push('busy');
    broadcast();
    assert.equal(packets.some(packet => packet.id === 'you'), false);
    assert.equal(room._survivFullMapSent?.has('you') || false, false);
    socket.conn.writeBuffer.length = 0;
    broadcast();
    assert.ok(packets.find(packet => packet.id === 'you' && packet.event === 'survivTick').data.fullMap);
    packets.length = 0;
    socket.conn.writeBuffer.push('busy');
    room.players[0]._damageTaken = { damage: 10 };
    broadcast();
    assert.equal(packets.find(packet => packet.id === 'you' && packet.event === 'survivTick').reliable, true);
});
