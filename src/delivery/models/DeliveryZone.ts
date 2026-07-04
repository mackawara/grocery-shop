import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { DeliveryZoneKind } from '../../constants/models.ts';
import { tenantScope } from '../../models/plugins/tenantScope.ts';

export { DeliveryZoneKind };

// A distance band from the tenant's shop, in kilometres. Half-open [minKm, maxKm)
// so adjacent rings don't both claim a point on the boundary.
export interface IZoneRing {
  minKm: number;
  maxKm: number;
}

// GeoJSON polygon boundary. Coordinates are [longitude, latitude] pairs (GeoJSON
// order — the reverse of how we usually say "lat, lng").
export interface IZoneGeometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: number[][][] | number[][][][];
}

export interface IDeliveryZone extends Document {
  tenantId: Types.ObjectId;
  name: string;
  code?: string; // short label, e.g. "A", "CBD"
  kind: DeliveryZoneKind;
  // Lower is checked first; the first zone that contains the point wins. Lets a
  // tenant carve a specific inner zone out of a broader one.
  priority: number;
  active: boolean;
  // Exactly one matcher is set, per `kind` (enforced in the pre-validate hook).
  ring?: IZoneRing;
  geometry?: IZoneGeometry;
}

const RingSchema = new Schema<IZoneRing>(
  {
    minKm: { type: Number, required: true, min: 0 },
    maxKm: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const GeometrySchema = new Schema<IZoneGeometry>(
  {
    type: { type: String, enum: ['Polygon', 'MultiPolygon'], required: true },
    // Mixed-depth GeoJSON coordinate array; MongoDB validates it via the
    // 2dsphere index at write time.
    coordinates: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

const DeliveryZoneSchema = new Schema<IDeliveryZone>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    kind: { type: String, enum: Object.values(DeliveryZoneKind), required: true },
    priority: { type: Number, required: true, default: 100 },
    active: { type: Boolean, required: true, default: true },
    ring: { type: RingSchema },
    geometry: { type: GeometrySchema },
  },
  { timestamps: true },
);

// Zone name is unique per tenant (natural key).
DeliveryZoneSchema.index({ tenantId: 1, name: 1 }, { unique: true });
// Resolver reads a tenant's zones in priority order.
DeliveryZoneSchema.index({ tenantId: 1, active: 1, priority: 1 });
// Point-in-polygon lookups via $geoIntersects. 2dsphere (v2) is sparse, so ring
// zones (no geometry) are simply not indexed here.
DeliveryZoneSchema.index({ geometry: '2dsphere' });

// The matcher must match the kind: ring zones need a ring, polygon zones a
// geometry. Fail fast at validation rather than silently never matching.
DeliveryZoneSchema.pre<IDeliveryZone>('validate', function () {
  if (this.kind === DeliveryZoneKind.RING) {
    if (!this.ring) {
      this.invalidate('ring', 'ring is required when kind is "ring"');
    } else if (this.ring.maxKm <= this.ring.minKm) {
      this.invalidate('ring.maxKm', 'maxKm must be greater than minKm');
    }
  }
  if (this.kind === DeliveryZoneKind.POLYGON && !this.geometry) {
    this.invalidate('geometry', 'geometry is required when kind is "polygon"');
  }
});

DeliveryZoneSchema.plugin(tenantScope);

export default mongoose.model<IDeliveryZone>('DeliveryZone', DeliveryZoneSchema);
