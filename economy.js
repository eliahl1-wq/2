/** Normal-mode entry tiers (USD). Battle Royale uses its own economy. */
export const ALLOWED_ENTRY_FEES = [5, 10, 20];
export const DEFAULT_ENTRY_FEE = 10;

/** Share of entry fee converted to one Golden Blob (deducted from food pool allocation). */
export const GOLDEN_BLOB_ENTRY_SHARE = 0.10;

/** Server tick rate used for wealth-tax decay (matches processRoom interval). */
export const ECONOMY_TICKS_PER_SECOND = 40;

/** Platform cut on normal agar/slither cashouts (matches Slither Arena $5 tier). */
export const NORMAL_CASHOUT_FEE_PCT = 0.035;

/** Baseline economy at $10 entry — all values scale linearly with entry fee. */
const BASE = {
    playerStart: 1.0,
    /** Extra food-pool dollars per join (formerly owner cut). */
    joinFoodBonus: 1.0,
    foodLow: 12.0,   // 1–2 humans
    foodMid: 16.0,   // 3–7 humans
    foodHigh: 20.0,  // 8+ humans
    aiLow: 2.0,   // per join: fund 2 bots; 2 joins → 4 bots max at botStart stake
    aiMid: 1.0,
    aiHigh: 0.0,
    botStart: 1.0,
    botMax: 500.0,
    foodDensityPerHuman: 500.0,
    /** Snake mass gained per normal pellet at $10 entry ($5→0.01, $10→0.02, $20→0.04). Decoupled from dollar value. */
    massPerPellet: 0.02,
    /** Pellet dollar value at $10 entry ($5→$0.02, $10→$0.04, $20→$0.08). Half the blob count, same total food pool $. */
    foodBlobValue: 0.02,
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
        /** In-game dollars (HUD, cashout, wealth tax). Scales with entry tier. */
        playerStartBalance: BASE.playerStart * s,
        /** Snake mass / visual size — fixed baseline, not tied to entry tier. */
        massStartBalance: BASE.playerStart,
        massPerPellet: BASE.massPerPellet,
        goldenBlobMass: getGoldenBlobValue(DEFAULT_ENTRY_FEE),
        joinFoodBonus: BASE.joinFoodBonus * s,
        cashoutFeePct: NORMAL_CASHOUT_FEE_PCT,
        cashoutPlayerPct: 1 - NORMAL_CASHOUT_FEE_PCT,
        foodLow: BASE.foodLow * s,
        foodMid: BASE.foodMid * s,
        foodHigh: BASE.foodHigh * s,
        aiLow: BASE.aiLow * s,
        aiMid: BASE.aiMid * s,
        aiHigh: BASE.aiHigh * s,
        botStartBalance: BASE.botStart * s,
        botMaxBalance: BASE.botMax * s,
        foodDensityPerHuman: BASE.foodDensityPerHuman * s,
        foodBlobValue: BASE.foodBlobValue * s,
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

/** Slither Arena entry tiers (USD) — separate pools from normal mode. */
export const COMPETITIVE_SLITHER_ENTRY_FEES = [2, 5];
export const DEFAULT_COMPETITIVE_ENTRY_FEE = 5;

/** Surviv entry tier (USD) — separate pool. */
export const SURVIV_ENTRY_FEES = [5];
export const DEFAULT_SURVIV_ENTRY_FEE = 5;

/** Platform cut on Slither Arena cashouts by entry tier ($5 keeps legacy 3.5%). */
const COMPETITIVE_CASHOUT_FEE_PCT = {
    2: 0.05,
    5: 0.035,
};

export function normalizeCompetitiveEntryFee(fee) {
    const n = Number(fee);
    return COMPETITIVE_SLITHER_ENTRY_FEES.includes(n) ? n : DEFAULT_COMPETITIVE_ENTRY_FEE;
}

export function normalizeSurvivEntryFee(fee) {
    const n = Number(fee);
    return SURVIV_ENTRY_FEES.includes(n) ? n : DEFAULT_SURVIV_ENTRY_FEE;
}

/** Scaled Slither Arena economy for a given entry tier. */
export function getCompetitiveEconomy(entryFeeUsd) {
    const entry = normalizeCompetitiveEntryFee(entryFeeUsd);
    const cashoutFeePct = COMPETITIVE_CASHOUT_FEE_PCT[entry] ?? 0.035;
    return {
        entryFeeUsd: entry,
        dollarStart: entry,
        // Snake mass uses the same baseline as $10 normal slither — size is not tied to entry tier or dollars.
        playerStartBalance: BASE.playerStart,
        massPerPellet: BASE.massPerPellet,
        cashoutFeePct,
        cashoutPlayerPct: 1 - cashoutFeePct,
    };
}

/** Surviv economy — $5 entry, $2 player start, $3 map loot pool per join. */
export function getSurvivEconomy(entryFeeUsd) {
    const entry = normalizeSurvivEntryFee(entryFeeUsd);
    const cashoutFeePct = 0.035;
    return {
        entryFeeUsd: entry,
        playerStartBalance: 2.0,
        lootPoolOnJoin: 3.0,
        cashoutFeePct,
        cashoutPlayerPct: 1 - cashoutFeePct,
    };
}
