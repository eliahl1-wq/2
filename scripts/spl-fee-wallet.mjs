import { Keypair } from '@solana/web3.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPath = fileURLToPath(new URL('../.local/spl-fee-wallet.json', import.meta.url));

export async function readFeeWallet(path) {
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.version !== 1 || !/^[a-f0-9]{128}$/i.test(record.secretHex || '')) throw new Error('Invalid saved fee wallet. It will not be replaced.');
    const keypair = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(record.secretHex, 'hex')));
    if (keypair.publicKey.toBase58() !== record.address) throw new Error('Saved fee wallet address does not match its key. It will not be replaced.');
    return record;
}

export async function ensureFeeWallet(path = defaultPath) {
    try { return await readFeeWallet(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const keypair = Keypair.generate();
    const record = { version: 1, address: keypair.publicKey.toBase58(),
        secretHex: Buffer.from(keypair.secretKey).toString('hex') };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Exclusive creation: repeated/concurrent runs keep the same funded wallet.
    return readFeeWallet(path);
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log('npm run spl:fee-wallet                 Create/reuse wallet; show public address only.\n'
            + 'npm run spl:fee-wallet -- --show-secret   Show existing wallet secret for Railway.\n'
            + 'No RPC, transfers or Railway configuration changes are performed.');
        return;
    }
    if (args.some(arg => arg !== '--show-secret')) throw new Error('Unknown argument. Use --help.');
    const showSecret = args.includes('--show-secret');
    let wallet;
    try { wallet = showSecret ? await readFeeWallet(defaultPath) : await ensureFeeWallet(); }
    catch (error) {
        if (error.code === 'ENOENT') throw new Error('Create the wallet first: npm run spl:fee-wallet');
        throw error;
    }
    console.log(`Fee wallet address: ${wallet.address}\nSaved locally: ${defaultPath}`);
    if (showSecret) {
        console.log('PRIVATE KEY BELOW. Copy only into the backend Railway variable. Do not share screenshots or send it in chat.');
        console.log(`SPL_FEE_SPONSOR_SECRET=${wallet.secretHex}`);
    } else console.log('The private key is hidden. To display it locally: npm run spl:fee-wallet -- --show-secret');
    console.log('Back up the saved file securely. Keep only a limited amount of SOL in this wallet.\n'
        + 'Use the same secret in Railway, deploy, then verify that Admin fee wallet shows this address before funding it.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => {
        console.error('Fee wallet operation failed. The existing file was not overwritten. Check arguments with --help and verify the local file.');
        process.exitCode = 1;
    });
}
