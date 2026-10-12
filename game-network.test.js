import test from 'node:test';
import assert from 'node:assert/strict';
import { emitGameSnapshot, getAgarSnapshotSchedule, isGameTransportReady, serializeAgarPlayer, packSlitherSnake, usesCompactSlitherSnapshots } from './game-network.js';

test('congested worlds do not queue while important events remain reliable', () => {
    const packets = [];
    const socket = { connected: true, conn: { transport: { writable: true }, writeBuffer: [] } };
    const target = { emit: (event, ...args) => packets.push({ event, args, reliable: true }),
        volatile: { emit: (event, ...args) => packets.push({ event, args, reliable: false }) } };
    const io = { sockets: { sockets: new Map([['player', socket]]) }, to: () => target };
    assert.equal(emitGameSnapshot(io, 'player', 'tick', [1]), true);
    socket.conn.writeBuffer.push('busy');
    for (let i = 0; i < 1000; i++) assert.equal(emitGameSnapshot(io, 'player', 'tick', [i]), false);
    assert.equal(packets.length, 1);
    assert.equal(emitGameSnapshot(io, 'player', 'cashout', [2], { reliable: true }), true);
    assert.equal(packets.at(-1).reliable, true);
    assert.equal(isGameTransportReady(io, 'gone'), false);
    socket.conn.writeBuffer.length = 0;
    assert.equal(emitGameSnapshot(io, 'player', 'tick', [1001]), true);
});

test('Agar secondary snapshots refresh on join, movement/zoom and their own cadence', () => {
    const room = {};
    const player = { id: 'p', x: 0, y: 0, screenWidth: 1920, screenHeight: 1080 };
    assert.deepEqual(getAgarSnapshotSchedule(room, player, 1000), { food: true, minimap: true, leaderboard: true });
    assert.deepEqual(getAgarSnapshotSchedule(room, player, 1025), { food: false, minimap: false, leaderboard: false });
    assert.equal(getAgarSnapshotSchedule(room, player, 1100).food, true);
    assert.equal(getAgarSnapshotSchedule(room, player, 1250).minimap, true);
    player.screenWidth = 2500;
    assert.equal(getAgarSnapshotSchedule(room, player, 1275).food, true);
    player.x = 1000;
    assert.equal(getAgarSnapshotSchedule(room, player, 1300).minimap, true);
    assert.equal(getAgarSnapshotSchedule(room, player, 1500).leaderboard, true);
});

test('public Agar payload excludes server state and stays serializable during reconnect timers', () => {
    const timer = {}; timer.self = timer;
    const source = { id: 'p', mongoId: 'private-account', username: '', x: 5, y: 6, balance: 2, dollarBalance: 3,
        cashoutHoldActive: true, cashoutHoldStartedAt: 123, removeTimeout: timer, botTarget: { id: 'hidden-player' },
        cells: [{ id: 'c', x: 5, y: 6, radius: 10, balance: 1, vx: 0, lastSplit: 99 }] };
    const snapshot = serializeAgarPlayer(source);
    assert.doesNotThrow(() => JSON.stringify(snapshot));
    assert.equal(snapshot.dollarBalance, 3);
    assert.equal(snapshot.cashoutHoldStartedAt, 123);
    assert.equal('mongoId' in snapshot, false);
    assert.equal('removeTimeout' in snapshot, false);
    assert.equal('botTarget' in snapshot, false);
    assert.notEqual(snapshot.cells[0], source.cells[0]);
});

test('compact Slither snapshots are opt-in and carry unchanged geometry with fewer bytes', () => {
    const snapshot = { id: 'p', sct: 120, radius: 8, cashoutHoldActive: true,
        segments: Array.from({ length: 72 }, (_, i) => ({ x: i * 1.1, y: -i * 2 })) };
    const packed = packSlitherSnake(snapshot);
    const restored = packed.segmentPositions.map((_, i) => i % 2 ? null : { x: packed.segmentPositions[i], y: packed.segmentPositions[i + 1] }).filter(Boolean);
    assert.deepEqual(restored, snapshot.segments);
    assert.ok(JSON.stringify(packed).length < JSON.stringify(snapshot).length * .75);
    const io = { sockets: { sockets: new Map([['new', { handshake: { auth: { snapshotProtocol: 2 } } }], ['old', { handshake: { auth: {} } }]]) } };
    assert.equal(usesCompactSlitherSnapshots(io, 'new'), true);
    assert.equal(usesCompactSlitherSnapshots(io, 'old'), false);
});
