import type { ClientSession } from 'mongoose';
import mongoose, { Types } from 'mongoose';
import type { StoredActor } from './models/fields.ts';
import { RATE_FIELDS } from './rates.ts';
import type { BillingActor, Money, PartialRateCard, RateVersion } from './types.ts';

// Conversions between stored billing records and the plain shapes the pure
// rules work on, plus the transaction wrapper every billing write uses.

type RateSourceRecord = Partial<Record<(typeof RATE_FIELDS)[number], unknown>>;

// The rate fields a record sets, as plain values (no Mongoose internals).
export const ratesOf = (record: RateSourceRecord): PartialRateCard => {
  const rates: PartialRateCard = {};
  for (const field of RATE_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (field === 'commissionBps') {
      rates.commissionBps = value as number;
    } else {
      const money = value as Money;
      rates[field] = { amount: money.amount, currency: money.currency };
    }
  }
  return rates;
};

interface VersionRecord extends RateSourceRecord {
  _id: unknown;
  effectiveFrom: string;
  cancelled: boolean;
}

export const toRateVersion = (record: VersionRecord): RateVersion => ({
  id: String(record._id),
  effectiveFrom: record.effectiveFrom,
  cancelled: record.cancelled,
  rates: ratesOf(record),
});

export const toStoredActor = (actor: BillingActor): StoredActor => ({
  platformUserId: new Types.ObjectId(actor.platformUserId),
  email: actor.email,
});

// Every billing change commits together with its audit entry, or not at all.
// The driver retries `work` on transient errors, so it must be safe to re-run:
// read, check and write inside it, and await every operation in sequence.
export const inBillingTransaction = async <T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
};
