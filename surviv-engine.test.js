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

function rectsOverlap(x1, y1, w1, h1, x2, y2, w2, h2) {
    return Math.abs(x1 - x2) < (w1 + w2) / 2 && Math.abs(y1 - y2) < (h1 + h2) / 2;
}

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
    assert.ok(houses.length >= 90);
    assert.ok(chests.length < houses.length);
    assert.equal(groundLoot.length, 42);
    assert.ok(maxExtent <= SURVIV.worldHalf);
});

test('surviv open areas keep scattered cover and small houses', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const coverKinds = new Set(['tree', 'bush', 'rock']);
    const openCover = map.obstacles.filter(obstacle => (
        coverKinds.has(obstacle.kind)
        && Math.hypot(obstacle.x, obstacle.y) > 1800
    ));
    const openTrees = openCover.filter(obstacle => obstacle.kind === 'tree');
    const coverCells = new Set(openCover.map(obstacle => (
        Math.floor((obstacle.x + SURVIV.worldHalf) / 1800)
        + ','
        + Math.floor((obstacle.y + SURVIV.worldHalf) / 1800)
    )));
    const treeCells = new Set(openTrees.map(obstacle => (
        Math.floor((obstacle.x + SURVIV.worldHalf) / 1600)
        + ','
        + Math.floor((obstacle.y + SURVIV.worldHalf) / 1600)
    )));
    const smallHouseVariants = new Set(['cabin', 'house', 'barn']);
    const smallOpenHouses = map.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor'
        && smallHouseVariants.has(obstacle.variant)
        && Math.hypot(obstacle.x, obstacle.y) > 1800
    ));

    assert.ok(openCover.length >= 900);
    assert.ok(openTrees.length >= 700);
    assert.ok(coverCells.size >= 78);
    assert.ok(treeCells.size >= 90);
    assert.ok(smallOpenHouses.length >= 24);
});

test('surviv town roads stay centered between rows and doors face the road', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const plannedTownRoads = map.obstacles.filter(obstacle => (
        obstacle.kind === 'road'
        && obstacle.variant === 'dirt'
        && obstacle.w >= 1900
        && obstacle.h === 120
    ));
    const townHouses = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor' && obstacle.variant === 'town');
    const doorsByHouse = new Map(map.obstacles
        .filter(obstacle => obstacle.kind === 'door')
        .map(door => [door.houseId, door]));

    assert.equal(plannedTownRoads.length, 3);
    assert.ok(townHouses.length >= 20);

    for (const house of townHouses) {
        const road = plannedTownRoads.find(candidate => (
            Math.abs(house.x - candidate.x) <= candidate.w / 2
            && Math.abs(house.y - candidate.y) <= 320
        ));
        assert.ok(road, 'town house should belong to a centered town road');

        const door = doorsByHouse.get(house.id);
        assert.ok(door, 'town house should have a doorway');

        const expectedSide = house.y < road.y ? 'south' : 'north';
        assert.equal(door.role, expectedSide);
        assert.ok(Math.abs(door.x - house.x) < 1);
        if (expectedSide === 'south') {
            assert.ok(door.y > house.y && door.y < road.y);
        } else {
            assert.ok(door.y < house.y && door.y > road.y);
        }
    }
});

test('surviv network roads do not run through buildings or walls', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const roads = map.obstacles.filter(obstacle => obstacle.kind === 'road' && obstacle.role === 'networkRoad');
    const blockers = map.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor'
        || obstacle.kind === 'wall'
        || obstacle.kind === 'interiorWall'
        || obstacle.kind === 'door'
        || obstacle.kind === 'container'
    ) && obstacle.role !== 'bridgeRail');

    assert.ok(roads.length >= 16);
    for (const road of roads) {
        for (const blocker of blockers) {
            assert.equal(
                rectsOverlap(road.x, road.y, road.w, road.h, blocker.x, blocker.y, blocker.w, blocker.h),
                false,
                'network road should not overlap ' + blocker.kind,
            );
        }
    }
});

test('straight surviv roads do not create extra square asphalt stubs', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const squareAsphaltRoads = map.obstacles.filter(obstacle => (
        obstacle.kind === 'road'
        && obstacle.variant === 'asphalt'
        && obstacle.w === 120
        && obstacle.h === 120
    ));

    assert.equal(squareAsphaltRoads.length, 0);
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

test('ground loot creates a pickup summary for the player', () => {
    const room = makeRoom();
    const player = createSurvivPlayer('human-loot', 'mongo-loot', 'Collector', '#fff', room);
    room.players.push(player);
    room.loot = [
        { id: 'ammo-drop', type: 'ammo', x: player.x, y: player.y, amount: 2, tier: 'common' },
        { id: 'medkit-drop', type: 'medkit', x: player.x, y: player.y, amount: 1, tier: 'rare' },
    ];

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(player.inventory.ammoPacks, 2);
    assert.equal(player.inventory.medkits, 1);
    assert.equal(player.lastLoot.source, 'ground');
    assert.equal(player.lastLoot.items.ammoPacks, 2);
    assert.equal(player.lastLoot.items.medkits, 1);
});
test('fast bullets hit and eliminate bots along their full travel path', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    const player = createSurvivPlayer('human-shot', 'mongo-shot', 'Shooter', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.weapon = { type: 'sniper', ammo: 5, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.inventory.weapons = ['fists', 'sniper'];
    player.shooting = true;
    room.players.push(player);
    const bot = spawnSurvivBotNear(room, 90, 0, { adminSpawned: true });
    bot.hp = 40;
    bot.botThinkAt = Number.POSITIVE_INFINITY;

    processSurvivRoom(room, silentIo, Date.now() + 600000);
    player.shooting = false;
    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(room.bots.some(candidate => candidate.id === bot.id), false);
    assert.equal(player.kills, 1);
});

test('surviv bots automatically collect useful ground loot', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    const player = createSurvivPlayer('human-far', 'mongo-far', 'Observer', '#fff', room);
    player.x = 1000;
    player.y = 1000;
    room.players.push(player);
    const bot = spawnSurvivBotNear(room, 0, 0, { adminSpawned: true });
    room.loot.push({ id: 'bot-medkit', type: 'medkit', x: 0, y: 0, amount: 1, tier: 'common' });

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(bot.inventory.medkits, 1);
    assert.equal(room.loot.some(item => item.id === 'bot-medkit'), false);
});
