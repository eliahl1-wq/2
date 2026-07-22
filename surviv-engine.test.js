import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SURVIV,
    WEAPONS,
    beginSurvivReload,
    broadcastSurvivState,
    createSurvivPlayer,
    equipSurvivWeaponSlot,
    generateSurvivMap,
    getSurvivZone,
    processSurvivRoom,
    resetSurvivRoomRuntime,
    spawnLootFromPool,
    spawnSurvivBotNear,
} from './surviv-engine.js';
import { getSurvivEconomy } from './economy.js';

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
    const angle = -(Number(rect.rotation) || 0);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = x - rect.x;
    const dy = y - rect.y;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const closestX = Math.max(-rect.w / 2, Math.min(localX, rect.w / 2));
    const closestY = Math.max(-rect.h / 2, Math.min(localY, rect.h / 2));
    return Math.hypot(localX - closestX, localY - closestY) < radius;
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

test('pond sites and the west forest camp keep readable spacing', () => {
    let pondCount = 0;
    for (let sample = 0; sample < 8 && pondCount < 3; sample++) {
        const map = generateSurvivMap(SURVIV.worldHalf);
        const ponds = map.obstacles.filter(obstacle => obstacle.kind === 'water' && obstacle.variant === 'pond');
        const roads = map.obstacles.filter(obstacle => obstacle.kind === 'road');
        const houses = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
        const looseProps = map.obstacles.filter(obstacle => (
            obstacle.kind === 'tree'
            || obstacle.kind === 'rock'
            || obstacle.kind === 'bush'
            || obstacle.kind === 'crate'
            || obstacle.kind === 'barrel'
            || obstacle.kind === 'tent'
            || obstacle.kind === 'sandbag'
        ));

        for (const pond of ponds) {
            pondCount++;
            assert.ok(roads.every(road => !rectsOverlap(
                pond.x, pond.y, pond.w, pond.h,
                road.x, road.y, road.w, road.h,
            )), 'roads must not cut through ponds');
            assert.ok(houses.every(house => !rectsOverlap(
                pond.x, pond.y, pond.w, pond.h,
                house.x, house.y, house.w, house.h,
            )), 'houses must stay outside pond water');
            assert.ok(looseProps.every(prop => !pointInRect(prop.x, prop.y, pond, 4)), 'loose props must stay out of ponds');
        }

        const campProps = map.obstacles.filter(obstacle => (
            Math.abs(obstacle.x + 7800) < 1400
            && Math.abs(obstacle.y + 3800) < 1200
            && obstacle.kind !== 'field'
        ));
        const campHouses = campProps.filter(obstacle => obstacle.kind === 'houseFloor');
        assert.ok(campProps.length < 120, `west forest camp is too crowded: ${campProps.length} props`);
        assert.ok(campHouses.length <= 4, `west forest camp has too many stacked buildings: ${campHouses.length}`);
    }
    assert.ok(pondCount > 0, 'expected at least one sampled pond site');
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

test('surviv runtime reset clears old arena state and caches', () => {
    const room = makeRoom();
    room.players.push({ id: 'old-player' });
    room.bots.push({ id: 'old-bot' });
    room.bullets.push({ id: 'old-bullet' });
    room.spectators.push({ id: 'old-spectator' });
    room.deathMarkers = [{ id: 'old-grave' }];
    room.lootPoolBalance = 5;
    room._survivObstacleIndex = { stale: true };
    room._survivLootIndex = { stale: true };
    room._survivViewerPayloadCache = new Map([['viewer', { stale: true }]]);
    room._survivLeaderboardSignature = 'stale';
    room._lastSurvivLbAt = 123;
    room._nextSurvivBotSyncAt = 456;
    const nextMap = {
        loot: [{ id: 'fresh-loot' }],
        obstacles: [{ id: 'fresh-obstacle' }],
        spawnPoints: [{ x: 1, y: 2 }],
        landmarks: [{ id: 'fresh-landmark' }],
    };

    resetSurvivRoomRuntime(room, nextMap);

    assert.deepEqual(room.players, []);
    assert.deepEqual(room.bots, []);
    assert.deepEqual(room.bullets, []);
    assert.deepEqual(room.spectators, []);
    assert.deepEqual(room.deathMarkers, []);
    assert.equal(room.lootPoolBalance, 0);
    assert.equal(room.loot[0].id, 'fresh-loot');
    assert.equal(room.obstacles[0].id, 'fresh-obstacle');
    assert.equal(room._survivObstacleIndex, null);
    assert.equal(room._survivLootIndex, null);
    assert.equal(room._survivViewerPayloadCache.size, 0);
    assert.equal(room._nextSurvivBotSyncAt, 0);
});
test('surviv economy conserves the full entry and applies only the cashout fee', () => {
    const economy = getSurvivEconomy(5);
    assert.equal(economy.entryFeeUsd, 5);
    assert.equal(economy.playerStartBalance, 0);
    assert.equal(economy.lootPoolOnJoin, 5);
    assert.equal(economy.cashoutFeePct, 0.035);
    assert.equal(economy.cashoutPlayerPct + economy.cashoutFeePct, 1);
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

test('surviv roads expose clean crossing and T-junction surfaces', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const roads = map.obstacles.filter(obstacle => obstacle.kind === 'road' && obstacle.role === 'networkRoad');
    const horizontalRoads = roads.filter(road => road.w > road.h);
    const verticalRoads = roads.filter(road => road.h > road.w);
    const junctions = map.obstacles.filter(obstacle => obstacle.kind === 'roadJunction');

    assert.ok(junctions.length >= 15);
    assert.ok(junctions.filter(junction => junction.role === 'crossIntersection').length >= 4);
    assert.ok(junctions.filter(junction => junction.role === 'tIntersection').length >= 8);
    for (const junction of junctions) {
        assert.equal(junction.collidable, false);
        assert.equal(junction.variant, 'asphalt');
        assert.ok(horizontalRoads.some(road => pointInRect(junction.x, junction.y, road, 2)));
        assert.ok(verticalRoads.some(road => pointInRect(junction.x, junction.y, road, 2)));
    }
});

test('surviv adds curved trails and varied natural detail without another building pass', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const trails = map.obstacles.filter(obstacle => obstacle.kind === 'trail_path');
    const naturalKinds = new Set(['bush', 'grassTuft', 'wildflowers', 'reeds', 'stump', 'fallenLog', 'mushrooms', 'signpost']);
    const naturalDetails = map.obstacles.filter(obstacle => naturalKinds.has(obstacle.kind));
    const bushVariants = new Set(map.obstacles
        .filter(obstacle => obstacle.kind === 'bush' && obstacle.variant)
        .map(obstacle => obstacle.variant));

    assert.equal(trails.length, 11);
    assert.ok(trails.every(trail => trail.collidable === false));
    assert.ok(trails.every(trail => trail.points.length >= 5 && trail.width >= 48));
    assert.ok(trails.some(trail => trail.variant === 'boardwalk'));
    assert.ok(trails.some(trail => trail.variant === 'forest'));
    assert.ok(trails.some(trail => trail.variant === 'gravel'));
    assert.ok(naturalDetails.length >= 550);
    assert.ok(bushVariants.has('bramble'));
    assert.ok(bushVariants.has('berry'));
    assert.ok(bushVariants.has('flowering'));
    assert.ok(bushVariants.has('juniper'));
    assert.ok(map.obstacles.some(obstacle => obstacle.kind === 'hayBale'));
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
    assert.equal(riverPath.points.length, 21);
    assert.ok(riverPath.width >= 210 && riverPath.width <= 270);
    assert.equal(riverPath.widths.length, riverPath.points.length);
    assert.ok(Math.max(...riverPath.widths) - Math.min(...riverPath.widths) > riverPath.width * 0.1);
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

test('ground weapons fill empty slot first without swapping', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    const player = createSurvivPlayer('human-weapons-fill', 'mongo-weapons-fill', 'One Slot', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inventory.weapons = ['pistol'];
    player.weapon = { type: 'pistol', ammo: 7, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.weaponsAmmo = { pistol: 7 };
    room.players.push(player);
    room.loot.push({ id: 'loot-shotgun', type: 'weapon', x: 0, y: 0, weaponType: 'shotgun', pickupAfter: 0 });

    player.pickupWeaponPending = true;
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    
    assert.deepEqual(player.inventory.weapons, ['pistol', 'shotgun']);
    assert.equal(player.weapon.type, 'shotgun');
    assert.equal(player.weaponsAmmo.pistol, 7);
    assert.ok(!room.loot.some(item => item.weaponType === 'pistol'), 'pistol should NOT be on the ground');
});

test('players can carry two identical guns with independent magazines', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    const player = createSurvivPlayer('human-duplicates', 'mongo-duplicates', 'Double Pistols', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inventory.weapons = ['pistol'];
    player.activeWeaponSlot = 0;
    player.weaponSlotAmmo = [7];
    player.weapon = { type: 'pistol', ammo: 7, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    room.players.push(player);
    room.loot.push({ id: 'loot-second-pistol', type: 'weapon', x: 0, y: 0, weaponType: 'pistol', ammo: 3, pickupAfter: 0 });

    player.pickupWeaponPending = true;
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.deepEqual(player.inventory.weapons, ['pistol', 'pistol']);
    assert.equal(player.activeWeaponSlot, 1);
    assert.equal(player.weapon.ammo, 3);

    assert.equal(equipSurvivWeaponSlot(player, 0), true);
    assert.equal(player.weapon.ammo, 7);
    player.weapon.ammo = 5;
    assert.equal(equipSurvivWeaponSlot(player, 1), true);
    assert.equal(player.weapon.ammo, 3);
    assert.deepEqual(player.weaponSlotAmmo, [5, 3]);
});
test('the dedicated melee slot stays available and G drops the held gun', () => {
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

    assert.equal(equipSurvivWeaponSlot(player, 1), false);
    assert.equal(equipSurvivWeaponSlot(player, 2), true);
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

test('holding a chest open drops every item onto the ground after two seconds', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('human-hold-chest', 'mongo-hold-chest', 'Opener', '#fff', room);
    player.x = 0;
    player.y = 0;
    room.players.push(player);
    room.loot.push({
        id: 'hold-chest',
        type: 'chest',
        x: 0,
        y: 0,
        tier: 'rare',
        contents: {
            weaponType: 'shotgun',
            ammo: 3,
            money: 1.25,
            medkits: 2,
            ammoType: '12g',
            ammoAmount: 8,
            grenades: 1,
            armor: 35,
            rarity: 'rare',
        },
    });

    player.chestHoldId = 'hold-chest';
    player.chestHoldStartedAt = Date.now() - 2100;
    player.chestHoldSeenAt = Date.now();
    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(room.loot.some(item => item.id === 'hold-chest'), false);
    assert.deepEqual(new Set(room.loot.map(item => item.type)), new Set([
        'weapon', 'money', 'medkit', 'ammo', 'grenade', 'armor',
    ]));
    assert.ok(room.loot.every(item => item.source === 'chest'));
    assert.ok(room.loot.every(item => item.spawnX === 0 && item.spawnY === 0));
    assert.ok(room.loot.every(item => Number.isFinite(item.spawnedAt)));
    assert.ok(room.loot.every(item => item.pickupAfter - item.spawnedAt === 700));
    assert.deepEqual(room.loot.map(item => item.burstIndex).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
    assert.ok(room.loot.every(item => item.burstCount === 6));
    assert.equal(room.loot.find(item => item.type === 'weapon')?.ammo, 3);
    assert.equal(room.loot.find(item => item.type === 'money')?.dollarValue, 1.25);
    assert.equal(room.loot.find(item => item.type === 'medkit')?.amount, 2);
    assert.equal(player.inventory.chestsOpened, 1);
    assert.equal(player.openedContainer, null);
});

test('indoor chest drops stay inside the house when opened beside a corner', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [
        { id: 'corner-house', kind: 'houseFloor', x: 0, y: 0, w: 200, h: 200, rotation: 0, collidable: false },
        { id: 'corner-room', kind: 'roomZone', x: 0, y: 0, w: 200, h: 200, rotation: 0, collidable: false, houseId: 'corner-house', variant: 'main' },
    ];
    const player = createSurvivPlayer('corner-opener', 'mongo-corner-opener', 'Corner Opener', '#fff', room);
    player.x = 72;
    player.y = 72;
    room.players.push(player);
    room.loot.push({
        id: 'corner-chest',
        type: 'chest',
        x: 84,
        y: 84,
        tier: 'rare',
        houseId: 'corner-house',
        room: 'main',
        contents: {
            weaponType: 'shotgun',
            ammo: 3,
            money: 1,
            medkits: 1,
            ammoType: '12g',
            ammoAmount: 8,
            grenades: 1,
            armor: 35,
        },
    });

    player.chestHoldId = 'corner-chest';
    player.chestHoldStartedAt = Date.now() - 2100;
    player.chestHoldSeenAt = Date.now();
    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(room.loot.length, 6);
    assert.ok(room.loot.every(item => Math.abs(item.x) <= 78 && Math.abs(item.y) <= 78));
    assert.ok(room.loot.every(item => item.houseId === 'corner-house' && item.room === 'main'));
});
test('chests ignore legacy inventory transfer requests', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    const player = createSurvivPlayer('human-no-chest-inventory', 'mongo-no-chest-inventory', 'Pack Rat', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inventory.medkits = 2;
    room.players.push(player);
    const chest = {
        id: 'closed-chest',
        type: 'chest',
        x: 0,
        y: 0,
        contents: { medkits: 4, weaponType: 'shotgun', rarity: 'rare' },
    };
    room.loot.push(chest);

    player.takeChestItem = { chestId: chest.id, itemKey: 'medkits' };
    player.putChestItem = { chestId: chest.id, itemKey: 'medkits' };
    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(player.inventory.medkits, 2);
    assert.equal(chest.contents.medkits, 4);
    assert.equal(chest.contents.weaponType, 'shotgun');
    assert.equal(player.openedContainer, null);
});
test('players and automatic bots start with fists and no dollars', () => {
    const room = makeRoom();
    const player = createSurvivPlayer('human-1', 'mongo-1', 'Tester', '#fff', room);
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(player.weapon.type, 'fists');
    assert.deepEqual(player.inventory.weapons, []);
    assert.equal(player.dollarBalance, 0);
    assert.equal(room.bots.length, 2);
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
    victim.inventory.ammoReserves = { '9mm': 60, '12g': 0, '556': 0, '762': 0 };
    player.aimAngle = 0;
    player.shooting = true;

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    const deathDrops = room.loot.filter(item => item.source === 'death');
    assert.ok(deathDrops.some(item => item.type === 'money' && item.dollarValue === 2));
    assert.ok(deathDrops.some(item => item.type === 'weapon' && item.weaponType === 'smg'));
    assert.ok(deathDrops.some(item => item.type === 'medkit' && item.amount === 1));
    assert.ok(deathDrops.some(item => item.type === 'ammo' && item.ammoType === '9mm' && item.amount === 60));
    assert.ok(deathDrops.some(item => item.type === 'armor' && item.armorValue > 0));
    assert.equal(room.loot.some(item => item.type === 'deathCrate'), false);
});
test('manual reload consumes only the matching caliber and only the missing rounds', () => {
    const fullWeapon = {
        weapon: { type: 'smg', ammo: 30, reloading: false, reloadEndAt: 0 },
        inventory: { weapons: ['smg'], medkits: 0, ammoReserves: { '9mm': 30, '12g': 0, '556': 0, '762': 0 }, chestsOpened: 0 },
    };
    assert.equal(beginSurvivReload(fullWeapon, 1000), false);
    assert.equal(fullWeapon.weapon.reloading, false);
    assert.equal(fullWeapon.inventory.ammoReserves['9mm'], 30);

    const noReserve = {
        weapon: { type: 'smg', ammo: 11, reloading: false, reloadEndAt: 0 },
        inventory: { weapons: ['smg'], medkits: 0, ammoReserves: { '9mm': 0, '12g': 30, '556': 0, '762': 0 }, chestsOpened: 0 },
    };
    assert.equal(beginSurvivReload(noReserve, 1000), false);
    assert.equal(noReserve.weapon.reloading, false);

    const partialWeapon = {
        weapon: { type: 'smg', ammo: 11, reloading: false, reloadEndAt: 0 },
        inventory: { weapons: ['smg'], medkits: 0, ammoReserves: { '9mm': 12, '12g': 30, '556': 0, '762': 0 }, chestsOpened: 0 },
    };
    assert.equal(beginSurvivReload(partialWeapon, 1000), true);
    assert.equal(partialWeapon.weapon.reloading, true);
    assert.equal(partialWeapon.weapon.reloadEndAt, 2800);
    assert.equal(partialWeapon.weapon.reloadAmount, 12);
    assert.equal(partialWeapon.inventory.ammoReserves['9mm'], 0);
    assert.equal(partialWeapon.inventory.ammoReserves['12g'], 30);

    assert.equal(beginSurvivReload(partialWeapon, 1500), false);
    assert.equal(partialWeapon.inventory.ammoReserves['9mm'], 0);

    const fists = {
        weapon: { type: 'fists', ammo: 0, reloading: false, reloadEndAt: 0 },
        inventory: { weapons: [], medkits: 0, ammoReserves: { '9mm': 30, '12g': 0, '556': 0, '762': 0 }, chestsOpened: 0 },
    };
    assert.equal(beginSurvivReload(fists, 1000), false);
    assert.equal(fists.inventory.ammoReserves['9mm'], 30);
});

test('ground loot creates a pickup summary for the player', () => {
    const room = makeRoom();
    const player = createSurvivPlayer('human-loot', 'mongo-loot', 'Collector', '#fff', room);
    room.players.push(player);
    room.loot = [
        { id: 'ammo-drop', type: 'ammo', ammoType: '762', x: player.x, y: player.y, amount: 15, tier: 'common' },
        { id: 'medkit-drop', type: 'medkit', x: player.x, y: player.y, amount: 1, tier: 'rare' },
    ];

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(player.inventory.ammoReserves['762'], 15);
    assert.equal(player.inventory.medkits, 1);
    assert.equal(player.lastLoot.source, 'ground');
    assert.equal(player.lastLoot.items.ammoType, '762');
    assert.equal(player.lastLoot.items.ammoAmount, 15);
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

test('grenades follow crosshair distance within the server range limit', () => {
    const makeThrow = (aimDistance) => {
        const room = makeRoom();
        room.obstacles = [];
        room.loot = [];
        room.spawnPoints = [];
        room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
        const player = createSurvivPlayer('grenade-' + aimDistance, 'mongo-grenade-' + aimDistance, 'Grenadier', '#fff', room);
        player.x = 0;
        player.y = 0;
        player.aimAngle = 0;
        player.aimDistance = aimDistance;
        player.inventory.grenades = 1;
        player.throwGrenadePending = true;
        room.players.push(player);
        processSurvivRoom(room, silentIo, Date.now() + 600000);
        return room.bullets.find(bullet => bullet.isGrenade);
    };

    const shortThrow = makeThrow(90);
    const longThrow = makeThrow(360);
    const cappedThrow = makeThrow(5000);

    assert.equal(shortThrow?.throwDistance, 90);
    assert.equal(longThrow?.throwDistance, 360);
    assert.equal(cappedThrow?.throwDistance, SURVIV.grenadeMaxRange);
    assert.ok(Math.hypot(shortThrow.vx, shortThrow.vy) < Math.hypot(longThrow.vx, longThrow.vy));
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
    const grave = room.deathMarkers?.find(marker => marker.victimId === bot.id);
    assert.ok(grave, 'eliminations should create a synchronized grave marker');
    assert.equal(grave.killerId, player.id);
});

test('firearm range depends on travelled distance instead of delayed wall-clock ticks', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room.bots = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('lag-range-shot', 'lag-range-mongo', 'Lag Proof', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.weapon = { type: 'pistol', ammo: 15, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.inventory.weapons = ['pistol'];
    player.shooting = true;
    room.players.push(player);

    const firedAt = Date.now() + 600000;
    processSurvivRoom(room, silentIo, firedAt);
    player.shooting = false;
    assert.equal(room.bullets.length, 1);
    assert.equal(room.bullets[0].maxDistance, WEAPONS.pistol.range);

    processSurvivRoom(room, silentIo, firedAt + SURVIV.bulletLifetimeMs + 1200);
    assert.equal(room.bullets.length, 1, 'a delayed tick must not expire a barely-travelled bullet');
    assert.ok(room.bullets[0].distanceTravelled > 0 && room.bullets[0].distanceTravelled < 100);
});
test('firearms retain enough range to damage destructible trees', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room.obstacles = [{
        id: 'tree-shot', kind: 'tree', x: 68, y: 0, w: 46, h: 46,
        collidable: true, destructible: true, hp: 84, maxHp: 84,
    }];
    const player = createSurvivPlayer('human-tree-shot', 'mongo-tree-shot', 'Lumberjack', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.weapon = { type: 'pistol', ammo: 15, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.inventory.weapons = ['pistol'];
    player.shooting = true;
    room.players.push(player);

    assert.ok(SURVIV.bulletLifetimeMs >= 1600, 'ordinary bullets should have a practical combat range');
    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(room.obstacles[0].hp, 73, 'a pistol round should damage a destructible tree');
});
test('melee attacks destroy weak Surviv obstacles', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room.obstacles = [{
        id: 'breakable-bush', kind: 'bush', x: 48, y: 0, w: 30, h: 30,
        collidable: true, destructible: true, hp: 18, maxHp: 18,
    }];
    const player = createSurvivPlayer('human-melee-prop', 'mongo-melee-prop', 'Chopper', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.shooting = true;
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(room.obstacles.some(obstacle => obstacle.id === 'breakable-bush'), false);
    assert.ok(room._survivObstacleRevision > 0);
});

test('bullets damage and eventually destroy durable Surviv obstacles', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room.obstacles = [{
        id: 'breakable-rock', kind: 'rock', x: 68, y: 0, w: 34, h: 34,
        collidable: true, destructible: true, hp: 60, maxHp: 60,
    }];
    const player = createSurvivPlayer('human-prop-shot', 'mongo-prop-shot', 'Miner', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.weapon = { type: 'sniper', ammo: 5, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.inventory.weapons = ['sniper'];
    player.shooting = true;
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.equal(room.obstacles[0].hp, 12, 'the first shot should chip the rock');

    player.weapon.lastShotAt = 0;
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.equal(room.obstacles.some(obstacle => obstacle.id === 'breakable-rock'), false);
});

test('generated cover and small props have server-authoritative durability', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    for (const kind of ['tree', 'rock', 'bush', 'crate', 'barrel']) {
        const obstacle = map.obstacles.find(candidate => candidate.kind === kind && candidate.collidable !== false);
        assert.ok(obstacle, `expected a generated ${kind}`);
        assert.equal(obstacle.destructible, true);
        assert.ok(obstacle.hp > 0);
        assert.equal(obstacle.hp, obstacle.maxHp);
    }
    const breakableBarriers = map.obstacles.filter(obstacle => obstacle.role === 'breakableBarrier');
    assert.ok(breakableBarriers.length >= 80, 'expected segmented outdoor walls and fences');
    assert.ok(breakableBarriers.every(obstacle => (
        obstacle.kind === 'wall'
        && obstacle.destructible
        && obstacle.hp === obstacle.maxHp
        && Math.max(obstacle.w, obstacle.h) <= 120.01
    )));
    const structuralWalls = map.obstacles.filter(obstacle => (
        (obstacle.kind === 'wall' || obstacle.kind === 'interiorWall')
        && obstacle.role !== 'breakableBarrier'
    ));
    assert.ok(structuralWalls.length > 0);
    assert.ok(structuralWalls.every(obstacle => !obstacle.destructible), 'house walls must stay indestructible');
});

test('rotated props use their visible shape for bullet collision', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room.bots = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [{
        id: 'rotated-container', kind: 'container', x: 100, y: 0, w: 120, h: 30,
        rotation: Math.PI / 2, collidable: true, destructible: false,
    }];
    const player = createSurvivPlayer('rotation-shot', 'rotation-mongo', 'Rotation', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.weapon = { type: 'sniper', ammo: 5, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.inventory.weapons = ['sniper'];
    player.shooting = true;
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.equal(room.bullets.length, 1, 'the round must not hit the invisible unrotated bounds');

    player.shooting = false;
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.equal(room.bullets.length, 0, 'the next segment should hit the visible rotated container');
});

test('surviv bots prioritize useful chests and loot their contents', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [
        { id: 'near-medkit', type: 'medkit', x: 0, y: 80, amount: 1, tier: 'common' },
        { id: 'priority-chest', type: 'chest', x: 120, y: 0, tier: 'rare', contents: { weaponType: 'assault', money: 1, rarity: 'rare' } },
    ];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('loot-observer', 'loot-observer-mongo', 'Observer', '#fff', room);
    player.x = 1800;
    player.y = 1800;
    room.players.push(player);
    const bot = spawnSurvivBotNear(room, 0, 0, { adminSpawned: true });

    for (let tick = 0; tick < 12; tick++) {
        bot.botThinkAt = 0;
        processSurvivRoom(room, silentIo, Date.now() + 600000);
    }
    bot.x = 120;
    bot.y = 0;
    bot.chestHoldStartedAt = Date.now() - 2100;
    bot.botThinkAt = 0;
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    for (const item of room.loot) item.pickupAfter = 0;
    for (let tick = 0; tick < 32; tick++) {
        bot.botThinkAt = 0;
        processSurvivRoom(room, silentIo, Date.now() + 600000);
    }

    assert.ok(bot.inventory.weapons.includes('assault'), 'bot should open and pick up the dropped chest weapon');
    assert.ok(bot.dollarBalance >= 1, 'bot should continue looting money from the opened chest');
});

test('armed surviv bots aggressively engage and lead distant players', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('combat-target', 'combat-target-mongo', 'Target', '#fff', room);
    player.x = 760;
    player.y = 0;
    player.inputDy = 1;
    room.players.push(player);
    const bot = spawnSurvivBotNear(room, 0, 0, { adminSpawned: true });
    bot.inventory.weapons = ['assault'];
    bot.activeWeaponSlot = 0;
    bot.weaponSlotAmmo = [22];
    bot.weapon = { type: 'assault', ammo: 22, reloading: false, reloadEndAt: 0, lastShotAt: 0 };

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(bot.botTargetId, player.id);
    assert.ok(bot.inputDx > 0.8, 'bot should push toward a distant target');
    assert.ok(bot.aimAngle > 0, 'bot should lead the moving target instead of aiming at the old position');
    assert.ok(room.bullets.some(bullet => bullet.ownerId === bot.id), 'bot should fire at combat range');
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
    room.loot.push({
        id: 'animated-chest-drop',
        type: 'weapon',
        weaponType: 'shotgun',
        x: 42,
        y: -1500,
        source: 'chest',
        spawnedAt: Date.now(),
        spawnX: 0,
        spawnY: -1500,
        burstIndex: 0,
        burstCount: 2,
    });
    room._survivLootRevision = (room._survivLootRevision || 0) + 1;
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
    const animatedDrop = ticks[0].loot.find(item => item.id === 'animated-chest-drop');
    assert.ok(animatedDrop);
    assert.equal(animatedDrop.spawnX, 0);
    assert.equal(animatedDrop.spawnY, -1500);
    assert.equal(animatedDrop.burstIndex, 0);
    assert.equal(animatedDrop.burstCount, 2);
    assert.ok(animatedDrop.burstRemainingMs > 0 && animatedDrop.burstRemainingMs <= 700);
    const serializedRiver = ticks[0].obstacles.find(obstacle => obstacle.kind === 'river_path');
    assert.ok(serializedRiver);
    assert.equal(serializedRiver.points.length, 21);
    assert.equal(serializedRiver.widths.length, serializedRiver.points.length);
    assert.ok(serializedRiver.width >= 210);
    assert.equal(Object.hasOwn(ticks[1], 'obstacles'), false);
    assert.equal(Object.hasOwn(ticks[1], 'minimap'), false);
    assert.ok(Array.isArray(ticks[1].players));
    assert.equal(ticks[1].you.id, player.id);
    assert.equal(ticks[1].players.some(other => other.id === player.id), false);
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

    assert.equal(lbData.aliveCount, 3);
    assert.deepEqual(
        new Set(lbData.leaderboard.map(entry => entry.id)),
        new Set([active.id, disconnected.id, liveBot.id]),
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


test('safe zone covers the map before shrinking and closes before reset', () => {
    const resetAt = 1_000_000;
    const beforeShrink = getSurvivZone(resetAt, resetAt - SURVIV.shrinkBeforeResetMs - 1);
    const halfway = getSurvivZone(resetAt, resetAt - SURVIV.shrinkBeforeResetMs / 2);
    const closed = getSurvivZone(resetAt, resetAt);

    assert.ok(beforeShrink.radius > Math.SQRT2 * SURVIV.worldHalf);
    assert.equal(beforeShrink.progress, 0);
    assert.ok(halfway.radius < beforeShrink.radius);
    assert.ok(halfway.radius > SURVIV.minZoneRadius);
    assert.equal(closed.radius, SURVIV.minZoneRadius);
    assert.equal(closed.progress, 1);
});

test('players outside the safe zone take server-authoritative damage', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('outside-zone', 'outside-zone-mongo', 'Runner', '#fff', room);
    player.x = SURVIV.worldHalf - 100;
    player.y = 0;
    player._lastZoneDamageAt = Date.now() - 250;
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now());

    assert.equal(player.outsideZone, true);
    assert.ok(player.hp < 100);
});

test('a player in front of a wall is hit before the wall behind them', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [{
        id: 'wall-behind-target', kind: 'wall', x: 95, y: 0, w: 12, h: 100,
        collidable: true, destructible: true, hp: 100, maxHp: 100,
    }];
    const shooter = createSurvivPlayer('ordered-shot', 'ordered-shot-mongo', 'Shooter', '#fff', room);
    shooter.x = 0;
    shooter.y = 0;
    shooter.aimAngle = 0;
    shooter.weapon = { type: 'sniper', ammo: 5, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    shooter.inventory.weapons = ['sniper'];
    shooter.activeWeaponSlot = 0;
    shooter.shooting = true;
    room.players.push(shooter);
    const target = spawnSurvivBotNear(room, 58, 0, { adminSpawned: true });
    target.botThinkAt = Number.POSITIVE_INFINITY;

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.ok(target.hp < 100);
    assert.equal(room.obstacles[0].hp, 100);
});

test('a wall in front of a player blocks the shot', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [{
        id: 'wall-before-target', kind: 'wall', x: 48, y: 0, w: 12, h: 100,
        collidable: true, destructible: true, hp: 100, maxHp: 100,
    }];
    const shooter = createSurvivPlayer('blocked-shot', 'blocked-shot-mongo', 'Shooter', '#fff', room);
    shooter.x = 0;
    shooter.y = 0;
    shooter.aimAngle = 0;
    shooter.weapon = { type: 'sniper', ammo: 5, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    shooter.inventory.weapons = ['sniper'];
    shooter.activeWeaponSlot = 0;
    shooter.shooting = true;
    room.players.push(shooter);
    const target = spawnSurvivBotNear(room, 90, 0, { adminSpawned: true });
    target.botThinkAt = Number.POSITIVE_INFINITY;

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(target.hp, 100);
    assert.ok(room.obstacles[0].hp < 100);
});
