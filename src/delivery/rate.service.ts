import { runWithTenant } from '../context/tenantContext.ts';
import { DeliveryRateKind } from '../constants/models.ts';
import type { VehicleTier } from '../constants/models.ts';
import DeliveryRateModel from './models/DeliveryRate.ts';
import type { IDeliveryRate } from './models/DeliveryRate.ts';
import type { Money } from './types.ts';

export interface RateInput {
  zone: string; // DeliveryZone id
  tier: VehicleTier;
  kind: DeliveryRateKind;
  flat?: Money;
  base?: Money;
  perKm?: Money;
}

// The minimal rate shape the fee math needs — hydrated doc or lean DTO.
export interface RatePricing {
  kind: DeliveryRateKind;
  flat?: Money;
  base?: Money;
  perKm?: Money;
}

// --- Matrix CRUD. A cell is keyed by (zone, tier), so writes are upserts:
// the dashboard just "sets the cell" without caring whether it existed. ---

export const upsertRate = (tenantId: string, input: RateInput): Promise<IDeliveryRate> =>
  runWithTenant(tenantId, async () => {
    const { zone, tier, ...pricing } = input;
    const existing = await DeliveryRateModel.findOne({ zone, tier });
    if (existing) {
      // Clear stale pricing fields from a previous kind, then apply the new cell.
      existing.set({ flat: undefined, base: undefined, perKm: undefined, ...pricing });
      await existing.save(); // re-runs kind/pricing validation
      return existing;
    }
    return DeliveryRateModel.create(input);
  });

export const listRates = (tenantId: string): Promise<IDeliveryRate[]> =>
  runWithTenant(tenantId, () => DeliveryRateModel.find());

export const deleteRate = (tenantId: string, id: string): Promise<boolean> =>
  runWithTenant(tenantId, async () => {
    const result = await DeliveryRateModel.deleteOne({ _id: id });
    return result.deletedCount > 0;
  });

// Cascade helper: remove every cell for a zone (called when the zone is deleted
// so the matrix never holds rows pointing at a zone that no longer exists).
export const deleteRatesForZone = (tenantId: string, zoneId: string): Promise<number> =>
  runWithTenant(tenantId, async () => {
    const result = await DeliveryRateModel.deleteMany({ zone: zoneId });
    return result.deletedCount ?? 0;
  });

/**
 * Price one rate cell for a given distance. Pure — no DB, no context.
 * Returns null when the cell says the zone isn't served by this vehicle.
 * BASE_PER_KM rounds to whole minor units so fees are always chargeable.
 */
export const computeDeliveryFee = (rate: RatePricing, distanceKm: number): Money | null => {
  switch (rate.kind) {
    case DeliveryRateKind.FLAT:
      if (!rate.flat) {
        throw new Error('flat rate cell is missing its flat amount');
      }
      // Rebuild field-by-field: `rate` may be a hydrated doc, and spreading a
      // Mongoose subdocument leaks its internals into what must be a plain DTO.
      return { amount: rate.flat.amount, currency: rate.flat.currency };
    case DeliveryRateKind.BASE_PER_KM: {
      if (!rate.base || !rate.perKm) {
        throw new Error('base_per_km rate cell is missing base/perKm');
      }
      const amount = Math.round(rate.base.amount + rate.perKm.amount * distanceKm);
      return { amount, currency: rate.base.currency };
    }
    default:
      return null; // NOT_SERVED
  }
};
