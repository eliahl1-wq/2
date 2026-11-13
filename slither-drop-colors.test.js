import test from 'node:test';
import assert from 'node:assert/strict';
import { slitherDropTint, tintHue } from './slither-drop-colors.js';
import { eliminateCompetitiveSnake } from './slither-engine.js';
import { resolveSignatureSkin } from './signature-skins.js';
import { getAgarShopProduct } from './agar-economy.js';

test('private fades require access, stay Slither-only, and cannot be bought', async () => {
    for (const skin of ['onyx','sorbet']) for (const field of ['skinId','skinColor']) {
        assert.equal(getAgarShopProduct(`slither:${skin}`), null);
        await assert.rejects(resolveSignatureSkin({mode:'slither',[field]:skin,hasAccess:async()=>false}), /unlocked/);
        for (const mode of ['slither','competitive-slither']) assert.equal(await resolveSignatureSkin({mode,[field]:skin,hasAccess:async()=>true}),skin);
        await assert.rejects(resolveSignatureSkin({mode:'agar',[field]:skin,hasAccess:async()=>true}),/only available/);
    }
});

test('death pellets retain actual palettes and conserve arena mass and money', () => {
    for (const skin of ['#c080ff','#80d0d0','onyx','sorbet','flag:ca','flag:jp','flag:se','random','aurora','eclipse']) {
        const segments=Array.from({length:20},(_,i)=>({x:i*9,y:0}));
        const snake={id:'test',isBot:true,color:skin,balance:5,dollarBalance:3,segments};
        const room={players:[snake],slitherFood:[],entryFeeUsd:5};
        eliminateCompetitiveSnake(room,snake,null,null,null);
        assert.ok(room.slitherFood.length);
        assert.ok(Math.abs(room.slitherFood.reduce((s,f)=>s+f.balance,0)-5)<1e-8);
        assert.ok(Math.abs(room.slitherFood.reduce((s,f)=>s+f.dollarValue,0)-3)<1e-8);
        room.slitherFood.forEach(f=>{ assert.match(f.tint,/^#[0-9a-f]{6}$/i); assert.ok(Number.isFinite(f.hue)); });
        if (skin.startsWith('#')) assert.ok(room.slitherFood.every(f=>f.tint===skin));
        else assert.ok(new Set(room.slitherFood.map(f=>f.tint)).size>1);
    }
    assert.ok(Math.abs(tintHue('#c080ff')-270.2362)<0.001);
    assert.equal(slitherDropTint('onyx',1),'#2e2939');
    assert.equal(slitherDropTint('flag:jp',0,0),'#ffffff');
});
