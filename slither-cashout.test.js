import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createSegments,
    processSlitherRoom,
    processCompetitiveSlitherRoom,
    runSlitherBotAI,
    runCompetitiveSlitherBotAI,
    SLITHER,
} from './slither-engine.js';

const io = { to: () => ({ emit() {} }) };

function makeSnake(mode, isBot, overrides = {}) {
    return {
        id: 'snake', username: 'Test', mode, isBot, color: '#fff',
        entryFeeUsd: 10, balance: 4, dollarBalance: 4, fam: 0,
        x: 0, y: 0, angle: 0, inputDx: 0, inputDy: 1, boost: true,
        targetX: 0, targetY: 500, segments: createSegments(0, 0, 4, 0),
        ...overrides,
    };
}

function makeRoom(snake) {
    return {
        id: 'cashout-test', entryFeeUsd: 10, isSandbox: true, sandboxBotAi: true,
        players: snake.mode === 'slither' && snake.isBot ? [] : [snake],
        slitherBots: snake.mode === 'slither' && snake.isBot ? [snake] : [],
        slitherFood: [], foodPoolBalance: 0, aiBudgetBalance: 0,
    };
}

function tick(room, mode) {
    if (mode === 'slither') return processSlitherRoom(room, io, null);
    return processCompetitiveSlitherRoom(room, io, null, null, Date.now() + 600000);
}

for (const mode of ['slither', 'competitive-slither']) {
    for (const isBot of [false, true]) {
        for (const flag of ['cashoutHoldActive', 'isCashingOut']) {
            test(`${mode}: ${isBot ? 'bot' : 'human'} ${flag} locks heading/boost but keeps forward movement`, () => {
                const snake = makeSnake(mode, isBot, { [flag]: true });
                const room = makeRoom(snake);
                const initialMass = snake.balance;
                const initialDollars = snake.dollarBalance;
                for (let i = 0; i < 8; i++) {
                    // Stale input cannot bypass the authoritative physics lock.
                    snake.inputDx = -1;
                    snake.inputDy = 1;
                    snake.boost = true;
                    tick(room, mode);
                    assert.equal(snake.angle, 0);
                    assert.equal(snake.boost, false);
                    assert.equal(snake.y, 0);
                }
                assert.ok(snake.x > 0, 'cashout must not freeze the snake in place');
                assert.equal(snake.balance, initialMass, 'no hidden boost mass loss');
                assert.equal(snake.dollarBalance, initialDollars);
                assert.equal(room.slitherFood.length, 0, 'no boost pellets');

                snake[flag] = false;
                snake.inputDx = 0;
                snake.inputDy = 1;
                snake.boost = true;
                tick(room, mode);
                assert.notEqual(snake.angle, 0, 'steering resumes after cancellation');
                if (!isBot) assert.ok(snake.balance < initialMass, 'boost resumes for new input');
            });
        }
    }

    test(`${mode}: bot cashout guard runs before AI decisions, including boundary avoidance`, () => {
        const snake = makeSnake(mode, true, { isCashingOut: true });
        const input = [snake.inputDx, snake.inputDy];
        if (mode === 'slither') {
            runSlitherBotAI(snake, [{ entity: snake }], [], null, makeRoom(snake));
        } else {
            runCompetitiveSlitherBotAI(snake, [{ entity: snake }], [], 1, [], new Set());
        }
        assert.notDeepEqual([snake.inputDx, snake.inputDy], input);
        assert.equal(snake.inputDx, 1);
        assert.equal(snake.inputDy, 0);
        assert.equal(snake.boost, false);
        assert.equal(snake.targetY, 500, 'AI must not choose a new target while holding');
    });
}

test('normal Slither bot starts the same three-second hold and clears it before fleeing', (t) => {
    t.mock.method(Date, 'now', () => 100000);
    const previousFreePlay = process.env.DEV_FREE_PLAY;
    process.env.DEV_FREE_PLAY = 'false';
    t.after(() => {
        if (previousFreePlay === undefined) delete process.env.DEV_FREE_PLAY;
        else process.env.DEV_FREE_PLAY = previousFreePlay;
    });
    const snake = makeSnake('slither', true, { cashOutThreshold: 3 });
    const room = { ...makeRoom(snake), isSandbox: false };
    tick(room, 'slither');
    assert.equal(snake.isCashingOut, true);
    assert.equal(snake.cashoutHoldActive, true);
    assert.equal(snake.cashoutHoldStartedAt, 100000);
    assert.equal(snake.cashOutEndTime, 103000);
    assert.equal(snake.angle, 0);
    assert.equal(snake.boost, false);

    const threat = makeSnake('slither', false, {
        id: 'threat', x: 0, y: 150, dollarBalance: 8,
        segments: createSegments(0, 150, 4, 0),
    });
    room.players.push(threat);
    tick(room, 'slither');
    assert.equal(snake.isCashingOut, false);
    assert.equal(snake.cashoutHoldActive, false);
    assert.equal(snake.cashoutHoldStartedAt, 0);
    assert.equal(snake.cashOutEndTime, 0);
    assert.equal(snake.cashOutRetryAt, 101500);
    assert.notEqual(snake.angle, 0, 'AI can steer only after canceling the hold');
});

test('Slither cashout does not grant immunity from the arena boundary', () => {
    const snake = makeSnake('competitive-slither', true, {
        cashoutHoldActive: true, dollarBalance: 0,
        segments: createSegments(SLITHER.worldHalf, 0, 4, 0),
    });
    const room = makeRoom(snake);
    tick(room, snake.mode);
    assert.equal(room.players.length, 0);
});
