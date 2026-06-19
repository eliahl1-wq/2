export const PRESENCE_TTL_MS = 90_000;

/** @type {Map<string, object>} */
const sitePresence = new Map();

function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || '';
}

function truncateIp(ip) {
    if (!ip) return '—';
    if (ip.includes('.')) {
        const parts = ip.split('.');
        if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
    }
    if (ip.includes(':')) return `${ip.slice(0, 14)}…`;
    return ip;
}

function normalizeRecord(key, prev, meta, now) {
    const seenAt = now;
    const base = (prev && typeof prev === 'object') ? prev : null;
    const firstSeenAt = base?.firstSeenAt ?? seenAt;
    const ip = meta.ip ?? base?.ip ?? null;

    return {
        key: String(key),
        seenAt,
        firstSeenAt,
        ip,
        ipDisplay: truncateIp(ip),
        country: meta.country ?? base?.country ?? null,
        city: meta.city ?? base?.city ?? null,
        timezone: meta.timezone ?? base?.timezone ?? null,
        locale: meta.locale ?? base?.locale ?? null,
        page: meta.page ?? base?.page ?? null,
        gamemode: meta.gamemode ?? base?.gamemode ?? null,
        username: meta.username ?? base?.username ?? null,
        source: meta.source ?? base?.source ?? 'web',
        inGame: meta.inGame != null ? !!meta.inGame : !!base?.inGame,
        gameMode: meta.gameMode ?? base?.gameMode ?? null,
        userAgent: meta.userAgent ?? base?.userAgent ?? null,
    };
}

export function touchSitePresence(key, meta = {}) {
    if (!key) return;
    const now = Date.now();
    const k = String(key);
    const prev = sitePresence.get(k);
    sitePresence.set(k, normalizeRecord(k, prev, meta, now));
}

export function touchSitePresenceFromRequest(req, extra = {}) {
    const key = req.headers['x-presence-id'] || getClientIp(req);
    touchSitePresence(key, {
        ip: getClientIp(req),
        country: req.headers['cf-ipcountry']
            || req.headers['x-vercel-ip-country']
            || extra.country
            || null,
        city: req.headers['cf-ipcity'] || extra.city || null,
        timezone: req.headers['x-presence-timezone'] || extra.timezone || null,
        locale: (req.headers['accept-language'] || '').split(',')[0]?.trim() || extra.locale || null,
        page: req.headers['x-presence-page'] || extra.page || null,
        gamemode: req.headers['x-presence-gamemode'] || extra.gamemode || null,
        username: extra.username || null,
        source: extra.source || 'web',
        inGame: extra.inGame ?? false,
        gameMode: extra.gameMode || null,
        userAgent: (req.headers['user-agent'] || '').slice(0, 140) || null,
    });
}

export function touchSitePresenceFromSocket(socket, extra = {}) {
    const presenceId = socket.handshake?.auth?.presenceId;
    const meta = { source: 'socket', ...extra };
    if (presenceId) touchSitePresence(presenceId, meta);
    touchSitePresence(socket.id, { ...meta, source: 'socket-id' });
}

export function pruneSitePresence() {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [key, rec] of sitePresence) {
        const seenAt = typeof rec === 'number' ? rec : rec?.seenAt;
        if (!seenAt || seenAt < cutoff) sitePresence.delete(key);
    }
}

export function getSiteUsersOnline() {
    pruneSitePresence();
    return sitePresence.size;
}

export function getSitePresenceList() {
    pruneSitePresence();
    return [...sitePresence.values()]
        .filter(rec => rec && typeof rec === 'object')
        .sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
}

export function formatPresenceLocation(rec) {
    const parts = [];
    if (rec.country) parts.push(rec.country);
    if (rec.city) parts.push(rec.city);
    if (rec.timezone) parts.push(rec.timezone);
    else if (rec.locale) parts.push(rec.locale);
    return parts.length ? parts.join(' · ') : '—';
}
