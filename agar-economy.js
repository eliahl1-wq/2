export const AGAR_BPS_DENOMINATOR = 10_000n;

export function usdPriceToAtomic({ usdPrice, tokenPriceUsd, decimals }) {
    const usd = Number(usdPrice);
    const price = Number(tokenPriceUsd);
    const places = Number(decimals);
    if (!Number.isFinite(usd) || usd <= 0) throw new Error('USD price must be positive');
    if (!Number.isFinite(price) || price <= 0) throw new Error('Token price must be positive');
    if (!Number.isInteger(places) || places < 0 || places > 18) throw new Error('Invalid token decimals');
    return BigInt(Math.ceil((usd / price) * (10 ** places)));
}

export function splitAtomicAmount(totalAtomic, treasuryBps = 9000, ownerBps = 1000) {
    const total = BigInt(totalAtomic);
    const treasury = BigInt(treasuryBps);
    const owner = BigInt(ownerBps);
    if (total <= 0n) throw new Error('Total token amount must be positive');
    if (treasury < 0n || owner < 0n || treasury + owner !== AGAR_BPS_DENOMINATOR) {
        throw new Error('Revenue shares must total 10000 bps');
    }
    const ownerAtomic = (total * owner) / AGAR_BPS_DENOMINATOR;
    return {
        ownerAtomic,
        treasuryAtomic: total - ownerAtomic,
    };
}

export const AGAR_SHOP_PRODUCTS = Object.freeze([
    Object.freeze({
        id: 'flags:bundle',
        gameMode: 'all',
        skinId: 'flags',
        name: 'Flag Pack',
        usdPrice: 1,
    }),
    Object.freeze({
        id: 'agar:rainbow',
        gameMode: 'agar',
        skinId: 'rainbow',
        name: 'Rainbow',
        usdPrice: 3,
    }),
    Object.freeze({
        id: 'slither:rainbow',
        gameMode: 'slither',
        skinId: 'rainbow',
        name: 'Rainbow',
        usdPrice: 3,
    }),
    Object.freeze({
        id: 'slither:agarstake',
        gameMode: 'slither',
        skinId: 'agarstake',
        name: 'AgarStake Charm',
        usdPrice: 1,
    }),
    Object.freeze({
        id: 'slither:aurora',
        gameMode: 'slither',
        skinId: 'aurora',
        name: 'Aurora Veil',
        usdPrice: 2,
    }),
    Object.freeze({
        id: 'slither:eclipse',
        gameMode: 'slither',
        skinId: 'eclipse',
        name: 'Solar Eclipse',
        usdPrice: 2,
    }),
]);

export function getAgarShopProduct(productId) {
    return AGAR_SHOP_PRODUCTS.find((product) => product.id === productId) || null;
}
