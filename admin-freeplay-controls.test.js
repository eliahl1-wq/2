import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { grantAdminSlitherGrowth, SLITHER } from './slither-engine.js';
import { getEconomy } from './economy.js';

// Exercise the actual socket registration without starting payments or MongoDB.
const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const handlerSource = source.slice(source.indexOf("    socket.on('adminFreePlayAction'"), source.indexOf("    socket.on('adminClearBots'"));
function fixture(mode = 'agar', free = true) {
    const player = { id: 'socket', mode, x: 0, y: 0, balance: 1, dollarBalance: 2, fam: 0,
        cells: [{ x: 200, y: 200, balance: 1, radius: 10 }],
        segments: [{ x: 0, y: 0 }, { x: -4, y: 0 }] };
    const room = { entryFeeUsd: 10, isPersonalFreePlay: free, players: [player], food: [], slitherFood: [] };
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
    test(`${mode}: actual admin socket action adds visible nearby food and grows the player`, async () => {
        const { player, room, run } = fixture(mode);
        assert.equal((await run('food')).ok, true);
        const food = mode === 'agar' ? room.food : room.slitherFood;
        assert.equal(food.length, 250);
        assert.ok(food.every(f => Number.isFinite(f.x) && Number.isFinite(f.y) && f.dollarValue === 0));
        assert.ok(food.every(f => Math.hypot(f.x - (mode === 'agar' ? 200 : 0), f.y - (mode === 'agar' ? 200 : 0)) <= 501));
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
