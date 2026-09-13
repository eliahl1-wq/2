export const DEFAULT_MISSING_BROADCAST_TIMEOUT_MS = 10 * 60 * 1000;

export function shouldReleaseMissingBroadcastClaim(
    claim,
    now = Date.now(),
    timeoutMs = DEFAULT_MISSING_BROADCAST_TIMEOUT_MS,
) {
    const updatedAt = new Date(claim?.updatedAt || claim?.createdAt || 0).getTime();
    const safeTimeout = Math.max(60_000, Number(timeoutMs) || DEFAULT_MISSING_BROADCAST_TIMEOUT_MS);
    return Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt >= safeTimeout;
}
