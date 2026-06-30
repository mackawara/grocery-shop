import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope.ts';
import {
  WA_MESSAGE_TYPES,
  WA_INTERACTIVE_TYPES,
  WA_MESSAGE_DIRECTIONS,
  WA_MESSAGE_STATUSES,
} from '../constants/whatsapp.ts';

// The message vocabulary now lives in constants/whatsapp.ts (single source of
// truth); re-exported here so existing model-based imports keep working.
export type {
  WaMessageDirection,
  WaMessageType,
  WaInteractiveType,
  WaMessageStatus,
} from '../constants/whatsapp.ts';

import type {
  WaMessageDirection,
  WaMessageType,
  WaInteractiveType,
  WaMessageStatus,
} from '../constants/whatsapp.ts';

export interface IWhatsappMessage extends Document {
  tenantId: Types.ObjectId;
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
    // Optional (not required) so genuinely pre-tenant outbound audit rows can be
    // saved — e.g. the vendor-signup OTP, sent before any Tenant exists. Under a
    // normal tenant context the tenantScope plugin still injects tenantId on every
    // new doc, so tenant-owned messages always carry one; only bypass writes
    // (runWithoutTenant) may leave it unset, and those rows surface only under bypass.
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: false, index: true },
    phoneNumber: { type: String, required: true },
    direction: { type: String, enum: WA_MESSAGE_DIRECTIONS, required: true },
    messageType: {
      type: String,
      enum: WA_MESSAGE_TYPES,
      required: true,
    },
    interactiveType: {
      type: String,
      enum: WA_INTERACTIVE_TYPES,
      default: null,
    },
    content: { type: String, required: true },
    externalId: { type: String, sparse: true },
    timestamp: { type: Date, required: true },
    status: {
      type: String,
      enum: WA_MESSAGE_STATUSES,
      required: true,
    },
  },
  { timestamps: true },
);

WhatsappMessageSchema.index({ tenantId: 1, phoneNumber: 1 });
WhatsappMessageSchema.index({ tenantId: 1, externalId: 1 }, { unique: true, sparse: true });

WhatsappMessageSchema.plugin(tenantScope);

export default mongoose.model<IWhatsappMessage>('WhatsappMessage', WhatsappMessageSchema);
