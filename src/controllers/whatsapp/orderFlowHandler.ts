import { logger } from '../../services/logger.ts';
import whatsappMessager from './outgoingMessages.ts';
import OrderModel from '../../models/Order.ts';
import { getRedisHashValue } from '../redis/redis.controller.ts';
import {
  PaymentMethod,
  DeliveryMethod,
  PaymentStatus,
  DeliveryStatus,
} from '../../constants/models.ts';
import { sanitizeText, sanitizePhone } from '../../utils/sanitize.ts';
import type { OrderFlowResponse } from '../../constants/orderFlow.ts';
import { promptForLocation } from '../delivery/deliveryFlowHandler.ts';
import { initiateOrderPayment } from '../payments/payment.controller.ts';
import { sendOrderDetailsFlow } from './whatsappOrderHandler.ts';
import { resolveUserByPhone, resolveDeliveryAddress } from '../delivery/deliveryAddress.controller.ts';
import type { Types } from 'mongoose';

const isPaymentMethod = (value: unknown): value is PaymentMethod =>
  typeof value === 'string' && (Object.values(PaymentMethod) as string[]).includes(value);

const isDeliveryMethod = (value: unknown): value is DeliveryMethod =>
  typeof value === 'string' && (Object.values(DeliveryMethod) as string[]).includes(value);

/**
 * Handles the completed order-details flow. The payload arrives via
 * `nfm_reply.response_json` and is routed here by the nfm-reply handler when
 * the flow_token matches ORDER_DETAILS_FLOW_TOKEN.
 *
 * Captures + sanitises the customer/payment/delivery details and persists them
 * onto the pending order created earlier by `whatsappOrderHandler` (located via
 * the orderNumber stashed in Redis under the sender's hash).
 */
export const orderFlowHandler = async (from: string, payload: OrderFlowResponse): Promise<void> => {
  logger.info(`[ORDER_FLOW] Processing order-details flow completion from: ${from}`);

  const customerName = sanitizeText(payload.full_name);
  const paymentMethod = isPaymentMethod(payload.payment_method)
    ? payload.payment_method
    : undefined;
  const deliveryMethod = isDeliveryMethod(payload.delivery_method)
    ? payload.delivery_method
    : undefined;
  const ecocashNumber =
    paymentMethod === PaymentMethod.ECOCASH ? sanitizePhone(payload.ecocash_number) : undefined;

  // EcoCash settles to a specific wallet, so the number is mandatory. The flow
  // marks it required client-side, but enforce it here too — re-send the form
  // rather than charge the wrong number if it's missing.
  if (paymentMethod === PaymentMethod.ECOCASH && !ecocashNumber) {
    logger.warn(`[ORDER_FLOW] EcoCash selected without a number from ${from}, re-sending form`);
    await sendOrderDetailsFlow(from);
    return;
  }

  // Address fields are only collected (and only meaningful) for door
  // delivery. They feed straight into the DeliveryAddress document below;
  // Order itself only holds the foreign key.
  const typedAddress =
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

    if (customerName) {
      order.customerName = customerName;
    }

    order.paymentDetails.status = order.paymentDetails.status ?? PaymentStatus.PENDING;
    if (paymentMethod) {
      order.paymentDetails.method = paymentMethod;
    }
    if (ecocashNumber) {
      order.paymentDetails.mobileNumber = ecocashNumber;
    }

    if (deliveryMethod) {
      order.deliveryDetails = {
        method: deliveryMethod,
        status: order.deliveryDetails?.status ?? DeliveryStatus.PENDING,
        address: order.deliveryDetails?.address,
      };
    }

    if (deliveryMethod === DeliveryMethod.DOOR_DELIVERY && typedAddress) {
      const user = await resolveUserByPhone(from);
      const userId = user._id as Types.ObjectId;
      const addressId = await resolveDeliveryAddress({
        userId,
        existingAddressId: order.deliveryDetails?.address as Types.ObjectId | undefined,
        typed: typedAddress,
      });
      order.user = userId;
      order.deliveryDetails = {
        ...order.deliveryDetails,
        address: addressId,
      } as typeof order.deliveryDetails;
    }

    await order.save();
    logger.info(`[ORDER_FLOW] Order ${orderNumber} updated with flow details for ${from}`);

    // For door delivery we still need the GPS pin — Zim addresses aren't
    // reliably geocodable, so the typed address alone won't get the driver
    // to the door. Payment is kicked off later, once the pin lands (see
    // handleDeliveryLocation).
    if (deliveryMethod === DeliveryMethod.DOOR_DELIVERY) {
      await promptForLocation(from);
      return;
    }

    // Collect/pickup: nothing more to gather, so charge straight away.
    await whatsappMessager.sendFreeFormTextMessage(
      from,

      `Thanks${customerName ? `, ${customerName}` : ''}! We've captured your details for order ${orderNumber}.`,
    );
    await initiateOrderPayment(from, orderNumber);
  } catch (error) {
    logger.error(`[ORDER_FLOW] Error saving flow details for ${from}:`, error);
    await whatsappMessager.sendFreeFormTextMessage(
      from,
      'Sorry, we ran into an issue saving your details. Please try again.',
    );
  }
};
