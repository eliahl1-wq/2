import { getAgarShopProduct } from './agar-economy.js';

const MODES = Object.freeze({ prism: 'agar', leviathan: 'slither', warden: 'surviv' });
const getMode = value => typeof value === 'string' && Object.hasOwn(MODES, value) ? MODES[value] : null;

// Inspect the raw payload before a color whitelist can discard a paid skin.
export async function resolveSignatureSkin({ mode, skinId, skinColor, hasAccess }) {
    const requested = [skinId, skinColor].filter(value => getMode(value));
    if (!requested.length) return null;
    const id = requested[0];
    if (requested.some(value => value !== id)) throw new Error('Conflicting skin selection.');
    const gameMode = mode === 'competitive-slither' ? 'slither' : mode;
    const product = getAgarShopProduct(`${getMode(id)}:${id}`);
    if (gameMode !== product.gameMode) throw new Error(`${product.name} is only available in ${product.gameMode}.`);
    if (!await hasAccess(product.gameMode, id)) throw new Error(`${product.name} must be unlocked in the shop first.`);
    return id;
}
