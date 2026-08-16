export const PUBLIC_FREE_PLAY_ROOM_OWNER = 'public';

export function getPublicFreePlayEntryFee(mode) {
    return mode === 'surviv' || mode === 'competitive-slither' ? 5 : 10;
}
