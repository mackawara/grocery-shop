import type { Currency } from '../constants/models.ts';
import type { BillingPeriod } from './period.ts';

// Money in integer minor units plus an ISO-4217 currency, the platform-wide
// convention (see Product.IMoney, delivery/types.Money). Owned here so the
// billing module does not import another module's model to get a type.
export interface Money {
  amount: number; // integer minor units, e.g. 2500 = $25.00
  currency: Currency;
}

// The four numbers on a rate card (decision F1). Plans set all four; a vendor
// override may set any subset.
export interface RateCard {
  // One-off, charged once for the life of the vendor account (B1, B2).
  setupFee: Money;
  // Per calendar month, billed after the month ends (C4).
  monthlyFee: Money;
  // Share of each completed order's items, excluding delivery (D1, D4), in
  // basis points: 250 = 2.50%.
  commissionBps: number;
  // Fixed fee per completed order, on top of the percentage (D4). May be 0.
  commissionFixedFee: Money;
}

export type RateField = keyof RateCard;
export type PartialRateCard = Partial<RateCard>;

// A platform admin, as recorded on billing records and audit entries. The id
// is the stable identity; the email is a snapshot so history stays readable
// even if the account is later renamed or removed.
export interface BillingActor {
  platformUserId: string;
  email: string;
}

// One entry on a rate timeline (a plan's rate card or a vendor's overrides),
// reduced to what the pure resolution and scheduling rules need.
export interface RateVersion {
  id: string;
  effectiveFrom: BillingPeriod;
  cancelled: boolean;
  rates: PartialRateCard;
}
