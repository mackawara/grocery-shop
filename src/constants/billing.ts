import { Currency } from './models.ts';

// --- Vendor billing (issue #53) ---------------------------------------------
//
// What the PLATFORM charges vendors (tenants): a setup fee, a monthly fee and a
// commission on sales. Not to be confused with constants/payments.ts, which is
// about customers paying vendors for their orders.

// Billing months are calendar months in this time zone. Vendors are in
// Zimbabwe (CAT, UTC+2, no DST), so a month on an invoice is the month on the
// vendor's own calendar: an order completed at 01:00 on the 1st, local time,
// belongs to the new month, not (as it would in UTC) to the old one. One
// platform-wide zone for now; a per-country zone can come with new markets.
export const BILLING_TIME_ZONE = 'Africa/Harare';

// Currencies a rate card may be priced in (decision G2). USD only for now, but
// every amount carries its currency and rate cards are keyed by it, so adding a
// currency is a change to this list, not a schema migration. Matches
// ORDER_CURRENCY: commission is a share of order amounts, which are USD-only.
export const BILLING_CURRENCIES: readonly Currency[] = [Currency.USD];

// Decision F2: a change that makes any charge more expensive must be scheduled
// at least this many days before the billing month it takes effect in.
export const RATE_INCREASE_NOTICE_DAYS = 30;

// Notice for decreases is still open on #53. 0 lets a decrease start from any
// future billing month; raising it needs no other change.
export const RATE_DECREASE_NOTICE_DAYS = 0;

// Commission percentages are stored as integer basis points: 250 = 2.50%,
// 10_000 = 100%. Integers keep the money math exact.
export const BASIS_POINTS_PER_WHOLE = 10_000;

// Where an effective rate came from: the vendor's plan rate card, or an
// admin's per-vendor override (decision F1).
export enum RateSource {
  PLAN = 'plan',
  OVERRIDE = 'override',
}

// Lifecycle of one rate version. Derived from the current billing month and
// the rest of the version's timeline, never stored, so it can't go stale.
//  SCHEDULED  — starts in a future month; may still be cancelled.
//  IN_EFFECT  — the version that applies this month.
//  SUPERSEDED — applied in the past; a later version has replaced it.
//  CANCELLED  — withdrawn before it took effect; kept for the record.
export enum RateVersionStatus {
  SCHEDULED = 'scheduled',
  IN_EFFECT = 'in_effect',
  SUPERSEDED = 'superseded',
  CANCELLED = 'cancelled',
}

// What an audit entry records, as "<subject>.<verb>". Later buckets of #53
// (waivers, promos, credit notes) add their own actions alongside these.
export enum BillingAuditAction {
  PLAN_RATE_SCHEDULED = 'plan_rate.scheduled',
  PLAN_RATE_CANCELLED = 'plan_rate.cancelled',
  VENDOR_RATE_OVERRIDE_SCHEDULED = 'vendor_rate_override.scheduled',
  VENDOR_RATE_OVERRIDE_CANCELLED = 'vendor_rate_override.cancelled',
}

// The kind of record an audit entry is about.
export enum BillingAuditSubject {
  PLAN_RATE = 'plan_rate',
  VENDOR_RATE_OVERRIDE = 'vendor_rate_override',
}
