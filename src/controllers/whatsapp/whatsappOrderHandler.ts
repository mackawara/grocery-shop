import mongoose, { Types } from "mongoose";
import { logger } from "../../services/logger";
import { Order } from "../../types/types";
import whatsappMessager from "./outgoingMessages";
import OrderModel from "../../models/Order";
import { OrderItem } from "../../models/OrderItem";
import { setRedisHashKeyValuePair } from "../redis/redis.controller";
// import User from "../../models/User"; // TODO: uncomment once User model is fully defined

const ORDER_SESSION_TTL_SECONDS = 1800; // 30 minutes

interface OrderItemSummary {
  productId: string;
  quantity: number;
  price: number;
}

export const whatsappOrderHandler = async (from: string, order: Order): Promise<void> => {
  logger.info(`[ORDER_MESSAGE] Processing catalog order from: ${from} | catalog: ${order.catalog_id} | items: ${order.product_items.length}`);

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

      const newOrderItem = new OrderItem({
        order: newOrder._id,
        orderNumber,
        // user: userId, // TODO: restore once user resolution is wired up
        productId: item.product_retailer_id,
        // TODO: resolve human-readable name from Product catalog once that model exists
        productNameSnapshot: item.product_retailer_id,
        catalogId: order.catalog_id,
        quantity,
        priceAtOrder: price,
      });

      await newOrderItem.save({ session });
      orderItemIds.push(newOrderItem._id);
      itemSummaries.push({ productId: item.product_retailer_id, quantity, price });
      totalAmount += price * quantity;
    }

    newOrder.totalAmount = totalAmount;
    newOrder.orderItems = orderItemIds;
    await newOrder.save({ session });

    await session.commitTransaction();
    logger.info(`[ORDER_MESSAGE] Order ${orderNumber} committed for ${from}`);

    await setRedisHashKeyValuePair({ hashName: from, key: 'orderNumber', value: orderNumber, expiry: ORDER_SESSION_TTL_SECONDS });
    await setRedisHashKeyValuePair({ hashName: from, key: 'items', value: JSON.stringify(itemSummaries), expiry: ORDER_SESSION_TTL_SECONDS });

    const itemsList = itemSummaries
      .map(i => `• ${i.productId} x${i.quantity} — $${i.price.toFixed(2)}`)
      .join('\n');

    await whatsappMessager.sendFreeFormTextMessage(
      from,
      `Order received!\n\n${itemsList}\n\nTotal: $${totalAmount.toFixed(2)}\nOrder #: ${orderNumber}\n\nWe'll be in touch shortly to confirm your order.`,
    );

  } catch (error) {
    await session.abortTransaction();
    logger.error(`[ORDER_MESSAGE] Error processing order from ${from}:`, error);
    await whatsappMessager.sendFreeFormTextMessage(from, 'Sorry, we ran into an issue processing your order. Please try again.');
  } finally {
    session.endSession();
  }
};
