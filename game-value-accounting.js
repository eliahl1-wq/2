function value(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

function entityValue(entity) {
    return value(entity?.dollarBalance ?? entity?.balance);
}

function itemValue(item) {
    return value(item?.dollarValue ?? item?.balance);
}

/** Debit only value the player really owns; visual mass can still be ejected. */
export function allocateAgarEjectionValue({ availableUsd, requestedUsd, retainedRatio = 1 }) {
    const available = value(availableUsd);
    const requested = value(requestedUsd);
    const ratio = Math.min(1, value(retainedRatio));
    const debitedUsd = Math.min(available, requested);
    const ejectedUsd = debitedUsd * ratio;
    return {
        debitedUsd,
        ejectedUsd,
        recycledUsd: debitedUsd - ejectedUsd,
    };
}

/** Snapshot every real-value ledger in a paid shared Agar/Slither room. */
export function calculateNormalRoomValue(room = {}) {
    const playersUsd = (room.players || []).reduce((sum, player) => (
        player?._arenaCashoutReservationUsd > 0 ? sum : sum + entityValue(player)
    ), 0);
    const botsUsd = [...(room.bots || []), ...(room.slitherBots || [])]
        .reduce((sum, bot) => sum + (bot?.freeTicketRewardFunded ? 0 : entityValue(bot)), 0);
    const agarFoodUsd = (room.food || []).reduce((sum, food) => sum + itemValue(food), 0);
    const slitherFoodUsd = (room.slitherFood || []).reduce((sum, food) => sum + itemValue(food), 0);
    const ejectedUsd = (room.ejected || []).reduce((sum, item) => sum + itemValue(item), 0);
    const foodPoolUsd = value(room.foodPoolBalance);
    const aiBudgetUsd = value(room.aiBudgetBalance);
    const ownerAllocatedUsd = value(room.ownerBalance);
    const reservedCashoutUsd = value(room.reservedCashoutUsd);
    const paidCashoutUsd = value(room.paidCashoutUsd);
    const fundedEntryUsd = value(room.fundedEntryUsd);
    const accountedUsd = playersUsd + botsUsd + agarFoodUsd + slitherFoodUsd + ejectedUsd
        + foodPoolUsd + aiBudgetUsd + ownerAllocatedUsd + reservedCashoutUsd + paidCashoutUsd;

    return {
        fundedEntryUsd,
        accountedUsd,
        excessUsd: Math.max(0, accountedUsd - fundedEntryUsd),
        playersUsd,
        botsUsd,
        agarFoodUsd,
        slitherFoodUsd,
        ejectedUsd,
        foodPoolUsd,
        aiBudgetUsd,
        ownerAllocatedUsd,
        reservedCashoutUsd,
        paidCashoutUsd,
    };
}
