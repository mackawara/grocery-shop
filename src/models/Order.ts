// TODO: Stub model — extend with discount and channel fields before production use
import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { OrderStatus, PaymentStatus } from '../constants/models.ts';
import { tenantScope } from './plugins/tenantScope.ts';

export { OrderStatus, PaymentStatus };

export interface IOrder extends Document {
  tenantId: Types.ObjectId;
  orderNumber: string;
  user: Types.ObjectId;
  customerName?: string;
  totalAmount: number;
  status: OrderStatus;
  orderDate: Date;
  // First completion is permanent, even if subsequently refunded/cancelled.
  completedAt?: Date;
  billingItemsMinor?: number;
  billingNeedsSync?: boolean;
  notes?: string;
  orderItems: Types.ObjectId[];
  paymentDetails: {
    status: PaymentStatus;
    method?: string;
    reference?: string;
    mobileNumber?: string;
  };
  // Foreign key to this order's fulfilment job (`Delivery`), set once the
  // customer chooses how to receive the order. This is the ONLY delivery data
  // on the order: method, address, the quote, the fee, the driver and the
  // lifecycle all live on that record (src/delivery/models/Delivery.ts).
  //
  // The relationship is recorded from both ends, and the delivery's own `order`
  // field is the AUTHORITATIVE direction — it is uniquely indexed, so the
  // database itself guarantees one job per order. This side is a convenience
  // pointer that resolves the job in one populate. Because it is a second copy
  // of one relationship, exactly one function writes it: `ensureOrderDelivery`
  // (controllers/delivery/orderDelivery.ts), which creates the job and stamps
  // the order together. Never assign this by hand.
  //
  // `totalAmount` is the one place delivery money touches the order: the fee is
  // folded into it on confirmation, because the total is what gets charged.
  delivery?: Types.ObjectId;
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
    completedAt: { type: Date, index: true },
    billingItemsMinor: { type: Number, min: 0, validate: Number.isSafeInteger },
    billingNeedsSync: { type: Boolean },
    notes: { type: String },
    orderItems: [{ type: Schema.Types.ObjectId, ref: 'OrderItem' }],
    // Back-reference to the fulfilment job — written only by
    // ensureOrderDelivery, alongside the job it points at.
    delivery: { type: Schema.Types.ObjectId, ref: 'Delivery' },
    paymentDetails: {
      status: { type: String, enum: Object.values(PaymentStatus), default: PaymentStatus.PENDING },
      method: { type: String },
      reference: { type: String },
      mobileNumber: { type: String },
    },
  },
  { timestamps: true },
);

OrderSchema.index({ tenantId: 1, orderNumber: 1 }, { unique: true });

OrderSchema.plugin(tenantScope);

OrderSchema.pre<IOrder>('save', async function () {
  this.$locals.billingChanged =
    this.isNew || this.isModified('status') || this.isModified('paymentDetails.status');
  if (this.$locals.billingChanged && this.completedAt) {
    this.billingNeedsSync = true;
  }
  if (this.status === OrderStatus.COMPLETED && !this.completedAt) {
    const { itemSubtotal } = await import('../billing/service.ts');
    this.billingItemsMinor = await itemSubtotal(
      this._id as Types.ObjectId,
      this.$session() ?? undefined,
    );
    this.completedAt = new Date();
    this.billingNeedsSync = true;
  }
});
OrderSchema.post<IOrder>('save', async function (order) {
  if (!order.completedAt || !order.$locals.billingChanged) {
    return;
  }
  const { syncOrderBilling, transaction } = await import('../billing/service.ts');
  const session = order.$session();
  if (session) {
    await syncOrderBilling(order, session);
  } else {
    await transaction((s) => syncOrderBilling(order, s));
  }
});

// Lifecycle queries would skip first-completion snapshots and accrual hooks.
// Use save() inside a transaction for completion, cancellation and refunds.
for (const operation of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
] as const) {
  OrderSchema.pre(operation, function () {
    const update = this.getUpdate();
    if (Array.isArray(update)) {
      throw new Error('Order lifecycle changes require document save');
    }
    if (!update) {
      return;
    }
    const fields = { ...update, ...update.$set, ...update.$unset };
    if (
      'status' in fields ||
      'paymentDetails' in fields ||
      'paymentDetails.status' in fields ||
      'completedAt' in fields ||
      'billingItemsMinor' in fields
    ) {
      throw new Error('Order lifecycle changes require document save');
    }
  });
}

export default mongoose.model<IOrder>('Order', OrderSchema);
