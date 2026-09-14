import test from 'node:test';
import assert from 'node:assert/strict';
import {
    agarEconomicVisualMass,
    allocateAgarEjectionValue,
    calculateNormalRoomValue,
    canAgarCellEat,
    proportionalAgarCellUsd,
} from './game-value-accounting.js';

test('Agar cell size and eat power follow proportional USD instead of mismatched raw mass', () => {
    const largerRawMassButLowerUsd = proportionalAgarCellUsd({
        playerUsd: 1.8,
        cellMass: 1.4,
        totalMass: 1.4,
    });
    const smallerRawMassButHigherUsd = proportionalAgarCellUsd({
        playerUsd: 2,
        cellMass: 1,
        totalMass: 1,
    });

    assert.equal(largerRawMassButLowerUsd, 1.8);
    assert.equal(smallerRawMassButHigherUsd, 2);
    assert.equal(canAgarCellEat({
        eaterCellUsd: largerRawMassButLowerUsd,
        victimCellUsd: smallerRawMassButHigherUsd,
    }), false);
    assert.equal(agarEconomicVisualMass({ cellUsd: 2, startingUsd: 2, startingMass: 1 }), 1);
    assert.equal(agarEconomicVisualMass({ cellUsd: 4, startingUsd: 2, startingMass: 1 }), 2);
});

test('Agar ejection cannot create USD when the player has less than the requested value', () => {
    assert.deepEqual(allocateAgarEjectionValue({
        availableUsd: 0.02,
        requestedUsd: 0.05,
        retainedRatio: 1,
    }), {
        debitedUsd: 0.02,
        ejectedUsd: 0.02,
        recycledUsd: 0,
    });
});

test('Agar ejection conserves spread between the drop and food pool', () => {
    const result = allocateAgarEjectionValue({
        availableUsd: 1,
        requestedUsd: 0.05,
        retainedRatio: 0.8,
    });
    assert.ok(Math.abs(result.debitedUsd - result.ejectedUsd - result.recycledUsd) < 1e-12);
});

test('normal-room invariant counts every live ledger exactly once', () => {
    const result = calculateNormalRoomValue({
        fundedEntryUsd: 10,
        players: [{ dollarBalance: 2 }, { dollarBalance: 4, _arenaCashoutReservationUsd: 4 }],
        bots: [{ dollarBalance: 1 }],
        slitherBots: [{ dollarBalance: 0.5 }],
        food: [{ dollarValue: 0.25 }],
        slitherFood: [{ dollarValue: 0.25 }],
        ejected: [{ dollarValue: 0.25 }],
        foodPoolBalance: 1,
        aiBudgetBalance: 0.25,
        ownerBalance: 0.5,
        reservedCashoutUsd: 4,
        paidCashoutUsd: 0,
    });
    assert.equal(result.accountedUsd, 10);
    assert.equal(result.excessUsd, 0);
});

test('normal-room invariant exposes duplicated value above paid funding', () => {
    const result = calculateNormalRoomValue({
        fundedEntryUsd: 2,
        players: [{ dollarBalance: 1.25 }],
        foodPoolBalance: 1,
    });
    assert.equal(result.excessUsd, 0.25);
});
