import type { Document} from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import {
  TenantStatus,
  TenantPlan,
  PaymentMethod,
  DeliveryMethod,
} from '../constants/models';

export { TenantStatus, TenantPlan, PaymentMethod, DeliveryMethod };

export interface IWhatsappFlowIds {
  order?: string;
  onboarding?: string;
  returns?: string;
  support?: string;
}

export interface ITenant extends Document {
  status: TenantStatus;
  plan: TenantPlan;
  displayName: string;
  slug: string;
  email: string;
  country: string;
  whatsappPhoneNumberId: string;
  whatsappCatalogId?: string;
  whatsappBusinessId: string;
  whatsappFlowIds: IWhatsappFlowIds;
  paymentMethods: PaymentMethod[];
  deliveryMethods: DeliveryMethod[];
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
    whatsappPhoneNumberId: { type: String, required: true, unique: true },
    whatsappCatalogId: { type: String },
    whatsappBusinessId: { type: String, required: true },
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
  },
  { timestamps: true },
);

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
  while (
    await TenantModel.exists({ slug: candidate, _id: { $ne: this._id } })
  ) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  this.slug = candidate;
});

export default mongoose.model<ITenant>('Tenant', TenantSchema);
