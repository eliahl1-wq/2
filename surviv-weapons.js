const FAMILY_DEFAULTS = Object.freeze({
    pistol: { spread: 0.055, bulletSpeed: 42, range: 2900, pellets: 1, automatic: false },
    revolver: { spread: 0.035, bulletSpeed: 46, range: 3300, pellets: 1, automatic: false },
    smg: { spread: 0.14, bulletSpeed: 38, range: 2700, pellets: 1, automatic: true, firingMoveMultiplier: 0.8 },
    shotgun: { spread: 0.31, bulletSpeed: 31, range: 1900, pellets: 9, automatic: false },
    assault: { spread: 0.085, bulletSpeed: 44, range: 3400, pellets: 1, automatic: true, firingMoveMultiplier: 0.75 },
    dmr: { spread: 0.026, bulletSpeed: 51, range: 3900, pellets: 1, automatic: false },
    sniper: { spread: 0.012, bulletSpeed: 59, range: 4600, pellets: 1, automatic: false },
    lmg: { spread: 0.12, bulletSpeed: 43, range: 3500, pellets: 1, automatic: true, firingMoveMultiplier: 0.67 },
});

function gun(id, label, family, ammoType, damage, fireRateMs, clipSize, reloadMs, rarity = 'common', overrides = {}) {
    return Object.freeze({
        id,
        label,
        family,
        rarity,
        damage,
        fireRateMs,
        clipSize,
        reloadMs,
        ammoType,
        ...FAMILY_DEFAULTS[family],
        ...overrides,
    });
}

const FIREARMS = {
    m9: gun('m9', 'M9', 'pistol', '9mm', 12, 240, 15, 1800),
    p30l: gun('p30l', 'P30L', 'pistol', '9mm', 18, 200, 15, 1700, 'rare'),
    mp5: gun('mp5', 'MP5', 'smg', '9mm', 11, 90, 30, 2000),
    mac10: gun('mac10', 'MAC-10', 'smg', '9mm', 7, 45, 32, 1800, 'common', { spread: 0.21 }),
    ump9: gun('ump9', 'UMP9', 'smg', '9mm', 14, 110, 30, 2200, 'rare', { spread: 0.1 }),
    vector9: gun('vector9', 'Vector (9mm)', 'smg', '9mm', 8, 38, 33, 1600, 'military', { spread: 0.16 }),
    g18c: gun('g18c', 'G18C', 'pistol', '9mm', 8, 55, 17, 1700, 'rare', { automatic: true, spread: 0.18 }),
    m93r: gun('m93r', 'M93R', 'pistol', '9mm', 11, 75, 20, 1900, 'rare', { automatic: true, spread: 0.1 }),
    cz3a1: gun('cz3a1', 'CZ-3A1', 'smg', '9mm', 11, 55, 30, 2100, 'military', { spread: 0.1 }),
    vss: gun('vss', 'VSS', 'dmr', '9mm', 22, 160, 20, 2300, 'rare', { bulletSpeed: 44, range: 3500 }),
    flamethrower: gun('flamethrower', 'Flame Thrower', 'smg', '9mm', 6, 42, 60, 2600, 'military', { bulletSpeed: 28, range: 1000, spread: 0.18 }),

    m1100: gun('m1100', 'M1100', 'shotgun', '12g', 7, 300, 4, 2200, 'common', { pellets: 8 }),
    m870: gun('m870', 'M870', 'shotgun', '12g', 12.5, 900, 5, 3750, 'rare'),
    mp220: gun('mp220', 'MP220', 'shotgun', '12g', 12.5, 180, 2, 2800, 'rare'),
    saiga12: gun('saiga12', 'Saiga-12', 'shotgun', '12g', 12.5, 400, 5, 2500, 'military', { automatic: true }),
    spas12: gun('spas12', 'SPAS-12', 'shotgun', '12g', 10, 700, 9, 3000, 'rare', { pellets: 9, spread: 0.24 }),
    usas12: gun('usas12', 'USAS-12', 'shotgun', '12g', 9, 270, 10, 2900, 'military', { automatic: true, pellets: 9 }),
    super90: gun('super90', 'Super 90', 'shotgun', '12g', 18, 650, 8, 3200, 'military', { pellets: 1, spread: 0.025, bulletSpeed: 48, range: 3400 }),
    hawk12g: gun('hawk12g', 'Hawk 12G', 'shotgun', '12g', 13, 800, 5, 2800, 'military', { pellets: 9, spread: 0.22 }),
    lasrgun: gun('lasrgun', 'Lasr Gun', 'pistol', '12g', 48, 750, 5, 2800, 'military', { spread: 0.11, bulletSpeed: 52 }),

    ak47: gun('ak47', 'AK-47', 'assault', '762', 15, 100, 30, 2500, 'rare', { spread: 0.1 }),
    ot38: gun('ot38', 'OT-38', 'revolver', '762', 26, 400, 5, 2400),
    ots38: gun('ots38', 'OTs-38', 'revolver', '762', 29, 400, 5, 2400, 'rare', { spread: 0.022 }),
    m39emr: gun('m39emr', 'M39 EMR', 'dmr', '762', 24, 240, 20, 2600, 'rare'),
    dp28: gun('dp28', 'DP-28', 'lmg', '762', 14, 110, 60, 3500, 'rare', { spread: 0.13 }),
    mosin: gun('mosin', 'Mosin-Nagant', 'sniper', '762', 72, 1000, 5, 3600, 'rare'),
    scarh: gun('scarh', 'SCAR-H', 'assault', '762', 20, 150, 20, 2600, 'military', { spread: 0.055 }),
    barm1918: gun('barm1918', 'BAR M1918', 'lmg', '762', 22, 150, 20, 2700, 'rare', { spread: 0.075 }),
    sv98: gun('sv98', 'SV-98', 'sniper', '762', 80, 1400, 10, 2700, 'military'),
    groza: gun('groza', 'Groza', 'assault', '762', 13, 80, 30, 2800, 'military', { spread: 0.07 }),
    grozas: gun('grozas', 'Groza-S', 'assault', '762', 13, 78, 30, 2800, 'military', { spread: 0.055 }),
    an94: gun('an94', 'AN-94', 'assault', '762', 17, 110, 30, 2500, 'military', { spread: 0.06 }),
    m1garand: gun('m1garand', 'M1 Garand', 'dmr', '762', 48, 400, 8, 2400, 'military'),
    pkp: gun('pkp', 'PKP Pecheneg', 'lmg', '762', 18, 100, 200, 5000, 'military', { spread: 0.08 }),
    svd63: gun('svd63', 'SVD-63', 'dmr', '762', 56, 500, 10, 2600, 'military'),
    blr81: gun('blr81', 'BLR 81', 'sniper', '762', 56, 800, 5, 2500, 'rare'),
    pkm: gun('pkm', 'PKM', 'lmg', '762', 17, 95, 100, 4800, 'military', { spread: 0.09 }),
    m134: gun('m134', 'M134', 'lmg', '762', 12, 35, 200, 5500, 'military', { spread: 0.16, firingMoveMultiplier: 0.55 }),
    watergun: gun('watergun', 'Water Gun', 'assault', '762', 9, 70, 30, 2200, 'rare', { bulletSpeed: 36, range: 2400 }),

    famas: gun('famas', 'FAMAS', 'assault', '556', 17, 115, 25, 2300, 'rare', { automatic: true, spread: 0.065 }),
    m249: gun('m249', 'M249', 'lmg', '556', 14, 80, 100, 5000, 'military'),
    m416: gun('m416', 'M416', 'assault', '556', 11, 75, 30, 2300, 'rare'),
    m4a1s: gun('m4a1s', 'M4A1-S', 'assault', '556', 14, 82, 30, 3100, 'military', { spread: 0.055 }),
    mk12spr: gun('mk12spr', 'Mk 12 SPR', 'dmr', '556', 20, 150, 20, 2400, 'rare'),
    qbb97: gun('qbb97', 'QBB-97', 'lmg', '556', 14, 100, 75, 4000, 'rare', { spread: 0.09 }),
    scoutelite: gun('scoutelite', 'Scout Elite', 'sniper', '556', 56, 1100, 5, 2000, 'rare'),
    l86a2: gun('l86a2', 'L86A2', 'dmr', '556', 27, 190, 30, 2900, 'rare'),

    m1911: gun('m1911', 'M1911', 'pistol', '45acp', 14, 220, 7, 2100),
    m1a1: gun('m1a1', 'M1A1', 'smg', '45acp', 13, 100, 30, 2400, 'rare'),
    vector45: gun('vector45', 'Vector (.45 ACP)', 'smg', '45acp', 11, 45, 25, 1900, 'military', { spread: 0.14 }),
    model94: gun('model94', 'Model 94', 'sniper', '45acp', 44, 800, 8, 2300, 'rare'),
    peacemaker: gun('peacemaker', 'Peacemaker', 'revolver', '45acp', 34, 300, 6, 2600, 'rare'),
    deagle50: gun('deagle50', 'DEagle 50', 'pistol', '50ae', 60, 500, 7, 2200, 'military', { spread: 0.025, bulletSpeed: 50, range: 3600 }),
    awms: gun('awms', 'AWM-S', 'sniper', '308', 96, 1200, 5, 3200, 'military', { spread: 0.006, bulletSpeed: 64, range: 5000 }),
    mk20ssr: gun('mk20ssr', 'Mk 20 SSR', 'dmr', '308', 60, 350, 10, 2800, 'military', { bulletSpeed: 58, range: 4400 }),
    m79: gun('m79', 'M79', 'shotgun', '40mm', 85, 1500, 1, 3000, 'military', { pellets: 1, spread: 0.02, bulletSpeed: 30, range: 2600 }),
    flaregun: gun('flaregun', 'Flare Gun', 'pistol', 'flare', 35, 900, 1, 1800, 'military', { bulletSpeed: 32, range: 2500 }),
    potatocannon: gun('potatocannon', 'Potato Cannon', 'shotgun', 'potato', 55, 750, 4, 2800, 'military', { pellets: 1, spread: 0.04, bulletSpeed: 35, range: 2700 }),
    spudgun: gun('spudgun', 'Spud Gun', 'smg', 'potato', 12, 85, 30, 2200, 'rare', { bulletSpeed: 34 }),
    heartcannon: gun('heartcannon', 'Heart Cannon', 'dmr', 'heart', 42, 300, 10, 2500, 'military', { bulletSpeed: 48 }),
    rainbowblaster: gun('rainbowblaster', 'Rainbow Blaster', 'assault', 'heart', 15, 75, 30, 2300, 'military', { bulletSpeed: 46 }),
    bugle: gun('bugle', 'Bugle', 'pistol', 'bugle', 10, 500, 5, 1800, 'rare', { spread: 0.09, bulletSpeed: 36 }),

    dualm9: gun('dualm9', 'Dual M9', 'pistol', '9mm', 12, 150, 30, 2600, 'rare', { spread: 0.085, automatic: true }),
    dualm93r: gun('dualm93r', 'Dual M93R', 'pistol', '9mm', 11, 48, 40, 3000, 'military', { spread: 0.15, automatic: true }),
    dualg18c: gun('dualg18c', 'Dual G18C', 'pistol', '9mm', 8, 34, 34, 2900, 'military', { spread: 0.24, automatic: true }),
    dualp30l: gun('dualp30l', 'Dual P30L', 'pistol', '9mm', 18, 120, 30, 2800, 'military', { spread: 0.09, automatic: true }),
    dualot38: gun('dualot38', 'Dual OT-38', 'revolver', '762', 26, 240, 10, 3400, 'rare', { spread: 0.075, automatic: true }),
    dualots38: gun('dualots38', 'Dual OTs-38', 'revolver', '762', 29, 240, 10, 3400, 'military', { spread: 0.06, automatic: true }),
    dualpeacemaker: gun('dualpeacemaker', 'Dual Peacemaker', 'revolver', '45acp', 34, 180, 12, 3600, 'military', { spread: 0.08, automatic: true }),
    dualm1911: gun('dualm1911', 'Dual M1911', 'pistol', '45acp', 14, 135, 14, 3100, 'rare', { spread: 0.1, automatic: true }),
    dualdeagle50: gun('dualdeagle50', 'Dual DEagle 50', 'pistol', '50ae', 60, 300, 14, 3700, 'military', { spread: 0.07, automatic: true, bulletSpeed: 50, range: 3600 }),
};

export const SURVIV_FIREARM_IDS = Object.freeze(Object.keys(FIREARMS));

// The standard Arenifi Surviv roster. Event and compatibility definitions
// remain valid for old sessions, but normal map/chest generation must only use
// the readable core set presented in the loadout reference.
export const SURVIV_STANDARD_FIREARM_IDS = Object.freeze([
    'm9', 'ot38', 'mac10', 'mp5',
    'm870', 'mp220', 'ak47', 'm416',
    'famas', 'vss', 'mosin', 'awms',
    'dp28', 'm249', 'm4a1s', 'dualm9',
]);

export const SURVIV_WEAPONS = Object.freeze({
    fists: Object.freeze({
        id: 'fists', label: 'Fists', family: 'melee', rarity: 'common', damage: 18,
        fireRateMs: 430, melee: true, meleeReach: 58, meleeArc: 0.95,
        clipSize: 0, reloadMs: 0, spread: 0, bulletSpeed: 0, pellets: 0, automatic: false,
    }),
    knife: Object.freeze({
        id: 'knife', label: 'Combat Knife', family: 'melee', rarity: 'rare', damage: 34,
        fireRateMs: 340, melee: true, meleeReach: 76, meleeArc: 0.78,
        clipSize: 0, reloadMs: 0, spread: 0, bulletSpeed: 0, pellets: 0, automatic: false,
    }),
    ...FIREARMS,
    // Legacy ids remain valid for old sessions and tests, but never enter the
    // new loot pools.
    pistol: gun('pistol', 'M9', 'pistol', '9mm', 12, 120, 15, 1400, 'common', { spread: 0.06, bulletSpeed: 34, range: 2500 }),
    revolver: gun('revolver', 'OT-38', 'revolver', '762', 18, 520, 6, 1500, 'common', { spread: 0.035, bulletSpeed: 44, range: 3200 }),
    smg: gun('smg', 'MP5', 'smg', '9mm', 7, 90, 30, 1800, 'common', { spread: 0.14, bulletSpeed: 38, range: 2800, firingMoveMultiplier: 0.78 }),
    shotgun: gun('shotgun', 'M870', 'shotgun', '12g', 5, 750, 6, 2200, 'rare', { spread: 0.32, bulletSpeed: 30, range: 2200, pellets: 5 }),
    assault: gun('assault', 'M416', 'assault', '556', 11, 75, 30, 2000, 'rare', { spread: 0.09, bulletSpeed: 42, range: 3100, firingMoveMultiplier: 0.74 }),
    dmr: gun('dmr', 'M39 EMR', 'dmr', '762', 24, 360, 10, 1900, 'rare', { spread: 0.025, bulletSpeed: 48, range: 3500 }),
    sniper: gun('sniper', 'Mosin-Nagant', 'sniper', '762', 48, 950, 5, 2400, 'military', { spread: 0.012, bulletSpeed: 58, range: 4200 }),
    lmg: gun('lmg', 'M249', 'lmg', '556', 10, 105, 100, 2600, 'military', { spread: 0.13, bulletSpeed: 40, range: 3200, firingMoveMultiplier: 0.66 }),
});
