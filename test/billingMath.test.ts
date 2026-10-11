import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Currency, TenantPlan } from '../src/constants/models.ts';
import {
  bestDiscount,
  commission,
  DAY,
  discounted,
  money,
  monthlyCharge,
  ratio,
  validateEffectiveMonth,
} from '../src/billing/math.ts';
import type { Discount, Rates } from '../src/billing/math.ts';
import { verifiedBillingUpdate } from '../src/billing/paynowSignature.ts';
import { createHash } from 'node:crypto';

const rates: Rates = {
  currency: Currency.USD,
  setupFee: money(5000),
  monthlyFee: money(3100),
  commissionBps: 250,
  commissionFixed: money(30),
};
const date = (s: string) => new Date(s);
const start = date('2026-10-01');
const end = date('2026-11-01');
const signup = date('2026-08-01');
const waiver = (overrides: Partial<Discount> = {}): Discount => ({
  charge: 'monthly',
  discountBps: 5000,
  startsAt: start,
  endsAt: end,
  reason: 'Launch promotion',
  ...overrides,
});
describe('billing business rules', () => {
  it('uses integer cents and rounds half-cent commissions once before adding the fixed fee', () => {
    assert.equal(commission(100, rates), 33);
    assert.equal(commission(12345, rates), 339);
    assert.equal(ratio(1, 5000, 10_000), 1);
    assert.throws(() => money(0.1));
    assert.throws(() => money(Number.MAX_SAFE_INTEGER + 1));
  });
  it('prorates the first paid calendar month after exactly thirty days', () => {
    const live = date('2026-09-15');
    const trialEnd = new Date(live.getTime() + 30 * DAY);
    assert.equal(trialEnd.toISOString(), '2026-10-15T00:00:00.000Z');
    assert.equal(monthlyCharge(start, end, trialEnd, rates, [], TenantPlan.FREE, signup), 1700);
    assert.equal(
      monthlyCharge(date('2026-09-01'), start, trialEnd, rates, [], TenantPlan.FREE, signup),
      0,
    );
    assert.equal(
      monthlyCharge(start, end, date('2026-10-15T12:00:00Z'), rates, [], TenantPlan.FREE, signup),
      1650,
    );
  });
  it('handles February, leap years and running partial-month estimates', () => {
    const febRates = { ...rates, monthlyFee: money(2900) };
    assert.equal(
      monthlyCharge(
        date('2028-02-01'),
        date('2028-03-01'),
        date('2028-02-15'),
        febRates,
        [],
        TenantPlan.FREE,
        signup,
      ),
      1500,
    );
    assert.equal(
      monthlyCharge(start, date('2026-10-10'), signup, rates, [], TenantPlan.FREE, signup),
      900,
    );
  });
  it('does not stack a vendor waiver with a larger promo', () => {
    const discounts = [waiver({ discountBps: 2000 }), waiver({ discountBps: 5000 })];
    assert.equal(bestDiscount(discounts, 'monthly', start, TenantPlan.FREE, signup), 5000);
    assert.equal(
      monthlyCharge(start, end, signup, rates, discounts, TenantPlan.FREE, signup),
      1550,
    );
    assert.equal(discounted(3100, 10000), 0);
  });
  it('respects charge, plan, signup and half-open date eligibility', () => {
    const promo = waiver({
      plan: TenantPlan.PRO,
      signupFrom: date('2026-08-01'),
      signupTo: date('2026-09-01'),
    });
    assert.equal(bestDiscount([promo], 'monthly', start, TenantPlan.PRO, signup), 5000);
    assert.equal(bestDiscount([promo], 'commission', start, TenantPlan.PRO, signup), 0);
    assert.equal(bestDiscount([promo], 'monthly', start, TenantPlan.FREE, signup), 0);
    assert.equal(bestDiscount([promo], 'monthly', end, TenantPlan.PRO, signup), 0);
    assert.equal(bestDiscount([promo], 'monthly', start, TenantPlan.PRO, date('2026-09-01')), 0);
  });
  it('only waives the days in the defined interval', () => {
    const discounts = [
      waiver({ discountBps: 10000, startsAt: date('2026-10-10'), endsAt: date('2026-10-20') }),
    ];
    assert.equal(
      monthlyCharge(start, end, signup, rates, discounts, TenantPlan.FREE, signup),
      2100,
    );
  });
  it('requires a future first-of-month with at least thirty days notice', () => {
    const now = date('2026-10-11T12:00:00Z');
    assert.throws(() => validateEffectiveMonth(date('2026-10-01'), now));
    assert.throws(() => validateEffectiveMonth(date('2026-11-01'), now));
    assert.throws(() => validateEffectiveMonth(date('2026-12-02'), now));
    assert.doesNotThrow(() => validateEffectiveMonth(date('2026-12-01'), now));
  });
});
const signed = (fields: Record<string, string>, key = 'TEST-KEY'): string => {
  const hash = createHash('sha512')
    .update(Object.values(fields).join('') + key.toLowerCase())
    .digest('hex')
    .toUpperCase();
  return new URLSearchParams({ ...fields, hash }).toString();
};
describe('platform Paynow signature boundary', () => {
  const fields = {
    reference: 'billing-attempt',
    amount: '12.34',
    pollurl: 'https://paynow.co.zw/poll/1',
    status: 'Paid',
  };
  it('verifies a signed callback and converts the exact amount to cents', () => {
    const update = verifiedBillingUpdate(signed(fields), '123', 'TEST-KEY');
    assert.equal(update.amountMinor, 1234);
    assert.equal(update.reference, 'billing-attempt');
  });
  it('rejects a forged signature, altered amount and a vendor integration key', () => {
    assert.throws(() =>
      verifiedBillingUpdate('reference=x&amount=12.34&status=Paid&hash=forged', '123', 'TEST-KEY'),
    );
    assert.throws(() =>
      verifiedBillingUpdate(signed(fields).replace('12.34', '99.99'), '123', 'TEST-KEY'),
    );
    assert.throws(() => verifiedBillingUpdate(signed(fields), '123', 'VENDOR-KEY'));
  });
  it('rejects signed missing, negative, fractional-cent and unsafe amounts', () => {
    for (const amount of ['', '-1', '1.001', '1e2', '9007199254740993']) {
      assert.throws(() => verifiedBillingUpdate(signed({ ...fields, amount }), '123', 'TEST-KEY'));
    }
  });
});
