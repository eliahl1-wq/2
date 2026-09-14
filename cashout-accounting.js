function nonNegative(value) {
    return Math.max(0, Number(value) || 0);
}

/** Cap settlement to real entry value funded in this reset cycle. */
export function calculateRoomCashoutReservation({ requestedUsd, fundedUsd, reservedUsd, paidUsd }) {
    const requested = nonNegative(requestedUsd);
    const funded = nonNegative(fundedUsd);
    const reserved = nonNegative(reservedUsd);
    const paid = nonNegative(paidUsd);
    const available = Math.max(0, funded - reserved - paid);
    const payable = Math.min(requested, available);
    return {
        requestedUsd: requested,
        payableUsd: payable,
        availableUsd: available,
        ledgerShortfallUsd: Math.max(0, requested - available),
        nextReservedUsd: reserved + payable,
    };
}
