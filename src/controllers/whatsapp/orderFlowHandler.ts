import { logger } from '../../services/logger';
import whatsappMessager from './outgoingMessages';
import OrderModel from '../../models/Order';
import { getRedisHashValue } from '../redis/redis.controller';
import {
  PaymentMethod,
  DeliveryMethod,
  PaymentStatus,
  DeliveryStatus,
} from '../../constants/models';
import { sanitizeText, sanitizePhone } from '../../utils/sanitize';
import type { OrderFlowResponse } from '../../constants/orderFlow';

const isPaymentMethod = (value: unknown): value is PaymentMethod =>
  typeof value === 'string' &&
  (Object.values(PaymentMethod) as string[]).includes(value);

const isDeliveryMethod = (value: unknown): value is DeliveryMethod =>
  typeof value === 'string' &&
  (Object.values(DeliveryMethod) as string[]).includes(value);

/**
 * Handles the completed order-details flow. The payload arrives via
 * `nfm_reply.response_json` and is routed here by the nfm-reply handler when
 * the flow_token matches ORDER_DETAILS_FLOW_TOKEN.
 *
 * Captures + sanitises the customer/payment/delivery details and persists them
 * onto the pending order created earlier by `whatsappOrderHandler` (located via
 * the orderNumber stashed in Redis under the sender's hash).
 */
export const orderFlowHandler = async (
  from: string,
  payload: OrderFlowResponse,
): Promise<void> => {
  logger.info(`[ORDER_FLOW] Processing order-details flow completion from: ${from}`);

  const customerName = sanitizeText(payload.full_name);
  const paymentMethod = isPaymentMethod(payload.payment_method)
    ? payload.payment_method
    : undefined;
  const deliveryMethod = isDeliveryMethod(payload.delivery_method)
    ? payload.delivery_method
    : undefined;
  const ecocashNumber =
    paymentMethod === PaymentMethod.ECOCASH
      ? sanitizePhone(payload.ecocash_number)
      : undefined;

  // Address is only collected (and only meaningful) for door delivery.
  const address =
    deliveryMethod === DeliveryMethod.DOOR_DELIVERY
      ? {
          street: sanitizeText(payload.street),
          suburb: sanitizeText(payload.suburb),
          area: sanitizeText(payload.area),
          town: sanitizeText(payload.town),
        }
      : undefined;

  // Correlate the flow response back to the order created at catalog checkout.
  const orderNumber = await getRedisHashValue(from, 'orderNumber');
  if (!orderNumber) {
    logger.warn(`[ORDER_FLOW] No active order found in session for ${from}`);
    await whatsappMessager.sendFreeFormTextMessage(
      from,
      // eslint-disable-next-line max-len
      "We couldn't find an active order to attach these details to. Please start a new order from the catalog.",
    );
    return;
  }

  try {
    const order = await OrderModel.findOne({ orderNumber });
    if (!order) {
      logger.warn(`[ORDER_FLOW] Order ${orderNumber} not found for ${from}`);
      await whatsappMessager.sendFreeFormTextMessage(
        from,
        'Sorry, we could not locate your order. Please try again.',
      );
      return;
    }

    if (customerName) {order.customerName = customerName;}

    order.paymentDetails.status = order.paymentDetails.status ?? PaymentStatus.PENDING;
    if (paymentMethod) {order.paymentDetails.method = paymentMethod;}
    if (ecocashNumber) {order.paymentDetails.mobileNumber = ecocashNumber;}

    if (deliveryMethod) {
      order.deliveryDetails = {
        method: deliveryMethod,
        status: order.deliveryDetails?.status ?? DeliveryStatus.PENDING,
        ...(address ? { address } : {}),
      };
    }

    await order.save();
    logger.info(`[ORDER_FLOW] Order ${orderNumber} updated with flow details for ${from}`);

    await whatsappMessager.sendFreeFormTextMessage(
      from,
      // eslint-disable-next-line max-len
      `Thanks${customerName ? `, ${customerName}` : ''}! We've captured your details for order ${orderNumber} and will confirm shortly.`,
    );
  } catch (error) {
    logger.error(`[ORDER_FLOW] Error saving flow details for ${from}:`, error);
    await whatsappMessager.sendFreeFormTextMessage(
      from,
      'Sorry, we ran into an issue saving your details. Please try again.',
    );
  }
};
