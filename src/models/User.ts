import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { UserRole, UserStatus } from '../constants/models';
import { tenantScope } from './plugins/tenantScope';

export { UserRole, UserStatus };

export interface IUser extends Document {
  tenantId: Types.ObjectId;
  phoneNumber: string;
  name?: string;
  email?: string;
  address?: Types.ObjectId;
  role: UserRole;
  status: UserStatus;
  lastInteractionAt?: Date;
}

const UserSchema = new Schema<IUser>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    phoneNumber: { type: String, required: true },
    name: { type: String },
    email: { type: String, trim: true, lowercase: true },
    address: { type: Schema.Types.ObjectId, ref: 'DeliveryAddress' },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.CUSTOMER,
    },
    status: {
      type: String,
      enum: Object.values(UserStatus),
      default: UserStatus.ACTIVE,
      index: true,
    },
    lastInteractionAt: { type: Date },
  },
  { timestamps: true },
);

UserSchema.index({ tenantId: 1, phoneNumber: 1 }, { unique: true });

UserSchema.plugin(tenantScope);

export default mongoose.model<IUser>('User', UserSchema);
