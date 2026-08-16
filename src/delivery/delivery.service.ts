import { Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { logger } from '../services/logger.ts';
import { runWithTenant } from '../context/tenantContext.ts';
import { DeliveryStatus, DeliveryMethod } from '../constants/models.ts';
import DeliveryModel from './models/Delivery.ts';
import type { IDelivery } from './models/Delivery.ts';

const TAG = '[DELIVERY_JOB]';

// Forward-only lifecycle. The shop moves a job along it; there is no path back,
// because "un-delivering" an order is a support conversation, not a toggle.
const STATUS_ORDER: readonly DeliveryStatus[] = [
  DeliveryStatus.PENDING,
  DeliveryStatus.SHIPPED,
  DeliveryStatus.DELIVERED,
];

const rank = (status: DeliveryStatus): number => STATUS_ORDER.indexOf(status);

// The two states the shop can move a job into (PENDING is where it starts).
export type DeliveryTransition = DeliveryStatus.SHIPPED | DeliveryStatus.DELIVERED;

export interface DeliveryJobInput {
  orderId: string;
  orderNumber: string;
  method: DeliveryMethod;
  // The drop-off address, when the caller already resolved one. Omitted leaves
  // any existing address alone rather than clearing it.
  address?: Types.ObjectId;
}

export interface DeliveryQuery {
  status?: DeliveryStatus;
  method?: DeliveryMethod;
  // true → door deliveries with nobody allocated yet. Collection orders are
  // excluded: they never need a driver, so counting them as "unassigned" would
  // put permanent work on a queue that is supposed to reach zero.
  unassigned?: boolean;
}

/**
 * Create (or update) the fulfilment job for an order.
 *
 * The single entry point for "this order's fulfilment method is now X" — both
 * at checkout, when the customer first picks a method, and later if they switch
 * to collection. Being the only writer of `method` is what keeps the
 * denormalized copy honest.
 *
 * Never resets lifecycle state: a re-run only ever re-points the method, so a
 * customer switching to collection mid-flow doesn't rewind a job already
 * dispatched.
 */
export const upsertDeliveryForOrder = (
  tenantId: string,
  input: DeliveryJobInput,
): Promise<IDelivery> =>
  runWithTenant(tenantId, async () => {
    const set: Record<string, unknown> = { method: input.method };
    if (input.address) {
      set.address = input.address;
    }

    const update: Record<string, unknown> = {
      $set: set,
      $setOnInsert: {
        order: input.orderId,
        orderNumber: input.orderNumber,
        status: DeliveryStatus.PENDING,
      },
    };

    // A switch to collection retires any driver: nobody is carrying an order
    // the customer is coming to fetch. Applying this on every collection
    // upsert also repairs an inconsistent pre-existing assignment.
    if (input.method === DeliveryMethod.COLLECT) {
      update.$unset = {
        driver: 1,
        driverNameSnapshot: 1,
        assignedAt: 1,
      };
    }

    // The tenant plugin adds tenantId to this equality filter, so the compound
    // unique index on (tenantId, order) makes concurrent retries converge on
    // one document instead of racing through a read followed by create.
    const delivery = await DeliveryModel.findOneAndUpdate({ order: input.orderId }, update, {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    });
    if (!delivery) {
      throw new Error(`Delivery upsert returned no document for order ${input.orderNumber}`);
    }
    return delivery;
  });

export const getDeliveryByOrder = (tenantId: string, orderId: string): Promise<IDelivery | null> =>
  runWithTenant(tenantId, () => DeliveryModel.findOne({ order: orderId }));

export const getDeliveryByOrderNumber = (
  tenantId: string,
  orderNumber: string,
): Promise<IDelivery | null> =>
  runWithTenant(tenantId, () => DeliveryModel.findOne({ orderNumber }));

// Translate a board query into a Mongo filter. Shared by the list and the
// count so a badge can never disagree with the tab it points at.
const toFilter = (query: DeliveryQuery): Record<string, unknown> => {
  const filter: Record<string, unknown> = {};
  if (query.status) {
    filter.status = query.status;
  }
  if (query.method) {
    filter.method = query.method;
  }
  if (query.unassigned) {
    filter.method = DeliveryMethod.DOOR_DELIVERY;
    filter.driver = { $exists: false };
    filter.status = { $ne: DeliveryStatus.DELIVERED };
  }
  return filter;
};

export interface DeliveryPage {
  deliveries: IDelivery[];
  total: number;
}

/**
 * The board's working list: newest first, paginated, with the order populated
 * so a row can show the customer and the fee.
 *
 * `populate` issues its own query per collection rather than a `$lookup`, so
 * every hop stays inside the tenant scope (the plugin refuses `$lookup`
 * precisely because it cannot scope the joined collection).
 */
export const listDeliveries = (
  tenantId: string,
  query: DeliveryQuery,
  page: number,
  limit: number,
): Promise<DeliveryPage> =>
  runWithTenant(tenantId, async () => {
    const filter = toFilter(query);
    const [deliveries, total] = await Promise.all([
      DeliveryModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        // The drop-off address hangs off the job itself now, so a board row is
        // one populate for the customer/total and one for the address. Each hop
        // is its own scoped query, not a $lookup.
        .populate('order', 'orderNumber customerName totalAmount status orderDate paymentDetails')
        .populate('address')
        .populate('driver', 'name phoneNumber active'),
      DeliveryModel.countDocuments(filter),
    ]);
    return { deliveries, total };
  });

export const countDeliveries = (tenantId: string, query: DeliveryQuery): Promise<number> =>
  runWithTenant(tenantId, () => DeliveryModel.countDocuments(toFilter(query)));

export type AssignFailure = 'not_found' | 'not_a_delivery';
export type AssignResult = { ok: true; delivery: IDelivery } | { ok: false; reason: AssignFailure };

/**
 * Allocate (or clear) the driver on a fulfilment job. Passing a null driver
 * returns the job to the unassigned pool.
 *
 * The caller has already validated that the driver is on this tenant's roster
 * and available — this only records the decision.
 */
export const assignDriver = (
  tenantId: string,
  orderId: string,
  driver: { id: string; name: string } | null,
): Promise<AssignResult> =>
  runWithTenant(tenantId, async (): Promise<AssignResult> => {
    const delivery = await DeliveryModel.findOne({ order: orderId });
    if (!delivery) {
      return { ok: false, reason: 'not_found' };
    }
    if (driver && delivery.method !== DeliveryMethod.DOOR_DELIVERY) {
      return { ok: false, reason: 'not_a_delivery' };
    }

    if (driver) {
      delivery.driver = new Types.ObjectId(driver.id);
      delivery.driverNameSnapshot = driver.name;
      delivery.assignedAt = new Date();
    } else {
      delivery.driver = undefined;
      delivery.driverNameSnapshot = undefined;
      delivery.assignedAt = undefined;
    }
    await delivery.save();
    logger.info(
      `${TAG} order ${delivery.orderNumber} ${
        driver ? `assigned to ${driver.name}` : 'returned to the unassigned pool'
      }`,
    );
    return { ok: true, delivery };
  });

export type TransitionFailure = 'not_found' | 'backwards';
export type TransitionResult =
  | { ok: true; delivery: IDelivery; changed: boolean }
  | { ok: false; reason: TransitionFailure };

/**
 * Move a job to the next milestone, stamping when it happened.
 *
 * Re-applying the current status is a no-op success (`changed: false`) so a
 * double-tap never re-stamps or re-notifies; moving backwards is refused.
 * Jumping straight to DELIVERED backfills the dispatch time, or the elapsed
 * duration reads as if the order was never sent out.
 */
export const advanceDelivery = (
  tenantId: string,
  orderId: string,
  next: DeliveryTransition,
  session?: ClientSession,
): Promise<TransitionResult> =>
  runWithTenant(tenantId, async (): Promise<TransitionResult> => {
    const delivery = await DeliveryModel.findOne({ order: orderId }).session(session ?? null);
    if (!delivery) {
      return { ok: false, reason: 'not_found' };
    }

    const current = delivery.status;
    if (current === next) {
      return { ok: true, delivery, changed: false };
    }
    if (rank(next) < rank(current)) {
      return { ok: false, reason: 'backwards' };
    }

    const now = new Date();
    delivery.status = next;
    if (next === DeliveryStatus.SHIPPED) {
      delivery.dispatchedAt = now;
    }
    if (next === DeliveryStatus.DELIVERED) {
      delivery.deliveredAt = now;
      delivery.dispatchedAt = delivery.dispatchedAt ?? now;
    }
    await delivery.save({ session });
    logger.info(`${TAG} order ${delivery.orderNumber}: ${current} → ${next}`);
    return { ok: true, delivery, changed: true };
  });
