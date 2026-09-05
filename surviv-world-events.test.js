import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SURVIV, broadcastSurvivState, createSurvivPlayer, equipSurvivWeaponSlot,
    processSurvivRoom, resetSurvivRoomRuntime, spawnSurvivAirdrop,
    spawnSurvivBotNear, updateSurvivAirdrops,
} from './surviv-engine.js';

const io = { to: () => ({ emit() {} }) };
function roomFixture() {
    return { id: 'world-test', entryFeeUsd: 5, players: [], bots: [], bullets: [],
        obstacles: [], loot: [], spawnPoints: [], landmarks: [], spectators: [],
        _nextSurvivBotSyncAt: Infinity };
}
function player(room, id, x, y = 0) {
    const entity = createSurvivPlayer(id, id, id, '#ffffff', room);
    Object.assign(entity, { x, y, hp: 100, dollarBalance: 0 });
    room.players.push(entity);
    return entity;
}
function barrel(id, x, y = 0, variant = 'fuel') {
    return { id, kind: 'barrel', variant, x, y, w: 36, h: 36,
        collidable: true, destructible: true, hp: 42, maxHp: 42 };
}
function shoot(room, owner, x, y = 0, damage = 50) {
    room.bullets.push({ id: `shot-${room.bullets.length}`, ownerId: owner.id,
        x: x - 50, y, vx: 50, vy: 0, damage, weaponType: 'm9',
        bornAt: Date.now(), maxDistance: 800 });
}
function step(room) { return processSurvivRoom(room, io, Date.now() + 600000); }

test('airdrop never falls back inside water or a building when all landing points are blocked', () => {
    for (const kind of ['river', 'houseFloor']) {
        const room = roomFixture();
        room.obstacles.push({ id: kind, kind, x: 0, y: 0, w: 5000, h: 5000, collidable: false });
        room.spawnPoints = [{ x: 0, y: 0 }, { x: 8000, y: 8000 }];
        assert.equal(spawnSurvivAirdrop(room, 1000, { x: 0, y: 0, radius: 1200 }), null);
        assert.equal(room.airdrops.length, 0);
    }
});

test('airdrop validates rounded coordinates and keeps clearance from players and earlier drops', () => {
    const room = roomFixture();
    const viewer = player(room, 'viewer', 0);
    for (let i = 0; i < 20; i++) {
        const drop = spawnSurvivAirdrop(room, 1000, { x: 0, y: 0, radius: 1100 });
        if (!drop) continue;
        assert.ok(Number.isInteger(drop.x) && Number.isInteger(drop.y));
        assert.ok(Math.hypot(drop.x, drop.y) <= 930);
        assert.ok(Math.hypot(drop.x - viewer.x, drop.y - viewer.y) >= 150);
        assert.ok(room.airdrops.every(other => other.id === drop.id
            || Math.hypot(other.x - drop.x, other.y - drop.y) >= 180));
    }
    assert.ok(room.airdrops.length > 0);
});

test('a closed or tiny safe zone cannot expand into an artificial landing area', () => {
    for (const radius of [0, 100, 200]) {
        assert.equal(spawnSurvivAirdrop(roomFixture(), 1000, { x: 0, y: 0, radius }), null);
    }
});

test('a player standing on a landing marker is separated from the solid crate and can still move', () => {
    const room = roomFixture();
    const occupant = player(room, 'occupant', 0);
    const drop = spawnSurvivAirdrop(room, Date.now() - 9000, { x: 0, y: 0, radius: 4000 });
    occupant.x = drop.x;
    occupant.y = drop.y;
    step(room);
    assert.equal(drop.state, 'landed');
    assert.ok(Math.hypot(occupant.x - drop.x, occupant.y - drop.y) >= 31 + SURVIV.playerRadius - 0.1);
    occupant.inputDx = Math.sign(occupant.x - drop.x) || 1;
    occupant.inputDy = Math.sign(occupant.y - drop.y);
    const before = { x: occupant.x, y: occupant.y };
    step(room);
    assert.ok(Math.hypot(occupant.x - before.x, occupant.y - before.y) > 0);
});

test('failed scheduled drops retry without consuming the two-drop allowance; empty rooms do not spawn', () => {
    const room = roomFixture();
    room._nextSurvivAirdropAt = 1;
    const zone = { x: 0, y: 0, radius: 1000 };
    updateSurvivAirdrops(room, 1000, zone, 600000);
    assert.equal(room.airdrops.length, 0);
    player(room, 'viewer', 0);
    room.obstacles.push({ id: 'water', kind: 'river', x: 0, y: 0, w: 4000, h: 4000, collidable: false });
    updateSurvivAirdrops(room, 1000, zone, 600000);
    assert.equal(room._survivAirdropsSpawned || 0, 0);
    assert.equal(room._nextSurvivAirdropAt, 6000);
    room.obstacles = [];
    room._survivObstacleRevision = 1;
    updateSurvivAirdrops(room, 6000, zone, 600000);
    assert.equal(room._survivAirdropsSpawned, 1);
    assert.equal(room.airdrops.length, 1);
});

test('shooting a fuel barrel causes one authoritative blast and distance-based damage', () => {
    const room = roomFixture();
    const owner = player(room, 'shooter', -500);
    const near = player(room, 'near', 0, 55);
    const far = player(room, 'far', 0, 130);
    room.obstacles.push(barrel('fuel', 0));
    shoot(room, owner, 0);
    step(room);
    assert.equal(room.obstacles.length, 0);
    assert.equal(room._survivExplosions.length, 1);
    assert.equal(room._survivExplosions[0].kind, 'barrel');
    assert.ok(near.hp < far.hp && far.hp < 100);
    assert.equal(owner.hp, 100);
    assert.equal(near._damageTaken.kind, 'barrel');
    assert.equal(near._damageTaken.sourceX, 0);
    assert.equal(room.loot.length, 0, 'fuel barrels do not mint loot/money');
});

test('barrel chain reactions run once per object and preserve kill attribution', () => {
    const room = roomFixture();
    const owner = player(room, 'shooter', -500);
    const victim = player(room, 'victim', 65, 40);
    victim.hp = 20;
    room.obstacles.push(barrel('a', 0), barrel('b', 65), barrel('c', 130));
    shoot(room, owner, 0);
    step(room);
    assert.equal(room._survivExplosions.length, 3);
    assert.equal(room.obstacles.length, 0);
    assert.equal(owner.kills, 1);
    assert.equal(room._pendingKillFeed.length, 1);
    assert.equal(room._pendingKillFeed[0].weapon, 'barrel');
    assert.equal(room.deathMarkers[0].killerId, owner.id);
    assert.equal(room._survivBlastQueue, null);
});

test('water barrels break normally and damaged fuel barrels do not explode early', () => {
    const room = roomFixture();
    const owner = player(room, 'shooter', -500);
    room.obstacles.push(barrel('water', 0, 0, 'water'), barrel('fuel', 300));
    shoot(room, owner, 0);
    shoot(room, owner, 300, 0, 10);
    step(room);
    assert.equal(room.obstacles.length, 1);
    assert.equal(room.obstacles[0].hp, 32);
    assert.equal(room._survivExplosions?.length || 0, 0);
});

test('grenades trigger fuel barrels and keep grenade kill-source separate from equipped weapon', () => {
    const room = roomFixture();
    const owner = player(room, 'shooter', -500);
    const victim = player(room, 'victim', 0, 15);
    victim.hp = 20;
    room.obstacles.push(barrel('fuel', 65));
    room.bullets.push({ id: 'grenade', ownerId: owner.id, x: 0, y: 0, vx: 0, vy: 0,
        damage: SURVIV.grenadeDamage, isGrenade: true, detonateAt: 0, bornAt: 0 });
    step(room);
    assert.deepEqual(room._survivExplosions.map(event => event.kind), ['grenade', 'barrel']);
    assert.equal(room._pendingKillFeed[0].weapon, 'grenade');
    assert.equal(owner.kills, 1);
});

test('nearby explosion events repeat with stable ids, expire, and reset without leaking distant positions', () => {
    const room = roomFixture();
    const owner = player(room, 'viewer', -500);
    player(room, 'distant', 4000);
    room.obstacles.push(barrel('fuel', 0));
    shoot(room, owner, 0);
    const state = step(room);
    spawnSurvivAirdrop(room, Date.now(), state.zone);
    const packets = [];
    const capture = { to: id => ({ emit: (event, data) => { if (event === 'survivTick') packets.push({ id, data }); } }) };
    broadcastSurvivState(room, capture, state, {});
    broadcastSurvivState(room, capture, state, {});
    const near = packets.filter(packet => packet.id === owner.id);
    assert.equal(near[0].data.explosions.length, 1);
    assert.equal(near[0].data.explosions[0].id, near[1].data.explosions[0].id);
    assert.ok(near[0].data.airdrops[0].remainingMs <= 8200);
    assert.ok(packets.filter(packet => packet.id === 'distant').every(packet => packet.data.explosions.length === 0));
    room._survivExplosions[0].createdAt -= 1000;
    broadcastSurvivState(room, capture, state, {});
    assert.equal(room._survivExplosions.length, 0);
    resetSurvivRoomRuntime(room, { obstacles: [], loot: [] });
    assert.deepEqual(room._survivExplosions, []);
});

test('armed bots approach blocked crates instead of stopping to fire through a wall', () => {
    const room = roomFixture();
    player(room, 'observer', 3000, 3000);
    const bot = spawnSurvivBotNear(room, 0, 0, { adminSpawned: true });
    Object.assign(bot, { x: 0, y: 0, botThinkAt: 0 });
    bot.inventory.weapons = ['assault'];
    bot.weaponSlotAmmo = [20];
    equipSurvivWeaponSlot(bot, 0);
    room.obstacles.push({ id: 'wall', kind: 'wall', x: 100, y: 0, w: 20, h: 180, collidable: true });
    room.loot.push({ id: 'crate', type: 'chest', containerType: 'armory_crate', x: 200, y: 0,
        hp: 100, hitRadius: 26, contents: { weaponType: 'sniper', medkits: 2, rarity: 'military' } });
    step(room);
    assert.equal(bot.shooting, false);
    assert.ok(Math.hypot(bot.inputDx, bot.inputDy) > 0);
});
