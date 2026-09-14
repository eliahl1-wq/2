import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRoomCashoutReservation } from './cashout-accounting.js';

test('room settlement cannot pay more than the funded reset-cycle pool', () => {
    const reservation = calculateRoomCashoutReservation({
        requestedUsd: 7,
        fundedUsd: 10,
        reservedUsd: 1,
        paidUsd: 7,
    });
    assert.equal(reservation.requestedUsd, 7);
    assert.equal(reservation.availableUsd, 2);
    assert.equal(reservation.payableUsd, 2);
    assert.equal(reservation.ledgerShortfallUsd, 5);
    assert.equal(reservation.nextReservedUsd, 3);
});

test('room audit reports no shortfall when the full amount is funded', () => {
    const reservation = calculateRoomCashoutReservation({
        requestedUsd: 6.5,
        fundedUsd: 20,
        reservedUsd: 2,
        paidUsd: 5,
    });
    assert.equal(reservation.requestedUsd, 6.5);
    assert.equal(reservation.availableUsd, 13);
    assert.equal(reservation.payableUsd, 6.5);
    assert.equal(reservation.ledgerShortfallUsd, 0);
});
