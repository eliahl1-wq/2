import { Worker } from 'node:worker_threads';

let template = null;
let pending = null;
// Map generation is CPU-heavy. It must not pause ongoing arena/server ticks.
export function prepareSurvivBRMap() {
    if (template) return Promise.resolve(template);
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./surviv-br-map-worker.js', import.meta.url));
        worker.once('message', map => { template = map; resolve(map); });
        worker.once('error', reject);
        worker.once('exit', code => { if (!template) reject(new Error(`Surviv map worker exited (${code})`)); });
    }).catch(error => { pending = null; throw error; });
    return pending;
}

export function clonePreparedSurvivBRMap() {
    return template ? structuredClone(template) : null;
}
