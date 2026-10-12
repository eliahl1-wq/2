import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSurvivCombatEvents, recordSurvivCombatEvent, survivImpactMaterial } from './surviv-combat-presentation.js';
import { applySurvivFireInput, broadcastSurvivState, createSurvivPlayer, equipSurvivWeaponSlot, processSurvivRoom, resetSurvivRoomRuntime, WEAPONS } from './surviv-engine.js';

function fixture(t) {
    let now = 1900000000000;
    t.mock.method(Date, 'now', () => now);
    const packets = [];
    const io = { to: id => ({ emit: (type, data) => { if (type === 'survivTick') packets.push({ id, data }); } }) };
    const room = { id: 'presentation', isBattleRoyale: true, players: [], bots: [], loot: [], obstacles: [],
        bullets: [], spectators: [], spawnPoints: [{ x: 0, y: 0 }], entryFeeUsd: 5 };
    const me = createSurvivPlayer('shooter', 'user', 'Player', '#fff', room);
    me.x = 0; me.y = 0; me.inventory.weapons = ['m9']; me.weaponSlotAmmo = [15];
    equipSurvivWeaponSlot(me, 0); me.aimAngle = 0; room.players.push(me);
    return { room, me, packets, io, get now() { return now; },
        step(ms = 0) { now += ms; const state = processSurvivRoom(room, io, now + 600000);
            broadcastSurvivState(room, io, state, {}); return packets.at(-1).data; } };
}

test('close-range rounds report one shot and exact contact even when no bullet survives a snapshot', t => {
    const f = fixture(t);
    f.room.obstacles.push({ id: 'cover', kind: 'rock', x: 40, y: 0, w: 20, h: 30,
        collidable: true, destructible: true, hp: 1, maxHp: 100 });
    applySurvivFireInput(f.me, true, 1); applySurvivFireInput(f.me, false, 1);
    const tick = f.step();
    assert.equal(f.me.weapon.ammo, WEAPONS.m9.clipSize - 1);
    assert.equal(tick.bullets.length, 0);
    assert.equal(f.room.obstacles.length, 0);
    assert.deepEqual(tick.combatEvents.map(e => e.type), ['shot', 'impact']);
    const impact = tick.combatEvents[1];
    assert.ok(Math.abs(impact.x - 30) < 1e-8, 'contact uses swept collision, not the removed prop centre');
    assert.equal(impact.material, 'stone'); assert.equal(impact.objectId, 'cover'); assert.equal(impact.ageMs, 0);
    assert.equal(f.step(25).combatEvents[0].id, tick.combatEvents[0].id, 'lost packets have a short replay window');
    assert.deepEqual(f.step(500).combatEvents, []);
});

test('range expiry does not masquerade as an impact near scenery or the owner', t => {
    const f = fixture(t);
    f.room.bullets.push({ id: 'expired', ownerId: f.me.id, weaponType: 'm9', x: 500, y: 0,
        vx: 30, vy: 0, damage: 10, bornAt: f.now, maxDistance: 25 });
    const tick = f.step();
    assert.equal(tick.bullets.length, 0); assert.deepEqual(tick.combatEvents, []);
});

test('combat events cannot disclose hidden owners, rooms, or points behind interior walls', t => {
    const f = fixture(t);
    f.room.obstacles = [
        { id: 'house', kind: 'houseFloor', x: 0, y: 0, w: 500, h: 500, collidable: false },
        { id: 'partition', kind: 'interiorWall', houseId: 'house', x: 80, y: 0, w: 12, h: 500, collidable: true },
    ];
    const hidden = createSurvivPlayer('hidden', 'hidden-user', 'Hidden', '#fff', f.room);
    hidden.x = 150; hidden.y = 0; f.room.players.push(hidden);
    for (const event of [{ ownerId: hidden.id, x: 150, y: 0 },{ ownerId: f.me.id, x: 150, y: 0 },
        { ownerId: f.me.id, x: -280, y: 0 },{ ownerId: f.me.id, x: 40, y: 0 }])
        recordSurvivCombatEvent(f.room, { type: 'impact', material: 'stone', angle: 0, ...event }, f.now);
    f.step();
    const tick = f.packets.find(p => p.id === f.me.id).data;
    assert.equal(tick.players.length, 0); assert.equal(tick.combatEvents.length, 1); assert.equal(tick.combatEvents[0].x, 40);
});

test('presentation memory is capped and resetting a map removes old events without reusing ids', t => {
    const f = fixture(t);
    for (let i = 0; i < 500; i++) recordSurvivCombatEvent(f.room, { type: 'shot', ownerId: f.me.id, x: 0, y: 0, angle: 0 }, f.now);
    assert.equal(f.room._survivCombatEvents.length, 192);
    const lastId = f.room._survivCombatEvents.at(-1).id;
    assert.equal(collectSurvivCombatEvents(f.room, f.now, new Set(), () => true).length, 0);
    assert.equal(collectSurvivCombatEvents(f.room, f.now, new Set([f.me.id]), () => false).length, 0);
    resetSurvivRoomRuntime(f.room, { obstacles: [], loot: [] });
    assert.deepEqual(f.room._survivCombatEvents, []);
    recordSurvivCombatEvent(f.room, { type: 'shot', ownerId: f.me.id, x: 0, y: 0, angle: 0 }, f.now);
    assert.notEqual(f.room._survivCombatEvents[0].id, lastId);
});

test('existing cover types map to restrained, consistent impact materials', () => {
    for (const [object, material] of [[{ kind: 'player' }, 'blood'], [{kind:'tree'},'wood'],
        [{kind:'barrel',variant:'fuel'},'metal'],[{kind:'furniture',variant:'labBench'},'metal'],
        [{kind:'furniture',variant:'bathtub'},'stone'],[{kind:'chest',containerType:'wood_crate'},'wood'],
        [{kind:'sandbag'},'soft'],[{kind:'furniture',variant:'sofa'},'soft'],
        [{kind:'crate',variant:'industrial'},'metal'],[{kind:'bush'},'foliage']]) assert.equal(survivImpactMaterial(object),material);
});
