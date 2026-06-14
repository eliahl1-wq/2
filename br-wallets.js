/**
 * Battle Royale house wallets — isolated from the main arena house wallet.
 *
 * Entry fees flow:  player deposit wallet → BR house wallet (per variant + entry tier)
 * Winner payout:    same wallet → player deposit wallet
 * Owner cut:        2.5% of pot swept to OWNER_VAULT after winner is paid
 *
 * Env naming:
 *   $5 Agar:    BR_AGAR_HOUSE_WALLET_*
 *   $10 Agar:   BR_AGAR_10_HOUSE_WALLET_*
 *   $5 Slither: BR_SLITHER_HOUSE_WALLET_*
 *   $10 Slither: BR_SLITHER_10_HOUSE_WALLET_*
 *
 * The main arena reset only sweeps HOUSE_WALLET_* — never these wallets.
 */

export const BR_ENTRY_FEES = [5, 10];
export const DEFAULT_BR_ENTRY_FEE = 5;

const VARIANTS = ['agar', 'slither'];

export function normalizeBREntryFee(fee) {
    const n = Number(fee);
    return BR_ENTRY_FEES.includes(n) ? n : DEFAULT_BR_ENTRY_FEE;
}

/** Env prefix for a variant + entry tier (without _HOUSE_WALLET suffix). */
export function brWalletEnvPrefix(variant, entryFeeUsd) {
    if (!VARIANTS.includes(variant)) {
        throw new Error(`Invalid battle royale variant: ${variant}`);
    }
    const fee = normalizeBREntryFee(entryFeeUsd);
    if (fee === 5) return `BR_${variant.toUpperCase()}`;
    return `BR_${variant.toUpperCase()}_${fee}`;
}

function readWallet(prefix) {
    return {
        address: process.env[`${prefix}_HOUSE_WALLET_ADDRESS`]?.trim() || null,
        secret: process.env[`${prefix}_HOUSE_WALLET_SECRET`]?.trim() || null,
        prefix,
    };
}

export function getBRHouseWallet(variant, entryFeeUsd) {
    const fee = normalizeBREntryFee(entryFeeUsd);
    const prefix = brWalletEnvPrefix(variant, fee);
    const wallet = readWallet(prefix);
    if (!wallet.address || !wallet.secret) {
        throw new Error(
            `BR house wallet not configured for ${variant} $${fee}. `
            + `Set ${prefix}_HOUSE_WALLET_ADDRESS and ${prefix}_HOUSE_WALLET_SECRET.`,
        );
    }
    return wallet;
}

export function isBRWalletConfigured(variant, entryFeeUsd = DEFAULT_BR_ENTRY_FEE) {
    const prefix = brWalletEnvPrefix(variant, entryFeeUsd);
    const w = readWallet(prefix);
    return !!(w.address && w.secret);
}

/** All configured BR wallets (for dev status). */
export function listBRHouseWallets() {
    const list = [];
    for (const variant of VARIANTS) {
        for (const fee of BR_ENTRY_FEES) {
            const prefix = brWalletEnvPrefix(variant, fee);
            const w = readWallet(prefix);
            if (w.address) {
                list.push({ variant, entryFeeUsd: fee, address: w.address, prefix });
            }
        }
    }
    return list;
}

export function validateBRWalletsOnStartup({ devFreePlay = false } = {}) {
    if (devFreePlay) {
        console.log('ℹ️  DEV_FREE_PLAY — BR house wallets optional (simulated payments).');
        return;
    }

    for (const variant of VARIANTS) {
        for (const fee of BR_ENTRY_FEES) {
            const prefix = brWalletEnvPrefix(variant, fee);
            const w = readWallet(prefix);
            const label = `${variant} $${fee}`;
            if (w.address && w.secret) {
                console.log(`✅ BR ${label} house wallet: ${w.address}`);
            } else if (w.address || w.secret) {
                console.warn(
                    `⚠️  BR ${label} wallet incomplete — set BOTH `
                    + `${prefix}_HOUSE_WALLET_ADDRESS and ${prefix}_HOUSE_WALLET_SECRET.`,
                );
            } else {
                console.warn(
                    `⚠️  BR ${label} wallet missing — $${fee} ${variant} queue disabled until configured. `
                    + `Run: node scripts/generate-br-wallets.mjs`,
                );
            }
        }
    }
}
