import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSignatureSkin } from './signature-skins.js';
import { SkinEntitlement, SkinPurchase } from './agar-commerce-models.js';

test('new skins enforce ownership from either payload field and remain mode-exclusive', async () => {
    for (const [id, mode] of [['prism', 'agar'], ['leviathan', 'slither'], ['warden', 'surviv']]) {
        for (const field of ['skinId', 'skinColor']) {
            const request = { mode, [field]: id };
            await assert.rejects(resolveSignatureSkin({ ...request, hasAccess: async () => false }), /unlocked/);
            assert.equal(await resolveSignatureSkin({ ...request, hasAccess: async (requestedMode, requestedId) => requestedMode === mode && requestedId === id }), id);
            for (const otherMode of ['agar', 'slither', 'surviv'].filter(value => value !== mode)) {
                await assert.rejects(resolveSignatureSkin({ ...request, mode: otherMode, hasAccess: async () => true }), /only available/);
            }
        }
    }
    assert.equal(await resolveSignatureSkin({ mode: 'competitive-slither', skinColor: 'leviathan', hasAccess: async () => true }), 'leviathan');
    await assert.rejects(resolveSignatureSkin({ mode: 'agar', skinId: 'prism', skinColor: 'warden' }), /Conflicting/);
    assert.equal(await resolveSignatureSkin({ mode: 'surviv', skinColor: '#80d0d0' }), null);
});

test('commerce schemas support permanent Surviv purchases and entitlements', () => {
    for (const model of [SkinEntitlement, SkinPurchase]) assert.ok(model.schema.path('gameMode').enumValues.includes('surviv'));
});
