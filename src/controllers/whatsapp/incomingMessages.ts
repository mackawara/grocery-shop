import type { Request, Response } from 'express';
import { logger } from '../../services/logger.ts';
import type {
  WebhookNotificationBody,
  Text,
  InteractiveMessageNotification,
  OrderMessageNotification,
  ReactionMessageNotification,
  LocationMessageNotification,
} from '../../types/types.ts';

import {
  textHandler,
  interactiveHandler,
  reactionHandler,
  locationHandler,
  isWhatsAppMessageProcessed,
} from './conversation.controller.ts';
import { whatsappOrderHandler } from './whatsappOrderHandler.ts';
import { saveWhatsappMessage } from '../../utils/whatsapp.utils.ts';
import type { WaInteractiveType, WaMessageType } from '../../models/whatsappMessage.model.ts';
import type { InteractivePayLoad, Order } from '../../types/types.ts';
import { fromUnixTime } from 'date-fns';

// The audit trail stored what the customer *could* have replied with (the raw
// interactive type, e.g. "button_reply") rather than what they actually chose,
// so a transcript read back later — the dashboard Chats view, support triage —
// lost the answer. These helpers recover the human-readable reply.

// Flow submissions arrive as a JSON string of the form's fields. Render them as
// a compact "field: value" line rather than a raw blob, and drop flow_token: it
// is a correlation secret and has no place in a readable message log.
const FLOW_SUMMARY_MAX = 400;

const flowValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value) ?? '';
  }
  return String(value);
};

const summarizeFlowResponse = (responseJson: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseJson);
  } catch {
    // A malformed payload is not worth failing the webhook over — the flow's
    // own handler still ran; we just can't describe it.
    return 'Submitted a form';
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return 'Submitted a form';
  }

  const summary = Object.entries(parsed as Record<string, unknown>)
    .filter(([key]) => key !== 'flow_token')
    .map(([key, value]) => `${key}: ${flowValue(value)}`)
    .join(' · ');

  if (!summary) {
    return 'Submitted a form';
  }
  return summary.length > FLOW_SUMMARY_MAX ? `${summary.slice(0, FLOW_SUMMARY_MAX)}…` : summary;
};

// What the customer actually picked. Falls back to the interactive type so the
// row is never empty (the save below is gated on a non-empty content).
const describeInteractiveReply = (interactive: InteractivePayLoad): string => {
  switch (interactive.type) {
    case 'button_reply': {
      return interactive.button_reply.title || interactive.type;
    }
    case 'list_reply': {
      const { title, description } = interactive.list_reply;
      if (title && description) {
        return `${title} — ${description}`;
      }
      return title || description || interactive.type;
    }
    case 'nfm_reply': {
      return summarizeFlowResponse(interactive.nfm_reply.response_json);
    }
    default: {
      return (interactive as { type: string }).type;
    }
  }
};

// A submitted cart. The catalog id we used to store is an internal Meta
// identifier and tells an operator nothing; the useful facts are how much the
// customer is buying, for how much, and any note they typed with the cart.
// Prices arrive as strings, so coerce defensively — a malformed figure must not
// turn the whole summary into NaN.
const summarizeOrder = (order: Order): string => {
  const items = order.product_items ?? [];
  const units = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const total = items.reduce(
    (sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.item_price) || 0),
    0,
  );

  const parts = [`${units} item${units === 1 ? '' : 's'}`];
  if (items.length > 1) {
    parts.push(`${items.length} products`);
  }
  if (total > 0) {
    parts.push(`${items[0]?.currency ?? ''} ${total.toFixed(2)}`.trim());
  }

  const summary = parts.join(' · ');
  const note = order.text?.trim();
  return note ? `${summary} — "${note}"` : summary;
};

export const incomingMessagesHandler = async (req: Request, res: Response) => {
  res.status(200).json({ success: true }); // early return to avoid repeated processing in case of retries from WhatsApp

  const reqBody: WebhookNotificationBody = req.body;

  try {
    if (reqBody.object) {
      const { messages } = reqBody.entry[0].changes[0].value;
      if (messages) {
        const { id: messageId, type: messageType, from, timestamp } = messages[0];
        const waTimestamp = fromUnixTime(Number(timestamp));

        if (await isWhatsAppMessageProcessed(messageId)) {
          logger.warn('[INCOMING_MESSAGE] : Duplicate message ignored:', messageId);
          return;
        }

        let content = '';
        let interactiveType: WaInteractiveType | undefined;

        switch (messageType) {
          case 'text': {
            const { text } = messages[0] as Text;
            content = text.body;
            await textHandler(from, text);
            break;
          }
          case 'interactive': {
            const { interactive } = messages[0] as InteractiveMessageNotification;
            interactiveType = interactive.type;
            content = describeInteractiveReply(interactive);
            await interactiveHandler(from, interactive);
            break;
          }
          case 'order': {
            const { order } = messages[0] as OrderMessageNotification;
            content = summarizeOrder(order);
            await whatsappOrderHandler(from, order);
            break;
          }
          case 'reaction': {
            const { reaction } = messages[0] as ReactionMessageNotification;
            content = reaction.emoji;
            await reactionHandler(from, reaction);
            break;
          }
          case 'location': {
            const { location } = messages[0] as LocationMessageNotification;
            content = `${location.latitude},${location.longitude}`;
            await locationHandler(from, location);
            break;
          }
          default:
            logger.warn('[INCOMING_MESSAGE] : Unhandled message type:', messageType, 'from:', from);
        }

        if (content) {
          await saveWhatsappMessage({
            phoneNumber: from,
            direction: 'inbound',
            messageType: messageType as WaMessageType,
            interactiveType,
            content,
            externalId: messageId,
            timestamp: waTimestamp,
            status: 'received',
          });
        }
      }
    }
  } catch (error) {
    logger.error('[INCOMING_MESSAGE] : Error processing incoming message:', error);
  }
};
