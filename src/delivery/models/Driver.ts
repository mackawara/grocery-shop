import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { tenantScope } from '../../models/plugins/tenantScope.ts';

// A person the shop sends deliveries out with — a delivery resource, like a
// Vehicle, not a dashboard account.
//
// Deliberately NOT a VendorUser. A driver needs to be *reachable*, not
// *authenticated*: the manager types a name and a phone number and that is the
// whole onboarding. There is no email, no Authentik identity, no invitation and
// no login, so a driver record can never become a way into the dashboard —
// that is a structural property here, not a convention someone has to remember.
//
// If a driver ever does need dashboard access, they get a VendorUser seat too;
// the two are separate things about the same person, and that is the honest
// model rather than one row trying to be both.
export interface IDriver extends Document {
  tenantId: Types.ObjectId;
  name: string;
  // Normalized to digits only (utils/phone.normalizePhone) so it is directly
  // usable as a WhatsApp send target and keys consistently.
  phoneNumber: string;
  // Retired drivers are deactivated rather than deleted: orders they already
  // carried still point at them, and that history must stay readable.
  active: boolean;
  notes?: string;
}

const DriverSchema = new Schema<IDriver>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phoneNumber: { type: String, required: true, trim: true },
    active: { type: Boolean, required: true, default: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

// One record per number per tenant — the phone is the driver's natural key.
// Scoped to the tenant, not global: the same person may drive for two shops,
// and neither should be able to detect the other.
DriverSchema.index({ tenantId: 1, phoneNumber: 1 }, { unique: true });

DriverSchema.plugin(tenantScope);

export default mongoose.model<IDriver>('Driver', DriverSchema);
