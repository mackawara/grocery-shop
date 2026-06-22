import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import type { MessageNotification, InteractivePayLoad } from '../types/types.js';
import { tenantScope } from './plugins/tenantScope.js';

export type WaMessageDirection = 'inbound' | 'outbound';
export type WaMessageType = MessageNotification['type'];
export type WaInteractiveType =
  | InteractivePayLoad['type']
  | 'flow'
  | 'button'
  | 'list'
  | 'product_list'
  | 'catalog_message'
  | 'cta_url'
  | 'location_request_message';
export type WaMessageStatus = 'received' | 'sent' | 'failed';

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
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    phoneNumber: { type: String, required: true },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    messageType: {
      type: String,
      enum: ['text', 'interactive', 'order', 'reaction', 'location'],
      required: true,
    },
    interactiveType: {
      type: String,
      enum: [
        'button_reply',
        'list_reply',
        'nfm_reply',
        'flow',
        'button',
        'list',
        'product_list',
        'catalog_message',
        'cta_url',
        'location_request_message',
      ],
      default: null,
    },
    content: { type: String, required: true },
    externalId: { type: String, sparse: true },
    timestamp: { type: Date, required: true },
    status: {
      type: String,
      enum: ['received', 'sent', 'failed'],
      required: true,
    },
  },
  { timestamps: true },
);

WhatsappMessageSchema.index({ tenantId: 1, phoneNumber: 1 });
WhatsappMessageSchema.index({ tenantId: 1, externalId: 1 }, { unique: true, sparse: true });

WhatsappMessageSchema.plugin(tenantScope);

export default mongoose.model<IWhatsappMessage>('WhatsappMessage', WhatsappMessageSchema);
