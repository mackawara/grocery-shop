import mongoose from 'mongoose';
import { logger } from '../services/logger.ts';
import { runWithTenant } from '../context/tenantContext.ts';
import { DeliveryZoneKind, DeliveryRateKind, VehicleTier, Currency } from '../constants/models.ts';
import DeliveryZoneModel from './models/DeliveryZone.ts';
import VehicleModel from './models/Vehicle.ts';
import DeliveryRateModel from './models/DeliveryRate.ts';
import type { Money } from './types.ts';

const TAG = '[DELIVERY_DEFAULTS]';

// The starter delivery setup every new tenant is born with: one catch-all ring
// zone, one vehicle, one flat cell. A vendor who changes nothing can still quote
// and charge deliveries from day one; the zone/fleet/matrix editors are then
// pure refinement rather than a prerequisite for going live.
//
// The ring is anchored on the shop's GPS (Tenant.location_gps), so a vendor who
// has not set their shop location still quotes OUT_OF_AREA — the business
// settings page is the one field they must fill in.
export const DEFAULT_ZONE_NAME = 'Citywide';
export const DEFAULT_ZONE_CODE = 'ALL';
// Wide enough to cover any city + its surrounds, so the default behaves as
// "we deliver anywhere we'd realistically drive" without being unbounded.
export const DEFAULT_ZONE_MAX_KM = 50;
export const DEFAULT_VEHICLE_TIER = VehicleTier.VAN;
export const DEFAULT_VEHICLE_NAME = 'Delivery vehicle';
// A van-sized default cap: high enough that a normal grocery cart always fits,
// so an unpriced cart is never blocked by capacity the vendor never configured.
export const DEFAULT_VEHICLE_MAX_WEIGHT_KG = 500;
export const DEFAULT_FLAT_FEE: Money = { amount: 300, currency: Currency.USD };

export interface DeliveryDefaultsResult {
  // false only when all three natural keys already existed; true when the
  // transaction inserted at least one missing component.
  seeded: boolean;
}

/**
 * Give a tenant the starter delivery setup, once.
 *
 * Idempotent and repairable by design: the default zone, vehicle and rate are
 * independently upserted by their natural keys in one transaction. Existing
 * custom configuration is untouched, complete defaults no-op, and an earlier
 * partial setup gains only its missing components. Safe to call at signup AND
 * from the dashboard for tenants that predate seeding.
 *
 * Scopes itself with tenantId like the rest of the module, so it may be called
 * from outside any tenant context (e.g. the signup bypass).
 */
export const seedDefaultDeliverySetup = (tenantId: string): Promise<DeliveryDefaultsResult> =>
  runWithTenant(tenantId, async () => {
    const session = await mongoose.startSession();
    try {
      const result = await session.withTransaction(async (): Promise<DeliveryDefaultsResult> => {
        // Each component is identified by its tenant-scoped natural key. Using
        // upserts means a retry repairs whichever component is absent instead
        // of treating the presence of any unrelated zone as "fully seeded".
        const zoneResult = await DeliveryZoneModel.findOneAndUpdate(
          { name: DEFAULT_ZONE_NAME },
          {
            $setOnInsert: {
              name: DEFAULT_ZONE_NAME,
              code: DEFAULT_ZONE_CODE,
              kind: DeliveryZoneKind.RING,
              ring: { minKm: 0, maxKm: DEFAULT_ZONE_MAX_KM },
              // Highest number = checked last, so any zone the vendor adds
              // later naturally takes precedence over the catch-all.
              priority: 1000,
              active: true,
            },
          },
          {
            upsert: true,
            new: true,
            runValidators: true,
            setDefaultsOnInsert: true,
            includeResultMetadata: true,
            session,
          },
        );
        const zone = zoneResult.value;
        if (!zone) {
          throw new Error('Default delivery zone upsert returned no document');
        }

        const vehicleResult = await VehicleModel.findOneAndUpdate(
          { tier: DEFAULT_VEHICLE_TIER },
          {
            $setOnInsert: {
              tier: DEFAULT_VEHICLE_TIER,
              name: DEFAULT_VEHICLE_NAME,
              maxWeightKg: DEFAULT_VEHICLE_MAX_WEIGHT_KG,
              active: true,
            },
          },
          {
            upsert: true,
            new: true,
            runValidators: true,
            setDefaultsOnInsert: true,
            includeResultMetadata: true,
            session,
          },
        );
        const vehicle = vehicleResult.value;
        if (!vehicle) {
          throw new Error('Default delivery vehicle upsert returned no document');
        }

        const rateResult = await DeliveryRateModel.findOneAndUpdate(
          { zone: zone._id, tier: vehicle.tier },
          {
            $setOnInsert: {
              zone: zone._id,
              tier: vehicle.tier,
              kind: DeliveryRateKind.FLAT,
              flat: DEFAULT_FLAT_FEE,
            },
          },
          {
            upsert: true,
            new: true,
            runValidators: true,
            setDefaultsOnInsert: true,
            includeResultMetadata: true,
            session,
          },
        );
        if (!rateResult.value) {
          throw new Error('Default delivery rate upsert returned no document');
        }

        const seeded = [zoneResult, vehicleResult, rateResult].some(
          (upsert) => upsert.lastErrorObject?.updatedExisting === false,
        );
        return { seeded };
      });

      if (!result) {
        throw new Error('Default delivery setup transaction completed without a result');
      }
      if (result.seeded) {
        logger.info(
          `${TAG} seeded starter delivery setup: zone "${DEFAULT_ZONE_NAME}" (0-${DEFAULT_ZONE_MAX_KM}km) × ` +
            `${DEFAULT_VEHICLE_TIER} @ flat ${DEFAULT_FLAT_FEE.currency} ${(DEFAULT_FLAT_FEE.amount / 100).toFixed(2)}`,
        );
      }
      return result;
    } finally {
      await session.endSession();
    }
  });
