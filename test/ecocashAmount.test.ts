import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateUsdOrderTotal,
  parseUsdCents,
} from '../src/controllers/payments/ecocash/amount.ts';

describe('direct EcoCash USD amounts', () => {
  it('calculates exact item and delivery components without floating point rounding', () => {
    const items = [
      { unitAmount: '0.10', currency: 'USD', quantity: 3 },
      { unitAmount: '1.99', currency: 'USD', quantity: 2 },
    ];
    const acceptedFee = { amount: '0.20', currency: 'USD' };
    const expected = { itemSubtotalCents: 428, deliveryFeeCents: 20, totalCents: 448 };
    assert.deepEqual(calculateUsdOrderTotal(items, acceptedFee), expected);
    assert.deepEqual(calculateUsdOrderTotal(items, acceptedFee), expected);
  });

  it('supports collection and a free delivery fee without allowing a zero collection', () => {
    for (const amount of ['0', '0.0', '0.00']) {
      assert.deepEqual(
        calculateUsdOrderTotal([{ unitAmount: '0.01', currency: 'USD', quantity: 1 }], {
          amount,
          currency: 'USD',
        }),
        { itemSubtotalCents: 1, deliveryFeeCents: 0, totalCents: 1 },
      );
      assert.throws(() => parseUsdCents(amount, 'USD'));
    }
  });

  it('rejects invalid precision, negative values and coercible non-decimal inputs', () => {
    for (const amount of [
      '-1',
      '1.001',
      '1.230',
      '1e2',
      'NaN',
      'Infinity',
      '',
      ' 1.00',
      '1.00 ',
      '+1',
      '.01',
      '1.',
      '01.00',
    ]) {
      assert.throws(() => parseUsdCents(amount, 'USD'), amount);
    }
    assert.equal(parseUsdCents('12', 'USD'), 1200);
    assert.equal(parseUsdCents('12.3', 'USD'), 1230);
  });

  it('rejects unsupported item and delivery currencies even when the fee is zero', () => {
    assert.throws(() => parseUsdCents('1.00', 'ZWG'));
    assert.throws(() =>
      calculateUsdOrderTotal([{ unitAmount: '1', currency: 'ZWG', quantity: 1 }], {
        amount: '0',
        currency: 'USD',
      }),
    );
    assert.throws(() =>
      calculateUsdOrderTotal([{ unitAmount: '1', currency: 'USD', quantity: 1 }], {
        amount: '0',
        currency: 'ZWG',
      }),
    );
  });

  it('rejects empty carts, fractional quantities and unsafe arithmetic', () => {
    assert.throws(() => calculateUsdOrderTotal([], { amount: '0', currency: 'USD' }));
    for (const quantity of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() =>
        calculateUsdOrderTotal([{ unitAmount: '2', currency: 'USD', quantity }], {
          amount: '0',
          currency: 'USD',
        }),
      );
    }
    assert.equal(parseUsdCents('90071992547409.91', 'USD'), Number.MAX_SAFE_INTEGER);
    assert.throws(() => parseUsdCents('90071992547409.92', 'USD'));
    assert.throws(() =>
      calculateUsdOrderTotal([{ unitAmount: '90071992547409.91', currency: 'USD', quantity: 1 }], {
        amount: '0.01',
        currency: 'USD',
      }),
    );
  });
});
