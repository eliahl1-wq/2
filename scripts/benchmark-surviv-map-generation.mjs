import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { generateSurvivMap, SURVIV } from '../surviv-engine.js';
import { generateSurvivMapInWorker } from '../surviv-map-generation.js';

// Timer responsiveness during actual full-map generation. This process has no
// connections, accounts or payments. Maps are random, not identical seed trials.
async function measure(label, generate) {
    let previous = performance.now();
    const gaps = [];
    const timer = setInterval(() => {
        const now = performance.now(); gaps.push(now - previous); previous = now;
    }, 20);
    try {
        await new Promise(resolve => setTimeout(resolve, 80));
        const start = performance.now();
        const map = await generate();
        const generationMs = performance.now() - start;
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.ok(map.obstacles.length > 9000, 'real normal map, unchanged density');
        return { label, objects: map.obstacles.length, generationMs: +generationMs.toFixed(1),
            maximumTimerGapMs: +Math.max(...gaps).toFixed(1), heartbeatSamples: gaps.length };
    } finally { clearInterval(timer); }
}
const baseline = await measure('main-thread generation', () => generateSurvivMap(SURVIV.worldHalf));
const current = await measure('worker generation', generateSurvivMapInWorker);
assert.ok(current.maximumTimerGapMs < baseline.maximumTimerGapMs * .25, 'worker keeps the game/event loop responsive');
console.log(JSON.stringify({ baseline, current }));
