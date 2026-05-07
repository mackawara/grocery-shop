import { Request, Response } from "express";
import { logger } from "../../services/logger";
import {
  WebhookNotificationBody,
  Text,
  InteractiveMessageNotification,
  OrderMessageNotification,
  ReactionMessageNotification,
} from "../../types/types";
import { textHandler, interactiveHandler, reactionHandler, isWhatsAppMessageProcessed } from "./conversation.controller";
import { orderHandler } from "./whatsappOrderHandler";

export const incomingMessagesHandler = async (req: Request, res: Response) => {
  const reqBody: WebhookNotificationBody = req.body;

  try {
    if (reqBody.object) {
      const { messages } = reqBody.entry[0].changes[0].value;
      if (messages) {
        const message = messages[0];
        const { id: messageId, type: notificationType, from } = message;

        if (await isWhatsAppMessageProcessed(messageId)) {
          logger.warn("[INCOMING_MESSAGE] : Duplicate message ignored:", messageId);
          return res.status(200).json({ success: true });
        }

        switch (notificationType) {
          case "text":
            {
              const { text } = message as Text;
              await textHandler(from, text);
            }
            break;
          case "interactive":
            {
              const { interactive } = message as InteractiveMessageNotification;
              await interactiveHandler(from, interactive);
            }
            break;
          case "order":
            {
              const { order } = message as OrderMessageNotification;
              await orderHandler(from, order);
            }
            break;
          case "reaction":
            {
              const { reaction } = message as ReactionMessageNotification;
              await reactionHandler(from, reaction);
            }
            break;
          default:
            logger.warn("[INCOMING_MESSAGE] : Unhandled message type:", notificationType, "from:", from);
            break;
        }
      }
    }
  } catch (error) {
    logger.error("[INCOMING_MESSAGE] : Error processing incoming message:", error);
  }

  return res.status(200).json({
    success: true,
  });
};
