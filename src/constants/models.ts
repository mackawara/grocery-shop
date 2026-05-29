export enum TenantStatus {
  ACTIVE = "active",
  SUSPENDED = "suspended",
  TRIAL = "trial",
  INACTIVE = "inactive",
}

export enum TenantPlan {
  FREE = "free",
  STARTER = "starter",
  PRO = "pro",
  ENTERPRISE = "enterprise",
}

export enum OrderStatus {
  PENDING = "pending",
  CONFIRMED = "confirmed",
  PROCESSING = "processing",
  COMPLETED = "completed",
  CANCELLED = "cancelled",
}

export enum PaymentStatus {
  PENDING = "pending",
  PAID = "paid",
  FAILED = "failed",
  REFUNDED = "refunded",
}

export enum DeliveryStatus {
  PENDING = "pending",
  SHIPPED = "shipped",
  DELIVERED = "delivered",
}

export enum UserRole {
  ADMIN = "admin",
  VENDOR = "vendor",
  SHOP_MANAGER = "shop_manager",
  SALES_REP = "sales_rep",
  CUSTOMER = "customer",
}

export enum UserStatus {
  ACTIVE = "active",
  VERIFIED = "verified",
  DORMANT = "dormant",
  BLACKLISTED = "blacklisted",
}

export enum PaymentMethod {
  ECOCASH = "ecocash",
  OMARI = "omari",
  CASH_ON_DELIVERY = "cash_on_delivery",
}

export enum DeliveryMethod {
  COLLECT = "collect",
  DOOR_DELIVERY = "door_delivery",
}
