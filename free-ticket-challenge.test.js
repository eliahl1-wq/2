import test from 'node:test';
import assert from 'node:assert/strict';
import {
    hasUnlockedFreeTicket,
    isQualifyingFreeTicketCompletion,
} from './free-ticket-challenge.js';

function completion(overrides = {}) {
    const { meta = {}, ...rest } = overrides;
    return {
        type: 'game',
        status: 'confirmed',
        excludedFromReports: false,
        ...rest,
        meta: {
            event: 'death',
            reason: 'Arena Death',
            mode: 'agar',
            ...meta,
        },
    };
}

test('Agar, Slither, and Surviv Normal completions unlock the free-ticket challenge', () => {
    assert.equal(isQualifyingFreeTicketCompletion(completion()), true);
    assert.equal(isQualifyingFreeTicketCompletion(completion({ meta: { mode: 'slither' } })), true);
    assert.equal(isQualifyingFreeTicketCompletion(completion({ meta: { mode: 'surviv', reason: 'Surviv Death' } })), true);
    assert.equal(isQualifyingFreeTicketCompletion(completion({
        type: 'withdraw',
        meta: { mode: 'surviv', event: undefined, reason: 'Arena Cashout' },
    })), true);
    assert.equal(isQualifyingFreeTicketCompletion(completion({
        type: 'withdraw',
        meta: { mode: 'surviv', event: undefined, reason: 'Auto Room Reset' },
    })), true);
});

test('Arena, BR, tournament, free-ticket, and simulated games do not qualify', () => {
    assert.equal(isQualifyingFreeTicketCompletion(completion({ meta: { mode: 'competitive-slither' } })), false);
    assert.equal(isQualifyingFreeTicketCompletion(completion({ meta: { mode: 'slither', reason: 'BR Eliminated' } })), false);
    assert.equal(isQualifyingFreeTicketCompletion(completion({ meta: { mode: 'slither', reason: 'Tournament Death' } })), false);
    assert.equal(isQualifyingFreeTicketCompletion(completion({ meta: { isFreeTicketPlay: true } })), false);
    assert.equal(isQualifyingFreeTicketCompletion(completion({ meta: { simulated: true } })), false);
    assert.equal(isQualifyingFreeTicketCompletion(completion({ excludedFromReports: true })), false);
});

test('a ticket is usable only after its challenge is complete', () => {
    assert.equal(hasUnlockedFreeTicket({ hasFreeTicket: true, freeTicketUsed: false }), false);
    assert.equal(hasUnlockedFreeTicket({ freeTicketChallengeCompleted: true, hasFreeTicket: true, freeTicketUsed: false }), true);
    assert.equal(hasUnlockedFreeTicket({ freeTicketChallengeCompleted: true, hasFreeTicket: true, freeTicketUsed: true }), false);
});
