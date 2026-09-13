function nonNegative(value) {
    return Math.max(0, Number(value) || 0);
}

/**
 * Room accounting is an audit signal, not a reason to silently change the
 * amount the player saw in the HUD. The shared house-wallet liquidity check is
 * authoritative for the immediate on-chain payment.
 */
export function calculateRoomCashoutReservation({ requestedUsd, fundedUsd, reservedUsd, paidUsd }) {
    const requested = nonNegative(requestedUsd);
    const funded = nonNegative(fundedUsd);
    const reserved = nonNegative(reservedUsd);
    const paid = nonNegative(paidUsd);
    const available = Math.max(0, funded - reserved - paid);
    return {
        requestedUsd: requested,
        availableUsd: available,
        ledgerShortfallUsd: Math.max(0, requested - available),
        nextReservedUsd: reserved + requested,
    };
}
