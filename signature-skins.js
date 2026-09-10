import { getAgarShopProduct } from './agar-economy.js';

const MODES = Object.freeze({ prism: 'agar', leviathan: 'slither', farmer: 'surviv' });
const getMode = value => typeof value === 'string' && Object.hasOwn(MODES, value) ? MODES[value] : null;

export const canonicalSignatureSkinId = value => value === 'warden' ? 'farmer' : value;

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
    const gameMode = mode === 'competitive-slither' ? 'slither' : mode;
    const product = getAgarShopProduct(`${getMode(id)}:${id}`);
    if (gameMode !== product.gameMode) throw new Error(`${product.name} is only available in ${product.gameMode}.`);
    if (!await hasAccess(product.gameMode, id)) throw new Error(`${product.name} must be unlocked in the shop first.`);
    return id;
}
