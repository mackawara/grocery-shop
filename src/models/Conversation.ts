import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope.ts';
import {
  WA_MESSAGE_TYPES,
  WA_INTERACTIVE_TYPES,
  WA_MESSAGE_DIRECTIONS,
  WA_MESSAGE_STATUSES,
} from '../constants/whatsapp.ts';
import type {
  WaMessageDirection,
  WaMessageType,
  WaInteractiveType,
  WaMessageStatus,
} from '../constants/whatsapp.ts';

/**
 * Materialised one-row-per-conversation summary of the WhatsApp message log.
 *
 * Why this exists: the dashboard conversation list previously derived itself by
 * `$sort` + `$group` over a tenant's ENTIRE message history on every request.
 * No index can serve a `$group` by phoneNumber across the whole log, so cost grew
 * with total messages ever exchanged — and a large sort risks the aggregation
 * memory limit. This collection is updated on write instead, so the list becomes
 * an indexed find + skip/limit that scales with conversation count (bounded by
 * customers) rather than message count (unbounded).
 *
 * It is a derived view: `scripts/backfillConversations.ts` can rebuild it from
 * the message log at any time, so it is safe to drop and regenerate.
 */

// Denormalised copy of the newest message in the conversation. Stores a
// truncated `preview`, not the full body: the list only ever renders a preview,
// and duplicating full message content (which can carry flow field values like
// delivery addresses) into a second collection would widen PII exposure for no
// benefit. The thread endpoint reads full content from the message log.
export interface IConversationLastMessage {
  messageId: Types.ObjectId;
  direction: WaMessageDirection;
  messageType: WaMessageType;
  interactiveType?: WaInteractiveType | null;
  preview: string;
  timestamp: Date;
  status: WaMessageStatus;
}

export interface IConversation extends Document {
  tenantId: Types.ObjectId;
  phoneNumber: string;
  lastMessage: IConversationLastMessage;
  // Hoisted out of lastMessage so it can be indexed for the list's sort.
  lastMessageAt: Date;
  messageCount: number;
}

const LastMessageSchema = new Schema<IConversationLastMessage>(
  {
    messageId: { type: Schema.Types.ObjectId, ref: 'WhatsappMessage', required: true },
    direction: { type: String, enum: WA_MESSAGE_DIRECTIONS, required: true },
    messageType: { type: String, enum: WA_MESSAGE_TYPES, required: true },
    interactiveType: { type: String, enum: WA_INTERACTIVE_TYPES, default: null },
    preview: { type: String, required: true },
    timestamp: { type: Date, required: true },
    status: { type: String, enum: WA_MESSAGE_STATUSES, required: true },
  },
  { _id: false },
);

const ConversationSchema = new Schema<IConversation>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    phoneNumber: { type: String, required: true },
    lastMessage: { type: LastMessageSchema, required: true },
    lastMessageAt: { type: Date, required: true },
    messageCount: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

// One row per (tenant, customer number) — the upsert key on the write path.
ConversationSchema.index({ tenantId: 1, phoneNumber: 1 }, { unique: true });
// Serves the list's default ordering (newest conversation first) directly.
ConversationSchema.index({ tenantId: 1, lastMessageAt: -1 });

ConversationSchema.plugin(tenantScope);

export default mongoose.model<IConversation>('Conversation', ConversationSchema);
