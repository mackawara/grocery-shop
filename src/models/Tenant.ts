import type { Document} from "mongoose";
import mongoose, { Schema } from "mongoose";
import { TenantStatus, TenantPlan } from "../constants/models";

export { TenantStatus, TenantPlan };

export interface IWhatsappFlowIds {
  order?: string;
  onboarding?: string;
  returns?: string;
  support?: string;
}

export interface ITenant extends Document {
  status: TenantStatus;
  plan: TenantPlan;
  email: string;
  country: string;
  whatsappPhoneNumberId: string;
  whatsappCatalogId?: string;
  whatsappBusinessId: string;
  whatsappFlowIds: IWhatsappFlowIds;
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
    email: { type: String, required: true, unique: true, index: true },
    country: { type: String, required: true },
    whatsappPhoneNumberId: { type: String, required: true, unique: true },
    whatsappCatalogId: { type: String },
    whatsappBusinessId: { type: String, required: true },
    whatsappFlowIds: { type: WhatsappFlowIdsSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export default mongoose.model<ITenant>("Tenant", TenantSchema);
