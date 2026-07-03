import type { Types } from 'mongoose';
import mongoose from 'mongoose';
import { logger } from '../../services/logger.ts';
import type { Order } from '../../types/types.ts';
import whatsappMessager, { createFlowInteractive } from './outgoingMessages.ts';
import OrderModel from '../../models/Order.ts';
import { OrderItem } from '../../models/OrderItem.ts';
import ProductModel from '../../models/Product.ts';
import { setRedisHashKeyValuePair } from '../redis/redis.controller.ts';
import Tenant from '../../models/Tenant.ts';
import { getTenantId } from '../../context/tenantContext.ts';
import { toPaymentMethodOptions, toDeliveryMethodOptions } from '../../constants/models.ts';
import { DEFAULT_ORDER_FLOW_ID, ORDER_DETAILS_FLOW_TOKEN } from '../../constants/orderFlow.ts';
// import User from "../../models/User.ts"; // TODO: uncomment once User model is fully defined

const ORDER_SESSION_TTL_SECONDS = 1800; // 30 minutes

interface OrderItemSummary {
  name: string;
  quantity: number;
  price: number;
}

// Build + send the order-details flow. Reused to re-prompt when a required field
// (e.g. the EcoCash number) is missing; the Redis session orderNumber still ties
// the re-submission back to the same order.
export const sendOrderDetailsFlow = async (from: string): Promise<void> => {
  const tenant = await Tenant.findById(getTenantId())
    .select('paymentMethods deliveryMethods whatsappFlowIds')
    .lean();

  const orderDetailsFlow = createFlowInteractive({
    bodyText: 'Please fill in the following form to complete your order:',
    flowId: tenant?.whatsappFlowIds?.order ?? DEFAULT_ORDER_FLOW_ID,
    flowToken: ORDER_DETAILS_FLOW_TOKEN,
    initialScreen: 'ORDER_DETAILS',
    // TODO: generate a unique token per order to correlate flow responses back to orders
    initialData: {
      payment_methods: toPaymentMethodOptions(tenant?.paymentMethods ?? []),
      delivery_methods: toDeliveryMethodOptions(tenant?.deliveryMethods ?? []),
    },
    flowCta: 'Complete Order Form',
  });
  await whatsappMessager.sendInteractive(from, orderDetailsFlow);
};

export const whatsappOrderHandler = async (from: string, order: Order): Promise<void> => {
  logger.info(
    `[ORDER_MESSAGE] Processing catalog order from: ${from} | catalog: ${order.catalog_id} | items: ${order.product_items.length}`,
  );

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // TODO: uncomment and wire up once User model is fully defined
    // let user = await User.findOne({ phoneNumber: from }).select('_id').lean();
    // if (!user) {
    //   const newUser = new User({ phoneNumber: from });
    //   await newUser.save({ session });
    //   user = newUser;
    // }
    // const userId = user._id as Types.ObjectId;

    // TODO: replace with a persistent counter (e.g. MongoDB sequence) before production
    const orderNumber = `ORD-${Date.now()}`;

    const newOrder = new OrderModel({
      orderNumber,
      // user: userId, // TODO: restore once user resolution is wired up
      totalAmount: 0,
      status: 'pending',
      orderDate: new Date(),
      notes: order.text || 'Order received via WhatsApp',
      paymentDetails: { status: 'pending' },
    });

    const orderItemIds: Types.ObjectId[] = [];
    const itemSummaries: OrderItemSummary[] = [];
    let totalAmount = 0;

    for (const item of order.product_items) {
      const price = Number(item.item_price) || 0;
      const quantity = Number(item.quantity) || 1;
      const sku = item.product_retailer_id;

      // Resolve the catalog product (tenant-scoped) to link the ref and snapshot
      // its name/type. Falls back to the raw retailer id when the product isn't
      // in our catalog, so an order is never dropped for an unknown item.
      // TODO: N+1 — collect the SKUs and resolve them in one find({ sku: { $in } })
      // before the loop.
      const product = await ProductModel.findOne({ sku }).select('title productType').lean();

      const newOrderItem = new OrderItem({
        order: newOrder._id,
        orderNumber,
        // user: userId, // TODO: restore once user resolution is wired up
        product: product?._id,
        sku,
        productNameSnapshot: product?.title ?? sku,
        productTypeSnapshot: product?.productType,
        catalogId: order.catalog_id,
        quantity,
        priceAtOrder: price,
      });

      await newOrderItem.save({ session });
      orderItemIds.push(newOrderItem._id);
      itemSummaries.push({ name: product?.title ?? sku, quantity, price });
      totalAmount += price * quantity;
    }

    newOrder.totalAmount = totalAmount;
    newOrder.orderItems = orderItemIds;
    await newOrder.save({ session });

    await session.commitTransaction();
    logger.info(`[ORDER_MESSAGE] Order ${orderNumber} committed for ${from}`);

    await setRedisHashKeyValuePair({
      hashName: from,
      key: 'orderNumber',
      value: orderNumber,
      expiry: ORDER_SESSION_TTL_SECONDS,
    });

    await setRedisHashKeyValuePair({
      hashName: from,
      key: 'items',
      value: JSON.stringify(itemSummaries),
      expiry: ORDER_SESSION_TTL_SECONDS,
    });

    const itemsList = itemSummaries
      .map((i) => `• ${i.name} x${i.quantity} — $${i.price.toFixed(2)}`)
      .join('\n');

    await whatsappMessager.sendFreeFormTextMessage(
      from,

      `Order received!\n\n${itemsList}\n\nTotal: $${totalAmount.toFixed(2)}\nOrder #: ${orderNumber}\n\nWe'll be in touch shortly to confirm your order.`,
    );
    await sendOrderDetailsFlow(from);
  } catch (error) {
    await session.abortTransaction();
    logger.error(`[ORDER_MESSAGE] Error processing order from ${from}:`, error);

    await whatsappMessager.sendFreeFormTextMessage(
      from,
      'Sorry, we ran into an issue processing your order. Please try again.',
    );
  } finally {
    session.endSession();
  }
};
