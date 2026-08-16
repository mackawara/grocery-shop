import type { Request, Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { logger } from '../../services/logger.ts';
import OrderModel from '../../models/Order.ts';
import { OrderItem } from '../../models/OrderItem.ts';
import { OrderStatus, DeliveryMethod, DeliveryStatus } from '../../constants/models.ts';
import { ORDER_CURRENCY } from '../../constants/payments.ts';
import {
  getDriver,
  getDeliveryByOrder,
  listDeliveries,
  countDeliveries,
  assignDriver,
} from '../../delivery/index.ts';
import type { AssignFailure } from '../../delivery/index.ts';
import type { DashboardActor } from '../middleware/dashboardAuthResolver.ts';
import { applyManualDeliveryFee } from '../delivery/deliveryQuote.controller.ts';
import type { ManualFeeFailure } from '../delivery/deliveryQuote.controller.ts';
import { advanceDeliveryStatus } from '../delivery/deliveryStatus.controller.ts';
import type { DeliveryStatusFailure } from '../delivery/deliveryStatus.controller.ts';
import { notifyDriverOfAssignment } from '../delivery/driverNotification.controller.ts';

const TAG = '[dashboard-orders]';

// All handlers run behind dashboardAuthResolver, which establishes the tenant
// context for the request — model calls here are tenant-scoped automatically.

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? 'Invalid request.';

const objectIdSchema = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v), { message: 'Invalid id.' });

const tenantOf = (res: Response): string => (res.locals.actor as DashboardActor).tenantId;

// --- List --------------------------------------------------------------------

// Orders list only. Everything about the delivery — method, address, quote,
// fee, driver, lifecycle — is on the Delivery job, which this populates through
// the order's `delivery` foreign key. Filtering BY those fields belongs to
// /dashboard/deliveries; you cannot filter a populated field in Mongo, and
// duplicating them back onto the order to make that possible is exactly what
// the split removed.
const listQuerySchema = z.object({
  status: z.enum(OrderStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /dashboard/orders — newest first, paginated, each with its delivery job.
export const listOrdersHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { status, page, limit } = parsed.data;

  const filter: Record<string, unknown> = {};
  if (status) {
    filter.status = status;
  }

  try {
    const [orders, total] = await Promise.all([
      OrderModel.find(filter)
        .sort({ orderDate: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('delivery')
        .lean(),
      OrderModel.countDocuments(filter),
    ]);
    res.status(200).json({ orders, total, page, limit });
  } catch (err) {
    logger.error(`${TAG} list failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not load orders. Please try again.' });
  }
};

// GET /dashboard/nav/counts — sidebar badges. `orders` = deliveries still
// needing a driver (the dashboard-only "alert the attendant" signal), counted
// off the Delivery jobs so the badge and the board's Needs-driver tab are
// answering the identical query. The other counters are placeholders.
export const navCountsHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const unassigned = await countDeliveries(tenantOf(res), { unassigned: true });
    res.status(200).json({ chats: 0, orders: unassigned, tickets: 0, notifications: 0 });
  } catch (err) {
    logger.error(`${TAG} counts failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not load nav counts.' });
  }
};

// --- Delivery board ------------------------------------------------------------

// The fulfilment jobs, filtered the way the board's tabs think: by lifecycle
// stage, by method, or "door deliveries nobody is carrying yet".
const deliveriesQuerySchema = z.object({
  status: z.enum(DeliveryStatus).optional(),
  method: z.enum(DeliveryMethod).optional(),
  unassigned: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /dashboard/deliveries — the delivery board. Newest first, paginated, with
// the order and driver populated so a row is self-contained.
export const listDeliveriesHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = deliveriesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { page, limit, ...query } = parsed.data;

  try {
    const { deliveries, total } = await listDeliveries(tenantOf(res), query, page, limit);
    res.status(200).json({ deliveries, total, page, limit });
  } catch (err) {
    logger.error(`${TAG} deliveries failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not load deliveries. Please try again.' });
  }
};

// --- Detail ------------------------------------------------------------------

// GET /dashboard/orders/:id — the order plus its line items and address.
export const getOrderHandler = async (req: Request, res: Response): Promise<void> => {
  const id = objectIdSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: firstIssue(id.error) });
    return;
  }

  try {
    // The order's `delivery` pointer resolves the fulfilment job in one hop,
    // and the job's own address in a second — populate is per-collection
    // queries, all tenant-scoped, unlike a $lookup.
    const order = await OrderModel.findById(id.data)
      .populate({ path: 'delivery', populate: { path: 'address' } })
      .lean();
    if (!order) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    const items = await OrderItem.find({ orderNumber: order.orderNumber })
      .select('sku productNameSnapshot productTypeSnapshot quantity priceAtOrder')
      .lean();

    // Fall back to the authoritative direction (the job's own uniquely-indexed
    // `order` field) if the pointer is missing — an order that predates the
    // back-reference still has a job, and the detail view should show it.
    const delivery = order.delivery ?? (await getDeliveryByOrder(tenantOf(res), id.data));
    res.status(200).json({ order, items, delivery });
  } catch (err) {
    logger.error(`${TAG} get failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not load the order. Please try again.' });
  }
};

// --- Manual delivery fee -----------------------------------------------------

// The fee the shop sets by hand, in minor units — same convention as the rate
// matrix and `Delivery.fee`. Pinned to the order currency for the same reason
// rate cells are: `Order.totalAmount` carries no currency, so a fee in anything
// else would be confirmed by the customer and then folded into the total as if
// it were the order currency. Reject it here, where the attendant sees why.
const feeSchema = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.literal(ORDER_CURRENCY, {
    message: `Delivery fees must be priced in ${ORDER_CURRENCY}.`,
  }),
});

// Why the flow refused, as an HTTP status + message the attendant can act on.
const MANUAL_FEE_ERRORS: Record<ManualFeeFailure, { status: number; error: string }> = {
  not_found: { status: 404, error: 'Order not found.' },
  not_delivery: { status: 409, error: 'Only delivery orders can have a delivery fee.' },
  already_applied: {
    status: 409,
    error: 'The customer has already confirmed this fee. Refund and re-order to change it.',
  },
  no_customer_phone: {
    status: 409,
    error: 'This order has no customer WhatsApp number to send the quote to.',
  },
};

// POST /dashboard/orders/:id/delivery-fee — set the delivery fee by hand and
// re-send the customer the confirm-and-pay prompt. The rescue path for every
// order the automatic quote could not price (out of area, no vehicle, no rate
// cell). It does NOT charge: the customer still taps Confirm, and the same
// `feeApplied` latch guarantees the fee is folded into the total exactly once.
export const setDeliveryFeeHandler = async (req: Request, res: Response): Promise<void> => {
  const id = objectIdSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: firstIssue(id.error) });
    return;
  }
  const parsed = feeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }

  try {
    // Resolve the order number first: the delivery flow keys on it (as the
    // WhatsApp side does), and the scoped read here is what proves the order
    // belongs to the caller's tenant.
    const order = await OrderModel.findById(id.data).select('orderNumber').lean();
    if (!order) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }

    const result = await applyManualDeliveryFee(order.orderNumber, parsed.data);
    if (!result.ok) {
      const mapped = MANUAL_FEE_ERRORS[result.reason];
      res.status(mapped.status).json({ error: mapped.error });
      return;
    }

    const updated = await OrderModel.findById(id.data).lean();
    logger.info(`${TAG} manual delivery fee set on order ${order.orderNumber}`);
    res.status(200).json({ order: updated });
  } catch (err) {
    logger.error(`${TAG} manual fee failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not set the delivery fee. Please try again.' });
  }
};

// --- Delivery lifecycle ------------------------------------------------------

const statusSchema = z.object({
  status: z.enum([DeliveryStatus.SHIPPED, DeliveryStatus.DELIVERED]),
});

const DELIVERY_STATUS_ERRORS: Record<DeliveryStatusFailure, { status: number; error: string }> = {
  not_found: { status: 404, error: 'Order not found.' },
  no_delivery_details: {
    status: 409,
    error: 'This order has no delivery details yet — the customer has not chosen how to receive it.',
  },
  backwards: {
    status: 409,
    error: 'This order has already moved past that stage.',
  },
};

// POST /dashboard/orders/:id/delivery-status — move an order to the next
// fulfilment milestone (dispatched, then delivered) and notify the customer.
// Forward-only and idempotent; delivering also completes the order.
export const setDeliveryStatusHandler = async (req: Request, res: Response): Promise<void> => {
  const id = objectIdSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: firstIssue(id.error) });
    return;
  }
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }

  try {
    const result = await advanceDeliveryStatus(id.data, parsed.data.status);
    if (!result.ok) {
      const mapped = DELIVERY_STATUS_ERRORS[result.reason];
      res.status(mapped.status).json({ error: mapped.error });
      return;
    }
    res.status(200).json({ delivery: result.delivery.toObject(), changed: result.changed });
  } catch (err) {
    logger.error(
      `${TAG} delivery status failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({ error: 'Could not update the order. Please try again.' });
  }
};

// --- Driver allocation -------------------------------------------------------

const assignSchema = z.object({
  // null clears the current assignment (order returns to the unassigned pool).
  driverId: objectIdSchema.nullable(),
});

const ASSIGN_ERRORS: Record<AssignFailure, { status: number; error: string }> = {
  not_found: {
    status: 404,
    // No job means the customer never chose a fulfilment method — the order
    // exists but has nothing to deliver against yet.
    error: 'This order has no delivery yet — the customer has not chosen how to receive it.',
  },
  not_a_delivery: {
    status: 409,
    error: 'Only door deliveries can have a driver assigned.',
  },
};

// POST /dashboard/orders/:id/assign-driver — allocate (or clear) the driver on
// a delivery order. The driver must be on the tenant's own roster; the lookup
// is tenant-scoped, so a foreign id is a plain 404.
export const assignDriverHandler = async (req: Request, res: Response): Promise<void> => {
  const id = objectIdSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: firstIssue(id.error) });
    return;
  }
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }

  const tenantId = tenantOf(res);

  try {
    // Clearing needs no driver lookup — it just empties the allocation.
    if (parsed.data.driverId === null) {
      const cleared = await assignDriver(tenantId, id.data, null);
      if (!cleared.ok) {
        res.status(ASSIGN_ERRORS[cleared.reason].status).json({
          error: ASSIGN_ERRORS[cleared.reason].error,
        });
        return;
      }
      res.status(200).json({ delivery: cleared.delivery.toObject() });
      return;
    }

    const driver = await getDriver(tenantId, parsed.data.driverId);
    if (!driver) {
      res.status(404).json({ error: 'Driver not found.' });
      return;
    }
    if (!driver.active) {
      res.status(409).json({ error: 'That driver is marked inactive.' });
      return;
    }

    const result = await assignDriver(tenantId, id.data, {
      id: String(driver._id),
      name: driver.name,
    });
    if (!result.ok) {
      res.status(ASSIGN_ERRORS[result.reason].status).json({
        error: ASSIGN_ERRORS[result.reason].error,
      });
      return;
    }

    // Tell the driver on WhatsApp. Deliberately awaited but never allowed to
    // fail the request: the allocation is already saved, and an unreachable
    // driver is a notification problem, not a reason to reject the assignment.
    // The order carries what the driver needs to know (address, total, payment).
    const order = await OrderModel.findById(id.data);
    if (order) {
      await notifyDriverOfAssignment(order, result.delivery, driver);
    }

    res.status(200).json({ delivery: result.delivery.toObject() });
  } catch (err) {
    logger.error(`${TAG} assign failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not assign the driver. Please try again.' });
  }
};
