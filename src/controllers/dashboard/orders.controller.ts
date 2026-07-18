import type { Request, Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { logger } from '../../services/logger.ts';
import OrderModel from '../../models/Order.ts';
import { OrderItem } from '../../models/OrderItem.ts';
import VendorUser from '../../models/VendorUser.ts';
import {
  OrderStatus,
  DeliveryMethod,
  DeliveryStatus,
  UserRole,
  VendorUserStatus,
} from '../../constants/models.ts';

const TAG = '[dashboard-orders]';

// All handlers run behind dashboardAuthResolver, which establishes the tenant
// context for the request — model calls here are tenant-scoped automatically.

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? 'Invalid request.';

const objectIdSchema = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v), { message: 'Invalid id.' });

// A delivery order with no driver yet — the "needs attention" set the sidebar
// badge and the Unassigned filter both key on. Excludes terminal orders.
const UNASSIGNED_DELIVERY_FILTER = {
  'deliveryDetails.method': DeliveryMethod.DOOR_DELIVERY,
  'deliveryDetails.assignment': { $exists: false },
  'deliveryDetails.status': { $ne: DeliveryStatus.DELIVERED },
  status: { $nin: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] },
} as const;

// --- List --------------------------------------------------------------------

const listQuerySchema = z.object({
  status: z.enum(OrderStatus).optional(),
  deliveryMethod: z.enum(DeliveryMethod).optional(),
  unassigned: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /dashboard/orders — newest first, paginated. `unassigned=true` narrows to
// delivery orders still needing a driver.
export const listOrdersHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { status, deliveryMethod, unassigned, page, limit } = parsed.data;

  const filter: Record<string, unknown> = {};
  if (status) {
    filter.status = status;
  }
  if (deliveryMethod) {
    filter['deliveryDetails.method'] = deliveryMethod;
  }
  if (unassigned) {
    Object.assign(filter, UNASSIGNED_DELIVERY_FILTER);
  }

  try {
    const [orders, total] = await Promise.all([
      OrderModel.find(filter)
        .sort({ orderDate: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('deliveryDetails.address')
        .lean(),
      OrderModel.countDocuments(filter),
    ]);
    res.status(200).json({ orders, total, page, limit });
  } catch (err) {
    logger.error(`${TAG} list failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not load orders. Please try again.' });
  }
};

// GET /dashboard/nav/counts — sidebar badges. `orders` = delivery orders still
// needing a driver (the dashboard-only "alert the attendant" signal). The other
// counters are placeholders until their features land.
export const navCountsHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const unassigned = await OrderModel.countDocuments(UNASSIGNED_DELIVERY_FILTER);
    res.status(200).json({ chats: 0, orders: unassigned, tickets: 0, notifications: 0 });
  } catch (err) {
    logger.error(`${TAG} counts failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not load nav counts.' });
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
    const order = await OrderModel.findById(id.data)
      .populate('deliveryDetails.address')
      .populate('deliveryDetails.assignment.driver', 'name email phoneNumber role status')
      .lean();
    if (!order) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    const items = await OrderItem.find({ orderNumber: order.orderNumber })
      .select('sku productNameSnapshot productTypeSnapshot quantity priceAtOrder')
      .lean();
    res.status(200).json({ order, items });
  } catch (err) {
    logger.error(`${TAG} get failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not load the order. Please try again.' });
  }
};

// --- Driver allocation -------------------------------------------------------

const assignSchema = z.object({
  // null clears the current assignment (order returns to the unassigned pool).
  driverId: objectIdSchema.nullable(),
});

// POST /dashboard/orders/:id/assign-driver — allocate (or clear) the driver on
// a delivery order. The driver must be one of the tenant's VendorUser seats
// with role DRIVER; the lookup is tenant-scoped, so a foreign id is a plain 404.
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

  try {
    const order = await OrderModel.findById(id.data);
    if (!order) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    if (order.deliveryDetails?.method !== DeliveryMethod.DOOR_DELIVERY) {
      res.status(409).json({ error: 'Only delivery orders can have a driver assigned.' });
      return;
    }

    if (parsed.data.driverId === null) {
      order.deliveryDetails.assignment = undefined;
      await order.save();
      logger.info(`${TAG} cleared driver on order ${order.orderNumber}`);
      res.status(200).json({ order: order.toObject() });
      return;
    }

    const driver = await VendorUser.findById(parsed.data.driverId)
      .select('name email role status')
      .lean();
    if (!driver || driver.role !== UserRole.DRIVER) {
      res.status(404).json({ error: 'Driver not found.' });
      return;
    }
    if (driver.status === VendorUserStatus.DISABLED) {
      res.status(409).json({ error: 'That driver seat is disabled.' });
      return;
    }

    order.deliveryDetails.assignment = {
      driver: driver._id as Types.ObjectId,
      driverNameSnapshot: driver.name ?? driver.email,
      assignedAt: new Date(),
    };
    await order.save();
    logger.info(
      `${TAG} assigned driver ${String(driver._id)} (${driver.name ?? driver.email}) ` +
        `to order ${order.orderNumber}`,
    );
    res.status(200).json({ order: order.toObject() });
  } catch (err) {
    logger.error(`${TAG} assign failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not assign the driver. Please try again.' });
  }
};
