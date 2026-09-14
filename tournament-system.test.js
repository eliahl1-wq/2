import test from 'node:test';
import assert from 'node:assert/strict';
import {
    Tournament,
    getTournamentFormat,
    serializeTournament,
    tournamentSettings,
} from './tournament-system.js';

test('Mass Grab is a one-attempt $2 Agar tournament', () => {
    assert.deepEqual(getTournamentFormat('mass-grab'), {
        id: 'mass-grab',
        name: 'Mass Grab',
        gameMode: 'agar',
        entryFeeUsd: 2,
        maxAttempts: 1,
        gameplayEntryFeeUsd: 10,
        gameplayStartBalanceUsd: 2,
        imageUrl: '/mass-grab.png',
    });
});

test('Mass Grab schema defaults follow its tournament type', () => {
    const tournament = new Tournament({
        name: 'Mass Grab',
        tournamentType: 'mass-grab',
        startAt: new Date('2030-01-01T00:00:00Z'),
        endAt: new Date('2030-01-01T00:30:00Z'),
        createdBy: '507f1f77bcf86cd799439011',
    });

    assert.equal(tournament.gameMode, 'agar');
    assert.equal(tournament.entryFeeUsd, 2);
    assert.equal(tournament.maxAttempts, 1);
    assert.equal(tournament.gameplayStartBalanceUsd, 2);
    assert.equal(tournament.imageUrl, '/mass-grab.png');
});

test('legacy Balance Grab documents keep their Slither defaults', () => {
    assert.deepEqual(tournamentSettings({ gameMode: 'slither' }), {
        tournamentType: 'balance-grab',
        gameMode: 'slither',
        entryFeeUsd: 1,
        maxAttempts: 3,
        gameplayEntryFeeUsd: 10,
        gameplayStartBalanceUsd: 1,
        imageUrl: '/normal slither.png',
    });
});

test('serialized Mass Grab exposes one attempt and the supplied artwork', () => {
    const userId = { toString: () => 'user-1' };
    const tournament = serializeTournament({
        _id: { toString: () => 'tournament-1' },
        name: 'Mass Grab',
        tournamentType: 'mass-grab',
        gameMode: 'agar',
        entryFeeUsd: 2,
        maxAttempts: 1,
        gameplayEntryFeeUsd: 10,
        gameplayStartBalanceUsd: 2,
        imageUrl: '/mass-grab.png',
        totalEntryFeesUsd: 4,
        participants: [{
            userId,
            username: 'Player',
            entries: 1,
            tournamentBalanceUsd: 7.25,
        }],
    }, userId);

    assert.equal(tournament.tournamentType, 'mass-grab');
    assert.equal(tournament.gameMode, 'agar');
    assert.equal(tournament.entryFeeUsd, 2);
    assert.equal(tournament.maxAttempts, 1);
    assert.equal(tournament.gameplayStartBalanceUsd, 2);
    assert.equal(tournament.imageUrl, '/mass-grab.png');
    assert.equal(tournament.me.entries, 1);
    assert.equal(tournament.me.attemptsRemaining, 0);
});
