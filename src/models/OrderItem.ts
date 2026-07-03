import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope.ts';

// A line item on an order. Links to the catalog Product by both a hard ref
// (`product`) and the stable retailer id (`sku`), while snapshotting the
// name/type/price as they were at order time so historical orders stay correct
// even if the product later changes or is archived.
export interface IOrderItem extends Document {
  tenantId: Types.ObjectId;
  order: Types.ObjectId;
  orderNumber: string;
  user?: Types.ObjectId;
  // Ref to the catalog Product. Optional: an order can arrive for a retailer_id
  // we don't (yet) have a Product row for; `sku` is always retained regardless.
  product?: Types.ObjectId;
  // Product.sku / WhatsApp product_retailer_id — the stable catalog key.
  sku: string;
  // Snapshots captured at order time.
  productNameSnapshot: string;
  productTypeSnapshot?: string;
  catalogId?: string;
  quantity: number;
  priceAtOrder: number;
}

const OrderItemSchema = new Schema<IOrderItem>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    product: { type: Schema.Types.ObjectId, ref: 'Product' },
    sku: { type: String, required: true },
    productNameSnapshot: { type: String, required: true },
    productTypeSnapshot: { type: String },
    catalogId: { type: String },
    quantity: { type: Number, required: true, default: 1 },
    priceAtOrder: { type: Number, required: true },
  },
  { timestamps: true },
);

OrderItemSchema.index({ tenantId: 1, orderNumber: 1 });
OrderItemSchema.index({ tenantId: 1, sku: 1 });

OrderItemSchema.plugin(tenantScope);

export const OrderItem = mongoose.model<IOrderItem>('OrderItem', OrderItemSchema);
