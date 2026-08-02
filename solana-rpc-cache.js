function defaultCacheKey(publicKey) {
    return publicKey?.toBase58?.() || String(publicKey || '');
}

export function createCachedBalanceReader({
    primaryConnection,
    fallbackConnection = null,
    shouldUseFallback = () => false,
    now = () => Date.now(),
}) {
    const cache = new Map();
    const inFlight = new Map();

    async function read(publicKey, { maxAgeMs = 0, force = false } = {}) {
        const key = defaultCacheKey(publicKey);
        const cached = cache.get(key);
        if (!force && cached && maxAgeMs > 0 && now() - cached.fetchedAt <= maxAgeMs) {
            return { lamports: cached.lamports, fromCache: true };
        }
        if (!force && inFlight.has(key)) return inFlight.get(key);

        const request = (async () => {
            let lamports;
            try {
                lamports = await primaryConnection.getBalance(publicKey);
            } catch (error) {
                if (!fallbackConnection || !shouldUseFallback(error)) throw error;
                lamports = await fallbackConnection.getBalance(publicKey);
            }
            cache.set(key, { lamports, fetchedAt: now() });
            return { lamports, fromCache: false };
        })();
        inFlight.set(key, request);
        try {
            return await request;
        } finally {
            if (inFlight.get(key) === request) inFlight.delete(key);
        }
    }

    function invalidate(publicKey) {
        cache.delete(defaultCacheKey(publicKey));
    }

    return { read, invalidate };
}
