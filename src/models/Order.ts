// TODO: Stub model — extend with delivery address, discount, and channel fields before production use
import type { Document, Types } from "mongoose";
import mongoose, { Schema } from "mongoose";
import { OrderStatus, PaymentStatus, DeliveryStatus } from "../constants/models";
import { tenantScope } from "./plugins/tenantScope";

export { OrderStatus, PaymentStatus, DeliveryStatus };

export interface IOrder extends Document {
  tenantId: Types.ObjectId;
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
  deliveryDetails?: {
    address: string;
    status: DeliveryStatus;
    expectedDeliveryDate: Date;
  };
}

const OrderSchema = new Schema<IOrder>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    orderNumber: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    totalAmount: { type: Number, required: true, default: 0 },
    status: {
      type: String,
      enum: Object.values(OrderStatus),
      default: OrderStatus.PENDING,
    },
    orderDate: { type: Date, required: true },
    notes: { type: String },
    orderItems: [{ type: Schema.Types.ObjectId, ref: "OrderItem" }],
    paymentDetails: {
      status: { type: String, enum: Object.values(PaymentStatus), default: PaymentStatus.PENDING },
      method: { type: String },
      reference: { type: String },
    },
  },
  { timestamps: true },
);

OrderSchema.index({ tenantId: 1, orderNumber: 1 }, { unique: true });

OrderSchema.plugin(tenantScope);

export default mongoose.model<IOrder>("Order", OrderSchema);
