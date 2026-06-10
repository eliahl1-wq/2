/** Normal-mode entry tiers (USD). Battle Royale uses its own economy. */
export const ALLOWED_ENTRY_FEES = [5, 10, 20];
export const DEFAULT_ENTRY_FEE = 10;

/** Baseline economy at $10 entry — all values scale linearly with entry fee. */
const BASE = {
    playerStart: 1.0,
    ownerCut: 1.0,
    foodLow: 6.0,   // 1–2 humans
    foodMid: 7.0,   // 3–7 humans
    foodHigh: 8.0,  // 8+ humans
    aiLow: 2.0,
    aiMid: 1.0,
    aiHigh: 0.0,
    botStart: 1.0,
    botMax: 500.0,
    foodDensityPerHuman: 250.0,
    rankBonus1st: 20.0,
    rankBonus2nd3rd: 10.0,
};

export function normalizeEntryFee(fee) {
    const n = Number(fee);
    return ALLOWED_ENTRY_FEES.includes(n) ? n : DEFAULT_ENTRY_FEE;
}

export function scaleForEntry(entryFeeUsd) {
    return normalizeEntryFee(entryFeeUsd) / DEFAULT_ENTRY_FEE;
}

/** Full scaled economy for a given entry tier. */
export function getEconomy(entryFeeUsd) {
    const entry = normalizeEntryFee(entryFeeUsd);
    const s = entry / DEFAULT_ENTRY_FEE;
    return {
        entryFeeUsd: entry,
        playerStartBalance: BASE.playerStart * s,
        ownerCut: BASE.ownerCut * s,
        foodLow: BASE.foodLow * s,
        foodMid: BASE.foodMid * s,
        foodHigh: BASE.foodHigh * s,
        aiLow: BASE.aiLow * s,
        aiMid: BASE.aiMid * s,
        aiHigh: BASE.aiHigh * s,
        botStartBalance: BASE.botStart * s,
        botMaxBalance: BASE.botMax * s,
        foodDensityPerHuman: BASE.foodDensityPerHuman * s,
        rankBonus1st: BASE.rankBonus1st * s,
        rankBonus2nd3rd: BASE.rankBonus2nd3rd * s,
    };
}

/** Food + AI allocation for current population after a join. */
export function getJoinPoolSplit(entryFeeUsd, activeHumansAfterJoin) {
    const eco = getEconomy(entryFeeUsd);
    if (activeHumansAfterJoin < 3) {
        return { food: eco.foodLow, ai: eco.aiLow };
    }
    if (activeHumansAfterJoin < 8) {
        return { food: eco.foodMid, ai: eco.aiMid };
    }
    return { food: eco.foodHigh, ai: eco.aiHigh };
}

/** Average entry fee for humans in a mode (defaults to $10 if empty). */
export function avgEntryFeeForMode(players, mode) {
    const humans = players.filter(p =>
        !p.isBot && (p.mode === mode || (mode === 'agar' && !p.mode))
    );
    if (!humans.length) return DEFAULT_ENTRY_FEE;
    const sum = humans.reduce((acc, p) => acc + normalizeEntryFee(p.entryFeeUsd), 0);
    return sum / humans.length;
}

export function botStakeForMode(players, mode) {
    return getEconomy(avgEntryFeeForMode(players, mode)).botStartBalance;
}
