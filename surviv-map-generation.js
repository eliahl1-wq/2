import { Worker } from 'node:worker_threads';

export function generateSurvivMapInWorker() {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./surviv-br-map-worker.js', import.meta.url));
        let received = false;
        worker.once('message', map => { received = true; resolve(map); });
        worker.once('error', reject);
        worker.once('exit', code => { if (!received) reject(new Error(`Surviv map worker exited before returning a map (${code}).`)); });
    });
}

// One generation at a time, plus one prepared next map. Each room gets its own
// generated object graph, so damage/loot cannot leak between stake/free rooms.
export function createSurvivMapGenerator(generate = generateSurvivMapInWorker) {
    let queued = Promise.resolve();
    let reserved = null;
    const warm = () => {
        if (!reserved) {
            reserved = queued.then(generate);
            queued = reserved.catch(() => {});
            // A prepared reserve may fail before a join asks for it. Suppress
            // unhandled-rejection noise; take() still observes and retries it.
            reserved.catch(() => {});
        }
        return reserved;
    };
    return {
        warm,
        async take() {
            const map = warm();
            reserved = null;
            warm();
            return map;
        },
    };
}
