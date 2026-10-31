// Arenifi's explicit rarity progression; these are not historical Surviv.io tiers.
export const SURVIV_WEAPON_RARITIES = Object.freeze({
    m9: 'common',
    ot38: 'common',
    mac10: 'common',
    mp5: 'common',
    p30l: 'rare',
    ump9: 'rare',
    m870: 'rare',
    mp220: 'rare',
    ak47: 'rare',
    m416: 'rare',
    vss: 'rare',
    dp28: 'rare',
    dualm9: 'rare',
    m39emr: 'rare',
    scoutelite: 'rare',
    barm1918: 'rare',
    knife: 'rare',
    famas: 'epic',
    mosin: 'epic',
    m4a1s: 'epic',
    spas12: 'epic',
    saiga12: 'epic',
    scarh: 'epic',
    groza: 'epic',
    awms: 'legendary',
    m249: 'legendary',
    sv98: 'legendary',
});
export const SURVIV_RARITY_COLORS = Object.freeze({
    common: '#c5ceca', rare: '#72acfa', epic: '#bd85ee', legendary: '#e5ba5e',
});
export const getWeaponRarity = (id, fallback = 'common') => SURVIV_WEAPON_RARITIES[id]
    || (fallback === 'military' ? 'epic' : fallback);
