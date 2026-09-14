/**
 * Transactions that are allowed to affect real-money reporting and rankings.
 *
 * `excludedFromReports` is the canonical flag for public/personal free play.
 * `meta.simulated` and the metadata fallbacks also cover dev free play and
 * legacy rows written before every free-play path set the canonical flag.
 */
export const REPORTED_TRANSACTION_MATCH = Object.freeze({
    excludedFromReports: { $ne: true },
    'meta.simulated': { $ne: true },
    'meta.freePlay': { $ne: true },
    'meta.freeMode': { $ne: true },
    'meta.publicFreeMode': { $ne: true },
    'meta.personalFreePlay': { $ne: true },
    'meta.signature': { $not: /^simulated(?:_|$)/i },
    'meta.roomId': { $not: /^(?:personal-)?freeplay-/i },
});

export function isFreePlayTransaction(transaction) {
    const meta = transaction?.meta || {};
    return transaction?.excludedFromReports === true
        || meta.simulated === true
        || meta.freePlay === true
        || meta.freeMode === true
        || meta.publicFreeMode === true
        || meta.personalFreePlay === true
        || /^simulated(?:_|$)/i.test(String(meta.signature || ''))
        || /^(?:personal-)?freeplay-/i.test(String(meta.roomId || ''));
}
