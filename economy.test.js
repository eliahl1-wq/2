import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ALLOWED_ENTRY_FEES,
    getEconomy,
    getJoinPoolSplit,
} from './economy.js';

const populations = [1, 2, 3, 7, 8, 30];

for (const entryFeeUsd of ALLOWED_ENTRY_FEES) {
    for (const population of populations) {
        test(`$${entryFeeUsd} join conserves value at population ${population}`, () => {
            const eco = getEconomy(entryFeeUsd);
            const { food, ai } = getJoinPoolSplit(entryFeeUsd, population);
            const total = eco.playerStartBalance + food + ai;
            assert.equal(total, entryFeeUsd);
            assert.ok(food >= 0);
            assert.ok(ai >= 0);
        });
    }
}
