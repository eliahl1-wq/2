/** Normal-mode entry tiers (USD). Battle Royale uses its own economy. */
export const ALLOWED_ENTRY_FEES = [5, 10, 20];
export const DEFAULT_ENTRY_FEE = 10;

/** Share of entry fee converted to one Golden Blob (deducted from food pool allocation). */
export const GOLDEN_BLOB_ENTRY_SHARE = 0.10;

/** Server tick rate used for wealth-tax decay (matches processRoom interval). */
export const ECONOMY_TICKS_PER_SECOND = 40;

/** Baseline economy at $10 entry — all values scale linearly with entry fee. */
const BASE = {
    playerStart: 1.0,
    ownerCut: 1.0,
    foodLow: 6.0,   // 1–2 humans
    foodMid: 7.0,   // 3–7 humans
    foodHigh: 8.0,  // 8+ humans
    aiLow: 4.0,   // 1–2 humans: fund 4 bots at botStart stake
    aiMid: 1.0,
    aiHigh: 0.0,
    botStart: 1.0,
    botMax: 500.0,
    foodDensityPerHuman: 250.0,
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
    };
}

/** Golden Blob value for a join (= 10% of entry fee). */
export function getGoldenBlobValue(entryFeeUsd) {
    return normalizeEntryFee(entryFeeUsd) * GOLDEN_BLOB_ENTRY_SHARE;
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

/**
 * Soft wealth tax: decay scales with excess balance above starting size.
 * Returns USD lost this tick (never below startBalance).
 */
export function wealthTaxDecayAmount(balance, startBalance, ticksPerSecond = ECONOMY_TICKS_PER_SECOND) {
    const excess = balance - startBalance;
    if (excess <= 1e-9) return 0;
    const ratio = excess / startBalance;
    const perSecondRate = 0.0015 * (1 + ratio * 0.5);
    const decay = excess * perSecondRate / ticksPerSecond;
    return Math.min(excess, decay);
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
