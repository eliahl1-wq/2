import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_FREE_PLAY_ROOM_OWNER, getPublicFreePlayEntryFee } from './public-free-mode.js';

test('public free play uses one stable shared room owner', () => {
    assert.equal(PUBLIC_FREE_PLAY_ROOM_OWNER, 'public');
});

test('public free play forces the requested fixed economy tiers', () => {
    assert.equal(getPublicFreePlayEntryFee('agar'), 10);
    assert.equal(getPublicFreePlayEntryFee('slither'), 10);
    assert.equal(getPublicFreePlayEntryFee('surviv'), 5);
    assert.equal(getPublicFreePlayEntryFee('competitive-slither'), 5);
});
