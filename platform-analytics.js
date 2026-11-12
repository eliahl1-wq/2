import { createHmac } from 'node:crypto';

export const VISITOR_RETENTION_DAYS = 400;
const DAY = 86_400_000;

export function visitorKey(value, secret) {
    if (typeof value !== 'string' || !/^(?:[a-f0-9-]{32,64}|p-[a-z0-9-]{10,100})$/i.test(value) || !secret) return null;
    return createHmac('sha256', secret).update(`platform-visitor-v1:${value}`).digest('hex');
}

export function visitorDevice(userAgent = '') {
    return /mobile|android|iphone|ipad/i.test(userAgent) ? 'mobile' : 'desktop';
}

// One upsert per browser/day/minute, not one database write per stats poll.
// Never wait for this best-effort analytics path in auth, gameplay or payments.
export function createVisitorTracker({ Visit, State, secret, clock = Date.now, onError = () => {} }) {
    const saved = new Map();
    let stateReady = false;
    return async function track({ id, userId = null, userAgent = '' }) {
        const key = visitorKey(id, secret);
        if (!key || /bot\b|crawler|spider|headless/i.test(userAgent)) return false;
        const now = clock();
        const day = new Date(Math.floor(now / DAY) * DAY);
        const throttleKey = `${day.toISOString()}:${key}:${userId || 'guest'}`;
        if (saved.has(throttleKey) && now - saved.get(throttleKey) < 60_000) return false;
        saved.set(throttleKey, now);
        if (saved.size > 20_000) for (const [entry, at] of saved) if (now - at >= 60_000) saved.delete(entry);
        // Bounded even with a burst of arbitrary client-generated IDs.
        if (saved.size > 20_000) saved.delete(saved.keys().next().value);
        try {
            if (!stateReady) {
                await State.updateOne({ _id: 'visitors' }, { $min: { since: new Date(now) } }, { upsert: true });
                stateReady = true;
            }
            await Visit.updateOne({ _id: `${day.toISOString().slice(0, 10)}:${key}`, day, visitorKey: key }, {
                $setOnInsert: { firstSeenAt: new Date(now), device: visitorDevice(userAgent),
                    expiresAt: new Date(day.getTime() + VISITOR_RETENTION_DAYS * DAY) },
                $max: { lastSeenAt: new Date(now) },
                ...(userId ? { $addToSet: { userIds: userId } } : {}),
            }, { upsert: true });
            return true;
        } catch (error) {
            saved.delete(throttleKey);
            onError(error);
            return false;
        }
    };
}

const number = field => ({ $convert: { input: field, to: 'double', onError: 0, onNull: 0 } });

export function depositGrowthPipeline(match, { from, previousFrom, to }) {
    const current = { $and: [{ $gte: ['$createdAt', from] }, { $lte: ['$createdAt', to] }] };
    const previous = { $and: [{ $gte: ['$createdAt', previousFrom] }, { $lt: ['$createdAt', from] }] };
    return [
        { $match: { $and: [match, { amount: { $gt: 0 }, userId: { $ne: null }, createdAt: { $gte: previousFrom, $lte: to } }] } },
        { $facet: {
            accounts: [
                { $group: { _id: '$userId', firstAt: { $min: '$createdAt' },
                    currentCount: { $sum: { $cond: [current, 1, 0] } },
                    previousCount: { $sum: { $cond: [previous, 1, 0] } },
                    currentSol: { $sum: { $cond: [current, number('$amount'), 0] } },
                    previousSol: { $sum: { $cond: [previous, number('$amount'), 0] } } } },
                { $match: { $or: [{ currentCount: { $gt: 0 } }, { previousCount: { $gt: 0 } }] } },
                // Only look up full history for accounts active in these periods.
                // The existing userId/createdAt index serves earliest-deposit lookup.
                { $lookup: { from: 'transactions', localField: '_id', foreignField: 'userId', pipeline: [
                    { $match: { $and: [match, { amount: { $gt: 0 }, createdAt: { $lte: to } }] } },
                    { $sort: { createdAt: 1 } }, { $limit: 1 }, { $project: { createdAt: 1 } },
                ], as: '_first' } },
                { $set: { firstAt: { $arrayElemAt: ['$_first.createdAt', 0] } } },
                { $unset: '_first' },
            ],
            daily: [
                { $match: { createdAt: { $gte: from } } },
                { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, user: '$userId' },
                    count: { $sum: 1 }, sol: { $sum: number('$amount') } } },
                { $group: { _id: '$_id.day', depositors: { $sum: 1 }, deposits: { $sum: '$count' }, depositSol: { $sum: '$sol' } } },
                { $sort: { _id: 1 } },
            ],
        } },
    ];
}

export function summarizeDepositGrowth(accounts, { from, previousFrom, newUserIds = [] }) {
    const cohort = new Set(newUserIds.map(String));
    const current = accounts.filter(row => row.currentCount > 0);
    const previous = accounts.filter(row => row.previousCount > 0);
    const first = (rows, start, end) => rows.filter(row => new Date(row.firstAt) >= start && (!end || new Date(row.firstAt) < end)).length;
    return {
        depositors: current.length,
        previousDepositors: previous.length,
        firstDepositors: first(current, from),
        previousFirstDepositors: first(previous, previousFrom, from),
        repeatDepositors: current.filter(row => new Date(row.firstAt) < from).length,
        multiDepositAccounts: current.filter(row => row.currentCount > 1).length,
        newUsersWhoDeposited: current.filter(row => cohort.has(String(row._id))).length,
        deposits: current.reduce((n, row) => n + row.currentCount, 0),
        depositSol: current.reduce((n, row) => n + row.currentSol, 0),
    };
}

export async function getVisitorAnalytics(Visit, State, { from, previousFrom, to, excludedUserIds = [] }) {
    const [rows, state] = await Promise.all([
        Visit.aggregate([
            { $match: { day: { $gte: previousFrom, $lte: to },
                ...(excludedUserIds.length ? { userIds: { $nin: excludedUserIds } } : {}) } },
            { $facet: {
                current: [ { $match: { day: { $gte: from } } }, { $group: { _id: '$visitorKey' } }, { $count: 'count' } ],
                previous: [ { $match: { day: { $lt: from } } }, { $group: { _id: '$visitorKey' } }, { $count: 'count' } ],
                daily: [ { $match: { day: { $gte: from } } },
                    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$day' } }, visitors: { $sum: 1 } } },
                    { $sort: { _id: 1 } } ],
                devices: [ { $match: { day: { $gte: from } } }, { $group: { _id: '$visitorKey', device: { $first: '$device' } } },
                    { $group: { _id: '$device', count: { $sum: 1 } } } ],
            } },
        ]),
        State.findById('visitors').lean(),
    ]);
    const data = rows[0] || {};
    return { since: state?.since || null, visitors: data.current?.[0]?.count || 0,
        previousVisitors: data.previous?.[0]?.count || 0, daily: data.daily || [], devices: data.devices || [],
        complete: !!state?.since && new Date(state.since) <= from,
        previousComplete: !!state?.since && new Date(state.since) <= previousFrom };
}
