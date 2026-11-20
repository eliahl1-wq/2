import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function externalError(status, message, code = 'EXTERNAL_GAMES_ERROR') {
    return Object.assign(new Error(message), { status, code });
}

export function normalizeTag(input) {
    const tag = typeof input === 'string' ? input.trim().toUpperCase() : '';
    if (!/^#?[0289PYLQGRJCUV]{3,15}$/.test(tag)) throw externalError(400, 'Enter a valid Clash Royale player tag.', 'INVALID_TAG');
    return '#' + tag.replace(/^#/, '');
}

// A single empirically reviewed Friendly Triple Draft tuple, not a guessed ID or label.
export function parseBattleRule(value) {
    try {
        const rule = JSON.parse(value || 'null');
        return rule && typeof rule.type === 'string' && /^friendly$/i.test(rule.type)
            && Number.isSafeInteger(rule.modeId) && rule.modeId > 0
            && typeof rule.modeName === 'string' && /^[a-z0-9_ -]{1,80}$/i.test(rule.modeName)
            ? { type: rule.type, modeId: rule.modeId, modeName: rule.modeName } : null;
    } catch { return null; }
}

function battleDate(value) {
    const parts = typeof value === 'string' && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/.exec(value);
    if (!parts) return null;
    const [, y, m, d, h, min, s, ms] = parts;
    const iso = `${y}-${m}-${d}T${h}:${min}:${s}.${ms}Z`;
    const time = new Date(iso);
    return Number.isFinite(+time) && time.toISOString() === iso ? +time : null;
}

export function normalizeBattle(battle, expectedTags, rule) {
    if (!rule || battle?.type !== rule.type || battle?.gameMode?.id !== rule.modeId || battle?.gameMode?.name !== rule.modeName
        || !Array.isArray(battle.team) || !Array.isArray(battle.opponent) || battle.team.length !== 1 || battle.opponent.length !== 1) return null;
    const at = battleDate(battle.battleTime);
    if (at == null) return null;
    try {
        const rows = [battle.team[0], battle.opponent[0]].map(row => ({ tag: normalizeTag(row?.tag), crowns: row?.crowns }))
            .sort((a, b) => a.tag.localeCompare(b.tag));
        if (rows[0].tag === rows[1].tag || rows.map(row => row.tag).join(',') !== [...expectedTags].sort((a, b) => a.localeCompare(b)).join(',')) return null;
        // Identity intentionally excludes result fields and perspective.
        const fingerprint = createHash('sha256').update(JSON.stringify(['clash-royale', rows.map(row => row.tag), at, rule.type, rule.modeId])).digest('hex');
        const score = rows.every(row => Number.isInteger(row.crowns) && row.crowns >= 0 && row.crowns <= 3) ? rows.map(row => row.crowns) : null;
        return { fingerprint, at, score, winnerTag: score && score[0] !== score[1] ? rows[score[0] > score[1] ? 0 : 1].tag : null };
    } catch { return null; }
}

export function mergeEvidence(previous, logs, match) {
    const known = new Map(previous.map(row => [row.fingerprint, { ...row }]));
    const baseline = new Set(match.baseline);
    for (let index = 0; index < logs.length; index++) for (const battle of logs[index]) {
        const row = normalizeBattle(battle, match.players.map(player => player.tag), match.rule);
        if (!row || baseline.has(row.fingerprint) || row.at < +match.opensAt || row.at > +match.battleUntil) continue;
        const old = known.get(row.fingerprint);
        if (!old && known.size >= 16) return { evidence: [...known.values()], ambiguous: true };
        const conflict = !!old && (old.conflict || (old.score && row.score && old.score.join(',') !== row.score.join(',')));
        const scoreFromThisLog = row.score ? 1 << index : 0;
        known.set(row.fingerprint, { ...row, ...(old?.score && !row.score ? { score: old.score, winnerTag: old.winnerTag } : {}),
            sources: (old?.sources || 0) | scoreFromThisLog, conflict: !!conflict });
    }
    const evidence = [...known.values()];
    return { evidence, ambiguous: evidence.length > 1 || evidence.some(row => row.conflict) };
}

export function createClashRoyaleAdapter({ apiKey, tokenVerification = false, fetchImpl = fetch, clock = Date.now, sleep = delay, timeoutMs = 5000 } = {}) {
    const cache = new Map(), pending = new Map();
    let active = 0, cooldownUntil = 0, recent = [];
    let health = { status: 'not_checked', at: null };
    const unavailable = (code = 'PROVIDER_BUSY') => externalError(503, 'Clash Royale API is not available right now.', code);
    async function request(path, { body, ttl = 0 } = {}) {
        if (!apiKey) throw unavailable('PROVIDER_NOT_CONFIGURED');
        const cached = cache.get(path);
        if (!body && ttl && cached?.until > clock()) return cached.value;
        if (!body && pending.has(path)) return pending.get(path);
        if (active >= 8 || clock() < cooldownUntil) throw unavailable();
        active++;
        const work = (async () => {
            try {
                for (let attempt = 0; attempt < (body ? 1 : 2); attempt++) {
                    recent = recent.filter(at => clock() - at < 60_000);
                    if (recent.length >= 90 || clock() < cooldownUntil) throw unavailable();
                    recent.push(clock());
                    let response;
                    try {
                        response = await fetchImpl(`https://api.clashroyale.com/v1${path}`, {
                            method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
                            ...(body ? { body: JSON.stringify(body) } : {}),
                        });
                    } catch {
                        if (!body && attempt === 0) { await sleep(250); continue; }
                        throw unavailable('PROVIDER_TIMEOUT');
                    }
                    if (response.status === 429) {
                        const retry = Number(response.headers.get('Retry-After'));
                        cooldownUntil = clock() + Math.min(120, Math.max(5, retry || 15)) * 1000;
                        throw unavailable('PROVIDER_RATE_LIMIT');
                    }
                    if (response.status >= 500 && !body && attempt === 0) { await sleep(250); continue; }
                    if (response.status === 401 || response.status === 403) throw unavailable(body ? 'VERIFY_TOKEN_ACCESS_DENIED' : 'PROVIDER_ACCESS_DENIED');
                    if (response.status === 404 && !body) throw externalError(404, 'Clash Royale account or battle log was not found.', 'PROVIDER_NOT_FOUND');
                    if (!response.ok) throw unavailable('PROVIDER_REJECTED_REQUEST');
                    const value = await response.json().catch(() => null);
                    if (!value || typeof value !== 'object') throw unavailable('PROVIDER_BAD_RESPONSE');
                    health = { status: 'ok', at: new Date(clock()) };
                    if (!body && ttl) {
                        if (cache.size >= 256) cache.delete(cache.keys().next().value);
                        cache.set(path, { value, until: clock() + ttl });
                    }
                    return value;
                }
            } catch (error) {
                health = { status: error.code || 'PROVIDER_ERROR', at: new Date(clock()) };
                throw error.status ? error : unavailable('PROVIDER_ERROR');
            } finally { active--; if (!body) pending.delete(path); }
        })();
        if (!body) pending.set(path, work);
        return work;
    }
    const playerPath = tag => '/players/' + encodeURIComponent(normalizeTag(tag));
    return {
        id: 'clash-royale', mode: 'triple-draft',
        normalizeBattle, mergeEvidence,
        health: () => ({ ...health, configured: !!apiKey, tokenVerification }),
        async profile(tag, { fresh = false } = {}) {
            const row = await request(playerPath(tag), { ttl: fresh ? 0 : 30_000 });
            if (row.tag !== normalizeTag(tag) || typeof row.name !== 'string' || !Number.isSafeInteger(row.trophies) || row.trophies < 0) throw unavailable('PROVIDER_BAD_PROFILE');
            return { tag: row.tag, name: row.name.slice(0, 48), trophies: row.trophies, clan: typeof row.clan?.name === 'string' ? row.clan.name.slice(0, 48) : null };
        },
        async proveOwnership(tag, token) {
            if (!tokenVerification) throw unavailable('VERIFY_TOKEN_NOT_ENABLED');
            if (typeof token !== 'string' || !/^[a-z0-9]{4,64}$/i.test(token)) throw externalError(400, 'Enter the in-game API token, not your Supercell ID credentials.');
            const row = await request(playerPath(tag) + '/verifytoken', { body: { token } });
            if (row.status === 'invalid') throw externalError(422, 'The in-game API token was rejected.', 'TOKEN_REJECTED');
            if (row.status !== 'ok' || (row.tag != null && row.tag !== normalizeTag(tag))) throw unavailable('VERIFY_TOKEN_BAD_RESPONSE');
        },
        async battles(tag) {
            const rows = await request(playerPath(tag) + '/battlelog');
            if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !row || !battleDate(row.battleTime) || !Array.isArray(row.team) || !Array.isArray(row.opponent))) throw unavailable('PROVIDER_BAD_BATTLE_LOG');
            return rows;
        },
    };
}
