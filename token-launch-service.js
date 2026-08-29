import mongoose from 'mongoose';
import * as solanaWeb3 from '@solana/web3.js';
import { PinataSDK } from 'pinata';
import { createRequire } from 'node:module';
import { encryptWalletSecret, decryptWalletSecret } from './wallet-crypto.js';

// Pump's ESM bundle currently imports named values from Anchor's CommonJS
// entrypoint, which crashes on some Node 20 Railway runtimes. The package
// publishes a native CommonJS export as well; loading that export avoids the
// interop failure without patching anything in node_modules.
const require = createRequire(import.meta.url);
const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');
const BN = require('bn.js');

const TokenLaunchSchema = new mongoose.Schema({
    key: { type: String, unique: true, default: 'arenifi' },
    mintAddress: { type: String, default: '' },
    encryptedMintSecret: { type: String, default: '', select: false },
    name: { type: String, default: 'AreniFi Coin' },
    symbol: { type: String, default: 'ARENA' },
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

export function createTokenLaunchService({ connection, User, authenticateAdmin, sensitiveRateLimit }) {
    async function getRecord({ secret = false } = {}) {
        return TokenLaunch.findOne({ key: 'arenifi' }).select(secret ? '+encryptedMintSecret' : undefined);
    }

    function registerRoutes(app) {
        app.get('/api/admin/token-launch', authenticateAdmin, async (_req, res) => {
            res.json(serialize(await getRecord()));
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
            if (!admin.depositSecret && !admin.depositAddress) {
                const wallet = solanaWeb3.Keypair.generate();
                admin.depositAddress = wallet.publicKey.toBase58();
                admin.depositSecret = encryptWalletSecret(wallet.secretKey);
                await admin.save();
                return res.status(409).json({
                    message: `Admin launch wallet was created. Send SOL to ${admin.depositAddress}, then retry the launch.`,
                    launchWalletAddress: admin.depositAddress,
                });
            }
            if (!admin.depositSecret && admin.depositAddress) {
                return res.status(409).json({
                    message: `Admin wallet ${admin.depositAddress} has no recoverable signing key. It was not replaced.`,
                    launchWalletAddress: admin.depositAddress,
                });
            }
            if (admin.depositSecret && !admin.depositAddress) {
                const recovered = solanaWeb3.Keypair.fromSecretKey(decryptWalletSecret(admin.depositSecret));
                admin.depositAddress = recovered.publicKey.toBase58();
                await admin.save();
            }
            const payer = solanaWeb3.Keypair.fromSecretKey(decryptWalletSecret(admin.depositSecret));
            if (payer.publicKey.toBase58() !== admin.depositAddress) throw new Error('Admin wallet secret does not match its address');
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
