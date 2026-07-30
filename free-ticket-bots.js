export const FREE_TICKET_BOTS_PER_JOIN = 4;
export const FREE_TICKET_MAX_BOTS_PER_MODE = 10;

function modeKey(mode) {
    return mode === 'slither' ? 'slither' : 'agar';
}

function autoBotCount(room, mode) {
    const bots = modeKey(mode) === 'slither' ? room.slitherBots : room.bots;
    return (bots || []).filter(bot => !bot.adminSpawned).length;
}

export function getFreeTicketBotTarget(room, mode) {
    const key = modeKey(mode);
    return Math.min(
        FREE_TICKET_MAX_BOTS_PER_MODE,
        Math.max(0, Number(room.freeTicketBotTargets?.[key]) || 0),
    );
}

export function registerFreeTicketBotJoin(room, mode) {
    const key = modeKey(mode);
    const currentTarget = getFreeTicketBotTarget(room, key);
    const nextTarget = Math.min(
        FREE_TICKET_MAX_BOTS_PER_MODE,
        Math.max(currentTarget, autoBotCount(room, key)) + FREE_TICKET_BOTS_PER_JOIN,
    );
    room.freeTicketBotTargets = {
        agar: getFreeTicketBotTarget(room, 'agar'),
        slither: getFreeTicketBotTarget(room, 'slither'),
        [key]: nextTarget,
    };
    return nextTarget;
}

export function resetFreeTicketBotTargets(room) {
    room.freeTicketBotTargets = { agar: 0, slither: 0 };
}
