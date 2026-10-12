import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvivMapGenerator } from './surviv-map-generation.js';

test('concurrent rooms receive distinct maps, with only one generator and one reserve', async () => {
    let active = 0, peak = 0, generated = 0;
    const generator = createSurvivMapGenerator(async () => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 8));
        active--; return { id: ++generated, obstacles: [{ hp: 100 }] };
    });
    const warm = generator.warm();
    assert.equal(generator.warm(), warm);
    const maps = await Promise.all([generator.take(), generator.take(), generator.take()]);
    assert.equal(peak, 1);
    assert.deepEqual(maps.map(map => map.id), [1, 2, 3]);
    maps[0].obstacles[0].hp = 0;
    assert.equal(maps[1].obstacles[0].hp, 100);
    await generator.warm();
    assert.equal(generated, 4, 'only one extra map is prepared');
    assert.equal((await generator.take()).id, 4);
});

test('a failed map cannot strand later joins or create an unhandled reserve rejection', async () => {
    let attempts = 0;
    const generator = createSurvivMapGenerator(async () => {
        if (++attempts === 1) throw new Error('worker failed');
        return { id: attempts };
    });
    await assert.rejects(generator.take(), /worker failed/);
    assert.equal((await generator.take()).id, 2);
});
