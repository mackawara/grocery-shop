import { logger } from '../services/logger.ts';
import { VEHICLE_TIER_ORDER, DeliveryRateKind, QuoteStatus } from '../constants/models.ts';
import type { VehicleTier } from '../constants/models.ts';
import { haversineKm } from '../utils/geo.ts';
import { resolveZone } from './zone.service.ts';
import { listVehicles, listFittingVehicles } from './vehicle.service.ts';
import { listRates, computeDeliveryFee } from './rate.service.ts';
import type { GeoPoint, Money, VehicleRequirement, CartItemPhysicals } from './types.ts';

export { QuoteStatus };

const TAG = '[DELIVERY_QUOTE]';

// Standard courier volumetric divisor: 5000 cm³ of volume bills as 1 kg, so a
// light-but-bulky cart is charged by the space it takes, not just its mass.
export const VOLUMETRIC_DIVISOR_CM3_PER_KG = 5000;

const tierRank = (tier: VehicleTier): number => VEHICLE_TIER_ORDER.indexOf(tier);

/**
 * Fold a cart's physical profiles into the single requirement the fleet is
 * asked to satisfy. Pure. Billable weight = max(actual, volumetric) — the
 * standard courier rule — and the minimum-vehicle floor is the strongest
 * per-item floor in the cart. Missing weight/dimensions contribute nothing:
 * the platform quotes on available data rather than refusing to quote.
 */
export const computeVehicleRequirement = (items: CartItemPhysicals[]): VehicleRequirement => {
  let actualKg = 0;
  let volumetricKg = 0;
  let minTier: VehicleTier | undefined;

  for (const item of items) {
    const quantity = item.quantity > 0 ? item.quantity : 1;
    if (item.weightKg && item.weightKg > 0) {
      actualKg += item.weightKg * quantity;
    }
    if (item.dimensionsCm) {
      const { length, width, height } = item.dimensionsCm;
      volumetricKg += ((length * width * height) / VOLUMETRIC_DIVISOR_CM3_PER_KG) * quantity;
    }
    if (item.minTier && (!minTier || tierRank(item.minTier) > tierRank(minTier))) {
      minTier = item.minTier;
    }
  }

  return { weightKg: Math.max(actualKg, volumetricKg), ...(minTier ? { minTier } : {}) };
};

// A successful quote: everything the host needs to show the customer and to
// persist on the order (ids as strings — module DTOs never leak ObjectIds).
export interface DeliveryQuote {
  status: QuoteStatus.QUOTED;
  zoneId: string;
  zoneName: string;
  tier: VehicleTier;
  vehicleName: string;
  distanceKm?: number;
  fee: Money;
  requirement: VehicleRequirement;
}

// Why a quote couldn't be produced. zoneId/zoneName are set when the pin did
// resolve to a zone (NO_VEHICLE / NOT_SERVED) so the failure can be explained.
export interface DeliveryQuoteFailure {
  status: QuoteStatus.OUT_OF_AREA | QuoteStatus.NO_VEHICLE | QuoteStatus.NOT_SERVED;
  zoneId?: string;
  zoneName?: string;
  requirement: VehicleRequirement;
}

export type DeliveryQuoteResult = DeliveryQuote | DeliveryQuoteFailure;

/**
 * Price a delivery: drop-off pin → zone → smallest priced vehicle → fee.
 *
 * Pure orchestration over the tenant-scoped services (each call scopes itself
 * with tenantId), so this function opens no tenant context of its own.
 *
 * Vehicle choice walks the fitting fleet smallest → largest until a rate cell
 * prices the (zone × tier): the cheapest vehicle that can both carry the cart
 * AND is priced for the zone wins. A missing cell or an explicit NOT_SERVED
 * only rules out that tier — a bigger vehicle may still serve the zone.
 */
export const quoteDelivery = async (
  tenantId: string,
  shopOrigin: GeoPoint | undefined,
  dropoff: GeoPoint,
  requirement: VehicleRequirement,
): Promise<DeliveryQuoteResult> => {
  const zone = await resolveZone(tenantId, shopOrigin, dropoff);
  if (!zone) {
    return { status: QuoteStatus.OUT_OF_AREA, requirement };
  }
  const zoneId = String(zone._id);

  const vehicles = await listVehicles(tenantId);
  const fitting = listFittingVehicles(vehicles, requirement);
  if (fitting.length === 0) {
    logger.warn(
      `${TAG} no active vehicle fits ${requirement.weightKg.toFixed(1)}kg` +
        `${requirement.minTier ? ` (minTier=${requirement.minTier})` : ''} in zone ${zone.name}`,
    );
    return { status: QuoteStatus.NO_VEHICLE, zoneId, zoneName: zone.name, requirement };
  }

  const distanceKm = shopOrigin ? haversineKm(shopOrigin, dropoff) : undefined;

  const rates = await listRates(tenantId);
  const zoneRates = rates.filter((r) => String(r.zone) === zoneId);
  const rateByTier = new Map(zoneRates.map((r) => [r.tier, r]));

  for (const vehicle of fitting) {
    const rate = rateByTier.get(vehicle.tier);
    if (!rate) {
      continue; // no cell for this tier — try the next size up
    }
    if (rate.kind === DeliveryRateKind.BASE_PER_KM && distanceKm === undefined) {
      // Per-km pricing is meaningless without a shop origin; skip rather than
      // silently bill a distance of zero.
      logger.warn(
        `${TAG} zone ${zone.name} × ${vehicle.tier} is per-km priced but the shop has no location — skipping tier`,
      );
      continue;
    }
    const fee = computeDeliveryFee(rate, distanceKm ?? 0);
    if (!fee) {
      continue; // explicit NOT_SERVED cell for this tier
    }
    return {
      status: QuoteStatus.QUOTED,
      zoneId,
      zoneName: zone.name,
      tier: vehicle.tier,
      vehicleName: vehicle.name,
      distanceKm,
      fee,
      requirement,
    };
  }

  return { status: QuoteStatus.NOT_SERVED, zoneId, zoneName: zone.name, requirement };
};
