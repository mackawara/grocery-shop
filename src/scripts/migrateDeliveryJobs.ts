/**
 * Moves fulfilment onto its own records: a `Driver` roster and a `Delivery`
 * job per order.
 *
 * Two changes landed together and this migration carries both, in order,
 * because the second depends on the first:
 *
 *   1. Drivers used to be VendorUser seats with role DRIVER (Authentik identity
 *      + unique email + first-login OTP) purely so the shop could pick a name
 *      off a list. They are now `Driver` records — name and phone, no login.
 *
 *   2. Fulfilment state (driver, lifecycle status, dispatch/delivery times)
 *      used to live on `Order.deliveryDetails`. It is now the `Delivery`
 *      record, one per order, linked from both ends (`Delivery.order` and
 *      `Order.delivery`). Without this backfill, every existing order vanishes
 *      from the delivery board — the board reads Delivery, and there would be
 *      none.
 *
 * For each tenant it creates a Driver per legacy seat (matched on the
 * normalized phone), then a Delivery per order that has a fulfilment method,
 * carrying across the legacy status, timestamps and driver — mapping a legacy
 * VendorUser driver id onto the new Driver via the roster built in step 1.
 *
 * What it deliberately does NOT do:
 *   - delete the old VendorUser seats. They are no longer invitable and their
 *     Authentik identity is untouched, so nothing breaks by keeping them;
 *     deleting a person's login is the shop's call, not a migration's.
 *   - `$unset` the legacy `deliveryDetails` fields. Nothing reads them any more,
 *     and leaving them means this migration stays re-runnable against the
 *     original data if a mapping ever turns out wrong.
 *
 * Idempotent — safe to re-run. Drivers match on (tenant, phone) and deliveries
 * on (tenant, order), so a second pass creates nothing.
 *
 * Usage:  yarn tsx src/scripts/migrateDeliveryJobs.ts
 */
import mongoose from 'mongoose';
import { logger } from '../services/logger.ts';
import { connectDb } from '../services/database.ts';
import Tenant from '../models/Tenant.ts';
import VendorUser from '../models/VendorUser.ts';
import OrderModel from '../models/Order.ts';
import { Driver, Delivery } from '../delivery/index.ts';
import type { Money } from '../delivery/index.ts';
import { UserRole, DeliveryMethod, DeliveryStatus } from '../constants/models.ts';
import type { QuoteStatus, VehicleTier } from '../constants/models.ts';
import { normalizePhone } from '../utils/phone.ts';
import { runWithTenant, runWithoutTenant } from '../context/tenantContext.ts';

const TAG = 'MIGRATE_DELIVERY_JOBS';

// The pre-migration shape of `Order.deliveryDetails`. These paths are gone from
// the schema, but `.lean()` returns the raw stored document, so the values are
// still readable here — which is the whole point of this script.
interface LegacyDeliveryDetails {
  method?: string;
  status?: DeliveryStatus;
  dispatchedAt?: Date;
  deliveredAt?: Date;
  expectedDeliveryDate?: Date;
  address?: mongoose.Types.ObjectId;
  quoteStatus?: QuoteStatus;
  fee?: Money;
  feeApplied?: boolean;
  vehicleTier?: VehicleTier;
  distanceKm?: number;
  assignment?: {
    driver?: mongoose.Types.ObjectId;
    driverNameSnapshot?: string;
    assignedAt?: Date;
  };
}

// The order document as it exists BEFORE this migration. `deliveryDetails` is
// gone from the schema, but `.lean()` returns the raw stored document, so the
// values are still readable — which is the whole point of this script.
interface LegacyOrder {
  _id: mongoose.Types.ObjectId;
  orderNumber: string;
  delivery?: mongoose.Types.ObjectId;
  deliveryDetails?: LegacyDeliveryDetails;
}

interface TenantResult {
  drivers: number;
  deliveries: number;
}

const migrateTenant = async (): Promise<TenantResult> => {
  // --- 1. Driver seats → roster -------------------------------------------
  const seats = await VendorUser.find({ role: UserRole.DRIVER })
    .select('name email phoneNumber')
    .lean();

  // Legacy VendorUser id → new Driver id, so step 2 can re-point assignments
  // that were made before the roster existed.
  const driverBySeatId = new Map<string, { id: mongoose.Types.ObjectId; name: string }>();
  let driversCreated = 0;

  for (const seat of seats) {
    const phoneNumber = normalizePhone(seat.phoneNumber);
    const name = seat.name ?? seat.email;
    let driver = await Driver.findOne({ phoneNumber });
    if (!driver) {
      driver = await Driver.create({
        name,
        phoneNumber,
        active: true,
        notes: 'Migrated from a dashboard staff seat.',
      });
      driversCreated += 1;
    }
    driverBySeatId.set(String(seat._id), {
      id: driver._id as mongoose.Types.ObjectId,
      name: driver.name,
    });
  }

  // --- 2. Order fulfilment state → Delivery jobs ---------------------------
  // Read every order for this tenant and filter in memory. Deliberately NOT a
  // raw-collection query with a `deliveryDetails.method` filter: that would
  // bypass tenantScope and pull every tenant's orders into this tenant's loop.
  // `.lean()` with no projection returns the stored document whole, legacy
  // paths included, which is exactly what this needs — and a migration can
  // afford to read a tenant's orders once.
  const orders = (await OrderModel.find({}).lean()) as unknown as LegacyOrder[];

  let deliveriesCreated = 0;

  // Point an order at its job. Separate from creation so a re-run repairs an
  // order whose pointer is missing even though its job already exists.
  const link = async (orderId: mongoose.Types.ObjectId, deliveryId: mongoose.Types.ObjectId) => {
    await OrderModel.updateOne({ _id: orderId }, { $set: { delivery: deliveryId } });
  };

  for (const order of orders) {
    const legacy = order.deliveryDetails as LegacyDeliveryDetails | undefined;
    const method = legacy?.method;
    // Anything that isn't a known method can't be given a job — the enum is
    // what the board and the lifecycle are built on.
    if (method !== DeliveryMethod.DOOR_DELIVERY && method !== DeliveryMethod.COLLECT) {
      continue;
    }

    const existing = await Delivery.findOne({ order: order._id });
    if (existing) {
      if (!order.delivery) {
        await link(order._id as mongoose.Types.ObjectId, existing._id as mongoose.Types.ObjectId);
      }
      continue;
    }

    // A legacy assignment may point at either a VendorUser seat (assignments
    // made before the roster) or an already-migrated Driver. Try the map first,
    // fall back to treating the id as a Driver.
    const legacyDriverId = legacy?.assignment?.driver;
    const mapped = legacyDriverId ? driverBySeatId.get(String(legacyDriverId)) : undefined;
    const driverId = mapped?.id ?? legacyDriverId;
    const driverName = mapped?.name ?? legacy?.assignment?.driverNameSnapshot;

    const delivery = await Delivery.create({
      order: order._id,
      orderNumber: order.orderNumber,
      method,
      status: legacy?.status ?? DeliveryStatus.PENDING,
      dispatchedAt: legacy?.dispatchedAt,
      deliveredAt: legacy?.deliveredAt,
      expectedDeliveryDate: legacy?.expectedDeliveryDate,
      // The address and the quote moved across with the lifecycle — losing
      // these would lose the fee the customer already agreed to.
      address: legacy?.address,
      quoteStatus: legacy?.quoteStatus,
      fee: legacy?.fee,
      feeApplied: legacy?.feeApplied,
      vehicleTier: legacy?.vehicleTier,
      distanceKm: legacy?.distanceKm,
      ...(driverId
        ? {
            driver: driverId,
            driverNameSnapshot: driverName,
            assignedAt: legacy?.assignment?.assignedAt ?? new Date(),
          }
        : {}),
    });
    // Record the relationship from the order's side too.
    await link(order._id as mongoose.Types.ObjectId, delivery._id as mongoose.Types.ObjectId);
    deliveriesCreated += 1;
  }

  return { drivers: driversCreated, deliveries: deliveriesCreated };
};

const run = async (): Promise<void> => {
  await connectDb();

  const tenants = await runWithoutTenant(
    'delivery-job migration',
    'Tenant.find({}) to iterate every tenant',
    () => Tenant.find({}).select('_id slug').lean(),
  );

  logger.info(`[${TAG}] Migrating fulfilment across ${tenants.length} tenant(s)…`);

  let drivers = 0;
  let deliveries = 0;
  for (const tenant of tenants) {
    const result = await runWithTenant(
      tenant._id as mongoose.Types.ObjectId,
      () => migrateTenant(),
      tenant.slug,
    );
    if (result.drivers > 0 || result.deliveries > 0) {
      logger.info(
        `[${TAG}] ${tenant.slug}: ${result.drivers} driver(s), ${result.deliveries} delivery job(s)`,
      );
    }
    drivers += result.drivers;
    deliveries += result.deliveries;
  }

  logger.info(
    `[${TAG}] Done. ${drivers} driver(s) and ${deliveries} delivery job(s) created. ` +
      `Legacy staff seats and the old deliveryDetails fields were left in place — ` +
      `nothing reads them now, and keeping them makes this re-runnable.`,
  );
  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (error) => {
  logger.error(
    `[${TAG}] Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
  );
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
