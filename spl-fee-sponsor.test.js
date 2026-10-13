import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { loadSplFeeSponsor, createSplFeeBudget, prepareSponsoredSplTransaction } from './spl-fee-sponsor.js';

test('fee sponsor accepts wallet exports, is opt-in and cannot reuse protected funds', () => {
    const keypair = Keypair.generate();
    assert.equal(loadSplFeeSponsor({}), null);
    for (const secret of [Buffer.from(keypair.secretKey).toString('hex'), bs58.encode(keypair.secretKey), JSON.stringify([...keypair.secretKey])]) {
        assert.equal(loadSplFeeSponsor({ SPL_FEE_SPONSOR_SECRET: secret }).address, keypair.publicKey.toBase58());
    }
    const env = { SPL_FEE_SPONSOR_SECRET: bs58.encode(keypair.secretKey) };
    assert.throws(() => loadSplFeeSponsor(env, [keypair.publicKey.toBase58()]), /separate wallet/);
    assert.throws(() => loadSplFeeSponsor({ SPL_FEE_SPONSOR_SECRET: 'invalid' }), /valid 64-byte/);
    assert.throws(() => loadSplFeeSponsor({ ...env, SPL_FEE_SPONSOR_MAX_SOL: '2' }), /at most 1/);
});

function fixture(programId = TOKEN_PROGRAM_ID) {
    const sponsor = { keypair: Keypair.generate() };
    const source = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const destinationTokenAccount = getAssociatedTokenAddressSync(mint, destination, false, programId);
    const sourceTokenAccount = getAssociatedTokenAddressSync(mint, source.publicKey, false, programId);
    const transaction = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(sponsor.keypair.publicKey, destinationTokenAccount, destination, mint, programId),
        createTransferCheckedInstruction(sourceTokenAccount, mint, destinationTokenAccount, source.publicKey, 42n, 6, [], programId),
    );
    let available = 10_000_000;
    let destinationExists = true;
    const calls = [];
    const connection = {
        getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
        getAccountInfo: async () => destinationExists ? {} : null,
        getMinimumBalanceForRentExemption: async size => { calls.push(['rent', size]); return 2_100_000; },
        getFeeForMessage: async message => { calls.push(['fee', message.header.numRequiredSignatures]); return { value: 10_000 }; },
        getBalance: async address => { assert.ok(address.equals(sponsor.keypair.publicKey)); return available; },
    };
    return { sponsor, source, transaction, calls, budget: createSplFeeBudget('0.01', 250_000_000),
        options: { connection, transaction, sponsor, sourceAddress: source.publicKey, destinationTokenAccount, mint, programId },
        setAvailable: value => { available = value; }, setDestinationExists: value => { destinationExists = value; } };
}

test('source can have zero SOL: sponsor signs fees/ATA, source alone authorizes its token transfer', async () => {
    const f = fixture();
    const result = await prepareSponsoredSplTransaction({ ...f.options, budget: f.budget });
    assert.equal(result.reservedLamports, 10_000);
    assert.ok(f.transaction.feePayer.equals(f.sponsor.keypair.publicKey));
    assert.ok(f.transaction.instructions[0].keys[0].pubkey.equals(f.sponsor.keypair.publicKey));
    assert.ok(f.transaction.instructions[1].keys[3].pubkey.equals(f.source.publicKey));
    assert.equal(f.transaction.instructions[1].keys[3].isSigner, true);
    assert.deepEqual(f.calls, [['fee', 2]]);
    f.transaction.sign(f.sponsor.keypair, f.source);
    assert.equal(f.transaction.verifySignatures(), true);
});

test('missing Token-2022 destination reserves actual extension-dependent rent plus network fee', async () => {
    const f = fixture(TOKEN_2022_PROGRAM_ID);
    f.setDestinationExists(false);
    const result = await prepareSponsoredSplTransaction({ ...f.options, budget: f.budget,
        getMintImpl: async (_connection, mint, _commitment, program) => {
            assert.ok(program.equals(TOKEN_2022_PROGRAM_ID)); assert.ok(mint.equals(f.options.mint)); return { custom: true };
        }, accountLenImpl: mint => { assert.equal(mint.custom, true); return 300; } });
    assert.equal(result.rentLamports, 2_100_000);
    assert.equal(f.budget.reservedLamports, 2_110_000);
    assert.deepEqual(f.calls, [['rent', 300], ['fee', 2]]);
});

test('insufficient sponsor balance, unknown fees and cumulative limits block submission', async () => {
    const f = fixture();
    f.setAvailable(0);
    await assert.rejects(prepareSponsoredSplTransaction({ ...f.options, budget: f.budget }), /insufficient SOL/);
    assert.equal(f.budget.reservedLamports, 0);
    f.setAvailable(10_000_000);
    f.options.connection.getFeeForMessage = async () => ({ value: null });
    await assert.rejects(prepareSponsoredSplTransaction({ ...f.options, budget: f.budget }), /estimate/);
    const budget = createSplFeeBudget('0.00002', 250_000_000);
    budget.reserve(10_000); budget.reserve(10_000);
    assert.throws(() => budget.reserve(1), /budget reached/);
    assert.equal(budget.reservedLamports, 20_000);
    for (const invalid of ['0', '-1', 'bad', '0.3']) assert.throws(() => createSplFeeBudget(invalid, 250_000_000));
    await assert.rejects(prepareSponsoredSplTransaction({ ...f.options, sourceAddress: f.sponsor.keypair.publicKey, budget }), /cannot also be a source/);
});
