import mongoose, { Schema, Document } from "mongoose";
import { MessageNotification, InteractivePayLoad } from "../types/types";

export type WaMessageDirection = "inbound" | "outbound";
export type WaMessageType = MessageNotification["type"];
export type WaInteractiveType =
  | InteractivePayLoad["type"]
  | "flow"
  | "button"
  | "list"
  | "product_list"
  | "catalog_message"
  | "cta_url";
export type WaMessageStatus = "received" | "sent" | "failed";

export interface IWhatsappMessage extends Document {
  phoneNumber: string;
  direction: WaMessageDirection;
  messageType: WaMessageType;
  interactiveType?: WaInteractiveType;
  content: string;
  externalId?: string;
  timestamp: Date;
  status: WaMessageStatus;
}

const WhatsappMessageSchema = new Schema<IWhatsappMessage>(
  {
    phoneNumber: { type: String, required: true, index: true },
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    messageType: {
      type: String,
      enum: ["text", "interactive", "order", "reaction"],
      required: true,
    },
    interactiveType: {
      type: String,
      enum: [
        "button_reply",
        "list_reply",
        "nfm_reply",
        "flow",
        "button",
        "list",
        "product_list",
        "catalog_message",
        "cta_url",
      ],
      default: null,
    },
    content: { type: String, required: true },
    externalId: { type: String, unique: true, sparse: true },
    timestamp: { type: Date, required: true },
    status: {
      type: String,
      enum: ["received", "sent", "failed"],
      required: true,
    },
  },
  { timestamps: true },
);

export default mongoose.models?.WhatsappMessage ||
  mongoose.model<IWhatsappMessage>("WhatsappMessage", WhatsappMessageSchema);
