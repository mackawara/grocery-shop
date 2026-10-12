import type { TenantPlan } from '../constants/models.ts';
import { Currency } from '../constants/models.ts';

export interface Money {
  amount: number;
  currency: Currency;
}
export interface Rates {
  currency: Currency;
  setupFee: Money;
  monthlyFee: Money;
  commissionBps: number;
  commissionFixed: Money;
}
export type Charge = 'setup' | 'monthly' | 'commission';
export interface Discount {
  charge: Charge;
  discountBps: number;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  plan?: TenantPlan;
  signupFrom?: Date;
  signupTo?: Date;
}
export const DAY = 86_400_000;
export const money = (amount: number, currency = Currency.USD): Money => {
  if (!Number.isSafeInteger(amount)) {
    throw new Error('Money must be safe integer minor units');
  }
  return { amount, currency };
};
// BigInt avoids intermediate floating-point errors, including half-cent ties.
export const ratio = (amount: number, numerator: number, denominator: number): number => {
  if (
    ![amount, numerator, denominator].every(Number.isSafeInteger) ||
    amount < 0 ||
    numerator < 0 ||
    denominator <= 0
  ) {
    throw new Error('Invalid money ratio');
  }
  return money(
    Number(
      (BigInt(amount) * BigInt(numerator) + BigInt(Math.floor(denominator / 2))) /
        BigInt(denominator),
    ),
  ).amount;
};
export const monthStart = (at: Date): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
export const nextMonth = (at: Date): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
export const periodKey = (at: Date): string => at.toISOString().slice(0, 7);
export const bestDiscount = (
  discounts: Discount[],
  charge: Charge,
  at: Date,
  plan: TenantPlan,
  signupAt: Date,
): number =>
  discounts
    .filter(
      (d) =>
        d.charge === charge &&
        d.startsAt <= at &&
        at < d.endsAt &&
        (!d.plan || d.plan === plan) &&
        (!d.signupFrom || signupAt >= d.signupFrom) &&
        (!d.signupTo || signupAt < d.signupTo),
    )
    .reduce((best, d) => Math.max(best, d.discountBps), 0);
export const discounted = (amount: number, bps: number): number =>
  ratio(amount, 10_000 - bps, 10_000);
export const commission = (itemsMinor: number, rates: Rates): number =>
  money(ratio(itemsMinor, rates.commissionBps, 10_000) + rates.commissionFixed.amount).amount;

// A day is charged only for the portion after the trial ends; this preserves
// the exact 30 * 24h trial while prorating by calendar-month days.
export const monthlyCharge = (
  start: Date,
  end: Date,
  trialEndsAt: Date,
  rates: Rates,
  discounts: Discount[],
  plan: TenantPlan,
  signupAt: Date,
): number => {
  let weightedMilliseconds = 0;
  for (let day = start.getTime(); day < end.getTime(); day += DAY) {
    const from = Math.max(day, trialEndsAt.getTime());
    const to = Math.min(day + DAY, end.getTime());
    if (from >= to) {
      continue;
    }
    // Split at discount boundaries, so date ranges never leak into other days.
    const boundaries = [
      from,
      to,
      ...discounts.flatMap((d) => [d.startsAt.getTime(), d.endsAt.getTime()]),
    ]
      .filter((t) => t >= from && t <= to)
      .sort((a, b) => a - b);
    for (let i = 1; i < boundaries.length; i += 1) {
      const a = boundaries[i - 1];
      const b = boundaries[i];
      weightedMilliseconds +=
        (b - a) * (10_000 - bestDiscount(discounts, 'monthly', new Date(a), plan, signupAt));
    }
  }
  return ratio(
    rates.monthlyFee.amount,
    weightedMilliseconds,
    (nextMonth(start).getTime() - monthStart(start).getTime()) * 10_000,
  );
};
export const validateEffectiveMonth = (at: Date, now: Date): void => {
  if (
    !Number.isFinite(at.getTime()) ||
    at.getTime() <= now.getTime() ||
    at.getTime() !== monthStart(at).getTime()
  ) {
    throw new Error('Rates must start at 00:00 UTC on the first of a future month');
  }
  // Use 30 days for all changes, including decreases, until a shorter notice
  // period is agreed. Initial rate cards are initialized separately.
  if (at.getTime() - now.getTime() < 30 * DAY) {
    throw new Error('Rate changes require at least 30 days notice');
  }
};
