import type { Request, Response } from 'express';
import { logger } from '../../services/logger.ts';
import {
  decryptFlowRequest,
  encryptFlowResponse,
  FlowKeyMismatchError,
  type EncryptedFlowRequest,
} from '../../utils/whatsappFlowCrypto.ts';

interface FlowDataExchange {
  version: string;
  action: 'INIT' | 'BACK' | 'data_exchange' | 'ping';
  screen?: string;
  data?: Record<string, unknown>;
  flow_token?: string;
}

export const flowsHandler = async (req: Request, res: Response): Promise<Response> => {
  const body = req.body as EncryptedFlowRequest;

  if (!body?.encrypted_aes_key || !body?.encrypted_flow_data || !body?.initial_vector) {
    logger.warn('[FLOWS] Missing encrypted payload fields');
    return res.status(400).send('Bad request');
  }

  let decrypted;
  try {
    decrypted = decryptFlowRequest<FlowDataExchange>(body);
  } catch (error) {
    if (error instanceof FlowKeyMismatchError) {
      logger.error('[FLOWS] Key mismatch — returning 421 so Meta refreshes the public key');
      return res.status(421).send('Key mismatch');
    }
    logger.error('[FLOWS] Failed to decrypt flow request:', error);
    return res.status(500).send('Decryption failed');
  }

  const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decrypted;
  logger.info(
    '[FLOWS] Decrypted request — action:',
    decryptedBody.action,
    '| screen:',
    decryptedBody.screen,
  );

  // Health-check ping from Meta — must respond with { data: { status: "active" } }
  const responsePayload =
    decryptedBody.action === 'ping'
      ? { data: { status: 'active' } }
      : { version: decryptedBody.version, data: { acknowledged: true } };

  const encrypted = encryptFlowResponse(responsePayload, aesKeyBuffer, initialVectorBuffer);
  return res.status(200).type('text/plain').send(encrypted);
};
