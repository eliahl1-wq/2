const DEFAULT_ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens/{mint}';
let cache = null;

export async function fetchAgarMarketPrice({
    mint,
    symbol = 'ARENA',
    endpoint = process.env.AGAR_MARKET_ENDPOINT || DEFAULT_ENDPOINT,
    minLiquidityUsd = Number(process.env.AGAR_SHOP_MIN_LIQUIDITY_USD || 0),
    fetchImpl = fetch,
}) {
    if (!mint) throw new Error(`${symbol} mint is not configured`);
    const now = Date.now();
    if (cache?.mint === mint && now - cache.fetchedAt < 15_000) return cache;

    const url = endpoint.replaceAll('{mint}', encodeURIComponent(mint));
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`${symbol} market provider returned ${response.status}`);
    const payload = await response.json();
    const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
    const matching = pairs
        .filter((pair) => (
            pair?.baseToken?.address === mint || pair?.quoteToken?.address === mint
        ))
        .map((pair) => ({
            pair,
            liquidityUsd: Number(pair?.liquidity?.usd || 0),
            priceUsd: pair?.baseToken?.address === mint
                ? Number(pair?.priceUsd)
                : Number(pair?.priceNative) > 0
                    ? Number(pair?.priceUsd) / Number(pair.priceNative)
                    : NaN,
        }))
        .filter((entry) => Number.isFinite(entry.priceUsd) && entry.priceUsd > 0)
        .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    const best = matching[0];
    if (!best) throw new Error(`No ${symbol}/USD market pair is available`);
    if (!Number.isFinite(best.liquidityUsd) || best.liquidityUsd < minLiquidityUsd) {
        throw new Error(`${symbol} liquidity must be at least $${minLiquidityUsd}`);
    }
    cache = {
        mint,
        priceUsd: best.priceUsd,
        liquidityUsd: best.liquidityUsd,
        pairAddress: best.pair?.pairAddress || '',
        source: 'dexscreener',
        fetchedAt: now,
    };
    return cache;
}

export function clearAgarMarketCache() {
    cache = null;
}
