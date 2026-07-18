import type { VehicleTier, Currency } from '../constants/models.ts';

// Public data types for the delivery service. The service speaks only in these
// plain shapes + tenantId, never in host models (Product/Tenant/Order), so it
// stays extractable into a standalone API.

// A geographic point. Same shape as utils/geo's LatLng, but owned here so the
// public API doesn't leak an internal util type.
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

// Money in integer minor units + ISO currency — same convention as the rest of
// the platform, but owned here (the module never imports the Product model,
// where the host's IMoney lives).
export interface Money {
  amount: number; // integer minor units, e.g. 250 = $2.50
  currency: Currency;
}

// What a cart asks of the fleet. The caller computes this from its own data
// (order line items + product physicals) and passes it in — the service does not
// read the catalog itself.
export interface VehicleRequirement {
  // Total billable weight of the cart, in kilograms.
  weightKg: number;
  // The strongest per-item minimum-vehicle floor in the cart, if any. A cart
  // containing a gas cylinder tagged "van" can't go by bike even if it's light.
  minTier?: VehicleTier;
}

// The minimal vehicle shape the selection logic needs — lets callers pass lean
// docs or DTOs, not just hydrated Mongoose documents.
export interface VehicleCapacity {
  tier: VehicleTier;
  maxWeightKg: number;
  active: boolean;
}

// One order line's physical profile, as the host reads it off its own catalog.
// Everything except quantity is optional: the platform quotes on available
// data, so a missing weight/dimensions simply contributes nothing (delivery
// readiness checks nudge vendors to fill physicals in).
export interface CartItemPhysicals {
  quantity: number;
  weightKg?: number;
  dimensionsCm?: { length: number; width: number; height: number };
  minTier?: VehicleTier;
}
