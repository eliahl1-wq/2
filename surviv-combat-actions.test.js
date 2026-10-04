import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SURVIV_AMMO,
    WEAPONS,
    applySurvivFireInput,
    beginSurvivReload,
    cancelSurvivAction,
    createSurvivPlayer,
    eliminateSurvivPlayer,
    equipSurvivWeaponSlot,
    processSurvivRoom,
} from './surviv-engine.js';
import { applySurvivInputPayload } from './surviv-input.js';

const io = { to: () => ({ emit() {} }) };

function fixture(t, weapons = ['m416', 'm9']) {
    let now = 1900000000000;
    t.mock.method(Date, 'now', () => now);
    const room = {
        id: 'combat-actions', isBattleRoyale: true, entryFeeUsd: 5,
        players: [], bots: [], loot: [], obstacles: [], bullets: [], spectators: [],
        spawnPoints: [{ x: 0, y: 0 }],
    };
    const player = createSurvivPlayer('human', 'user', 'Player', '#fff', room);
    player.x = 0;
    player.y = 0;
    player.dollarBalance = 0;
    player.inventory.weapons = weapons;
    player.activeWeaponSlot = 0;
    player.weaponSlotAmmo = weapons.map(id => WEAPONS[id].clipSize);
    player.weapon = {
        type: weapons[0], ammo: WEAPONS[weapons[0]].clipSize,
        reloading: false, reloadEndAt: 0, reloadAmount: 0, lastShotAt: 0,
    };
    room.players.push(player);
    return {
        player, room,
        get now() { return now; },
        advance(ms = 0) { now += ms; processSurvivRoom(room, io, now + 600000); },
        press(id, ms = 0) {
            now += ms;
            applySurvivFireInput(player, true, id);
            applySurvivFireInput(player, false, id);
            processSurvivRoom(room, io, now + 600000);
        },
    };
}

test('switching or stowing refunds reserved reload rounds exactly once', t => {
    for (const slot of [1, 2]) {
        const f = fixture(t);
        f.player.weapon.ammo = 10;
        f.player.inventory.ammoReserves['556'] = 70;
        assert.equal(beginSurvivReload(f.player, f.now), true);
        assert.equal(f.player.inventory.ammoReserves['556'], 50);
        assert.equal(equipSurvivWeaponSlot(f.player, slot), true);
        assert.equal(f.player.inventory.ammoReserves['556'], 70);
        assert.equal(cancelSurvivAction(f.player), false);
        assert.equal(f.player.inventory.ammoReserves['556'], 70);
        assert.equal(equipSurvivWeaponSlot(f.player, 0), true);
        assert.equal(f.player.weapon.ammo, 10);
    }
});

test('reselecting the active slot preserves its reload and firing cadence', t => {
    const f = fixture(t);
    f.player.weapon.ammo = 10;
    f.player.inventory.ammoReserves['556'] = 70;
    beginSurvivReload(f.player, f.now);
    const weapon = f.player.weapon;
    const endAt = weapon.reloadEndAt;
    assert.equal(equipSurvivWeaponSlot(f.player, 0), true);
    assert.equal(f.player.weapon, weapon);
    assert.equal(weapon.reloading, true);
    assert.equal(weapon.reloadEndAt, endAt);
    assert.equal(f.player.inventory.ammoReserves['556'], 50);
    cancelSurvivAction(f.player);
    applySurvivFireInput(f.player, true, 1);
    f.advance();
    assert.equal(f.player.weapon.ammo, 9);
    equipSurvivWeaponSlot(f.player, 0);
    f.advance(20);
    assert.equal(f.player.weapon.ammo, 9, 'slot selection must not manufacture another automatic shot');
});

test('two identical guns retain independent ammunition and cooldowns across switching and slot swapping', t => {
    const f = fixture(t, ['m9', 'm9']);
    f.press(1);
    assert.equal(f.player.weapon.ammo, 14);
    equipSurvivWeaponSlot(f.player, 1);
    f.press(2, 25);
    assert.equal(f.player.weapon.ammo, 14, 'the other gun can fire independently');
    equipSurvivWeaponSlot(f.player, 0);
    f.press(3, 25);
    assert.equal(f.player.weapon.ammo, 14, 'cycling back must not bypass this gun\'s cadence');
    f.player.swapWeaponSlots = { fromSlot: 0, toSlot: 1 };
    f.advance();
    assert.equal(f.player.activeWeaponSlot, 1);
    equipSurvivWeaponSlot(f.player, 0);
    f.press(4, 10);
    assert.equal(f.player.weapon.ammo, 14, 'the cooldown must follow the actual gun when slots move');
    f.press(5, WEAPONS.m9.fireRateMs);
    assert.equal(f.player.weapon.ammo, 13);
});

test('removing an earlier gun slot keeps the remaining gun\'s magazine and cooldown', t => {
    const f = fixture(t, ['m9', 'm9']);
    equipSurvivWeaponSlot(f.player, 1);
    f.press(1);
    f.player.dropItemPending = { itemKey: 'weapon', slotIdx: 0 };
    f.advance();
    assert.equal(f.player.activeWeaponSlot, 0);
    assert.equal(f.player.weapon.ammo, 14);
    equipSurvivWeaponSlot(f.player, 2);
    equipSurvivWeaponSlot(f.player, 0);
    f.press(2, 25);
    assert.equal(f.player.weapon.ammo, 14);
    f.press(3, WEAPONS.m9.fireRateMs);
    assert.equal(f.player.weapon.ammo, 13);
});

test('cycling melee through a firearm cannot restart a punch inside its cadence window', t => {
    const f = fixture(t);
    equipSurvivWeaponSlot(f.player, 2);
    f.press(1);
    assert.equal(f.player.meleeAttackId, 1);
    equipSurvivWeaponSlot(f.player, 0);
    equipSurvivWeaponSlot(f.player, 2);
    f.press(2, 25);
    assert.equal(f.player.meleeAttackId, 1);
    f.press(3, WEAPONS.fists.fireRateMs);
    assert.equal(f.player.meleeAttackId, 2);
});

test('ammo pickup includes reload reservation in backpack capacity and leaves excess on the ground', t => {
    const f = fixture(t);
    f.player.weapon.ammo = 10;
    f.player.inventory.ammoReserves['556'] = SURVIV_AMMO['556'].max - 5;
    beginSurvivReload(f.player, f.now);
    f.room.loot.push({ id: 'ammo', type: 'ammo', ammoType: '556', amount: 30, x: 0, y: 0 });
    f.advance();
    assert.equal(f.room.loot[0].amount, 25);
    assert.equal(f.player.inventory.ammoReserves['556'], 160);
    assert.equal(cancelSurvivAction(f.player), true);
    assert.equal(f.player.inventory.ammoReserves['556'], 180);
    assert.equal(f.room.loot[0].amount, 25);
});

test('dropping or replacing an active reloading gun conserves its loaded and reserved rounds', t => {
    for (const replace of [false, true]) {
        const f = fixture(t);
        f.player.weapon.ammo = 10;
        f.player.inventory.ammoReserves['556'] = 70;
        beginSurvivReload(f.player, f.now);
        if (replace) {
            f.room.loot.push({ id: 'next-gun', type: 'weapon', weaponType: 'mp5', ammo: 8, x: 0, y: 0 });
            f.player.pickupWeaponPending = 'next-gun';
        } else {
            f.player.dropItemPending = { itemKey: 'weapon', slotIdx: 0 };
        }
        f.advance();
        assert.equal(f.player.inventory.ammoReserves['556'], 70);
        const previous = f.room.loot.find(item => item.weaponType === 'm416');
        assert.equal(previous.ammo, 10);
        assert.equal(f.player.weapon.type, replace ? 'mp5' : 'm9');
    }
});

test('death during reload drops reserved ammunition instead of deleting it', t => {
    const f = fixture(t);
    f.player.weapon.ammo = 10;
    f.player.inventory.ammoReserves['556'] = 70;
    beginSurvivReload(f.player, f.now);
    eliminateSurvivPlayer(f.room, f.player, io);
    const ammo = f.room.loot.find(item => item.type === 'ammo' && item.ammoType === '556');
    assert.equal(ammo.amount, 70);
    assert.equal(f.room.loot.find(item => item.weaponType === 'm416').ammo, 10);
});

test('completed reload cannot be refunded again by a later cancel', t => {
    const f = fixture(t);
    f.player.weapon.ammo = 10;
    f.player.inventory.ammoReserves['556'] = 70;
    beginSurvivReload(f.player, f.now);
    f.advance(WEAPONS.m416.reloadMs);
    assert.equal(f.player.weapon.ammo, 30);
    assert.equal(f.player.inventory.ammoReserves['556'], 50);
    assert.equal(cancelSurvivAction(f.player), false);
    assert.equal(f.player.inventory.ammoReserves['556'], 50);
});

test('medkit use interrupts reload and queued clicks cannot shoot through the healing action', t => {
    const f = fixture(t, ['m9', 'mp5']);
    f.player.hp = 40;
    f.player.inventory.medkits = 2;
    f.player.weapon.ammo = 5;
    f.player.inventory.ammoReserves['9mm'] = 30;
    beginSurvivReload(f.player, f.now);
    f.player.useMedkit = true;
    f.advance();
    assert.equal(f.player.weapon.reloading, false);
    assert.equal(f.player.inventory.ammoReserves['9mm'], 30);
    assert.equal(beginSurvivReload(f.player, f.now), false);
    f.press(1, 25);
    assert.equal(f.player.weapon.ammo, 5);
    assert.equal(f.room.bullets.length, 0);
    assert.equal(f.player.hp, 40);
    applySurvivInputPayload(f.player, { cancelAction: true });
    assert.equal(f.player.medkitUseEndAt, 0);
    assert.equal(f.player.inventory.medkits, 2);
    f.press(2, 25);
    assert.equal(f.player.weapon.ammo, 4, 'a fresh click after cancellation should fire normally');
});

test('X cancellation is idempotent and wins over simultaneous reload/heal requests', t => {
    const f = fixture(t);
    f.player.weapon.ammo = 10;
    f.player.inventory.ammoReserves['556'] = 70;
    beginSurvivReload(f.player, f.now);
    applySurvivInputPayload(f.player, { cancelAction: true, reload: true, useMedkit: true });
    assert.equal(f.player.weapon.reloading, false);
    assert.equal(f.player.inventory.ammoReserves['556'], 70);
    assert.equal(f.player.useMedkit, false);
    applySurvivInputPayload(f.player, { cancelAction: true });
    assert.equal(f.player.inventory.ammoReserves['556'], 70);
});

test('switching to a different weapon cancels healing; invalid or current slots do not', t => {
    const f = fixture(t);
    f.player.hp = 40;
    f.player.inventory.medkits = 2;
    f.player.useMedkit = true;
    f.advance();
    const endAt = f.player.medkitUseEndAt;
    equipSurvivWeaponSlot(f.player, 99);
    equipSurvivWeaponSlot(f.player, 0);
    assert.equal(f.player.medkitUseEndAt, endAt);
    equipSurvivWeaponSlot(f.player, 1);
    assert.equal(f.player.medkitUseEndAt, 0);
    assert.equal(f.player.inventory.medkits, 2);
});

test('a dropped stowed knife does not unequip or cancel the current firearm', t => {
    const f = fixture(t);
    f.player.inventory.meleeWeapon = 'knife';
    f.player.weapon.ammo = 10;
    f.player.inventory.ammoReserves['556'] = 70;
    beginSurvivReload(f.player, f.now);
    f.player.dropItemPending = { itemKey: 'weapon', slotIdx: 2 };
    f.advance();
    assert.equal(f.player.activeWeaponSlot, 0);
    assert.equal(f.player.weapon.type, 'm416');
    assert.equal(f.player.weapon.reloading, true);
    assert.equal(f.player.inventory.meleeWeapon, 'fists');
    assert.equal(f.room.loot[0].weaponType, 'knife');
});

test('ground weapon interaction respects pickup lock and circular reach', t => {
    const f = fixture(t);
    f.room.loot.push({ id: 'locked', type: 'weapon', weaponType: 'mp5', ammo: 3, x: 0, y: 0, pickupAfter: f.now + 900 });
    f.player.pickupWeaponPending = 'locked';
    f.advance();
    assert.equal(f.player.weapon.type, 'm416');
    f.player.pickupWeaponPending = 'locked';
    f.advance(900);
    assert.equal(f.player.weapon.type, 'mp5');
    f.room.loot.push({ id: 'diagonal', type: 'weapon', weaponType: 'awms', x: 50, y: 50 });
    f.player.pickupWeaponPending = 'diagonal';
    f.advance();
    assert.equal(f.player.weapon.type, 'mp5', 'spatial-query box corners are outside interaction reach');
});

test('.308 rounds from the standard AWM-S can be dropped through normal input validation', t => {
    const f = fixture(t);
    f.player.inventory.ammoReserves['308'] = 10;
    applySurvivInputPayload(f.player, { dropItem: { itemKey: 'ammo', ammoType: '308' } });
    f.advance();
    assert.equal(f.player.inventory.ammoReserves['308'], 5);
    assert.equal(f.room.loot[0].ammoType, '308');
    assert.equal(f.room.loot[0].amount, 5);
});
