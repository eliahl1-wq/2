import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SURVIV,
    SURVIV_AMMO,
    WEAPONS,
    applySurvivFireInput,
    beginSurvivReload,
    broadcastSurvivState,
    createSurvivPlayer,
    eliminateSurvivPlayer,
    equipSurvivWeaponSlot,
    generateSurvivMap,
    getSurvivDoorCollisionRect,
    getSurvivZone,
    processSurvivRoom,
    resetSurvivRoomRuntime,
    spawnLootFromPool,
    spawnSurvivBotNear,
    toggleSurvivDoor,
} from './surviv-engine.js';
import { getSurvivEconomy, getSurvivJoinLootFunding } from './economy.js';

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

function rotatedRectCorners(rect) {
    const angle = Number(rect.rotation) || 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const halfW = rect.w / 2;
    const halfH = rect.h / 2;
    return [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]]
        .map(([x, y]) => ({
            x: rect.x + x * cos - y * sin,
            y: rect.y + x * sin + y * cos,
        }));
}

function rotatedRectsOverlap(first, second) {
    const firstCorners = rotatedRectCorners(first);
    const secondCorners = rotatedRectCorners(second);
    const axes = [];
    for (const corners of [firstCorners, secondCorners]) {
        for (let index = 0; index < 2; index++) {
            const start = corners[index];
            const end = corners[(index + 1) % corners.length];
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const length = Math.max(0.0001, Math.hypot(dx, dy));
            axes.push({ x: -dy / length, y: dx / length });
        }
    }
    return axes.every(axis => {
        const firstProjection = firstCorners.map(point => point.x * axis.x + point.y * axis.y);
        const secondProjection = secondCorners.map(point => point.x * axis.x + point.y * axis.y);
        return Math.max(...firstProjection) >= Math.min(...secondProjection)
            && Math.max(...secondProjection) >= Math.min(...firstProjection);
    });
}

function pointInRect(x, y, rect, padding = 0) {
    return x >= rect.x - rect.w / 2 - padding
        && x <= rect.x + rect.w / 2 + padding
        && y >= rect.y - rect.h / 2 - padding
        && y <= rect.y + rect.h / 2 + padding;
}

function pointInHouseFootprint(x, y, house) {
    if (!Array.isArray(house.footprint) || house.footprint.length < 3) return pointInRect(x, y, house);
    const localX = x - house.x;
    const localY = y - house.y;
    let inside = false;
    for (let i = 0, j = house.footprint.length - 1; i < house.footprint.length; j = i++) {
        const a = house.footprint[i];
        const b = house.footprint[j];
        if ((a.y > localY) !== (b.y > localY)
            && localX < (b.x - a.x) * (localY - a.y) / ((b.y - a.y) || 1e-9) + a.x) inside = !inside;
    }
    return inside;
}

function pointToRectDistance(x, y, rect) {
    const angle = -(Number(rect.rotation) || 0);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = x - rect.x;
    const dy = y - rect.y;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const outsideX = Math.max(0, Math.abs(localX) - rect.w / 2);
    const outsideY = Math.max(0, Math.abs(localY) - rect.h / 2);
    return Math.hypot(outsideX, outsideY);
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

function obstacleCollisionRectForTest(obstacle) {
    if (obstacle.kind === 'door') return getSurvivDoorCollisionRect(obstacle);
    const visualW = Math.abs(Number(obstacle.w) || 0);
    const visualH = Math.abs(Number(obstacle.h) || 0);
    let hitboxW = Number(obstacle.hitboxW) > 0 ? Number(obstacle.hitboxW) : null;
    let hitboxH = Number(obstacle.hitboxH) > 0 ? Number(obstacle.hitboxH) : null;
    if (obstacle.kind === 'tree') {
        const fallbackScale = Number(obstacle.trunkScale) > 0
            ? Number(obstacle.trunkScale)
            : Math.max(visualW, visualH) >= 64 ? 0.31 : 0.255;
        hitboxW ??= Math.max(11, visualW * fallbackScale);
        hitboxH ??= Math.max(11, visualH * fallbackScale);
    }
    if (hitboxW == null && hitboxH == null) return obstacle;
    return {
        ...obstacle,
        w: Math.max(1, Math.min(hitboxW ?? visualW, visualW)),
        h: Math.max(1, Math.min(hitboxH ?? visualH, visualH)),
    };
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
    assert.equal(map.landmarks.length, 34);
    assert.ok(houses.length >= 178 && houses.length <= 188,
        `expected a deliberate building budget, got ${houses.length}`);
    assert.ok(chests.length < houses.length);
    assert.deepEqual(new Set(chests.map(item => item.containerType)), new Set([
        'wood_crate', 'supply_crate', 'ammo_crate', 'medical_crate', 'armory_crate',
    ]));
    assert.ok(chests.every(item => item.hp > 0 && item.hp === item.maxHp && item.hitRadius > 0));
    assert.equal(groundLoot.length, 22);
    for (const item of groundLoot) {
        const floor = houses.find(house => house.id === item.houseId);
        assert.ok(floor, 'loose map loot should belong to a building');
        assert.equal(item.location, 'interior');
        assert.ok(pointInRect(item.x, item.y, floor, -18));
    }
    assert.ok(maxExtent <= SURVIV.worldHalf);
});

test('prison cell blocks use a purpose-built four-cell plan facing the yard', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const blocks = map.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor'
        && obstacle.landmarkType === 'prison'
        && obstacle.role === 'cellBlock'
    ));

    assert.equal(blocks.length, 4);
    assert.equal(blocks.filter(block => block.orientation === 'north').length, 2);
    assert.equal(blocks.filter(block => block.orientation === 'south').length, 2);

    for (const block of blocks) {
        const contents = map.obstacles.filter(obstacle => obstacle.houseId === block.id);
        const rooms = contents.filter(obstacle => obstacle.kind === 'roomZone');
        const doors = contents.filter(obstacle => obstacle.kind === 'door');
        const furniture = contents.filter(obstacle => obstacle.kind === 'furniture');
        const roomTypes = rooms.map(room => room.variant);
        const furnitureTypes = furniture.map(prop => prop.variant);
        const blockChests = map.loot.filter(item => item.type === 'chest' && item.houseId === block.id);

        assert.equal(block.variant, 'prisonBlock');
        assert.deepEqual([block.w, block.h], [360, 460]);
        assert.equal(roomTypes.filter(type => type === 'cell').length, 4);
        assert.equal(roomTypes.filter(type => type === 'cell-corridor').length, 1);
        assert.equal(roomTypes.filter(type => type === 'intake').length, 1);
        assert.equal(roomTypes.some(type => ['bedroom', 'kitchen', 'living-room', 'study'].includes(type)), false);
        assert.equal(doors.length, 6, 'cell block should have one entrance, one security door, and four cell doors');
        assert.equal(doors.filter(door => door.entranceRole === 'mainEntrance').length, 1);
        assert.equal(doors.filter(door => door.entranceRole === 'interiorDoor').length, 5);
        assert.equal(furnitureTypes.filter(type => type === 'bunkBed').length, 4);
        assert.equal(furnitureTypes.filter(type => type === 'toilet').length, 4);
        assert.ok(furnitureTypes.includes('prisonBench'));
        assert.ok(furnitureTypes.includes('controlConsole'));
        assert.equal(blockChests.length, 1);
        assert.ok(contents.every(obstacle => obstacle.kind === 'roomZone' || pointInRect(
            obstacle.x, obstacle.y, block, obstacle.kind === 'door' ? 3 : 0,
        )), 'cell-block geometry must stay attached to its floor');
    }
});

test('estate manor uses a purpose-built courtyard loop instead of the generic four-room corridor', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const manor = map.obstacles.find(obstacle => (
        obstacle.kind === 'houseFloor'
        && obstacle.variant === 'mansion'
        && obstacle.landmarkType === 'estate'
        && obstacle.role === 'mainBuilding'
    ));

    assert.ok(manor);
    assert.deepEqual([manor.w, manor.h], [760, 560]);
    const contents = map.obstacles.filter(obstacle => obstacle.houseId === manor.id);
    const rooms = contents.filter(obstacle => obstacle.kind === 'roomZone');
    const roomTypes = rooms.map(room => room.variant);
    const doors = contents.filter(obstacle => obstacle.kind === 'door');
    const interiorWalls = contents.filter(obstacle => obstacle.kind === 'interiorWall');
    const manorChests = map.loot.filter(item => item.type === 'chest' && item.houseId === manor.id);

    assert.equal(rooms.length, 7);
    assert.deepEqual(new Set(roomTypes), new Set([
        'hallway', 'study', 'courtyard', 'living-room', 'bedroom', 'kitchen',
    ]));
    assert.equal(roomTypes.filter(type => type === 'courtyard').length, 1);
    assert.equal(doors.filter(door => door.entranceRole !== 'interiorDoor').length, 3);
    assert.deepEqual(new Set(doors
        .filter(door => door.entranceRole !== 'interiorDoor')
        .map(door => door.entranceRole)), new Set(['mainEntrance', 'gardenEntrance', 'serviceEntrance']));
    assert.ok(interiorWalls.every(wall => Math.max(wall.w, wall.h) <= 210),
        'manor should not recreate a long uninterrupted central corridor wall');
    assert.equal(manorChests.length, 2);
    assert.ok(contents.some(obstacle => obstacle.kind === 'furniture' && obstacle.role === 'winterGardenPlanter'));
});

test('larger residential layer adds twenty distinct detailed homes across ten real blueprints', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const homes = map.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor'
        && obstacle.role === 'largeResidence'
        && obstacle.landmarkType === 'residential'
    ));
    const homeIds = new Set(homes.map(home => home.id));
    const rooms = map.obstacles.filter(obstacle => obstacle.kind === 'roomZone' && homeIds.has(obstacle.houseId));
    const doors = map.obstacles.filter(obstacle => obstacle.kind === 'door' && homeIds.has(obstacle.houseId));
    const furniture = map.obstacles.filter(obstacle => obstacle.kind === 'furniture' && homeIds.has(obstacle.houseId));
    const drives = map.obstacles.filter(obstacle => obstacle.role === 'residentialDrive' && homeIds.has(obstacle.houseId));
    const mailboxes = map.obstacles.filter(obstacle => obstacle.role === 'residenceMailbox' && homeIds.has(obstacle.houseId));
    const gardens = map.obstacles.filter(obstacle => obstacle.role === 'residenceGarden' && homeIds.has(obstacle.houseId));
    const chests = map.loot.filter(item => item.type === 'chest' && homeIds.has(item.houseId));

    assert.equal(homes.length, 20);
    assert.equal(new Set(homes.map(home => home.blueprint)).size, 10);
    assert.equal(new Set(homes.map(home => home.designId)).size, 20);
    assert.equal(new Set(homes.map(home => home.variant)).size, 10);
    assert.ok(homes.every(home => home.w >= 480 && home.h >= 360));
    const lHomes = homes.filter(home => home.footprint?.length === 6);
    assert.equal(lHomes.length, 6, 'three mirrored blueprint pairs should have real L-shaped footprints');
    assert.ok(homes.filter(home => Math.max(home.w, home.h) / Math.min(home.w, home.h) >= 1.2).length >= 16,
        'most new homes should read as rectangles rather than near-square boxes');
    assert.equal(drives.length, 20);
    assert.equal(mailboxes.length, 20);
    assert.equal(gardens.length, 40);
    assert.equal(chests.length, 20);
    assert.ok(furniture.length >= 160, `expected detailed furnishing, got ${furniture.length} pieces`);
    assert.ok(['bathtub', 'vanity', 'wardrobe', 'sideboard', 'entryBench']
        .every(variant => furniture.some(item => item.variant === variant)));

    const layoutSignatures = new Set();
    for (const home of homes) {
        const homeRooms = rooms.filter(room => room.houseId === home.id);
        const homeDoors = doors.filter(door => door.houseId === home.id);
        const homeFurniture = furniture.filter(item => item.houseId === home.id);
        const exteriorDoors = homeDoors.filter(door => door.entranceRole !== 'interiorDoor');
        const interiorDoors = homeDoors.filter(door => door.entranceRole === 'interiorDoor');
        assert.ok(homeRooms.length >= 5);
        assert.equal(exteriorDoors.length, 2);
        assert.ok(interiorDoors.length <= 2, `${home.blueprint} should not overuse interior doors`);
        assert.ok(homeFurniture.length >= 5, `${home.blueprint} should feel intentionally furnished`);
        assert.ok(homeDoors.every(door => pointInRect(door.x, door.y, home, 3)));
        assert.ok(homeRooms.every(room => pointInHouseFootprint(room.x, room.y, home)),
            `${home.blueprint} room centers must stay inside the actual footprint`);
        layoutSignatures.add(home.blueprint + ':' + homeRooms
            .map(room => `${room.variant}@${Math.round((room.x - home.x) / 10)},${Math.round((room.y - home.y) / 10)}`)
            .sort()
            .join('|'));
    }
    assert.ok(layoutSignatures.size >= 10);
});

test('every Surviv house has themed furniture outside every complete door swing', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const houses = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
    const furniture = map.obstacles.filter(obstacle => obstacle.kind === 'furniture');
    const doors = map.obstacles.filter(obstacle => obstacle.kind === 'door');
    const furnishedHouseIds = new Set(furniture.map(obstacle => obstacle.houseId));
    const variants = new Set(furniture.map(obstacle => obstacle.variant));

    assert.ok(houses.every(house => furnishedHouseIds.has(house.id)));
    assert.ok(furniture.every(obstacle => obstacle.houseId && obstacle.roomId));
    assert.ok(furniture.every(obstacle => obstacle.collidable !== false), 'raised furniture must have a physical hitbox');
    assert.ok(furniture.every(obstacle => !['table', 'cabinet', 'machine'].includes(obstacle.variant)));
    for (const expected of [
        'sofa', 'bed', 'kitchenCounter', 'diningTable', 'desk', 'salesCounter',
        'workbench', 'controlConsole', 'hospitalBed', 'storageShelf',
        'floorLamp', 'housePlant', 'generator', 'labBench', 'specimenTank',
        'serverRack', 'weaponRack', 'ammoLocker',
    ]) {
        assert.ok(variants.has(expected), `missing redesigned furniture type ${expected}`);
    }
    assert.ok(furniture.every(obstacle => (
        obstacle.destructible
        && obstacle.hp > 0
        && obstacle.hp === obstacle.maxHp
    )), 'every solid furnishing must have authoritative durability');

    const blockingInteriorProps = map.obstacles.filter(obstacle => (
        obstacle.houseId
        && obstacle.collidable !== false
        && ['furniture', 'machine', 'container', 'crate', 'barrel'].includes(obstacle.kind)
    ));
    assert.ok(blockingInteriorProps.length >= furniture.length);
    assert.ok(blockingInteriorProps.every(obstacle => (
        obstacle.destructible
        && obstacle.hp > 0
        && obstacle.hp === obstacle.maxHp
    )), 'no indoor blocker may become permanent cover or trap a player');

    const labFurniture = furniture.filter(obstacle => obstacle.landmarkType === 'lab');
    assert.ok(['labBench', 'specimenTank', 'serverRack']
        .every(variant => labFurniture.some(obstacle => obstacle.variant === variant)));
    const militaryFurniture = furniture.filter(obstacle => obstacle.landmarkType === 'military');
    assert.ok(['weaponRack', 'ammoLocker']
        .every(variant => militaryFurniture.some(obstacle => obstacle.variant === variant)));

    for (const prop of furniture) {
        const house = houses.find(candidate => candidate.id === prop.houseId);
        assert.ok(house && pointInRect(prop.x, prop.y, house, -12));
        for (const door of doors.filter(candidate => candidate.houseId === prop.houseId)) {
            const horizontal = door.w >= door.h;
            const panelLength = Math.max(door.w, door.h) + 8;
            const clearance = {
                x: door.x,
                y: door.y,
                w: horizontal ? panelLength + 12 : panelLength * 2 + 12,
                h: horizontal ? panelLength * 2 + 12 : panelLength + 12,
            };
            assert.equal(rectsOverlap(
                prop.x, prop.y, prop.w + 8, prop.h + 8,
                clearance.x, clearance.y, clearance.w, clearance.h,
            ), false, `${prop.variant} must stay outside the complete ${door.role} door swing`);
        }
    }
});

test('surviv countryside keeps dense distributed cover and frequent solo rural homes', () => {
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
    const gameplayTreeCells = new Map();
    const allTrees = map.obstacles.filter(obstacle => obstacle.kind === 'tree');
    const survivTrees = allTrees.filter(tree => tree.canopyStyle === 'surviv');
    const legacyTrees = allTrees.filter(tree => tree.canopyStyle === 'legacy');
    const largeTrees = allTrees.filter(tree => tree.treeSize === 'large');
    const giantTrees = allTrees.filter(tree => tree.treeSize === 'giant');
    const insetNaturalKinds = new Set(['rock', 'bush', 'barrel', 'fallenLog', 'stump']);
    const insetNaturalCover = map.obstacles.filter(obstacle => (
        obstacle.collidable !== false && insetNaturalKinds.has(obstacle.kind)
    ));
    const survivTreeCells = new Set();
    for (const tree of allTrees) {
        if (Math.abs(tree.x) >= 9500 || Math.abs(tree.y) >= 9500) continue;
        const key = Math.floor((tree.x + 9500) / 1000)
            + ','
            + Math.floor((tree.y + 9500) / 650);
        gameplayTreeCells.set(key, (gameplayTreeCells.get(key) || 0) + 1);
        if (tree.canopyStyle === 'surviv') survivTreeCells.add(key);
    }
    const gameplayCellCount = 19 * 30;
    const averageTreesPerGameplayCell = [...gameplayTreeCells.values()]
        .reduce((sum, count) => sum + count, 0) / gameplayCellCount;
    const ruralHomes = map.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor'
        && obstacle.role === 'ruralHome'
    ));
    const rotationCover = map.obstacles.filter(obstacle => obstacle.role === 'rotationCover');
    const rotationCells = new Set(rotationCover.map(obstacle => (
        Math.floor((obstacle.x + SURVIV.worldHalf) / 600)
        + ','
        + Math.floor((obstacle.y + SURVIV.worldHalf) / 600)
    )));

    assert.ok(openCover.length >= 5700 && openCover.length <= 6250,
        `expected dense countryside cover across the island, got ${openCover.length}`);
    assert.ok(openTrees.length >= 4500 && openTrees.length <= 4950,
        `expected trees to be common in normal gameplay views, got ${openTrees.length}`);
    assert.ok(coverCells.size >= 90);
    assert.ok(treeCells.size >= 75);
    assert.ok(gameplayTreeCells.size >= 540,
        `trees should reach nearly every gameplay-sized countryside cell, got ${gameplayTreeCells.size}`);
    assert.ok([...gameplayTreeCells.values()].filter(count => count >= 3).length >= 515,
        'most gameplay-sized countryside cells should contain several visible trees');
    assert.ok(averageTreesPerGameplayCell >= 7.4,
        `expected multiple visible trees per desktop-scale cell, got ${averageTreesPerGameplayCell.toFixed(2)}`);
    assert.ok(survivTrees.length / allTrees.length >= 0.72 && survivTrees.length / allTrees.length <= 0.78,
        `roughly three quarters of trees should use the new canopy, got ${survivTrees.length}/${allTrees.length}`);
    assert.ok(legacyTrees.length / allTrees.length >= 0.22 && legacyTrees.length / allTrees.length <= 0.28,
        `roughly one quarter of trees should retain legacy biome art, got ${legacyTrees.length}/${allTrees.length}`);
    assert.ok(largeTrees.length >= 900, `expected frequent larger trees, got ${largeTrees.length}`);
    assert.ok(giantTrees.length >= 28, `expected landmark-scale giant trees, got ${giantTrees.length}`);
    assert.ok(allTrees.every(tree => (
        tree.hitboxW >= 11 && tree.hitboxH >= 11
        && tree.hitboxW < tree.w * 0.56
        && tree.hitboxH < tree.h * 0.56
    )), 'tree collision should cover only the trunk, never the visible canopy');
    assert.ok(survivTrees.every(tree => tree.hitboxW >= 26 && tree.hitboxH >= 26),
        'new tree trunks should be wide enough to function as player-sized combat cover');
    assert.ok(survivTrees.every(tree => tree.trunkScale >= 0.44),
        'new tree art and authoritative collision should share the broader trunk proportions');
    assert.ok(largeTrees.every(tree => tree.trunkScale > 0.255),
        'larger trees should have visibly and physically wider trunks');
    assert.ok(insetNaturalCover.length >= 600,
        `expected broad hitbox coverage for irregular natural props, got ${insetNaturalCover.length}`);
    assert.ok(insetNaturalCover.every(obstacle => (
        Number(obstacle.hitboxW) > 0 && Number(obstacle.hitboxH) > 0
        && obstacle.hitboxW < obstacle.w
        && obstacle.hitboxH < obstacle.h
    )), 'irregular natural props must use an inset hitbox inside their visible bounds');
    assert.ok(survivTreeCells.size >= 520,
        `new tree canopies should appear across nearly the whole playable map, got ${survivTreeCells.size} cells`);
    assert.ok(ruralHomes.length >= 20 && ruralHomes.length <= 27,
        `expected frequent authored solo homes between POIs, got ${ruralHomes.length}`);
    assert.ok(rotationCover.length >= 145 && rotationCover.length <= 190,
        'larger homes may replace a small amount of rotation cover, but the authored cover network should remain dense');
    assert.ok(rotationCells.size >= 62, 'rotation cover should span distinct travel corridors');
    assert.equal(map.obstacles.some(obstacle => obstacle.role === 'gapHouse' || obstacle.role === 'gapCover'), false);
});

test('Surviv map preserves deliberate open combat fields with readable covered edges', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const coverKinds = new Set([
        'houseFloor', 'tree', 'rock', 'bush', 'stump', 'fallenLog',
        'crate', 'barrel', 'container', 'tent', 'sandbag', 'hayBale',
    ]);
    const surfaceKinds = new Set(['road', 'water', 'river', 'houseFloor']);
    const cover = map.obstacles.filter(obstacle => coverKinds.has(obstacle.kind));
    const reservedSurfaces = map.obstacles.filter(obstacle => surfaceKinds.has(obstacle.kind));
    const openAreas = map.obstacles.filter(obstacle => obstacle.role === 'openCombatArea');
    const edgeCover = map.obstacles.filter(obstacle => obstacle.role === 'openAreaEdge');
    const houses = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
    let largestGap = 0;
    let largeGapSamples = 0;

    for (let x = -9000; x <= 9000; x += 600) {
        for (let y = -9000; y <= 9000; y += 600) {
            // Roads, door approaches, and shorelines need clear shoulders for
            // movement and are not unplanned empty countryside.
            if (reservedSurfaces.some(surface => pointToRectDistance(x, y, surface) < 260)) continue;
            const nearestCover = Math.min(...cover.map(obstacle => pointToRectDistance(x, y, obstacle)));
            largestGap = Math.max(largestGap, nearestCover);
            if (nearestCover > 1100) largeGapSamples++;
        }
    }

    assert.equal(openAreas.length, 6);
    assert.equal(new Set(openAreas.map(area => area.label)).size, openAreas.length);
    assert.ok(edgeCover.length >= 40);
    for (const area of openAreas) {
        assert.ok(houses.every(house => !rectsOverlap(
            area.x, area.y, area.w, area.h,
            house.x, house.y, house.w, house.h,
        )), `${area.label} should not contain a building`);
        assert.ok(cover.every(obstacle => !pointInRect(
            obstacle.x, obstacle.y, area, -40,
        )), `${area.label} should keep an uncluttered centre`);
        const nearestCover = Math.min(...cover.map(obstacle => pointToRectDistance(area.x, area.y, obstacle)));
        assert.ok(nearestCover >= 420 && nearestCover <= 650,
            `${area.label} should be open but bounded by usable cover`);
    }
    assert.ok(largestGap < 1500, `largest playable land gap is ${Math.round(largestGap)} units`);
    assert.ok(largeGapSamples <= 8, `too many unexplained sparse land samples: ${largeGapSamples}`);
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
        assert.ok(campProps.length < 240, `west forest camp is too crowded: ${campProps.length} props`);
        assert.ok(campHouses.length <= 4, `west forest camp has too many stacked buildings: ${campHouses.length}`);
    }
    assert.ok(pondCount > 0, 'expected at least one sampled pond site');
});

test('static surviv map loot never creates unfunded money', () => {
    let chestCount = 0;
    const standardWeapons = new Set([
        'm9', 'ot38', 'mac10', 'mp5', 'm870', 'mp220', 'ak47', 'm416',
        'famas', 'vss', 'mosin', 'awms', 'dp28', 'm249', 'm4a1s', 'dualm9', 'knife',
    ]);
    const standardAmmo = new Set(['9mm', '12g', '556', '762', '308']);
    for (let i = 0; i < 8; i++) {
        const map = generateSurvivMap(SURVIV.worldHalf);
        const chests = map.loot.filter(item => item.type === 'chest' && item.source === 'map');
        const weaponTypes = map.loot.flatMap(item => [
            item.type === 'weapon' ? item.weaponType : null,
            item.contents?.weaponType || null,
        ]).filter(Boolean);
        const ammoTypes = map.loot.flatMap(item => [
            item.type === 'ammo' ? item.ammoType : null,
            item.contents?.ammoType || null,
        ]).filter(Boolean);
        chestCount += chests.length;
        assert.ok(chests.every(chest => !(Number(chest.contents?.money) > 0)));
        assert.ok(map.loot.every(item => item.type !== 'money' || !(Number(item.dollarValue) > 0)));
        assert.ok(weaponTypes.every(weaponType => standardWeapons.has(weaponType)), `unexpected normal-match weapon: ${weaponTypes.find(weaponType => !standardWeapons.has(weaponType))}`);
        assert.ok(ammoTypes.every(ammoType => standardAmmo.has(ammoType)), `unexpected normal-match ammo: ${ammoTypes.find(ammoType => !standardAmmo.has(ammoType))}`);
    }

    assert.ok(chestCount > 80);
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
test('surviv economy takes the hidden 5% entry owner cut from map loot', () => {
    const economy = getSurvivEconomy(5);
    assert.equal(economy.entryFeeUsd, 5);
    assert.equal(economy.playerStartBalance, 0);
    assert.equal(economy.entryOwnerCutUsd, 0.25);
    assert.equal(economy.lootPoolOnJoin, 4.75);
    assert.equal(economy.cashoutFeePct, 0.08);
    assert.equal(economy.cashoutPlayerPct + economy.cashoutFeePct, 1);
});
test('admin public Surviv entry contributes no map money', () => {
    assert.equal(getSurvivJoinLootFunding(5), 4.75);
    assert.equal(getSurvivJoinLootFunding(5, { adminFreeEntry: true }), 0);

    const room = makeRoom();
    const originalLootCount = room.loot.length;
    assert.ok(room.loot.every(item => !(Number(item.contents?.money) > 0)));
    assert.ok(room.loot.every(item => item.type !== 'money' || !(Number(item.dollarValue) > 0)));
    spawnLootFromPool(room, getSurvivJoinLootFunding(5, { adminFreeEntry: true }));
    assert.equal(room.loot.length, originalLootCount);
    assert.equal(room.lootPoolBalance || 0, 0);
});
test('each paid Surviv entry adds 95% to loot and admin adds zero', () => {
    const room = makeRoom();
    const mapMoneyCents = () => room.loot.reduce((total, item) => {
        const dollars = item.type === 'money'
            ? Number(item.dollarValue || 0)
            : Number(item.contents?.money || 0);
        return total + Math.round(dollars * 100);
    }, 0);

    assert.equal(getSurvivJoinLootFunding(5), 4.75);
    assert.equal(getSurvivJoinLootFunding(999), 4.75);
    assert.equal(getSurvivJoinLootFunding(null), 4.75);
    assert.equal(mapMoneyCents(), 0);

    spawnLootFromPool(room, getSurvivJoinLootFunding(5));
    assert.equal(mapMoneyCents(), 475);

    spawnLootFromPool(room, getSurvivJoinLootFunding(5, { adminFreeEntry: true }));
    assert.equal(mapMoneyCents(), 475);

    spawnLootFromPool(room, getSurvivJoinLootFunding(5));
    assert.equal(mapMoneyCents(), 950);
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
        && obstacle.role === 'townMainStreet'
        && obstacle.variant === 'cobblestone'
    ));
    const townHouses = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor' && obstacle.variant === 'town');
    const doorsByHouse = new Map(map.obstacles
        .filter(obstacle => obstacle.kind === 'door' && obstacle.entranceRole !== 'interiorDoor')
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

test('planned towns include useful civic buildings and readable side lanes', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const shops = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor' && obstacle.role === 'townShop');
    const clinics = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor' && obstacle.role === 'townClinic');
    const lanes = map.obstacles.filter(obstacle => obstacle.kind === 'road' && obstacle.role === 'townLane');
    const townMainRoads = map.obstacles.filter(obstacle => (
        obstacle.kind === 'road'
        && obstacle.role === 'townMainStreet'
        && obstacle.variant === 'cobblestone'
    ));

    assert.equal(shops.length, 3);
    assert.equal(clinics.length, 3);
    assert.equal(lanes.length, 6);
    assert.ok(lanes.every(lane => lane.collidable === false));
    assert.ok(lanes.every(lane => townMainRoads.some(road => rectsOverlap(
        lane.x, lane.y, lane.w, lane.h,
        road.x, road.y, road.w, road.h,
    ))), 'every side lane should join its town main street');

    for (const shop of shops) {
        const rooms = new Set(map.obstacles
            .filter(obstacle => obstacle.kind === 'roomZone' && obstacle.houseId === shop.id)
            .map(room => room.variant));
        assert.deepEqual(rooms, new Set(['shop-front', 'stockroom']));
    }
    for (const clinic of clinics) {
        const rooms = new Set(map.obstacles
            .filter(obstacle => obstacle.kind === 'roomZone' && obstacle.houseId === clinic.id)
            .map(room => room.variant));
        assert.deepEqual(rooms, new Set(['living-room', 'bedroom']));
    }
});

test('surviv roads, landmark trees, and world furniture add varied readable detail within budget', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const roads = map.obstacles.filter(obstacle => obstacle.kind === 'road');
    const roadVariants = new Set(roads.map(road => road.variant));
    const landmarkTrees = map.obstacles.filter(obstacle => obstacle.kind === 'tree' && obstacle.role === 'landmarkTree');
    const treeVariants = new Set(landmarkTrees.map(tree => tree.variant));
    const countKind = kind => map.obstacles.filter(obstacle => obstacle.kind === kind).length;

    for (const variant of ['asphalt', 'dirt', 'gravel', 'cobblestone', 'service', 'rail']) {
        assert.ok(roadVariants.has(variant), 'missing road surface ' + variant);
    }
    assert.ok(landmarkTrees.length >= 28);
    assert.ok(landmarkTrees.every(tree => tree.w >= 82 && tree.h >= 82));
    for (const variant of ['ancientOak', 'giantPine', 'willowTree', 'birch']) {
        assert.ok(treeVariants.has(variant), 'missing landmark tree ' + variant);
    }

    assert.ok(countKind('roadMarker') >= 30);
    assert.ok(countKind('lampPost') >= 16);
    assert.ok(countKind('mailbox') >= 10);
    assert.ok(countKind('bench') >= 3);
    assert.ok(countKind('picnicTable') >= 5);
    const decorKinds = new Set(['roadMarker', 'lampPost', 'mailbox', 'bench', 'picnicTable']);
    assert.ok(map.obstacles
        .filter(obstacle => decorKinds.has(obstacle.kind))
        .every(obstacle => obstacle.collidable === false));
    assert.ok(map.obstacles.length < 11200, 'static map detail should stay inside the expanded residential performance budget');
});

test('new roadside landmarks have distinct buildings and connect to the highway network', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const landmarkTypes = new Set(map.landmarks.map(landmark => landmark.type));
    const roads = map.obstacles.filter(obstacle => obstacle.kind === 'road');
    const networkRoads = roads.filter(road => road.role === 'networkRoad');
    const doorsByHouse = new Map(map.obstacles
        .filter(obstacle => obstacle.kind === 'door' && obstacle.entranceRole !== 'interiorDoor')
        .map(door => [door.houseId, door]));

    for (const type of ['services', 'fire-station', 'orchard']) assert.ok(landmarkTypes.has(type));

    const services = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor' && obstacle.landmarkType === 'services');
    const fireStation = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor' && obstacle.landmarkType === 'fire-station');
    const orchard = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor' && obstacle.landmarkType === 'orchard');
    assert.deepEqual(new Set(services.map(building => building.role)), new Set(['diner', 'store', 'garage']));
    assert.deepEqual(new Set(fireStation.map(building => building.role)), new Set(['engineHall', 'watchHouse']));
    assert.deepEqual(new Set(orchard.map(building => building.role)), new Set(['farmhouse', 'ciderBarn', 'packingShed']));

    const expectedDoors = new Map([
        ['diner', 'south'], ['store', 'south'], ['garage', 'north'],
        ['engineHall', 'west'], ['watchHouse', 'north'],
        ['farmhouse', 'south'], ['ciderBarn', 'north'], ['packingShed', 'south'],
    ]);
    for (const building of [...services, ...fireStation, ...orchard]) {
        assert.equal(doorsByHouse.get(building.id)?.role, expectedDoors.get(building.role));
    }

    assert.ok(networkRoads.some(road => pointInRect(-700, -4000, road, 2)), 'service stop should sit on the north highway');
    for (const role of ['driveway', 'orchardLane']) {
        const approach = roads.find(road => road.role === role);
        assert.ok(approach);
        assert.ok(networkRoads.some(road => rectsOverlap(
            approach.x, approach.y, approach.w, approach.h,
            road.x, road.y, road.w, road.h,
        )), role + ' should connect to a highway');
    }

    const interiorVariants = new Set(map.obstacles
        .filter(obstacle => obstacle.kind === 'roomZone' && [...services, ...fireStation, ...orchard].some(building => building.id === obstacle.houseId))
        .map(room => room.variant));
    for (const variant of ['shop-front', 'stockroom', 'living-room', 'bedroom']) {
        assert.ok(interiorVariants.has(variant), 'missing new interior type ' + variant);
    }

    const fireHall = fireStation.find(building => building.role === 'engineHall');
    const medicalCrate = map.loot.find(item => item.houseId === fireHall.id && item.containerType === 'medical_crate');
    assert.ok(medicalCrate, 'fire station should keep its medical supplies indoors');
});

test('motel, ranger lodge, and lumberworks add distinct connected combat districts', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const landmarkTypes = new Set(map.landmarks.map(landmark => landmark.type));
    const networkRoads = map.obstacles.filter(obstacle => (
        obstacle.kind === 'road' && obstacle.role === 'networkRoad'
    ));
    const doorsByHouse = new Map(map.obstacles
        .filter(obstacle => obstacle.kind === 'door' && obstacle.entranceRole !== 'interiorDoor')
        .map(door => [door.houseId, door]));

    for (const type of ['motel', 'ranger-lodge', 'lumberworks']) {
        assert.ok(landmarkTypes.has(type), 'missing landmark ' + type);
    }

    const buildingsFor = landmarkType => map.obstacles.filter(obstacle => (
        obstacle.kind === 'houseFloor' && obstacle.landmarkType === landmarkType
    ));
    const motel = buildingsFor('motel');
    const lodge = buildingsFor('ranger-lodge');
    const lumberworks = buildingsFor('lumberworks');
    assert.equal(motel.length, 5);
    assert.deepEqual(new Set(motel.map(building => building.role)), new Set([
        'northWing', 'westWing', 'eastWing', 'reception', 'laundry',
    ]));
    assert.equal(lodge.length, 4);
    assert.deepEqual(new Set(lodge.map(building => building.role)), new Set([
        'mainLodge', 'guestCabin', 'gearShed',
    ]));
    assert.equal(lumberworks.length, 4);
    assert.deepEqual(new Set(lumberworks.map(building => building.role)), new Set([
        'sawmill', 'millOffice', 'workshop', 'dryingShed',
    ]));
    assert.ok([...motel, ...lodge, ...lumberworks].every(building => doorsByHouse.has(building.id)));

    const expectedConnections = [
        { x: 6000, y: -4300, name: 'motel' },
        { x: -3200, y: -7500, name: 'ranger lodge' },
        { x: 3500, y: 8720, name: 'lumberworks' },
    ];
    for (const connection of expectedConnections) {
        assert.ok(networkRoads.some(road => pointInRect(connection.x, connection.y, road, 2)), (
            connection.name + ' should connect to the highway network'
        ));
    }

    assert.ok(map.obstacles.some(obstacle => (
        obstacle.kind === 'water' && obstacle.variant === 'pool' && obstacle.landmarkType === 'motel'
    )));
    assert.ok(map.obstacles.filter(obstacle => (
        obstacle.kind === 'fallenLog' && obstacle.landmarkType === 'lumberworks'
    )).length >= 6);
    assert.ok(map.loot.filter(item => item.landmarkType === 'motel' && item.type === 'chest').length >= 4);
    assert.ok(map.loot.filter(item => item.landmarkType === 'ranger-lodge' && item.type === 'chest').length >= 3);
    assert.ok(map.loot.filter(item => item.landmarkType === 'lumberworks' && item.type === 'chest').length >= 3);
});

test('urban expansion adds five dense and distinct road-connected districts', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const landmarkTypes = new Set(map.landmarks.map(landmark => landmark.type));
    const houses = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
    const roads = map.obstacles.filter(obstacle => obstacle.kind === 'road');
    const networkRoads = roads.filter(road => road.role === 'networkRoad');
    const junctions = map.obstacles.filter(obstacle => obstacle.kind === 'roadJunction');
    const doorsByHouse = new Map(map.obstacles
        .filter(obstacle => obstacle.kind === 'door' && obstacle.entranceRole !== 'interiorDoor')
        .map(door => [door.houseId, door]));
    const expectedDistricts = new Map([
        ['riverside', { buildings: 8, approachRole: 'boroughCrossStreet' }],
        ['eastgate', { buildings: 8, approachRole: 'boroughMainStreet' }],
        ['westport', { buildings: 7, approachRole: 'harborRoad' }],
        ['rail-depot', { buildings: 5, approachRole: 'depotApproach' }],
        ['civic-quarter', { buildings: 6, approachRole: 'civicStreet' }],
    ]);

    assert.ok(houses.length >= 178 && houses.length <= 188);
    assert.ok(roads.length >= 75);
    assert.ok(junctions.length >= 25);
    for (const [landmarkType, expected] of expectedDistricts) {
        assert.ok(landmarkTypes.has(landmarkType), `missing expanded district ${landmarkType}`);
        const districtBuildings = houses.filter(house => house.landmarkType === landmarkType);
        assert.equal(districtBuildings.length, expected.buildings);
        assert.ok(districtBuildings.every(building => doorsByHouse.has(building.id)));
        assert.ok(new Set(districtBuildings.map(building => building.variant)).size >= 2);

        const approach = roads.find(road => (
            road.landmarkType === landmarkType && road.role === expected.approachRole
        ));
        assert.ok(approach, `${landmarkType} should have its own approach street`);
        assert.ok(networkRoads.some(road => rectsOverlap(
            approach.x, approach.y, approach.w + 24, approach.h + 24,
            road.x, road.y, road.w, road.h,
        )), `${landmarkType} should connect to the highway network`);
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

test('all Surviv roads and houses keep physically coherent spacing', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const roads = map.obstacles.filter(obstacle => obstacle.kind === 'road');
    const houses = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor');

    for (const road of roads) {
        for (const house of houses) {
            assert.equal(
                rectsOverlap(road.x, road.y, road.w, road.h, house.x, house.y, house.w, house.h),
                false,
                `${road.role || road.variant} road should not pass through ${house.role || house.variant}`,
            );
        }
    }
    for (let first = 0; first < houses.length; first++) {
        for (let second = first + 1; second < houses.length; second++) {
            assert.equal(
                rectsOverlap(
                    houses[first].x, houses[first].y, houses[first].w, houses[first].h,
                    houses[second].x, houses[second].y, houses[second].w, houses[second].h,
                ),
                false,
                'generated houses should never occupy the same ground',
            );
        }
    }

    const gasForecourt = map.obstacles.find(obstacle => obstacle.role === 'gasForecourt');
    assert.equal(gasForecourt?.kind, 'field', 'the gas station apron is a lot, not a giant road');
    assert.equal(gasForecourt?.variant, 'parkingLot');
});

test('remote supply structures connect back to the main road network with safe trails', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const networkRoads = map.obstacles.filter(obstacle => (
        obstacle.kind === 'road' && obstacle.role === 'networkRoad'
    ));
    const accessTrails = map.obstacles.filter(obstacle => (
        obstacle.kind === 'trail_path'
        && obstacle.role === 'supplyAccess'
        && obstacle.landmarkType === 'supply-cache'
    ));
    const cacheGrounds = map.obstacles.filter(obstacle => (
        obstacle.kind === 'field' && obstacle.role === 'supplyCache'
    ));

    assert.equal(accessTrails.length, 4);
    assert.equal(cacheGrounds.length, 4);
    for (const trail of accessTrails) {
        const start = trail.points[0];
        const end = trail.points.at(-1);
        assert.ok(cacheGrounds.some(cache => pointInRect(start.x, start.y, cache, 4)), (
            `${trail.label} should begin at a supply structure`
        ));
        assert.ok(networkRoads.some(road => pointInRect(end.x, end.y, road, 8)), (
            `${trail.label} should end at the main road network`
        ));
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

test('outer regional roads stop at the highways instead of forming a repetitive full grid', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const networkRoads = map.obstacles.filter(obstacle => (
        obstacle.kind === 'road' && obstacle.role === 'networkRoad'
    ));

    for (const point of [
        { x: -6000, y: -6100 }, { x: 6000, y: -6100 },
        { x: -6000, y: 6200 }, { x: 6000, y: 6200 },
    ]) {
        assert.ok(networkRoads.some(road => pointInRect(point.x, point.y, road, 4)),
            `missing regional collector at ${point.x},${point.y}`);
    }
    assert.equal(networkRoads.some(road => pointInRect(0, -6100, road, 4)), false);
    assert.equal(networkRoads.some(road => pointInRect(0, 6200, road, 4)), false);
    assert.ok(networkRoads.some(road => pointInRect(2100, 8200, road, 4)),
        'rail depot freight road should connect to the east highway');
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

    assert.equal(trails.length, 15);
    assert.ok(trails.every(trail => trail.collidable === false));
    assert.ok(trails.every(trail => trail.points.length >= 5 && trail.width >= 48));
    assert.ok(trails.some(trail => trail.variant === 'boardwalk'));
    assert.ok(trails.some(trail => trail.variant === 'forest'));
    assert.ok(trails.some(trail => trail.variant === 'gravel'));
    assert.ok(naturalDetails.length >= 1180 && naturalDetails.length <= 1400,
        `natural detail should stay varied across the denser countryside, got ${naturalDetails.length}`);
    assert.ok(bushVariants.has('bramble'));
    assert.ok(bushVariants.has('berry'));
    assert.ok(bushVariants.has('flowering'));
    assert.ok(bushVariants.has('juniper'));
    assert.ok(map.obstacles.some(obstacle => obstacle.kind === 'hayBale'));
});

test('generated Surviv maps keep trails, roads, buildings, and props separated', () => {
    const clearableKinds = new Set([
        'tree', 'bush', 'rock', 'stump', 'fallenLog', 'signpost', 'hayBale',
        'reeds', 'grassTuft', 'wildflowers', 'mushrooms', 'crate', 'barrel',
        'container', 'sandbag', 'tent',
    ]);

    for (let sample = 0; sample < 4; sample++) {
        const map = generateSurvivMap(SURVIV.worldHalf);
        const houses = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
        const trails = map.obstacles.filter(obstacle => obstacle.kind === 'trail_path');
        const roads = map.obstacles.filter(obstacle => obstacle.kind === 'road');
        const networkRoads = roads.filter(road => road.role === 'networkRoad');
        const outdoorProps = map.obstacles.filter(obstacle => (
            clearableKinds.has(obstacle.kind) && !obstacle.houseId
        ));

        for (const prop of outdoorProps) {
            assert.ok(networkRoads.every(road => !rectsOverlap(
                prop.x, prop.y, prop.w, prop.h,
                road.x, road.y, road.w, road.h,
            )), `${prop.kind} should stay off network roads`);
        }

        for (let i = 0; i < houses.length; i++) {
            for (let j = i + 1; j < houses.length; j++) {
                assert.ok(!rectsOverlap(
                    houses[i].x, houses[i].y, houses[i].w, houses[i].h,
                    houses[j].x, houses[j].y, houses[j].w, houses[j].h,
                ), 'generated buildings should not overlap');
            }
        }

        for (const trail of trails) {
            for (let i = 0; i < trail.points.length - 1; i++) {
                const from = trail.points[i];
                const to = trail.points[i + 1];
                const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 30));
                for (let step = 0; step <= steps; step++) {
                    const progress = step / steps;
                    const x = from.x + (to.x - from.x) * progress;
                    const y = from.y + (to.y - from.y) * progress;
                    assert.ok(houses.every(house => !pointInRect(x, y, house, trail.width / 2)), `${trail.label} should avoid buildings`);
                }
            }
        }

        for (const networkRoad of networkRoads) {
            const horizontal = networkRoad.w > networkRoad.h;
            for (const localRoad of roads) {
                if (localRoad === networkRoad || localRoad.role === 'networkRoad') continue;
                if ((localRoad.w > localRoad.h) !== horizontal) continue;
                if (!rectsOverlap(
                    networkRoad.x, networkRoad.y, networkRoad.w, networkRoad.h,
                    localRoad.x, localRoad.y, localRoad.w, localRoad.h,
                )) continue;
                const overlapLength = horizontal
                    ? Math.min(networkRoad.x + networkRoad.w / 2, localRoad.x + localRoad.w / 2)
                        - Math.max(networkRoad.x - networkRoad.w / 2, localRoad.x - localRoad.w / 2)
                    : Math.min(networkRoad.y + networkRoad.h / 2, localRoad.y + localRoad.h / 2)
                        - Math.max(networkRoad.y - networkRoad.h / 2, localRoad.y - localRoad.h / 2);
                assert.ok(overlapLength <= 5, 'parallel road surfaces should only overlap at a short seam');
            }
        }
    }
});
test('surviv landmark approaches survive road clipping without tiny fragments', () => {
    const approachPoints = [
        { x: 6950, y: -1200, name: 'farm' },
        { x: 4800, y: -6800, name: 'north-east town' },
        { x: 6950, y: 7200, name: 'research campus' },
        { x: -7500, y: -6810, name: 'north-west mansion' },
        { x: -2500, y: 7300, name: 'ironworks' },
        { x: -6505, y: 1900, name: 'south-west town' },
        { x: -7800, y: -3900, name: 'forest camp' },
        { x: 2450, y: 7490, name: 'bunker' },
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
    const exteriorDoors = doors.filter(door => door.entranceRole !== 'interiorDoor');
    const interiorDoors = doors.filter(door => door.entranceRole === 'interiorDoor');
    assert.equal(exteriorDoors.length, 4);
    assert.ok(interiorDoors.length >= 8);
    assert.deepEqual(new Set(exteriorDoors.map(door => door.role)), new Set(['north', 'south', 'east', 'west']));
    assert.ok(exteriorDoors.some(door => door.entranceRole === 'mainEntrance'));
    assert.ok(exteriorDoors.some(door => door.entranceRole === 'loadingEntrance'));

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

    const ironworksFurniture = map.obstacles.filter(obstacle => (
        obstacle.kind === 'furniture'
        && obstacle.houseId === floor.id
    ));
    assert.ok(ironworksFurniture.length >= 6);
    assert.ok(ironworksFurniture.every(obstacle => obstacle.collidable !== false && obstacle.roomId));
    const ironworksFurnitureVariants = new Set(ironworksFurniture.map(obstacle => obstacle.variant));
    for (const variant of ['workbench', 'controlConsole', 'locker', 'palletStack']) {
        assert.ok(ironworksFurnitureVariants.has(variant), `missing Ironworks furniture ${variant}`);
    }

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
        .filter(obstacle => obstacle.kind === 'door' && obstacle.entranceRole !== 'interiorDoor')
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
    assert.ok(hamletFields.length >= 3);
    assert.equal(hamletHomes.length, hamletFields.length * 3);
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
    const doors = map.obstacles.filter(obstacle => (
        obstacle.kind === 'door' && obstacle.entranceRole !== 'interiorDoor'
    ));
    const interiorDoors = map.obstacles.filter(obstacle => (
        obstacle.kind === 'door' && obstacle.entranceRole === 'interiorDoor'
    ));
    const propKinds = new Set(['tree', 'bush', 'rock', 'crate', 'barrel', 'container', 'sandbag', 'tent']);
    const props = map.obstacles.filter(obstacle => propKinds.has(obstacle.kind));

    assert.ok([...doors, ...interiorDoors].every(door => Math.max(door.w, door.h) <= 64.01),
        'door leaves should stay compact even in large and industrial buildings');
    assert.ok([...doors, ...interiorDoors].every(door => Math.min(door.w, door.h) <= 6.51),
        'door leaves should remain much thinner than their surrounding walls');
    assert.ok(interiorDoors.length >= 30, 'split and corridor buildings should expose real interior doors');
    assert.ok(interiorDoors.every(door => {
        const house = floors.find(floor => floor.id === door.houseId);
        return door.collidable !== false && door.isOpen === false
            && house && pointInRect(door.x, door.y, house, 2);
    }), 'interior doors should start closed, solid, and inside their owning building');

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
        !circleRectCollision(point.x, point.y, 28, obstacleCollisionRectForTest(obstacle))
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
            player.x, player.y, SURVIV.playerRadius + 10, obstacleCollisionRectForTest(obstacle),
        )), 'runtime spawn should stay outside structures and water');
    }
});

test('every interior partition belongs to a connected wall junction', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const floors = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
    const exteriorWalls = map.obstacles.filter(obstacle => (
        obstacle.kind === 'wall' && Math.abs(Number(obstacle.rotation) || 0) < 0.001
    ));
    const interiorWalls = map.obstacles.filter(obstacle => (
        obstacle.kind === 'interiorWall' && Math.abs(Number(obstacle.rotation) || 0) < 0.001
    ));
    const doors = map.obstacles.filter(obstacle => obstacle.kind === 'door');
    const wallsTouch = (first, second, tolerance = 1.5) => (
        Math.abs(first.x - second.x) * 2 <= first.w + second.w + tolerance * 2
        && Math.abs(first.y - second.y) * 2 <= first.h + second.h + tolerance * 2
    );
    const maxVisibleGap = 76;
    let checkedPartitions = 0;
    let joinedEndpoints = 0;

    for (const floor of floors) {
        const floorLeft = floor.x - floor.w / 2;
        const floorRight = floor.x + floor.w / 2;
        const floorTop = floor.y - floor.h / 2;
        const floorBottom = floor.y + floor.h / 2;
        const belongsToFloor = obstacle => obstacle.houseId
            ? obstacle.houseId === floor.id
            : pointInRect(obstacle.x, obstacle.y, floor, 22);
        const partitions = interiorWalls.filter(belongsToFloor);
        const structureWalls = [...exteriorWalls, ...interiorWalls].filter(belongsToFloor);
        const floorDoors = doors.filter(door => door.houseId === floor.id);
        const boundaryWalls = exteriorWalls.filter(wall => {
            if (wall.houseId && wall.houseId !== floor.id) return false;
            if (wall.h > wall.w) {
                return Math.min(Math.abs(wall.x - floorLeft), Math.abs(wall.x - floorRight))
                        <= Math.max(18, wall.w * 1.25)
                    && wall.y + wall.h / 2 >= floorTop - 2
                    && wall.y - wall.h / 2 <= floorBottom + 2;
            }
            return Math.min(Math.abs(wall.y - floorTop), Math.abs(wall.y - floorBottom))
                    <= Math.max(18, wall.h * 1.25)
                && wall.x + wall.w / 2 >= floorLeft - 2
                && wall.x - wall.w / 2 <= floorRight + 2;
        });

        for (const partition of partitions) {
            const touchesStructure = structureWalls.some(wall => (
                wall.id !== partition.id && wallsTouch(partition, wall)
            ));
            const terminatesAtDoor = floorDoors.some(door => {
                const horizontal = partition.w >= partition.h;
                if ((door.w >= door.h) !== horizontal) return false;
                const samePlane = horizontal
                    ? Math.abs(door.y - partition.y) <= (door.h + partition.h) / 2 + 2
                    : Math.abs(door.x - partition.x) <= (door.w + partition.w) / 2 + 2;
                const endpointDistance = horizontal
                    ? Math.min(
                        Math.abs(door.x - (partition.x - partition.w / 2)),
                        Math.abs(door.x - (partition.x + partition.w / 2)),
                    )
                    : Math.min(
                        Math.abs(door.y - (partition.y - partition.h / 2)),
                        Math.abs(door.y - (partition.y + partition.h / 2)),
                    );
                return samePlane && endpointDistance <= Math.max(door.w, door.h) / 2 + 3;
            });
            const clearedForDoorTraversal = floorDoors.some(door => {
                if (partition.doorwayClearanceFor === door.id) return true;
                const endpoints = partition.w >= partition.h
                    ? [
                        { x: partition.x - partition.w / 2, y: partition.y },
                        { x: partition.x + partition.w / 2, y: partition.y },
                    ]
                    : [
                        { x: partition.x, y: partition.y - partition.h / 2 },
                        { x: partition.x, y: partition.y + partition.h / 2 },
                    ];
                return endpoints.some(endpoint => Math.hypot(
                    endpoint.x - door.x,
                    endpoint.y - door.y,
                ) <= SURVIV.playerRadius + 3);
            });
            assert.ok(touchesStructure || terminatesAtDoor || clearedForDoorTraversal,
                `freestanding interior wall in ${floor.label || floor.role || floor.id} (${partition.id}: ${partition.x},${partition.y} ${partition.w}x${partition.h})`);
            checkedPartitions++;

            const horizontal = partition.w >= partition.h;
            const nearTargets = boundaryWalls.filter(wall => horizontal
                ? wall.h > wall.w
                    && partition.y + partition.h / 2 >= wall.y - wall.h / 2 - 0.5
                    && partition.y - partition.h / 2 <= wall.y + wall.h / 2 + 0.5
                : wall.w >= wall.h
                    && partition.x + partition.w / 2 >= wall.x - wall.w / 2 - 0.5
                    && partition.x - partition.w / 2 <= wall.x + wall.w / 2 + 0.5);
            const endpointGaps = horizontal
                ? nearTargets.flatMap(wall => [
                    {
                        gap: partition.x - partition.w / 2 - (wall.x + wall.w / 2),
                        from: partition.x - partition.w / 2,
                        to: wall.x,
                    },
                    {
                        gap: (wall.x - wall.w / 2) - (partition.x + partition.w / 2),
                        from: partition.x + partition.w / 2,
                        to: wall.x,
                    },
                ])
                : nearTargets.flatMap(wall => [
                    {
                        gap: partition.y - partition.h / 2 - (wall.y + wall.h / 2),
                        from: partition.y - partition.h / 2,
                        to: wall.y,
                    },
                    {
                        gap: (wall.y - wall.h / 2) - (partition.y + partition.h / 2),
                        from: partition.y + partition.h / 2,
                        to: wall.y,
                    },
                ]);
            for (const { gap, from, to } of endpointGaps) {
                if (gap < -maxVisibleGap || gap > maxVisibleGap) continue;
                const doorwayIntentionallyInterruptsJunction = gap > 0.5 && floorDoors.some(door => {
                    if ((door.w >= door.h) !== horizontal) return false;
                    const samePlane = horizontal
                        ? Math.abs(door.y - partition.y) <= (door.h + partition.h) / 2 + 2
                        : Math.abs(door.x - partition.x) <= (door.w + partition.w) / 2 + 2;
                    const doorAxis = horizontal ? door.x : door.y;
                    return samePlane
                        && Math.abs(doorAxis - from) > 2
                        && doorAxis >= Math.min(from, to) - 0.5
                        && doorAxis <= Math.max(from, to) + 0.5;
                });
                if (doorwayIntentionallyInterruptsJunction || partition.doorwayClearanceFor) continue;
                assert.ok(gap <= 0.5,
                    `detached interior-wall endpoint leaves a ${gap.toFixed(2)} unit gap in ${floor.label || floor.role || floor.id} (${partition.id})`);
                joinedEndpoints++;
            }
        }
    }

    assert.ok(checkedPartitions >= 500, 'expected to audit every generated building interior');
    assert.ok(joinedEndpoints >= 30, 'expected the assertion to cover many exterior-wall junctions');
});

test('generated doorways never remain sealed by a structural wall', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const doors = map.obstacles.filter(obstacle => obstacle.kind === 'door');
    const structuralWalls = map.obstacles.filter(obstacle => (
        obstacle.kind === 'wall' || obstacle.kind === 'interiorWall'
    ));

    assert.ok(doors.length >= 400, 'expected to audit every generated building doorway');
    for (const door of doors) {
        const alignedWalls = structuralWalls.filter(wall => (
            (!door.houseId || !wall.houseId || wall.houseId === door.houseId)
            && Math.abs(Number(wall.rotation) || 0) < 0.001
        ));
        const centerBlocker = alignedWalls.find(wall => (
            Math.abs(door.x - wall.x) * 2 < wall.w - 0.5
            && Math.abs(door.y - wall.y) * 2 < wall.h - 0.5
        ));
        assert.equal(
            centerBlocker,
            undefined,
            `door ${door.id} in ${door.houseId || 'untagged house'} is sealed by ${centerBlocker?.id}`,
        );

        // The opening must fit the authoritative player body after the leaf
        // swings away, not merely expose a one-pixel visual slit.
        assert.ok(alignedWalls.every(wall => !circleRectCollision(
            door.x,
            door.y,
            SURVIV.playerRadius - 1,
            obstacleCollisionRectForTest(wall),
        )), `door ${door.id} does not leave player-width traversal clearance`);
    }
});

test('river spline metadata survives generation and bridges hit both highways exactly', () => {
    const map = generateSurvivMap(SURVIV.worldHalf);
    const riverPath = map.obstacles.find(obstacle => obstacle.kind === 'river_path');
    const riverSegments = map.obstacles.filter(obstacle => obstacle.kind === 'river');
    const bridges = map.obstacles.filter(obstacle => obstacle.kind === 'bridge');
    const bridgeRails = map.obstacles.filter(obstacle => obstacle.role === 'bridgeRail');
    const houses = map.obstacles.filter(obstacle => obstacle.kind === 'houseFloor');
    const roads = map.obstacles.filter(obstacle => obstacle.kind === 'road');
    const verticalHighways = map.obstacles.filter(obstacle => (
        obstacle.kind === 'road'
        && obstacle.role === 'networkRoad'
        && obstacle.h > obstacle.w
    ));

    assert.ok(riverPath);
    assert.equal(riverPath.points.length, 21);
    assert.ok(riverPath.width >= 210 && riverPath.width <= 270);
    assert.equal(riverPath.widths.length, riverPath.points.length);
    assert.ok(Math.max(...riverPath.widths) - Math.min(...riverPath.widths) > riverPath.width * 0.1);
    assert.ok(riverPath.points.every(point => pointInRect(point.x, point.y, riverPath)));
    assert.equal(bridges.length, 2);
    assert.deepEqual(bridges.map(bridge => Math.round(bridge.x)).sort((a, b) => a - b), [-2500, 2500]);
    assert.ok(bridges.every(bridge => Math.abs(bridge.rotation - Math.PI / 2) < 1e-9));
    assert.ok(bridges.every(bridge => bridge.h === 140 && bridge.w > riverPath.width));
    assert.ok(bridges.every(bridge => verticalHighways.some(road => (
        Math.abs(road.x - bridge.x) < 1
        && pointInRect(bridge.x, bridge.y, road, 2)
    ))), 'each bridge should share the exact axis of its highway');
    assert.ok(houses.every(house => riverSegments.every(segment => !rotatedRectsOverlap(house, segment))),
        'houses must stay completely outside the river');
    const riverRoads = roads.filter(road => riverSegments.some(segment => rotatedRectsOverlap(road, segment)));
    assert.equal(riverRoads.length, bridges.length, 'only bridged highways may cross the river');
    assert.ok(riverRoads.every(road => bridges.some(bridge => rotatedRectsOverlap(road, bridge))),
        'every road entering the river must be covered by a bridge');

    assert.equal(bridgeRails.length, 4);
    assert.ok(bridgeRails.every(rail => rail.collidable === true));
    assert.ok(bridgeRails.every(rail => rail.destructible !== true));
    assert.ok(bridgeRails.every(rail => rail.variant === 'bridgeRail'));
    for (const bridge of bridges) {
        const rails = bridgeRails.filter(rail => Math.hypot(rail.x - bridge.x, rail.y - bridge.y) < bridge.h);
        assert.equal(rails.length, 2);
        assert.ok(rails.every(rail => Math.abs(rail.rotation - bridge.rotation) < 1e-9));
        assert.ok(rails.every(rail => Math.abs(rail.w - bridge.w) < 1e-9));
    }
});

test('surviv doors open with interaction and cannot close through a player', () => {
    const room = makeRoom();
    const door = room.obstacles.find(obstacle => obstacle.kind === 'door');
    const player = createSurvivPlayer('door-player', null, 'Door player', '#55aaff', room);
    room.players.push(player);
    room.bots = [];

    const horizontal = door.w >= door.h;
    player.x = horizontal ? door.x : door.x + door.w / 2 + 42;
    player.y = horizontal ? door.y + door.h / 2 + 42 : door.y;
    player.toggleDoorId = door.id;
    assert.equal(toggleSurvivDoor(player, room, 1000), true);
    assert.equal(door.isOpen, true);
    assert.equal(door.openDirection, horizontal ? -1 : 1, 'the door should swing away from the interacting player');
    const openDoorShape = getSurvivDoorCollisionRect(door);
    assert.ok(Math.hypot(openDoorShape.x - door.x, openDoorShape.y - door.y) > 20,
        'the open door must keep a moved physical collision shape');
    assert.ok(Math.abs(Math.sin(openDoorShape.rotation - (door.rotation || 0))) > 0.99,
        'the physical door leaf must rotate a quarter turn when opened');

    player.x = door.x;
    player.y = door.y;
    player.toggleDoorId = door.id;
    assert.equal(toggleSurvivDoor(player, room, 1300), false);
    assert.equal(door.isOpen, true, 'an occupied doorway must stay open');

    player.x = door.x + door.w / 2 + 100;
    player.y = door.y + door.h / 2 + 100;
    player.toggleDoorId = door.id;
    assert.equal(toggleSurvivDoor(player, room, 1600), false, 'remote door requests must be rejected');
});

test('bridge rails block movement along their full rotated length', () => {
    const room = makeRoom();
    const bridge = room.obstacles.find(obstacle => obstacle.kind === 'bridge');
    const leftRail = room.obstacles
        .filter(obstacle => obstacle.role === 'bridgeRail' && obstacle.x < bridge.x)
        .sort((a, b) => Math.abs(a.y - bridge.y) - Math.abs(b.y - bridge.y))[0];
    const player = createSurvivPlayer('bridge-collision', 'mongo-bridge', 'Bridge Tester', '#fff', room);
    const radius = SURVIV.playerRadius;

    room.players = [player];
    room.bots = [];
    player.x = leftRail.x + leftRail.h / 2 + radius + 3;
    player.y = bridge.y + bridge.w * 0.35;
    player.inputDx = -1;
    player.inputDy = 0;

    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.ok(player.x >= leftRail.x + leftRail.h / 2 + radius - 0.01, (
        'the player should be resolved against the bridge rail instead of crossing it'
    ));
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

test('melee-breaking a crate bursts every item onto the ground', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('human-break-crate', 'mongo-break-crate', 'Opener', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.shooting = true;
    room.players.push(player);
    room.loot.push({
        id: 'break-crate',
        type: 'chest',
        containerType: 'supply_crate',
        x: 45,
        y: 0,
        tier: 'rare',
        hp: 18,
        maxHp: 18,
        hitRadius: 24,
        contents: {
            weaponType: 'shotgun',
            ammo: 3,
            money: 1.25,
            medkits: 2,
            ammoType: '12g',
            ammoAmount: 8,
            grenades: 1,
            vestLevel: 2,
            rarity: 'rare',
        },
    });

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(room.loot.some(item => item.id === 'break-crate'), false);
    assert.deepEqual(new Set(room.loot.map(item => item.type)), new Set([
        'weapon', 'money', 'medkit', 'ammo', 'grenade', 'vest',
    ]));
    assert.ok(room.loot.every(item => item.source === 'chest'));
    assert.ok(room.loot.every(item => item.spawnX === 45 && item.spawnY === 0));
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
test('indoor crate drops stay inside the house when broken beside a corner', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [
        { id: 'corner-house', kind: 'houseFloor', x: 0, y: 0, w: 200, h: 200, rotation: 0, collidable: false },
        { id: 'corner-room', kind: 'roomZone', x: 0, y: 0, w: 200, h: 200, rotation: 0, collidable: false, houseId: 'corner-house', variant: 'main' },
    ];
    const player = createSurvivPlayer('corner-opener', 'mongo-corner-opener', 'Corner Opener', '#fff', room);
    player.x = 52;
    player.y = 84;
    player.aimAngle = 0;
    player.shooting = true;
    room.players.push(player);
    room.loot.push({
        id: 'corner-chest',
        type: 'chest',
        x: 84,
        y: 84,
        tier: 'rare',
        containerType: 'armory_crate',
        hp: 18,
        maxHp: 18,
        hitRadius: 26,
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
            vestLevel: 2,
        },
    });

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
    victim.vestLevel = 2;
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
    assert.ok(deathDrops.some(item => item.type === 'vest' && item.vestLevel === 2));
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

test('vest pickups auto-equip upgrades and F can deliberately equip a lower tier', () => {
    const room = makeRoom();
    const player = createSurvivPlayer('human-vest', 'mongo-vest', 'Armored', '#fff', room);
    player.vestLevel = 1;
    room.players.push(player);
    room.loot = [
        { id: 'vest-upgrade', type: 'vest', vestLevel: 3, x: player.x, y: player.y, tier: 'military' },
    ];

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(player.vestLevel, 3);
    assert.equal(player.lastLoot.items.vestLevel, 3);
    assert.equal(player.lastLoot.items.vestLabel, 'Level 3 Vest');
    assert.ok(room.loot.some(item => item.type === 'vest' && item.vestLevel === 1));

    room.loot.push({ id: 'worse-vest', type: 'vest', vestLevel: 2, x: player.x, y: player.y, tier: 'rare' });
    processSurvivRoom(room, silentIo, Date.now() + 600010);
    assert.equal(player.vestLevel, 3);
    assert.ok(room.loot.some(item => item.id === 'worse-vest'), 'a worse vest should remain available for another player');

    player.pickupVestId = 'worse-vest';
    processSurvivRoom(room, silentIo, Date.now() + 600020);
    assert.equal(player.vestLevel, 2, 'an explicit F interaction should permit a downgrade');
    assert.equal(player.lastLoot.items.vestLevel, 2);
    assert.equal(player.lastLoot.items.vestLabel, 'Level 2 Vest');
    assert.ok(room.loot.some(item => (
        item.id === 'worse-vest'
        && item.type === 'vest'
        && item.vestLevel === 3
        && item.source === 'player-swap'
    )), 'the replaced higher vest should remain on the ground');
});

test('legacy ground ammo without a caliber is repaired and can be picked up', () => {
    const room = makeRoom();
    const player = createSurvivPlayer('human-legacy-ammo', 'mongo-legacy-ammo', 'Collector', '#fff', room);
    room.players.push(player);
    room.loot = [
        { id: 'legacy-ammo-drop', type: 'ammo', x: player.x, y: player.y, amount: 0, tier: 'common' },
    ];

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(room.loot.length, 0);
    assert.equal(player.inventory.ammoReserves['9mm'], SURVIV_AMMO['9mm'].pickup);
    assert.equal(player.lastLoot.items.ammoType, '9mm');
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

test('grenade damage is lethal at the center and falls off sharply with distance', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room.bots = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;

    const attacker = createSurvivPlayer('grenade-attacker', 'mongo-grenade-attacker', 'Grenadier', '#fff', room);
    attacker.x = 500;
    attacker.y = 0;

    const makeTarget = (id, x, vestLevel = 0, y = 0) => {
        const target = createSurvivPlayer(id, `mongo-${id}`, id, '#fff', room);
        target.x = x;
        target.y = y;
        target.hp = 100;
        target.vestLevel = vestLevel;
        return target;
    };
    const direct = makeTarget('grenade-direct', 0, 1);
    const near = makeTarget('grenade-near', 45);
    const middle = makeTarget('grenade-middle', 105);
    const edge = makeTarget('grenade-edge', 140);
    const middleVest1 = makeTarget('grenade-middle-vest1', 0, 1, 105);
    const middleVest2 = makeTarget('grenade-middle-vest2', -105, 2);
    const middleVest3 = makeTarget('grenade-middle-vest3', 0, 3, -105);
    room.players.push(attacker, direct, near, middle, edge, middleVest1, middleVest2, middleVest3);

    room.bullets.push({
        id: 'grenade-falloff-test',
        ownerId: attacker.id,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        damage: SURVIV.grenadeDamage,
        weaponType: 'grenade',
        isGrenade: true,
        bornAt: 0,
        detonateAt: 0,
    });

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    const nearDamage = 100 - near.hp;
    const middleDamage = 100 - middle.hp;
    const edgeDamage = 100 - edge.hp;
    assert.ok(direct.hp <= 0, 'standing on the grenade should kill through light armor');
    assert.ok(room.loot.some(item => item.source === 'death' && item.type === 'vest' && item.vestLevel === 1), 'the vest should drop intact rather than being consumed by damage');
    assert.ok(nearDamage > 70, `near blast should hurt heavily, got ${nearDamage}`);
    assert.ok(middleDamage > 20 && middleDamage < 40, `mid-range blast should be reduced, got ${middleDamage}`);
    assert.ok(edgeDamage >= SURVIV.grenadeMinDamage && edgeDamage < 15, `blast edge should do low damage, got ${edgeDamage}`);
    assert.ok(nearDamage > middleDamage && middleDamage > edgeDamage);
    assert.ok(Math.abs((100 - middleVest1.hp) - middleDamage * 0.75) < 0.25);
    assert.ok(Math.abs((100 - middleVest2.hp) - middleDamage * 0.62) < 0.25);
    assert.ok(Math.abs((100 - middleVest3.hp) - middleDamage * 0.55) < 0.25);
    assert.equal(near._damageTaken.kind, 'grenade');
    assert.equal(near._damageTaken.sourceX, 0);
    assert.equal(near._damageTaken.sourceY, 0);
    assert.notEqual(near._damageTaken.sourceX, attacker.x, 'damage direction should point to the blast, not the thrower');
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
test('firearms work throughout the square map outside the old circular projectile boundary', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room.bots = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;

    const player = createSurvivPlayer('south-shot', 'south-shot-mongo', 'South Shooter', '#fff', room);
    player.x = 7600;
    player.y = 6500;
    player.aimAngle = 0;
    player.weapon = { type: 'pistol', ammo: 15, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.inventory.weapons = ['pistol'];
    player.shooting = true;
    room.players.push(player);

    const target = spawnSurvivBotNear(room, 7690, 6500, { adminSpawned: true });
    target.botThinkAt = Number.POSITIVE_INFINITY;
    const firedAt = Date.now() + 600000;

    processSurvivRoom(room, silentIo, firedAt);
    player.shooting = false;
    processSurvivRoom(room, silentIo, firedAt + 25);
    processSurvivRoom(room, silentIo, firedAt + 50);

    assert.ok(target.hp < target.maxHp, 'a shot inside the square map must not disappear at the old circular edge');
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
    const firedAt = Date.now() + 600000;
    processSurvivRoom(room, silentIo, firedAt);
    player.shooting = false;
    processSurvivRoom(room, silentIo, firedAt + 25);

    assert.equal(
        room.obstacles[0].hp,
        84 - WEAPONS.pistol.damage,
        'a pistol round should damage a destructible tree',
    );
});
test('firearm rounds pass through foliage beside a tree trunk', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room.bots = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [{
        id: 'foliage-only-shot', kind: 'tree', x: 62, y: 0, w: 100, h: 100,
        hitboxW: 20, hitboxH: 20, trunkScale: 0.2,
        collidable: true, destructible: true, hp: 84, maxHp: 84,
    }];
    const player = createSurvivPlayer('foliage-shooter', 'foliage-shooter-mongo', 'Shooter', '#fff', room);
    player.x = 0;
    player.y = 30;
    player.aimAngle = 0;
    player.weapon = { type: 'pistol', ammo: 15, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.inventory.weapons = ['pistol'];
    player.shooting = true;
    const target = createSurvivPlayer('foliage-target', 'foliage-target-mongo', 'Target', '#fff', room);
    target.x = 105;
    target.y = 30;
    room.players.push(player, target);

    const firedAt = Date.now() + 600000;
    processSurvivRoom(room, silentIo, firedAt);
    player.shooting = false;
    processSurvivRoom(room, silentIo, firedAt + 25);
    processSurvivRoom(room, silentIo, firedAt + 50);

    assert.ok(target.hp < target.maxHp, 'foliage outside the trunk should not absorb the round');
    assert.equal(room.obstacles[0].hp, 84, 'passing through leaves should not damage the tree');
});
test('bullets break loot crates and release their contents', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.spawnPoints = [];
    room.loot = [{
        id: 'shot-crate',
        type: 'chest',
        containerType: 'ammo_crate',
        x: 68,
        y: 0,
        tier: 'common',
        hp: 11,
        maxHp: 11,
        hitRadius: 23,
        contents: { ammoType: '9mm', ammoAmount: 30 },
    }];
    const player = createSurvivPlayer('human-crate-shot', 'mongo-crate-shot', 'Crate Shooter', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.weapon = { type: 'pistol', ammo: 15, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.inventory.weapons = ['pistol'];
    player.shooting = true;
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(room.loot.some(item => item.id === 'shot-crate'), false);
    assert.equal(room.loot.find(item => item.type === 'ammo')?.amount, 30);
    assert.equal(player.inventory.chestsOpened, 1);
});

test('hit and damage feedback is private, accurate, and emitted once', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;

    const shooter = createSurvivPlayer('feedback-shooter', 'mongo-feedback-shooter', 'Shooter', '#fff', room);
    shooter.x = 0;
    shooter.y = 0;
    shooter.aimAngle = 0;
    shooter.weapon = { type: 'pistol', ammo: 15, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    shooter.inventory.weapons = ['pistol'];
    shooter.shooting = true;

    const target = createSurvivPlayer('feedback-target', 'mongo-feedback-target', 'Target', '#fff', room);
    target.x = 68;
    target.y = 0;
    room.players.push(shooter, target);

    let lbData;
    for (let tick = 0; tick < 3; tick++) {
        lbData = processSurvivRoom(room, silentIo, Date.now() + 600000 + tick);
        if (shooter._hitConfirm) break;
    }
    assert.ok(shooter._hitConfirm, 'the projectile should produce authoritative hit feedback');
    const ticksBySocket = new Map();
    const io = {
        to(socketId) {
            return {
                emit(event, payload) {
                    if (event !== 'survivTick') return;
                    const ticks = ticksBySocket.get(socketId) || [];
                    ticks.push(payload);
                    ticksBySocket.set(socketId, ticks);
                },
            };
        },
    };

    broadcastSurvivState(room, io, lbData, {});
    const shooterTick = ticksBySocket.get(shooter.id)[0];
    const targetTick = ticksBySocket.get(target.id)[0];
    assert.equal(shooterTick.hitConfirm.targetId, target.id);
    assert.equal(shooterTick.hitConfirm.damage, WEAPONS.pistol.damage);
    assert.equal(shooterTick.hitConfirm.kill, false);
    assert.equal(Object.hasOwn(shooterTick, 'damageTaken'), false);
    assert.equal(targetTick.damageTaken.sourceId, shooter.id);
    assert.equal(targetTick.damageTaken.kind, 'player');
    assert.equal(targetTick.damageTaken.sourceX, shooter.x);
    assert.equal(targetTick.damageTaken.damage, WEAPONS.pistol.damage);
    assert.equal(Object.hasOwn(targetTick, 'hitConfirm'), false);

    broadcastSurvivState(room, io, lbData, {});
    assert.equal(Object.hasOwn(ticksBySocket.get(shooter.id)[1], 'hitConfirm'), false);
    assert.equal(Object.hasOwn(ticksBySocket.get(target.id)[1], 'damageTaken'), false);
});
test('eliminations produce one global kill-feed event for players and spectators', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;

    const attacker = createSurvivPlayer('kill-feed-attacker', 'mongo-kill-feed-attacker', 'Winner', '#fff', room);
    attacker.weapon = { type: 'shotgun', ammo: 5, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    attacker.inventory.weapons = ['shotgun'];
    const victim = createSurvivPlayer('kill-feed-victim', 'mongo-kill-feed-victim', 'Victim', '#fff', room);
    room.players.push(attacker, victim);
    eliminateSurvivPlayer(room, victim, silentIo, attacker);

    const ticksBySocket = new Map();
    const io = {
        to(socketId) {
            return {
                emit(event, payload) {
                    if (event !== 'survivTick') return;
                    const ticks = ticksBySocket.get(socketId) || [];
                    ticks.push(payload);
                    ticksBySocket.set(socketId, ticks);
                },
            };
        },
    };
    const lbData = {
        leaderboard: [{ id: attacker.id }],
        aliveCount: 1,
        zone: { x: 0, y: 0, radius: SURVIV.worldHalf },
    };

    broadcastSurvivState(room, io, lbData, {});
    for (const socketId of [attacker.id, victim.id]) {
        const event = ticksBySocket.get(socketId)[0].killFeed[0];
        assert.equal(event.killer, 'Winner');
        assert.equal(event.victim, 'Victim');
        assert.equal(event.weapon, 'shotgun');
    }

    broadcastSurvivState(room, io, lbData, {});
    assert.equal(Object.hasOwn(ticksBySocket.get(attacker.id)[1], 'killFeed'), false);
    assert.equal(Object.hasOwn(ticksBySocket.get(victim.id)[1], 'killFeed'), false);
});
test('cashout hold freezes movement and discards queued gameplay actions', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('cashout-hold-player', 'mongo-cashout-hold', 'Holding', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inputDx = 1;
    player.inputDy = 1;
    player.shooting = true;
    player.useMedkit = true;
    player.pickupWeaponPending = true;
    player.equipSlotPending = 1;
    player.throwGrenadePending = true;
    player.swapWeaponSlots = { fromSlot: 0, toSlot: 1 };
    player.dropItemPending = { itemKey: 'grenades' };
    player.openChestId = 'stale-chest';
    player.takeChestItem = { chestId: 'stale-chest', itemKey: 'weapon' };
    player.cashoutHoldActive = true;
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(player.x, 0);
    assert.equal(player.y, 0);
    assert.equal(player.inputDx, 0);
    assert.equal(player.inputDy, 0);
    assert.equal(player.shooting, false);
    assert.equal(player.useMedkit, false);
    assert.equal(player.pickupWeaponPending, false);
    assert.equal(player.equipSlotPending, null);
    assert.equal(player.throwGrenadePending, false);
    assert.equal(player.swapWeaponSlots, null);
    assert.equal(player.dropItemPending, null);
    assert.equal(player.openChestId, null);
    assert.equal(player.takeChestItem, null);
});
for (const isBot of [false, true]) {
    for (const flag of ['cashoutHoldActive', 'isCashingOut']) {
        test(`Surviv ${isBot ? 'bot' : 'human'} ${flag} blocks AI/actions and stays vulnerable`, () => {
            const room = {
                id: 'surviv-cashout', entryFeeUsd: 5, players: [], bots: [],
                obstacles: [], loot: [], bullets: [], spawnPoints: [],
                _nextSurvivBotSyncAt: Infinity,
            };
            const player = createSurvivPlayer('holding', 'mongo-holding', 'Holding', '#fff', room);
            Object.assign(player, {
                isBot, x: 0, y: 0, angle: 0.3, aimAngle: 0.3,
                inputDx: 1, inputDy: 1, shooting: true, botThinkAt: 0,
                [flag]: true, useMedkit: true, pickupWeaponPending: true,
                equipSlotPending: 1, throwGrenadePending: true,
                chestHoldId: 'stale', _pendingFirePressId: 123,
            });
            (isBot ? room.bots : room.players).push(player);
            processSurvivRoom(room, silentIo, Date.now() + 600000);
            assert.equal(player.x, 0);
            assert.equal(player.y, 0);
            assert.equal(player.angle, 0.3);
            assert.equal(player.aimAngle, 0.3);
            assert.equal(player.botThinkAt, 0, 'bot AI must not run');
            assert.equal(player.shooting, false);
            assert.equal(player.useMedkit, false);
            assert.equal(player.pickupWeaponPending, false);
            assert.equal(player.equipSlotPending, null);
            assert.equal(player.throwGrenadePending, false);
            assert.equal(player.chestHoldId, null);
            assert.equal(player._pendingFirePressId, null);
            assert.equal(room.bullets.length, 0);

            player.x = SURVIV.worldHalf;
            player._lastZoneDamageAt = Date.now() - 200;
            processSurvivRoom(room, silentIo, Date.now() + 1000);
            assert.ok(player.hp < player.maxHp, 'cashout must still take zone damage');

            player[flag] = false;
            player.x = 0;
            player.inputDx = 1;
            processSurvivRoom(room, silentIo, Date.now() + 600000);
            if (isBot) assert.ok(player.botThinkAt > 0, 'AI resumes after cancellation');
            else assert.ok(player.x > 0, 'movement resumes after cancellation');
        });
    }
}

test('analog movement strength matches mobile client prediction', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('analog-player', 'analog-mongo', 'Analog', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inputDx = 0.5;
    player.inputDy = 0;
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.ok(Math.abs(player.x - SURVIV.playerSpeed * 0.5) < 0.001);

    const halfSpeedX = player.x;
    player.inputDx = 1;
    processSurvivRoom(room, silentIo, Date.now() + 600001);
    assert.ok(Math.abs((player.x - halfSpeedX) - SURVIV.playerSpeed) < 0.001);
});

test('players walk beneath tree canopies and stop only at the trunk', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room.bots = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [{
        id: 'trunk-only-tree', kind: 'tree', x: 60, y: 0, w: 100, h: 100,
        hitboxW: 20, hitboxH: 20, trunkScale: 0.2,
        collidable: true, destructible: true, hp: 84, maxHp: 84,
    }];
    const player = createSurvivPlayer('tree-walker', 'tree-walker-mongo', 'Walker', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inputDx = 1;
    player.inputDy = 0;
    room.players.push(player);

    for (let tick = 0; tick < 4; tick++) {
        processSurvivRoom(room, silentIo, Date.now() + 600000 + tick);
    }
    assert.ok(player.x > 18, 'the visual canopy must not block entry beneath the leaves');

    for (let tick = 0; tick < 8; tick++) {
        processSurvivRoom(room, silentIo, Date.now() + 600100 + tick);
    }
    assert.ok(player.x >= 35.9 && player.x <= 36.1,
        'the player should stop at the trunk plus player radius');
});

test('explicit obstacle hitboxes are clamped inside visible bounds', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room.bots = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [{
        id: 'oversized-hitbox-rock', kind: 'rock', x: 60, y: 0, w: 30, h: 30,
        hitboxW: 120, hitboxH: 120,
        collidable: true, destructible: true, hp: 72, maxHp: 72,
    }];
    const player = createSurvivPlayer('hitbox-walker', 'hitbox-walker-mongo', 'Walker', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inputDx = 1;
    player.inputDy = 0;
    room.players.push(player);

    for (let tick = 0; tick < 12; tick++) {
        processSurvivRoom(room, silentIo, Date.now() + 700000 + tick);
    }
    assert.ok(player.x >= 30.9 && player.x <= 31.1,
        'even malformed metadata must stop at the visible rock edge plus player radius');
});

test('water slows movement while bridges and indoor floors report the correct surface', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('surface-player', 'surface-mongo', 'Wader', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inputDx = 1;
    player.inputDy = 0;
    room.players.push(player);

    room.obstacles = [{
        id: 'test-water', kind: 'water', variant: 'pond', x: 0, y: 0,
        w: 300, h: 220, rotation: 0, collidable: false,
    }];
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.ok(Math.abs(player.x - SURVIV.playerSpeed * SURVIV.waterMoveMultiplier) < 0.001);
    assert.equal(player.surface, 'water');

    player.x = 0;
    player.y = 0;
    room.obstacles = [
        ...room.obstacles,
        { id: 'test-bridge', kind: 'bridge', x: 0, y: 0, w: 180, h: 60, rotation: 0, collidable: false },
    ];
    processSurvivRoom(room, silentIo, Date.now() + 600001);
    assert.ok(Math.abs(player.x - SURVIV.playerSpeed) < 0.001);
    assert.equal(player.surface, 'ground');

    player.x = 0;
    player.y = 0;
    room.obstacles = [{
        id: 'test-house', kind: 'houseFloor', x: 0, y: 0,
        w: 240, h: 180, rotation: 0, collidable: false,
    }];
    processSurvivRoom(room, silentIo, Date.now() + 600002);
    assert.ok(Math.abs(player.x - SURVIV.playerSpeed) < 0.001);
    assert.equal(player.surface, 'indoor');
});

test('full-auto fire slows movement while semi-auto fire does not', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('firing-movement', 'firing-movement-mongo', 'Gunner', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inputDx = 1;
    player.inputDy = 0;
    player.shooting = true;
    player.weapon = { type: 'smg', ammo: 30, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.ok(Math.abs(player.x - SURVIV.playerSpeed * WEAPONS.smg.firingMoveMultiplier) < 0.001);

    const autoX = player.x;
    player.shooting = false;
    processSurvivRoom(room, silentIo, Date.now() + 600001);
    assert.ok(Math.abs((player.x - autoX) - SURVIV.playerSpeed) < 0.001);

    const normalX = player.x;
    player.weapon = { type: 'pistol', ammo: 15, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.shooting = true;
    processSurvivRoom(room, silentIo, Date.now() + 600200);
    assert.ok(Math.abs((player.x - normalX) - SURVIV.playerSpeed) < 0.001);
});

test('human semi-auto guns fire once per click but accept rapid new clicks', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('semi-auto-player', 'semi-auto-mongo', 'Clicker', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.weapon = { type: 'pistol', ammo: 15, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.shooting = true;
    room.players.push(player);
    const now = Date.now() + 600000;

    processSurvivRoom(room, silentIo, now);
    assert.equal(player.weapon.ammo, 14);

    processSurvivRoom(room, silentIo, now + WEAPONS.pistol.fireRateMs + 20);
    assert.equal(player.weapon.ammo, 14, 'holding the trigger must not repeat a semi-auto shot');

    // processSurvivRoom intentionally uses the live server clock. Advance the
    // weapon cooldown explicitly so this synchronous test can model the next
    // valid rapid click without sleeping.
    player.weapon.lastShotAt -= WEAPONS.pistol.fireRateMs + 1;
    player.shooting = false;
    processSurvivRoom(room, silentIo, now + WEAPONS.pistol.fireRateMs + 21);
    player.shooting = true;
    processSurvivRoom(room, silentIo, now + WEAPONS.pistol.fireRateMs + 22);
    assert.equal(player.weapon.ammo, 13, 'a released and pressed trigger should fire again quickly');
});

test('automatic guns emit one projectile per cadence step with progressive spread', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('auto-cadence-player', 'auto-cadence-mongo', 'Sprayer', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.weapon = { type: 'm416', ammo: 30, reloading: false, reloadEndAt: 0, lastShotAt: 0 };
    player.shooting = true;
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);
    assert.equal(player.weapon.ammo, 29);
    assert.equal(room.bullets.length, 1, 'one automatic cadence step must create one projectile');

    processSurvivRoom(room, silentIo, Date.now() + 600001);
    assert.equal(player.weapon.ammo, 29, 'the same cadence window must not create a duplicate round');
    assert.equal(room.bullets.length, 1);

    player.weapon.lastShotAt -= WEAPONS.m416.fireRateMs + 1;
    processSurvivRoom(room, silentIo, Date.now() + 600100);
    assert.equal(player.weapon.ammo, 28);
    assert.equal(room.bullets.length, 2);
    assert.equal(new Set(room.bullets.map(bullet => bullet.shotId)).size, 2,
        'successive automatic rounds need distinct shot identities');
    assert.ok(room.bullets.every(bullet => bullet.shotId && bullet.weaponType === 'm416'));
});

test('loot crates block movement until they are destroyed', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.spawnPoints = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.loot = [{
        id: 'solid-crate',
        type: 'chest',
        containerType: 'wood_crate',
        x: 50,
        y: 0,
        tier: 'common',
        hp: 18,
        maxHp: 18,
        hitRadius: 24,
        contents: {},
    }];
    const player = createSurvivPlayer('solid-crate-player', 'solid-crate-mongo', 'Blocked', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.inputDx = 1;
    player.inputDy = 0;
    room.players.push(player);

    for (let tick = 0; tick < 8; tick++) {
        processSurvivRoom(room, silentIo, Date.now() + 600000 + tick);
    }

    assert.ok(player.x <= 12.01, 'the player should stop at the crate collision radius');
    assert.equal(room.loot.some(item => item.id === 'solid-crate'), true);

    player.aimAngle = 0;
    player.shooting = true;
    player.weapon.lastShotAt = 0;
    processSurvivRoom(room, silentIo, Date.now() + 601000);
    assert.equal(room.loot.some(item => item.id === 'solid-crate'), false);

    player.shooting = false;
    for (let tick = 0; tick < 8; tick++) {
        processSurvivRoom(room, silentIo, Date.now() + 602000 + tick);
    }
    assert.ok(player.x > 20, 'movement should continue after the crate is broken');
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

test('melee hits on solid non-destructible props emit a material impact event', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room.bots = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [{
        id: 'solid-metal-locker', kind: 'furniture', variant: 'metal',
        x: 48, y: 0, w: 30, h: 30, collidable: true, destructible: false,
    }];
    const player = createSurvivPlayer('solid-impact-player', 'solid-impact-mongo', 'Striker', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.shooting = true;
    room.players.push(player);

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(room.obstacles.some(obstacle => obstacle.id === 'solid-metal-locker'), true);
    assert.equal(player._objectImpact?.kind, 'furniture');
    assert.equal(player._objectImpact?.variant, 'metal');
    assert.match(player._objectImpact?.id || '', /^solid-impact-player:/);
});

test('one held human melee press produces only one attack', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room.bots = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [{
        id: 'single-press-target', kind: 'bush', x: 48, y: 0, w: 30, h: 30,
        collidable: true, destructible: true, hp: 100, maxHp: 100,
    }];
    const player = createSurvivPlayer('single-press-player', 'single-press-mongo', 'Boxer', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.shooting = true;
    room.players.push(player);

    const resetAt = Date.now() + 600000;
    processSurvivRoom(room, silentIo, resetAt);
    player.weapon.lastShotAt = 0;
    processSurvivRoom(room, silentIo, resetAt);
    assert.equal(room.obstacles[0].hp, 82, 'holding one press must not trigger a second punch');

    player.shooting = false;
    processSurvivRoom(room, silentIo, resetAt);
    player.shooting = true;
    player.weapon.lastShotAt = 0;
    processSurvivRoom(room, silentIo, resetAt);
    assert.equal(room.obstacles[0].hp, 64, 'a new press should trigger the next punch');
});

test('duplicate packets with the same fire press id cannot create a second melee attack', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room.bots = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [{
        id: 'packet-target', kind: 'bush', x: 48, y: 0, w: 30, h: 30,
        collidable: true, destructible: true, hp: 100, maxHp: 100,
    }];
    const player = createSurvivPlayer('packet-player', 'packet-mongo', 'Packet Boxer', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    player.firePressId = 7;
    player.shooting = true;
    room.players.push(player);

    const now = Date.now() + 600000;
    processSurvivRoom(room, silentIo, now);
    assert.equal(room.obstacles[0].hp, 82);
    assert.equal(player.meleeAttackId, 1);
    const firstHand = player.meleeHand;

    player.shooting = false;
    processSurvivRoom(room, silentIo, now + 1);
    player.shooting = true;
    player.weapon.lastShotAt = 0;
    processSurvivRoom(room, silentIo, now + 1000);
    assert.equal(room.obstacles[0].hp, 82, 'a delayed duplicate id must be ignored');
    assert.equal(player.meleeAttackId, 1, 'a duplicate packet must not restart the animation');
    assert.equal(player.meleeHand, firstHand);

    player.firePressId = 8;
    player.weapon.lastShotAt = 0;
    processSurvivRoom(room, silentIo, now + 1001);
    assert.equal(room.obstacles[0].hp, 64, 'a genuinely new press id must attack once');
    assert.equal(player.meleeAttackId, 2);
    assert.notEqual(player.meleeHand, firstHand, 'distinct clicks should alternate hands');
});

test('a delayed final down packet cannot append a melee swing after release', () => {
    const room = makeRoom();
    room.loot = [];
    room.spawnPoints = [];
    room.bots = [];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [{
        id: 'sequence-target', kind: 'bush', x: 48, y: 0, w: 30, h: 30,
        collidable: true, destructible: true, hp: 500, maxHp: 500,
    }];
    const player = createSurvivPlayer('sequence-player', 'sequence-mongo', 'Sequence Boxer', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.aimAngle = 0;
    room.players.push(player);

    const startedAt = Date.now() + 600000;
    for (let pressId = 1; pressId <= 5; pressId++) {
        player.weapon.lastShotAt = 0;
        applySurvivFireInput(player, true, pressId);
        applySurvivFireInput(player, false, pressId);
        processSurvivRoom(room, silentIo, startedAt + pressId * 500);
    }
    assert.equal(player.meleeAttackId, 5);
    assert.equal(room.obstacles[0].hp, 500 - WEAPONS.fists.damage * 5);

    // Simulate a stale volatile down packet arriving after the reliable up for
    // the fifth click. It must not re-arm shooting or queue a sixth punch.
    assert.equal(applySurvivFireInput(player, true, 5), false);
    processSurvivRoom(room, silentIo, startedAt + 4000);
    assert.equal(player.shooting, false);
    assert.equal(player.meleeAttackId, 5);
    assert.equal(room.obstacles[0].hp, 500 - WEAPONS.fists.damage * 5);
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

    player.shooting = false;
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    player.shooting = true;
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
        {
            id: 'priority-chest',
            type: 'chest',
            containerType: 'armory_crate',
            x: 120,
            y: 0,
            tier: 'rare',
            hp: 18,
            maxHp: 18,
            hitRadius: 26,
            contents: { weaponType: 'assault', money: 1, rarity: 'rare' },
        },
    ];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const player = createSurvivPlayer('loot-observer', 'loot-observer-mongo', 'Observer', '#fff', room);
    player.x = 1800;
    player.y = 1800;
    room.players.push(player);
    const bot = spawnSurvivBotNear(room, 0, 0, { adminSpawned: true });

    bot.x = 70;
    bot.y = 0;
    bot.botThinkAt = 0;
    bot.weapon.lastShotAt = 0;
    processSurvivRoom(room, silentIo, Date.now() + 600000);
    for (const item of room.loot) item.pickupAfter = 0;
    for (let tick = 0; tick < 32; tick++) {
        bot.botThinkAt = 0;
        processSurvivRoom(room, silentIo, Date.now() + 600000);
    }

    assert.ok(bot.inventory.weapons.includes('assault'), 'bot should break and pick up the dropped crate weapon');
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

test('unarmed surviv bots remember valuable weapon loot across the map', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [{
        id: 'distant-rifle', type: 'weapon', weaponType: 'm416',
        x: 6200, y: 700, ammo: 30, tier: 'rare',
    }];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const observer = createSurvivPlayer('distant-observer', 'distant-observer-mongo', 'Observer', '#fff', room);
    observer.x = -9000;
    observer.y = -9000;
    room.players.push(observer);
    const bot = spawnSurvivBotNear(room, 0, 0, { adminSpawned: true });

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.equal(bot.botLootTargetId, 'distant-rifle');
    assert.ok(bot.inputDx > 0.8, 'the bot should commit to the remembered loot site');
    assert.ok(bot.inputDy > 0, 'the bot should travel toward the actual loot position');
});

test('surviv bots replace a weak full-slot weapon with a stronger pickup', () => {
    const room = makeRoom();
    room.obstacles = [];
    room.loot = [{
        id: 'bot-upgrade', type: 'weapon', weaponType: 'm416',
        x: 0, y: 0, ammo: 30, tier: 'rare',
    }];
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    const observer = createSurvivPlayer('upgrade-observer', 'upgrade-observer-mongo', 'Observer', '#fff', room);
    observer.x = 5000;
    observer.y = 5000;
    room.players.push(observer);
    const bot = spawnSurvivBotNear(room, 0, 0, { adminSpawned: true });
    bot.inventory.weapons = ['m9', 'ot38'];
    bot.activeWeaponSlot = 0;
    bot.weaponSlotAmmo = [15, 5];
    bot.weapon = { type: 'm9', ammo: 15, reloading: false, reloadEndAt: 0, lastShotAt: 0 };

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.ok(bot.inventory.weapons.includes('m416'));
    assert.equal(room.loot.some(item => item.id === 'bot-upgrade' && item.weaponType === 'm416'), false);
});

test('surviv bots route around a house wall toward its exterior loot entrance', () => {
    const room = makeRoom();
    room._nextSurvivBotSyncAt = Number.POSITIVE_INFINITY;
    room.obstacles = [
        { id: 'house-floor', kind: 'houseFloor', x: 0, y: 0, w: 220, h: 180, collidable: false },
        { id: 'east-wall', kind: 'wall', houseId: 'house-floor', x: 110, y: 0, w: 14, h: 180, collidable: true },
        { id: 'north-wall', kind: 'wall', houseId: 'house-floor', x: 0, y: -90, w: 220, h: 14, collidable: true },
        { id: 'south-wall', kind: 'wall', houseId: 'house-floor', x: 0, y: 90, w: 220, h: 14, collidable: true },
        { id: 'west-door', kind: 'door', houseId: 'house-floor', x: -110, y: 0, w: 6, h: 52, collidable: true, role: 'west', entranceRole: 'mainEntrance', isOpen: false },
    ];
    room.loot = [{
        id: 'indoor-armory', type: 'chest', containerType: 'armory_crate',
        houseId: 'house-floor', x: 0, y: 0, hp: 30, maxHp: 30,
        hitRadius: 26, tier: 'rare', contents: { weaponType: 'm416' },
    }];
    const observer = createSurvivPlayer('house-observer', 'house-observer-mongo', 'Observer', '#fff', room);
    observer.x = 5000;
    observer.y = 5000;
    room.players.push(observer);
    const bot = spawnSurvivBotNear(room, 320, 0, { adminSpawned: true });

    processSurvivRoom(room, silentIo, Date.now() + 600000);

    assert.ok(bot.inputDx < 0, 'the bot should still make progress toward the building');
    assert.ok(Math.abs(bot.inputDy) > 0.25, 'the bot should choose a side route instead of walking into the wall');
    assert.equal(bot.botDoorTargetId, 'west-door');
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
    assert.ok(Array.isArray(ticks[0].fullMap?.obstacles));
    assert.ok(ticks[0].fullMap.obstacles.length > ticks[0].minimap.obstacles.length);
    assert.ok(Array.isArray(ticks[0].fullMap.landmarks));
    assert.equal(ticks[0].obstaclePatch.x, player.x);
    assert.equal(ticks[0].obstaclePatch.y, player.y);
    assert.ok(ticks[0].obstaclePatch.retainRange > ticks[0].obstaclePatch.range);
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
    const serializedTree = ticks[0].obstacles.find(obstacle => obstacle.kind === 'tree');
    assert.ok(serializedTree);
    assert.ok(serializedTree.canopyStyle === 'surviv' || serializedTree.canopyStyle === 'legacy');
    assert.ok(serializedTree.hitboxW > 0 && serializedTree.hitboxW < serializedTree.w);
    assert.ok(serializedTree.hitboxH > 0 && serializedTree.hitboxH < serializedTree.h);
    assert.ok(serializedTree.trunkScale > 0);
    assert.ok(['standard', 'large', 'giant'].includes(serializedTree.treeSize));
    assert.equal(Object.hasOwn(ticks[1], 'obstacles'), false);
    assert.equal(Object.hasOwn(ticks[1], 'minimap'), false);
    assert.equal(Object.hasOwn(ticks[1], 'fullMap'), false);
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

test('surviv expanded map exposes coarse activity areas without exact enemy positions', () => {
    const room = makeRoom();
    const viewer = createSurvivPlayer('map-viewer', 'mongo-map-viewer', 'Viewer', '#fff', room);
    const enemy = createSurvivPlayer('map-enemy', 'mongo-map-enemy', 'Enemy', '#f00', room);
    viewer.x = 0;
    viewer.y = 0;
    enemy.x = 9837;
    enemy.y = 9463;
    room.players.push(viewer, enemy);

    const ticksByViewer = new Map();
    const io = {
        to(socketId) {
            return {
                emit(event, payload) {
                    if (event === 'survivTick') ticksByViewer.set(socketId, payload);
                },
            };
        },
    };
    broadcastSurvivState(room, io, {
        leaderboard: [],
        aliveCount: 2,
        zone: { x: 0, y: 0, radius: SURVIV.worldHalf },
    }, {});

    const tick = ticksByViewer.get(viewer.id);
    assert.ok(tick.fullMap);
    assert.ok(tick.activityZones.length >= 1);
    const activity = tick.activityZones.find(candidate => (
        Math.hypot(candidate.x - enemy.x, candidate.y - enemy.y) <= candidate.radius
    ));
    assert.ok(activity);
    assert.ok(activity.radius >= 1200);
    assert.ok(Math.abs(activity.x) <= SURVIV.worldHalf - 1200);
    assert.ok(Math.abs(activity.y) <= SURVIV.worldHalf - 1200);
    assert.notEqual(activity.x, enemy.x);
    assert.notEqual(activity.y, enemy.y);
    assert.equal(tick.fullMap.obstacles.some(obstacle => obstacle.kind === 'door'), false);
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

test('surviv spectators receive lightweight targets for players outside the rendered view', () => {
    const room = makeRoom();
    room.loot = [];
    const nearby = createSurvivPlayer('nearby-player', 'mongo-nearby', 'Nearby', '#fff', room);
    const distant = createSurvivPlayer('distant-player', 'mongo-distant', 'Distant', '#fff', room);
    nearby.x = -5000;
    nearby.y = 0;
    distant.x = 5000;
    distant.y = 0;
    room.players.push(nearby, distant);
    room.spectators.push({ id: 'spectator', x: -5000, y: 0, dollarBalance: 0 });

    const ticks = new Map();
    const io = {
        to(socketId) {
            return {
                emit(event, payload) {
                    if (event === 'survivTick') ticks.set(socketId, payload);
                },
            };
        },
    };
    const lbData = {
        leaderboard: [],
        aliveCount: 2,
        zone: { x: 0, y: 0, radius: SURVIV.worldHalf },
    };

    broadcastSurvivState(room, io, lbData, {});

    const spectatorTick = ticks.get('spectator');
    assert.ok(spectatorTick.players.some(player => player.id === nearby.id));
    assert.equal(spectatorTick.players.some(player => player.id === distant.id), false);
    assert.deepEqual(
        new Set(spectatorTick.spectateTargets.map(player => player.id)),
        new Set([nearby.id, distant.id]),
    );
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
