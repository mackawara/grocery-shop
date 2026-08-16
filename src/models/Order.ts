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

export default mongoose.model<IOrder>('Order', OrderSchema);
