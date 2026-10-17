import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmEntrySignature, sendAndConfirmEntryTransaction } from './entry-confirmation.js';
import { createJoinWaiters, requireResumeTarget } from './join-waiters.js';
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js';

function fixture(statuses) {
    let checks = 0, sends = 0, aborted = false;
    let signed = false;
    const transaction = { recentBlockhash: 'block', lastValidBlockHeight: 100,
        sign: () => { signed = true; }, serialize: () => { assert.equal(signed, true); return Buffer.from('same-signed-transaction'); } };
    const connection = {
        sendRawTransaction: async (bytes, options) => {
            assert.equal(bytes.toString(), 'same-signed-transaction');
            sends++; assert.equal(options.preflightCommitment, 'confirmed');
            assert.notEqual(options.skipPreflight, true); return 'same-signature';
        },
        confirmTransaction: strategy => {
            assert.equal(strategy.signature, 'same-signature');
            assert.equal(strategy.lastValidBlockHeight, 100);
            return new Promise((_resolve, reject) => strategy.abortSignal.addEventListener('abort', () => {
                aborted = true; reject(new Error('aborted after HTTP confirmation'));
            }, { once: true }));
        },
        getSignatureStatuses: async signatures => {
            assert.deepEqual(signatures, ['same-signature']);
            const status = statuses[Math.min(checks++, statuses.length - 1)];
            if (status instanceof Error) throw status;
            return { value: [status] };
        },
    };
    return { connection, transaction, stats: () => ({ checks, sends, aborted }) };
}

test('a stalled WebSocket cannot delay an already HTTP-confirmed entry or submit twice', async () => {
    const f = fixture([{ confirmationStatus: 'confirmed', err: null }]);
    const result = await sendAndConfirmEntryTransaction(f.connection, f.transaction, [], { lastValidBlockHeight: 100 });
    assert.equal(result, 'same-signature');
    assert.deepEqual(f.stats(), { checks: 1, sends: 1, aborted: true });
});

test('missing blockhash/expiry cannot submit a payment', async () => {
    const f = fixture([]);
    f.transaction.lastValidBlockHeight = undefined;
    await assert.rejects(sendAndConfirmEntryTransaction(f.connection, f.transaction, []), /valid blockhash/);
    assert.equal(f.stats().sends, 0);
});

test('real signed entry bytes preserve the amount, fee payer and prefetched blockhash', async () => {
    const sender = Keypair.generate(), house = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: sender.publicKey }).add(
        SystemProgram.transfer({ fromPubkey: sender.publicKey, toPubkey: house.publicKey, lamports: 123456 }),
    );
    let sends = 0;
    const connection = {
        sendRawTransaction: async bytes => {
            sends++;
            const decoded = Transaction.from(bytes);
            assert.equal(decoded.verifySignatures(), true);
            assert.equal(decoded.recentBlockhash, blockhash);
            assert.ok(decoded.feePayer.equals(sender.publicKey));
            assert.equal(decoded.instructions[0].data.readBigUInt64LE(4), 123456n);
            return 'same-signature';
        },
        confirmTransaction: async strategy => {
            assert.equal(strategy.blockhash, blockhash);
            assert.equal(strategy.lastValidBlockHeight, 123);
            return { value: { err: null } };
        },
        getSignatureStatuses: async () => ({ value: [null] }),
    };
    assert.equal(await sendAndConfirmEntryTransaction(connection, tx, [sender], { lastValidBlockHeight: 123 }), 'same-signature');
    assert.equal(sends, 1);
});

test('processed, absent and transient RPC failures never count as paid confirmation', async () => {
    const f = fixture([null, { confirmationStatus: 'processed', err: null }, new Error('temporary HTTP outage'),
        { confirmationStatus: 'finalized', err: null }]);
    assert.equal(await confirmEntrySignature(f.connection, 'same-signature', f.transaction, { pollMs: 1 }), 'same-signature');
    assert.equal(f.stats().checks, 4);
});

test('an authoritative transaction failure prevents entry', async () => {
    const f = fixture([{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'failure'] } }]);
    await assert.rejects(confirmEntrySignature(f.connection, 'same-signature', f.transaction), /failed/);
    assert.equal(f.stats().aborted, true);
});

test('working SDK confirmation remains usable when HTTP fails; SDK expiry still propagates', async () => {
    const f = fixture([new Error('HTTP unavailable')]);
    f.connection.confirmTransaction = async () => ({ value: { err: null } });
    assert.equal(await confirmEntrySignature(f.connection, 'same-signature', f.transaction), 'same-signature');
    f.connection.confirmTransaction = async () => { throw new Error('block height expired'); };
    await assert.rejects(confirmEntrySignature(f.connection, 'same-signature', f.transaction), /expired/);
});

test('reconnect waiters resume only after their owning join releases; other users stay locked', async () => {
    const active = new Set(['a', 'b']);
    const gate = createJoinWaiters(active);
    const waiting = gate.wait('a');
    gate.finish('a');
    assert.equal(await waiting, true);
    assert.equal(active.has('b'), true);
    assert.equal(await gate.wait('already-finished'), true);
    assert.equal(await gate.wait('b', 1), false);
    assert.equal(active.has('b'), true, 'a timed-out observer must not clear the owner lock');
    gate.finish('b');
});

test('resume-only retries never create another paid session if the old join failed or player died', () => {
    assert.throws(() => requireResumeTarget(true, null), /no active match/);
    assert.doesNotThrow(() => requireResumeTarget(true, { id: 'existing' }));
    assert.doesNotThrow(() => requireResumeTarget(false, null));
});
