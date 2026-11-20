import { randomUUID } from 'node:crypto';
import { createClashRoyaleAdapter, externalError, normalizeTag, parseBattleRule } from './clash-royale.js';

const MIN = 60_000;
const LIVE = ['ready', 'baseline', 'battle'];
const TRANSITIONS = {
    ready: ['baseline', 'cancelled', 'expired'], baseline: ['battle', 'expired'],
    battle: ['completed', 'expired', 'disputed'],
};
const blocked = () => externalError(404, 'Not found.');
const conflict = message => externalError(409, message);
const idPattern = /^[a-f0-9]{24}$/i;
const bool = value => value === 'true';

export function getExternalPolicy(env = process.env) {
    const testers = new Set(String(env.EXTERNAL_GAMES_TESTER_IDS || '').split(',').map(x => x.trim().toLowerCase()).filter(x => idPattern.test(x)));
    return {
        // An explicit attempt to make this public disables access rather than granting it.
        enabled: bool(env.EXTERNAL_GAMES_ENABLED) && bool(env.CLASH_ROYALE_ENABLED)
            && (env.EXTERNAL_GAMES_ADMIN_ONLY == null || bool(env.EXTERNAL_GAMES_ADMIN_ONLY)),
        realStakesRequested: bool(env.CLASH_ROYALE_REAL_STAKES_ENABLED),
        realStakes: false,
        matchmaking: testers.size > 0,
        allow: (id, admin) => admin || testers.has(String(id).toLowerCase()),
        rule: parseBattleRule(env.CLASH_ROYALE_TRIPLE_DRAFT_RULE),
    };
}

export function nextMatchState(match, state, now, reason = null) {
    if (!TRANSITIONS[match.state]?.includes(state)) throw conflict('This match can no longer make that transition.');
    return { ...match, state, reason, updatedAt: new Date(now), audit: [...match.audit, { state, at: new Date(now), reason }] };
}

export function choosePair(seats, now) {
    for (let i = 0; i < seats.length; i++) for (let j = i + 1; j < seats.length; j++) {
        const a = seats[i], b = seats[j];
        if (a._id === b._id || a.profile.tag === b.profile.tag) continue;
        const waited = Math.max(0, now - Math.min(+a.joinedAt, +b.joinedAt));
        if (Math.abs(a.profile.trophies - b.profile.trophies) <= 500 + 250 * Math.floor(waited / 15_000)) return [a, b];
    }
    return null;
}

export function createExternalGames({ connection, User, isAdmin, env = process.env, clock = Date.now, adapter } = {}) {
    const policy = getExternalPolicy(env);
    const provider = adapter || createClashRoyaleAdapter({ apiKey: env.CLASH_ROYALE_API_KEY, tokenVerification: bool(env.CLASH_ROYALE_VERIFY_TOKEN_ENABLED) });
    const windowMs = 12 * MIN, resultGraceMs = 2 * MIN, recoveryMs = 5 * MIN;
    let initialized;
    function prepare() {
        if (connection.readyState !== 1) throw externalError(503, 'Private matchmaking database is unavailable.');
        if (!initialized) initialized = (async () => {
            const db = connection.db;
            const links = db.collection('external_game_links');
            const seats = db.collection('external_game_seats');
            const matches = db.collection('external_game_matches');
            const control = db.collection('external_game_control');
            const audit = db.collection('external_game_audit');
            await Promise.all([
                links.createIndex({ 'profile.tag': 1 }, { unique: true }),
                seats.createIndex({ state: 1, joinedAt: 1 }),
                matches.createIndex({ fingerprint: 1 }, { unique: true, partialFilterExpression: { fingerprint: { $type: 'string' } } }),
                matches.createIndex({ state: 1, nextCheck: 1 }),
                matches.createIndex({ 'players.id': 1, createdAt: -1 }),
                audit.createIndex({ at: -1 }),
                control.updateOne({ _id: 'control' }, { $setOnInsert: { paused: false, revision: 0 } }, { upsert: true }),
            ]);
            return { links, seats, matches, control, audit };
        })().catch(error => { initialized = null; throw error; });
        return initialized;
    }

    async function transaction(fn) {
        const db = await prepare();
        return connection.getClient().withSession(session => session.withTransaction(async () => {
            // Serialize infrequent internal queue mutations and account changes across replicas.
            // Provider HTTP never runs in the transaction or under the write lock.
            const settings = await db.control.findOneAndUpdate({ _id: 'control' }, { $inc: { revision: 1 } }, { session, returnDocument: 'after' });
            return fn(db, { session }, settings);
        }, { readPreference: 'primary', readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }));
    }

    async function identity(id) {
        if (!policy.enabled || !idPattern.test(String(id))) return null;
        const user = await User.findById(id).select('username').lean();
        if (!user || !policy.allow(id, isAdmin(user))) return null;
        return { id: String(user._id), username: user.username, admin: isAdmin(user) };
    }

    async function eligiblePlayers(players, db, opt) {
        for (const player of players) {
            const actor = await identity(player.id);
            const link = await db.links.findOne({ _id: player.id, active: true, 'profile.tag': player.tag }, opt);
            if (!actor || !link || +link.verifiedAt < clock() - 30 * 24 * 60 * MIN) return false;
        }
        return true;
    }

    const auditEvent = (db, opt, id, event, fields = {}) => db.audit.insertOne({ id, event, at: new Date(clock()), ...fields }, opt);
    function publicMatch(match) {
        if (!match) return null;
        const { _id, state, players, ready, hostId, createdAt, deadline, opensAt, battleUntil, reason, result, attempts, practice } = match;
        return { id: _id, state, players, ready, hostId, createdAt, deadline, opensAt, battleUntil, reason, result, attempts, practice: !!practice };
    }

    async function finish(db, opt, match, state, reason, extra = {}) {
        const next = { ...nextMatchState(match, state, clock(), reason), ...extra, lease: null, nextCheck: null };
        await db.matches.replaceOne({ _id: match._id }, next, opt);
        await db.seats.deleteMany({ matchId: match._id }, opt);
        return next;
    }

    async function pair(db, opt, settings, now) {
        if (settings.paused || !policy.matchmaking || !policy.rule || !provider.health().configured || !provider.health().tokenVerification) return;
        // Keep this private preview below the provider polling budget.
        if (await db.matches.countDocuments({ state: { $in: LIVE } }, { ...opt, limit: 6 }) >= 6) return;
        const queued = await db.seats.find({ state: 'queued', expiresAt: { $gt: new Date(now) } }, opt).sort({ joinedAt: 1 }).limit(100).toArray();
        const picked = choosePair(queued, now);
        if (!picked) return;
        const players = picked.map(row => ({ id: row._id, ...row.profile }));
        if (await db.matches.findOne({ state: { $in: LIVE }, 'players.tag': { $in: players.map(p => p.tag) } }, opt)) return;
        if (!await eligiblePlayers(players, db, opt)) {
            // Don't leave a revoked or unverified account blocking the front of the queue.
            for (const player of players) if (!await eligiblePlayers([player], db, opt)) await db.seats.deleteOne({ _id: player.id }, opt);
            return;
        }
        const date = new Date(now), deadline = new Date(now + 45_000), matchId = randomUUID();
        const recentPairCount = await db.matches.countDocuments({ 'players.id': { $all: players.map(p => p.id) },
            state: 'completed', createdAt: { $gte: new Date(now - 24 * 60 * MIN) } }, opt);
        await db.matches.insertOne({ _id: matchId, provider: provider.id, mode: provider.mode, entry: 'free', state: 'ready', players, ready: [],
            hostId: players[0].id, rule: policy.rule, createdAt: date, updatedAt: date, deadline, nextCheck: deadline, attempts: 0,
            risk: recentPairCount >= 3 ? ['repeated_pair'] : [], audit: [{ state: 'ready', at: date }] }, opt);
        await db.seats.updateMany({ _id: { $in: players.map(p => p.id) } }, { $set: { state: 'matched', matchId } }, opt);
    }

    async function snapshot(actor) {
        const db = await prepare();
        const participant = { 'players.id': actor.id };
        const [link, seat, history, settings, stats] = await Promise.all([
            db.links.findOne({ _id: actor.id }), db.seats.findOne({ _id: actor.id }),
            db.matches.find({ ...participant, state: { $nin: LIVE } }).sort({ createdAt: -1 }).limit(30).toArray(),
            db.control.findOne({ _id: 'control' }),
            db.matches.aggregate([{ $match: { ...participant, state: 'completed' } }, { $group: { _id: '$result.winnerId', count: { $sum: 1 } } }]).toArray(),
        ]);
        const match = seat?.matchId ? await db.matches.findOne({ ...participant, _id: seat.matchId }) : null;
        const wins = stats.find(row => row._id === actor.id)?.count || 0;
        const draws = stats.find(row => row._id === null)?.count || 0;
        const losses = stats.reduce((sum, row) => sum + row.count, 0) - wins - draws;
        const health = provider.health();
        return { self: actor.id, admin: actor.admin, profile: link?.active ? { ...link.profile, verifiedAt: link.verifiedAt } : null,
            canQueue: !settings.paused && !!policy.rule && health.configured && health.tokenVerification,
            matchmaking: policy.matchmaking,
            paused: settings.paused, ruleReady: !!policy.rule, configured: health.configured, tokenVerification: health.tokenVerification,
            realStakes: false, queue: seat?.state === 'queued' ? { joinedAt: seat.joinedAt, expiresAt: seat.expiresAt } : null,
            match: publicMatch(match), history: history.map(publicMatch), stats: { wins, losses, draws, winRate: wins + losses ? Math.round(100 * wins / (wins + losses)) : null } };
    }

    async function linkAccount(actor, tag, token) {
        const db = await prepare();
        const [existing, seat] = await Promise.all([db.links.findOne({ _id: actor.id }), db.seats.findOne({ _id: actor.id })]);
        if (seat) throw conflict('Leave matchmaking before changing account verification.');
        if (existing && existing.profile.tag !== tag) throw conflict('This Arenifi account already has a permanent player tag.');
        await provider.proveOwnership(tag, token);
        const profile = await provider.profile(tag, { fresh: true });
        try {
            return await transaction(async (db, opt) => {
                if (await db.seats.findOne({ _id: actor.id }, opt)) throw conflict('Leave matchmaking before changing account verification.');
                const latest = await db.links.findOne({ _id: actor.id }, opt);
                if (latest && latest.profile.tag !== tag) throw conflict('This Arenifi account already has a permanent player tag.');
                const verifiedAt = new Date(clock());
                await db.links.updateOne({ _id: actor.id }, { $set: { profile, active: true, verifiedAt }, $setOnInsert: { createdAt: verifiedAt } }, { ...opt, upsert: true });
                await auditEvent(db, opt, actor.id, latest ? 'reverified' : 'linked', { tag });
                return { ...profile, verifiedAt };
            });
        } catch (error) {
            if (error.code === 11000) throw conflict('This Clash Royale account is already associated with another Arenifi account.');
            throw error;
        }
    }

    async function enqueue(actor, entry) {
        if (entry !== 'free') throw externalError(403, 'SOL battles are not available.');
        if (!policy.matchmaking) throw conflict('Use private practice when only the admin has access.');
        await transaction(async (db, opt, settings) => {
            if (settings.paused || !policy.rule || !provider.health().configured || !provider.health().tokenVerification) throw externalError(503, 'Private Triple Draft matchmaking is not enabled.');
            if (await db.seats.findOne({ _id: actor.id }, opt)) return;
            const link = await db.links.findOne({ _id: actor.id, active: true }, opt);
            if (!link || !await eligiblePlayers([{ id: actor.id, tag: link.profile.tag }], db, opt)) throw conflict('Verify your Clash Royale account first.');
            const now = clock();
            await db.seats.insertOne({ _id: actor.id, state: 'queued', profile: link.profile, joinedAt: new Date(now), expiresAt: new Date(now + 10 * MIN) }, opt);
            await pair(db, opt, settings, now);
        });
    }

    async function startPractice(actor, tag) {
        if (!actor.admin) throw blocked();
        if (!policy.rule || !provider.health().configured || !provider.health().tokenVerification) throw externalError(503, 'Private Triple Draft is not configured.');
        const db = await prepare();
        const ownLink = await db.links.findOne({ _id: actor.id, active: true });
        if (!ownLink) throw conflict('Verify your Clash Royale account first.');
        if (ownLink.profile.tag === tag) throw conflict('Your opponent must use a different Clash Royale account.');
        const opponent = await provider.profile(tag);
        await transaction(async (db, opt, settings) => {
            if (settings.paused) throw conflict('Private matches are paused.');
            if (await db.seats.findOne({ _id: actor.id }, opt)) throw conflict('You already have an active match or queue entry.');
            if (!await eligiblePlayers([{ id: actor.id, tag: ownLink.profile.tag }], db, opt)) throw conflict('Reverify your Clash Royale account first.');
            const overlapping = await db.matches.findOne({ state: { $in: LIVE }, 'players.tag': { $in: [ownLink.profile.tag, tag] } }, opt);
            if (overlapping) throw conflict('One of these players is already in an active match.');
            const now = new Date(clock()), matchId = randomUUID();
            await db.matches.insertOne({ _id: matchId, provider: provider.id, mode: provider.mode, entry: 'free', practice: true,
                state: 'baseline', players: [{ id: actor.id, ...ownLink.profile }, { id: 'external-opponent', ...opponent }],
                ready: [actor.id], hostId: actor.id, rule: policy.rule, createdAt: now, updatedAt: now, deadline: new Date(+now + MIN),
                nextCheck: now, attempts: 0, audit: [{ state: 'baseline', at: now, reason: 'admin_private_practice' }] }, opt);
            await db.seats.insertOne({ _id: actor.id, state: 'matched', matchId }, opt);
        });
    }

    async function respond(actor, matchId, accept) {
        await transaction(async (db, opt, settings) => {
            const match = await db.matches.findOne({ _id: matchId, 'players.id': actor.id }, opt);
            if (!match) throw blocked();
            if (match.state !== 'ready') throw conflict('The ready check has already ended.');
            if (+match.deadline <= clock()) return finish(db, opt, match, 'expired', 'ready_timeout');
            if (!accept || settings.paused) return finish(db, opt, match, 'cancelled', settings.paused ? 'matchmaking_paused' : 'declined');
            const ready = [...new Set([...match.ready, actor.id])];
            if (ready.length !== 2) {
                if (ready.length !== match.ready.length) await db.matches.updateOne({ _id: matchId }, { $set: { ready }, $push: { audit: { state: 'ready', actor: actor.id, at: new Date(clock()), reason: 'accepted' } } }, opt);
                return;
            }
            if (!await eligiblePlayers(match.players, db, opt)) return finish(db, opt, match, 'cancelled', 'link_unavailable');
            const next = nextMatchState({ ...match, ready, audit: [...match.audit, { state: 'ready', actor: actor.id, at: new Date(clock()), reason: 'accepted' }] }, 'baseline', clock());
            await db.matches.replaceOne({ _id: matchId }, { ...next, deadline: new Date(clock() + MIN), nextCheck: new Date(clock()) }, opt);
        });
    }

    async function processMatch() {
        const db = await prepare();
        const now = clock(), lease = randomUUID();
        const match = await db.matches.findOneAndUpdate({ state: { $in: LIVE }, nextCheck: { $lte: new Date(now) },
            $or: [{ leaseUntil: { $lte: new Date(now) } }, { leaseUntil: { $exists: false } }] },
        { $set: { lease, leaseUntil: new Date(now + 40_000) }, $inc: { attempts: 1 } }, { returnDocument: 'after', sort: { nextCheck: 1 } });
        if (!match) return;
        let logs, errorCode;
        const expired = () => match.state === 'battle' ? clock() >= +match.battleUntil + resultGraceMs + recoveryMs : clock() >= +match.deadline;
        const observedAfterGrace = match.state === 'battle' && now >= +match.battleUntil + resultGraceMs;
        if (match.state !== 'ready' && !expired()) {
            try { logs = await Promise.all(match.players.map(p => provider.battles(p.tag))); }
            catch (error) { errorCode = error.code || 'PROVIDER_ERROR'; }
        }
        async function commit(replayed = false) {
            return transaction(async (db, opt) => {
                const current = await db.matches.findOne({ _id: match._id, lease, leaseUntil: { $gt: new Date(clock()) }, state: match.state }, opt);
                if (!current) return;
                if (replayed) return finish(db, opt, current, 'disputed', 'battle_already_claimed');
                if (current.state === 'ready') return finish(db, opt, current, 'expired', 'ready_timeout');
                if (expired()) return finish(db, opt, current, current.state === 'battle' && current.evidence?.length ? 'disputed' : 'expired', errorCode || current.lastProviderError || 'verification_timeout');
                if (!logs) {
                    await db.matches.updateOne({ _id: current._id }, { $set: { lastProviderError: errorCode, leaseUntil: new Date(0), nextCheck: new Date(clock() + 15_000) } }, opt);
                    return;
                }
                if (current.state === 'baseline') {
                    const verificationPlayers = current.practice ? current.players.filter(p => p.id === current.hostId) : current.players;
                    if (!await eligiblePlayers(verificationPlayers, db, opt) || (current.practice && !(await identity(current.hostId))?.admin)) {
                        return finish(db, opt, current, 'expired', 'link_unavailable');
                    }
                    const tags = current.players.map(p => p.tag);
                    const baseline = [...new Set(logs.flatMap(log => log.map(row => provider.normalizeBattle(row, tags, current.rule)?.fingerprint).filter(Boolean)))];
                    const opensAt = new Date(Math.ceil((clock() + 2000) / 1000) * 1000);
                    await db.matches.replaceOne({ _id: current._id }, { ...nextMatchState(current, 'battle', clock()), baseline, opensAt,
                        battleUntil: new Date(+opensAt + windowMs), deadline: new Date(+opensAt + windowMs), evidence: [],
                        lastProviderError: null, leaseUntil: new Date(0), nextCheck: new Date(+opensAt + 15_000) }, opt);
                    return;
                }
                const { evidence, ambiguous } = provider.mergeEvidence(current.evidence, logs, current);
                if (ambiguous) return finish(db, opt, current, 'disputed', 'ambiguous_evidence', { evidence });
                const [battle] = evidence;
                const fresh = observedAfterGrace ? provider.mergeEvidence([], logs, current) : null;
                if (fresh?.evidence.length === 1 && fresh.evidence[0].fingerprint === battle?.fingerprint
                    && fresh.evidence[0].sources === 3 && battle?.sources === 3 && battle.score) {
                    const winnerId = current.players.find(p => p.tag === battle.winnerTag)?.id ?? null;
                    const orderedTags = current.players.map(p => p.tag).sort((a, b) => a.localeCompare(b));
                    return finish(db, opt, current, 'completed', null, { evidence, fingerprint: battle.fingerprint,
                        result: { winnerId, scores: Object.fromEntries(current.players.map(p => [p.id, battle.score[orderedTags.indexOf(p.tag)]])), verifiedAt: new Date(clock()), battleAt: new Date(battle.at) } });
                }
                await db.matches.updateOne({ _id: current._id }, { $set: { evidence, lastProviderError: null, leaseUntil: new Date(0), nextCheck: new Date(clock() + 15_000) } }, opt);
            });
        }
        try { await commit(); } catch (error) {
            if (error.code === 11000) await commit(true);
            else throw error;
        }
    }

    let busy = false;
    async function tick() {
        if (!policy.enabled || busy || connection.readyState !== 1) return;
        busy = true;
        try {
            const db = await prepare();
            if (await db.seats.findOne({ state: 'queued' }, { projection: { _id: 1 } })) await transaction(async (db, opt, settings) => {
                const now = clock();
                await db.seats.deleteMany({ state: 'queued', expiresAt: { $lte: new Date(now) } }, opt);
                await pair(db, opt, settings, now);
            });
            await processMatch();
        } finally { busy = false; }
    }

    function registerRoutes(app, { authenticateToken, rateLimit }) {
        const base = '/api/external-games';
        app.use(base, (req, res, next) => {
            res.set('Cache-Control', 'no-store');
            res.set('X-Robots-Tag', 'noindex, nofollow');
            if (!policy.enabled || !req.headers.authorization) return res.sendStatus(404);
            authenticateToken(req, res, next);
        }, async (req, res, next) => {
            try { req.externalActor = await identity(req.user.id); if (!req.externalActor) return res.sendStatus(404); next(); }
            catch { res.sendStatus(503); }
        });
        const route = (verb, path, run, { admin = false, limit = 0 } = {}) => app[verb](base + path,
            ...(limit ? [rateLimit({ limit, windowMs: MIN })] : []), async (req, res) => {
                if (admin && !req.externalActor.admin) return res.sendStatus(404);
                try { return res.json(await run(req, req.externalActor)); }
                catch (error) { return res.status(error.status || 503).json({ code: typeof error.code === 'string' ? error.code : 'EXTERNAL_GAMES_UNAVAILABLE', message: error.status ? error.message : 'Private matchmaking is temporarily unavailable.' }); }
            });
        route('get', '/state', (_req, actor) => snapshot(actor), { limit: 180 });
        route('post', '/profile', req => provider.profile(normalizeTag(req.body?.tag)), { limit: 12 });
        route('post', '/link', (req, actor) => linkAccount(actor, normalizeTag(req.body?.tag), req.body?.token), { limit: 6 });
        route('post', '/unlink', (_req, actor) => transaction(async (db, opt) => {
            if (await db.seats.findOne({ _id: actor.id }, opt)) throw conflict('Leave matchmaking before disconnecting.');
            const result = await db.links.updateOne({ _id: actor.id, active: true }, { $set: { active: false } }, opt);
            if (result.modifiedCount) await auditEvent(db, opt, actor.id, 'unlinked');
            return { ok: true };
        }), { limit: 6 });
        route('post', '/queue', async (req, actor) => { await enqueue(actor, req.body?.entry); return snapshot(actor); }, { limit: 12 });
        route('post', '/practice', async (req, actor) => {
            await startPractice(actor, normalizeTag(req.body?.opponentTag));
            return snapshot(actor);
        }, { admin: true, limit: 8 });
        route('delete', '/queue', async (_req, actor) => {
            await transaction((db, opt) => db.seats.deleteOne({ _id: actor.id, state: 'queued' }, opt));
            return snapshot(actor);
        }, { limit: 12 });
        route('post', '/matches/:matchId/ready', async (req, actor) => {
            if (typeof req.body?.accept !== 'boolean') throw externalError(400, 'Choose accept or decline.');
            await respond(actor, req.params.matchId, req.body.accept);
            return snapshot(actor);
        }, { limit: 20 });
        route('get', '/admin', async req => {
            const db = await prepare();
            const state = ['ready', 'baseline', 'battle', 'completed', 'disputed', 'cancelled', 'expired'].includes(req.query.state) ? req.query.state : null;
            const userId = idPattern.test(String(req.query.userId || '')) ? String(req.query.userId).toLowerCase() : null;
            const [matches, queued, links, audit, settings] = await Promise.all([
                db.matches.find({ ...(state ? { state } : {}), ...(userId ? { 'players.id': userId } : {}) }).sort({ createdAt: -1 }).limit(40).toArray(),
                db.seats.find({ state: 'queued', ...(userId ? { _id: userId } : {}) }).sort({ joinedAt: 1 }).limit(40).toArray(),
                db.links.find(userId ? { _id: userId } : {}).sort({ verifiedAt: -1 }).limit(40).toArray(),
                db.audit.find(userId ? { id: userId } : {}).sort({ at: -1 }).limit(40).toArray(), db.control.findOne({ _id: 'control' }),
            ]);
            return { matches, queued, links, audit, paused: settings.paused, provider: provider.health(), realStakes: false, realStakesRequested: policy.realStakesRequested };
        }, { admin: true, limit: 20 });
        route('post', '/admin/pause', (req, actor) => transaction(async (db, opt) => {
            if (typeof req.body?.paused !== 'boolean') throw externalError(400, 'Invalid pause setting.');
            await db.control.updateOne({ _id: 'control' }, { $set: { paused: req.body.paused } }, opt);
            if (req.body.paused) await db.seats.deleteMany({ state: 'queued' }, opt);
            await auditEvent(db, opt, actor.id, req.body.paused ? 'paused' : 'resumed');
            return { ok: true };
        }), { admin: true, limit: 6 });
        route('get', '/admin/own-battles', async (_req, actor) => {
            const db = await prepare();
            const link = await db.links.findOne({ _id: actor.id, active: true });
            if (!link) throw conflict('Verify your own account first.');
            const battles = await provider.battles(link.profile.tag);
            return battles.slice(0, 20).map(row => ({ battleTime: row.battleTime, type: typeof row.type === 'string' ? row.type.slice(0, 80) : null,
                modeId: Number.isSafeInteger(row.gameMode?.id) ? row.gameMode.id : null, modeName: typeof row.gameMode?.name === 'string' ? row.gameMode.name.slice(0, 80) : null, sizes: [row.team.length, row.opponent.length] }));
        }, { admin: true, limit: 6 });
    }

    return { policy, identity, registerRoutes, tick, snapshot, enqueue, respond, linkAccount };
}
