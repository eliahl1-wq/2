/** Return only the bot deficit that the room can fully fund right now. */
export function getFundedBotSpawnCount({
    targetCount,
    activeCount,
    pendingCount = 0,
    aiBudget,
    botStake,
    maxSpawn = Number.POSITIVE_INFINITY,
}) {
    const target = Math.max(0, Math.floor(Number(targetCount) || 0));
    const active = Math.max(0, Math.floor(Number(activeCount) || 0));
    const pending = Math.max(0, Math.floor(Number(pendingCount) || 0));
    const stake = Number(botStake);
    if (!(stake > 0)) return 0;

    const deficit = Math.max(0, target - active - pending);
    const affordable = Math.max(0, Math.floor(((Number(aiBudget) || 0) + 1e-9) / stake));
    const cap = Number.isFinite(maxSpawn)
        ? Math.max(0, Math.floor(maxSpawn))
        : deficit;
    return Math.min(deficit, affordable, cap);
}
