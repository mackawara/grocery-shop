// TODO: Stub model — extend with delivery address, discount, and channel fields before production use
import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import {
  OrderStatus,
  PaymentStatus,
  DeliveryStatus,
  QuoteStatus,
  VehicleTier,
  Currency,
} from '../constants/models.ts';
import { tenantScope } from './plugins/tenantScope.ts';

export { OrderStatus, PaymentStatus, DeliveryStatus };

export interface IOrder extends Document {
  tenantId: Types.ObjectId;
  orderNumber: string;
  user: Types.ObjectId;
  customerName?: string;
  totalAmount: number;
  status: OrderStatus;
  orderDate: Date;
  notes?: string;
  orderItems: Types.ObjectId[];
  paymentDetails: {
    status: PaymentStatus;
    method?: string;
    reference?: string;
    mobileNumber?: string;
  };
  deliveryDetails?: {
    method?: string;
    // Foreign key to DeliveryAddress — the delivery controller owns the
    // canonical address document (typed fields + GPS). Order only points
    // at it; it does not snapshot any address fields.
    address?: Types.ObjectId;
    status: DeliveryStatus;
    expectedDeliveryDate?: Date;
    // --- Delivery quote (written at GPS-pin time by the quote flow). The fee
    // is the source of truth in minor units; it is folded into `totalAmount`
    // (major units) only once the customer confirms — `feeApplied` is the
    // idempotency latch for that fold.
    quoteStatus?: QuoteStatus;
    fee?: { amount: number; currency: Currency };
    feeApplied?: boolean;
    vehicleTier?: VehicleTier;
    distanceKm?: number;
    // Driver allocation, made by the shop on the dashboard. `driver` refs a
    // VendorUser with role DRIVER; the name is snapshotted so the order's
    // history stays legible even if the seat is later renamed/removed.
    assignment?: {
      driver: Types.ObjectId;
      driverNameSnapshot?: string;
      assignedAt: Date;
    };
  };
}

const OrderSchema = new Schema<IOrder>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    orderNumber: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    customerName: { type: String },
    totalAmount: { type: Number, required: true, default: 0 },
    status: {
      type: String,
      enum: Object.values(OrderStatus),
      default: OrderStatus.PENDING,
    },
    orderDate: { type: Date, required: true },
    notes: { type: String },
    orderItems: [{ type: Schema.Types.ObjectId, ref: 'OrderItem' }],
    paymentDetails: {
      status: { type: String, enum: Object.values(PaymentStatus), default: PaymentStatus.PENDING },
      method: { type: String },
      reference: { type: String },
      mobileNumber: { type: String },
    },
    deliveryDetails: {
      method: { type: String },
      address: { type: Schema.Types.ObjectId, ref: 'DeliveryAddress' },
      status: {
        type: String,
        enum: Object.values(DeliveryStatus),
        default: DeliveryStatus.PENDING,
      },
      expectedDeliveryDate: { type: Date },
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
      assignment: {
        type: new Schema(
          {
            driver: { type: Schema.Types.ObjectId, ref: 'VendorUser', required: true },
            driverNameSnapshot: { type: String, trim: true },
            assignedAt: { type: Date, required: true },
          },
          { _id: false },
        ),
      },
    },
  },
  { timestamps: true },
);

OrderSchema.index({ tenantId: 1, orderNumber: 1 }, { unique: true });

OrderSchema.plugin(tenantScope);

export default mongoose.model<IOrder>('Order', OrderSchema);
