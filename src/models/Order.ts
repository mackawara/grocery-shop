// TODO: Stub model — extend with delivery address, discount, and channel fields before production use
import mongoose, { Document, Schema, Types } from 'mongoose';

type OrderStatus = 'pending' | 'confirmed' | 'processing' | 'completed' | 'cancelled';
type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export interface IOrder extends Document {
  orderNumber: string;
  user: Types.ObjectId;
  totalAmount: number;
  status: OrderStatus;
  orderDate: Date;
  notes?: string;
  orderItems: Types.ObjectId[];
  paymentDetails: {
    status: PaymentStatus;
    method?: string;
    reference?: string;
  };
}

const OrderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    totalAmount: { type: Number, required: true, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'processing', 'completed', 'cancelled'],
      default: 'pending',
    },
    orderDate: { type: Date, required: true },
    notes: { type: String },
    orderItems: [{ type: Schema.Types.ObjectId, ref: 'OrderItem' }],
    paymentDetails: {
      status: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
      method: { type: String },
      reference: { type: String },
    },
  },
  { timestamps: true },
);

export default mongoose.models?.Order ?? mongoose.model<IOrder>('Order', OrderSchema);
