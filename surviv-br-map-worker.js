import { parentPort } from 'node:worker_threads';
import { generateSurvivMap, SURVIV } from './surviv-engine.js';
parentPort.postMessage(generateSurvivMap(SURVIV.worldHalf));
