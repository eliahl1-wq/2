const RANGE_CONFIG = Object.freeze({
    '1H': { timeframe: 'minute', aggregate: 1, limit: 60 },
    '6H': { timeframe: 'minute', aggregate: 5, limit: 72 },
    '24H': { timeframe: 'minute', aggregate: 15, limit: 96 },
    '7D': { timeframe: 'hour', aggregate: 1, limit: 168 },
});

const cache = new Map();

function selectPrimaryPair(pairs, mint) {
    return [...pairs]
        .filter((pair) => pair?.baseToken?.address === mint || pair?.quoteToken?.address === mint)
        .sort((left, right) => (
            (Number(right?.liquidity?.usd) || 0) - (Number(left?.liquidity?.usd) || 0)
        ))[0] || null;
}

export async function fetchAgarCandles({
    mint,
    symbol = 'ARC',
    range = '24H',
    dexEndpoint = process.env.AGAR_MARKET_ENDPOINT
        || 'https://api.dexscreener.com/latest/dex/tokens/{mint}',
    candlesEndpoint = process.env.AGAR_CANDLES_ENDPOINT
        || 'https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/ohlcv/{timeframe}',
}) {
    const normalizedRange = String(range || '').toUpperCase();
    const rangeConfig = RANGE_CONFIG[normalizedRange];
    if (!rangeConfig) throw Object.assign(new Error('Unsupported chart range.'), { status: 400 });

    const cacheKey = `${mint}:${normalizedRange}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < 15_000) return cached.value;

    const pairResponse = await fetch(
        dexEndpoint.replaceAll('{mint}', encodeURIComponent(mint)),
        { headers: { Accept: 'application/json' } },
    );
    if (!pairResponse.ok) throw new Error(`Market lookup failed (${pairResponse.status})`);
    const pairPayload = await pairResponse.json();
    const pair = selectPrimaryPair(pairPayload?.pairs || [], mint);
    if (!pair?.pairAddress) throw new Error(`No ${symbol} trading pool was found.`);

    const tokenSide = pair.baseToken?.address === mint ? 'base' : 'quote';
    const url = new URL(candlesEndpoint
        .replaceAll('{pool}', encodeURIComponent(pair.pairAddress))
        .replaceAll('{timeframe}', rangeConfig.timeframe));
    url.searchParams.set('aggregate', String(rangeConfig.aggregate));
    url.searchParams.set('limit', String(rangeConfig.limit));
    url.searchParams.set('currency', 'usd');
    url.searchParams.set('token', tokenSide);

    const candlesResponse = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!candlesResponse.ok) throw new Error(`Chart history failed (${candlesResponse.status})`);
    const payload = await candlesResponse.json();
    const points = (payload?.data?.attributes?.ohlcv_list || [])
        .map(([time, open, high, low, close, volume]) => ({
            time: Number(time), open: Number(open), high: Number(high),
            low: Number(low), close: Number(close), volume: Number(volume),
        }))
        .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.close) && point.close > 0)
        .sort((left, right) => left.time - right.time);

    const value = {
        range: normalizedRange,
        pairAddress: pair.pairAddress,
        dexId: pair.dexId || '',
        points,
        updatedAt: new Date().toISOString(),
    };
    cache.set(cacheKey, { loadedAt: Date.now(), value });
    return value;
}
