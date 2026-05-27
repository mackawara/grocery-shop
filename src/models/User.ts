// TODO: Stub model — fill in full schema fields (e.g. name, email, address) before production use
<<<<<<< HEAD
import type { Document, Types } from "mongoose";
import mongoose, { Schema } from "mongoose";
import { UserRole } from "../constants/models";

export { UserRole };
=======
import type { Document} from 'mongoose';
import mongoose, { Schema } from 'mongoose';
>>>>>>> cc2ce29 (CU-86ba552pv - lint files)

export interface IUser extends Document {
  tenantId: Types.ObjectId;
  phoneNumber: string;
  name?: string;
  role: UserRole;
}

const UserSchema = new Schema<IUser>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    phoneNumber: { type: String, required: true },
    name: { type: String },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.CUSTOMER,
    },
  },
  { timestamps: true },
);

UserSchema.index({ tenantId: 1, phoneNumber: 1 }, { unique: true });

export default mongoose.model<IUser>("User", UserSchema);
