// TODO: Stub model — add productType, SKU, and discount fields once Product model is defined
import type { Document, Types } from "mongoose";
import mongoose, { Schema } from "mongoose";

export interface IOrderItem extends Document {
  tenantId: Types.ObjectId;
  order: Types.ObjectId;
  orderNumber: string;
  user: Types.ObjectId;
  productId: string;
  productNameSnapshot: string;
  catalogId: string;
  quantity: number;
  priceAtOrder: number;
}

const OrderItemSchema = new Schema<IOrderItem>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    orderNumber: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    productId: { type: String, required: true },
    productNameSnapshot: { type: String, required: true },
    catalogId: { type: String },
    quantity: { type: Number, required: true, default: 1 },
    priceAtOrder: { type: Number, required: true },
  },
  { timestamps: true },
);

OrderItemSchema.index({ tenantId: 1, orderNumber: 1 });

export const OrderItem = mongoose.model<IOrderItem>("OrderItem", OrderItemSchema);
