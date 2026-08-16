import type { Types } from 'mongoose';
import { logger } from '../../services/logger.ts';
import { requireTenantId } from '../../context/tenantContext.ts';
import type { IOrder } from '../../models/Order.ts';
import { upsertDeliveryForOrder } from '../../delivery/index.ts';
import type { IDelivery } from '../../delivery/index.ts';
import type { DeliveryMethod } from '../../constants/models.ts';

const TAG = '[ORDER_DELIVERY]';

/**
 * Link an order to its fulfilment job, creating the job if it doesn't exist.
 *
 * The order↔delivery relationship is recorded from both ends, which means one
 * relationship stored twice — so this is the ONLY function allowed to write
 * either side. Anything that needs an order to have a delivery calls this;
 * nothing calls `upsertDeliveryForOrder` directly, and nothing assigns
 * `order.delivery` by hand.
 *
 * This has to live host-side rather than in the delivery module: it touches the
 * Order model, and the module's whole boundary is that it imports no host
 * business model.
 *
 * Idempotent — re-running only re-points the method (and the pointer, if it was
 * ever missing). Safe to call on every pass through the order flow.
 *
 * Saves the order if the pointer changed, so callers may pass an order they are
 * still editing; the extra save is harmless.
 *
 * Must run inside the tenant context.
 */
export const ensureOrderDelivery = async (
  order: IOrder,
  method: DeliveryMethod,
  address?: Types.ObjectId,
): Promise<IDelivery> => {
  const tenantId = requireTenantId('order delivery link');

  const delivery = await upsertDeliveryForOrder(tenantId, {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    method,
    address,
  });

  // Only write when it would actually change something — an order whose pointer
  // is already correct is the common case.
  if (String(order.delivery ?? '') !== String(delivery._id)) {
    order.delivery = delivery._id as Types.ObjectId;
    await order.save();
    logger.info(`${TAG} order ${order.orderNumber} linked to delivery ${String(delivery._id)}`);
  }

  return delivery;
};
