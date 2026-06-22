import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { UserRole, UserStatus } from '../constants/models.js';

export { UserRole, UserStatus };

// Dashboard operators (staff/admins) — distinct from the WhatsApp `User` model,
// which is customer-shaped (phone-based, tenant-scoped). Operators authenticate
// via Authentik, so the stable identity is the OIDC `sub`. Deliberately NOT
// scoped by the tenantScope plugin: operators are resolved at login time before
// any tenant context exists, and roles like ADMIN span tenants.
export interface IOperator extends Document {
  authSub: string;
  email?: string;
  name?: string;
  role: UserRole;
  status: UserStatus;
  tenantId?: Types.ObjectId;
  lastLoginAt?: Date;
}

const OperatorSchema = new Schema<IOperator>(
  {
    authSub: { type: String, required: true, unique: true, index: true },
    email: { type: String, trim: true, lowercase: true },
    name: { type: String },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.SALES_REP,
    },
    status: {
      type: String,
      enum: Object.values(UserStatus),
      default: UserStatus.ACTIVE,
      index: true,
    },
    // Optional: platform-wide operators (e.g. ADMIN) have no single tenant.
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

export default mongoose.model<IOperator>('Operator', OperatorSchema);
