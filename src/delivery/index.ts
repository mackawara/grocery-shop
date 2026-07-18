// Public facade for the delivery service — a self-contained, extractable module.
// The rest of the codebase imports ONLY from here (`../delivery`), never from a
// file inside the module. The service depends on infra (mongoose, tenant scope,
// geo math) and shared enums, but on NO host business model (Product / Tenant /
// Order): everything it needs arrives as tenantId + plain DTOs. That boundary is
// what would let this move to its own API without untangling business logic.

export type {
  GeoPoint,
  Money,
  VehicleRequirement,
  VehicleCapacity,
  CartItemPhysicals,
} from './types.ts';

// Quote engine
export {
  quoteDelivery,
  computeVehicleRequirement,
  QuoteStatus,
  VOLUMETRIC_DIVISOR_CM3_PER_KG,
} from './quote.service.ts';
export type { DeliveryQuote, DeliveryQuoteFailure, DeliveryQuoteResult } from './quote.service.ts';

// Rate matrix
export {
  upsertRate,
  listRates,
  deleteRate,
  computeDeliveryFee,
} from './rate.service.ts';
export type { RateInput, RatePricing } from './rate.service.ts';
export { default as DeliveryRate, DeliveryRateKind } from './models/DeliveryRate.ts';
export type { IDeliveryRate } from './models/DeliveryRate.ts';

// Zones
export {
  resolveZone,
  createZone,
  listZones,
  getZone,
  updateZone,
  deleteZone,
} from './zone.service.ts';
export type { ZoneInput } from './zone.service.ts';
export { default as DeliveryZone, DeliveryZoneKind } from './models/DeliveryZone.ts';
export type { IDeliveryZone, IZoneRing, IZoneGeometry } from './models/DeliveryZone.ts';

// Fleet / vehicles
export {
  createVehicle,
  listVehicles,
  getVehicle,
  updateVehicle,
  deleteVehicle,
  selectVehicle,
  listFittingVehicles,
} from './vehicle.service.ts';
export type { VehicleInput } from './vehicle.service.ts';
export { default as Vehicle, VehicleTier } from './models/Vehicle.ts';
export type { IVehicle } from './models/Vehicle.ts';
