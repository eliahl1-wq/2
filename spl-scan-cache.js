// Persistent stale-while-revalidate cache. RPC work is bounded across all pages
// and admins; stale data is visible, never treated as transfer authorization.
export function createSplScanCache({ scan, save, now = Date.now, ttlMs = 60_000, concurrency = 6, onError = () => {} }) {
    const pending = new Map();
    const queue = [];
    const versions = new Map();
    let active = 0;
    function drain() {
        while (active < concurrency && queue.length) {
            const job = queue.shift();
            active++;
            (async () => {
                let result;
                try {
                    const tokens = await scan(job.address);
                    result = { tokens, checkedAt: new Date(now()), attemptedAt: new Date(now()), error: null };
                } catch (error) {
                    result = { tokens: job.previous?.tokens || [], checkedAt: job.previous?.checkedAt || null,
                        attemptedAt: new Date(now()), error: error.message || 'RPC scan failed' };
                }
                // A transfer invalidates work begun before it, avoiding stale resurrection.
                if ((versions.get(job.address) || 0) === job.version) await save(job.address, result);
                return result;
            })().then(job.resolve, job.reject).finally(() => {
                pending.delete(job.address); active--; drain();
            });
        }
    }
    function refresh(address, previous) {
        if (pending.has(address)) return pending.get(address);
        const promise = new Promise((resolve, reject) => {
            queue.push({ address, previous, version: versions.get(address) || 0, resolve, reject });
        });
        pending.set(address, promise);
        promise.catch(onError);
        drain();
        return promise;
    }
    return {
        async get(address, record, { cachedOnly = false, force = false } = {}) {
            const age = now() - new Date(record?.attemptedAt || 0).getTime();
            const stale = !record || age >= ttlMs;
            if (stale || force) {
                const work = refresh(address, record);
                if (force || (!record && !cachedOnly)) return { ...await work, refreshing: false, cached: false };
            }
            return { tokens: record?.tokens || [], checkedAt: record?.checkedAt || null,
                error: record?.error || null, refreshing: pending.has(address), cached: !!record };
        },
        invalidate(address) { versions.set(address, (versions.get(address) || 0) + 1); },
    };
}
