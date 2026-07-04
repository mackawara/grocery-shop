import type { Document } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import {
  TenantStatus,
  TenantPlan,
  PaymentMethod,
  PaymentProvider,
  DeliveryMethod,
} from '../constants/models.js';

export interface IWhatsappFlowIds {
  order?: string;
  onboarding?: string;
  returns?: string;
  support?: string;
}

export interface ITenantAddress {
  streetNumber?: string;
  streetName?: string;
  area?: string;
  subArea?: string;
  city?: string;
}

export interface IGpsCoordinates {
  latitude: number;
  longitude: number;
}

// Per-merchant Paynow credentials from the Paynow dashboard. integrationKey is
// the hash secret used to sign/verify requests.
export interface IPaynowCredentials {
  integrationId: string;
  integrationKey: string;
  authEmail: string;
}

// Standalone EcoCash/OMari direct-API credentials, used only when a tenant
// routes a method straight to the network instead of through Paynow.
export interface IMobileMoneyCredentials {
  merchantCode: string;
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
}

// select:false (see schema) — query explicitly inside the payment layer so
// secrets never ride along on incidental tenant reads.
export interface IPaymentCredentials {
  paynow?: IPaynowCredentials;
  ecocash?: IMobileMoneyCredentials;
  omari?: IMobileMoneyCredentials;
}

export interface ITenant extends Document {
  status: TenantStatus;
  plan: TenantPlan;
  displayName: string;
  slug: string;
  email: string;
  country: string;
  // WhatsApp assets are attached when the vendor's WhatsApp is onboarded —
  // optional so a vendor can exist (signup, delivery config, catalog drafts)
  // before WhatsApp is connected. The webhook resolver matches BY phone-number
  // id, so a tenant without one simply never receives WhatsApp traffic.
  whatsappPhoneNumberId?: string;
  whatsappCatalogId?: string;
  whatsappBusinessId?: string;
  // Authentik group pk for this tenant, captured at signup. The group is the
  // tenant's identity boundary in Authentik; staff invitations are placed into
  // it so they resolve back to this tenant on login.
  authGroupPk?: string;
  whatsappFlowIds: IWhatsappFlowIds;
  paymentMethods: PaymentMethod[];
  deliveryMethods: DeliveryMethod[];
  paymentCredentials?: IPaymentCredentials;
  // Method→gateway overrides; absent entries fall back to DEFAULT_PAYMENT_ROUTING.
  paymentRouting?: Partial<Record<PaymentMethod, PaymentProvider>>;
  address?: ITenantAddress;
  location_gps?: IGpsCoordinates;
  // The tenant's single Facebook page URL, used as the Meta catalog `link` for
  // every product this tenant syncs (WhatsApp commerce has no per-product web
  // storefront). Required at sync time; products can't push without it.
  facebookPageUrl?: string;
}

const WhatsappFlowIdsSchema = new Schema<IWhatsappFlowIds>(
  {
    order: { type: String },
    onboarding: { type: String },
    returns: { type: String },
    support: { type: String },
  },
  { _id: false },
);

const PaynowCredentialsSchema = new Schema<IPaynowCredentials>(
  {
    integrationId: { type: String, required: true, trim: true },
    integrationKey: { type: String, required: true, trim: true },
    authEmail: { type: String, required: true, trim: true, lowercase: true },
  },
  { _id: false },
);

const MobileMoneyCredentialsSchema = new Schema<IMobileMoneyCredentials>(
  {
    merchantCode: { type: String, required: true, trim: true },
    apiKey: { type: String, required: true, trim: true },
    apiSecret: { type: String, required: true, trim: true },
    baseUrl: { type: String, trim: true },
  },
  { _id: false },
);

const PaymentCredentialsSchema = new Schema<IPaymentCredentials>(
  {
    paynow: { type: PaynowCredentialsSchema },
    ecocash: { type: MobileMoneyCredentialsSchema },
    omari: { type: MobileMoneyCredentialsSchema },
  },
  { _id: false },
);

// Keys are derived from PaymentMethod so the schema stays in sync with the enum:
// add a method there and it's automatically routable here, no schema edit needed.
const PaymentRoutingSchema = new Schema<Partial<Record<PaymentMethod, PaymentProvider>>>(
  Object.fromEntries(
    Object.values(PaymentMethod).map((method) => [
      method,
      { type: String, enum: Object.values(PaymentProvider) },
    ]),
  ),
  { _id: false },
);

// What a tenant must have before it may go ACTIVE. PENDING/TRIAL tenants can
// exist with nothing but signup fields (so delivery/catalog can be configured
// pre-onboarding), but ACTIVE means live on WhatsApp — connectivity fields and
// at least one payment and delivery method are non-negotiable. Shared by the
// pre-validate backstop below and the admin activate endpoint, so the reported
// missing-field list and the enforced rule can never drift apart.
export const missingActivationFields = (tenant: ITenant): string[] => {
  const missing: string[] = [];
  if (!tenant.whatsappPhoneNumberId?.trim()) {
    missing.push('whatsappPhoneNumberId');
  }
  if (!tenant.whatsappBusinessId?.trim()) {
    missing.push('whatsappBusinessId');
  }
  if (!tenant.paymentMethods?.length) {
    missing.push('paymentMethods');
  }
  if (!tenant.deliveryMethods?.length) {
    missing.push('deliveryMethods');
  }
  return missing;
};

export class TenantActivationError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Tenant cannot be activated; missing: ${missing.join(', ')}`);
    this.name = 'TenantActivationError';
  }
}

const slugify = (input: string): string =>
  input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const TenantSchema = new Schema<ITenant>(
  {
    status: {
      type: String,
      enum: Object.values(TenantStatus),
      default: TenantStatus.TRIAL,
      required: true,
    },
    plan: {
      type: String,
      enum: Object.values(TenantPlan),
      default: TenantPlan.FREE,
      required: true,
    },
    displayName: { type: String, required: true, unique: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    },
    email: { type: String, required: true, unique: true, index: true },
    country: { type: String, required: true },
    // Optional until WhatsApp onboarding; uniqueness enforced by the sparse
    // index below (plain `unique` would collide on missing values).
    whatsappPhoneNumberId: { type: String, trim: true },
    whatsappCatalogId: { type: String },
    whatsappBusinessId: { type: String, trim: true },
    // Authentik group pk, stamped at signup; targets staff invitations.
    authGroupPk: { type: String },
    whatsappFlowIds: { type: WhatsappFlowIdsSchema, default: () => ({}) },
    paymentMethods: {
      type: [String],
      enum: Object.values(PaymentMethod),
      default: () => [PaymentMethod.CASH_ON_DELIVERY],
    },
    deliveryMethods: {
      type: [String],
      enum: Object.values(DeliveryMethod),
      default: () => [DeliveryMethod.COLLECT],
    },
    // select:false so secrets never leak through routine tenant reads.
    paymentCredentials: { type: PaymentCredentialsSchema, select: false },
    // Method→gateway overrides; keys mirror the PaymentMethod enum (see
    // PaymentRoutingSchema). Absent entries fall back to DEFAULT_PAYMENT_ROUTING.
    paymentRouting: { type: PaymentRoutingSchema },
    address: {
      streetNumber: { type: String, trim: true },
      streetName: { type: String, trim: true },
      area: { type: String, trim: true },
      subArea: { type: String, trim: true },
      city: { type: String, trim: true },
    },
    location_gps: {
      latitude: { type: Number },
      longitude: { type: Number },
    },
    facebookPageUrl: { type: String, trim: true },
  },
  { timestamps: true },
);

// Unique only when present: multiple tenants may await WhatsApp onboarding, but
// no two tenants can claim the same phone-number id.
TenantSchema.index({ whatsappPhoneNumberId: 1 }, { unique: true, sparse: true });

// TODO(controller): the exists()+save sequence below is not atomic. Two
// concurrent signups with the same displayName can both pick the same slug and
// one will fail with a duplicate-key error (E11000) on the unique slug index.
// The tenant create controller must catch that error and retry the save so the
// hook re-runs and picks the next free suffix.
TenantSchema.pre<ITenant>('validate', async function () {
  if (this.slug || !this.displayName) {
    return;
  }
  const base = slugify(this.displayName);
  if (!base) {
    throw new Error('Cannot derive slug from displayName');
  }
  const TenantModel = this.constructor as mongoose.Model<ITenant>;
  let candidate = base;
  let suffix = 1;
  while (await TenantModel.exists({ slug: candidate, _id: { $ne: this._id } })) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  this.slug = candidate;
});

// Backstop: no code path may create a tenant as ACTIVE or flip one to ACTIVE
// unless it is fully onboarded (see missingActivationFields). The admin
// activate endpoint pre-checks and reports the missing fields; this hook holds
// every other save path to the same bar. Already-ACTIVE tenants saving
// unrelated changes are untouched — only the transition is gated.
TenantSchema.pre<ITenant>('validate', function () {
  if (this.status !== TenantStatus.ACTIVE) {
    return;
  }
  if (!this.isNew && !this.isModified('status')) {
    return;
  }
  const missing = missingActivationFields(this);
  if (missing.length > 0) {
    throw new TenantActivationError(missing);
  }
});

export default mongoose.model<ITenant>('Tenant', TenantSchema);
