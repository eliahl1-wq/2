import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { grantAdminSlitherGrowth, SLITHER, syncSlitherFood, processSlitherRoom } from './slither-engine.js';
import { queueAdminFood } from './admin-food-pool.js';
import { getEconomy } from './economy.js';

// Exercise the actual socket registration without starting payments or MongoDB.
const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const handlerSource = source.slice(source.indexOf("    socket.on('adminFreePlayAction'"), source.indexOf("    socket.on('adminClearBots'"));
function fixture(mode = 'agar', free = true) {
    const player = { id: 'socket', mode, x: 0, y: 0, balance: 1, dollarBalance: 2, fam: 0,
        cells: [{ x: 200, y: 200, balance: 1, radius: 10 }],
        segments: [{ x: 0, y: 0 }, { x: -4, y: 0 }] };
    const room = { entryFeeUsd: 10, isPersonalFreePlay: free, players: [player], food: [], slitherFood: [], foodPoolBalance: 0 };
    let handler;
    const context = {
        socket: { id: 'socket', on: (_, fn) => { handler = fn; }, emit() {} },
        verifyAccountToken: async token => { if (token !== 'admin') throw Error('invalid token'); return { id: 'admin' }; },
        User: { findById: async () => ({ isAdmin: true }) },
        isAdminUserRecord: user => user.isAdmin,
        getArenaRoomById: () => room, DEV_FREE_PLAY: false,
        getEconomy, DEFAULT_ENTRY_FEE: 10,
        SLITHER, c: { worldWidth: 6000, worldHeight: 6000 },
        getCompetitiveEffectiveRadius: () => 700,
        grantAdminSlitherGrowth,
        queueAdminFood,
        playerTotalMass: p => p.cells.reduce((n, cell) => n + cell.balance, 0),
        playerMassStart: () => 1, calculateCellRadius: mass => Math.sqrt(mass) * 10,
        console: { error() {} },
    };
    vm.runInNewContext(handlerSource, context);
    return { player, room, run: async action => {
        player._adminWorldActionAt = 0;
        let result;
        await handler({ token: 'admin', action }, value => { result = value; });
        return result;
    } };
}

for (const mode of ['agar', 'slither', 'competitive-slither']) {
    test(`${mode}: actual admin socket action queues standard pool food and grows the player`, async () => {
        const { player, room, run } = fixture(mode);
        assert.equal((await run('food')).ok, true);
        const food = mode === 'agar' ? room.food : room.slitherFood;
        assert.equal(food.length, 0, 'standard simulation ticks spawn the food');
        assert.equal(room.adminFoodExtraTargets[mode], 250);
        assert.equal(room.foodPoolBalance, mode === 'competitive-slither' ? 0 : 250 * getEconomy(10).foodBlobValue);
        assert.equal((await run('grow')).ok, true);
        if (mode === 'agar') assert.equal(player.cells[0].balance, 1.5);
        else {
            assert.equal(player.segments.length, 102);
            assert.ok(player.dollarBalance > 2, 'growth also credits practice dollars');
            assert.ok(player.balance > 1);
            if (mode === 'slither') {
                const eco = getEconomy(room.entryFeeUsd);
                assert.ok(Math.abs((player.balance - 1) / (player.dollarBalance - 2)
                    - eco.massPerPellet / eco.foodBlobValue) < 1e-9);
            }
        }
    });
    test(`${mode}: paid rooms reject admin world mutations with feedback`, async () => {
        const { player, room, run } = fixture(mode, false);
        assert.equal((await run('food')).ok, false);
        assert.equal((await run('grow')).ok, false);
        assert.equal(room.food.length + room.slitherFood.length, 0);
        assert.equal(player.balance, 1);
    });
}

test('queued normal Slither food spends the pool and gives real pickup mass, dollars and fullness', () => {
    const player = { id: 'player', mode: 'slither', balance: 1, dollarBalance: 2, fam: 0,
        segments: [{ x: 0, y: 0 }, { x: -4, y: 0 }], angle: 0, inputDx: 1, inputDy: 0 };
    const room = { entryFeeUsd: 10, players: [player], slitherBots: [], slitherFood: [],
        foodPoolBalance: 0, isSandbox: true, sandboxInvincible: true, sandboxBotAi: true };
    const eco = getEconomy(10);
    queueAdminFood(room, 'slither');
    for (let i = 0; i < 15; i++) {
        room._lastSlitherFoodSync = 0;
        syncSlitherFood(room, eco.foodBlobValue, room.foodPoolBalance, 1, 0);
    }
    assert.ok(room.slitherFood.length > 0);
    assert.ok(room.slitherFood.every(f => f.dollarValue === eco.foodBlobValue && f.balance === eco.massPerPellet && !f.adminSpawned));
    const onMap = room.slitherFood.reduce((sum, f) => sum + f.dollarValue, 0);
    assert.ok(Math.abs(onMap + room.foodPoolBalance - 250 * eco.foodBlobValue) < 1e-8);
    room.slitherFood = [{ ...room.slitherFood[0], x: 2, y: 0 }];
    processSlitherRoom(room, { to: () => ({ emit() {} }) }, null);
    assert.equal(player.balance, 1 + eco.massPerPellet);
    assert.equal(player.dollarBalance, 2 + eco.foodBlobValue);
    assert.ok(player.fam > 0);
});
