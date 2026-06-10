#!/usr/bin/env node
/**
 * Dev tool: trigger arena reset (cashout players + sweep house wallet → owner vault)
 *
 * Usage:
 *   npm run reset          — trigger reset
 *   npm run reset:status   — show room + house wallet status
 *
 * Requires in .env:
 *   DEV_RESET_SECRET=your-secret
 *   (optional) API_URL=http://localhost:5000
 */
import 'dotenv/config';

const API_URL = process.env.API_URL || process.env.VITE_API_URL || 'http://localhost:5000';
const SECRET = process.env.DEV_RESET_SECRET;

if (!SECRET) {
    console.error('❌ DEV_RESET_SECRET is not set in .env');
    console.error('   Add: DEV_RESET_SECRET=some-random-string');
    process.exit(1);
}

const action = process.argv[2] || 'reset';
const endpoint = action === 'status' ? '/api/dev/room-status' : '/api/dev/trigger-reset';
const method = action === 'status' ? 'GET' : 'POST';

console.log(`→ ${method} ${API_URL}${endpoint}`);

try {
    const res = await fetch(`${API_URL}${endpoint}`, {
        method,
        headers: { 'X-Dev-Reset-Secret': SECRET },
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
        console.error(`❌ ${res.status}: ${data.message || JSON.stringify(data)}`);
        process.exit(1);
    }

    if (action === 'status') {
        console.log('\n📊 Room Status');
        console.log('─────────────────────────────────');
        console.log(`  Resetting:       ${data.isResetting}`);
        console.log(`  Players:         ${data.playerCount}`);
        console.log(`  Food pool:       $${data.foodPoolBalance?.toFixed(2)}`);
        console.log(`  AI budget:       $${data.aiBudgetBalance?.toFixed(2)}`);
        console.log(`  Owner ledger:    $${data.ownerBalance?.toFixed(2)}`);
        console.log(`  Room age:        ${Math.round(data.roomAgeMs / 1000)}s / ${Math.round(data.roomDurationMs / 1000)}s`);
        console.log(`  House wallet:    ${data.houseWalletSol != null ? data.houseWalletSol.toFixed(6) + ' SOL' : 'N/A'}`);
        console.log(`  Owner vault:     ${data.ownerVaultConfigured ? 'configured ✓' : 'NOT SET ⚠️'}`);
    } else {
        console.log('✅ Reset initiated — players cashed out, house wallet sweep started.');
        console.log('   Run "npm run reset:status" to monitor progress.');
    }
} catch (err) {
    console.error(`❌ Could not reach server at ${API_URL}`);
    console.error(`   ${err.message}`);
    console.error('   Is the server running? (npm start)');
    process.exit(1);
}
