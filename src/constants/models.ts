export enum TenantStatus {
  // Awaiting platform-admin approval after signup; cannot transact yet.
  PENDING = 'pending',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  TRIAL = 'trial',
  INACTIVE = 'inactive',
  // Signup declined by a platform admin; terminal.
  REJECTED = 'rejected',
}

export enum TenantPlan {
  FREE = 'free',
  STARTER = 'starter',
  PRO = 'pro',
  ENTERPRISE = 'enterprise',
}

export enum OrderStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum PaymentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

export enum DeliveryStatus {
  PENDING = 'pending',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
}

// --- Product / catalog ---

// Product availability. Internal snake_case values; the catalog formatter maps
// these to Meta's feed strings ("in stock", "out of stock", ...) on export. We
// never store Meta's format — storage is optimised for arithmetic/analytics.
export enum ProductAvailability {
  IN_STOCK = 'in_stock',
  OUT_OF_STOCK = 'out_of_stock',
  PREORDER = 'preorder',
  AVAILABLE_FOR_ORDER = 'available_for_order',
  DISCONTINUED = 'discontinued',
}

export enum ProductCondition {
  NEW = 'new',
  REFURBISHED = 'refurbished',
  USED = 'used',
}

// Internal lifecycle of a Product row, independent of Meta availability.
// ARCHIVED products are DELETEd from the Meta catalog on the next sync.
export enum ProductStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

// Sync state of a Product against the Meta (Facebook) catalog.
export enum CatalogSyncStatus {
  NOT_SYNCED = 'not_synced',
  PENDING = 'pending',
  SYNCED = 'synced',
  ERROR = 'error',
}

// Delivery vehicle tiers, smallest -> largest. Shared by the product
// minimum-vehicle tag and (later) the delivery quote engine.
export enum VehicleTier {
  BIKE = 'bike',
  VAN = 'van',
  SMALL_TRUCK = 'small_truck',
  TRUCK = 'truck',
}

// Smallest -> largest. Rank = index; used to pick the smallest vehicle that fits
// and to honour a product's minimum-vehicle floor.
export const VEHICLE_TIER_ORDER: readonly VehicleTier[] = [
  VehicleTier.BIKE,
  VehicleTier.VAN,
  VehicleTier.SMALL_TRUCK,
  VehicleTier.TRUCK,
];

// How a rate-matrix cell (zone × vehicle tier) prices a delivery:
//  FLAT        — one fixed fee for the whole zone.
//  BASE_PER_KM — base fee + perKm × distance.
//  NOT_SERVED  — this vehicle does not deliver to this zone (coverage control).
export enum DeliveryRateKind {
  FLAT = 'flat',
  BASE_PER_KM = 'base_per_km',
  NOT_SERVED = 'not_served',
}

// How a delivery zone is matched to a customer GPS pin:
//  RING    — a distance band {minKm,maxKm} from the tenant's shop (haversine).
//  POLYGON — a GeoJSON boundary resolved with MongoDB $geoIntersects (2dsphere).
export enum DeliveryZoneKind {
  RING = 'ring',
  POLYGON = 'polygon',
}

// Currencies the platform accepts, as ISO-4217 codes. NOTE: Zimbabwe Gold (ZiG)
// is code `ZWG`. Meta's catalog may not accept all of these — validate there.
export enum Currency {
  USD = 'USD',
  ZAR = 'ZAR',
  ZWG = 'ZWG', // Zimbabwe Gold (ZiG)
}

// Units of measurement are standardised platform-wide: weight is always stored
// in KILOGRAMS and dimensions in CENTIMETRES, so a unit is never stored per
// product. These labels exist only for display/export (e.g. Meta shipping_weight).
export const WEIGHT_UNIT = 'kg' as const;
export const DIMENSION_UNIT = 'cm' as const;

export enum UserRole {
  ADMIN = 'admin',
  VENDOR = 'vendor',
  SHOP_MANAGER = 'shop_manager',
  SALES_REP = 'sales_rep',
  CUSTOMER = 'customer',
}

export enum UserStatus {
  ACTIVE = 'active',
  VERIFIED = 'verified',
  DORMANT = 'dormant',
  BLACKLISTED = 'blacklisted',
}

// Lifecycle of a dashboard-login account (VendorUser). INVITED rows exist before
// the person has ever authenticated; they flip to ACTIVE on first login (the
// dashboard auth resolver binds their authSubject). DISABLED locks them out.
export enum VendorUserStatus {
  INVITED = 'invited',
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

// Platform operators run the SaaS across tenants. Single role today; kept as an
// enum so additional operator tiers can be added without touching call sites.
export enum PlatformRole {
  SUPER_ADMIN = 'super_admin',
}

// Lifecycle of a PlatformUser. Mirrors VendorUserStatus minus INVITED — admins
// are provisioned active via the createPlatformAdmin script.
export enum PlatformUserStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

// What the customer picks at checkout — not how it's settled (see PaymentProvider).
export enum PaymentMethod {
  ECOCASH = 'ecocash',
  OMARI = 'omari',
  CASH_ON_DELIVERY = 'cash_on_delivery',
}

// The gateway that settles a payment. Distinct from PaymentMethod: an EcoCash
// payment can settle via Paynow *or* EcoCash's own API (per Tenant.paymentRouting).
export enum PaymentProvider {
  PAYNOW = 'paynow',
  ECOCASH = 'ecocash', // direct merchant API (standalone)
  OMARI = 'omari', // direct merchant API (standalone)
  CASH_ON_DELIVERY = 'cash_on_delivery',
}

// Default routing when a tenant hasn't overridden it.
export const DEFAULT_PAYMENT_ROUTING: Record<PaymentMethod, PaymentProvider> = {
  [PaymentMethod.ECOCASH]: PaymentProvider.PAYNOW,
  [PaymentMethod.OMARI]: PaymentProvider.PAYNOW,
  [PaymentMethod.CASH_ON_DELIVERY]: PaymentProvider.CASH_ON_DELIVERY,
};

export const resolvePaymentProvider = (
  method: PaymentMethod,
  routing?: Partial<Record<PaymentMethod, PaymentProvider>>,
): PaymentProvider => routing?.[method] ?? DEFAULT_PAYMENT_ROUTING[method];

export enum DeliveryMethod {
  COLLECT = 'collect',
  DOOR_DELIVERY = 'door_delivery',
}

// Customer-facing labels for each method. Used to build the { id, title }
// options a WhatsApp Flow RadioButtonsGroup data-source requires.
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  [PaymentMethod.ECOCASH]: 'EcoCash',
  [PaymentMethod.OMARI]: "O'mari",
  [PaymentMethod.CASH_ON_DELIVERY]: 'Cash on delivery / pickup',
};

export const DELIVERY_METHOD_LABELS: Record<DeliveryMethod, string> = {
  [DeliveryMethod.COLLECT]: 'Collect / Pickup',
  [DeliveryMethod.DOOR_DELIVERY]: 'Door delivery',
};

export interface MethodOption {
  id: string;
  title: string;
}

export const toPaymentMethodOptions = (methods: PaymentMethod[]): MethodOption[] =>
  methods.map((method) => ({
    id: method,
    title: PAYMENT_METHOD_LABELS[method] ?? method,
  }));

export const toDeliveryMethodOptions = (methods: DeliveryMethod[]): MethodOption[] =>
  methods.map((method) => ({
    id: method,
    title: DELIVERY_METHOD_LABELS[method] ?? method,
  }));
