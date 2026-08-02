const NORMAL_GAME_MODES = new Set(['agar', 'slither', 'surviv']);
const NORMAL_DEATH_REASONS = new Set(['Arena Death', 'Surviv Death']);
const NORMAL_CASHOUT_REASONS = new Set(['Arena Cashout', 'Auto Room Reset', 'Auto Room Reset to Account Address']);

export function isQualifyingFreeTicketCompletion(transaction) {
    if (!transaction || transaction.status !== 'confirmed') return false;
    if (transaction.excludedFromReports || transaction.meta?.simulated || transaction.meta?.isFreeTicketPlay) return false;
    if (!NORMAL_GAME_MODES.has(transaction.meta?.mode)) return false;

    const isDeath = transaction.type === 'game'
        && transaction.meta?.event === 'death'
        && NORMAL_DEATH_REASONS.has(transaction.meta?.reason);
    const isCashout = transaction.type === 'withdraw'
        && NORMAL_CASHOUT_REASONS.has(transaction.meta?.reason);
    return isDeath || isCashout;
}

export function hasUnlockedFreeTicket(user) {
    return !!(!user?.rewardsDisabled
        && user?.freeTicketChallengeCompleted
        && user?.hasFreeTicket
        && !user?.freeTicketUsed);
}
