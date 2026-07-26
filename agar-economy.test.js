import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AGAR_SHOP_PRODUCTS,
    getAgarShopProduct,
    splitAtomicAmount,
    usdPriceToAtomic,
} from './agar-economy.js';

test('USD skin price rounds up to AGAR atomic units', () => {
    assert.equal(usdPriceToAtomic({
        usdPrice: 3,
        tokenPriceUsd: 0.2,
        decimals: 9,
    }), 15_000_000_000n);
    assert.equal(usdPriceToAtomic({
        usdPrice: 3,
        tokenPriceUsd: 7,
        decimals: 2,
    }), 43n);
});

test('90/10 AGAR split conserves every atomic unit', () => {
    const split = splitAtomicAmount(101n, 9000, 1000);
    assert.equal(split.ownerAtomic, 10n);
    assert.equal(split.treasuryAtomic, 91n);
    assert.equal(split.ownerAtomic + split.treasuryAtomic, 101n);
});

test('revenue shares must total 10000 bps', () => {
    assert.throws(() => splitAtomicAmount(100n, 8000, 1000), /10000/);
});

test('shop sells the flag bundle, Rainbow skins, AGAR, and two additional premium Slither skins', () => {
    assert.deepEqual(
        AGAR_SHOP_PRODUCTS.map(({ id, usdPrice }) => ({ id, usdPrice })),
        [
            { id: 'flags:bundle', usdPrice: 1 },
            { id: 'agar:rainbow', usdPrice: 3 },
            { id: 'slither:rainbow', usdPrice: 3 },
            { id: 'slither:agarstake', usdPrice: 1 },
            { id: 'slither:aurora', usdPrice: 2 },
            { id: 'slither:eclipse', usdPrice: 2 },
        ],
    );
    assert.equal(getAgarShopProduct('surviv:rainbow'), null);
});
