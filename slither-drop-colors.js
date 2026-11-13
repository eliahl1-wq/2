const palettes = {
    onyx: ['#121118','#34263f','#15121e','#382744'],
    sorbet: ['#ae82ba','#db9db9','#f0b09a','#f2d18e'],
    aurora: ['#31206f','#236bb5','#26d8d0','#91ffd2','#a372ff'],
    eclipse: ['#07080d','#ff8738','#ffe295','#ff7a32','#a91f35'],
    leviathan: ['#216c75','#49a69a','#f0cc7b'],
    random: ['#c080ff','#9099ff','#80d0d0','#80ff80','#eeee70','#ffa060','#ff9050','#ff4040','#e030e0'],
};
const flags = {
    se:['#006aa7','#fecc02'],us:['#b22234','#ffffff','#3c3b6e'],gb:['#012169','#ffffff','#c8102e'],
    de:['#171717','#dd0000','#ffce00'],fr:['#0055a4','#ffffff','#ef4135'],es:['#aa151b','#f1bf00'],it:['#009246','#ffffff','#ce2b37'],
    br:['#009c3b','#ffdf00','#002776'],ca:['#d80621','#ffffff'],jp:['#ffffff','#bc002d'],no:['#ba0c2f','#ffffff','#00205b'],fi:['#ffffff','#003580'],dk:['#c8102e','#ffffff'],nl:['#ae1c28','#ffffff','#21468b'],pl:['#ffffff','#dc143c'],ua:['#0057b7','#ffd700'],
};
export function slitherDropTint(value, progress = 0, index = 0) {
    const selected = typeof value === 'object' && value ? value.fill : value;
    const raw = selected === 'tide' ? 'onyx' : selected;
    if (typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw)) return raw;
    const palette = flags[String(raw).replace('flag:','')] || palettes[raw];
    if (!palette) return '#c080ff';
    if (raw === 'onyx' || raw === 'sorbet') {
        const p=Math.max(0,Math.min(1,progress))*(palette.length-1), n=Math.min(palette.length-2,Math.floor(p)), t=p-n;
        return '#'+[1,3,5].map(k=>Math.round(parseInt(palette[n].slice(k,k+2),16)*(1-t)+parseInt(palette[n+1].slice(k,k+2),16)*t).toString(16).padStart(2,'0')).join('');
    }
    return palette[Math.abs(index) % palette.length];
}
export function tintHue(hex) {
    const [r,g,b]=[1,3,5].map(k=>parseInt(hex.slice(k,k+2),16)/255), max=Math.max(r,g,b), d=max-Math.min(r,g,b);
    if (!d) return 0;
    return ((max===r?(g-b)/d:max===g?(b-r)/d+2:(r-g)/d+4)*60+360)%360;
}
