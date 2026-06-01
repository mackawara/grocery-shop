export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  TRIAL = 'trial',
  INACTIVE = 'inactive',
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

export enum PaymentMethod {
  ECOCASH = 'ecocash',
  OMARI = 'omari',
  CASH_ON_DELIVERY = 'cash_on_delivery',
}

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

export const toPaymentMethodOptions = (
  methods: PaymentMethod[],
): MethodOption[] =>
  methods.map((method) => ({
    id: method,
    title: PAYMENT_METHOD_LABELS[method] ?? method,
  }));

export const toDeliveryMethodOptions = (
  methods: DeliveryMethod[],
): MethodOption[] =>
  methods.map((method) => ({
    id: method,
    title: DELIVERY_METHOD_LABELS[method] ?? method,
  }));
