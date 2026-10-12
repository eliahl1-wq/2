import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { broadcastSlitherState, createSlitherPlayer } from '../slither-engine.js';
import { broadcastSurvivState, createSurvivPlayer } from '../surviv-engine.js';

// Interleaved old/new serialization of the same fixture. No real sockets,
// services, RPC, accounts or funds. Baseline comes from this repository's HEAD.
const root = fileURLToPath(new URL('..', import.meta.url));
async function baseline(filename) {
    let source = execFileSync('git', ['show', `HEAD:${filename}`], { encoding: 'utf8', cwd: root });
    source = source.replace(/(from\s+|import\s+)['"](\.\/[^'"]+)['"]/g,
        (_match, prefix, relative) => `${prefix}'${pathToFileURL(resolve(root, relative)).href}'`);
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const oldSlither = await baseline('slither-engine.js');
const oldSurviv = await baseline('surviv-engine.js');

for (const mode of ['slither', 'surviv']) for (const count of [4, 16, 32]) {
    const template = { id: 'benchmark', entryFeeUsd: 5, players: [], bots: [], slitherBots: [],
        slitherFood: [], foodPoolBalance: 0, obstacles: [], loot: [], bullets: [], spectators: [], spawnPoints: [] };
    for (let i = 0; i < count; i++) {
        const player = mode === 'slither'
            ? createSlitherPlayer(`p${i}`, `m${i}`, `Player ${i}`, '#a78bfa', template, 1, 2)
            : createSurvivPlayer(`p${i}`, `m${i}`, `Player ${i}`, '#a78bfa', template);
        if (mode === 'slither') {
            player.segments.forEach((segment, j) => { segment.x = (i % 8) * 100 - j * 3; segment.y = Math.floor(i / 8) * 100; });
        } else { player.x = i % 8 * 100; player.y = Math.floor(i / 8) * 100; }
        template.players.push(player);
    }
    const results = [];
    for (const blocked of [false, true]) {
        const rooms = [structuredClone(template), structuredClone(template)];
        const counters = [{ bytes: 0, packets: 0 }, { bytes: 0, packets: 0 }];
        const ios = counters.map(counter => {
            const sockets = new Map(template.players.map(player => [player.id, { connected: true,
                handshake: { auth: { snapshotProtocol: 2 } },
                conn: { transport: { writable: !blocked }, writeBuffer: [] } }]));
            const emit = (_event, ...args) => { counter.bytes += Buffer.byteLength(JSON.stringify(args)); counter.packets++; };
            return { sockets: { sockets }, to: () => ({ emit, volatile: { emit: (...args) => { if (!blocked) emit(...args); } } }) };
        });
        const broadcasts = mode === 'slither'
            ? [oldSlither.broadcastSlitherState, broadcastSlitherState]
            : [oldSurviv.broadcastSurvivState, broadcastSurvivState];
        const times = [[], []];
        for (let run = 0; run < 150; run++) {
            for (const variant of run % 2 ? [1, 0] : [0, 1]) {
                const begin = performance.now();
                broadcasts[variant](rooms[variant], ios[variant], mode === 'slither' ? [] : {
                    leaderboard: [], aliveCount: count, zone: { x: 0, y: 0, radius: 10000 } }, {});
                if (run >= 20) times[variant].push(performance.now() - begin);
                else { counters[variant].bytes = 0; counters[variant].packets = 0; }
            }
        }
        const stats = values => { values.sort((a,b) => a-b); return {
            medianMs: +values[Math.floor(values.length / 2)].toFixed(3),
            p95Ms: +values[Math.floor(values.length * .95)].toFixed(3) }; };
        results.push({ blocked, baseline: { ...stats(times[0]), ...counters[0] },
            current: { ...stats(times[1]), ...counters[1] } });
        if (blocked && counters[1].packets) throw new Error('Congested transports received queued snapshots');
    }
    console.log(JSON.stringify({ mode, players: count, results }));
}
