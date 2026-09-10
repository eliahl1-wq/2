import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSignatureSkin, presentSkinEntitlement, signatureEntitlementSkinIds } from './signature-skins.js';
import { SkinEntitlement, SkinPurchase } from './agar-commerce-models.js';

test('new skins enforce ownership from either payload field and remain mode-exclusive', async () => {
    for (const [id, mode] of [['farmer', 'surviv']]) {
        for (const field of ['skinId', 'skinColor']) {
            const request = { mode, [field]: id };
            await assert.rejects(resolveSignatureSkin({ ...request, hasAccess: async () => false }), /unlocked/);
            assert.equal(await resolveSignatureSkin({ ...request, hasAccess: async (requestedMode, requestedId) => requestedMode === mode && requestedId === id }), id);
            for (const otherMode of ['agar', 'slither', 'surviv'].filter(value => value !== mode)) {
                await assert.rejects(resolveSignatureSkin({ ...request, mode: otherMode, hasAccess: async () => true }), /only available/);
            }
        }
    }
    for (const id of ['prism', 'leviathan']) for (const field of ['skinId', 'skinColor']) {
        assert.equal(await resolveSignatureSkin({ mode: 'competitive-slither', [field]: id, hasAccess: async () => true }), '#c080ff');
    }
    await assert.rejects(resolveSignatureSkin({ mode: 'agar', skinId: 'prism', skinColor: 'warden' }), /Conflicting/);
    assert.equal(await resolveSignatureSkin({ mode: 'surviv', skinColor: '#80d0d0' }), null);
});

test('commerce schemas support permanent Surviv purchases and entitlements', () => {
    for (const model of [SkinEntitlement, SkinPurchase]) assert.ok(model.schema.path('gameMode').enumValues.includes('surviv'));
});

test('retired Warden ownership and selections resolve to Farmer, with ownership still required', async () => {
    const old = { gameMode: 'surviv', skinId: 'warden', productId: 'surviv:warden', createdAt: '2026-09-07' };
    assert.deepEqual(presentSkinEntitlement(old), { ...old, skinId: 'farmer', productId: 'surviv:farmer' });
    assert.equal(old.skinId, 'warden', 'historical records are not mutated');
    assert.deepEqual(signatureEntitlementSkinIds('farmer'), ['farmer', 'warden']);
    assert.equal(presentSkinEntitlement({ ...old, gameMode: 'agar' }).skinId, 'warden');
    for (const field of ['skinId', 'skinColor']) {
        assert.equal(await resolveSignatureSkin({ mode: 'surviv', [field]: 'warden', hasAccess: async (mode, id) => mode === 'surviv' && id === 'farmer' }), 'farmer');
        await assert.rejects(resolveSignatureSkin({ mode: 'surviv', [field]: 'warden', hasAccess: async () => false }), /unlocked/);
        await assert.rejects(resolveSignatureSkin({ mode: 'agar', [field]: 'warden', hasAccess: async () => true }), /only available/);
    }
    assert.equal(await resolveSignatureSkin({ mode: 'surviv', skinId: 'farmer', skinColor: 'warden', hasAccess: async () => true }), 'farmer');
});
