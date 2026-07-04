import { runWithTenant } from '../context/tenantContext.ts';
import { VEHICLE_TIER_ORDER } from '../constants/models.ts';
import type { VehicleTier } from '../constants/models.ts';
import VehicleModel from './models/Vehicle.ts';
import type { IVehicle } from './models/Vehicle.ts';
import type { VehicleRequirement, VehicleCapacity } from './types.ts';

// Rank a tier by size (bike=0 … truck=3). -1 for an unknown tier so it never
// wins selection.
const tierRank = (tier: VehicleTier): number => VEHICLE_TIER_ORDER.indexOf(tier);

export interface VehicleInput {
  tier: VehicleTier;
  name: string;
  maxWeightKg: number;
  maxDimensionsCm?: { length: number; width: number; height: number };
  active?: boolean;
}

// --- Fleet CRUD. Each takes tenantId and scopes itself (runWithTenant), so the
// service owns its tenant boundary rather than relying on ambient context. ---

export const createVehicle = (tenantId: string, input: VehicleInput): Promise<IVehicle> =>
  runWithTenant(tenantId, () => VehicleModel.create(input));

export const listVehicles = (tenantId: string): Promise<IVehicle[]> =>
  runWithTenant(tenantId, async () => {
    const vehicles = await VehicleModel.find();
    // Smallest → largest so the fleet reads in a sensible order.
    return vehicles.sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
  });

export const getVehicle = (tenantId: string, id: string): Promise<IVehicle | null> =>
  runWithTenant(tenantId, () => VehicleModel.findById(id));

export const updateVehicle = (
  tenantId: string,
  id: string,
  patch: Partial<VehicleInput>,
): Promise<IVehicle | null> =>
  runWithTenant(tenantId, async () => {
    const vehicle = await VehicleModel.findById(id);
    if (!vehicle) {
      return null;
    }
    vehicle.set(patch);
    await vehicle.save();
    return vehicle;
  });

export const deleteVehicle = (tenantId: string, id: string): Promise<boolean> =>
  runWithTenant(tenantId, async () => {
    const result = await VehicleModel.deleteOne({ _id: id });
    return result.deletedCount > 0;
  });

/**
 * Pick the smallest vehicle that can carry a cart: active, tier at least the
 * cart's minimum-vehicle floor, and enough weight capacity. Pure and generic so
 * it works on hydrated docs or lean DTOs, and is trivially unit-testable.
 * Returns null when nothing in the fleet fits (caller decides: block or split).
 */
export const selectVehicle = <T extends VehicleCapacity>(
  vehicles: T[],
  requirement: VehicleRequirement,
): T | null => {
  const minRank = requirement.minTier ? tierRank(requirement.minTier) : 0;
  const fitting = vehicles
    .filter(
      (v) => v.active && tierRank(v.tier) >= minRank && v.maxWeightKg >= requirement.weightKg,
    )
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
  return fitting[0] ?? null;
};
