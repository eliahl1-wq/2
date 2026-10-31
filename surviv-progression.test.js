import test from 'node:test';
import assert from 'node:assert/strict';
import { fundSurvivEntry, createSurvivPlayer, eliminateSurvivPlayer, maintainSurvivLoot, pickWeaponForTier,
    processSurvivRoom, spawnLootFromPool, SURVIV, WEAPONS } from './surviv-engine.js';
import { calculateSurvivRoomValue } from './game-value-accounting.js';
import { getSurvivJoinLootFunding } from './economy.js';
const io = {to:()=>({emit(){}})};
const room = () => ({id:'progression',entryFeeUsd:5,players:[],bots:[],loot:[],obstacles:[],bullets:[],spectators:[],
    spawnPoints:[{x:0,y:0},{x:1500,y:0}],fundedEntryUsd:0});
const mapValue = r => r.loot.reduce((s,l)=>s+Math.round(Number(l.type==='money'?l.dollarValue:l.contents?.money||0)*100),0)/100 + (r.lootPoolBalance||0);
function seedRandom(t, seed=42) {
    t.mock.method(Math,'random',()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;});
}

test('a paid join allocates exactly $1 player, $1 to at most one bot, and $3 map funding',t=>{
    seedRandom(t); const r=room(),p=createSurvivPlayer('human','u','P','#fff',r);
    assert.equal(p.dollarBalance,0,'unfunded constructors never mint a stake');
    assert.deepEqual(fundSurvivEntry(r,p,5),{total:5,player:1,bot:1,map:3});
    r.players.push(p); r.fundedEntryUsd=5;
    assert.equal(r.bots.length,1); assert.equal(mapValue(r),3);
    assert.equal(calculateSurvivRoomValue(r).accountedUsd,5);
    assert.equal(fundSurvivEntry(r,p,5),null); assert.equal(r.bots.length,1);
    for(let i=0;i<10;i++) processSurvivRoom(r,io,Date.now()+600000);
    assert.equal(r.bots.length,1,'the simulation cannot silently replenish unfunded bots');
});

test('bot cap reroutes its entire dollar to the map, including practice and zero-funded admin joins',t=>{
    seedRandom(t); const r=room();
    r.bots=Array.from({length:SURVIV.botMaxCount},(_,i)=>({id:`b${i}`,hp:100,dollarBalance:0}));
    const paid=createSurvivPlayer('paid','u','P','#fff',r);
    assert.deepEqual(fundSurvivEntry(r,paid,5),{total:5,player:1,bot:0,map:4});
    const free=createSurvivPlayer('free','f','P','#fff',r);
    assert.deepEqual(fundSurvivEntry(r,free,getSurvivJoinLootFunding(5,{freePlay:true})),{total:20,player:1,bot:0,map:19});
    const before=mapValue(r),admin=createSurvivPlayer('admin','a','A','#fff',r);
    assert.deepEqual(fundSurvivEntry(r,admin,0),{total:0,player:0,bot:0,map:0});
    assert.equal(mapValue(r),before); assert.equal(r.bots.length,SURVIV.botMaxCount);
    assert.equal(createSurvivPlayer('br','br','BR','#fff',{...r,isBattleRoyale:true}).dollarBalance,0);
});

test('the starting stake drops as collectible coins exactly once on death',t=>{
    seedRandom(t); const r=room(),p=createSurvivPlayer('human','u','P','#fff',r);
    fundSurvivEntry(r,p,5); r.players.push(p); r.fundedEntryUsd=5;
    const events=[];const deathIo={to:()=>({emit:(name,data)=>events.push({name,data})})};
    const before=mapValue(r); eliminateSurvivPlayer(r,p,deathIo); eliminateSurvivPlayer(r,p,deathIo);
    assert.equal(p.dollarBalance,0); assert.equal(mapValue(r),before+1);
    assert.equal(r.loot.filter(l=>l.source==='death'&&l.type==='money').length,1);
    assert.equal(calculateSurvivRoomValue(r).accountedUsd,5);
    assert.equal(events.filter(e=>e.name==='died').length,1);
    assert.equal(events.find(e=>e.name==='died').data.balance,1,'death UI reports lost value, not the already-cleared stake');
});

test('every crate type can contain randomly assigned funded coins without changing its equipment',t=>{
    for(const containerType of ['wood_crate','supply_crate','ammo_crate','medical_crate','armory_crate','airdrop_crate']) {
        const r=room(); r.loot=[{id:'crate',type:'chest',containerType,x:100,y:0,contents:{medkits:2}}];
        t.mock.method(Math,'random',()=>.1);
        spawnLootFromPool(r,3.27);
        assert.equal(r.loot[0].contents.money,3.27,containerType);
        assert.equal(r.loot[0].contents.medkits,2);
        assert.equal(mapValue(r),3.27);
        t.mock.restoreAll();
    }
});

test('blocked currency placement retains the exact funded cents for a later safe retry',t=>{
    seedRandom(t); const r=room();
    r.obstacles=[{id:'blocked',kind:'rock',x:0,y:0,w:40000,h:40000,collidable:true}];
    spawnLootFromPool(r,4); assert.equal(r.loot.length,0); assert.equal(r.lootPoolBalance,4);
    r.obstacles=[]; spawnLootFromPool(r,0); assert.equal(mapValue(r),4); assert.equal(r.lootPoolBalance,0);
    r.loot=[]; spawnLootFromPool(r,0); assert.equal(mapValue(r),0,'collected/cashed-out dollars are never regenerated');
});

test('depleted map gear restocks slowly at original safe slots, not near players or in Battle Royale',t=>{
    seedRandom(t); const r=room();
    r.loot=Array.from({length:20},(_,i)=>({id:`c${i}`,type:'chest',source:'map',x:i*150+1000,y:2000,
        tier:'common',containerType:'wood_crate',contents:{money:1}}));
    maintainSurvivLoot(r,1000); r.loot=[];
    maintainSurvivLoot(r,20000); assert.equal(r.loot.length,0);
    r.players=[{id:'near',hp:100,x:1000,y:2000}];
    maintainSurvivLoot(r,150000); assert.equal(r.loot.length,6);
    assert.ok(r.loot.every(l=>Math.hypot(l.x-1000,l.y-2000)>=600));
    assert.equal(mapValue(r),0,'restocked crates cannot replay old embedded money');
    const count=r.loot.length; maintainSurvivLoot(r,151000); assert.equal(r.loot.length,count);
    maintainSurvivLoot(r,170000,{progress:.5}); assert.equal(r.loot.length,count);
    const br={...r,isBattleRoyale:true,loot:[]}; maintainSurvivLoot(br,300000); assert.equal(br.loot.length,0);
});

test('weighted rarity makes top weapons exceptional and premium crates better without guaranteeing gold',t=>{
    seedRandom(t); const counts={};
    for(const tier of ['common','rare','military']) {
        counts[tier]={common:0,rare:0,epic:0,legendary:0};
        for(let i=0;i<20000;i++) counts[tier][WEAPONS[pickWeaponForTier(tier)].rarity]++;
    }
    assert.ok(counts.common.common>18000); assert.ok(counts.common.legendary<60);
    assert.ok(counts.military.legendary>400 && counts.military.legendary<800);
    assert.ok(counts.military.epic>counts.rare.epic && counts.rare.epic>counts.common.epic);
});
