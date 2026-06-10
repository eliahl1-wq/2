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
import { getBRHouseWallet, isBRWalletConfigured } from './br-wallets.js';

export const BR = {
    entryFeeUsd: 5,
    minPlayers: 4,
    maxPlayers: 16,
    queueTimeoutMs: 90_000,
    countdownMs: 15_000,
    shrinkIntervalMs: 45_000,
    shrinkFactor: 0.72,
    minZoneRadius: 380,
    houseFeePct: 0.05,
    agarStartMass: 25,
    agarWorld: 6000,
};

const queues = { agar: [], slither: [] };
const matches = new Map();
const socketToMatch = new Map();
const mongoToMatch = new Map();

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

function createMatchRoom(variant, prizePool) {
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
        entryFeeUsd: BR.entryFeeUsd,
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
    for (const key of ['agar', 'slither']) {
        const idx = queues[key].findIndex(e => e.socketId === socketId);
        if (idx >= 0) queues[key].splice(idx, 1);
    }
}

function findQueueEntry(mongoId) {
    for (const key of ['agar', 'slither']) {
        const e = queues[key].find(q => q.mongoId === mongoId);
        if (e) return { variant: key, entry: e };
    }
    return null;
}

function emitQueueStatus(io, variant) {
    const q = queues[variant];
    const oldest = q[0]?.joinedAt || Date.now();
    const payload = {
        variant,
        playersInQueue: q.length,
        minPlayers: BR.minPlayers,
        maxPlayers: BR.maxPlayers,
        entryFeeUsd: BR.entryFeeUsd,
        waitMs: Math.max(0, BR.queueTimeoutMs - (Date.now() - oldest)),
    };
    q.forEach(e => io.to(e.socketId).emit('brQueueStatus', payload));
}

function createBRAgarPlayer(socketId, mongoId, username, color, room, deps) {
    const { x, y } = randomSpawnInZone(room);
    const mass = BR.agarStartMass;
    const { calculateCellRadius } = deps;
    return {
        id: socketId,
        mongoId,
        username,
        mode: 'br-agar',
        isBattleRoyale: true,
        brMatchId: room.id,
        kills: 0,
        mass,
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
            mass,
            radius: calculateCellRadius(mass, mass, 1),
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
            meta: { reason: 'BR Eliminated', mode: player.mode, placement, matchId: room.id },
            status: 'confirmed',
        }).catch(() => {});
    }

    room.players = room.players.filter(p => p.id !== player.id);
    socketToMatch.delete(player.id);
    if (player.mongoId) mongoToMatch.delete(player.mongoId.toString());

    if (alive.length === 1 && room.status === 'active') {
        finishMatch(room, alive[0], io, deps);
    } else if (alive.length === 0 && room.status === 'active') {
        endMatchNoWinner(room, io);
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
        const brWallet = getBRHouseWallet(room.variant);

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
                meta: { simulated: true, reason: 'BR Victory', matchId: room.id, mode: winner.mode },
                status: 'confirmed',
            });
            io.to(winner.id).emit('brVictory', { amount: payout, signature: 'simulated', placement: 1 });
        } else {
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
                    brHouseWallet: brWallet.address,
                },
                status: 'confirmed',
            });
            io.to(winner.id).emit('brVictory', { amount: payout, signature: sig, placement: 1 });
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

function cellMass(cell) {
    return cell.mass ?? cell.balance ?? 1;
}

function playerTotalMass(player) {
    return player.cells.reduce((s, cl) => s + cellMass(cl), 0);
}

function processBRAgarMatch(room, io, deps) {
    const { c, calculateCellRadius } = deps;
    const allUsers = room.players.filter(p => !p.disconnected);
    const userMap = new Map(allUsers.map(u => [u.id, u]));

    allUsers.forEach(player => {
        for (const cell of player.cells) {
            const mass = cellMass(cell);
            const speed = (6 / Math.pow(Math.max(mass, 1), 0.449)) * c.speedMult;
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
                if (item.type !== 'player' || item.socketId === player.id) continue;
                const other = userMap.get(item.socketId);
                const otherCell = item.cell;
                if (!other) continue;
                const d = Math.hypot(cell.x - otherCell.x, cell.y - otherCell.y);
                if (cellMass(cell) > cellMass(otherCell) * 1.05 && d < (r + otherCell.radius) * 0.1) {
                    cell.mass = cellMass(cell) + cellMass(otherCell);
                    cell.radius = calculateCellRadius(cell.mass, cell.mass, player.cells.length);
                    player.kills = (player.kills || 0) + 1;
                    other.cells = other.cells.filter(cl => cl.id !== otherCell.id);
                    if (other.cells.length === 0) eliminateBRPlayer(room, other, io, deps, 'killed');
                }
            }
        }
        player.mass = playerTotalMass(player);
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
        const rangeX = (p.screenWidth || 1920) / 2 + 400;
        const rangeY = (p.screenHeight || 1080) / 2 + 400;
        const visible = room.qt.query(new Rectangle(p.x, p.y, rangeX, rangeY));
        const visibleUsersSet = new Set([p]);
        visible.forEach(item => {
            if (item.type === 'player') {
                const found = userMap.get(item.socketId);
                if (found) visibleUsersSet.add(found);
            }
        });
        io.to(p.id).emit('serverTellPlayerMove', p, Array.from(visibleUsersSet), [], [], [], {
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

function startMatch(queuedPlayers, variant, io, deps) {
    const prizePool = queuedPlayers.length * BR.entryFeeUsd * (1 - BR.houseFeePct);
    const room = createMatchRoom(variant, prizePool);
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
        if (variant === 'agar') rebuildBRQuadTree(room, room.players);
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

function tryStartMatch(variant, io, deps) {
    const q = queues[variant];
    if (q.length < BR.minPlayers) return;

    const oldest = q[0]?.joinedAt || Date.now();
    const timedOut = Date.now() - oldest >= BR.queueTimeoutMs;
    const enough = q.length >= 10;
    const full = q.length >= BR.maxPlayers;

    if (!full && !enough && !timedOut) return;

    const take = Math.min(BR.maxPlayers, q.length);
    const batch = q.splice(0, take);
    startMatch(batch, variant, io, deps);
}

async function chargeEntryFee(user, deps, variant) {
    const { DEV_FREE_PLAY, SOL_PRICE_USD, connection, Transaction } = deps;
    const entryFeeInSol = BR.entryFeeUsd / SOL_PRICE_USD;

    if (DEV_FREE_PLAY) {
        await Transaction.create({
            userId: user._id,
            type: 'game',
            amount: entryFeeInSol,
            meta: { event: 'br_join', entryFeeUsd: BR.entryFeeUsd, variant, simulated: true },
            status: 'confirmed',
        });
        return true;
    }

    const brWallet = getBRHouseWallet(variant);
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
            entryFeeUsd: BR.entryFeeUsd,
            variant,
            brHouseWallet: brWallet.address,
        },
        status: 'confirmed',
    });
    return true;
}

/** Tick all active BR matches — call at 40Hz from server loop. */
export function processBattleRoyaleMatches(io, deps) {
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
            processBRAgarMatch(room, io, deps);
        }

        const alive = room.players.filter(p => !p.disconnected);
        if (room.status === 'active' && alive.length === 1) {
            finishMatch(room, alive[0], io, deps);
        }
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
        socket.on('brJoinQueue', async ({ variant, token, username }) => {
            try {
                if (variant !== 'agar' && variant !== 'slither') {
                    socket.emit('error', 'Invalid battle royale variant.');
                    return;
                }
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
                const inNormal = deps.rooms[0].players.find(p => p.mongoId?.toString() === user._id.toString());
                if (inNormal) {
                    socket.emit('error', 'Leave the normal arena before joining battle royale.');
                    return;
                }

                if (!DEV_FREE_PLAY && !isBRWalletConfigured(variant)) {
                    socket.emit('error', `Battle Royale (${variant}) is not configured yet. Contact support.`);
                    return;
                }

                const paid = await chargeEntryFee(user, deps, variant);
                if (!paid) {
                    socket.emit('error', `Insufficient balance for $${BR.entryFeeUsd} BR entry.`);
                    return;
                }

                removeFromQueue(socket.id);
                queues[variant].push({
                    socketId: socket.id,
                    mongoId: user._id.toString(),
                    username: username || user.username,
                    joinedAt: Date.now(),
                    socket,
                });
                socket.brQueueVariant = variant;
                emitQueueStatus(io, variant);
                tryStartMatch(variant, io, deps);
            } catch (err) {
                socket.emit('error', 'Failed to join battle royale queue.');
            }
        });

        socket.on('brLeaveQueue', () => {
            removeFromQueue(socket.id);
            if (socket.brQueueVariant) emitQueueStatus(io, socket.brQueueVariant);
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
            removeFromQueue(socket.id);
            const matchId = socketToMatch.get(socket.id);
            if (!matchId) return;
            const room = matches.get(matchId);
            const player = room?.players.find(p => p.id === socket.id);
            if (player && room?.status === 'active') {
                eliminateBRPlayer(room, player, io, deps, 'disconnect');
            }
        });
    });
}
