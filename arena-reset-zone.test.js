import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAgarResetZone, getArenaResetZone, isResetZoneLethal, RESET_ZONE_DURATION_MS } from './arena-reset-zone.js';
import { createSurvivPlayer, getSurvivZone, processSurvivRoom } from './surviv-engine.js';
import { createSegments, getCompetitiveZone, processCompetitiveSlitherRoom, processSlitherRoom } from './slither-engine.js';
import { directionalWarnings } from './directional-warnings.js';
const io={to:()=>({emit(){}})};
test('normal reset zone starts ten minutes before reset and is fully lethal before maintenance',()=>{
    const reset=2000000;
    const start=getArenaResetZone(reset,reset-RESET_ZONE_DURATION_MS,{radius:500});
    assert.equal(start.radius,500); assert.equal(start.progress,0);
    const midway=getArenaResetZone(reset,reset-300000,{radius:500});
    assert.ok(midway.radius>240&&midway.radius<260);
    const closed=getArenaResetZone(reset,reset-1000,{radius:500});
    assert.equal(closed.radius,0); assert.equal(closed.fullyClosed,true);
    assert.equal(isResetZoneLethal({},0,0,closed,reset-1000),true);
    assert.equal(isResetZoneLethal({cashoutSettling:true},0,0,closed,reset),false);
});
test('out-of-zone grace resets after returning and never defeats an already reserved settlement',()=>{
    const e={},zone={progress:.5,cx:0,cy:0,radius:100};
    assert.equal(isResetZoneLethal(e,200,0,zone,1000),false);
    assert.equal(isResetZoneLethal(e,200,0,zone,3999),false);
    assert.equal(isResetZoneLethal(e,200,0,zone,4000),true);
    assert.equal(isResetZoneLethal(e,0,0,zone,4100),false);
    assert.equal(isResetZoneLethal(e,200,0,zone,4200),false);
});
test('Agar final zone removes all split cells once and conserves their real funded dollars',()=>{
    const p={id:'p',mode:'agar',dollarBalance:12,cells:[{x:0,y:0,balance:2},{x:50,y:0,balance:3}]};
    const settling={...p,id:'settling',cashoutSettling:true,cells:[{x:0,y:0,balance:1}]};
    const r={players:[p,settling],bots:[],foodPoolBalance:2}; let deaths=0;
    const z=getArenaResetZone(2000000,2000000,{radius:500});
    applyAgarResetZone(r,z,2000000,()=>deaths++); applyAgarResetZone(r,z,2000000,()=>deaths++);
    assert.equal(r.foodPoolBalance,14); assert.equal(p.dollarBalance,0); assert.equal(deaths,1);
    assert.deepEqual(r.players,[settling]);
});
test('Surviv final zone kills even the exact centre while Battle Royale keeps its own match zone',t=>{
    const now=2000000;t.mock.method(Date,'now',()=>now);
    const r={id:'z',entryFeeUsd:5,players:[],bots:[],loot:[],obstacles:[],bullets:[],spectators:[],spawnPoints:[{x:0,y:0}]};
    const p=createSurvivPlayer('p','u','P','#fff',r);p.x=0;p.y=0;r.players.push(p);
    assert.equal(getSurvivZone(now,now).radius,0);
    processSurvivRoom(r,io,now); assert.equal(p._eliminated,true);
    const br={...r,isBattleRoyale:true,players:[],zone:{x:0,y:0,radius:500,damagePerSecond:0}};
    const alive=createSurvivPlayer('br','b','B','#fff',br);br.players.push(alive);
    processSurvivRoom(br,io,now); assert.equal(alive.hp,100);
});
for(const competitive of [false,true]) test(`${competitive?'competitive':'normal'} Slither final circle kills a central snake through its normal elimination path`,t=>{
    const now=2000000;t.mock.method(Date,'now',()=>now);
    const snake={id:'s',mode:competitive?'competitive-slither':'slither',username:'S',isBot:false,personalFreePlay:true,
        balance:2,dollarBalance:2,entryFeeUsd:5,x:0,y:0,angle:0,inputDx:1,inputDy:0,segments:createSegments(0,0,2,0)};
    const r={id:'s-room',entryFeeUsd:5,resetAt:now,players:[snake],slitherBots:[],slitherFood:[],spectators:[],foodPoolBalance:0,aiBudgetBalance:0};
    if(competitive) { assert.equal(getCompetitiveZone(now).fullyClosed,true);processCompetitiveSlitherRoom(r,io,null,null,now); }
    else processSlitherRoom(r,io,null);
    assert.equal(r.players.length,0);
    assert.ok(r.slitherFood.length>0,'the existing death-loot path is retained');
});
test('direction warnings disclose only coarse angular sectors, no identities, ranges or exact positions',()=>{
    const warnings=directionalWarnings({id:'me',x:0,y:0},[{id:'me',x:1,y:0},{id:'enemy',x:1000,y:20},{id:'other',x:1005,y:15},{id:'far',x:9000,y:0}]);
    assert.deepEqual(warnings,[{angle:0,strength:.85}]);
});

test('late normal Surviv joins spawn on safe land inside the current circle, and fail closed after closure',t=>{
    const now=2000000;t.mock.method(Date,'now',()=>now);
    const r={id:'late',entryFeeUsd:5,resetAt:now+120000,players:[],bots:[],loot:[],obstacles:[],spawnPoints:[{x:9000,y:9000}]};
    const z=getSurvivZone(r.resetAt,now);
    for(let i=0;i<10;i++) {
        const p=createSurvivPlayer(`p${i}`,'u','P','#fff',r);
        assert.ok(Math.hypot(p.x,p.y)<z.radius-80);
    }
    r.resetAt=now;
    assert.throws(()=>createSurvivPlayer('closed','u','P','#fff',r),/No safe spawn/);
});
