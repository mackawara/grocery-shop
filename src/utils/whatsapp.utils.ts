import { logger } from "../services/logger";
import WhatsappMessage, {
  WaMessageDirection,
  WaMessageType,
  WaInteractiveType,
  WaMessageStatus,
} from "../models/whatsappMessage.model";

const TAG = "[WHATSAPP_UTILS]";

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

export const saveWhatsappMessage = async (data: WhatsappMessagePayload): Promise<void> => {
  try {
    await WhatsappMessage.create(data);
  } catch (err: any) {
    if (err.code === 11000) {
      logger.warn(`${TAG}: Duplicate externalId skipped: ${data.externalId}`);
      return;
    }
    if (err.name === "ValidationError") {
      logger.error(`${TAG}: Validation error:`, err.message);
      return;
    }
    logger.error(`${TAG}: Unexpected error saving message:`, err);
  }
};
