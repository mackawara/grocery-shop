import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { PaymentStatus, PaymentMethod, PaymentProvider } from '../constants/models';
import { tenantScope } from './plugins/tenantScope';

export { PaymentStatus, PaymentMethod, PaymentProvider };

// One attempt against an order — a new doc per retry, so it doubles as an audit
// trail. providerReference holds the gateway's follow-up handle (Paynow poll URL).
export interface IPayment extends Document {
  tenantId: Types.ObjectId;
  order: Types.ObjectId;
  orderNumber: string;
  provider: PaymentProvider;
  method: PaymentMethod;
  amount: number;
  currency: string;
  status: PaymentStatus;
  providerReference?: string;
  payerMobileNumber?: string;
  // WhatsApp sender id, stored so the async webhook can message them — the order
  // never persists it.
  whatsappFrom?: string;
  instructions?: string;
  attempts: number;
  paidAt?: Date;
  lastError?: string;
}

const PaymentSchema = new Schema<IPayment>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String, required: true },
    provider: { type: String, enum: Object.values(PaymentProvider), required: true },
    method: { type: String, enum: Object.values(PaymentMethod), required: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'USD' },
    status: {
      type: String,
      enum: Object.values(PaymentStatus),
      default: PaymentStatus.PENDING,
    },
    providerReference: { type: String },
    payerMobileNumber: { type: String },
    whatsappFrom: { type: String },
    instructions: { type: String },
    attempts: { type: Number, required: true, default: 1 },
    paidAt: { type: Date },
    lastError: { type: String },
  },
  { timestamps: true },
);

// Serves both the double-charge guard and the webhook's settle-by-order lookup.
PaymentSchema.index(
  { tenantId: 1, orderNumber: 1 },
  { unique: true, partialFilterExpression: { status: PaymentStatus.PENDING } },
);
PaymentSchema.plugin(tenantScope);

export default mongoose.model<IPayment>('Payment', PaymentSchema);
