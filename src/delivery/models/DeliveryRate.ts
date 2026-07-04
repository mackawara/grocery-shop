import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { DeliveryRateKind, VehicleTier, Currency } from '../../constants/models.ts';
import { tenantScope } from '../../models/plugins/tenantScope.ts';
import type { Money } from '../types.ts';

export { DeliveryRateKind };

// One cell of the tenant's rate matrix: how deliveries by `tier` into `zone`
// are priced. A missing cell means "no explicit rate" — the quote engine treats
// that the same as NOT_SERVED unless a tenant-level default applies (later).
export interface IDeliveryRate extends Document {
  tenantId: Types.ObjectId;
  zone: Types.ObjectId; // ref DeliveryZone (same tenant, enforced by scoping)
  tier: VehicleTier;
  kind: DeliveryRateKind;
  // kind=FLAT: the whole fee.
  flat?: Money;
  // kind=BASE_PER_KM: fee = base + perKm × distanceKm (same currency, enforced).
  base?: Money;
  perKm?: Money;
}

const MoneySchema = new Schema<Money>(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'amount must be an integer in minor units (e.g. cents)',
      },
    },
    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: Object.values(Currency),
    },
  },
  { _id: false },
);

const DeliveryRateSchema = new Schema<IDeliveryRate>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    zone: { type: Schema.Types.ObjectId, ref: 'DeliveryZone', required: true },
    tier: { type: String, enum: Object.values(VehicleTier), required: true },
    kind: { type: String, enum: Object.values(DeliveryRateKind), required: true },
    flat: { type: MoneySchema },
    base: { type: MoneySchema },
    perKm: { type: MoneySchema },
  },
  { timestamps: true },
);

// One cell per (zone × tier) per tenant — the matrix key.
DeliveryRateSchema.index({ tenantId: 1, zone: 1, tier: 1 }, { unique: true });

// The pricing fields must match the kind — fail at validation, not at quote time.
DeliveryRateSchema.pre<IDeliveryRate>('validate', function () {
  if (this.kind === DeliveryRateKind.FLAT && !this.flat) {
    this.invalidate('flat', 'flat amount is required when kind is "flat"');
  }
  if (this.kind === DeliveryRateKind.BASE_PER_KM) {
    if (!this.base || !this.perKm) {
      this.invalidate('base', 'base and perKm are required when kind is "base_per_km"');
    } else if (this.base.currency !== this.perKm.currency) {
      this.invalidate('perKm', 'base and perKm must use the same currency');
    }
  }
});

DeliveryRateSchema.plugin(tenantScope);

export default mongoose.model<IDeliveryRate>('DeliveryRate', DeliveryRateSchema);
