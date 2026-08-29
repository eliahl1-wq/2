import * as solanaWeb3 from '@solana/web3.js';
import {
    ExtensionType,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createTransferCheckedInstruction,
    getAccount as getTokenAccount,
    getAssociatedTokenAddressSync,
    getExtensionTypes,
    getMint,
} from '@solana/spl-token';
import { randomUUID } from 'node:crypto';
import {
    AGAR_SHOP_PRODUCTS,
    getAgarShopProduct,
    splitAtomicAmount,
    usdPriceToAtomic,
} from './agar-economy.js';
import {
    AgarSwap,
    SkinEntitlement,
    SkinPurchase,
    acquireWalletOperation,
    releaseWalletOperation,
} from './agar-commerce-models.js';
import { fetchAgarMarketPrice } from './agar-market.js';
import { fetchAgarCandles } from './agar-candles.js';
import {
    decryptWalletSecret,
    hasWalletEncryptionKey,
    isEncryptedWalletSecret,
} from './wallet-crypto.js';

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const INCOMPATIBLE_TOKEN_2022_EXTENSIONS = new Set([
    ExtensionType.TransferFeeConfig,
    ExtensionType.TransferHook,
    ExtensionType.NonTransferable,
    ExtensionType.DefaultAccountState,
    ExtensionType.ConfidentialTransferMint,
]);

function envBoolean(name, fallback = false) {
    const value = process.env[name];
    if (value == null || String(value).trim() === '') return fallback;
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function publicKey(value, label) {
    try {
        return new solanaWeb3.PublicKey(String(value || '').trim());
    } catch {
        throw new Error(`${label} is not a valid Solana address`);
    }
}

function decimalToAtomic(value, decimals) {
    const normalized = String(value ?? '').trim();
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error('Amount must be a positive decimal');
    const [whole, fraction = ''] = normalized.split('.');
    const padded = `${fraction}${'0'.repeat(decimals)}`.slice(0, decimals);
    const atomic = (BigInt(whole) * (10n ** BigInt(decimals))) + BigInt(padded || '0');
    if (atomic <= 0n) throw new Error('Amount must be positive');
    return atomic;
}

function atomicToDecimal(value, decimals, maxFractionDigits = 6) {
    const atomic = BigInt(value);
    const scale = 10n ** BigInt(decimals);
    const whole = atomic / scale;
    const fraction = (atomic % scale).toString().padStart(decimals, '0')
        .slice(0, maxFractionDigits)
        .replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
}

function serializePurchase(purchase) {
    return {
        id: String(purchase._id),
        productId: purchase.productId,
        gameMode: purchase.gameMode,
        skinId: purchase.skinId,
        usdPrice: purchase.usdPrice,
        tokenPriceUsd: purchase.tokenPriceUsd,
        tokenAmountAtomic: purchase.tokenAmountAtomic,
        tokenAmount: atomicToDecimal(purchase.tokenAmountAtomic, purchase.decimals),
        treasuryAmountAtomic: purchase.treasuryAmountAtomic,
        ownerAmountAtomic: purchase.ownerAmountAtomic,
        quoteExpiresAt: purchase.quoteExpiresAt,
        status: purchase.status,
        signature: purchase.signature || '',
        error: purchase.error || '',
    };
}

export function createAgarCommerceService({
    connection,
    User,
    authenticateToken,
    sensitiveRateLimit,
}) {
    const configuredTokenName = process.env.AGAR_TOKEN_NAME?.trim();
    const configuredTokenSymbol = process.env.AGAR_TOKEN_SYMBOL?.trim().toUpperCase();
    const tokenName = !configuredTokenName || /^(stake\s*coin|agar\s*(coin|token)?)$/i.test(configuredTokenName)
        ? 'AreniFi Coin'
        : configuredTokenName;
    const tokenSymbol = !configuredTokenSymbol || ['AGAR', 'STAKECOIN'].includes(configuredTokenSymbol)
        ? 'ARENA'
        : configuredTokenSymbol;
    const config = {
        // Public access is the normal launched state. Admin-only preview must be
        // opted into explicitly so a missing Railway variable cannot silently
        // force every non-admin client back into Coming Soon mode.
        adminOnly: envBoolean('AGAR_ADMIN_ONLY', false),
        enabled: envBoolean('AGAR_TOKEN_ENABLED'),
        shopEnabled: envBoolean('AGAR_SHOP_ENABLED'),
        swapEnabled: envBoolean('AGAR_ACCOUNT_SWAP_ENABLED'),
        mint: process.env.AGAR_TOKEN_MINT?.trim() || '',
        name: tokenName,
        symbol: tokenSymbol,
        configuredDecimals: Number.parseInt(process.env.AGAR_TOKEN_DECIMALS || '6', 10),
        treasuryAddress: process.env.AGAR_TREASURY_ADDRESS?.trim() || '',
        ownerAddress: process.env.AGAR_OWNER_REVENUE_ADDRESS?.trim() || '',
        treasuryBps: Number.parseInt(process.env.AGAR_TREASURY_BPS || '9000', 10),
        ownerBps: Number.parseInt(process.env.AGAR_OWNER_BPS || '1000', 10),
        quoteTtlMs: Number.parseInt(process.env.AGAR_SHOP_QUOTE_TTL_SECONDS || '60', 10) * 1000,
        jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || '',
        jupiterBaseUrl: process.env.JUPITER_SWAP_API_URL?.trim() || 'https://api.jup.ag/swap/v2',
    };
    let tokenContextCache = null;
    const agarBalanceCache = new Map();
    const agarBalanceInFlight = new Map();
    const agarBalanceCacheMs = Math.max(5_000, Number(process.env.AGAR_BALANCE_RPC_CACHE_MS || 30_000));

    async function hasAgarAccess(userId) {
        if (!config.adminOnly) return true;
        const adminUsername = process.env.ADMIN_USERNAME?.trim();
        if (!adminUsername || !userId) return false;
        return !!(await User.exists({ _id: userId, username: adminUsername }));
    }

    async function requireAgarAccess(req, res) {
        if (await hasAgarAccess(req.user?.id)) return true;
        res.status(503).json({ message: `${config.name} is coming soon.` });
        return false;
    }

    async function loadTokenContext({ requireDestinations = false } = {}) {
        if (!config.enabled) throw new Error(`${config.symbol} has not launched yet`);
        if (!hasWalletEncryptionKey()) throw new Error('Wallet encryption is not configured');
        if (tokenContextCache && Date.now() - tokenContextCache.loadedAt < 5 * 60_000) {
            if (requireDestinations && !tokenContextCache.destinationsReady) {
                throw new Error(tokenContextCache.destinationError || `${config.symbol} destinations are not ready`);
            }
            return tokenContextCache;
        }
        const mint = publicKey(config.mint, 'AGAR_TOKEN_MINT');
        const mintAccount = await connection.getAccountInfo(mint, 'confirmed');
        if (!mintAccount) throw new Error(`${config.symbol} mint does not exist on the configured network`);
        const tokenProgram = mintAccount.owner.equals(TOKEN_PROGRAM_ID)
            ? TOKEN_PROGRAM_ID
            : mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)
                ? TOKEN_2022_PROGRAM_ID
                : null;
        if (!tokenProgram) throw new Error(`${config.symbol} mint is not owned by a supported token program`);
        const mintInfo = await getMint(connection, mint, 'confirmed', tokenProgram);
        if (mintInfo.decimals !== config.configuredDecimals) {
            throw new Error(`AGAR decimals mismatch: chain=${mintInfo.decimals}, config=${config.configuredDecimals}`);
        }
        if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
            const incompatible = getExtensionTypes(mintInfo.tlvData)
                .filter((extension) => INCOMPATIBLE_TOKEN_2022_EXTENSIONS.has(extension));
            if (incompatible.length) throw new Error(`${config.symbol} mint has unsupported Token-2022 extensions: ${incompatible.join(',')}`);
        }

        let treasuryWallet = null;
        let ownerWallet = null;
        let treasuryAta = null;
        let ownerAta = null;
        let destinationsReady = false;
        let destinationError = '';
        try {
            if (config.treasuryBps + config.ownerBps !== 10_000) {
                throw new Error('AGAR revenue shares must total 10000 bps');
            }
            treasuryWallet = publicKey(config.treasuryAddress, 'AGAR_TREASURY_ADDRESS');
            ownerWallet = publicKey(config.ownerAddress, 'AGAR_OWNER_REVENUE_ADDRESS');
            treasuryAta = getAssociatedTokenAddressSync(mint, treasuryWallet, false, tokenProgram);
            ownerAta = getAssociatedTokenAddressSync(mint, ownerWallet, false, tokenProgram);
            const [treasuryAccount, ownerAccount] = await Promise.all([
                getTokenAccount(connection, treasuryAta, 'confirmed', tokenProgram),
                getTokenAccount(connection, ownerAta, 'confirmed', tokenProgram),
            ]);
            if (treasuryAccount.isFrozen || ownerAccount.isFrozen) throw new Error('An AGAR revenue token account is frozen');
            destinationsReady = true;
        } catch (error) {
            destinationError = error.message;
        }

        tokenContextCache = {
            mint,
            mintInfo,
            tokenProgram,
            treasuryWallet,
            ownerWallet,
            treasuryAta,
            ownerAta,
            destinationsReady,
            destinationError,
            loadedAt: Date.now(),
        };
        if (requireDestinations && !destinationsReady) throw new Error(destinationError || `${config.symbol} destinations are not ready`);
        return tokenContextCache;
    }

    async function readAgarTokenBalance(address, context, { force = false } = {}) {
        const wallet = publicKey(address, 'Account wallet');
        const key = `${context.mint.toBase58()}:${wallet.toBase58()}`;
        const cached = agarBalanceCache.get(key);
        if (!force && cached && Date.now() - cached.loadedAt <= agarBalanceCacheMs) return cached.value;
        if (!force && agarBalanceInFlight.has(key)) return agarBalanceInFlight.get(key);

        const request = (async () => {
            const ata = getAssociatedTokenAddressSync(context.mint, wallet, false, context.tokenProgram);
            const tokenAccount = await getTokenAccount(
                connection, ata, 'confirmed', context.tokenProgram,
            ).catch(() => null);
            const value = {
                agarAtomic: tokenAccount?.amount || 0n,
                agar: atomicToDecimal(tokenAccount?.amount || 0n, context.mintInfo.decimals),
                ata,
                tokenAccount,
            };
            agarBalanceCache.set(key, { value, loadedAt: Date.now() });
            return value;
        })();
        agarBalanceInFlight.set(key, request);
        try {
            return await request;
        } finally {
            if (agarBalanceInFlight.get(key) === request) agarBalanceInFlight.delete(key);
        }
    }

    async function readWalletBalances(address, context) {
        const wallet = publicKey(address, 'Account wallet');
        const [lamports, tokenValue] = await Promise.all([
            connection.getBalance(wallet, 'confirmed'),
            readAgarTokenBalance(address, context, { force: true }),
        ]);
        return {
            sol: lamports / solanaWeb3.LAMPORTS_PER_SOL,
            ...tokenValue,
        };
    }
    async function grantEntitlement(purchase) {
        const entitlement = await SkinEntitlement.findOneAndUpdate(
            {
                userId: purchase.userId,
                gameMode: purchase.gameMode,
                skinId: purchase.skinId,
            },
            {
                $setOnInsert: {
                    productId: purchase.productId,
                    purchaseId: purchase._id,
                    source: 'purchase',
                },
            },
            { upsert: true, new: true },
        );
        await SkinPurchase.findByIdAndUpdate(purchase._id, {
            $set: {
                status: 'confirmed',
                confirmedAt: new Date(),
                error: '',
            },
        });
        return entitlement;
    }

    async function reconcilePurchase(purchase) {
        if (!purchase?.signature || !['broadcast', 'needs_review'].includes(purchase.status)) return purchase;
        const status = (await connection.getSignatureStatuses([purchase.signature], { searchTransactionHistory: true }))
            ?.value?.[0];
        if (!status) return purchase;
        if (status.err) {
            purchase.status = 'failed';
            purchase.error = JSON.stringify(status.err).slice(0, 500);
            await purchase.save();
            return purchase;
        }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
            await grantEntitlement(purchase);
            return SkinPurchase.findById(purchase._id);
        }
        return purchase;
    }

    async function shopReadiness() {
        if (!config.enabled) return { ready: false, reason: `${config.symbol} has not launched yet.` };
        if (!config.shopEnabled) return { ready: false, reason: `${config.symbol} shop is disabled.` };
        try {
            await loadTokenContext({ requireDestinations: true });
            const market = await fetchAgarMarketPrice({ mint: config.mint, symbol: config.symbol });
            return { ready: true, reason: '', market };
        } catch (error) {
            return { ready: false, reason: error.message };
        }
    }

    async function publicConfig({ accessGranted = false } = {}) {
        if (!accessGranted) {
            return {
                accessGranted: false,
                adminOnly: config.adminOnly,
                enabled: false,
                mint: '',
                decimals: config.configuredDecimals,
                name: config.name,
                symbol: config.symbol,
                shopEnabled: false,
                shopReady: false,
                shopReason: `${config.name} is coming soon.`,
                swapEnabled: false,
                swapReady: false,
                swapReason: `${config.name} is coming soon.`,
                treasuryBps: config.treasuryBps,
                ownerBps: config.ownerBps,
                market: null,
            };
        }
        const shop = await shopReadiness();
        let tokenReady = false;
        let tokenReason = '';
        try {
            await loadTokenContext();
            tokenReady = true;
        } catch (error) {
            tokenReason = error.message;
        }
        return {
            accessGranted: true,
            adminOnly: config.adminOnly,
            enabled: config.enabled,
            mint: config.enabled ? config.mint : '',
            decimals: config.configuredDecimals,
            name: config.name,
            symbol: config.symbol,
            shopEnabled: config.shopEnabled,
            shopReady: shop.ready,
            shopReason: shop.reason,
            swapEnabled: config.swapEnabled,
            swapReady: tokenReady && config.swapEnabled && !!config.jupiterApiKey,
            swapReason: !config.swapEnabled ? `${config.symbol} account swaps are disabled.` : !config.jupiterApiKey ? 'Jupiter is not configured.' : tokenReason,
            treasuryBps: config.treasuryBps,
            ownerBps: config.ownerBps,
            market: shop.market ? {
                priceUsd: shop.market.priceUsd,
                liquidityUsd: shop.market.liquidityUsd,
                source: shop.market.source,
            } : null,
        };
    }

    async function listInventory(userId) {
        const pending = await SkinPurchase.find({
            userId,
            status: { $in: ['broadcast', 'needs_review'] },
        });
        await Promise.all(pending.map((purchase) => reconcilePurchase(purchase)));
        const [entitlements, purchases] = await Promise.all([
            SkinEntitlement.find({ userId }).lean(),
            SkinPurchase.find({ userId }).sort({ createdAt: -1 }).limit(50).lean(),
        ]);
        return {
            entitlements: entitlements.map((entry) => ({
                productId: entry.productId,
                gameMode: entry.gameMode,
                skinId: entry.skinId,
                acquiredAt: entry.createdAt,
            })),
            purchases: purchases.map(serializePurchase),
        };
    }

    async function hasSkinEntitlement(userId, gameMode, skinId) {
        if (skinId === 'flags') {
            if (!['agar', 'slither', 'all'].includes(gameMode)) return false;
            return !!(await SkinEntitlement.exists({ userId, gameMode: 'all', skinId: 'flags' }));
        }
        if (skinId === 'rainbow') {
            if (!['agar', 'slither'].includes(gameMode)) return false;
            return !!(await SkinEntitlement.exists({ userId, gameMode, skinId }));
        }
        if (['aurora', 'eclipse'].includes(skinId)) {
            if (gameMode !== 'slither') return false;
            return !!(await SkinEntitlement.exists({ userId, gameMode: 'slither', skinId }));
        }
        return true;
    }

    function registerRoutes(app) {
        app.get('/api/agar/config', authenticateToken, async (req, res) => {
            const accessGranted = await hasAgarAccess(req.user.id);
            res.json(await publicConfig({ accessGranted }));
        });

        app.get('/api/agar/candles', authenticateToken, async (req, res) => {
            if (!await requireAgarAccess(req, res)) return;
            if (!config.enabled || !config.mint) {
                return res.status(503).json({ message: `${config.symbol} has not launched yet.` });
            }
            try {
                return res.json(await fetchAgarCandles({
                    mint: config.mint,
                    symbol: config.symbol,
                    range: req.query.range,
                }));
            } catch (error) {
                return res.status(error.status || 502).json({ message: error.message });
            }
        });

        app.get('/api/agar/balance', authenticateToken, async (req, res) => {
            if (!await hasAgarAccess(req.user.id)) return res.json({ balance: 0, launched: false });
            if (!config.enabled) return res.json({ balance: 0, launched: false });
            try {
                const context = await loadTokenContext();
                const user = await User.findById(req.user.id).select('depositAddress');
                if (!user?.depositAddress) return res.status(404).json({ message: 'Account wallet is not available.' });
                const balance = await readAgarTokenBalance(user.depositAddress, context);
                return res.json({ balance: balance.agar, launched: true });
            } catch (error) {
                console.error('[AGAR balance]', error);
                return res.status(502).json({ message: `${config.symbol} balance is temporarily unavailable.` });
            }
        });
        app.get('/api/agar/treasury', authenticateToken, async (req, res) => {
            if (!await hasAgarAccess(req.user.id)) return res.status(503).json({ message: `${config.name} is coming soon.` });
            if (!config.enabled) return res.json({ launched: false, balance: 0, address: '' });
            try {
                const context = await loadTokenContext();
                const treasury = await readAgarTokenBalance(config.treasuryAddress, context);
                return res.json({
                    launched: true,
                    balance: treasury.agar,
                    address: context.treasuryWallet?.toBase58() || config.treasuryAddress,
                    tokenAccount: treasury.ata.toBase58(),
                });
            } catch (error) {
                console.error('[AGAR treasury]', error);
                return res.status(502).json({ message: 'Treasury balance is temporarily unavailable.' });
            }
        });
        app.get('/api/shop/catalog', authenticateToken, async (req, res) => {
            if (!await hasAgarAccess(req.user.id)) {
                return res.json({
                    ready: false,
                    reason: 'AGAR is coming soon.',
                    currency: 'AGAR',
                    products: AGAR_SHOP_PRODUCTS.map((product) => ({ ...product, estimatedAgar: null })),
                });
            }
            const shop = await shopReadiness();
            const priceUsd = shop.market?.priceUsd || null;
            res.json({
                ready: shop.ready,
                reason: shop.reason,
                currency: 'AGAR',
                products: AGAR_SHOP_PRODUCTS.map((product) => {
                    const amountAtomic = priceUsd
                        ? usdPriceToAtomic({
                            usdPrice: product.usdPrice,
                            tokenPriceUsd: priceUsd,
                            decimals: config.configuredDecimals,
                        })
                        : null;
                    return {
                        ...product,
                        estimatedAgar: amountAtomic
                            ? atomicToDecimal(amountAtomic, config.configuredDecimals)
                            : null,
                    };
                }),
            });
        });

        app.get('/api/shop/inventory', authenticateToken, async (req, res) => {
            res.json(await listInventory(req.user.id));
        });

        app.post('/api/shop/quote', sensitiveRateLimit({ limit: 20, windowMs: 60_000 }), authenticateToken, async (req, res) => {
            if (!await requireAgarAccess(req, res)) return;
            const readiness = await shopReadiness();
            if (!readiness.ready) return res.status(503).json({ message: readiness.reason });
            const product = getAgarShopProduct(String(req.body?.productId || ''));
            if (!product) return res.status(404).json({ message: 'Shop product was not found.' });
            if (await hasSkinEntitlement(req.user.id, product.gameMode, product.skinId)) {
                return res.status(409).json({ message: 'You already own this skin.' });
            }
            const unresolved = await SkinPurchase.exists({
                userId: req.user.id,
                productId: product.id,
                status: { $in: ['processing', 'broadcast', 'needs_review'] },
            });
            if (unresolved) return res.status(409).json({ message: 'A purchase for this skin is still processing.' });
            const context = await loadTokenContext({ requireDestinations: true });
            const totalAtomic = usdPriceToAtomic({
                usdPrice: product.usdPrice,
                tokenPriceUsd: readiness.market.priceUsd,
                decimals: context.mintInfo.decimals,
            });
            const split = splitAtomicAmount(totalAtomic, config.treasuryBps, config.ownerBps);
            const purchase = await SkinPurchase.create({
                userId: req.user.id,
                productId: product.id,
                gameMode: product.gameMode,
                skinId: product.skinId,
                usdPrice: product.usdPrice,
                tokenPriceUsd: readiness.market.priceUsd,
                tokenAmountAtomic: totalAtomic.toString(),
                treasuryAmountAtomic: split.treasuryAtomic.toString(),
                ownerAmountAtomic: split.ownerAtomic.toString(),
                decimals: context.mintInfo.decimals,
                quoteExpiresAt: new Date(Date.now() + config.quoteTtlMs),
                treasuryAddress: config.treasuryAddress,
                ownerAddress: config.ownerAddress,
            });
            res.status(201).json({ quote: serializePurchase(purchase) });
        });

        app.post('/api/shop/purchase', sensitiveRateLimit({ limit: 10, windowMs: 60_000 }), authenticateToken, async (req, res) => {
            if (!await requireAgarAccess(req, res)) return;
            const quoteId = String(req.body?.quoteId || '');
            const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
            if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(idempotencyKey)) {
                return res.status(400).json({ message: 'A valid idempotency key is required.' });
            }
            const duplicate = await SkinPurchase.findOne({ userId: req.user.id, idempotencyKey });
            if (duplicate) {
                const reconciled = await reconcilePurchase(duplicate);
                return res.json({ purchase: serializePurchase(reconciled), duplicate: true });
            }
            let purchase = await SkinPurchase.findOne({ _id: quoteId, userId: req.user.id });
            if (!purchase) return res.status(404).json({ message: 'Purchase quote was not found.' });
            if (purchase.status === 'confirmed') return res.json({ purchase: serializePurchase(purchase), duplicate: true });
            if (purchase.status !== 'quoted') return res.status(409).json({ message: 'Purchase quote is no longer available.' });
            if (purchase.quoteExpiresAt <= new Date()) {
                purchase.status = 'expired';
                await purchase.save();
                return res.status(410).json({ message: 'Purchase quote has expired.' });
            }

            const operationId = `shop:${purchase._id}:${randomUUID()}`;
            if (!await acquireWalletOperation(req.user.id, 'shop_purchase', operationId)) {
                return res.status(409).json({ message: 'Another wallet operation is already processing.' });
            }
            let signature = '';
            try {
                purchase = await SkinPurchase.findOneAndUpdate(
                    { _id: purchase._id, status: 'quoted', idempotencyKey: null },
                    { $set: { status: 'processing', idempotencyKey } },
                    { new: true },
                );
                if (!purchase) throw Object.assign(new Error('Purchase quote is already being used.'), { status: 409 });
                const user = await User.findById(req.user.id).select('depositAddress depositSecret');
                if (!user?.depositAddress || !user?.depositSecret) throw Object.assign(new Error('Account wallet is unavailable.'), { status: 409 });
                if (!isEncryptedWalletSecret(user.depositSecret)) {
                    throw Object.assign(new Error(`Account wallet must be migrated to encrypted storage before ${config.symbol} purchases.`), { status: 503 });
                }
                const keypair = solanaWeb3.Keypair.fromSecretKey(decryptWalletSecret(user.depositSecret, { allowLegacy: false }));

                if (keypair.publicKey.toBase58() !== user.depositAddress) throw new Error('Account wallet key does not match its address');

                const context = await loadTokenContext({ requireDestinations: true });
                const balances = await readWalletBalances(user.depositAddress, context);
                const totalAtomic = BigInt(purchase.tokenAmountAtomic);
                if (!balances.tokenAccount || balances.tokenAccount.isFrozen || balances.agarAtomic < totalAtomic) {
                    throw Object.assign(new Error(`Insufficient ${config.symbol} balance.`), { status: 400 });
                }
                if (balances.sol < 0.001) {
                    throw Object.assign(new Error('At least 0.001 SOL is required for the network fee.'), { status: 400 });
                }
                const transaction = new solanaWeb3.Transaction().add(
                    createTransferCheckedInstruction(
                        balances.ata,
                        context.mint,
                        context.treasuryAta,
                        keypair.publicKey,
                        BigInt(purchase.treasuryAmountAtomic),
                        context.mintInfo.decimals,
                        [],
                        context.tokenProgram,
                    ),
                    createTransferCheckedInstruction(
                        balances.ata,
                        context.mint,
                        context.ownerAta,
                        keypair.publicKey,
                        BigInt(purchase.ownerAmountAtomic),
                        context.mintInfo.decimals,
                        [],
                        context.tokenProgram,
                    ),
                );
                transaction.feePayer = keypair.publicKey;
                const latest = await connection.getLatestBlockhash('confirmed');
                transaction.recentBlockhash = latest.blockhash;
                transaction.sign(keypair);
                signature = await connection.sendRawTransaction(transaction.serialize(), {
                    skipPreflight: false,
                    maxRetries: 3,
                });
                purchase.signature = signature;
                purchase.sourceAddress = user.depositAddress;
                purchase.status = 'broadcast';
                await purchase.save();
                const confirmation = await connection.confirmTransaction({
                    signature,
                    blockhash: latest.blockhash,
                    lastValidBlockHeight: latest.lastValidBlockHeight,
                }, 'confirmed');
                if (confirmation.value.err) throw new Error(`AGAR transfer failed: ${JSON.stringify(confirmation.value.err)}`);
                await grantEntitlement(purchase);
                const refreshed = await SkinPurchase.findById(purchase._id);
                const wallet = await readWalletBalances(user.depositAddress, context);
                res.json({
                    purchase: serializePurchase(refreshed),
                    balance: { agar: wallet.agar, sol: wallet.sol },
                });
            } catch (error) {
                if (purchase) {
                    purchase.status = signature ? 'needs_review' : 'failed';
                    purchase.signature = signature || purchase.signature;
                    purchase.error = String(error.message || error).slice(0, 500);
                    await purchase.save().catch(() => {});
                }
                res.status(error.status || (signature ? 202 : 500)).json({
                    message: signature
                        ? 'Payment was broadcast and is being reconciled. Do not retry.'
                        : (error.status ? error.message : `${config.symbol} purchase failed.`),
                    purchase: purchase ? serializePurchase(purchase) : null,
                });
            } finally {
                await releaseWalletOperation(req.user.id, operationId).catch(() => {});
            }
        });

        app.post('/api/agar/swap', sensitiveRateLimit({ limit: 20, windowMs: 60_000 }), authenticateToken, async (req, res) => {
            if (!await requireAgarAccess(req, res)) return;
            if (!config.enabled) return res.status(503).json({ message: `${config.symbol} has not launched yet.` });
            if (!config.swapEnabled) return res.status(503).json({ message: `${config.symbol} account swaps are not enabled yet.` });
            if (!config.jupiterApiKey) return res.status(503).json({ message: 'Jupiter is not configured.' });
            const side = String(req.body?.side || '').toUpperCase();
            if (!['BUY', 'SELL'].includes(side)) return res.status(400).json({ message: 'Swap side must be BUY or SELL.' });
            const operationId = `swap:${randomUUID()}`;
            if (!await acquireWalletOperation(req.user.id, 'agar_swap', operationId)) {
                return res.status(409).json({ message: 'Another wallet operation is already processing.' });
            }
            let record = null;
            let stage = 'configuration';
            try {
                const context = await loadTokenContext();
                stage = 'account_wallet';
                const user = await User.findById(req.user.id).select('depositAddress depositSecret balance');
                if (!user?.depositAddress || !isEncryptedWalletSecret(user.depositSecret)) {
                    throw Object.assign(new Error(`Account wallet must be encrypted before ${config.symbol} swaps.`), { status: 503 });
                }
                if (req.body?.accountAddress && req.body.accountAddress !== user.depositAddress) {
                    throw Object.assign(new Error('Swap wallet must match the wallet linked to your account.'), { status: 403 });
                }
                const keypair = solanaWeb3.Keypair.fromSecretKey(decryptWalletSecret(user.depositSecret, { allowLegacy: false }));
                if (keypair.publicKey.toBase58() !== user.depositAddress) {
                    throw Object.assign(new Error('The encrypted account wallet does not match the account address.'), { status: 503 });
                }
                stage = 'amount_validation';
                const inputMint = side === 'BUY' ? WRAPPED_SOL_MINT : config.mint;
                const outputMint = side === 'BUY' ? config.mint : WRAPPED_SOL_MINT;
                const inputDecimals = side === 'BUY' ? 9 : context.mintInfo.decimals;
                let amountAtomic;
                try {
                    amountAtomic = decimalToAtomic(req.body?.amount, inputDecimals);
                } catch (error) {
                    throw Object.assign(error, { status: 400 });
                }
                if (side === 'BUY' && amountAtomic > 100n * BigInt(solanaWeb3.LAMPORTS_PER_SOL)) {
                    throw Object.assign(new Error('Swap amount exceeds the configured limit.'), { status: 400 });
                }
                stage = 'jupiter_order';
                const orderUrl = new URL(`${config.jupiterBaseUrl}/order`);
                orderUrl.searchParams.set('inputMint', inputMint);
                orderUrl.searchParams.set('outputMint', outputMint);
                orderUrl.searchParams.set('amount', amountAtomic.toString());
                orderUrl.searchParams.set('taker', user.depositAddress);
                const orderResponse = await fetch(orderUrl, {
                    headers: { 'x-api-key': config.jupiterApiKey, Accept: 'application/json' },
                });
                const order = await orderResponse.json();
                if (!orderResponse.ok || !order?.transaction || !order?.requestId) {
                    throw Object.assign(new Error(order?.error || order?.message || 'Jupiter could not create a swap order.'), { status: 502 });
                }
                record = await AgarSwap.create({
                    userId: user._id,
                    side,
                    inputMint,
                    outputMint,
                    inputAmountAtomic: amountAtomic.toString(),
                    outputAmountAtomic: String(order.outAmount || ''),
                    requestId: order.requestId,
                });
                stage = 'transaction_signing';
                const transaction = solanaWeb3.VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
                transaction.sign([keypair]);
                stage = 'jupiter_execute';
                const executeResponse = await fetch(`${config.jupiterBaseUrl}/execute`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': config.jupiterApiKey,
                    },
                    body: JSON.stringify({
                        signedTransaction: Buffer.from(transaction.serialize()).toString('base64'),
                        requestId: order.requestId,
                        ...(order.lastValidBlockHeight ? { lastValidBlockHeight: order.lastValidBlockHeight } : {}),
                    }),
                });
                const result = await executeResponse.json();
                if (!executeResponse.ok || result?.status !== 'Success' || !result?.signature) {
                    throw Object.assign(new Error(result?.error || 'Jupiter swap failed.'), { status: 502 });
                }
                record.status = 'confirmed';
                record.signature = result.signature;
                record.outputAmountAtomic = String(result.outputAmountResult || result.totalOutputAmount || order.outAmount || '');
                await record.save();
                stage = 'balance_refresh';
                const balances = await readWalletBalances(user.depositAddress, context);
                user.balance = balances.sol;
                await user.save();
                res.json({
                    success: true,
                    signature: result.signature,
                    side,
                    inputAmountAtomic: amountAtomic.toString(),
                    outputAmountAtomic: record.outputAmountAtomic,
                    balance: { sol: balances.sol, agar: balances.agar },
                });
            } catch (error) {
                console.error(`[AGAR swap:${stage}]`, error);
                if (record) {
                    record.status = record.signature ? 'needs_review' : 'failed';
                    record.error = String(error.message || error).slice(0, 500);
                    await record.save().catch(() => {});
                }
                const fallbackByStage = {
                    configuration: 'AGAR or the Solana RPC is not ready.',
                    account_wallet: 'The account wallet could not be decrypted or loaded.',
                    amount_validation: 'The swap amount could not be validated.',
                    transaction_signing: 'The Jupiter transaction could not be signed.',
                    balance_refresh: 'The swap may have completed, but balances could not be refreshed.',
                };
                const walletDecryptFailed = error.code === 'WALLET_DECRYPT_FAILED';
                res.status(error.status || (walletDecryptFailed || stage === 'configuration' ? 503 : 500)).json({
                    message: walletDecryptFailed
                        ? 'Account wallet encryption is temporarily unavailable. No transaction was submitted.'
                        : (error.status ? error.message : (fallbackByStage[stage] || `${config.symbol} swap failed.`)),
                    stage,
                    ...(walletDecryptFailed ? { code: error.code } : {}),
                });
            } finally {
                await releaseWalletOperation(req.user.id, operationId).catch(() => {});
            }
        });
    }

    const reconciler = setInterval(async () => {
        const pending = await SkinPurchase.find({
            status: { $in: ['broadcast', 'needs_review'] },
            signature: { $ne: null },
        }).sort({ updatedAt: 1 }).limit(25);
        await Promise.all(pending.map((purchase) => reconcilePurchase(purchase).catch(() => {})));
    }, 30_000);
    reconciler.unref?.();

    return {
        registerRoutes,
        publicConfig,
        listInventory,
        hasSkinEntitlement,
        loadTokenContext,
    };
}
