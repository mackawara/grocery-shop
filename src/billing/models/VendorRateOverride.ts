import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { Currency } from '../../constants/models.ts';
import { tenantScope } from '../../models/plugins/tenantScope.ts';
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

// One version of a vendor's rate overrides (decisions C1, D4, F1): admin-set
// prices for THIS vendor that replace their plan's, field by field.
//
// Tenant-owned: carries tenantId and uses tenantScope, so it is only ever read
// or written inside the vendor's tenant context (issue #53 constraints).
//
// Each version is a complete statement of the vendor's overrides from its
// month on: a field it sets replaces the plan rate, a field it leaves out uses
// the plan rate. So a version with no rate fields at all is how an admin
// returns a vendor to plain plan pricing. Versioned and append-only exactly
// like PlanRateVersion.
export interface IVendorRateOverride extends Document {
  tenantId: Types.ObjectId;
  currency: Currency;
  effectiveFrom: BillingPeriod;
  setupFee?: Money;
  monthlyFee?: Money;
  commissionBps?: number;
  commissionFixedFee?: Money;
  reason: string;
  createdBy: StoredActor;
  cancelled: boolean;
  cancellation?: StoredCancellation;
  createdAt: Date;
}

const VendorRateOverrideSchema = new Schema<IVendorRateOverride>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    currency: { type: String, enum: Object.values(Currency), required: true },
    effectiveFrom: effectiveFromField,
    setupFee: { type: MoneySchema },
    monthlyFee: { type: MoneySchema },
    commissionBps: commissionBpsField(false),
    commissionFixedFee: { type: MoneySchema },
    reason: reasonField,
    createdBy: { type: ActorSchema, required: true },
    cancelled: { type: Boolean, required: true, default: false },
    cancellation: { type: CancellationSchema },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Natural key, scoped to the tenant: one live version per currency and month.
VendorRateOverrideSchema.index(
  { tenantId: 1, currency: 1, effectiveFrom: 1 },
  { unique: true, partialFilterExpression: { cancelled: false } },
);

VendorRateOverrideSchema.pre('validate', validateRateRecord);
VendorRateOverrideSchema.plugin(tenantScope);
VendorRateOverrideSchema.plugin(immutableRecord, { cancellable: true });

export default mongoose.model<IVendorRateOverride>(
  'BillingVendorRateOverride',
  VendorRateOverrideSchema,
);
