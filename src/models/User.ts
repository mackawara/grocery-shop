import mongoose,{Schema} from "mongoose";

export enum UserStatus {
  UNVERIFIED = "unverified",
  BLACKLISTED = "blacklisted",
  VERIFIED = "verified",
}

export enum UserRole {
  VENDOR = "vendor",
  ADMIN = "admin",
  SHOP_MANAGER = "shopManager",
  SHOPKEEPER = "shopkeeper",
  SUPPORT_AGENT = "supportAgent",
}

export type TUser = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber: string;
  delivery_address?: mongoose.Types.ObjectId;
  status: UserStatus;
  role: UserRole;
};

const UserSchema = new Schema<TUser>(
  {
    firstName: { type: String },
    lastName: { type: String },
    email: { type: String },
    phoneNumber: { type: String, required: true, unique: true },
    delivery_address: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Delivery_Address",
    },
    status: {
      type: String,
      enum: Object.values(UserStatus),
      default: UserStatus.UNVERIFIED,
    },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.VENDOR,
    },
  },
  { timestamps: true },
);

UserSchema.index(
  { email: "text", firstName: "text", lastName: "text", phoneNumber: "text" },
  {
    weights: {
      firstName: 2,
      lastName: 2,
      email: 5,
      phoneNumber: 10,
    },
  },
);

export default mongoose.model<TUser>("User", UserSchema);