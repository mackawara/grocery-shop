import type { HydratedDocument, Types } from 'mongoose';
import { Schema } from 'mongoose';
import { Currency } from '../../constants/models.ts';
import { BASIS_POINTS_PER_WHOLE } from '../../constants/billing.ts';
import { isBillingPeriod } from '../period.ts';
import type { Money } from '../types.ts';

// Schema building blocks shared by the billing models.

// Integer minor units + currency. Any platform currency may be stored (G2);
// which ones a rate may be priced in is decided at the API edge
// (BILLING_CURRENCIES), the same split the delivery rate matrix uses.
export const MoneySchema = new Schema<Money>(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'amount must be a whole number of minor units (e.g. cents)',
      },
    },
    currency: { type: String, required: true, enum: Object.values(Currency) },
  },
  { _id: false },
);

// A platform admin as stored on a record: the PlatformUser id, plus the email
// at the time so the history reads well even if the account changes later.
export interface StoredActor {
  platformUserId: Types.ObjectId;
  email: string;
}

export const ActorSchema = new Schema<StoredActor>(
  {
    platformUserId: { type: Schema.Types.ObjectId, ref: 'PlatformUser', required: true },
    email: { type: String, required: true, trim: true, lowercase: true },
  },
  { _id: false },
);

// Decision E4/G1: every billing change carries a reason.
export const reasonField = {
  type: String,
  required: true,
  trim: true,
  minlength: 3,
  maxlength: 500,
} as const;

export interface StoredCancellation {
  at: Date;
  by: StoredActor;
  reason: string;
}

export const CancellationSchema = new Schema<StoredCancellation>(
  {
    at: { type: Date, required: true },
    by: { type: ActorSchema, required: true },
    reason: reasonField,
  },
  { _id: false },
);

export const effectiveFromField = {
  type: String,
  required: true,
  validate: {
    validator: isBillingPeriod,
    message: 'effectiveFrom must be a billing month written YYYY-MM',
  },
} as const;

export const commissionBpsField = (required: boolean) =>
  ({
    type: Number,
    required,
    min: 0,
    max: BASIS_POINTS_PER_WHOLE,
    validate: {
      validator: Number.isSafeInteger,
      message: 'commissionBps must be a whole number of basis points (250 = 2.50%)',
    },
  }) as const;

const MONEY_RATE_FIELDS = ['setupFee', 'monthlyFee', 'commissionFixedFee'] as const;

interface RateRecordShape {
  currency: Currency;
  cancelled: boolean;
  setupFee?: Money;
  monthlyFee?: Money;
  commissionFixedFee?: Money;
}

// pre('validate') for rate records: every amount is in the record's own
// currency (the key it is filed under), and a version is never created
// already cancelled — cancellation is its own audited step.
export function validateRateRecord(this: HydratedDocument<RateRecordShape>): void {
  for (const field of MONEY_RATE_FIELDS) {
    const value = this.get(field) as Money | undefined;
    if (value && value.currency !== this.currency) {
      this.invalidate(field, `${field} must be in ${this.currency}, the rate's currency`);
    }
  }
  if (this.isNew && this.cancelled) {
    this.invalidate('cancelled', 'a rate version cannot be created cancelled');
  }
}
