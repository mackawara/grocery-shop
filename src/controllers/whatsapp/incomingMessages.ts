import { Request, Response } from "express";
import { logger } from "../../services/logger";
import { WebhookNotificationBody } from "../../types/types";



export const incomingMessagesHandler = async (req: Request, res: Response) => {
  const reqBody: WebhookNotificationBody = req.body;

  if (reqBody.object) {
    const { messages } = reqBody.entry[0].changes[0].value;
    if (messages) {
      const notificationType = messages[0].type;
      const clientNumber = messages[0].from;

      switch (notificationType) {
        case "text":
          {
            //Place the textHandler logic here
            logger.info("[TEXT_MESSAGE] : Processing WhatsApp text message from:", clientNumber);
          }
          break;
        case "interactive":
          {
              //Place the interactiveHandler logic here
                logger.info("[INTERACTIVE_MESSAGE] : Processing WhatsApp interactive message from:", clientNumber);
          }
          break;
        case "order":
          {
            //Place the orderHandler logic here
            logger.info("[ORDER_MESSAGE] : Processing WhatsApp catalog order from:", clientNumber);
          }
          break;
        case "reaction":
          {
            logger.info("[REACTION_MESSAGE] : Received a reaction Message");
          }
          break;
        default:
          break;
      }
      res.status(200).json({
        success: true,
      });
    }
  }
};