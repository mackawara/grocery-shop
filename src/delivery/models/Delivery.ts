import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import {
  DeliveryStatus,
  DeliveryMethod,
  QuoteStatus,
  VehicleTier,
  Currency,
} from '../../constants/models.ts';
import { tenantScope } from '../../models/plugins/tenantScope.ts';
import type { Money } from '../types.ts';

export { DeliveryStatus };

// The fulfilment job for one order: who is carrying it, where it is in the
// lifecycle, and when each milestone actually happened.
//
// This is the SOURCE OF TRUTH for fulfilment state. It used to live on
// `Order.deliveryDetails` alongside the pricing fields; splitting it out means
// the order owns the commerce side (method, address, quote, fee) and the
// delivery module owns the job. Nothing writes fulfilment state to Order any
// more — if you find yourself adding a status field there, it belongs here.
//
// Collection orders get a record too. The lifecycle reads differently
// (SHIPPED = ready for pickup, DELIVERED = collected) but it is the same three
// states, and one record type means one board and one set of controls rather
// than a second mechanism for the same idea.
//
// The module still imports no host model: `order` is a ref by collection name
// and `orderNumber` is a plain string.
export interface IDelivery extends Document {
  tenantId: Types.ObjectId;
  order: Types.ObjectId;
  // Snapshot of the order's human key. The WhatsApp side correlates on
  // orderNumber (never on ObjectId), so carrying it here keeps those lookups to
  // a single query.
  orderNumber: string;
  // Mirrors the order's fulfilment method. Denormalized deliberately: the board
  // filters on it ("needs a driver" only means anything for door delivery), and
  // a populated field can't be filtered in Mongo. Written ONLY by
  // `upsertDeliveryForOrder`, so there is exactly one writer.
  method: DeliveryMethod;
  // Absent until the shop allocates someone. Collection orders never get one.
  driver?: Types.ObjectId;
  // Snapshotted so the record stays legible if the driver is later renamed or
  // removed from the roster.
  driverNameSnapshot?: string;
  assignedAt?: Date;
  status: DeliveryStatus;
  // When each milestone was reached. Absent = not reached yet, never zero.
  dispatchedAt?: Date;
  deliveredAt?: Date;
  expectedDeliveryDate?: Date;
  // Where it goes. Foreign key to DeliveryAddress — that document owns the
  // typed fields and the GPS pin; this only points at it.
  address?: Types.ObjectId;
  // --- The quote (written at GPS-pin time by the quote flow). The fee is the
  // source of truth in minor units; it is folded into the ORDER's totalAmount
  // (major units) only once the customer confirms, and `feeApplied` is the
  // idempotency latch for that fold. The money lands on the order because that
  // is what gets charged; the reason for it lives here, with the delivery.
  quoteStatus?: QuoteStatus;
  fee?: Money;
  feeApplied?: boolean;
  vehicleTier?: VehicleTier;
  distanceKm?: number;
}

const DeliverySchema = new Schema<IDelivery>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String, required: true, trim: true },
    method: { type: String, enum: Object.values(DeliveryMethod), required: true },
    driver: { type: Schema.Types.ObjectId, ref: 'Driver' },
    driverNameSnapshot: { type: String, trim: true },
    assignedAt: { type: Date },
    status: {
      type: String,
      enum: Object.values(DeliveryStatus),
      required: true,
      default: DeliveryStatus.PENDING,
    },
    dispatchedAt: { type: Date },
    deliveredAt: { type: Date },
    expectedDeliveryDate: { type: Date },
    address: { type: Schema.Types.ObjectId, ref: 'DeliveryAddress' },
    quoteStatus: { type: String, enum: Object.values(QuoteStatus) },
    fee: {
      type: new Schema(
        {
          amount: {
            type: Number,
            required: true,
            min: 0,
            validate: {
              validator: Number.isInteger,
              message: 'fee amount must be an integer in minor units (e.g. cents)',
            },
          },
          currency: { type: String, required: true, enum: Object.values(Currency) },
        },
        { _id: false },
      ),
    },
    feeApplied: { type: Boolean },
    vehicleTier: { type: String, enum: Object.values(VehicleTier) },
    distanceKm: { type: Number, min: 0 },
  },
  { timestamps: true },
);

// One fulfilment record per order — both keys are natural, and both are unique
// so a double-write can never produce two jobs for one order.
DeliverySchema.index({ tenantId: 1, order: 1 }, { unique: true });
DeliverySchema.index({ tenantId: 1, orderNumber: 1 }, { unique: true });
// The board always sorts newest-first. Keep the sort key after each equality
// prefix so MongoDB can page directly from an index instead of sorting in
// memory for the unfiltered, method-filtered, and status-filtered tabs.
DeliverySchema.index({ tenantId: 1, createdAt: -1 });
DeliverySchema.index({ tenantId: 1, status: 1, createdAt: -1 });
DeliverySchema.index({ tenantId: 1, method: 1, createdAt: -1 });
// The needs-driver tab adds `driver: { $exists: false }` after fixing method to
// door delivery, then uses the same newest-first pagination.
DeliverySchema.index({ tenantId: 1, method: 1, driver: 1, createdAt: -1 });

DeliverySchema.plugin(tenantScope);

export default mongoose.model<IDelivery>('Delivery', DeliverySchema);
