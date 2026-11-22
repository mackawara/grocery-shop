import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateSource, RateVersionStatus } from '../src/constants/billing.ts';
import { Currency } from '../src/constants/models.ts';
import {
  DEFAULT_SCHEDULE_POLICY,
  checkCancelVersion,
  checkScheduleVersion,
  diffRates,
  resolveEffectiveRates,
  upcomingRateChanges,
  versionInEffect,
  versionStatus,
} from '../src/billing/rates.ts';
import type { ScheduleCheck } from '../src/billing/rates.ts';
import type { Money, PartialRateCard, RateCard, RateVersion } from '../src/billing/types.ts';

const usd = (amount: number): Money => ({ amount, currency: Currency.USD });

const card = (setup: number, monthly: number, bps: number, perOrder: number): RateCard => ({
  setupFee: usd(setup),
  monthlyFee: usd(monthly),
  commissionBps: bps,
  commissionFixedFee: usd(perOrder),
});

const version = (
  id: string,
  effectiveFrom: string,
  rates: PartialRateCard,
  cancelled = false,
): RateVersion => ({ id, effectiveFrom, cancelled, rates });

// 12:00 on 22 November 2026 in Harare. The current billing month is 2026-11;
// 2026-12 starts in 8.5 days, 2027-01 in 39.5 days, 2027-02 in 70.5 days.
const NOW = new Date('2026-11-22T10:00:00Z');

const violationOf = (check: ScheduleCheck) => {
  assert.equal(check.ok, false, 'expected the change to be refused');
  return check.ok ? undefined : check.violation;
};

const changesOf = (check: ScheduleCheck) => {
  assert.equal(check.ok, true, `expected the change to be allowed: ${JSON.stringify(check)}`);
  return check.ok ? check.changes : [];
};

const NOVEMBER_CARD = card(5000, 2000, 300, 25);

describe('rate resolution', () => {
  it('applies the latest uncancelled version starting in or before the month', () => {
    const timeline = [
      version('sep', '2026-09', card(1, 1, 1, 1)),
      version('nov', '2026-11', card(2, 2, 2, 2)),
      version('dec', '2026-12', card(3, 3, 3, 3), true),
      version('jan', '2027-01', card(4, 4, 4, 4)),
    ];
    assert.equal(versionInEffect(timeline, '2026-08'), undefined);
    assert.equal(versionInEffect(timeline, '2026-10')?.id, 'sep');
    assert.equal(versionInEffect(timeline, '2026-12')?.id, 'nov', 'cancelled versions never apply');
    assert.equal(versionInEffect(timeline, '2027-06')?.id, 'jan');
  });

  it('takes each field from the override when it sets one, else from the plan', () => {
    const plan = [version('plan', '2026-11', NOVEMBER_CARD)];
    const overrides = [version('ovr', '2026-11', { commissionBps: 150, monthlyFee: usd(0) })];
    const effective = resolveEffectiveRates('2026-11', plan, overrides);

    assert.deepEqual(effective.rates, {
      setupFee: usd(5000),
      monthlyFee: usd(0),
      commissionBps: 150,
      commissionFixedFee: usd(25),
    });
    assert.deepEqual(effective.sources, {
      setupFee: RateSource.PLAN,
      monthlyFee: RateSource.OVERRIDE,
      commissionBps: RateSource.OVERRIDE,
      commissionFixedFee: RateSource.PLAN,
    });
    assert.deepEqual(effective.missing, []);
    assert.equal(effective.planVersionId, 'plan');
    assert.equal(effective.overrideVersionId, 'ovr');
  });

  it('returns a vendor to plan pricing with an override version that sets nothing', () => {
    const plan = [version('plan', '2026-11', NOVEMBER_CARD)];
    const overrides = [
      version('discount', '2026-11', { monthlyFee: usd(0) }),
      version('back-to-plan', '2027-01', {}),
    ];
    assert.equal(resolveEffectiveRates('2026-12', plan, overrides).rates.monthlyFee?.amount, 0);
    assert.deepEqual(resolveEffectiveRates('2027-01', plan, overrides).rates, NOVEMBER_CARD);
  });

  it('reports fields that neither the plan nor an override prices', () => {
    const effective = resolveEffectiveRates(
      '2026-11',
      [],
      [version('ovr', '2026-10', { monthlyFee: usd(1000) })],
    );
    assert.deepEqual(effective.missing, ['setupFee', 'commissionBps', 'commissionFixedFee']);
    assert.equal(effective.planVersionId, undefined);
  });

  it('compares rates field by field', () => {
    assert.deepEqual(
      diffRates(
        { setupFee: usd(100), monthlyFee: usd(200), commissionBps: 300 },
        { setupFee: usd(150), monthlyFee: usd(100), commissionFixedFee: usd(10) },
      ),
      {
        increased: ['setupFee'],
        decreased: ['monthlyFee'],
        introduced: ['commissionFixedFee'],
        removed: ['commissionBps'],
      },
    );
  });
});

describe('scheduling a plan rate version (F2)', () => {
  const inEffect = [version('nov', '2026-11', NOVEMBER_CARD)];

  it('refuses the current and past months: never mid-month, never backdated', () => {
    for (const effectiveFrom of ['2026-11', '2026-10']) {
      const check = checkScheduleVersion({
        kind: 'plan',
        plan: inEffect,
        proposed: { effectiveFrom, rates: card(5000, 1000, 300, 25) },
        now: NOW,
      });
      assert.deepEqual(violationOf(check), {
        code: 'not_future',
        period: effectiveFrom,
        currentPeriod: '2026-11',
      });
    }
  });

  it('allows the first card for a plan from next month without increase notice', () => {
    const check = checkScheduleVersion({
      kind: 'plan',
      plan: [],
      proposed: { effectiveFrom: '2026-12', rates: NOVEMBER_CARD },
      now: NOW,
    });
    const [change] = changesOf(check);
    assert.deepEqual(change?.introduced, [
      'setupFee',
      'monthlyFee',
      'commissionBps',
      'commissionFixedFee',
    ]);
    assert.deepEqual(change?.increased, []);
  });

  it('refuses an increase with less than 30 days notice', () => {
    const check = checkScheduleVersion({
      kind: 'plan',
      plan: inEffect,
      proposed: { effectiveFrom: '2026-12', rates: card(5000, 2500, 300, 25) },
      now: NOW,
    });
    assert.deepEqual(violationOf(check), {
      code: 'insufficient_notice',
      period: '2026-12',
      direction: 'increase',
      fields: ['monthlyFee'],
      requiredDays: 30,
      noticeDays: 8,
    });
  });

  it('allows the same increase from a month that is far enough away', () => {
    const check = checkScheduleVersion({
      kind: 'plan',
      plan: inEffect,
      proposed: { effectiveFrom: '2027-01', rates: card(5000, 2500, 300, 25) },
      now: NOW,
    });
    const [change] = changesOf(check);
    assert.equal(change?.period, '2027-01');
    assert.deepEqual(change?.increased, ['monthlyFee']);
    assert.equal(change?.noticeDays, 39);
  });

  it('counts notice to the start of the month in the billing time zone, inclusive of 30 days', () => {
    // 2027-01 starts at 2026-12-31T22:00Z (midnight in Harare).
    const raise = { effectiveFrom: '2027-01', rates: card(5000, 2500, 300, 25) };
    const exactly30 = new Date('2026-12-01T22:00:00.000Z');
    assert.equal(
      checkScheduleVersion({ kind: 'plan', plan: inEffect, proposed: raise, now: exactly30 }).ok,
      true,
    );
    const justShort = new Date('2026-12-01T22:00:00.001Z');
    assert.equal(
      violationOf(
        checkScheduleVersion({ kind: 'plan', plan: inEffect, proposed: raise, now: justShort }),
      )?.code,
      'insufficient_notice',
    );
  });

  it('allows a decrease from next month (decrease notice defaults to 0)', () => {
    const check = checkScheduleVersion({
      kind: 'plan',
      plan: inEffect,
      proposed: { effectiveFrom: '2026-12', rates: card(5000, 1500, 250, 25) },
      now: NOW,
    });
    const [change] = changesOf(check);
    assert.deepEqual(change?.decreased, ['monthlyFee', 'commissionBps']);
  });

  it('applies a decrease notice period when one is configured', () => {
    const check = checkScheduleVersion({
      kind: 'plan',
      plan: inEffect,
      proposed: { effectiveFrom: '2026-12', rates: card(5000, 1500, 300, 25) },
      now: NOW,
      policy: { ...DEFAULT_SCHEDULE_POLICY, decreaseNoticeDays: 14 },
    });
    assert.equal(violationOf(check)?.code, 'insufficient_notice');
  });

  it('refuses a second live version in the same month, but not after a cancellation', () => {
    const scheduled = version('jan', '2027-01', card(5000, 2500, 300, 25));
    const proposed = { effectiveFrom: '2027-01', rates: card(5000, 2400, 300, 25) };
    assert.deepEqual(
      violationOf(
        checkScheduleVersion({ kind: 'plan', plan: [...inEffect, scheduled], proposed, now: NOW }),
      ),
      { code: 'period_taken', period: '2027-01', versionId: 'jan' },
    );
    const withdrawn = { ...scheduled, cancelled: true };
    assert.equal(
      checkScheduleVersion({ kind: 'plan', plan: [...inEffect, withdrawn], proposed, now: NOW }).ok,
      true,
    );
  });

  it('judges an inserted version only on the months it changes', () => {
    // A temporary December discount ahead of an already-announced February
    // price: February's price is unchanged by the insert, so it needs no new
    // notice even though the December→February step is now a rise.
    const timeline = [...inEffect, version('feb', '2027-02', NOVEMBER_CARD)];
    const check = checkScheduleVersion({
      kind: 'plan',
      plan: timeline,
      proposed: { effectiveFrom: '2026-12', rates: card(5000, 1000, 300, 25) },
      now: NOW,
    });
    assert.deepEqual(
      changesOf(check).map((c) => c.period),
      ['2026-12'],
    );
  });
});

describe('cancelling a plan rate version', () => {
  const inEffect = version('nov', '2026-11', NOVEMBER_CARD);

  it('refuses versions that already took effect', () => {
    for (const target of [inEffect, version('oct', '2026-10', NOVEMBER_CARD)]) {
      const check = checkCancelVersion({ kind: 'plan', plan: [target], target, now: NOW });
      assert.equal(violationOf(check)?.code, 'in_effect');
    }
  });

  it('refuses a version that is already cancelled', () => {
    const target = version('dec', '2026-12', NOVEMBER_CARD, true);
    const check = checkCancelVersion({ kind: 'plan', plan: [inEffect, target], target, now: NOW });
    assert.equal(violationOf(check)?.code, 'already_cancelled');
  });

  it('withdraws a scheduled increase at any time before it starts', () => {
    const target = version('dec', '2026-12', card(5000, 2500, 300, 25));
    const check = checkCancelVersion({ kind: 'plan', plan: [inEffect, target], target, now: NOW });
    assert.deepEqual(changesOf(check)[0]?.decreased, ['monthlyFee']);
  });

  it('treats withdrawing an announced decrease as an increase that needs notice', () => {
    const decrease = version('dec', '2026-12', card(5000, 1000, 300, 25));
    const late = checkCancelVersion({
      kind: 'plan',
      plan: [inEffect, decrease],
      target: decrease,
      now: NOW,
    });
    assert.deepEqual(violationOf(late), {
      code: 'insufficient_notice',
      period: '2026-12',
      direction: 'increase',
      fields: ['monthlyFee'],
      requiredDays: 30,
      noticeDays: 8,
    });

    const farDecrease = version('feb', '2027-02', card(5000, 1000, 300, 25));
    const early = checkCancelVersion({
      kind: 'plan',
      plan: [inEffect, farDecrease],
      target: farDecrease,
      now: NOW,
    });
    assert.equal(early.ok, true);
  });
});

describe('scheduling a vendor rate override', () => {
  const plan = [version('plan-nov', '2026-11', NOVEMBER_CARD)];

  it('allows a discount for the vendor from next month', () => {
    const check = checkScheduleVersion({
      kind: 'override',
      plan,
      overrides: [],
      proposed: { effectiveFrom: '2026-12', rates: { monthlyFee: usd(0) } },
      now: NOW,
    });
    assert.deepEqual(changesOf(check)[0]?.decreased, ['monthlyFee']);
  });

  it('treats ending a discount as an increase on the effective rate', () => {
    const overrides = [version('discount', '2026-11', { monthlyFee: usd(1000) })];
    const backToPlan = (effectiveFrom: string) =>
      checkScheduleVersion({
        kind: 'override',
        plan,
        overrides,
        proposed: { effectiveFrom, rates: {} },
        now: NOW,
      });
    assert.equal(violationOf(backToPlan('2026-12'))?.code, 'insufficient_notice');
    assert.deepEqual(changesOf(backToPlan('2027-01'))[0]?.increased, ['monthlyFee']);
  });

  it('judges a vendor change against the plan price in force in each month it spans', () => {
    // It is 23:00 on 31 January in Harare. The vendor's monthly fee is pinned
    // at $10; the plan is $8 now and goes to $15 in March. Returning the vendor
    // to plan pricing from February lowers February ($10 → $8) but raises March
    // ($10 → $15), and March starts in 28 days — too soon for an increase.
    const lateJanuary = new Date('2027-01-31T21:00:00Z');
    const planTimeline = [
      version('plan-jan', '2027-01', card(5000, 800, 300, 25)),
      version('plan-mar', '2027-03', card(5000, 1500, 300, 25)),
    ];
    const check = checkScheduleVersion({
      kind: 'override',
      plan: planTimeline,
      overrides: [version('pinned', '2027-01', { monthlyFee: usd(1000) })],
      proposed: { effectiveFrom: '2027-02', rates: {} },
      now: lateJanuary,
    });
    assert.deepEqual(violationOf(check), {
      code: 'insufficient_notice',
      period: '2027-03',
      direction: 'increase',
      fields: ['monthlyFee'],
      requiredDays: 30,
      noticeDays: 28,
    });
  });

  it('compares against what the vendor would otherwise pay that month', () => {
    const planTimeline = [...plan, version('plan-dec', '2026-12', card(5000, 9900, 300, 25))];
    const check = checkScheduleVersion({
      kind: 'override',
      plan: planTimeline,
      overrides: [],
      proposed: { effectiveFrom: '2026-12', rates: { monthlyFee: usd(2000) } },
      now: NOW,
    });
    // Without the override the vendor would pay the plan's new $99 in
    // December; with it they keep paying $20. That's a decrease, not a rise.
    assert.deepEqual(changesOf(check)[0]?.decreased, ['monthlyFee']);
  });
});

describe('rate presentation', () => {
  it('derives each version status from the current month', () => {
    const timeline = [
      version('oct', '2026-10', NOVEMBER_CARD),
      version('nov', '2026-11', NOVEMBER_CARD),
      version('dec', '2026-12', NOVEMBER_CARD),
      version('jan', '2027-01', NOVEMBER_CARD, true),
    ];
    const statuses = timeline.map((v) => versionStatus(v, timeline, '2026-11'));
    assert.deepEqual(statuses, [
      RateVersionStatus.SUPERSEDED,
      RateVersionStatus.IN_EFFECT,
      RateVersionStatus.SCHEDULED,
      RateVersionStatus.CANCELLED,
    ]);
  });

  it('lists only the upcoming months in which the effective rates change', () => {
    const plan = [
      version('plan-nov', '2026-11', NOVEMBER_CARD),
      version('plan-jan', '2027-01', card(5000, 2500, 300, 25)),
      // Changes only the monthly fee, which the vendor overrides from February.
      version('plan-mar', '2027-03', card(5000, 9900, 300, 25)),
    ];
    const overrides = [version('ovr-feb', '2027-02', { monthlyFee: usd(1000) })];
    const upcoming = upcomingRateChanges('2026-11', plan, overrides);
    assert.deepEqual(
      upcoming.map((u) => [u.period, u.rates.monthlyFee?.amount, u.sources.monthlyFee]),
      [
        ['2027-01', 2500, RateSource.PLAN],
        ['2027-02', 1000, RateSource.OVERRIDE],
      ],
    );
  });
});
