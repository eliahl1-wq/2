import { getAgarShopProduct, isHiddenShopSkin } from './agar-economy.js';

const MODES = Object.freeze({ prism: 'agar', leviathan: 'slither', farmer: 'surviv', onyx: 'slither', sorbet: 'slither' });
const getMode = value => typeof value === 'string' && Object.hasOwn(MODES, value) ? MODES[value] : null;

export const canonicalSignatureSkinId = value => value === 'warden' ? 'farmer' : value === 'tide' ? 'onyx' : value;

// Only pass a color which has already gone through join ownership validation.
export function applyValidatedSlitherSkin(player, mode, color) {
    if (!player || !['slither', 'competitive-slither'].includes(mode) || !color) return;
    player.color = color;
}

// Preserve purchased ownership without rewriting historical orders or requiring a DB migration.
export function presentSkinEntitlement(entry) {
    return entry.gameMode === 'surviv' && entry.skinId === 'warden'
        ? { ...entry, skinId: 'farmer', productId: 'surviv:farmer' }
        : entry;
}

export function signatureEntitlementSkinIds(skinId) {
    return canonicalSignatureSkinId(skinId) === 'farmer' ? ['farmer', 'warden'] : [skinId];
}

// Inspect the raw payload before a color whitelist can discard a paid skin.
export async function resolveSignatureSkin({ mode, skinId, skinColor, hasAccess }) {
    const requested = [skinId, skinColor].map(canonicalSignatureSkinId).filter(value => getMode(value));
    if (!requested.length) return null;
    const id = requested[0];
    if (requested.some(value => value !== id)) throw new Error('Conflicting skin selection.');
    // Saved selections from older clients fall back without deleting ownership.
    if (isHiddenShopSkin(id)) return '#c080ff';
    const gameMode = mode === 'competitive-slither' ? 'slither' : mode;
    const product = getAgarShopProduct(`${getMode(id)}:${id}`) || { gameMode: getMode(id), name: 'Private skin' };
    if (gameMode !== product.gameMode) throw new Error(`${product.name} is only available in ${product.gameMode}.`);
    if (!await hasAccess(product.gameMode, id)) throw new Error(`${product.name} must be unlocked in the shop first.`);
    return id;
}
