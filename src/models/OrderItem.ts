// TODO: Stub model — add productType, SKU, and discount fields once Product model is defined
import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IOrderItem extends Document {
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
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String, required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    productId: { type: String, required: true },
    productNameSnapshot: { type: String, required: true },
    catalogId: { type: String },
    quantity: { type: Number, required: true, default: 1 },
    priceAtOrder: { type: Number, required: true },
  },
  { timestamps: true },
);

export const OrderItem = mongoose.models?.OrderItem ?? mongoose.model<IOrderItem>('OrderItem', OrderItemSchema);
