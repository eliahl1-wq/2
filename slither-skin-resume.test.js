import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSignatureSkin, applyValidatedSlitherSkin } from './signature-skins.js';
import { createSlitherPlayer, createCompetitiveSlitherPlayer, broadcastSlitherState, broadcastCompetitiveSlitherState } from './slither-engine.js';

test('admin skin selection replaces old live skin and reaches normal/arena game snapshots', async () => {
    for (const mode of ['slither','competitive-slither']) for (const skin of ['onyx','sorbet','tide']) {
        const room={players:[],bots:[],slitherBots:[],slitherFood:[],entryFeeUsd:5,startTime:Date.now()};
        const create=mode==='slither'?createSlitherPlayer:createCompetitiveSlitherPlayer;
        const player=create('admin','account','Admin','#80d0d0',room);
        room.players.push(player);
        const originalSegments=player.segments, originalBalance=player.balance;
        const color=await resolveSignatureSkin({mode,skinColor:skin,skinId:skin,hasAccess:async()=>true});
        applyValidatedSlitherSkin(player,mode,color);
        assert.equal(player.color,skin==='tide'?'onyx':skin);
        assert.equal(player.segments,originalSegments);
        assert.equal(player.balance,originalBalance);
        const messages=[];
        const io={to:()=>({emit:(event,...args)=>messages.push({event,args})})};
        const broadcast=mode==='slither'?broadcastSlitherState:broadcastCompetitiveSlitherState;
        broadcast(room,io,[],{});
        const tick=messages.find(m=>m.event==='slitherTick')?.args[0];
        assert.ok(tick,'real game broadcaster emits a snapshot');
        assert.equal(tick.snakes.find(s=>s.isYou).color,player.color);
    }
});

test('rejoining cannot bypass private access and omitted skin preserves live selection', async () => {
    const player={color:'#80d0d0'};
    await assert.rejects(async()=>{
        const color=await resolveSignatureSkin({mode:'slither',skinId:'onyx',hasAccess:async()=>false});
        applyValidatedSlitherSkin(player,'slither',color);
    },/unlocked/);
    assert.equal(player.color,'#80d0d0');
    applyValidatedSlitherSkin(player,'slither',null);
    assert.equal(player.color,'#80d0d0');
    applyValidatedSlitherSkin(player,'agar','onyx');
    assert.equal(player.color,'#80d0d0');
});
