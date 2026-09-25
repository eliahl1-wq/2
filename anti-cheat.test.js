import test from 'node:test';
import assert from 'node:assert/strict';
import { createAntiCheatSession } from './anti-cheat.js';

function makeContext() {
    const player = {
        id: 'player-1',
        mongoId: '507f1f77bcf86cd799439011',
        username: 'PlayerOne',
        x: 0,
        y: 0,
        hp: 100,
        gameSessionId: 'session-1',
    };
    const targets = Array.from({ length: 6 }, (_, index) => ({
        id: `target-${index}`,
        username: `Target${index}`,
        x: 500 * Math.cos(index),
        y: 500 * Math.sin(index),
        hp: 100,
    }));
    return { player, room: { id: 'surviv-5', players: [player, ...targets], bots: [] }, targets };
}

test('ordinary Surviv aim samples do not create an alert', () => {
    let clock = 0;
    const reports = [];
    const antiCheat = createAntiCheatSession({ now: () => clock, report: issue => reports.push(issue) });
    const { player, room } = makeContext();
    for (let index = 0; index < 20; index++) {
        clock += 180;
        antiCheat.observeSurvivInput({
            player,
            room,
            payload: {
                dx: 0,
                dy: 0,
                aimAngle: index * 0.29 + 0.08,
                aimDistance: 300,
                shooting: true,
                firePressId: index + 1,
            },
        });
        clock += 20;
        antiCheat.observeSurvivInput({ player, room, payload: { dx: 0, dy: 0, aimAngle: index * 0.29 + 0.08, shooting: false, firePressId: index + 1 } });
    }
    assert.equal(reports.length, 0);
});

test('repeated centre-perfect rapid target snaps are surfaced for review', () => {
    let clock = 1;
    const reports = [];
    const antiCheat = createAntiCheatSession({ now: () => clock, report: issue => reports.push(issue) });
    const { player, room, targets } = makeContext();
    for (let index = 0; index < 18; index++) {
        const target = targets[index % targets.length];
        const angle = Math.atan2(target.y - player.y, target.x - player.x);
        clock += 45;
        antiCheat.observeSurvivInput({ player, room, payload: { dx: 0, dy: 0, aimAngle: angle + 0.5, shooting: false, firePressId: index } });
        clock += 20;
        antiCheat.observeSurvivInput({ player, room, payload: { dx: 0, dy: 0, aimAngle: angle, shooting: true, firePressId: index + 1 } });
        clock += 20;
        antiCheat.observeSurvivInput({ player, room, payload: { dx: 0, dy: 0, aimAngle: angle, shooting: false, firePressId: index + 1 } });
    }
    assert.ok(reports.some(report => report.code === 'surviv_aim_automation'));
    const report = reports.find(item => item.code === 'surviv_aim_automation');
    assert.equal(report.context.reviewOnly, true);
    assert.ok(report.context.evidenceReplay.frames.length > 0);
    assert.ok(report.context.evidenceReplay.frames.every(frame => Number.isFinite(frame.t)));
});

test('automatic aim that tracks a moving target while fire is held is surfaced', () => {
    let clock = 1;
    const reports = [];
    const antiCheat = createAntiCheatSession({ now: () => clock, report: issue => reports.push(issue) });
    const { player } = makeContext();
    const target = { id: 'moving-target', x: 500, y: 0, hp: 100, radius: 14 };
    const room = { id: 'surviv-moving-target', players: [player, target], bots: [] };
    for (let index = 0; index < 24; index++) {
        target.y += 9;
        clock += 100;
        antiCheat.observeSurvivInput({
            player,
            room,
            payload: {
                dx: 0,
                dy: 0,
                aimAngle: Math.atan2(target.y - player.y, target.x - player.x),
                aimDistance: 500,
                shooting: true,
                firePressId: 1,
            },
        });
    }
    const report = reports.find(item => item.code === 'surviv_automatic_tracking');
    assert.ok(report);
    assert.equal(report.context.signal, 'moving_target_lock');
    assert.ok(report.context.evidenceReplay.frames.some(frame => frame.shooting));
});

test('sustained packet floods require repeated windows before alerting', () => {
    let clock = 0;
    const reports = [];
    const antiCheat = createAntiCheatSession({ now: () => clock, report: issue => reports.push(issue) });
    const { player, room } = makeContext();
    for (let window = 0; window < 3; window++) {
        for (let count = 0; count < 130; count++) {
            antiCheat.observePacketRate({ kind: 'surviv_input', limit: 90, player, room, mode: 'surviv' });
        }
        if (window < 2) {
            assert.equal(reports.length, 0, 'one high-rate second must only count as one violation window');
        }
        clock += 1001;
        antiCheat.observePacketRate({ kind: 'surviv_input', limit: 90, player, room, mode: 'surviv' });
    }
    assert.ok(reports.some(report => report.code === 'input_rate_abuse'));
});

test('isolated malformed input is ignored but repetition is surfaced', () => {
    let clock = 0;
    const reports = [];
    const antiCheat = createAntiCheatSession({ now: () => clock, report: issue => reports.push(issue) });
    const { player, room } = makeContext();
    for (let index = 0; index < 4; index++) {
        antiCheat.observeInvalidInput({ reason: 'bad vector', player, room, mode: 'slither' });
        clock += 250;
    }
    assert.equal(reports.length, 1);
    assert.equal(reports[0].code, 'invalid_game_input');
});
