import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { createClashRoyaleAdapter, mergeEvidence, normalizeBattle, normalizeTag, parseBattleRule } from './clash-royale.js';
import { choosePair, createExternalGames, getExternalPolicy, nextMatchState } from './service.js';

const A = '000000000000000000000001', B = '000000000000000000000002', C = '000000000000000000000003';
const a = '#P0Y', b = '#Q2L', c = '#R2G';
// Synthetic mode tuple. Never a production allowlist or purported capture.
const rule = { type: 'friendly', modeId: 123456, modeName: 'SyntheticTripleDraft' };
const env = { EXTERNAL_GAMES_ENABLED: 'true', EXTERNAL_GAMES_ADMIN_ONLY: 'true', CLASH_ROYALE_ENABLED: 'true',
    EXTERNAL_GAMES_TESTER_IDS: B, CLASH_ROYALE_REAL_STAKES_ENABLED: 'true', CLASH_ROYALE_TRIPLE_DRAFT_RULE: JSON.stringify(rule) };
const dates = {
    start: Date.parse('2026-11-20T12:00:00Z'), end: Date.parse('2026-11-20T12:12:00Z'),
};
const battle = ({ tag = a, other = b, crowns = 2, opponentCrowns = 1, battleTime = '20261120T120300.000Z', type = 'friendly', gameMode = { id: rule.modeId, name: rule.modeName } } = {}) => ({
    type, gameMode, battleTime, team: [{ tag, crowns }], opponent: [{ tag: other, crowns: opponentCrowns }],
});
const reverse = params => battle({ tag: b, other: a, crowns: 1, opponentCrowns: 2, ...params });
const match = { players: [{ tag: a }, { tag: b }], opensAt: dates.start, battleUntil: dates.end, baseline: [], rule };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('policy denies by default and public flag cannot override private access', () => {
    assert.equal(getExternalPolicy({}).enabled, false);
    assert.equal(getExternalPolicy({ ...env, EXTERNAL_GAMES_ADMIN_ONLY: 'false' }).enabled, false);
    const policy = getExternalPolicy(env);
    assert.ok(policy.enabled && policy.allow(A, true) && policy.allow(B, false));
    assert.equal(policy.allow(C, false), false);
    assert.equal(policy.realStakesRequested, true);
    assert.equal(policy.realStakes, false);
    const adminOnly = getExternalPolicy({ ...env, EXTERNAL_GAMES_TESTER_IDS: '' });
    assert.equal(adminOnly.allow(B, false), false);
    assert.equal(adminOnly.matchmaking, false);
    assert.equal(parseBattleRule('{"modeId":72000194}'), null);
    assert.equal(parseBattleRule(JSON.stringify({ ...rule, type: 'ladder' })), null);
});

test('tag validation, replay identity and provider-perspective independent crown score', () => {
    assert.equal(normalizeTag(' p0y '), a);
    for (const input of ['#P0Y/battlelog', 'https://api.clashroyale.com/a', '<svg>', ['P0Y']]) assert.throws(() => normalizeTag(input));
    const first = normalizeBattle(battle(), [a, b], rule);
    assert.equal(first.winnerTag, a);
    assert.deepEqual(first, normalizeBattle(reverse(), [b, a], rule));
    assert.equal(first.fingerprint, normalizeBattle(battle({ crowns: 0, opponentCrowns: 3 }), [a, b], rule).fingerprint);
    assert.equal(normalizeBattle(battle({ crowns: 1, opponentCrowns: 1 }), [a, b], rule).winnerTag, null);
    for (const candidate of [battle({ other: c }), battle({ type: 'ladder' }), battle({ gameMode: { id: rule.modeId, name: 'Draft' } }),
        battle({ battleTime: '20260230T120300.000Z' }), { ...battle(), team: [{ tag: a }, { tag: c }] }]) assert.equal(normalizeBattle(candidate, [a, b], rule), null);
});

test('evidence rejects historical results and detects late rematches and contradictory logs', () => {
    const one = mergeEvidence([], [[battle(), battle()], []], match);
    assert.equal(one.evidence.length, 1);
    assert.equal(one.evidence[0].sources, 1);
    const confirmed = mergeEvidence(one.evidence, [[], [reverse()]], match);
    assert.equal(confirmed.evidence[0].sources, 3);
    assert.equal(confirmed.ambiguous, false);
    assert.equal(mergeEvidence(one.evidence, [[], [reverse({ crowns: 3 })]], match).ambiguous, true);
    assert.equal(mergeEvidence(confirmed.evidence, [[battle({ battleTime: '20261120T120200.000Z' })], []], match).ambiguous, true);
    const excluded = mergeEvidence([], [[battle(), battle({ battleTime: '20261120T115959.000Z' }), battle({ battleTime: '20261120T121201.000Z' })], []],
        { ...match, baseline: [one.evidence[0].fingerprint] });
    assert.equal(excluded.evidence.length, 0);
    assert.equal(mergeEvidence([], [[battle({ crowns: '2' })], [reverse()]], match).evidence[0].sources, 2);
});

test('skill band expands and terminal/active cancellation transitions are forbidden', () => {
    const seat = (id, tag, trophies, at = 0) => ({ _id: id, profile: { tag, trophies }, joinedAt: new Date(at) });
    const first = seat(A, a, 800), second = seat(B, b, 1800);
    assert.equal(choosePair([first, second], 5000), null);
    assert.deepEqual(choosePair([first, seat(C, a, 810), second], 30_000), [first, second]);
    assert.throws(() => nextMatchState({ state: 'battle', audit: [] }, 'cancelled', 1));
    assert.throws(() => nextMatchState({ state: 'completed', audit: [] }, 'completed', 1));
});

test('provider client uses fixed official origin, coalesces GETs, and does not cache proof', async () => {
    const calls = [];
    const api = createClashRoyaleAdapter({ apiKey: 'fixture-key', tokenVerification: true, fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return init.method === 'POST' ? json({ status: 'ok' }) : json({ tag: a, name: 'A', trophies: 800, clan: { name: 'Clan' } });
    } });
    const [first, second] = await Promise.all([api.profile(a), api.profile(a)]);
    assert.deepEqual(first, second);
    await api.profile(a);
    await api.proveOwnership(a, 'testtoken'); await api.proveOwnership(a, 'testtoken');
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, 'https://api.clashroyale.com/v1/players/%23P0Y');
    assert.equal(calls[1].url, calls[0].url + '/verifytoken');
    assert.equal(calls[1].init.redirect, 'error');
    assert.deepEqual(JSON.parse(calls[1].init.body), { token: 'testtoken' });
    assert.equal(JSON.stringify(api.health()).includes('fixture-key'), false);
});

test('provider rejects invalid proof, scopes, schema errors and backs off on rate limits', async () => {
    const create = (response, extra = {}) => createClashRoyaleAdapter({ apiKey: 'fixture', tokenVerification: true,
        fetchImpl: async () => response(), sleep: async () => {}, ...extra });
    await assert.rejects(create(() => json({ status: 'invalid' })).proveOwnership(a, 'token'), { code: 'TOKEN_REJECTED' });
    await assert.rejects(create(() => json({ status: 'ok' }), { tokenVerification: false }).proveOwnership(a, 'token'), { code: 'VERIFY_TOKEN_NOT_ENABLED' });
    await assert.rejects(create(() => json({}, 403)).proveOwnership(a, 'token'), { code: 'VERIFY_TOKEN_ACCESS_DENIED' });
    await assert.rejects(create(() => json([{ foo: 'bar' }])).battles(a), { code: 'PROVIDER_BAD_BATTLE_LOG' });
    let attempts = 0;
    const rateLimited = create(() => { attempts++; return json({}, 429, { 'Retry-After': '20' }); });
    await assert.rejects(rateLimited.battles(a), { code: 'PROVIDER_RATE_LIMIT' });
    await assert.rejects(rateLimited.battles(b), { code: 'PROVIDER_BUSY' });
    assert.equal(attempts, 1);
    let retries = 0;
    const outage = create(() => ++retries === 1 ? json({}, 502) : json([battle()]));
    assert.equal((await outage.battles(a)).length, 1);
});

const users = { [A]: 'admin', [B]: 'tester', [C]: 'ordinary' };
const User = { findById: id => ({ select: () => ({ lean: async () => users[id] ? { _id: id, username: users[id] } : null }) }) };
const isAdmin = user => user.username === 'admin';
const authenticateToken = (req, res, next) => { req.user = { id: req.headers.authorization?.split(' ')[1] }; next(); };
const limiter = () => (_req, _res, next) => next();

async function withHttp(service, run) {
    const app = express(); app.use(express.json());
    service.registerRoutes(app, { authenticateToken, rateLimit: limiter });
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const url = `http://127.0.0.1:${server.address().port}/api/external-games`;
    const call = (id, path, method = 'GET', body) => fetch(url + path, { method,
        headers: { ...(id ? { Authorization: `Bearer ${id}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    try { return await run(call); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('direct API denies guests, ordinary users, tester admin calls and stake requests before touching the DB', async () => {
    const service = createExternalGames({ User, isAdmin, env, connection: { get readyState() { throw Error('unexpected db access'); } } });
    await withHttp(service, async call => {
        for (const id of [null, C]) for (const [path, method] of [['/state', 'GET'], ['/profile', 'POST'], ['/link', 'POST'], ['/queue', 'POST'], ['/matches/any/ready', 'POST'], ['/admin', 'GET']]) {
            assert.equal((await call(id, path, method)).status, 404);
        }
        assert.equal((await call(B, '/admin')).status, 404);
        assert.equal((await call(B, '/admin/pause', 'POST', { paused: true })).status, 404);
        assert.equal((await call(B, '/practice', 'POST', { opponentTag: a })).status, 404);
        assert.equal((await call(A, '/queue', 'POST', { entry: 'sol', amount: 2 })).status, 403);
    });
});

test('single-admin practice opens a free match without an Arenifi account or seat for the opponent', async () => {
    const link = { _id: A, active: true, verifiedAt: new Date(dates.start), profile: { tag: a, name: 'Admin', trophies: 1000 } };
    const settings = { paused: false };
    let matchDoc, seat;
    const empty = () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) });
    const collections = {
        external_game_links: { findOne: async () => link },
        external_game_seats: { findOne: async () => seat, insertOne: async document => { seat = document; } },
        external_game_control: { updateOne: async () => {}, findOne: async () => settings, findOneAndUpdate: async () => settings },
        external_game_matches: { findOne: async () => matchDoc, insertOne: async document => { matchDoc = document; }, find: empty, aggregate: () => ({ toArray: async () => [] }) },
        external_game_audit: {},
    };
    const db = { collection: name => ({ createIndex: async () => {}, ...collections[name] }) };
    const connection = { db, readyState: 1, getClient: () => ({ withSession: fn => fn({ withTransaction: work => work() }) }) };
    const provider = createClashRoyaleAdapter({ apiKey: 'fixture', tokenVerification: true, fetchImpl: async () => json({ tag: b, name: 'Opponent', trophies: 1000 }) });
    await withHttp(createExternalGames({ User, isAdmin, env: { ...env, EXTERNAL_GAMES_TESTER_IDS: '' }, adapter: provider, connection, clock: () => dates.start }), async call => {
        assert.equal((await call(B, '/state')).status, 404);
        assert.equal((await call(A, '/queue', 'POST', { entry: 'free' })).status, 409);
        assert.equal((await call(A, '/practice', 'POST', { opponentTag: a })).status, 409);
        settings.paused = true;
        assert.equal((await call(A, '/practice', 'POST', { opponentTag: b })).status, 409);
        settings.paused = false;
        const response = await call(A, '/practice', 'POST', { opponentTag: b });
        assert.equal(response.status, 200);
        const { match, matchmaking, realStakes } = await response.json();
        assert.equal(match.practice, true);
        assert.equal(match.state, 'baseline');
        assert.equal(matchmaking, false);
        assert.equal(realStakes, false);
        assert.equal(matchDoc.entry, 'free');
        assert.equal(match.players[1].id, 'external-opponent');
        assert.deepEqual(seat, { _id: A, state: 'matched', matchId: match.id });
        assert.equal((await call(A, '/practice', 'POST', { opponentTag: b })).status, 409);
    });
});

// Opt-in actual MongoDB integration. Only a dedicated loopback replica set is
// accepted. Creates a random isolated database and drops only that database.
const mongoUri = process.env.EXTERNAL_TEST_MONGO_URI;
test('replica-set integration: linking, concurrent matchmaking, restart, replay and kill switch', { skip: !mongoUri, timeout: 45_000 }, async () => {
    assert.match(mongoUri, /^mongodb:\/\/127\.0\.0\.1:\d+\/\?replicaSet=[a-zA-Z0-9_-]+$/);
    const client = await new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 }).connect();
    const db = client.db('external_test_' + randomUUID().replaceAll('-', ''));
    const connection = { db, readyState: 1, getClient: () => client };
    let now = dates.start, logs = {};
    const provider = createClashRoyaleAdapter({ apiKey: 'fixture', tokenVerification: true, clock: () => now, fetchImpl: async (url, init) => {
        const tag = decodeURIComponent(url.match(/players\/([^/]+)/)[1]);
        if (url.endsWith('verifytoken')) return json({ status: JSON.parse(init.body).token === 'validtoken' ? 'ok' : 'invalid' });
        if (url.endsWith('battlelog')) return json(logs[tag] || []);
        return json({ tag, name: tag, trophies: 1000 });
    } });
    const build = (settings = env) => createExternalGames({ connection, User, isAdmin, env: settings, clock: () => now, adapter: provider });
    const state = async (call, id) => (await call(id, '/state')).json();
    try {
        const service = build();
        await withHttp(service, async call => {
            const link = (id, tag, token = 'validtoken') => call(id, '/link', 'POST', { tag, token });
            assert.equal((await link(A, a, 'badtoken')).status, 422);
            assert.equal((await link(A, a)).status, 200);
            assert.equal((await link(B, a)).status, 409);
            assert.equal((await link(B, b)).status, 200);
            const queue = id => call(id, '/queue', 'POST', { entry: 'free' });
            for (const response of await Promise.all([queue(A), queue(A), queue(B), queue(B)])) assert.equal(response.status, 200);
            const [left, right] = await Promise.all([state(call, A), state(call, B)]);
            assert.equal(left.match.id, right.match.id);
            assert.equal(await db.collection('external_game_matches').countDocuments(), 1);
            assert.equal((await link(A, a)).status, 409);
            const ready = `/matches/${left.match.id}/ready`;
            for (const response of await Promise.all([A, B].map(id => call(id, ready, 'POST', { accept: true })))) assert.equal(response.status, 200);
            assert.equal((await state(call, A)).match.state, 'baseline');
            const restarted = build();
            await restarted.tick();
            assert.equal((await state(call, A)).match.state, 'battle');
            assert.equal((await call(A, ready, 'POST', { accept: false })).status, 409);
            logs = { [a]: [battle()], [b]: [reverse()] };
            now += 3 * 60_000;
            await restarted.tick();
            assert.equal((await state(call, A)).match.state, 'battle');
            now += 11 * 60_000 + 20_000;
            await Promise.all([service.tick(), restarted.tick()]);
            const after = await state(call, A);
            assert.equal(after.stats.wins, 1);
            assert.equal(after.match, null);
            assert.equal((await state(call, B)).stats.losses, 1);
            const { _id, ...completed } = await db.collection('external_game_matches').findOne({ state: 'completed' });
            await assert.rejects(db.collection('external_game_matches').insertOne({ ...completed, _id: 'replay-test' }), { code: 11000 });
            assert.equal((await call(A, '/admin/pause', 'POST', { paused: true })).status, 200);
            assert.equal((await queue(B)).status, 503);
            assert.equal(await db.collection('external_game_seats').countDocuments(), 0);
            assert.equal((await call(A, '/admin/pause', 'POST', { paused: false })).status, 200);
            await queue(A); await queue(B);
            const declined = (await state(call, A)).match;
            assert.equal((await call(B, `/matches/${declined.id}/ready`, 'POST', { accept: false })).status, 200);
            assert.equal((await state(call, A)).history[0].state, 'cancelled');
            await queue(A); await queue(B);
            const expires = (await state(call, A)).match;
            now += 46_000;
            await restarted.tick();
            assert.equal((await state(call, A)).history.find(row => row.id === expires.id).state, 'expired');

            now += 1000;
            await queue(A); await queue(B);
            const next = (await state(call, A)).match;
            for (const id of [A, B]) assert.equal((await call(id, `/matches/${next.id}/ready`, 'POST', { accept: true })).status, 200);
            await restarted.tick();
            now += 30_000;
            const timestamp = new Date(now).toISOString().replace(/-|:/g, '');
            logs = { [a]: [battle({ battleTime: timestamp })], [b]: [reverse({ battleTime: timestamp, crowns: 3 })] };
            await restarted.tick();
            const disputed = await state(call, A);
            assert.equal(disputed.history.find(row => row.id === next.id).state, 'disputed');
            assert.equal(disputed.stats.wins, 1);
            assert.equal(disputed.match, null);
        });
        await withHttp(build({ ...env, EXTERNAL_GAMES_TESTER_IDS: '' }), async call => {
            assert.equal((await call(B, '/state')).status, 404);
            assert.equal((await call(A, '/queue', 'POST', { entry: 'free' })).status, 409);
            assert.equal((await call(A, '/practice', 'POST', { opponentTag: a })).status, 409);
            const res = await call(A, '/practice', 'POST', { opponentTag: b });
            assert.equal(res.status, 200);
            const created = (await res.json()).match;
            assert.equal(created.practice, true);
            assert.equal(created.state, 'baseline');
            assert.equal(created.players[1].id, 'external-opponent');
            assert.equal(await db.collection('external_game_seats').countDocuments(), 1);
            assert.equal((await call(A, '/practice', 'POST', { opponentTag: b })).status, 409);
            const worker = build({ ...env, EXTERNAL_GAMES_TESTER_IDS: '' });
            await worker.tick();
            assert.equal((await state(call, A)).match.state, 'battle');
            now += 60_000;
            const timestamp = new Date(now).toISOString().replace(/-|:/g, '');
            logs = { [a]: [battle({ battleTime: timestamp })], [b]: [reverse({ battleTime: timestamp })] };
            now += 14 * 60_000;
            await worker.tick();
            const result = (await state(call, A)).history.find(row => row.id === created.id);
            assert.equal(result.state, 'completed');
            assert.equal(result.result.winnerId, A);
        });
    } finally { await db.dropDatabase(); await client.close(); }
});
