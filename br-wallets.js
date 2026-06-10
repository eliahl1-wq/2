/**
 * Battle Royale house wallets — isolated from the main arena house wallet.
 *
 * Entry fees flow:  player deposit wallet → BR house wallet (per variant)
 * Winner payout:    BR house wallet → player deposit wallet
 *
 * The main arena reset only sweeps HOUSE_WALLET_* — never these wallets.
 */

const VARIANTS = ['agar', 'slither'];

function readWallet(prefix) {
    return {
        address: process.env[`${prefix}_HOUSE_WALLET_ADDRESS`]?.trim() || null,
        secret: process.env[`${prefix}_HOUSE_WALLET_SECRET`]?.trim() || null,
    };
}

export const BR_WALLETS = {
    agar: readWallet('BR_AGAR'),
    slither: readWallet('BR_SLITHER'),
};

export function isBRWalletConfigured(variant) {
    const w = BR_WALLETS[variant];
    return !!(w?.address && w?.secret);
}

export function getBRHouseWallet(variant) {
    if (!VARIANTS.includes(variant)) {
        throw new Error(`Invalid battle royale variant: ${variant}`);
    }
    const wallet = BR_WALLETS[variant];
    if (!wallet.address || !wallet.secret) {
        throw new Error(
            `BR house wallet not configured for "${variant}". `
            + `Set BR_${variant.toUpperCase()}_HOUSE_WALLET_ADDRESS and BR_${variant.toUpperCase()}_HOUSE_WALLET_SECRET.`,
        );
    }
    return wallet;
}

export function validateBRWalletsOnStartup({ devFreePlay = false } = {}) {
    if (devFreePlay) {
        console.log('ℹ️  DEV_FREE_PLAY — BR house wallets optional (simulated payments).');
        return;
    }

    for (const variant of VARIANTS) {
        const w = BR_WALLETS[variant];
        if (w.address && w.secret) {
            console.log(`✅ BR ${variant} house wallet: ${w.address}`);
        } else if (w.address || w.secret) {
            console.warn(
                `⚠️  BR ${variant} wallet incomplete — set BOTH `
                + `BR_${variant.toUpperCase()}_HOUSE_WALLET_ADDRESS and BR_${variant.toUpperCase()}_HOUSE_WALLET_SECRET.`,
            );
        } else {
            console.warn(
                `⚠️  BR ${variant} wallet missing — battle royale ${variant} queue disabled until configured. `
                + `Run: npm run br-wallets:generate`,
            );
        }
    }
}
