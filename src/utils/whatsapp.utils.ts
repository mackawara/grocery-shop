import { logger } from '../services/logger.ts';
import type {
  WaMessageDirection,
  WaMessageType,
  WaInteractiveType,
  WaMessageStatus,
} from '../models/whatsappMessage.model.ts';
import WhatsappMessage from '../models/whatsappMessage.model.ts';
import Conversation from '../models/Conversation.ts';
import { getTenantId } from '../context/tenantContext.ts';
import { maskPhone } from './phone.ts';

const TAG = '[WHATSAPP_UTILS]';

// Length of the denormalised preview kept on the conversation summary. Matches
// the dashboard list's needs; the thread endpoint serves full content.
const PREVIEW_LENGTH = 160;

export interface WhatsappMessagePayload {
  phoneNumber: string;
  direction: WaMessageDirection;
  messageType: WaMessageType;
  interactiveType?: WaInteractiveType;
  content: string;
  externalId?: string;
  timestamp: Date;
  status: WaMessageStatus;
}

const preview = (content: string): string =>
  content.length > PREVIEW_LENGTH ? `${content.slice(0, PREVIEW_LENGTH)}…` : content;

/**
 * Update the materialised conversation summary for this message.
 *
 * Uses an aggregation-pipeline update so the whole thing is one round trip and,
 * crucially, so the summary only moves FORWARD: a retried webhook or an
 * out-of-order write must not roll `lastMessage` back to an older message.
 * `messageCount` still increments for every stored message regardless of order.
 *
 * Runs only after the message itself was stored, so a deduplicated (duplicate
 * externalId) message never inflates the count.
 */
const updateConversationSummary = async (data: WhatsappMessagePayload, messageId: unknown) => {
  // Pre-tenant audit rows (e.g. the vendor-signup OTP, sent before any Tenant
  // exists) have no conversation to summarise — the dashboard list is
  // tenant-scoped by definition.
  if (!getTenantId()) {
    return;
  }

  const EPOCH = new Date(0);
  const incoming = {
    messageId,
    direction: data.direction,
    messageType: data.messageType,
    interactiveType: data.interactiveType ?? null,
    preview: preview(data.content),
    timestamp: data.timestamp,
    status: data.status,
  };

  await Conversation.updateOne(
    { phoneNumber: data.phoneNumber },
    [
      {
        $set: {
          messageCount: { $add: [{ $ifNull: ['$messageCount', 0] }, 1] },
          lastMessage: {
            $cond: [
              { $gt: [data.timestamp, { $ifNull: ['$lastMessageAt', EPOCH] }] },
              incoming,
              { $ifNull: ['$lastMessage', incoming] },
            ],
          },
          lastMessageAt: { $max: [data.timestamp, { $ifNull: ['$lastMessageAt', EPOCH] }] },
        },
      },
    ],
    { upsert: true },
  );
};

export const saveWhatsappMessage = async (data: WhatsappMessagePayload): Promise<void> => {
  try {
    // Deliberately does NOT log the payload. `content` carries message bodies and
    // flow field values (delivery addresses, order notes) — customer PII that
    // must not accumulate in log storage on every inbound message. Direction,
    // type and a masked number are enough to trace a message through the
    // pipeline; the body itself is available in the DB when genuinely needed.
    logger.info(
      `${TAG}: Saving ${data.direction} ${data.messageType} message from ${maskPhone(data.phoneNumber)}`,
    );
    const saved = await WhatsappMessage.create(data);
    await updateConversationSummary(data, saved._id);
  } catch (err: unknown) {
    if (err instanceof Error && (err as { code?: number }).code === 11000) {
      logger.warn(`${TAG}: Duplicate externalId skipped: ${data.externalId}`);
      return;
    }
    if (err instanceof Error && err.name === 'ValidationError') {
      logger.error(`${TAG}: Validation error:`, err.message);
      return;
    }
    logger.error(`${TAG}: Unexpected error saving message:`, err);
  }
};
