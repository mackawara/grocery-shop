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
