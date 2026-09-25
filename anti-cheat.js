const TWO_PI = Math.PI * 2;

function finite(value) {
    return Number.isFinite(Number(value));
}

function angleDelta(a, b) {
    let delta = Number(a) - Number(b);
    while (delta > Math.PI) delta -= TWO_PI;
    while (delta < -Math.PI) delta += TWO_PI;
    return delta;
}

function entityPosition(entity) {
    if (finite(entity?.x) && finite(entity?.y)) return { x: Number(entity.x), y: Number(entity.y) };
    const head = entity?.segments?.[0] || entity?.cells?.[0];
    return finite(head?.x) && finite(head?.y) ? { x: Number(head.x), y: Number(head.y) } : null;
}

function playerIdentity(player, mode, room) {
    return {
        userId: player?.mongoId || null,
        username: String(player?.username || player?.name || '').slice(0, 80),
        roomId: String(room?.id || '').slice(0, 160),
        gameSessionId: String(player?.gameSessionId || '').slice(0, 160),
        mode: String(mode || player?.mode || '').slice(0, 80),
    };
}

function activeSurvivTargets(player, room) {
    return [
        ...(Array.isArray(room?.players) ? room.players : []),
        ...(Array.isArray(room?.bots) ? room.bots : []),
    ].filter(target => target && target !== player && target.id !== player?.id
        && !target.disconnected && !target._eliminated && (target.hp == null || target.hp > 0));
}

function closestAimTarget(player, targets, aim, maxDistance) {
    const origin = entityPosition(player);
    if (!origin || !Number.isFinite(aim)) return null;
    let closest = null;
    for (const target of targets) {
        const position = entityPosition(target);
        if (!position) continue;
        const dx = position.x - origin.x;
        const dy = position.y - origin.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 60 || distance > maxDistance) continue;
        const error = Math.abs(angleDelta(aim, Math.atan2(dy, dx)));
        const angularRadius = Math.atan2(Math.max(10, Number(target.radius) || 14), distance);
        const centerRatio = error / Math.max(0.0001, angularRadius);
        if (!closest || centerRatio < closest.centerRatio) {
            closest = { target, position, distance, error, centerRatio };
        }
    }
    return closest;
}

/**
 * Per-socket, server-side heuristics. These signals deliberately never ban,
 * kick, change rewards or affect simulation. They only emit throttled review
 * records after repeated evidence so a noisy packet or a skilled shot cannot
 * punish a legitimate player.
 */
export function createAntiCheatSession({ report, now = () => Date.now() } = {}) {
    const state = {
        packetWindows: new Map(),
        actionTimes: new Map(),
        invalidTimes: new Map(),
        reportCooldowns: new Map(),
        surviv: {
            lastAim: null,
            lastAimAt: 0,
            lastShooting: false,
            lastPressId: null,
            samples: [],
            hiddenSamples: [],
            lastShotSampleAt: 0,
            targetPositions: new Map(),
            trace: [],
            lastTraceAt: 0,
            visibleRange: 1200,
        },
    };

    const buildSurvivEvidenceReplay = () => {
        const frames = state.surviv.trace.slice(-72);
        if (!frames.length) return null;
        const startedAt = frames[0].at;
        return {
            version: 1,
            durationMs: Math.max(0, frames[frames.length - 1].at - startedAt),
            visibleRange: state.surviv.visibleRange,
            frames: frames.map(({ at, ...frame }) => ({ ...frame, t: at - startedAt })),
        };
    };

    const emit = (code, details, cooldownMs = 10 * 60_000) => {
        if (typeof report !== 'function') return false;
        const at = now();
        if (at < (state.reportCooldowns.get(code) || 0)) return false;
        state.reportCooldowns.set(code, at + cooldownMs);
        try {
            const replay = String(details?.mode || '').includes('surviv')
                ? buildSurvivEvidenceReplay()
                : null;
            Promise.resolve(report({
                code,
                ...details,
                context: {
                    ...(details?.context || {}),
                    ...(replay ? { evidenceReplay: replay } : {}),
                },
            })).catch(() => {});
        } catch {
            // Anti-cheat telemetry must never affect live gameplay.
        }
        return true;
    };

    const observePacketRate = ({ kind, limit, player, room, mode }) => {
        const at = now();
        const key = String(kind || mode || 'game');
        let window = state.packetWindows.get(key);
        if (!window) {
            window = { startedAt: at, count: 0, violationRecorded: false, violations: [] };
            state.packetWindows.set(key, window);
        }
        if (at - window.startedAt >= 1000) {
            if (window.count > limit && !window.violationRecorded) {
                window.violations.push({ at, count: window.count });
            }
            window.violations = window.violations.filter(item => at - item.at <= 20_000);
            window.startedAt = at;
            window.count = 0;
            window.violationRecorded = false;
        }
        window.count += 1;
        if (window.count === limit + 25) {
            window.violations.push({ at, count: window.count });
            window.violationRecorded = true;
        }
        window.violations = window.violations.filter(item => at - item.at <= 20_000);
        if (window.violations.length >= 3) {
            const peakPerSecond = Math.max(window.count, ...window.violations.map(item => item.count));
            emit('input_rate_abuse', {
                severity: 'warning',
                title: 'Potential automated or modified client',
                message: `${player?.username || 'An account'} repeatedly sent more ${mode || 'game'} inputs than the official client requires. This can indicate a bot, macro or modified client.`,
                ...playerIdentity(player, mode, room),
                context: {
                    signal: 'packet_rate',
                    packetKind: key,
                    peakPerSecond,
                    violatedWindows: window.violations.length,
                    reviewOnly: true,
                },
            });
            window.violations = [];
        }
    };

    const observeActionRate = ({ action, limit, windowMs = 1000, player, room, mode }) => {
        const at = now();
        const key = `${mode || 'game'}:${action}`;
        const times = (state.actionTimes.get(key) || []).filter(time => at - time <= windowMs);
        times.push(at);
        state.actionTimes.set(key, times);
        if (times.length > limit) {
            emit('impossible_action_rate', {
                severity: 'warning',
                title: 'Potential action automation',
                message: `${player?.username || 'An account'} sent ${action} actions faster than normal gameplay permits. This can indicate a macro or game bot.`,
                ...playerIdentity(player, mode, room),
                context: {
                    signal: 'action_rate',
                    action,
                    eventsInWindow: times.length,
                    windowMs,
                    reviewOnly: true,
                },
            });
            times.length = 0;
        }
    };

    const observeInvalidInput = ({ reason, player, room, mode, context = {} }) => {
        const at = now();
        const key = String(mode || 'game');
        const times = (state.invalidTimes.get(key) || []).filter(time => at - time <= 10_000);
        times.push(at);
        state.invalidTimes.set(key, times);
        if (times.length >= 4) {
            emit('invalid_game_input', {
                severity: 'warning',
                title: 'Repeated invalid game input',
                message: `${player?.username || 'An account'} repeatedly sent malformed or out-of-range ${mode || 'game'} controls.`,
                ...playerIdentity(player, mode, room),
                context: {
                    signal: 'invalid_input',
                    reason: String(reason || 'invalid payload').slice(0, 180),
                    invalidInputsInWindow: times.length,
                    reviewOnly: true,
                    ...context,
                },
            });
            times.length = 0;
        }
    };

    const observeSurvivInput = ({ player, room, payload, visibleRange = 1200, mode = 'surviv' }) => {
        if (!player || !room || !payload || typeof payload !== 'object') return;
        const at = now();
        const aim = Number(payload.aimAngle);
        const shooting = payload.shooting === true;
        const pressId = Number(payload.firePressId);
        const validPressId = Number.isSafeInteger(pressId) && pressId >= 0;
        const isNewPress = shooting && (
            !state.surviv.lastShooting
            || (validPressId && pressId !== state.surviv.lastPressId)
        );
        state.surviv.visibleRange = Math.max(300, Number(visibleRange) || 1200);

        let targets = null;
        const getTargets = () => {
            targets ||= activeSurvivTargets(player, room);
            return targets;
        };

        if (!state.surviv.trace.length || at - state.surviv.lastTraceAt >= 90) {
            const origin = entityPosition(player);
            const traceTargets = origin
                ? getTargets().map(target => {
                    const position = entityPosition(target);
                    if (!position) return null;
                    const dx = position.x - origin.x;
                    const dy = position.y - origin.y;
                    const distance = Math.hypot(dx, dy);
                    if (distance > visibleRange * 1.45) return null;
                    return {
                        id: String(target.id || '').slice(0, 64),
                        dx: Math.round(dx),
                        dy: Math.round(dy),
                        distance: Math.round(distance),
                        bot: !!target.isBot,
                        offscreen: distance > visibleRange,
                    };
                }).filter(Boolean).sort((a, b) => a.distance - b.distance).slice(0, 5)
                : [];
            const traceClosest = closestAimTarget(player, getTargets(), aim, visibleRange * 1.45);
            state.surviv.trace.push({
                at,
                x: Math.round(Number(player.x) || 0),
                y: Math.round(Number(player.y) || 0),
                aim: Number.isFinite(aim) ? Number(aim.toFixed(4)) : 0,
                shooting,
                moving: Math.hypot(Number(payload.dx) || 0, Number(payload.dy) || 0) > 0.08,
                weapon: String(player.weapon?.type || 'fists').slice(0, 40),
                closestTargetId: traceClosest ? String(traceClosest.target.id || '').slice(0, 64) : null,
                centerRatio: traceClosest ? Number(traceClosest.centerRatio.toFixed(3)) : null,
                targets: traceTargets,
            });
            state.surviv.trace = state.surviv.trace.filter(frame => at - frame.at <= 10_000).slice(-72);
            state.surviv.lastTraceAt = at;
        }

        if (!finite(payload.dx) || !finite(payload.dy) || !finite(payload.aimAngle)
            || Math.abs(Number(payload.dx)) > 1.05 || Math.abs(Number(payload.dy)) > 1.05
            || (payload.aimDistance != null && (!finite(payload.aimDistance) || Math.abs(Number(payload.aimDistance)) > 10_000))) {
            observeInvalidInput({ reason: 'non-finite or out-of-range movement/aim', player, room, mode });
        }

        const heldFireSampleDue = shooting && at - state.surviv.lastShotSampleAt >= 90;
        if (Number.isFinite(aim) && shooting && (isNewPress || heldFireSampleDue)) {
            state.surviv.lastShotSampleAt = at;
            const closest = closestAimTarget(player, getTargets(), aim, visibleRange * 2.6);

            if (closest) {
                const elapsed = at - (state.surviv.lastAimAt || at);
                const snapDelta = state.surviv.lastAim == null ? 0 : Math.abs(angleDelta(aim, state.surviv.lastAim));
                const previousTargetPosition = state.surviv.targetPositions.get(closest.target.id);
                const targetMovement = previousTargetPosition && at - previousTargetPosition.at <= 500
                    ? Math.hypot(
                        closest.position.x - previousTargetPosition.x,
                        closest.position.y - previousTargetPosition.y,
                    )
                    : 0;
                state.surviv.targetPositions.set(closest.target.id, {
                    at,
                    x: closest.position.x,
                    y: closest.position.y,
                });
                const sample = {
                    at,
                    targetId: closest.target.id,
                    centerPerfect: closest.centerRatio <= 0.08,
                    snapped: closest.centerRatio <= 0.08 && snapDelta >= 0.12 && elapsed <= 120,
                    hidden: closest.distance > visibleRange * 1.2,
                    distance: Math.round(closest.distance),
                    centerRatio: Number(closest.centerRatio.toFixed(4)),
                    movingTarget: targetMovement >= 6,
                };
                state.surviv.samples.push(sample);
                state.surviv.samples = state.surviv.samples.filter(item => at - item.at <= 30_000).slice(-36);
                if (sample.hidden && sample.centerPerfect) {
                    state.surviv.hiddenSamples.push(sample);
                    state.surviv.hiddenSamples = state.surviv.hiddenSamples.filter(item => at - item.at <= 120_000).slice(-20);
                }

                const recent = state.surviv.samples.slice(-24);
                const perfect = recent.filter(item => item.centerPerfect).length;
                const snaps = recent.filter(item => item.snapped).length;
                const targetSwitches = recent.reduce((count, item, index) => (
                    index > 0 && item.targetId !== recent[index - 1].targetId ? count + 1 : count
                ), 0);
                if (recent.length >= 14 && perfect / recent.length >= 0.86 && snaps >= 6 && targetSwitches >= 4) {
                    emit('surviv_aim_automation', {
                        severity: 'warning',
                        title: 'Potential Surviv aim automation',
                        message: `${player.username || 'An account'} repeatedly snapped almost exactly to player centres while firing. Review the account before taking action.`,
                        ...playerIdentity(player, mode, room),
                        context: {
                            signal: 'aim_snap_pattern',
                            riskScore: Math.min(100, Math.round(55 + (perfect / recent.length) * 25 + snaps)),
                            shotSamples: recent.length,
                            centerPerfectShots: perfect,
                            rapidSnaps: snaps,
                            targetSwitches,
                            reviewOnly: true,
                        },
                    }, 15 * 60_000);
                }

                const movingTracking = recent.filter(item => item.movingTarget);
                const movingPerfect = movingTracking.filter(item => item.centerPerfect);
                const trackingSpan = movingTracking.length > 1
                    ? movingTracking[movingTracking.length - 1].at - movingTracking[0].at
                    : 0;
                const meanTrackingRatio = movingTracking.length
                    ? movingTracking.reduce((sum, item) => sum + item.centerRatio, 0) / movingTracking.length
                    : Infinity;
                if (movingTracking.length >= 18
                    && trackingSpan >= 1600
                    && movingPerfect.length / movingTracking.length >= 0.9
                    && meanTrackingRatio <= 0.05) {
                    emit('surviv_automatic_tracking', {
                        severity: 'warning',
                        title: 'Potential Surviv automatic tracking',
                        message: `${player.username || 'An account'} kept its aim almost perfectly centred while targets moved. Review the server evidence playback before taking action.`,
                        ...playerIdentity(player, mode, room),
                        context: {
                            signal: 'moving_target_lock',
                            riskScore: Math.min(100, Math.round(72 + movingPerfect.length)),
                            trackingSamples: movingTracking.length,
                            perfectTrackingSamples: movingPerfect.length,
                            meanCenterRatio: Number(meanTrackingRatio.toFixed(4)),
                            trackingSpanMs: trackingSpan,
                            reviewOnly: true,
                        },
                    }, 15 * 60_000);
                }

                const hidden = state.surviv.hiddenSamples.slice(-10);
                const hiddenTargets = new Set(hidden.map(item => item.targetId));
                if (hidden.length >= 8 && hiddenTargets.size >= 3) {
                    emit('surviv_hidden_target_tracking', {
                        severity: 'warning',
                        title: 'Potential hidden-player tracking',
                        message: `${player.username || 'An account'} repeatedly aimed at exact off-screen player positions. This may indicate unauthorized game-state access.`,
                        ...playerIdentity(player, mode, room),
                        context: {
                            signal: 'offscreen_target_lock',
                            riskScore: Math.min(100, 68 + hidden.length * 2),
                            samples: hidden.length,
                            distinctTargets: hiddenTargets.size,
                            reviewOnly: true,
                        },
                    }, 15 * 60_000);
                }
            }
        }

        if (Number.isFinite(aim)) {
            state.surviv.lastAim = aim;
            state.surviv.lastAimAt = at;
        }
        state.surviv.lastShooting = shooting;
        if (validPressId) state.surviv.lastPressId = pressId;
    };

    return {
        observePacketRate,
        observeActionRate,
        observeInvalidInput,
        observeSurvivInput,
    };
}

export const antiCheatMath = { angleDelta };
