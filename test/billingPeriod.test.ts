import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addMonths,
  comparePeriods,
  isBillingPeriod,
  periodOf,
  periodStart,
} from '../src/billing/period.ts';

const HARARE = 'Africa/Harare';

describe('billing periods', () => {
  it('accepts only YYYY-MM months', () => {
    for (const valid of ['2026-01', '2026-12', '1999-07']) {
      assert.equal(isBillingPeriod(valid), true, valid);
    }
    for (const invalid of ['2026-13', '2026-00', '2026-1', '26-01', '2026-01-01', '', 202601]) {
      assert.equal(isBillingPeriod(invalid), false, String(invalid));
    }
    assert.equal(isBillingPeriod(undefined), false);
  });

  it('adds months across year boundaries', () => {
    assert.equal(addMonths('2026-11', 1), '2026-12');
    assert.equal(addMonths('2026-12', 1), '2027-01');
    assert.equal(addMonths('2027-01', -1), '2026-12');
    assert.equal(addMonths('2026-05', 24), '2028-05');
  });

  it('orders periods chronologically', () => {
    assert.ok(comparePeriods('2026-09', '2026-10') < 0);
    assert.ok(comparePeriods('2027-01', '2026-12') > 0);
    assert.equal(comparePeriods('2026-10', '2026-10'), 0);
  });

  it("puts an instant in the billing time zone's month, not UTC's", () => {
    // 23:30 UTC on 30 November is already 01:30 on 1 December in Harare.
    const lateNight = new Date('2026-11-30T23:30:00Z');
    assert.equal(periodOf(lateNight, HARARE), '2026-12');
    assert.equal(periodOf(lateNight, 'UTC'), '2026-11');
    assert.equal(periodOf(new Date('2026-11-30T21:59:59.999Z'), HARARE), '2026-11');
    assert.equal(periodOf(new Date('2026-11-30T22:00:00.000Z'), HARARE), '2026-12');
  });

  it('starts a month at local midnight on the 1st', () => {
    assert.equal(periodStart('2026-12', HARARE).toISOString(), '2026-11-30T22:00:00.000Z');
    assert.equal(periodStart('2027-01', 'UTC').toISOString(), '2027-01-01T00:00:00.000Z');
  });

  it('follows daylight saving in zones that have it', () => {
    assert.equal(
      periodStart('2026-01', 'America/New_York').toISOString(),
      '2026-01-01T05:00:00.000Z',
    );
    assert.equal(
      periodStart('2026-07', 'America/New_York').toISOString(),
      '2026-07-01T04:00:00.000Z',
    );
  });

  it('rejects malformed periods and unknown time zones', () => {
    assert.throws(() => periodStart('2026-13', HARARE), RangeError);
    assert.throws(() => periodOf(new Date(), 'Not/A_Zone'), RangeError);
  });
});
