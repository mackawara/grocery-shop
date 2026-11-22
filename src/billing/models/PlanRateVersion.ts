import type { Document } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { Currency, TenantPlan } from '../../constants/models.ts';
import type { BillingPeriod } from '../period.ts';
import type { Money } from '../types.ts';
import { immutableRecord } from './plugins/immutableRecord.ts';
import type { StoredActor, StoredCancellation } from './fields.ts';
import {
  ActorSchema,
  CancellationSchema,
  MoneySchema,
  commissionBpsField,
  effectiveFromField,
  reasonField,
  validateRateRecord,
} from './fields.ts';

// One version of a plan's rate card (decisions C1, D4, F1, F2): all four
// numbers for one plan in one currency, from one billing month onwards.
//
// GLOBAL by design: a plan's prices are the same for every vendor on it, so
// this carries no tenantId and does not use tenantScope (the issue's technical
// constraints call rate cards "genuinely global"). Per-vendor prices live in
// VendorRateOverride, which is tenant-scoped.
//
// History is the collection itself: a price change is a NEW version starting
// in a future month, never an edit (immutableRecord). The one permitted change
// is withdrawing a version before it takes effect, which sets `cancelled` and
// keeps the record. The version that applies in a month is the latest
// uncancelled one starting in or before it (see billing/rates.ts).
export interface IPlanRateVersion extends Document {
  plan: TenantPlan;
  currency: Currency;
  effectiveFrom: BillingPeriod;
  setupFee: Money;
  monthlyFee: Money;
  commissionBps: number;
  commissionFixedFee: Money;
  reason: string;
  createdBy: StoredActor;
  cancelled: boolean;
  cancellation?: StoredCancellation;
  createdAt: Date;
}

const PlanRateVersionSchema = new Schema<IPlanRateVersion>(
  {
    plan: { type: String, enum: Object.values(TenantPlan), required: true },
    currency: { type: String, enum: Object.values(Currency), required: true },
    effectiveFrom: effectiveFromField,
    setupFee: { type: MoneySchema, required: true },
    monthlyFee: { type: MoneySchema, required: true },
    commissionBps: commissionBpsField(true),
    commissionFixedFee: { type: MoneySchema, required: true },
    reason: reasonField,
    createdBy: { type: ActorSchema, required: true },
    cancelled: { type: Boolean, required: true, default: false },
    cancellation: { type: CancellationSchema },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One live version per plan, currency and month. Partial so a cancelled
// version doesn't block scheduling its replacement. Also serves the timeline
// reads, which always filter on these fields.
PlanRateVersionSchema.index(
  { plan: 1, currency: 1, effectiveFrom: 1 },
  { unique: true, partialFilterExpression: { cancelled: false } },
);

PlanRateVersionSchema.pre('validate', validateRateRecord);
PlanRateVersionSchema.plugin(immutableRecord, { cancellable: true });

export default mongoose.model<IPlanRateVersion>('BillingPlanRateVersion', PlanRateVersionSchema);
