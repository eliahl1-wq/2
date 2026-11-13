import { getEconomy, DEFAULT_ENTRY_FEE } from './economy.js';

// Called only after the socket handler verifies admin access and a free room.
export function queueAdminFood(room, mode) {
    const key = mode || 'agar';
    room.adminFoodExtraTargets ||= {};
    const previous = room.adminFoodExtraTargets[key] || 0;
    const count = Math.min(250, Math.max(0, 5000 - previous));
    if (!count) return 0;
    room.adminFoodExtraTargets[key] = previous + count;
    if (key !== 'competitive-slither') {
        const value = getEconomy(room.entryFeeUsd ?? DEFAULT_ENTRY_FEE).foodBlobValue;
        room.foodPoolBalance = (room.foodPoolBalance || 0) + count * value;
    }
    // Standard sync adds bounded batches on subsequent ticks, respecting caps.
    room._lastAgarFoodSync = 0;
    room._lastSlitherFoodSync = 0;
    room._lastCompetitiveFoodSync = 0;
    return count;
}
