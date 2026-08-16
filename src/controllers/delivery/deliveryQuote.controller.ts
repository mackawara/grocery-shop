import { logger } from '../../services/logger.ts';
import whatsappMessager, { messageComposer } from '../whatsapp/outgoingMessages.ts';
import OrderModel from '../../models/Order.ts';
import { OrderItem } from '../../models/OrderItem.ts';
import ProductModel from '../../models/Product.ts';
import UserModel from '../../models/User.ts';
import { requireTenantId } from '../../context/tenantContext.ts';
import {
  quoteDelivery,
  computeVehicleRequirement,
  QuoteStatus,
  getDeliveryByOrderNumber,
} from '../../delivery/index.ts';
import type { CartItemPhysicals, GeoPoint, Money } from '../../delivery/index.ts';
import { ensureOrderDelivery } from './orderDelivery.ts';
import { DeliveryMethod } from '../../constants/models.ts';
import {
  buildDeliveryConfirmButtonId,
  buildDeliveryCollectButtonId,
} from '../../constants/delivery.ts';
import { ORDER_CURRENCY } from '../../constants/payments.ts';
import { initiateOrderPayment } from '../payments/payment.controller.ts';

const TAG = '[DELIVERY_QUOTE_FLOW]';

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
 * Ask the customer to confirm the new total before anything is charged.
 * Shared by the automatic quote and the shop's manual override so both offer
 * the identical choice — confirm & pay, or switch to collection — and both land
 * on the same `handleDeliveryQuoteConfirm` latch.
 *
 * `itemsTotal` is the order total *before* the fee: the fee is only folded in
 * on the confirm tap, never here.
 */
const sendFeeConfirmation = async (
  from: string,
  orderNumber: string,
  itemsTotal: number,
  fee: Money,
  detailLines: string[],
): Promise<void> => {
  const newTotal = Math.round((itemsTotal + toMajorUnits(fee)) * 100) / 100;

  await whatsappMessager.sendInteractive(
    from,
    messageComposer.messageWithReplyButtons({
      text:
        `Delivery quote for order ${orderNumber}:\n\n` +
        `${detailLines.join('\n')}\n` +
        `💰 Delivery fee: ${formatMoney(fee)}\n\n` +
        `New total: ${ORDER_CURRENCY} ${newTotal.toFixed(2)} ` +
        `(items ${ORDER_CURRENCY} ${itemsTotal.toFixed(2)} + delivery ${formatMoney(fee)})\n\n` +
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

  const delivery = await getDeliveryByOrderNumber(tenantId, orderNumber);
  if (!delivery) {
    // The job is created the moment the customer picks a method, and the pin
    // only arrives after that — so its absence is a broken flow, not a state.
    logger.warn(`${TAG} order ${orderNumber} has no delivery job — cannot quote`);
    return;
  }

  if (delivery.feeApplied) {
    logger.info(
      `${TAG} order ${orderNumber} fee already confirmed — pin updated, pricing unchanged`,
    );
    await initiateOrderPayment(from, orderNumber);
    return;
  }

  const physicals = await buildCartPhysicals(orderNumber);
  const requirement = computeVehicleRequirement(physicals);
  const result = await quoteDelivery(tenantId, shopOrigin, dropoff, requirement);

  delivery.quoteStatus = result.status;
  if (result.status === QuoteStatus.QUOTED) {
    delivery.fee = result.fee;
    delivery.vehicleTier = result.tier;
    delivery.distanceKm = result.distanceKm;
    delivery.feeApplied = false;
  } else {
    delivery.fee = undefined;
    delivery.vehicleTier = undefined;
    delivery.distanceKm = undefined;
    delivery.feeApplied = undefined;
  }
  await delivery.save();

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

  const distanceNote =
    result.distanceKm !== undefined ? ` (~${result.distanceKm.toFixed(1)} km)` : '';

  await sendFeeConfirmation(from, orderNumber, order.totalAmount, result.fee, [
    `📍 Area: ${result.zoneName}${distanceNote}`,
    `🚚 Vehicle: ${result.vehicleName}`,
  ]);
};

// Why a shop-set fee could not be offered to the customer. Mapped to HTTP by
// the dashboard handler; the flow itself never throws for these.
export type ManualFeeFailure =
  | 'not_found'
  | 'not_delivery'
  | 'already_applied'
  | 'no_customer_phone';

export type ManualFeeResult = { ok: true } | { ok: false; reason: ManualFeeFailure };

/**
 * The shop's manual delivery fee, set from the dashboard.
 *
 * This is the escape hatch for every case the automatic quote can't price —
 * out of area, no fitting vehicle, no rate cell, or a rate card in a currency
 * the payment path can't charge. It writes the same fields the quote engine
 * writes and re-uses the same confirmation prompt, so the customer's "Confirm &
 * pay" tap runs through the identical `feeApplied` latch: the shop sets the
 * price, the customer still consents to it, and the fee is still only ever
 * added once.
 *
 * Refused once the fee is confirmed — at that point pricing is final and money
 * may already be in motion, so a correction is a refund, not an edit.
 *
 * Must run inside the tenant context (dashboardAuthResolver establishes it).
 */
export const applyManualDeliveryFee = async (
  orderNumber: string,
  fee: Money,
): Promise<ManualFeeResult> => {
  const tenantId = requireTenantId('manual delivery fee');

  const order = await OrderModel.findOne({ orderNumber });
  if (!order) {
    return { ok: false, reason: 'not_found' };
  }
  const delivery = await getDeliveryByOrderNumber(tenantId, orderNumber);
  if (!delivery || delivery.method !== DeliveryMethod.DOOR_DELIVERY) {
    return { ok: false, reason: 'not_delivery' };
  }
  if (delivery.feeApplied) {
    return { ok: false, reason: 'already_applied' };
  }

  // The customer is messaged on the number their WhatsApp order came from.
  const customer = await UserModel.findById(order.user).select('phoneNumber').lean();
  if (!customer?.phoneNumber) {
    logger.warn(`${TAG} order ${orderNumber} has no customer phone — cannot offer a manual fee`);
    return { ok: false, reason: 'no_customer_phone' };
  }

  delivery.quoteStatus = QuoteStatus.QUOTED;
  delivery.fee = fee;
  delivery.feeApplied = false;
  await delivery.save();

  logger.info(`${TAG} shop set a manual fee of ${formatMoney(fee)} on order ${orderNumber}`);

  await sendFeeConfirmation(customer.phoneNumber, orderNumber, order.totalAmount, fee, [
    `📍 Delivery to your shared location`,
    `🏪 Fee set by the shop`,
  ]);
  return { ok: true };
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

  const delivery = await getDeliveryByOrderNumber(
    requireTenantId('delivery fee confirmation'),
    orderNumber,
  );
  if (delivery?.quoteStatus !== QuoteStatus.QUOTED || !delivery.fee) {
    logger.warn(`${TAG} confirm tap for order ${orderNumber} without a valid quote`);
    await whatsappMessager.sendFreeFormTextMessage(
      from,
      'That delivery quote is no longer available. Please share your location pin again.',
    );
    return;
  }

  if (!delivery.feeApplied) {
    // The fee is charged through the order total, so two records change: the
    // delivery latches that the fee has been applied, and the order gains the
    // money. The LATCH GOES FIRST, deliberately — these are separate writes,
    // and if the process dies between them the customer is undercharged by the
    // delivery fee rather than charged for it twice. Losing a fee is a
    // reconcilable mistake; double-charging a customer is not.
    delivery.feeApplied = true;
    await delivery.save();
    order.totalAmount = Math.round((order.totalAmount + toMajorUnits(delivery.fee)) * 100) / 100;
    await order.save();
    logger.info(
      `${TAG} order ${orderNumber} delivery fee ${formatMoney(delivery.fee)} applied — ` +
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

  const existing = await getDeliveryByOrderNumber(requireTenantId('collect switch'), orderNumber);
  if (existing?.feeApplied) {
    logger.info(`${TAG} collect tap after fee confirmed on ${orderNumber} — refusing switch`);
    await whatsappMessager.sendFreeFormTextMessage(
      from,
      `Order ${orderNumber} is already confirmed for delivery. Please contact the shop if you'd like to change it.`,
    );
    return;
  }

  // Re-point the fulfilment job: it stops being a delivery and, with it, stops
  // needing a driver.
  await ensureOrderDelivery(order, DeliveryMethod.COLLECT);

  await whatsappMessager.sendFreeFormTextMessage(
    from,
    `No problem! We'll have order ${orderNumber} ready for collection at the shop.`,
  );
  await initiateOrderPayment(from, orderNumber);
};
