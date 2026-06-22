import type { Request, Response } from 'express';
import { logger } from '../../services/logger.js';
import type {
  WebhookNotificationBody,
  Text,
  InteractiveMessageNotification,
  OrderMessageNotification,
  ReactionMessageNotification,
  LocationMessageNotification,
} from '../../types/types.js';

import {
  textHandler,
  interactiveHandler,
  reactionHandler,
  locationHandler,
  isWhatsAppMessageProcessed,
} from './conversation.controller.js';
import { whatsappOrderHandler } from './whatsappOrderHandler.js';
import { saveWhatsappMessage } from '../../utils/whatsapp.utils.js';
import type { WaInteractiveType, WaMessageType } from '../../models/whatsappMessage.model.js';
import { fromUnixTime } from 'date-fns';

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
            content = interactive.type;
            await interactiveHandler(from, interactive);
            break;
          }
          case 'order': {
            const { order } = messages[0] as OrderMessageNotification;
            content = `${order.product_items.length} item(s) from catalog ${order.catalog_id}`;
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
