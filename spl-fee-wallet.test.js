import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureFeeWallet, readFeeWallet } from './scripts/spl-fee-wallet.mjs';
import { loadSplFeeSponsor } from './spl-fee-sponsor.js';

test('fee wallet generation is persistent, concurrent-safe and usable by the sponsor', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'arenifi-fee-wallet-test-'));
    const path = join(folder, 'wallet.json');
    try {
        const wallets = await Promise.all(Array.from({ length: 5 }, () => ensureFeeWallet(path)));
        assert.ok(wallets.every(wallet => wallet.address === wallets[0].address));
        const original = await readFile(path, 'utf8');
        assert.equal((await ensureFeeWallet(path)).address, wallets[0].address);
        assert.equal(await readFile(path, 'utf8'), original);
        assert.equal(loadSplFeeSponsor({ SPL_FEE_SPONSOR_SECRET: wallets[0].secretHex }).address, wallets[0].address);
    } finally { await unlink(path); await rmdir(folder); }
});

test('an invalid or mismatched saved key is never silently replaced', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'arenifi-fee-wallet-test-'));
    const path = join(folder, 'wallet.json');
    try {
        await writeFile(path, '{broken');
        await assert.rejects(ensureFeeWallet(path));
        assert.equal(await readFile(path, 'utf8'), '{broken');
        await unlink(path);
        const wallet = await ensureFeeWallet(path);
        await writeFile(path, JSON.stringify({ ...wallet, address: 'wrong' }));
        await assert.rejects(readFeeWallet(path), /does not match/);
    } finally { await unlink(path); await rmdir(folder); }
});
