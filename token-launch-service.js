import mongoose from 'mongoose';
import * as solanaWeb3 from '@solana/web3.js';
import { PinataSDK } from 'pinata';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { encryptWalletSecret, decryptWalletSecret } from './wallet-crypto.js';

// Pump's ESM bundle currently imports named values from Anchor's CommonJS
// entrypoint, which crashes on some Node 20 Railway runtimes. The package
// publishes a native CommonJS export as well; loading that export avoids the
// interop failure without patching anything in node_modules.
const require = createRequire(import.meta.url);
const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');
const BN = require('bn.js');
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

const TokenLaunchSchema = new mongoose.Schema({
    key: { type: String, unique: true, default: 'arenifi' },
    mintAddress: { type: String, default: '' },
    encryptedMintSecret: { type: String, default: '', select: false },
    launchWalletAddress: { type: String, default: '' },
    encryptedLaunchWalletSecret: { type: String, default: '', select: false },
    name: { type: String, default: 'AreniFi Credits' },
    symbol: { type: String, default: 'ARC' },
    description: { type: String, default: '' },
    imageSourceUrl: { type: String, default: '' },
    imageUri: { type: String, default: '' },
    metadataUri: { type: String, default: '' },
    website: { type: String, default: 'https://arenifi.fun' },
    twitter: { type: String, default: '' },
    twitterPost: { type: String, default: '' },
    telegram: { type: String, default: '' },
    status: { type: String, enum: ['prepared', 'metadata_ready', 'launching', 'launched', 'failed'], default: 'prepared' },
    signature: { type: String, default: '' },
    error: { type: String, default: '' },
    launchedAt: { type: Date, default: null },
    initialBuySol: { type: Number, default: 0 },
    operationLockId: { type: String, default: '' },
    operationLockUntil: { type: Date, default: null },
    lastSellSignature: { type: String, default: '' },
    lastSellAt: { type: Date, default: null },
}, { timestamps: true });

const TokenLaunch = mongoose.models.TokenLaunch || mongoose.model('TokenLaunch', TokenLaunchSchema);

function serialize(record) {
    if (!record) return {
        prepared: false,
        launchEnabled: process.env.PUMP_LAUNCH_ENABLED === 'true',
        configuredMint: process.env.AGAR_TOKEN_MINT?.trim() || '',
    };
    return {
        prepared: true,
        mintAddress: record.mintAddress,
        name: record.name,
        symbol: record.symbol,
        description: record.description,
        imageSourceUrl: record.imageSourceUrl,
        imageUri: record.imageUri,
        metadataUri: record.metadataUri,
        website: record.website,
        twitter: record.twitter,
        twitterPost: record.twitterPost,
        telegram: record.telegram,
        status: record.status,
        signature: record.signature,
        error: record.error,
        launchedAt: record.launchedAt,
        initialBuySol: record.initialBuySol || 0,
        launchWalletAddress: record.launchWalletAddress || '',
        lastSellSignature: record.lastSellSignature || '',
        lastSellAt: record.lastSellAt || null,
        launchEnabled: process.env.PUMP_LAUNCH_ENABLED === 'true',
        configuredMint: process.env.AGAR_TOKEN_MINT?.trim() || '',
        mintMatchesEnvironment: process.env.AGAR_TOKEN_MINT?.trim() === record.mintAddress,
    };
}

function cleanText(value, max) {
    return String(value || '').trim().slice(0, max);
}

function validHttpUrl(value, { optional = true } = {}) {
    if (!value && optional) return '';
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTPS/HTTP URLs are supported');
    return url.toString();
}

function decimalToAtomic(value, decimals) {
    const text = String(value ?? '').trim();
    if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Enter a valid token amount.');
    const [whole, fraction = ''] = text.split('.');
    if (fraction.length > decimals) throw new Error(`This token supports at most ${decimals} decimals.`);
    return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

function atomicToDecimal(amount, decimals) {
    const base = 10n ** BigInt(decimals);
    const whole = amount / base;
    const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function createTokenLaunchService({ connection, User, authenticateAdmin, sensitiveRateLimit }) {
    async function getRecord({ secret = false } = {}) {
        return TokenLaunch.findOne({ key: 'arenifi' }).select(secret ? '+encryptedMintSecret +encryptedLaunchWalletSecret' : undefined);
    }

    async function readLaunchPosition(record) {
        if (!record?.launchWalletAddress || !record?.mintAddress) throw Object.assign(new Error('No dedicated launch-wallet position exists.'), { status: 409 });
        const wallet = new solanaWeb3.PublicKey(record.launchWalletAddress);
        const mint = new solanaWeb3.PublicKey(record.mintAddress);
        const mintAccount = await connection.getAccountInfo(mint, 'confirmed');
        if (!mintAccount) throw Object.assign(new Error('The launched mint does not exist on-chain.'), { status: 409 });
        const tokenProgram = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        const mintInfo = await getMint(connection, mint, 'confirmed', tokenProgram);
        const ata = getAssociatedTokenAddressSync(mint, wallet, false, tokenProgram);
        const tokenAccount = await getAccount(connection, ata, 'confirmed', tokenProgram).catch(() => null);
        const tokenAtomic = tokenAccount?.amount || 0n;
        const solLamports = await connection.getBalance(wallet, 'confirmed');
        return {
            walletAddress: wallet.toBase58(), mintAddress: mint.toBase58(), tokenAccount: ata.toBase58(),
            decimals: mintInfo.decimals, tokenAtomic: tokenAtomic.toString(), tokenAmount: atomicToDecimal(tokenAtomic, mintInfo.decimals),
            solLamports, solAmount: solLamports / solanaWeb3.LAMPORTS_PER_SOL,
        };
    }

    function registerRoutes(app) {
        app.get('/api/admin/token-launch', authenticateAdmin, async (_req, res) => {
            const [record, archivedLaunches] = await Promise.all([
                getRecord(),
                TokenLaunch.countDocuments({ key: { $ne: 'arenifi' } }),
            ]);
            res.json({ ...serialize(record), archivedLaunches });
        });

        app.post('/api/admin/token-launch/prepare-new', sensitiveRateLimit({ limit: 2, windowMs: 60 * 60_000 }), authenticateAdmin, async (req, res) => {
            const current = await getRecord({ secret: true });
            if (!current || current.status !== 'launched') return res.status(409).json({ message: 'A new coin can only be prepared after the current launch is complete.' });
            if (req.body?.confirmation !== `NEW COIN ${current.mintAddress}`) return res.status(400).json({ message: 'The exact new-coin confirmation does not match.' });
            if (current.launchWalletAddress && current.encryptedLaunchWalletSecret) {
                const position = await readLaunchPosition(current);
                if (BigInt(position.tokenAtomic) > 0n) {
                    return res.status(409).json({ message: `Sell or transfer the remaining ${position.tokenAmount} ${current.symbol} from the launch wallet before creating another coin.` });
                }
                if (position.solLamports > 10_000) {
                    return res.status(409).json({ message: `Withdraw the remaining ${position.solAmount} SOL from the launch wallet before creating another coin.` });
                }
            }
            const archivedKey = `archived:${Date.now()}:${current.mintAddress}`;
            current.key = archivedKey;
            await current.save();
            try {
                const mint = solanaWeb3.Keypair.generate();
                const record = await TokenLaunch.create({
                    key: 'arenifi',
                    mintAddress: mint.publicKey.toBase58(),
                    encryptedMintSecret: encryptWalletSecret(mint.secretKey),
                    name: 'AreniFi Credits',
                    symbol: 'ARC',
                    website: 'https://arenifi.fun',
                    status: 'prepared',
                });
                res.status(201).json({ launch: { ...serialize(record), archivedLaunches: await TokenLaunch.countDocuments({ key: { $ne: 'arenifi' } }) } });
            } catch (error) {
                current.key = 'arenifi';
                await current.save().catch(() => {});
                throw error;
            }
        });

        app.get('/api/admin/token-launch/position', authenticateAdmin, async (_req, res) => {
            try {
                const record = await getRecord();
                if (!record || record.status !== 'launched') return res.status(409).json({ message: 'The token has not been launched yet.' });
                res.json({ position: await readLaunchPosition(record), symbol: record.symbol, ownerRevenueAddress: process.env.AGAR_OWNER_REVENUE_ADDRESS?.trim() || '' });
            } catch (error) {
                res.status(error.status || 502).json({ message: error.message || 'Could not read the launch-wallet position.' });
            }
        });

        app.post('/api/admin/token-launch/sell', sensitiveRateLimit({ limit: 10, windowMs: 60 * 60_000 }), authenticateAdmin, async (req, res) => {
            let record;
            let lockId;
            try {
                const candidate = await getRecord({ secret: true });
                if (!candidate || candidate.status !== 'launched') throw Object.assign(new Error('The token has not been launched yet.'), { status: 409 });
                if (!candidate.encryptedLaunchWalletSecret || !candidate.launchWalletAddress) throw Object.assign(new Error('This launch did not use the dedicated server launch wallet. Sell from the wallet that made the initial purchase instead.'), { status: 409 });
                if (req.body?.confirmation !== `SELL ${candidate.mintAddress}`) throw Object.assign(new Error('The exact sell confirmation does not match.'), { status: 400 });
                const jupiterApiKey = process.env.JUPITER_API_KEY?.trim();
                if (!jupiterApiKey) throw Object.assign(new Error('JUPITER_API_KEY is not configured.'), { status: 503 });
                lockId = randomUUID();
                record = await TokenLaunch.findOneAndUpdate({
                    _id: candidate._id,
                    $or: [{ operationLockUntil: null }, { operationLockUntil: { $lt: new Date() } }],
                }, { $set: { operationLockId: lockId, operationLockUntil: new Date(Date.now() + 120_000) } }, { new: true }).select('+encryptedLaunchWalletSecret');
                if (!record) throw Object.assign(new Error('Another launch-wallet operation is already running.'), { status: 409 });
                const position = await readLaunchPosition(record);
                const available = BigInt(position.tokenAtomic);
                const amountAtomic = req.body?.max === true ? available : decimalToAtomic(req.body?.amount, position.decimals);
                if (amountAtomic <= 0n) throw Object.assign(new Error('Sell amount must be greater than zero.'), { status: 400 });
                if (amountAtomic > available) throw Object.assign(new Error('The launch wallet does not hold that many tokens.'), { status: 409 });
                if (position.solLamports < 5000) throw Object.assign(new Error('The launch wallet needs a small SOL balance for network fees.'), { status: 409 });
                const keypair = solanaWeb3.Keypair.fromSecretKey(decryptWalletSecret(record.encryptedLaunchWalletSecret));
                if (keypair.publicKey.toBase58() !== record.launchWalletAddress) throw new Error('Dedicated launch wallet secret does not match its address');
                const baseUrl = process.env.JUPITER_SWAP_API_URL?.trim() || 'https://api.jup.ag/swap/v2';
                const orderUrl = new URL(`${baseUrl}/order`);
                orderUrl.searchParams.set('inputMint', record.mintAddress);
                orderUrl.searchParams.set('outputMint', WRAPPED_SOL_MINT);
                orderUrl.searchParams.set('amount', amountAtomic.toString());
                orderUrl.searchParams.set('taker', record.launchWalletAddress);
                const orderResponse = await fetch(orderUrl, { headers: { 'x-api-key': jupiterApiKey, Accept: 'application/json' } });
                const order = await orderResponse.json();
                if (!orderResponse.ok || !order?.transaction || !order?.requestId) throw Object.assign(new Error(order?.error || order?.message || 'Jupiter could not create a sell order.'), { status: 502 });
                const transaction = solanaWeb3.VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
                transaction.sign([keypair]);
                const executeResponse = await fetch(`${baseUrl}/execute`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-api-key': jupiterApiKey },
                    body: JSON.stringify({ signedTransaction: Buffer.from(transaction.serialize()).toString('base64'), requestId: order.requestId, ...(order.lastValidBlockHeight ? { lastValidBlockHeight: order.lastValidBlockHeight } : {}) }),
                });
                const result = await executeResponse.json();
                if (!executeResponse.ok || result?.status !== 'Success' || !result?.signature) throw Object.assign(new Error(result?.error || result?.message || 'Jupiter sell failed.'), { status: 502 });
                record.lastSellSignature = result.signature;
                record.lastSellAt = new Date();
                await record.save();
                const positionAfter = await readLaunchPosition(record);
                res.json({ success: true, signature: result.signature, inputAmountAtomic: amountAtomic.toString(), outputAmountAtomic: String(result.outputAmountResult || result.totalOutputAmount || order.outAmount || ''), position: positionAfter });
            } catch (error) {
                console.error('[Pump creator sell]', error);
                res.status(error.status || 500).json({ message: error.message || 'Creator sell failed.' });
            } finally {
                if (record && lockId) await TokenLaunch.updateOne({ _id: record._id, operationLockId: lockId }, { $set: { operationLockId: '', operationLockUntil: null } }).catch(() => {});
            }
        });

        app.post('/api/admin/token-launch/withdraw-sol', sensitiveRateLimit({ limit: 10, windowMs: 60 * 60_000 }), authenticateAdmin, async (req, res) => {
            let record;
            let lockId;
            try {
                const candidate = await getRecord({ secret: true });
                if (!candidate || candidate.status !== 'launched') throw Object.assign(new Error('The token has not been launched yet.'), { status: 409 });
                if (!candidate.encryptedLaunchWalletSecret || !candidate.launchWalletAddress) throw Object.assign(new Error('No dedicated launch wallet with a recoverable signing key exists.'), { status: 409 });
                const destinationText = process.env.AGAR_OWNER_REVENUE_ADDRESS?.trim();
                if (!destinationText) throw Object.assign(new Error('AGAR_OWNER_REVENUE_ADDRESS is not configured.'), { status: 503 });
                let destination;
                try { destination = new solanaWeb3.PublicKey(destinationText); } catch { throw Object.assign(new Error('AGAR_OWNER_REVENUE_ADDRESS is not a valid Solana address.'), { status: 503 }); }
                if (req.body?.confirmation !== `WITHDRAW ${candidate.launchWalletAddress}`) throw Object.assign(new Error('The exact withdrawal confirmation does not match.'), { status: 400 });
                lockId = randomUUID();
                record = await TokenLaunch.findOneAndUpdate({
                    _id: candidate._id,
                    $or: [{ operationLockUntil: null }, { operationLockUntil: { $lt: new Date() } }],
                }, { $set: { operationLockId: lockId, operationLockUntil: new Date(Date.now() + 120_000) } }, { new: true }).select('+encryptedLaunchWalletSecret');
                if (!record) throw Object.assign(new Error('Another launch-wallet operation is already running.'), { status: 409 });
                const keypair = solanaWeb3.Keypair.fromSecretKey(decryptWalletSecret(record.encryptedLaunchWalletSecret));
                if (keypair.publicKey.toBase58() !== record.launchWalletAddress) throw new Error('Dedicated launch wallet secret does not match its address');
                const balanceLamports = await connection.getBalance(keypair.publicKey, 'confirmed');
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
                const provisional = new solanaWeb3.TransactionMessage({
                    payerKey: keypair.publicKey,
                    recentBlockhash: blockhash,
                    instructions: [solanaWeb3.SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: destination, lamports: 1 })],
                }).compileToV0Message();
                const feeLamports = (await connection.getFeeForMessage(provisional, 'confirmed')).value;
                if (feeLamports == null) throw Object.assign(new Error('Solana could not calculate the withdrawal fee.'), { status: 502 });
                const requestedAtomic = req.body?.max === true ? null : decimalToAtomic(req.body?.amount, 9);
                if (requestedAtomic != null && requestedAtomic > BigInt(Number.MAX_SAFE_INTEGER)) throw Object.assign(new Error('Withdrawal amount is too large.'), { status: 400 });
                const requestedLamports = requestedAtomic == null ? null : Number(requestedAtomic);
                const withdrawAll = req.body?.max === true || requestedLamports >= balanceLamports;
                let sendLamports;
                if (withdrawAll) {
                    sendLamports = balanceLamports - feeLamports;
                } else {
                    sendLamports = requestedLamports;
                }
                if (!Number.isSafeInteger(sendLamports) || sendLamports <= 0) throw Object.assign(new Error('The launch wallet does not have enough SOL after the network fee.'), { status: 409 });
                if (sendLamports + feeLamports > balanceLamports) throw Object.assign(new Error(`Insufficient SOL. The wallet must also keep ${(feeLamports / solanaWeb3.LAMPORTS_PER_SOL).toFixed(9)} SOL for the network fee.`), { status: 409 });
                const message = new solanaWeb3.TransactionMessage({
                    payerKey: keypair.publicKey,
                    recentBlockhash: blockhash,
                    instructions: [solanaWeb3.SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: destination, lamports: sendLamports })],
                }).compileToV0Message();
                const transaction = new solanaWeb3.VersionedTransaction(message);
                transaction.sign([keypair]);
                const signature = await connection.sendTransaction(transaction, { maxRetries: 3, skipPreflight: false });
                await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
                const position = await readLaunchPosition(record);
                res.json({ success: true, signature, destination: destination.toBase58(), sentLamports: sendLamports, sentSol: sendLamports / solanaWeb3.LAMPORTS_PER_SOL, feeLamports, withdrawAll, position });
            } catch (error) {
                console.error('[Pump launch-wallet SOL withdrawal]', error);
                res.status(error.status || 500).json({ message: error.message || 'Launch-wallet withdrawal failed.' });
            } finally {
                if (record && lockId) await TokenLaunch.updateOne({ _id: record._id, operationLockId: lockId }, { $set: { operationLockId: '', operationLockUntil: null } }).catch(() => {});
            }
        });

        app.post('/api/admin/token-launch/prepare', sensitiveRateLimit({ limit: 2, windowMs: 60 * 60_000 }), authenticateAdmin, async (_req, res) => {
            const existing = await getRecord();
            if (existing) return res.status(409).json({ message: 'A launch mint has already been prepared.', launch: serialize(existing) });
            const mint = solanaWeb3.Keypair.generate();
            const record = await TokenLaunch.create({
                key: 'arenifi',
                mintAddress: mint.publicKey.toBase58(),
                encryptedMintSecret: encryptWalletSecret(mint.secretKey),
                status: 'prepared',
            });
            res.status(201).json({ launch: serialize(record) });
        });

        app.post('/api/admin/token-launch/metadata', sensitiveRateLimit({ limit: 5, windowMs: 60 * 60_000 }), authenticateAdmin, async (req, res) => {
            const record = await getRecord();
            if (!record) return res.status(409).json({ message: 'Prepare the mint address first.' });
            if (record.status === 'launched' || record.status === 'launching') return res.status(409).json({ message: 'Launch metadata can no longer be changed.' });
            if (!process.env.PINATA_JWT) return res.status(503).json({ message: 'PINATA_JWT is not configured.' });
            const name = cleanText(req.body?.name, 32);
            const symbol = cleanText(req.body?.symbol, 13).toUpperCase();
            const description = cleanText(req.body?.description, 1000);
            if (!name || !symbol || !description) return res.status(400).json({ message: 'Name, ticker and description are required.' });
            const imageSourceUrl = validHttpUrl(req.body?.imageSourceUrl, { optional: false });
            const website = validHttpUrl(req.body?.website || '', { optional: true });
            const twitter = validHttpUrl(req.body?.twitter || '', { optional: true });
            const twitterPost = validHttpUrl(req.body?.twitterPost || '', { optional: true });
            const telegram = validHttpUrl(req.body?.telegram || '', { optional: true });

            const pinata = new PinataSDK({ pinataJwt: process.env.PINATA_JWT });
            const imageUpload = await pinata.upload.public.url(imageSourceUrl).name(`${symbol.toLowerCase()}-coin-logo`);
            const imageUri = `https://ipfs.io/ipfs/${imageUpload.cid}`;
            const metadata = {
                name, symbol, description, image: imageUri,
                showName: true,
                createdOn: 'https://pump.fun',
                ...(website && { website }),
                // Axiom's tweet preview reads the standard `twitter` field and
                // only previews direct status URLs, not profile handles.
                ...((twitterPost || twitter) && { twitter: twitterPost || twitter }),
                ...(twitter && { twitterAccount: twitter }),
                ...(twitterPost && { twitterPost }),
                ...(telegram && { telegram }),
            };
            const metadataUpload = await pinata.upload.public.json(metadata).name(`${symbol.toLowerCase()}-metadata.json`);
            const metadataUri = `https://ipfs.io/ipfs/${metadataUpload.cid}`;
            if (metadataUri.length > 200) throw new Error('Generated metadata URI exceeds Pump.fun limit');
            Object.assign(record, { name, symbol, description, imageSourceUrl, imageUri, metadataUri, website, twitter, twitterPost, telegram, status: 'metadata_ready', error: '' });
            await record.save();
            res.json({ launch: serialize(record) });
        });

        app.post('/api/admin/token-launch/backup', sensitiveRateLimit({ limit: 3, windowMs: 60 * 60_000 }), authenticateAdmin, async (req, res) => {
            const record = await getRecord({ secret: true });
            if (!record) return res.status(404).json({ message: 'No prepared mint exists.' });
            if (req.body?.confirmation !== record.mintAddress) return res.status(400).json({ message: 'Confirm the complete mint address first.' });
            res.json({
                version: 1,
                mintAddress: record.mintAddress,
                encryptedMintSecret: record.encryptedMintSecret,
                launchWalletAddress: record.launchWalletAddress || '',
                encryptedLaunchWalletSecret: record.encryptedLaunchWalletSecret || '',
                warning: 'Requires the matching WALLET_ENCRYPTION_KEY. Never upload this backup or commit it to Git.',
            });
        });

        // Preflight failures (missing wallet funds, disabled flag, etc.) must be
        // retryable. The database state and on-chain mint existence provide the
        // actual one-launch guarantee.
        app.post('/api/admin/token-launch/launch', sensitiveRateLimit({ limit: 10, windowMs: 60 * 60_000 }), authenticateAdmin, async (req, res) => {
            if (process.env.PUMP_LAUNCH_ENABLED !== 'true') return res.status(503).json({ message: 'Set PUMP_LAUNCH_ENABLED=true and redeploy before launching.' });
            const record = await getRecord({ secret: true });
            if (!record || !['metadata_ready', 'failed'].includes(record.status)) return res.status(409).json({ message: 'The mint and metadata must be prepared first.' });
            if (req.body?.confirmation !== `LAUNCH ${record.mintAddress}`) return res.status(400).json({ message: 'The exact launch confirmation does not match.' });
            if (process.env.AGAR_TOKEN_MINT?.trim() !== record.mintAddress) return res.status(409).json({ message: 'AGAR_TOKEN_MINT must equal the prepared mint before launch.' });
            const existingMint = await connection.getAccountInfo(new solanaWeb3.PublicKey(record.mintAddress), 'confirmed');
            if (existingMint) return res.status(409).json({ message: 'This mint already exists on-chain.' });
            const admin = await User.findById(req.adminUser._id).select('+depositSecret depositAddress');
            if (!admin) return res.status(404).json({ message: 'Admin account was not found.' });
            let payer;
            if (admin.depositSecret && !admin.depositAddress) {
                const recovered = solanaWeb3.Keypair.fromSecretKey(decryptWalletSecret(admin.depositSecret));
                admin.depositAddress = recovered.publicKey.toBase58();
                await admin.save();
            }
            if (admin.depositSecret && admin.depositAddress) {
                payer = solanaWeb3.Keypair.fromSecretKey(decryptWalletSecret(admin.depositSecret));
                if (payer.publicKey.toBase58() !== admin.depositAddress) throw new Error('Admin wallet secret does not match its address');
            } else if (record.encryptedLaunchWalletSecret && record.launchWalletAddress) {
                payer = solanaWeb3.Keypair.fromSecretKey(decryptWalletSecret(record.encryptedLaunchWalletSecret));
                if (payer.publicKey.toBase58() !== record.launchWalletAddress) throw new Error('Dedicated launch wallet secret does not match its address');
            } else {
                const launchWallet = solanaWeb3.Keypair.generate();
                record.launchWalletAddress = launchWallet.publicKey.toBase58();
                record.encryptedLaunchWalletSecret = encryptWalletSecret(launchWallet.secretKey);
                await record.save();
                return res.status(409).json({
                    message: `A dedicated Pump launch wallet was created because the admin wallet has no signing key. Send SOL to ${record.launchWalletAddress}, then retry. The old admin wallet was not changed.`,
                    launchWalletAddress: record.launchWalletAddress,
                });
            }
            const mint = solanaWeb3.Keypair.fromSecretKey(decryptWalletSecret(record.encryptedMintSecret));
            if (mint.publicKey.toBase58() !== record.mintAddress) throw new Error('Stored mint keypair does not match the prepared address');

            record.status = 'launching';
            const initialBuySol = Number(req.body?.initialBuySol || 0);
            if (!Number.isFinite(initialBuySol) || initialBuySol < 0 || initialBuySol > 100) return res.status(400).json({ message: 'Initial buy must be between 0 and 100 SOL.' });
            const payerLamports = await connection.getBalance(payer.publicKey, 'confirmed');
            const requiredLamports = Math.round((initialBuySol + 0.01) * solanaWeb3.LAMPORTS_PER_SOL);
            if (payerLamports < requiredLamports) {
                return res.status(409).json({
                    message: `Admin launch wallet needs at least ${(requiredLamports / solanaWeb3.LAMPORTS_PER_SOL).toFixed(4)} SOL including the fee buffer. Send SOL to ${payer.publicKey.toBase58()}.`,
                    launchWalletAddress: payer.publicKey.toBase58(),
                    balanceSol: payerLamports / solanaWeb3.LAMPORTS_PER_SOL,
                    requiredSol: requiredLamports / solanaWeb3.LAMPORTS_PER_SOL,
                });
            }
            record.initialBuySol = initialBuySol;
            record.error = '';
            await record.save();
            try {
                const createParams = {
                    mint: mint.publicKey,
                    name: record.name,
                    symbol: record.symbol,
                    uri: record.metadataUri,
                    creator: payer.publicKey,
                    user: payer.publicKey,
                    mayhemMode: false,
                    cashback: false,
                };
                let instructions;
                if (initialBuySol > 0) {
                    const online = new OnlinePumpSdk(connection);
                    const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
                    const solAmount = new BN(Math.round(initialBuySol * solanaWeb3.LAMPORTS_PER_SOL).toString());
                    const amount = getBuyTokenAmountFromSolAmount({
                        global, feeConfig, mintSupply: null, bondingCurve: null,
                        amount: solAmount, quoteMint: solanaWeb3.PublicKey.default,
                    });
                    instructions = await PUMP_SDK.createV2AndBuyInstructions({ ...createParams, global, amount, solAmount });
                } else {
                    instructions = [await PUMP_SDK.createV2Instruction(createParams)];
                }
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
                const message = new solanaWeb3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
                const transaction = new solanaWeb3.VersionedTransaction(message);
                transaction.sign([payer, mint]);
                const signature = await connection.sendTransaction(transaction, { maxRetries: 3, skipPreflight: false });
                record.signature = signature;
                await record.save();
                await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
                record.status = 'launched';
                record.signature = signature;
                record.launchedAt = new Date();
                await record.save();
                res.json({ launch: serialize(record) });
            } catch (error) {
                const exists = await connection.getAccountInfo(mint.publicKey, 'confirmed').catch(() => null);
                record.status = exists ? 'launched' : 'failed';
                record.launchedAt = exists ? new Date() : null;
                record.error = exists ? '' : String(error.message || error).slice(0, 500);
                await record.save();
                if (exists) return res.json({ launch: serialize(record) });
                res.status(502).json({ message: record.error, launch: serialize(record) });
            }
        });
    }

    return { registerRoutes };
}
