import mongoose from 'mongoose';
import { logger } from '../../services/logger.ts';
import whatsappMessager from '../whatsapp/outgoingMessages.ts';
import OrderModel from '../../models/Order.ts';
import UserModel from '../../models/User.ts';
import { DeliveryMethod, DeliveryStatus, OrderStatus } from '../../constants/models.ts';
import { requireTenantId } from '../../context/tenantContext.ts';
import { advanceDelivery } from '../../delivery/index.ts';
import type { DeliveryTransition, IDelivery } from '../../delivery/index.ts';

const TAG = '[DELIVERY_STATUS]';

export type { DeliveryTransition };

export type DeliveryStatusFailure = 'not_found' | 'no_delivery_details' | 'backwards';

export type DeliveryStatusResult =
  | { ok: true; delivery: IDelivery; changed: boolean }
  | { ok: false; reason: DeliveryStatusFailure };

// The same two milestones read differently depending on how the customer is
// getting their order, so each method gets its own wording. Collection orders
// deliberately share the lifecycle: "shipped" is ready-for-pickup and
// "delivered" is collected, which keeps one board and one set of controls.
const CUSTOMER_MESSAGE: Record<
  DeliveryMethod,
  Record<DeliveryTransition, (n: string) => string>
> = {
  [DeliveryMethod.DOOR_DELIVERY]: {
    [DeliveryStatus.SHIPPED]: (orderNumber) =>
      `🚚 Your order ${orderNumber} is on its way! Our driver will be with you shortly.`,
    [DeliveryStatus.DELIVERED]: (orderNumber) =>
      `✅ Your order ${orderNumber} has been delivered. Thank you for shopping with us!`,
  },
  [DeliveryMethod.COLLECT]: {
    [DeliveryStatus.SHIPPED]: (orderNumber) =>
      `📦 Your order ${orderNumber} is packed and ready for collection at the shop.`,
    [DeliveryStatus.DELIVERED]: (orderNumber) =>
      `✅ Your order ${orderNumber} has been collected. Thank you for shopping with us!`,
  },
};

/**
 * Move an order's fulfilment job to the next milestone, complete the order when
 * it lands, and tell the customer.
 *
 * The lifecycle itself (forward-only, idempotent, timestamped) belongs to the
 * delivery module — this is the host-side orchestration around it: the order
 * status it implies, and the WhatsApp message it warrants.
 *
 * Payment is deliberately left alone. A cash-on-delivery order is settled by
 * whoever takes the money, and marking a delivery done must never silently
 * assert that cash was received.
 *
 * Must run inside the tenant context (dashboardAuthResolver establishes it).
 */
export const advanceDeliveryStatus = async (
  orderId: string,
  next: DeliveryTransition,
): Promise<DeliveryStatusResult> => {
  const tenantId = requireTenantId('delivery status transition');

  const session = await mongoose.startSession();
  let outcome: DeliveryStatusResult | undefined;
  try {
    await session.withTransaction(async () => {
      // Load the order first so an orphaned delivery can never advance. For a
      // DELIVERED transition, this order write and the delivery milestone must
      // commit together or neither does.
      const order = await OrderModel.findById(orderId).session(session);
      if (!order) {
        outcome = { ok: false, reason: 'not_found' };
        return;
      }

      const result = await advanceDelivery(tenantId, orderId, next, session);
      if (!result.ok) {
        // The job is created the moment the customer picks a fulfilment method,
        // so its absence means they never got that far.
        outcome = {
          ok: false,
          reason: result.reason === 'not_found' ? 'no_delivery_details' : 'backwards',
        };
        return;
      }

      let changed = result.changed;
      // Reconcile legacy/partial state too: if the delivery already reached
      // DELIVERED but its order did not, a retry must complete the order rather
      // than returning early as an unchanged no-op.
      if (next === DeliveryStatus.DELIVERED && order.status !== OrderStatus.COMPLETED) {
        order.status = OrderStatus.COMPLETED;
        await order.save({ session });
        changed = true;
      }

      outcome = { ok: true, delivery: result.delivery, changed };
    });
  } finally {
    await session.endSession();
  }

  if (!outcome) {
    throw new Error('Delivery status transaction completed without a result');
  }
  if (!outcome.ok || !outcome.changed) {
    return outcome;
  }

  const delivery = outcome.delivery;
  const order = await OrderModel.findById(orderId);
  if (!order) {
    // The transaction verified the order, so reaching this means it was
    // deleted immediately after commit. The milestone remains authoritative.
    logger.error(`${TAG} delivery ${String(delivery._id)} lost order ${orderId} after commit`);
    return outcome;
  }

  // Best-effort notification: the milestone is the record of truth and must
  // stand even if WhatsApp rejects the send (most likely cause: the customer's
  // 24-hour service window has closed, which needs a template, not a retry).
  try {
    const customer = await UserModel.findById(order.user).select('phoneNumber').lean();
    if (customer?.phoneNumber) {
      const text = CUSTOMER_MESSAGE[delivery.method][next](delivery.orderNumber);
      await whatsappMessager.sendFreeFormTextMessage(customer.phoneNumber, text);
    } else {
      logger.warn(`${TAG} order ${delivery.orderNumber} has no customer phone — not notifying`);
    }
  } catch (err) {
    logger.error(
      `${TAG} could not notify the customer for order ${delivery.orderNumber}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return outcome;
};
