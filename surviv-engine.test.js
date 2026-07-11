import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SURVIV,
    beginSurvivReload,
    broadcastSurvivState,
    createSurvivPlayer,
    equipSurvivWeaponSlot,
    generateSurvivMap,
    processSurvivRoom,
    spawnLootFromPool,
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

function pointInRect(x, y, rect, padding = 0) {
    return x >= rect.x - rect.w / 2 - padding
        && x <= rect.x + rect.w / 2 + padding
        && y >= rect.y - rect.h / 2 - padding
        && y <= rect.y + rect.h / 2 + padding;
}

function circleRectCollision(x, y, radius, rect) {
    const closestX = Math.max(rect.x - rect.w / 2, Math.min(x, rect.x + rect.w / 2));
    const closestY = Math.max(rect.y - rect.h / 2, Math.min(y, rect.y + rect.h / 2));
    return Math.hypot(x - closestX, y - closestY) < radius;
}

test('surviv map keeps its 20k world while concentrating loot inside structures', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const houses = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
    const chests = map.loot.filter(item => item.type === 'chest');
    const groundLoot = map.loot.filter(item => item.source === 'ground');
    const maxExtent = Math.max(...map.obstacles.map(obstacle => Math.max(
        Math.abs(obstacle.x) + (obstacle.w || 0) / 2,
        Math.abs(obstacle.y) + (obstacle.h || 0) / 2,
    )));

    assert.equal(SURVIV.worldHalf, 10000);
    assert.equal(map.landmarks.length, 19);
    assert.ok(houses.length >= 100);
    assert.ok(chests.length < houses.length);
    assert.equal(groundLoot.length, 22);
    for (const item of groundLoot) {
        const floor = houses.find(house => house.id === item.houseId);
        assert.ok(floor, 'loose map loot should belong to a building');
        assert.equal(item.location, 'interior');
        assert.ok(pointInRect(item.x, item.y, floor, -18));
    }
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

    assert.ok(openCover.length >= 700);
    assert.ok(openTrees.length >= 550);
    assert.ok(coverCells.size >= 75);
    assert.ok(treeCells.size >= 88);
    assert.ok(smallOpenHouses.length >= 45);
});

test('surviv chests roll varied money across map loot', () => {
    const moneyAmounts = [];
    let chestCount = 0;
    for (let i = 0; i < 8; i++) {
        const map = generateSurvivMap(SURVIV.worldHalf);
        const chests = map.loot.filter(item => item.type === 'chest' && item.source === 'map');
        chestCount += chests.length;
        for (const chest of chests) {
            if (chest.contents?.money) moneyAmounts.push(Number(chest.contents.money));
        }
    }

    assert.ok(chestCount > 80);
    assert.ok(moneyAmounts.length >= 12);
    assert.ok(moneyAmounts.every(amount => amount >= 0.2 && amount <= 2));
    assert.ok(new Set(moneyAmounts.map(amount => amount.toFixed(2))).size >= 6);
});

test('surviv join money crates vary amounts while preserving the pool', () => {
    const room = makeRoom();
    room.loot = [];
    spawnLootFromPool(room, 8.25);

    const amounts = room.loot
        .filter(item => item.type === 'chest' && item.source === 'join')
        .map(item => Number(item.contents?.money || 0));
    const total = Number(amounts.reduce((sum, amount) => sum + amount, 0).toFixed(2));

    assert.ok(amounts.length >= 5);
    assert.equal(total, 8.25);
    assert.ok(amounts.every(amount => amount >= 0.2 && amount <= 2));
    assert.ok(new Set(amounts.map(amount => amount.toFixed(2))).size > 1);
    assert.equal(room.lootPoolBalance, 0);
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

    assert.ok(roads.length >= 12);
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

test('surviv landmark approaches survive road clipping without tiny fragments', () => {
    const approachPoints = [
        { x: 6950, y: -1200, name: 'farm' },
        { x: 4800, y: -6800, name: 'north-east town' },
        { x: 6950, y: 7200, name: 'research campus' },
        { x: -7500, y: -6810, name: 'north-west mansion' },
        { x: -2500, y: 7300, name: 'ironworks' },
        { x: -7200, y: 1900, name: 'south-west town' },
        { x: -7800, y: -3900, name: 'forest camp' },
        { x: 2400, y: 7310, name: 'bunker' },
    ];

    for (let i = 0; i < 5; i++) {
        const map = generateSurvivMap(SURVIV.worldHalf);
        const roads = map.obstacles.filter(obstacle => obstacle.kind === 'road');
        const networkRoads = roads.filter(obstacle => obstacle.role === 'networkRoad');

        assert.ok(networkRoads.every(road => Math.max(road.w, road.h) >= 132));
        for (const point of approachPoints) {
            assert.ok(roads.some(road => pointInRect(point.x, point.y, road, 4)), point.name + ' should have a road approach');
        }
    }
});

test('Ironworks is a multi-entry indoor combat landmark with loop routes', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const landmark = map.landmarks.filter(item => item.type === 'ironworks');
    const floors = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor' && obstacle.variant === 'ironworks');

    assert.equal(landmark.length, 1);
    assert.equal(floors.length, 1);
    const floor = floors[0];
    assert.equal(floor.label, 'IRONWORKS');
    assert.equal(floor.landmarkType, 'ironworks');
    assert.ok(floor.w >= 1600 && floor.h >= 1100);

    const doors = map.obstacles.filter(obstacle => obstacle.kind === 'door' && obstacle.houseId === floor.id);
    assert.equal(doors.length, 4);
    assert.deepEqual(new Set(doors.map(door => door.role)), new Set(['north', 'south', 'east', 'west']));
    assert.ok(doors.some(door => door.entranceRole === 'mainEntrance'));
    assert.ok(doors.some(door => door.entranceRole === 'loadingEntrance'));

    const rooms = map.obstacles.filter(obstacle => obstacle.kind === 'roomZone' && obstacle.houseId === floor.id);
    const roomVariants = new Set(rooms.map(room => room.variant));
    for (const variant of ['hallway', 'factory-floor', 'workshop', 'control-room', 'storage', 'loading-bay']) {
        assert.ok(roomVariants.has(variant), 'missing Ironworks room ' + variant);
    }
    const hallway = rooms.find(room => room.variant === 'hallway');
    const factoryLanes = rooms.filter(room => room.variant === 'factory-floor');
    assert.equal(factoryLanes.length, 2);
    assert.ok(factoryLanes.every(room => !rectsOverlap(
        hallway.x, hallway.y, hallway.w, hallway.h,
        room.x, room.y, room.w, room.h,
    )));

    const metalWalls = map.obstacles.filter(obstacle => (
        (obstacle.kind === 'wall' || obstacle.kind === 'interiorWall')
        && obstacle.variant === 'metal'
        && obstacle.houseId === floor.id
    ));
    assert.ok(metalWalls.length >= 12);
    assert.ok(metalWalls.every(wall => wall.landmarkType === 'ironworks'));

    const solidMachines = map.obstacles.filter(obstacle => (
        obstacle.kind === 'furniture'
        && obstacle.houseId === floor.id
        && obstacle.variant === 'machine'
        && obstacle.collidable
    ));
    assert.equal(solidMachines.length, 2);

    const chests = map.loot.filter(item => item.houseId === floor.id && item.type === 'chest');
    assert.equal(chests.length, 5);
    assert.ok(chests.some(chest => chest.room === 'hallway'));

    const apron = map.obstacles.find(obstacle => (
        obstacle.kind === 'road'
        && obstacle.role === 'driveway'
        && obstacle.landmarkType === 'ironworks'
    ));
    const highway = map.obstacles.find(obstacle => (
        obstacle.kind === 'road'
        && obstacle.role === 'networkRoad'
        && rectsOverlap(
            obstacle.x, obstacle.y, obstacle.w, obstacle.h,
            apron.x, apron.y, apron.w, apron.h,
        )
    ));
    assert.ok(apron);
    assert.ok(highway, 'Ironworks apron should join the highway');
});

test('farm, research campus, and hamlets use purposeful road-facing layouts', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const doorsByHouse = new Map(map.obstacles
        .filter(obstacle => obstacle.kind === 'door')
        .map(door => [door.houseId, door]));

    const farmBuildings = map.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor' && obstacle.landmarkType === 'farm'
    ));
    const labBuildings = map.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor' && obstacle.landmarkType === 'lab'
    ));
    const hamletHomes = map.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor' && obstacle.role === 'hamletHome'
    ));
    const hamletFields = map.obstacles.filter(obstacle => obstacle.kind === 'field' && obstacle.role === 'hamlet');

    assert.equal(farmBuildings.length, 4);
    assert.deepEqual(new Set(farmBuildings.map(building => building.role)), new Set(['barn', 'farmhouse', 'shed', 'greenhouse']));
    assert.equal(labBuildings.length, 3);
    assert.deepEqual(new Set(labBuildings.map(building => building.label)), new Set(['LAB A', 'LAB B', 'POWER']));
    assert.equal(hamletFields.length, 5);
    assert.equal(hamletHomes.length, 15);
    assert.ok([...farmBuildings, ...labBuildings, ...hamletHomes].every(building => doorsByHouse.has(building.id)));

    const farmRoad = map.obstacles.find(obstacle => obstacle.kind === 'road' && obstacle.landmarkType === 'farm' && obstacle.role === 'driveway');
    const labRoad = map.obstacles.find(obstacle => obstacle.kind === 'road' && obstacle.landmarkType === 'lab' && obstacle.role === 'driveway');
    assert.ok(farmRoad);
    assert.ok(labRoad);
    for (const building of farmBuildings) {
        const door = doorsByHouse.get(building.id);
        assert.equal(door.role, building.y < farmRoad.y ? 'south' : 'north');
    }
    for (const building of labBuildings) {
        const door = doorsByHouse.get(building.id);
        assert.equal(door.role, building.y < labRoad.y ? 'south' : 'north');
    }
});

test('Grand Market forms a large indoor village rotation', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const landmark = map.landmarks.find(item => item.type === 'market');
    const hall = map.obstacles.find(obstacle => (
        obstacle.kind === 'houseFloor' && obstacle.role === 'marketHall'
    ));
    const shops = map.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor' && obstacle.role === 'marketShop'
    ));
    const square = map.obstacles.find(obstacle => obstacle.role === 'marketSquare');
    const mainStreet = map.obstacles.find(obstacle => (
        obstacle.kind === 'road' && obstacle.landmarkType === 'market' && obstacle.role === 'mainStreet'
    ));
    const hallDoors = map.obstacles.filter(obstacle => obstacle.kind === 'door' && obstacle.houseId === hall?.id);
    const marketLoot = map.loot.filter(item => pointInRect(item.x, item.y, {
        x: landmark?.x || 0, y: landmark?.y || 0, w: 1900, h: 1320,
    }));

    assert.ok(landmark);
    assert.ok(hall);
    assert.ok(hall.w >= 900 && hall.h >= 500);
    assert.equal(shops.length, 4);
    assert.ok(square);
    assert.ok(mainStreet);
    assert.ok(hallDoors.length >= 1);
    assert.ok(marketLoot.length >= 2);
});

test('generated doors, props, and player spawns keep clear traversal space', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const floors = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
    const doors = map.obstacles.filter(obstacle => obstacle.kind === 'door');
    const propKinds = new Set(['tree', 'bush', 'rock', 'crate', 'barrel', 'container', 'sandbag', 'tent']);
    const props = map.obstacles.filter(obstacle => propKinds.has(obstacle.kind));

    for (const door of doors) {
        const horizontal = door.role === 'north' || door.role === 'south';
        const approach = {
            x: door.x,
            y: door.y,
            w: horizontal ? Math.max(180, door.w + 120) : 190,
            h: horizontal ? 190 : Math.max(180, door.h + 120),
        };
        assert.ok(props.every(prop => !rectsOverlap(
            prop.x, prop.y, prop.w, prop.h,
            approach.x, approach.y, approach.w, approach.h,
        )), 'door approach should stay free of solid props');
    }
    for (const prop of props.filter(obstacle => !obstacle.houseId)) {
        assert.ok(floors.every(floor => !rectsOverlap(
            prop.x, prop.y, prop.w, prop.h,
            floor.x, floor.y, floor.w, floor.h,
        )), 'outdoor props should not be embedded in buildings');
    }

    const forbidden = map.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor'
        || obstacle.kind === 'water'
        || obstacle.kind === 'river'
        || obstacle.collidable !== false
    ));
    assert.ok(map.spawnPoints.length >= 100);
    assert.ok(map.spawnPoints.every(point => forbidden.every(obstacle => (
        !circleRectCollision(point.x, point.y, 28, obstacle)
    ))));

    const room = makeRoom();
    const runtimeForbidden = room.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor'
        || obstacle.kind === 'water'
        || obstacle.kind === 'river'
        || obstacle.collidable !== false
    ));
    for (let i = 0; i < 500; i++) {
        const player = createSurvivPlayer('spawn-' + i, 'mongo-' + i, 'Spawn test', '#fff', room);
        assert.ok(runtimeForbidden.every(obstacle => !circleRectCollision(
            player.x, player.y, SURVIV.playerRadius + 10, obstacle,
        )), 'runtime spawn should stay outside structures and water');
    }
});

test('river spline metadata survives generation and bridges hit both highways exactly', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const riverPath = map.obstacles.find(obstacle => obstacle.kind === 'river_path');
    const bridges = map.obstacles.filter(obstacle => obstacle.kind === 'bridge');

    assert.ok(riverPath);
    assert.equal(riverPath.points.length, 15);
    assert.ok(riverPath.width >= 210 && riverPath.width <= 270);
    assert.ok(riverPath.points.every(point => pointInRect(point.x, point.y, riverPath)));
    assert.equal(bridges.length, 2);
    assert.deepEqual(bridges.map(bridge => Math.round(bridge.x)).sort((a, b) => a - b), [-2500, 2500]);
});

test('ground weapons require F and replace the held slot', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    const player = createSurvivPlayer('human-weapons', 'mongo-weapons', 'Two Slots', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inventory.weapons = ['pistol', 'smg'];
    player.weapon = { type: 'pistol', ammo: 7, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.weaponsAmmo = { pistol: 7, smg: 18 };
    room.players.push(player);
    room.loot.push({ id: 'loot-shotgun', type: 'weapon', x: 0, y: 0, weaponType: 'shotgun', pickupAfter: 0 });

    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.equal(player.weapon.type, 'pistol', 'walking over a weapon must not auto-pick it up');
    assert.ok(room.loot.some(item => item.weaponType === 'shotgun'));

    player.pickupWeaponPending = true;
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.deepEqual(player.inventory.weapons, ['shotgun', 'smg']);
    assert.equal(player.weapon.type, 'shotgun');
    assert.equal(player.weapon.ammo, 6);
    assert.ok(room.loot.some(item => item.weaponType === 'pistol'), 'the replaced gun should remain on the ground');
});

test('empty weapon slots select melee and G drops the held gun', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    const player = createSurvivPlayer('human-drop', 'mongo-drop', 'Dropper', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inventory.weapons = ['pistol'];
    player.weapon = { type: 'pistol', ammo: 9, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.weaponsAmmo = { pistol: 9 };
    room.players.push(player);

    assert.equal(equipSurvivWeaponSlot(player, 1), true);
    assert.equal(player.weapon.type, 'fists');
    assert.equal(equipSurvivWeaponSlot(player, 0), true);
    assert.equal(player.weapon.type, 'pistol');

    player.dropItemPending = { itemKey: 'weapon', slotIdx: 0 };
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.equal(player.weapon.type, 'fists');
    assert.deepEqual(player.inventory.weapons, []);
    const dropped = room.loot.find(item => item.type === 'weapon' && item.weaponType === 'pistol');
    assert.ok(dropped);
    assert.equal(dropped.ammo, 9);
});

test('chest transfers preserve overflow and reject occupied weapon slots', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    const player = createSurvivPlayer('human-chest', 'mongo-chest', 'Pack Rat', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inventory.medkits = 5;
    player.inventory.weapons = ['pistol', 'smg'];
    player.weapon = { type: 'pistol', ammo: 7, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    room.players.push(player);

    const chest = {
        id: 'transaction-chest',
        type: 'chest',
        x: 0,
        y: 0,
        contents: { medkits: 4, weaponType: 'shotgun', rarity: 'rare' },
    };
    room.loot.push(chest);

    player.takeChestItem = { chestId: chest.id, itemKey: 'medkits' };
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.equal(player.inventory.medkits, 6);
    assert.equal(chest.contents.medkits, 3);

    player.takeChestItem = { chestId: chest.id, itemKey: 'weapon' };
    processSurvivRoom(room, silentIo, Date.now() + 600001);
    assert.deepEqual(player.inventory.weapons, ['pistol', 'smg']);
    assert.equal(chest.contents.weaponType, 'shotgun');

    player.putChestItem = { chestId: chest.id, itemKey: 'weapon', weaponType: 'pistol' };
    processSurvivRoom(room, silentIo, Date.now() + 600002);
    assert.deepEqual(player.inventory.weapons, ['pistol', 'smg']);
    assert.equal(chest.contents.weaponType, 'shotgun');
    assert.equal(player.weapon.type, 'pistol');
});

test('players and automatic bots start with fists and no dollars', () => {
    const room = makeRoom();
    const player = createSurvivPlayer('human-1', 'mongo-1', 'Tester', '#fff', room);
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(player.weapon.type, 'fists');
    assert.deepEqual(player.inventory.weapons, []);
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
    victim.inventory.weapons = ['smg'];
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
test('medkits heal only after the server timer completes', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    const player = createSurvivPlayer('human-heal', 'mongo-heal', 'Medic', '#fff', room);
    player.hp = 40;
    player.inventory.medkits = 1;
    player.useMedkit = true;
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.equal(player.hp, 40);
    assert.equal(player.inventory.medkits, 1);
    assert.ok(player.medkitUseEndAt > Date.now());

    player.medkitUseEndAt = Date.now() - 1;
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.equal(player.hp, 85);
    assert.equal(player.inventory.medkits, 0);
    assert.equal(player.medkitUseEndAt, 0);
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
    player.inventory.weapons = ['sniper'];
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

test('surviv static terrain payload is retained between periodic sends', () => {
    const room = makeRoom();
    const player = createSurvivPlayer('static-viewer', 'mongo-static', 'Viewer', '#fff', room);
    room.players.push(player);
    player.x = 0;
    player.y = -1500;
    const ticks = [];
    const io = {
        to() {
            return {
                emit(event, payload) {
                    if (event === 'survivTick') ticks.push(payload);
                },
            };
        },
    };
    const lbData = {
        leaderboard: [],
        zone: { x: 0, y: 0, radius: SURVIV.worldHalf },
    };

    broadcastSurvivState(room, io, lbData, {});
    broadcastSurvivState(room, io, lbData, {});

    assert.ok(Array.isArray(ticks[0].obstacles));
    assert.ok(ticks[0].minimap);
    const serializedRiver = ticks[0].obstacles.find(obstacle => obstacle.kind === 'river_path');
    assert.ok(serializedRiver);
    assert.equal(serializedRiver.points.length, 15);
    assert.ok(serializedRiver.width >= 210);
    assert.equal(Object.hasOwn(ticks[1], 'obstacles'), false);
    assert.equal(Object.hasOwn(ticks[1], 'minimap'), false);
    assert.ok(Array.isArray(ticks[1].players));
    assert.ok(Array.isArray(ticks[1].loot));

    room._survivViewerPayloadCache.get(player.id).lastStaticAt = 0;
    broadcastSurvivState(room, io, lbData, {});
    assert.ok(Array.isArray(ticks[2].obstacles));
    assert.ok(ticks[2].minimap);

    const ironworks = room.landmarks.find(landmark => landmark.type === 'ironworks');
    player.x = ironworks.x;
    player.y = ironworks.y;
    broadcastSurvivState(room, io, lbData, {});
    assert.ok(Array.isArray(ticks[3].obstacles));
    assert.ok(ticks[3].minimap);
    const serializedIronworks = ticks[3].obstacles.find(obstacle => obstacle.kind === 'houseFloor' && obstacle.variant === 'ironworks');
    const serializedMainDoor = ticks[3].obstacles.find(obstacle => (
        obstacle.kind === 'door'
        && obstacle.houseId === serializedIronworks.id
        && obstacle.entranceRole === 'mainEntrance'
    ));
    assert.equal(serializedIronworks.label, 'IRONWORKS');
    assert.equal(serializedIronworks.landmarkType, 'ironworks');
    assert.equal(serializedIronworks.orientation, 'east');
    assert.equal(serializedMainDoor.role, 'east');
});

test('surviv alive count and leaderboard use the same active entities', () => {
    const room = makeRoom();
    room.loot = [];
    room._nextSurvivBotSyncAt = Date.now() + 60000;
    const active = createSurvivPlayer('active-human', 'mongo-active', 'Active', '#fff', room);
    const disconnected = createSurvivPlayer('disconnected-human', 'mongo-disconnected', 'Gone', '#fff', room);
    disconnected.disconnected = true;
    const dead = createSurvivPlayer('dead-human', 'mongo-dead', 'Dead', '#fff', room);
    dead.hp = 0;
    room.players.push(active, disconnected, dead);

    const liveBot = spawnSurvivBotNear(room, active.x + 3000, active.y, { adminSpawned: true });
    const deadBot = spawnSurvivBotNear(room, active.x - 3000, active.y, { adminSpawned: true });
    deadBot.hp = 0;
    const lbData = processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(lbData.aliveCount, 2);
    assert.deepEqual(
        new Set(lbData.leaderboard.map(entry => entry.id)),
        new Set([active.id, liveBot.id]),
    );

    const ticks = [];
    const io = {
        to() {
            return {
                emit(event, payload) {
                    if (event === 'survivTick') ticks.push(payload);
                },
            };
        },
    };
    broadcastSurvivState(room, io, lbData, {});
    assert.equal(ticks[0].aliveCount, lbData.aliveCount);
});
