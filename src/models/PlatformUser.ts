import type { Document } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { PlatformRole, PlatformUserStatus } from '../constants/models.ts';

export { PlatformRole, PlatformUserStatus };

// A platform operator (super admin) — the people who run the SaaS, NOT vendors
// or customers. Deliberately NOT tenant-scoped: it carries no tenantId and does
// not apply the tenantScope plugin, because these accounts act ACROSS tenants
// (e.g. approving a pending vendor). Identity still lives in Authentik; email is
// the anchor and authSubject (OIDC `sub`) is bound on first login, exactly like
// VendorUser — but globally unique rather than per-tenant.
export interface IPlatformUser extends Document {
  email: string;
  authSubject?: string;
  // Authentik user pk captured at provisioning (admin-API handle, e.g. to
  // re-send a setup email). Distinct from authSubject (OIDC `sub`, bound on
  // first login).
  authUserPk?: number;
  name?: string;
  role: PlatformRole;
  status: PlatformUserStatus;
  lastLoginAt?: Date;
}

const PlatformUserSchema = new Schema<IPlatformUser>(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    authSubject: { type: String, trim: true, unique: true, sparse: true },
    authUserPk: { type: Number },
    name: { type: String, trim: true },
    role: {
      type: String,
      enum: Object.values(PlatformRole),
      default: PlatformRole.SUPER_ADMIN,
    },
    status: {
      type: String,
      enum: Object.values(PlatformUserStatus),
      default: PlatformUserStatus.ACTIVE,
      index: true,
    },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

export default mongoose.model<IPlatformUser>('PlatformUser', PlatformUserSchema);
