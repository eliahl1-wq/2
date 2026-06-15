/**
 * Battle Royale — isolated matches for Agar & Slither variants.
 * Queue → countdown → shrinking zone → last player wins prize pool. No cash-out.
 */

import jwt from 'jsonwebtoken';
import * as solanaWeb3 from '@solana/web3.js';
import {
    SLITHER,
    createSlitherPlayer,
    processSlitherRoom,
    broadcastSlitherState,
    syncBRSlitherFood,
} from './slither-engine.js';
import { QuadTree, Rectangle, Point } from './quadtree.js';
import { getBRHouseWallet, isBRWalletConfigured, normalizeBREntryFee } from './br-wallets.js';

export const BR = {
    entryFees: [5, 10],
    defaultEntryFee: 5,
    minPlayers: 5,
    maxPlayers: 10,
    gracePeriodMs: 15_000,
    queueTimeoutMs: 90_000,
    countdownMs: 15_000,
    shrinkIntervalMs: 45_000,
    shrinkFactor: 0.72,
    minZoneRadius: 380,
    houseFeePct: 0.025,
    agarStartBalance: 1.0,
    agarFoodPerPlayer: 140,
    agarFoodMin: 350,
    agarWorld: 6000,
};

const queues = new Map();
const matches = new Map();
const socketToMatch = new Map();
const mongoToMatch = new Map();
/** @type {Map<string, { readyAt: number, timer: ReturnType<typeof setTimeout> | null }>} */
const queueGrace = new Map();

const MAX_RECENT_BR_VICTORIES = 5;
const recentBRVictories = {
    agar: [],
    slither: [],
};

function queueKey(variant, entryFeeUsd) {
    return `${variant}:${normalizeBREntryFee(entryFeeUsd)}`;
}

function getQueue(variant, entryFeeUsd) {
    const key = queueKey(variant, entryFeeUsd);
    if (!queues.has(key)) queues.set(key, []);
    return queues.get(key);
}

function recordBRVictory(variant, username, amount) {
    const list = recentBRVictories[variant];
    if (!list) return;
    list.unshift({
        username,
        amount: Number(amount.toFixed(2)),
        at: Date.now(),
    });
    if (list.length > MAX_RECENT_BR_VICTORIES) list.pop();
}

export function getRecentBRVictories(variant = null) {
    if (variant === 'agar' || variant === 'slither') return recentBRVictories[variant];
    return {
        agar: recentBRVictories.agar,
        slither: recentBRVictories.slither,
    };
}

/** Humans in queue + active BR matches, per variant and entry fee (for pre-game stats). */
export function getBRPlayerCountsByFee() {
    const result = {
        agar: { 5: 0, 10: 0 },
        slither: { 5: 0, 10: 0 },
    };
    for (const [key, q] of queues.entries()) {
        const [variant, feeStr] = key.split(':');
        const fee = Number(feeStr);
        if (result[variant]) result[variant][fee] = (result[variant][fee] || 0) + q.length;
    }
    for (const room of matches.values()) {
        if (room.status === 'ended') continue;
        const fee = normalizeBREntryFee(room.entryFeeUsd);
        const variant = room.variant;
        const n = room.players.filter(p => !p.disconnected).length;
        if (result[variant]) result[variant][fee] = (result[variant][fee] || 0) + n;
    }
    return result;
}

function randId() {
    return Math.random().toString(36).substr(2, 9);
}

function variantMode(variant) {
    return variant === 'slither' ? 'br-slither' : 'br-agar';
}

function isBRMode(mode) {
    return mode === 'br-agar' || mode === 'br-slither';
}

function getZoneCenter(variant) {
    if (variant === 'slither') return { cx: 0, cy: 0 };
    return { cx: BR.agarWorld / 2, cy: BR.agarWorld / 2 };
}

function initialZoneRadius(variant) {
    if (variant === 'slither') return SLITHER.worldHalf * 0.92;
    return BR.agarWorld * 0.46;
}

function createMatchRoom(variant, prizePool, entryFeeUsd) {
    const { cx, cy } = getZoneCenter(variant);
    const half = variant === 'slither' ? SLITHER.worldHalf : BR.agarWorld / 2;
    const room = {
        id: 'br_' + randId(),
        variant,
        isBattleRoyale: true,
        status: 'countdown',
        players: [],
        bots: [],
        slitherBots: [],
        food: [],
        slitherFood: [],
        viruses: [],
        ejected: [],
        prizePool,
        playerCount: 0,
        entryFeeUsd: normalizeBREntryFee(entryFeeUsd),
        aiBudgetBalance: 0,
        ownerBalance: 0,
        startTime: Date.now(),
        countdownEndsAt: Date.now() + BR.countdownMs,
        zone: {
            cx,
            cy,
            radius: initialZoneRadius(variant),
            phase: 0,
            nextShrinkAt: Date.now() + BR.shrinkIntervalMs,
        },
        qt: new QuadTree(new Rectangle(cx, cy, half, half), 4),
    };
    return room;
}

function removeFromQueue(socketId) {
    for (const [key, q] of queues.entries()) {
        const idx = q.findIndex(e => e.socketId === socketId);
        if (idx >= 0) {
            q.splice(idx, 1);
            if (q.length < BR.minPlayers) {
                clearQueueGrace(key);
            }
            return key;
        }
    }
    return null;
}

function clearQueueGrace(key) {
    const grace = queueGrace.get(key);
    if (grace?.timer) clearTimeout(grace.timer);
    queueGrace.delete(key);
}

function scheduleGraceLaunch(key, variant, entryFeeUsd, io, deps) {
    if (queueGrace.has(key)) return;
    const readyAt = Date.now();
    const timer = setTimeout(() => {
        queueGrace.delete(key);
        try {
            launchMatch(variant, entryFeeUsd, io, deps);
        } catch (err) {
            console.error('BR launch failed after grace:', err);
            emitQueueStatus(io, variant, entryFeeUsd, deps);
        }
    }, BR.gracePeriodMs);
    queueGrace.set(key, { readyAt, timer });
}

function emitQueueStatus(io, variant, entryFeeUsd, deps) {
    const q = getQueue(variant, entryFeeUsd);
    const fee = normalizeBREntryFee(entryFeeUsd);
    const key = queueKey(variant, entryFeeUsd);
    const grace = queueGrace.get(key);
    const graceEndsAt = grace ? grace.readyAt + BR.gracePeriodMs : null;
    const graceRemainingMs = graceEndsAt ? Math.max(0, graceEndsAt - Date.now()) : null;
    const payload = {
        variant,
        entryFeeUsd: fee,
        playersInQueue: q.length,
        minPlayers: BR.minPlayers,
        maxPlayers: BR.maxPlayers,
        graceEndsAt,
        graceRemainingMs,
        searching: q.length < BR.minPlayers
            || (graceRemainingMs != null && graceRemainingMs > 0 && q.length < BR.maxPlayers),
        devFreePlay: !!deps?.DEV_FREE_PLAY,
    };
    q.forEach(e => io.to(e.socketId).emit('brQueueStatus', payload));
}

function launchMatch(variant, entryFeeUsd, io, deps) {
    const key = queueKey(variant, entryFeeUsd);
    const q = getQueue(variant, entryFeeUsd);
    if (q.length < BR.minPlayers) return;
    clearQueueGrace(key);
    const take = Math.min(BR.maxPlayers, q.length);
    const batch = q.splice(0, take);
    try {
        startMatch(batch, variant, entryFeeUsd, io, deps);
        console.log(`🎯 BR match started: ${variant} $${normalizeBREntryFee(entryFeeUsd)} · ${batch.length} players`);
    } catch (err) {
        console.error('BR startMatch failed:', err);
        batch.forEach(entry => q.unshift(entry));
        throw err;
    }
}

function tryStartMatch(variant, entryFeeUsd, io, deps) {
    const key = queueKey(variant, entryFeeUsd);
    const q = getQueue(variant, entryFeeUsd);

    if (q.length < BR.minPlayers) {
        clearQueueGrace(key);
        return;
    }

    if (q.length >= BR.maxPlayers) {
        launchMatch(variant, entryFeeUsd, io, deps);
        return;
    }

    scheduleGraceLaunch(key, variant, entryFeeUsd, io, deps);
    emitQueueStatus(io, variant, entryFeeUsd, deps);
}

/** Safety tick — ensures grace timers / stale queues still progress. */
/** Admin / status — active BR matches (isolated from arena reset). */
export function getBRServerStatus() {
    const activeMatches = [];
    for (const room of matches.values()) {
        if (room.status === 'ended') continue;
        activeMatches.push({
            id: room.id,
            variant: room.variant,
            entryFeeUsd: room.entryFeeUsd,
            status: room.status,
            playerCount: room.players.filter(p => !p.disconnected).length,
            prizePool: room.prizePool,
        });
    }
    let queuedPlayers = 0;
    for (const q of queues.values()) queuedPlayers += q.length;
    return {
        activeMatchCount: activeMatches.length,
        queuedPlayers,
        matches: activeMatches,
        playersByFee: getBRPlayerCountsByFee(),
    };
}

export function processBRQueues(io, deps) {
    for (const [key, q] of queues.entries()) {
        if (!q.length) continue;
        const [variant, feeStr] = key.split(':');
        const entryFeeUsd = Number(feeStr);
        if (q.length >= BR.maxPlayers) {
            tryStartMatch(variant, entryFeeUsd, io, deps);
            continue;
        }
        if (q.length >= BR.minPlayers) {
            const grace = queueGrace.get(key);
            if (!grace) {
                tryStartMatch(variant, entryFeeUsd, io, deps);
            } else if (Date.now() - grace.readyAt >= BR.gracePeriodMs) {
                try {
                    launchMatch(variant, entryFeeUsd, io, deps);
                } catch (err) {
                    console.error('BR launch failed in queue tick:', err);
                }
            } else {
                emitQueueStatus(io, variant, entryFeeUsd, deps);
            }
        }
    }
}

function findQueueEntryBySocket(socketId) {
    for (const [key, q] of queues.entries()) {
        const entry = q.find(x => x.socketId === socketId);
        if (entry) {
            const [variant, feeStr] = key.split(':');
            return { variant, entryFeeUsd: Number(feeStr), entry, key };
        }
    }
    return null;
}

async function refundBREntryFee(entry, variant, entryFeeUsd, deps, reason) {
    const { DEV_FREE_PLAY, SOL_PRICE_USD, connection, Transaction, ensureUserDepositWallet, User } = deps;
    const fee = normalizeBREntryFee(entryFeeUsd);
    const entryFeeInSol = fee / SOL_PRICE_USD;

    if (DEV_FREE_PLAY) {
        await Transaction.create({
            userId: entry.mongoId,
            type: 'game',
            amount: entryFeeInSol,
            meta: { event: 'br_refund', entryFeeUsd: fee, variant, reason, simulated: true },
            status: 'confirmed',
        });
        return true;
    }

    try {
        const user = await User.findById(entry.mongoId);
        if (!user) return false;
        const userWithWallet = await ensureUserDepositWallet(user);
        if (!userWithWallet.depositAddress) return false;

        const brWallet = getBRHouseWallet(variant, fee);
        const lamports = Math.round(entryFeeInSol * solanaWeb3.LAMPORTS_PER_SOL);
        const brKeypair = solanaWeb3.Keypair.fromSecretKey(
            Uint8Array.from(Buffer.from(brWallet.secret, 'hex'))
        );
        const refundTx = new solanaWeb3.Transaction().add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: brKeypair.publicKey,
                toPubkey: new solanaWeb3.PublicKey(userWithWallet.depositAddress),
                lamports,
            })
        );
        const sig = await solanaWeb3.sendAndConfirmTransaction(connection, refundTx, [brKeypair]);
        await Transaction.create({
            userId: entry.mongoId,
            type: 'withdraw',
            amount: entryFeeInSol,
            meta: { event: 'br_refund', signature: sig, reason, variant, entryFeeUsd: fee },
            status: 'confirmed',
        });
        console.log(`↩️ BR refund $${fee} (${variant}) → ${entry.username}: ${reason}`);
        return true;
    } catch (err) {
        console.error('BR refund failed:', err.message);
        return false;
    }
}

async function refundAllBRPlayers(room, deps, reason) {
    for (const player of [...room.players]) {
        await refundBREntryFee(
            { mongoId: player.mongoId, username: player.username },
            room.variant,
            room.entryFeeUsd,
            deps,
            reason,
        );
    }
}

function processQueueTimeouts(io, deps) {
    const now = Date.now();
    for (const [key, q] of queues.entries()) {
        const [variant, feeStr] = key.split(':');
        const entryFeeUsd = Number(feeStr);
        for (let i = q.length - 1; i >= 0; i--) {
            const entry = q[i];
            if (now - entry.joinedAt <= BR.queueTimeoutMs) continue;
            q.splice(i, 1);
            if (q.length < BR.minPlayers) clearQueueGrace(key);
            refundBREntryFee(entry, variant, entryFeeUsd, deps, 'queue_timeout').catch(err => {
                console.error('Queue timeout refund failed:', err.message);
            });
            entry.socket?.emit('error', 'Queue timed out — entry fee refunded.');
            emitQueueStatus(io, variant, entryFeeUsd, deps);
        }
    }
}

function findQueueEntry(mongoId) {
    for (const [key, q] of queues.entries()) {
        const e = q.find(x => x.mongoId === mongoId);
        if (e) {
            const [variant, feeStr] = key.split(':');
            return { variant, entryFeeUsd: Number(feeStr), entry: e, key };
        }
    }
    return null;
}

function addBRAgarFood(room, n) {
    for (let i = 0; i < n; i++) {
        const { x, y } = randomSpawnInZone(room);
        room.food.push({
            id: randId(),
            x,
            y,
            hue: Math.floor(Math.random() * 360),
            radius: 5,
            balance: 0.01,
        });
    }
}

function syncBRAgarFood(room, playerCount) {
    const target = Math.max(BR.agarFoodMin, playerCount * BR.agarFoodPerPlayer);
    if (room.food.length < target) {
        addBRAgarFood(room, Math.min(60, target - room.food.length));
    } else if (room.food.length > target * 1.35) {
        room.food.length = target;
    }
}

function createBRAgarPlayer(socketId, mongoId, username, color, room, deps) {
    const { x, y } = randomSpawnInZone(room);
    const { calculateCellRadius, c } = deps;
    const startBalance = c.playerStartBalance;
    return {
        id: socketId,
        mongoId,
        username,
        mode: 'br-agar',
        isBattleRoyale: true,
        brMatchId: room.id,
        kills: 0,
        balance: startBalance,
        startTime: Date.now(),
        color,
        x,
        y,
        mouseX: 0,
        mouseY: 0,
        screenWidth: 1920,
        screenHeight: 1080,
        cells: [{
            id: randId(),
            x, y,
            balance: startBalance,
            radius: calculateCellRadius(startBalance, startBalance, 1, startBalance),
            vx: 0, vy: 0,
            lastSplit: Date.now(),
        }],
    };
}

function randomSpawnInZone(room) {
    const { cx, cy, radius } = room.zone;
    for (let i = 0; i < 25; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * radius * 0.85;
        const x = cx + Math.cos(angle) * dist;
        const y = cy + Math.sin(angle) * dist;
        if (room.variant === 'slither') {
            if (Math.abs(x) < SLITHER.worldHalf * 0.9 && Math.abs(y) < SLITHER.worldHalf * 0.9) {
                return { x, y };
            }
        } else if (x > 30 && x < BR.agarWorld - 30 && y > 30 && y < BR.agarWorld - 30) {
            return { x, y };
        }
    }
    return { x: cx, y: cy };
}

function createBRSlitherPlayer(socketId, mongoId, username, color, room) {
    const { x, y } = randomSpawnInZone(room);
    const p = createSlitherPlayer(socketId, mongoId, username, color, room);
    p.mode = 'slither';
    p.isBattleRoyale = true;
    p.brMatchId = room.id;
    p.x = x;
    p.y = y;
    const angle = p.angle || 0;
    const spacing = 7;
    p.segments = p.segments.map((s, i) => ({
        x: x - Math.cos(angle) * i * spacing,
        y: y - Math.sin(angle) * i * spacing,
    }));
    return p;
}

function isOutsideZone(room, x, y) {
    const { cx, cy, radius } = room.zone;
    return Math.hypot(x - cx, y - cy) > radius;
}

function eliminateBRPlayer(room, player, io, deps, reason = 'eliminated') {
    const { User, Transaction } = deps;
    const alive = room.players.filter(p => !p.disconnected && p.id !== player.id);
    const placement = alive.length + 1;

    io.to(player.id).emit('brEliminated', {
        placement,
        playersRemaining: alive.length,
        reason,
        prizePool: room.prizePool,
    });
    io.to(player.id).emit('RIP');

    if (player.mongoId) {
        User.findByIdAndUpdate(player.mongoId, {
            $inc: { playtime: Date.now() - (player.startTime || Date.now()) },
        }).catch(() => {});
        Transaction.create({
            userId: player.mongoId,
            type: 'game',
            amount: 0,
            meta: {
                reason: 'BR Eliminated',
                event: 'death',
                mode: player.mode,
                variant: room.variant,
                entryFeeUsd: room.entryFeeUsd,
                placement,
                matchId: room.id,
            },
            status: 'confirmed',
        }).catch(() => {});
    }

    room.players = room.players.filter(p => p.id !== player.id);
    socketToMatch.delete(player.id);
    if (player.mongoId) mongoToMatch.delete(player.mongoId.toString());

    tryDeclareBRWinner(room, io, deps);
}

function tryDeclareBRWinner(room, io, deps) {
    if (room.status !== 'active') return;
    const connected = room.players.filter(p => !p.disconnected && socketToMatch.has(p.id));

    if (connected.length === 1) {
        finishMatch(room, connected[0], io, deps);
    } else if (room.players.length === 0) {
        endMatchNoWinner(room, io);
    } else if (connected.length === 0) {
        if (!room._allDisconnectedSince) {
            room._allDisconnectedSince = Date.now();
        } else if (Date.now() - room._allDisconnectedSince >= 90_000) {
            refundAllBRPlayers(room, deps, 'all_disconnected').finally(() => {
                room.players.forEach(p => io.to(p.id).emit('brMatchEnd', { cancelled: true, reason: 'all_disconnected' }));
                endMatchNoWinner(room, io);
            });
        }
    } else {
        room._allDisconnectedSince = null;
    }
}

async function sweepBROwnerCut(room, deps) {
    const { DEV_FREE_PLAY, SOL_PRICE_USD, connection, Transaction, OWNER_VAULT_ADDRESS } = deps;
    const totalPotUsd = room.playerCount * room.entryFeeUsd;
    const ownerCutUsd = totalPotUsd * BR.houseFeePct;

    if (DEV_FREE_PLAY || !OWNER_VAULT_ADDRESS) {
        if (DEV_FREE_PLAY) {
            await Transaction.create({
                type: 'withdraw',
                amount: ownerCutUsd,
                meta: {
                    event: 'br_owner_sweep',
                    simulated: true,
                    matchId: room.id,
                    variant: room.variant,
                    entryFeeUsd: room.entryFeeUsd,
                    playerCount: room.playerCount,
                    ownerCutPct: BR.houseFeePct,
                    reason: 'BR Owner Cut Sweep',
                },
                status: 'confirmed',
            });
        }
        return;
    }

    try {
        const brWallet = getBRHouseWallet(room.variant, room.entryFeeUsd);
        const ownerCutSol = ownerCutUsd / SOL_PRICE_USD;
        let lamports = Math.round(ownerCutSol * solanaWeb3.LAMPORTS_PER_SOL);

        const brPubKey = new solanaWeb3.PublicKey(brWallet.address);
        const walletLamports = await connection.getBalance(brPubKey);
        const feeBuffer = Math.round(0.0005 * solanaWeb3.LAMPORTS_PER_SOL);
        lamports = Math.min(lamports, Math.max(0, walletLamports - feeBuffer));
        if (lamports <= 0) {
            console.warn(`BR owner sweep skipped (${room.variant} $${room.entryFeeUsd}): insufficient BR wallet balance`);
            return;
        }

        const brKeypair = solanaWeb3.Keypair.fromSecretKey(
            Uint8Array.from(Buffer.from(brWallet.secret, 'hex'))
        );
        const sweepTx = new solanaWeb3.Transaction().add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: brKeypair.publicKey,
                toPubkey: new solanaWeb3.PublicKey(OWNER_VAULT_ADDRESS),
                lamports,
            })
        );
        const sig = await solanaWeb3.sendAndConfirmTransaction(connection, sweepTx, [brKeypair]);
        const solAmount = lamports / solanaWeb3.LAMPORTS_PER_SOL;

        await Transaction.create({
            type: 'withdraw',
            amount: solAmount * SOL_PRICE_USD,
            currency: 'SOL',
            meta: {
                event: 'br_owner_sweep',
                signature: sig,
                solAmount,
                from: brWallet.address,
                destination: OWNER_VAULT_ADDRESS,
                matchId: room.id,
                variant: room.variant,
                entryFeeUsd: room.entryFeeUsd,
                playerCount: room.playerCount,
                ownerCutPct: BR.houseFeePct,
                reason: 'BR Owner Cut Sweep',
            },
            status: 'confirmed',
        });
        console.log(`💸 BR Owner Sweep: ${solAmount.toFixed(6)} SOL (${room.variant} $${room.entryFeeUsd}, ${room.playerCount} players) → owner vault`);
    } catch (err) {
        console.error('BR owner sweep failed:', err.message);
        await Transaction.create({
            type: 'game',
            amount: 0,
            meta: {
                event: 'failure',
                reason: 'br_owner_sweep_failed',
                matchId: room.id,
                variant: room.variant,
                error: err.message,
            },
        }).catch(() => {});
    }
}

async function finishMatch(room, winner, io, deps) {
    if (room.status === 'ended') return;
    room.status = 'ended';

    const payout = room.prizePool;

    room.players.forEach(p => {
        io.to(p.id).emit('brMatchEnd', { winnerId: winner.id, winnerName: winner.username, prizePool: room.prizePool });
    });

    try {
        const { User, Transaction, DEV_FREE_PLAY, SOL_PRICE_USD, connection, ensureUserDepositWallet } = deps;

        if (DEV_FREE_PLAY) {
            const user = await User.findById(winner.mongoId);
            if (user) {
                user.playtime += Date.now() - winner.startTime;
                await user.save();
            }
            await Transaction.create({
                userId: winner.mongoId,
                type: 'withdraw',
                amount: payout,
                meta: { simulated: true, freePlay: true, reason: 'BR Victory', matchId: room.id, mode: winner.mode, entryFeeUsd: room.entryFeeUsd, variant: room.variant },
                status: 'confirmed',
            });
            console.log(`🎮 [FREE PLAY] BR victory: ${winner.username} won $${payout.toFixed(2)} (simulated)`);
            recordBRVictory(room.variant, winner.username, payout);
            io.to(winner.id).emit('brVictory', { amount: payout, signature: 'simulated', placement: 1 });
            await sweepBROwnerCut(room, deps);
        } else {
            const brWallet = getBRHouseWallet(room.variant, room.entryFeeUsd);
            let user = await User.findById(winner.mongoId);
            user = await ensureUserDepositWallet(user);
            const solToTransfer = payout / SOL_PRICE_USD;
            const lamports = Math.round(solToTransfer * solanaWeb3.LAMPORTS_PER_SOL);
            const houseKeypair = solanaWeb3.Keypair.fromSecretKey(
                Uint8Array.from(Buffer.from(brWallet.secret, 'hex'))
            );
            const transaction = new solanaWeb3.Transaction().add(
                solanaWeb3.SystemProgram.transfer({
                    fromPubkey: houseKeypair.publicKey,
                    toPubkey: new solanaWeb3.PublicKey(user.depositAddress),
                    lamports,
                })
            );
            const sig = await solanaWeb3.sendAndConfirmTransaction(connection, transaction, [houseKeypair]);
            user.playtime += Date.now() - winner.startTime;
            await user.save();
            await Transaction.create({
                userId: winner.mongoId,
                type: 'withdraw',
                amount: payout,
                currency: 'SOL',
                meta: {
                    signature: sig,
                    reason: 'BR Victory',
                    matchId: room.id,
                    mode: winner.mode,
                    variant: room.variant,
                    entryFeeUsd: room.entryFeeUsd,
                    brHouseWallet: brWallet.address,
                },
                status: 'confirmed',
            });
            recordBRVictory(room.variant, winner.username, payout);
            io.to(winner.id).emit('brVictory', { amount: payout, signature: sig, placement: 1 });
            await sweepBROwnerCut(room, deps);
        }
    } catch (err) {
        console.error('BR payout failed:', err.message);
        io.to(winner.id).emit('error', 'Victory payout failed — contact support.');
    }

    room.players.forEach(p => {
        socketToMatch.delete(p.id);
        if (p.mongoId) mongoToMatch.delete(p.mongoId.toString());
    });
    matches.delete(room.id);
}

function endMatchNoWinner(room, io) {
    room.status = 'ended';
    matches.delete(room.id);
}

function rebuildBRQuadTree(room, allUsers) {
    room.qt.clear();
    room.food.forEach(f => {
        room.qt.insert(new Point(f.x, f.y, { type: 'food', data: f }));
    });
    allUsers.forEach(player => {
        for (const cell of player.cells) {
            room.qt.insert(new Point(cell.x, cell.y, {
                type: 'player',
                socketId: player.id,
                cell,
            }));
        }
    });
}

function cellBalance(cell) {
    return cell.balance ?? cell.mass ?? 1;
}

function playerTotalMass(player) {
    return player.cells.reduce((s, cl) => s + cellBalance(cl), 0);
}

function processBRAgarMatch(room, io, deps) {
    const { c, calculateCellRadius } = deps;
    const startBal = c.playerStartBalance;
    const allUsers = room.players.filter(p => !p.disconnected);
    const userMap = new Map(allUsers.map(u => [u.id, u]));

    rebuildBRQuadTree(room, allUsers);

    allUsers.forEach(player => {
        for (const cell of player.cells) {
            const bal = cellBalance(cell);
            const speed = (6 / Math.pow(Math.max(bal, 1), 0.449)) * c.speedMult;
            const angle = Math.atan2(player.mouseY, player.mouseX);
            const distToMouse = Math.hypot(player.mouseX, player.mouseY);
            const moveSpeed = distToMouse < 50 ? (speed * distToMouse / 50) : speed;
            cell.x += Math.cos(angle) * moveSpeed + (cell.vx || 0);
            cell.y += Math.sin(angle) * moveSpeed + (cell.vy || 0);
            cell.vx = (cell.vx || 0) * 0.85;
            cell.vy = (cell.vy || 0) * 0.85;
            const r = cell.radius;
            cell.x = Math.max(r, Math.min(c.worldWidth - r, cell.x));
            cell.y = Math.max(r, Math.min(c.worldHeight - r, cell.y));

            if (isOutsideZone(room, cell.x, cell.y)) {
                eliminateBRPlayer(room, player, io, deps, 'zone');
                return;
            }

            const range = new Rectangle(cell.x, cell.y, r * 2, r * 2);
            for (const item of room.qt.query(range)) {
                if (item.type === 'food') {
                    if (Math.hypot(cell.x - item.data.x, cell.y - item.data.y) < r) {
                        cell.balance = cellBalance(cell) + (item.data.balance || c.foodBlobValue);
                        cell.radius = calculateCellRadius(cell.balance, playerTotalMass(player), player.cells.length, startBal);
                        room.food = room.food.filter(f => f.id !== item.data.id);
                    }
                } else if (item.type === 'player' && item.socketId !== player.id) {
                    const other = userMap.get(item.socketId);
                    const otherCell = item.cell;
                    if (!other) continue;
                    const d = Math.hypot(cell.x - otherCell.x, cell.y - otherCell.y);
                    if (cellBalance(cell) > cellBalance(otherCell) * 1.05 && d < (r + otherCell.radius) * 0.1) {
                        cell.balance = cellBalance(cell) + cellBalance(otherCell);
                        cell.radius = calculateCellRadius(cell.balance, playerTotalMass(player), player.cells.length, startBal);
                        player.kills = (player.kills || 0) + 1;
                        other.cells = other.cells.filter(cl => cl.id !== otherCell.id);
                        if (other.cells.length === 0) eliminateBRPlayer(room, other, io, deps, 'killed');
                    }
                }
            }
        }
        player.balance = playerTotalMass(player);
        if (player.cells.length) {
            player.x = player.cells.reduce((s, cl) => s + cl.x, 0) / player.cells.length;
            player.y = player.cells.reduce((s, cl) => s + cl.y, 0) / player.cells.length;
        }
    });

    rebuildBRQuadTree(room, allUsers);

    const lb = allUsers
        .map(p => ({
            id: p.id,
            name: p.username,
            kills: p.kills || 0,
            mass: Math.round(playerTotalMass(p)),
        }))
        .sort((a, b) => b.kills - a.kills || b.mass - a.mass);

    allUsers.forEach(p => {
        io.to(p.id).emit('leaderboard', { leaderboard: lb, battleRoyale: true });
        const pad = 400;
        const foodPad = 600;
        const rangeX = (p.screenWidth || 1920) / 2 + pad;
        const rangeY = (p.screenHeight || 1080) / 2 + pad;
        const visibleItems = room.qt.query(new Rectangle(p.x, p.y, rangeX, rangeY));
        const foodItems = room.qt.query(new Rectangle(p.x, p.y, rangeX + foodPad, rangeY + foodPad));
        const visibleUsersSet = new Set([p]);
        const visibleFood = [];
        visibleItems.forEach(item => {
            if (item.type === 'player') {
                const found = userMap.get(item.socketId);
                if (found) visibleUsersSet.add(found);
            }
        });
        foodItems.forEach(item => {
            if (item.type === 'food') visibleFood.push(item.data);
        });
        io.to(p.id).emit('serverTellPlayerMove', p, Array.from(visibleUsersSet), visibleFood, [], [], {
            unlocked: false,
            unlockTime: 0,
            playerCount: allUsers.length,
            resetTime: null,
            solPrice: deps.SOL_PRICE_USD,
            battleRoyale: true,
            zone: room.zone,
            prizePool: room.prizePool,
            aliveCount: allUsers.length,
        });
    });
}

function applyZoneDamageSlither(room, io, deps) {
    for (const player of [...room.players]) {
        if (player.disconnected || !player.isBattleRoyale) continue;
        const head = player.segments?.[0];
        if (!head) continue;
        if (isOutsideZone(room, head.x, head.y)) {
            eliminateBRPlayer(room, player, io, deps, 'zone');
        }
    }
}

function updateZone(room, io) {
    const now = Date.now();
    if (now < room.zone.nextShrinkAt || room.status !== 'active') return;
    room.zone.phase += 1;
    room.zone.radius = Math.max(BR.minZoneRadius, room.zone.radius * BR.shrinkFactor);
    room.zone.nextShrinkAt = now + BR.shrinkIntervalMs;

    const payload = {
        matchId: room.id,
        ...room.zone,
        shrinkIn: BR.shrinkIntervalMs,
    };
    room.players.forEach(p => io.to(p.id).emit('brZoneUpdate', payload));
}

function startMatch(queuedPlayers, variant, entryFeeUsd, io, deps) {
    const fee = normalizeBREntryFee(entryFeeUsd ?? queuedPlayers[0]?.entryFeeUsd);
    const prizePool = queuedPlayers.length * fee * (1 - BR.houseFeePct);
    const room = createMatchRoom(variant, prizePool, fee);
    room.playerCount = queuedPlayers.length;
    matches.set(room.id, room);

    queuedPlayers.forEach(entry => {
        removeFromQueue(entry.socketId);
        const color = deps.util.randomColor();
        let player;
        if (variant === 'slither') {
            player = createBRSlitherPlayer(entry.socketId, entry.mongoId, entry.username, color, room);
        } else {
            player = createBRAgarPlayer(entry.socketId, entry.mongoId, entry.username, color, room, deps);
        }
        room.players.push(player);
        socketToMatch.set(entry.socketId, room.id);
        mongoToMatch.set(entry.mongoId, room.id);
        entry.socket.brMatchId = room.id;
        entry.socket.join(`br:${room.id}`);
    });

    room.players.forEach(p => {
        io.to(p.id).emit('brMatchCountdown', {
            matchId: room.id,
            seconds: BR.countdownMs / 1000,
            prizePool: room.prizePool,
            playerCount: room.players.length,
            variant,
            zone: room.zone,
        });
    });

    setTimeout(() => {
        if (!matches.has(room.id)) return;
        room.status = 'active';
        room.zone.nextShrinkAt = Date.now() + BR.shrinkIntervalMs;
        if (variant === 'agar') {
            addBRAgarFood(room, Math.max(BR.agarFoodMin, room.players.length * BR.agarFoodPerPlayer));
            rebuildBRQuadTree(room, room.players);
        }
        room.players.forEach(p => {
            const meta = {
                width: variant === 'slither' ? SLITHER.worldHalf * 2 : BR.agarWorld,
                height: variant === 'slither' ? SLITHER.worldHalf * 2 : BR.agarWorld,
                mode: variantMode(variant),
                rejoin: false,
                solPrice: deps.SOL_PRICE_USD,
                battleRoyale: true,
                prizePool: room.prizePool,
                playerCount: room.playerCount,
                entryFeeUsd: room.entryFeeUsd,
                zone: room.zone,
                cashOutRemaining: 0,
            };
            io.to(p.id).emit('welcome', p, meta);
            io.to(p.id).emit('brMatchStart', {
                matchId: room.id,
                variant,
                prizePool: room.prizePool,
                playerCount: room.playerCount,
                entryFeeUsd: room.entryFeeUsd,
                zone: room.zone,
            });
        });
    }, BR.countdownMs);
}

async function chargeEntryFee(user, deps, variant, entryFeeUsd) {
    const { DEV_FREE_PLAY, SOL_PRICE_USD, connection, Transaction } = deps;
    const fee = normalizeBREntryFee(entryFeeUsd);
    const entryFeeInSol = fee / SOL_PRICE_USD;

    if (DEV_FREE_PLAY) {
        await Transaction.create({
            userId: user._id,
            type: 'game',
            amount: entryFeeInSol,
            meta: { event: 'br_join', entryFeeUsd: fee, variant, simulated: true, freePlay: true },
            status: 'confirmed',
        });
        console.log(`🎮 [FREE PLAY] ${user.username} joined BR ${variant} $${fee} (simulated)`);
        return true;
    }

    const brWallet = getBRHouseWallet(variant, entryFeeUsd);
    const userPubKey = new solanaWeb3.PublicKey(user.depositAddress);
    const currentLamports = await connection.getBalance(userPubKey);
    const feeLamports = Math.round(entryFeeInSol * solanaWeb3.LAMPORTS_PER_SOL);
    if (currentLamports < feeLamports + 5000) return false;

    const userKeypair = solanaWeb3.Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(user.depositSecret, 'hex'))
    );
    const joinTx = new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.transfer({
            fromPubkey: userPubKey,
            toPubkey: new solanaWeb3.PublicKey(brWallet.address),
            lamports: feeLamports,
        })
    );
    await solanaWeb3.sendAndConfirmTransaction(connection, joinTx, [userKeypair]);
    await Transaction.create({
        userId: user._id,
        type: 'game',
        amount: entryFeeInSol,
        meta: {
            event: 'br_join',
            entryFeeUsd: fee,
            variant,
            brHouseWallet: brWallet.address,
        },
        status: 'confirmed',
    });
    return true;
}

/** Tick all active BR matches — call at 40Hz from server loop. */
export function processBattleRoyaleMatches(io, deps) {
    processQueueTimeouts(io, deps);

    for (const room of matches.values()) {
        if (room.status === 'countdown' || room.status === 'ended') continue;

        updateZone(room, io);

        if (room.variant === 'slither') {
            const humanCount = room.players.filter(p => !p.disconnected).length;
            syncBRSlitherFood(room, humanCount);
            processSlitherRoom(room, io, deps.User, null);
            applyZoneDamageSlither(room, io, deps);
            const lb = room.players
                .filter(p => !p.disconnected)
                .map(p => ({
                    id: p.id,
                    name: p.username,
                    kills: p.kills || 0,
                    length: p.segments?.length || 0,
                }))
                .sort((a, b) => b.kills - a.kills || b.length - a.length);
            broadcastSlitherState(room, io, lb, {
                resetTime: null,
                solPrice: deps.SOL_PRICE_USD,
                isResetting: false,
                battleRoyale: true,
                zone: room.zone,
                prizePool: room.prizePool,
                aliveCount: room.players.filter(p => !p.disconnected).length,
            });
        } else {
            const humanCount = room.players.filter(p => !p.disconnected).length;
            syncBRAgarFood(room, humanCount);
            processBRAgarMatch(room, io, deps);
        }

        tryDeclareBRWinner(room, io, deps);
    }
}

export function getBRMatchForMongo(mongoId) {
    const id = mongoToMatch.get(mongoId?.toString());
    return id ? matches.get(id) : null;
}

export function isPlayerInBR(mongoId) {
    return mongoToMatch.has(mongoId?.toString());
}

export function findBRPlayerBySocket(socketId) {
    const matchId = socketToMatch.get(socketId);
    if (!matchId) return null;
    const room = matches.get(matchId);
    if (!room) return null;
    const player = room.players.find(p => p.id === socketId);
    return player ? { room, player } : null;
}

export function findBRPlayerByMongo(mongoId) {
    const matchId = mongoToMatch.get(mongoId?.toString());
    if (!matchId) return null;
    const room = matches.get(matchId);
    if (!room) return null;
    const player = room.players.find(p => p.mongoId?.toString() === mongoId?.toString());
    return player ? { room, player } : null;
}

export function setupBattleRoyale(io, deps) {
    io.on('connection', (socket) => {
        socket.on('brJoinQueue', async ({ variant, token, username, entryFeeUsd: rawEntryFee }) => {
            try {
                if (variant !== 'agar' && variant !== 'slither') {
                    socket.emit('error', 'Invalid battle royale variant.');
                    return;
                }
                const entryFeeUsd = normalizeBREntryFee(rawEntryFee);
                const decoded = jwt.verify(token, deps.JWT_SECRET || 'fallback_hemlighet_byt_ut_mig');
                const user = await deps.User.findById(decoded.id);
                if (!user) return;

                if (mongoToMatch.has(user._id.toString())) {
                    socket.emit('error', 'You are already in a battle royale match.');
                    return;
                }
                if (findQueueEntry(user._id.toString())) {
                    socket.emit('error', 'Already in queue.');
                    return;
                }
                for (const room of deps.rooms) {
                    const inNormal = room.players.find(p => p.mongoId?.toString() === user._id.toString());
                    if (inNormal) {
                        socket.emit('error', 'Leave the normal arena before joining battle royale.');
                        return;
                    }
                }

                if (!deps.DEV_FREE_PLAY && !isBRWalletConfigured(variant, entryFeeUsd)) {
                    socket.emit('error', `Battle Royale (${variant} $${entryFeeUsd}) is not configured yet. Contact support.`);
                    return;
                }

                const paid = await chargeEntryFee(user, deps, variant, entryFeeUsd);
                if (!paid) {
                    socket.emit('error', `Insufficient balance for $${entryFeeUsd} BR entry.`);
                    return;
                }

                removeFromQueue(socket.id);
                getQueue(variant, entryFeeUsd).push({
                    socketId: socket.id,
                    mongoId: user._id.toString(),
                    username: username || user.username,
                    entryFeeUsd,
                    joinedAt: Date.now(),
                    socket,
                });
                socket.brQueueVariant = variant;
                socket.brQueueEntryFee = entryFeeUsd;
                tryStartMatch(variant, entryFeeUsd, io, deps);
                emitQueueStatus(io, variant, entryFeeUsd, deps);
            } catch (err) {
                console.error('brJoinQueue failed:', err.message);
                socket.emit('error', 'Failed to join battle royale queue.');
            }
        });

        socket.on('brLeaveQueue', async () => {
            const found = findQueueEntryBySocket(socket.id);
            if (!found) return;
            removeFromQueue(socket.id);
            await refundBREntryFee(found.entry, found.variant, found.entryFeeUsd, deps, 'queue_leave');
            emitQueueStatus(io, found.variant, found.entryFeeUsd, deps);
        });

        socket.on('brRejoinMatch', async ({ token }) => {
            try {
                const decoded = jwt.verify(token, deps.JWT_SECRET || 'fallback_hemlighet_byt_ut_mig');
                const found = findBRPlayerByMongo(decoded.id);
                if (!found || found.room.status === 'ended') {
                    socket.emit('error', 'Battle royale match is no longer active.');
                    return;
                }
                const { room, player } = found;
                player.id = socket.id;
                player.disconnected = false;
                socketToMatch.set(socket.id, room.id);
                socket.brMatchId = room.id;
                socket.join(`br:${room.id}`);

                const variant = room.variant;
                socket.emit('welcome', player, {
                    width: variant === 'slither' ? SLITHER.worldHalf * 2 : BR.agarWorld,
                    height: variant === 'slither' ? SLITHER.worldHalf * 2 : BR.agarWorld,
                    mode: variantMode(variant),
                    rejoin: true,
                    solPrice: deps.SOL_PRICE_USD,
                    battleRoyale: true,
                    prizePool: room.prizePool,
                    playerCount: room.playerCount,
                    entryFeeUsd: room.entryFeeUsd,
                    zone: room.zone,
                    cashOutRemaining: 0,
                });
                socket.emit('brMatchStart', {
                    matchId: room.id,
                    variant,
                    prizePool: room.prizePool,
                    playerCount: room.playerCount,
                    entryFeeUsd: room.entryFeeUsd,
                    zone: room.zone,
                });
            } catch {
                socket.emit('error', 'Failed to rejoin battle royale match.');
            }
        });

        socket.on('disconnect', () => {
            const found = findQueueEntryBySocket(socket.id);
            if (found) {
                removeFromQueue(socket.id);
                refundBREntryFee(found.entry, found.variant, found.entryFeeUsd, deps, 'queue_disconnect').catch(() => {});
                emitQueueStatus(io, found.variant, found.entryFeeUsd, deps);
            }
            const matchId = socketToMatch.get(socket.id);
            if (!matchId) return;
            const room = matches.get(matchId);
            const player = room?.players.find(p => p.id === socket.id);
            if (!player || room?.status === 'ended') return;
            player.disconnected = true;
            socketToMatch.delete(socket.id);
        });
    });
}
