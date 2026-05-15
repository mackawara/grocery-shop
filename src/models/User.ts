// TODO: Stub model — fill in full schema fields (e.g. name, email, address) before production use
import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  phoneNumber: string;
  name?: string;
}

const UserSchema = new Schema<IUser>(
  {
    phoneNumber: { type: String, required: true, unique: true, index: true },
    name: { type: String },
  },
  { timestamps: true },
);

export default mongoose.model<IUser>('User', UserSchema);
