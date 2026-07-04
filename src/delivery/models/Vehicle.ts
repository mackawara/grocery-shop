import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { VehicleTier } from '../../constants/models.ts';
import { tenantScope } from '../../models/plugins/tenantScope.ts';

export { VehicleTier };

// A tenant's fleet entry: one capacity/identity config per vehicle tier. The
// tier is the pricing bucket the rate matrix keys on; capacity is what the quote
// engine uses to pick the smallest vehicle a cart fits in. Cost (base/perKm)
// lives on the rate card (zone × tier), not here.
export interface IVehicle extends Document {
  tenantId: Types.ObjectId;
  tier: VehicleTier;
  name: string; // display label, e.g. "Motorbike", "1-ton truck"
  maxWeightKg: number;
  // Largest single item the vehicle can carry, in cm (optional volumetric cap).
  maxDimensionsCm?: {
    length: number;
    width: number;
    height: number;
  };
  active: boolean;
}

const MaxDimensionsSchema = new Schema(
  {
    length: { type: Number, required: true, min: 0 },
    width: { type: Number, required: true, min: 0 },
    height: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const VehicleSchema = new Schema<IVehicle>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    tier: { type: String, enum: Object.values(VehicleTier), required: true },
    name: { type: String, required: true, trim: true },
    maxWeightKg: { type: Number, required: true, min: 0 },
    maxDimensionsCm: { type: MaxDimensionsSchema },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

// One config per tier per tenant — the tier is the pricing bucket.
VehicleSchema.index({ tenantId: 1, tier: 1 }, { unique: true });

VehicleSchema.plugin(tenantScope);

export default mongoose.model<IVehicle>('Vehicle', VehicleSchema);
