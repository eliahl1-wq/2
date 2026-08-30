const DEFAULT_ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens/{mint}';
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
let cache = null;

async function fetchJupiterPrice({ mint, symbol, decimals, minLiquidityUsd, fetchImpl }) {
    const apiKey = process.env.JUPITER_API_KEY?.trim();
    if (!apiKey) throw new Error('JUPITER_API_KEY is not configured for the market fallback');
    if (minLiquidityUsd > 0) {
        throw new Error(`${symbol} liquidity cannot be verified through the Jupiter price fallback while AGAR_SHOP_MIN_LIQUIDITY_USD is above 0`);
    }
    const baseUrl = (process.env.JUPITER_PRICE_API_URL || 'https://api.jup.ag/price/v3').trim();
    const url = new URL(baseUrl);
    url.searchParams.set('ids', `${mint},${WRAPPED_SOL_MINT}`);
    const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'x-api-key': apiKey },
        signal: AbortSignal.timeout(Math.max(1_000, Number(process.env.AGAR_MARKET_TIMEOUT_MS || 8_000))),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || payload?.message || `Jupiter price provider returned ${response.status}`);
    const data = payload?.data || payload;
    const entry = data?.[mint];
    let priceUsd = Number(entry?.usdPrice ?? entry?.priceUsd ?? entry?.price);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        // Very new Pump tokens may have a swap route before Jupiter Price has
        // indexed the mint. Derive a live executable price from a small
        // SOL->token order and Jupiter's SOL/USD price in that case.
        const solEntry = data?.[WRAPPED_SOL_MINT];
        const solPriceUsd = Number(solEntry?.usdPrice ?? solEntry?.priceUsd ?? solEntry?.price);
        if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) throw new Error('Jupiter SOL/USD price is unavailable');
        const taker = process.env.AGAR_OWNER_REVENUE_ADDRESS?.trim() || process.env.AGAR_TREASURY_ADDRESS?.trim();
        if (!taker) throw new Error('A revenue wallet is required for the Jupiter market quote');
        const quoteLamports = Math.max(100_000, Number(process.env.AGAR_MARKET_QUOTE_LAMPORTS || 1_000_000));
        const swapBaseUrl = (process.env.JUPITER_SWAP_API_URL || 'https://api.jup.ag/swap/v2').replace(/\/$/, '');
        const orderUrl = new URL(`${swapBaseUrl}/order`);
        orderUrl.searchParams.set('inputMint', WRAPPED_SOL_MINT);
        orderUrl.searchParams.set('outputMint', mint);
        orderUrl.searchParams.set('amount', String(Math.trunc(quoteLamports)));
        orderUrl.searchParams.set('taker', taker);
        const orderResponse = await fetchImpl(orderUrl, {
            headers: { Accept: 'application/json', 'x-api-key': apiKey },
            signal: AbortSignal.timeout(Math.max(1_000, Number(process.env.AGAR_MARKET_TIMEOUT_MS || 8_000))),
        });
        const order = await orderResponse.json().catch(() => ({}));
        const tokenAmount = Number(order?.outAmount) / (10 ** decimals);
        if (!orderResponse.ok || !Number.isFinite(tokenAmount) || tokenAmount <= 0) throw new Error(order?.error || order?.message || `Jupiter has no ${symbol} swap quote`);
        priceUsd = (solPriceUsd * (quoteLamports / 1_000_000_000)) / tokenAmount;
    }
    return {
        mint,
        priceUsd,
        liquidityUsd: 0,
        pairAddress: '',
        source: 'jupiter',
        fetchedAt: Date.now(),
    };
}

export async function fetchAgarMarketPrice({
    mint,
    symbol = 'ARENA',
    decimals = Number(process.env.AGAR_TOKEN_DECIMALS || 6),
    endpoint = process.env.AGAR_MARKET_ENDPOINT || DEFAULT_ENDPOINT,
    minLiquidityUsd = Number(process.env.AGAR_SHOP_MIN_LIQUIDITY_USD || 0),
    fetchImpl = fetch,
}) {
    if (!mint) throw new Error(`${symbol} mint is not configured`);
    const now = Date.now();
    if (cache?.mint === mint && now - cache.fetchedAt < 15_000) return cache;

    const url = endpoint.replaceAll('{mint}', encodeURIComponent(mint));
    try {
        const response = await fetchImpl(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(Math.max(1_000, Number(process.env.AGAR_MARKET_TIMEOUT_MS || 8_000))),
        });
        if (!response.ok) throw new Error(`${symbol} market provider returned ${response.status}`);
        const payload = await response.json();
        const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
        const matching = pairs
            .filter((pair) => pair?.baseToken?.address === mint || pair?.quoteToken?.address === mint)
            .map((pair) => ({
                pair,
                liquidityUsd: Number(pair?.liquidity?.usd || 0),
                priceUsd: pair?.baseToken?.address === mint
                    ? Number(pair?.priceUsd)
                    : Number(pair?.priceNative) > 0 ? Number(pair?.priceUsd) / Number(pair.priceNative) : NaN,
            }))
            .filter((entry) => Number.isFinite(entry.priceUsd) && entry.priceUsd > 0)
            .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
        const best = matching[0];
        if (!best) throw new Error(`No ${symbol}/USD market pair is available`);
        if (!Number.isFinite(best.liquidityUsd) || best.liquidityUsd < minLiquidityUsd) throw new Error(`${symbol} liquidity must be at least $${minLiquidityUsd}`);
        cache = { mint, priceUsd: best.priceUsd, liquidityUsd: best.liquidityUsd, pairAddress: best.pair?.pairAddress || '', source: 'dexscreener', fetchedAt: now };
    } catch (dexError) {
        try {
            cache = await fetchJupiterPrice({ mint, symbol, decimals, minLiquidityUsd, fetchImpl });
        } catch (jupiterError) {
            throw new Error(`Market data unavailable: DexScreener: ${dexError.message}; Jupiter: ${jupiterError.message}`);
        }
    }
    return cache;
}

export function clearAgarMarketCache() {
    cache = null;
}
