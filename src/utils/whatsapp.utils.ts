import { logger } from '../services/logger.ts';
import type {
  WaMessageDirection,
  WaMessageType,
  WaInteractiveType,
  WaMessageStatus,
} from '../models/whatsappMessage.model.ts';
import WhatsappMessage from '../models/whatsappMessage.model.ts';

const TAG = '[WHATSAPP_UTILS]';

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
    logger.info(`${TAG}: Saving message:`, data);
    await WhatsappMessage.create(data);
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
