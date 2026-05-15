import mongoose, { Schema, Document } from "mongoose";

export interface IDeliveryAddress extends Document {
  user: mongoose.Types.ObjectId;
  streetNumber: string;
  streetName: string;
  area: string;
  subArea?: string;
  city: string;
  location_gps?: {
    latitude: number;
    longitude: number;
  };
}

const DeliveryAddressSchema = new Schema<IDeliveryAddress>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    streetNumber: {
      type: String,
      required: true,
      trim: true,
    },
    streetName: {
      type: String,
      required: true,
      trim: true,
    },
    area: {
      type: String,
      required: true,
      trim: true,
    },
    subArea: {
      type: String,
      trim: true,
    },
    city: {
      type: String,
      required: true,
      default: "Harare",
      trim: true,
    },
    location_gps: {
      latitude: { type: Number },
      longitude: { type: Number },
    },
  },
  { timestamps: true },
);

DeliveryAddressSchema.index({ area: 1, city: 1 });

export default mongoose.model<IDeliveryAddress>(
  "DeliveryAddress",
  DeliveryAddressSchema,
);
