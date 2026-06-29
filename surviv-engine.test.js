import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SURVIV,
    beginSurvivReload,
    createSurvivPlayer,
    generateSurvivMap,
    processSurvivRoom,
    spawnSurvivBotNear,
} from './surviv-engine.js';

function makeRoom() {
    const map = generateSurvivMap(SURVIV.worldHalf);
    return {
        id: 'surviv-test',
        entryFeeUsd: 5,
        players: [],
        bots: [],
        bullets: [],
        loot: [...map.loot],
        obstacles: map.obstacles,
        spawnPoints: map.spawnPoints,
        landmarks: map.landmarks,
        spectators: [],
    };
}

const silentIo = { to: () => ({ emit() {} }) };

test('surviv map stays dense inside the smaller world', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const houses = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
    const chests = map.loot.filter(item => item.type === 'chest');
    const groundLoot = map.loot.filter(item => item.source === 'ground');
    const maxExtent = Math.max(...map.obstacles.map(obstacle => Math.max(
        Math.abs(obstacle.x) + (obstacle.w || 0) / 2,
        Math.abs(obstacle.y) + (obstacle.h || 0) / 2,
    )));

    assert.equal(SURVIV.worldHalf, 10000);
    assert.equal(map.landmarks.length, 17);
    assert.ok(houses.length >= 70);
    assert.ok(chests.length < houses.length);
    assert.equal(groundLoot.length, 42);
    assert.ok(maxExtent <= SURVIV.worldHalf);
});

test('players and automatic bots start with fists and no dollars', () => {
    const room = makeRoom();
    const player = createSurvivPlayer('human-1', 'mongo-1', 'Tester', '#fff', room);
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(player.weapon.type, 'fists');
    assert.deepEqual(player.inventory.weapons, ['fists']);
    assert.equal(player.dollarBalance, 0);
    assert.equal(room.bots.length, 3);
    assert.ok(room.bots.every(bot => bot.weapon.type === 'fists'));
    assert.ok(room.bots.every(bot => bot.dollarBalance === 0));
});

test('automatic surviv bots scale by two up to eight', () => {
    const room = makeRoom();
    for (let i = 0; i < 4; i++) {
        room.players.push(createSurvivPlayer(`human-${i}`, `mongo-${i}`, `Player ${i}`, '#fff', room));
    }

    for (let i = 0; i < 5; i++) {
        room._nextSurvivBotSyncAt = 0;
        processSurvivRoom(room, silentIo, Date.now() + 600000);
    }

    assert.equal(room.bots.filter(bot => !bot.adminSpawned).length, 8);
});

test('melee deaths scatter the full inventory instead of making a death crate', () => {
    const room = makeRoom();
    const player = createSurvivPlayer('human-melee', 'mongo-melee', 'Boxer', '#fff', room);
    room.players.push(player);
    const victim = spawnSurvivBotNear(room, player.x + 32, player.y, { adminSpawned: true });
    victim.hp = 1;
    victim.dollarBalance = 2;
    victim.armor = 35;
    victim.inventory.weapons = ['fists', 'smg'];
    victim.inventory.medkits = 1;
    victim.inventory.ammoPacks = 2;
    player.aimAngle = 0;
    player.shooting = true;

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    const deathDrops = room.loot.filter(item => item.source === 'death');
    assert.ok(deathDrops.some(item => item.type === 'money' && item.dollarValue === 2));
    assert.ok(deathDrops.some(item => item.type === 'weapon' && item.weaponType === 'smg'));
    assert.ok(deathDrops.some(item => item.type === 'medkit' && item.amount === 1));
    assert.ok(deathDrops.some(item => item.type === 'ammo' && item.amount === 2));
    assert.ok(deathDrops.some(item => item.type === 'armor' && item.armorValue > 0));
    assert.equal(room.loot.some(item => item.type === 'deathCrate'), false);
});
test('manual reload only starts for a partially empty firearm', () => {
    const fullWeapon = { weapon: { type: 'smg', ammo: 30, reloading: false, reloadEndAt: 0 } };
    assert.equal(beginSurvivReload(fullWeapon, 1000), false);
    assert.equal(fullWeapon.weapon.reloading, false);

    const partialWeapon = { weapon: { type: 'smg', ammo: 11, reloading: false, reloadEndAt: 0 } };
    assert.equal(beginSurvivReload(partialWeapon, 1000), true);
    assert.equal(partialWeapon.weapon.reloading, true);
    assert.equal(partialWeapon.weapon.reloadEndAt, 2800);

    assert.equal(beginSurvivReload(partialWeapon, 1500), false);
    assert.equal(partialWeapon.weapon.reloadEndAt, 2800);

    const fists = { weapon: { type: 'fists', ammo: 0, reloading: false, reloadEndAt: 0 } };
    assert.equal(beginSurvivReload(fists, 1000), false);
});
