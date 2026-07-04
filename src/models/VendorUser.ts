import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { UserRole, VendorUserStatus } from '../constants/models.ts';
import { tenantScope } from './plugins/tenantScope.ts';

export { UserRole, VendorUserStatus };

// A dashboard-login account for a vendor (the merchant side), as opposed to the
// customer `User` model. Identity lives in Authentik; `authSubject` is the OIDC
// `sub` claim and is the join key the dashboard auth resolver looks up. It is
// optional until first login so an invited staff member can have a row before
// they have ever authenticated (status INVITED). The first VendorUser created
// at signup is the owner (role VENDOR).
//
// Identifier model is "phone-face / email-spine": `phoneNumber` is the first-line
// login identifier (verified via WhatsApp OTP at signup), while `email` is the
// stable anchor mirrored onto the Authentik user's username/email for enforced
// uniqueness and email-based recovery. Phone is also unique per tenant here, but
// note global phone uniqueness (one phone -> one Authentik identity) is enforced
// in the signup provisioning path, not by this index.
export interface IVendorUser extends Document {
  tenantId: Types.ObjectId;
  phoneNumber: string;
  email: string;
  authSubject?: string;
  // The Authentik user's numeric `pk`, captured at provisioning. Distinct from
  // authSubject (the OIDC `sub`, bound on first login): this is the admin-API
  // handle used to trigger a recovery email when the tenant is approved.
  authUserPk?: number;
  name?: string;
  role: UserRole;
  status: VendorUserStatus;
  lastLoginAt?: Date;
}

const VendorUserSchema = new Schema<IVendorUser>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    phoneNumber: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    authSubject: { type: String, trim: true },
    authUserPk: { type: Number },
    name: { type: String, trim: true },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.VENDOR,
    },
    status: {
      type: String,
      enum: Object.values(VendorUserStatus),
      default: VendorUserStatus.INVITED,
      index: true,
    },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

// Natural keys, all scoped to the tenant. phoneNumber is the first-line login
// identifier; email is the anchor/recovery field; authSubject is sparse because
// it is absent until first login (and unique only among the docs that have it,
// so multiple INVITED rows without a subject coexist).
VendorUserSchema.index({ tenantId: 1, phoneNumber: 1 }, { unique: true });
VendorUserSchema.index({ tenantId: 1, email: 1 }, { unique: true });
VendorUserSchema.index({ tenantId: 1, authSubject: 1 }, { unique: true, sparse: true });

// Global login-lookup keys. The dashboard login path resolves a tenant from the
// identity alone (see resolveMembership), before any tenant context exists, so
// authSubject and email must be unique platform-wide — the v1 invariant of one
// identity / one email -> exactly one vendor seat (already upheld upstream by
// Authentik's unique usernames and the signup provisioning path). These
// complement, not replace, the per-tenant natural-key indexes above.
// authSubject is sparse (absent until first login); email is always present.
VendorUserSchema.index({ authSubject: 1 }, { unique: true, sparse: true });
VendorUserSchema.index({ email: 1 }, { unique: true });

VendorUserSchema.plugin(tenantScope);

export default mongoose.model<IVendorUser>('VendorUser', VendorUserSchema);
