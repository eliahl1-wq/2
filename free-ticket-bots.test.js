import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FREE_TICKET_MAX_BOTS_PER_MODE,
    getFreeTicketBotTarget,
    registerFreeTicketBotJoin,
    resetFreeTicketBotTargets,
} from './free-ticket-bots.js';
import { addSlitherBots } from './slither-engine.js';

function room() {
    return { bots: [], slitherBots: [], freeTicketBotTargets: { agar: 0, slither: 0 } };
}

test('free-ticket joins add four bots and cap each game mode at ten', () => {
    const value = room();
    assert.equal(registerFreeTicketBotJoin(value, 'agar'), 4);
    assert.equal(registerFreeTicketBotJoin(value, 'agar'), 8);
    assert.equal(registerFreeTicketBotJoin(value, 'agar'), FREE_TICKET_MAX_BOTS_PER_MODE);
    assert.equal(registerFreeTicketBotJoin(value, 'agar'), FREE_TICKET_MAX_BOTS_PER_MODE);
    assert.equal(registerFreeTicketBotJoin(value, 'slither'), 4);
});

test('free-ticket bot targets reset with the arena', () => {
    const value = room();
    registerFreeTicketBotJoin(value, 'agar');
    registerFreeTicketBotJoin(value, 'slither');
    resetFreeTicketBotTargets(value);
    assert.equal(getFreeTicketBotTarget(value, 'agar'), 0);
    assert.equal(getFreeTicketBotTarget(value, 'slither'), 0);
});
test('free-ticket Slither bots spawn without consuming AI or food balances', () => {
    const value = {
        ...room(),
        isFreeTicketRoom: true,
        entryFeeUsd: 5,
        players: [],
        sandboxStaticWorms: [],
        aiBudgetBalance: 0,
        foodPoolBalance: 12,
    };
    addSlitherBots(value, 4);
    assert.equal(value.slitherBots.length, 4);
    assert.equal(value.aiBudgetBalance, 0);
    assert.equal(value.foodPoolBalance, 12);
    assert.ok(value.slitherBots.every(bot => bot.freeTicketRewardFunded));

    addSlitherBots(value, 20);
    assert.equal(value.slitherBots.length, FREE_TICKET_MAX_BOTS_PER_MODE);
    assert.equal(value.aiBudgetBalance, 0);
    assert.equal(value.foodPoolBalance, 12);
});