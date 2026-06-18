/**
 * Default slither.io snake colors (rcv/cv 0–8).
 * Extracted from the official client rrs/ggs/bbs tables.
 */
export const SLITHER_DEFAULT_COLORS = [
    '#c080ff', // 0 lavender-purple
    '#9099ff', // 1 indigo-blue
    '#80d0d0', // 2 turquoise-cyan
    '#80ff80', // 3 lime-green
    '#eeee70', // 4 tinted-yellow
    '#ffa060', // 5 orange
    '#ff9050', // 6 pink-red
    '#ff4040', // 7 dark-red
    '#e030e0', // 8 magenta
];

export function randomSlitherColor() {
    return SLITHER_DEFAULT_COLORS[Math.floor(Math.random() * SLITHER_DEFAULT_COLORS.length)];
}
