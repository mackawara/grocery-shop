import { logger } from '../../services/logger.ts';
import whatsappMessager, { messageComposer } from '../whatsapp/outgoingMessages.ts';
import OrderModel from '../../models/Order.ts';
import type { IOrder } from '../../models/Order.ts';
import { OrderItem } from '../../models/OrderItem.ts';
import ProductModel from '../../models/Product.ts';
import { requireTenantId } from '../../context/tenantContext.ts';
import { quoteDelivery, computeVehicleRequirement, QuoteStatus } from '../../delivery/index.ts';
import type { CartItemPhysicals, GeoPoint, Money } from '../../delivery/index.ts';
import { DeliveryMethod, DeliveryStatus, Currency } from '../../constants/models.ts';
import {
  buildDeliveryConfirmButtonId,
  buildDeliveryCollectButtonId,
} from '../../constants/delivery.ts';
import { initiateOrderPayment } from '../payments/payment.controller.ts';

const TAG = '[DELIVERY_QUOTE_FLOW]';

// Payments charge `order.totalAmount` in this currency (payment.controller's
// DEFAULT_CURRENCY), so a fee can only be folded into the total when it
// matches. A mismatched rate card falls back to attendant handling.
const ORDER_CURRENCY = Currency.USD;

const formatMoney = (money: Money): string => `${money.currency} ${(money.amount / 100).toFixed(2)}`;

const toMajorUnits = (money: Money): number => money.amount / 100;

/**
 * Read the physical profile of every line on the order off the catalog in one
 * batched query (by sku — items whose product was never in our catalog simply
 * have no physicals and contribute nothing to the requirement).
 */
const buildCartPhysicals = async (orderNumber: string): Promise<CartItemPhysicals[]> => {
  const items = await OrderItem.find({ orderNumber }).select('quantity sku').lean();
  const skus = items.map((item) => item.sku);
  const products = await ProductModel.find({ sku: { $in: skus } })
    .select('sku weight dimensions minVehicle')
    .lean();
  const bySku = new Map(products.map((p) => [p.sku, p]));

  return items.map((item) => {
    const product = bySku.get(item.sku);
    return {
      quantity: item.quantity,
      weightKg: product?.weight,
      dimensionsCm: product?.dimensions
        ? {
            length: product.dimensions.length,
            width: product.dimensions.width,
            height: product.dimensions.height,
          }
        : undefined,
      minTier: product?.minVehicle,
    };
  });
};

const collectButton = (orderNumber: string) => ({
  type: 'reply' as const,
  reply: { id: buildDeliveryCollectButtonId(orderNumber), title: 'Collect instead' },
});

/**
 * Quote the delivery for an order once its GPS pin has landed, persist the
 * quote on the order, and ask the customer to confirm the new total before any
 * payment is initiated (the fee is never charged without an explicit tap).
 *
 * Re-entrant: a corrected pin re-quotes and re-asks — unless the fee was
 * already confirmed (`feeApplied`), in which case pricing is final and we only
 * nudge payment along (its own double-charge guard makes that safe).
 *
 * Must run inside the webhook's tenant context.
 */
export const quoteAndConfirmDelivery = async (
  from: string,
  orderNumber: string,
  shopOrigin: GeoPoint | undefined,
  dropoff: GeoPoint,
): Promise<void> => {
  const tenantId = requireTenantId('delivery quote');

  const order = await OrderModel.findOne({ orderNumber });
  if (!order) {
    logger.warn(`${TAG} order ${orderNumber} not found for ${from}`);
    return;
  }

  if (order.deliveryDetails?.feeApplied) {
    logger.info(
      `${TAG} order ${orderNumber} fee already confirmed — pin updated, pricing unchanged`,
    );
    await initiateOrderPayment(from, orderNumber);
    return;
  }

  const physicals = await buildCartPhysicals(orderNumber);
  const requirement = computeVehicleRequirement(physicals);
  const result = await quoteDelivery(tenantId, shopOrigin, dropoff, requirement);

  const deliveryDetails = order.deliveryDetails ?? { status: DeliveryStatus.PENDING };
  deliveryDetails.quoteStatus = result.status;
  if (result.status === QuoteStatus.QUOTED) {
    deliveryDetails.fee = result.fee;
    deliveryDetails.vehicleTier = result.tier;
    deliveryDetails.distanceKm = result.distanceKm;
    deliveryDetails.feeApplied = false;
  } else {
    deliveryDetails.fee = undefined;
    deliveryDetails.vehicleTier = undefined;
    deliveryDetails.distanceKm = undefined;
    deliveryDetails.feeApplied = undefined;
  }
  order.deliveryDetails = deliveryDetails as IOrder['deliveryDetails'];
  await order.save();

  if (result.status !== QuoteStatus.QUOTED) {
    logger.warn(
      `${TAG} order ${orderNumber} not quotable: ${result.status}` +
        `${result.zoneName ? ` (zone ${result.zoneName})` : ''} — offering collection`,
    );
    await whatsappMessager.sendInteractive(
      from,
      messageComposer.messageWithReplyButtons({
        text:
          `Sorry — we can't deliver order ${orderNumber} to that location 😕\n\n` +
          `You can send a different pin to try again, or collect from the shop instead.`,
        buttons: [collectButton(orderNumber)],
      }),
    );
    return;
  }

  if (result.fee.currency !== ORDER_CURRENCY) {
    // The vendor priced this cell in a currency the payment path can't fold
    // into the order total — hand over to the shop rather than mis-charge.
    logger.warn(
      `${TAG} order ${orderNumber} quoted ${formatMoney(result.fee)} but orders charge in ` +
        `${ORDER_CURRENCY} — flagging for manual handling`,
    );
    await whatsappMessager.sendFreeFormTextMessage(
      from,
      `We've received your delivery location for order ${orderNumber}. The shop will confirm your delivery fee shortly.`,
    );
    return;
  }

  const itemsTotal = order.totalAmount;
  const newTotal = Math.round((itemsTotal + toMajorUnits(result.fee)) * 100) / 100;
  const distanceNote =
    result.distanceKm !== undefined ? ` (~${result.distanceKm.toFixed(1)} km)` : '';

  await whatsappMessager.sendInteractive(
    from,
    messageComposer.messageWithReplyButtons({
      text:
        `Delivery quote for order ${orderNumber}:\n\n` +
        `📍 Area: ${result.zoneName}${distanceNote}\n` +
        `🚚 Vehicle: ${result.vehicleName}\n` +
        `💰 Delivery fee: ${formatMoney(result.fee)}\n\n` +
        `New total: ${ORDER_CURRENCY} ${newTotal.toFixed(2)} ` +
        `(items ${ORDER_CURRENCY} ${itemsTotal.toFixed(2)} + delivery ${formatMoney(result.fee)})\n\n` +
        `Confirm to proceed with payment.`,
      buttons: [
        {
          type: 'reply',
          reply: { id: buildDeliveryConfirmButtonId(orderNumber), title: 'Confirm & pay' },
        },
        collectButton(orderNumber),
      ],
    }),
  );
};

/**
 * "Confirm & pay" tap: fold the quoted fee into the order total exactly once
 * (`feeApplied` latch — a double tap re-enters payment, never re-adds the fee)
 * and kick off payment.
 */
export const handleDeliveryQuoteConfirm = async (
  from: string,
  orderNumber: string,
): Promise<void> => {
  const order = await OrderModel.findOne({ orderNumber });
  if (!order) {
    logger.warn(`${TAG} confirm tap for unknown order ${orderNumber} from ${from}`);
    await whatsappMessager.sendFreeFormTextMessage(
      from,
      'Sorry, we could not locate your order. Please start a new order from the catalog.',
    );
    return;
  }

  const deliveryDetails = order.deliveryDetails;
  if (deliveryDetails?.quoteStatus !== QuoteStatus.QUOTED || !deliveryDetails.fee) {
    logger.warn(`${TAG} confirm tap for order ${orderNumber} without a valid quote`);
    await whatsappMessager.sendFreeFormTextMessage(
      from,
      'That delivery quote is no longer available. Please share your location pin again.',
    );
    return;
  }

  if (!deliveryDetails.feeApplied) {
    order.totalAmount =
      Math.round((order.totalAmount + toMajorUnits(deliveryDetails.fee)) * 100) / 100;
    deliveryDetails.feeApplied = true;
    await order.save();
    logger.info(
      `${TAG} order ${orderNumber} delivery fee ${formatMoney(deliveryDetails.fee)} applied — ` +
        `new total ${order.totalAmount.toFixed(2)}`,
    );
  }

  await initiateOrderPayment(from, orderNumber);
};

/**
 * "Collect instead" tap: switch the order to collection and charge the
 * items-only total. The quote stays on the order as a record, but the fee is
 * never applied. Refused after the fee is confirmed — that change is the
 * shop's call once payment is in motion.
 */
export const handleDeliverySwitchToCollect = async (
  from: string,
  orderNumber: string,
): Promise<void> => {
  const order = await OrderModel.findOne({ orderNumber });
  if (!order) {
    logger.warn(`${TAG} collect tap for unknown order ${orderNumber} from ${from}`);
    await whatsappMessager.sendFreeFormTextMessage(
      from,
      'Sorry, we could not locate your order. Please start a new order from the catalog.',
    );
    return;
  }

  if (order.deliveryDetails?.feeApplied) {
    logger.info(`${TAG} collect tap after fee confirmed on ${orderNumber} — refusing switch`);
    await whatsappMessager.sendFreeFormTextMessage(
      from,
      `Order ${orderNumber} is already confirmed for delivery. Please contact the shop if you'd like to change it.`,
    );
    return;
  }

  const deliveryDetails = order.deliveryDetails ?? { status: DeliveryStatus.PENDING };
  deliveryDetails.method = DeliveryMethod.COLLECT;
  order.deliveryDetails = deliveryDetails as IOrder['deliveryDetails'];
  await order.save();

  await whatsappMessager.sendFreeFormTextMessage(
    from,
    `No problem! We'll have order ${orderNumber} ready for collection at the shop.`,
  );
  await initiateOrderPayment(from, orderNumber);
};
