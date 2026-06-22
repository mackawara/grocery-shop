import crypto from 'crypto';
import { CONFIG } from '../config.js';

export interface EncryptedFlowRequest {
  encrypted_aes_key: string;
  encrypted_flow_data: string;
  initial_vector: string;
}

export interface DecryptedFlowRequest<T = unknown> {
  decryptedBody: T;
  aesKeyBuffer: Buffer;
  initialVectorBuffer: Buffer;
}

export class FlowKeyMismatchError extends Error {
  constructor(
    message = 'Flow private key does not match the public key registered on the WhatsApp account',
  ) {
    super(message);
    this.name = 'FlowKeyMismatchError';
  }
}

const getPrivateKey = (): crypto.KeyObject => {
  const pem = CONFIG.WHATSAPP_FLOW_PRIVATE_KEY;
  if (!pem) {
    throw new Error('WHATSAPP_FLOW_PRIVATE_KEY is not set');
  }
  const normalised = pem.replace(/\\n/g, '\n');
  const passphrase = CONFIG.WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE;
  return crypto.createPrivateKey(
    passphrase ? { key: normalised, passphrase } : { key: normalised },
  );
};

export const decryptFlowRequest = <T = unknown>(
  body: EncryptedFlowRequest,
): DecryptedFlowRequest<T> => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;

  const privateKey = getPrivateKey();

  let aesKeyBuffer: Buffer;
  try {
    aesKeyBuffer = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(encrypted_aes_key, 'base64'),
    );
  } catch {
    throw new FlowKeyMismatchError();
  }

  const flowDataBuffer = Buffer.from(encrypted_flow_data, 'base64');
  const initialVectorBuffer = Buffer.from(initial_vector, 'base64');

  // AES-GCM auth tag is the last 16 bytes of the ciphertext
  const TAG_LENGTH = 16;
  const encrypted = flowDataBuffer.subarray(0, flowDataBuffer.length - TAG_LENGTH);
  const authTag = flowDataBuffer.subarray(flowDataBuffer.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKeyBuffer, initialVectorBuffer);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const decryptedBody = JSON.parse(decrypted.toString('utf8')) as T;

  return { decryptedBody, aesKeyBuffer, initialVectorBuffer };
};

export const encryptFlowResponse = (
  response: unknown,
  aesKeyBuffer: Buffer,
  initialVectorBuffer: Buffer,
): string => {
  // Per Meta's spec: flip every bit of the IV for the response
  const flippedIv = Buffer.from(initialVectorBuffer.map((b) => ~b & 0xff));

  const cipher = crypto.createCipheriv('aes-128-gcm', aesKeyBuffer, flippedIv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([encrypted, authTag]).toString('base64');
};

// Convenience guard: import-time check would crash the app if the env is missing,
// so we expose a runtime helper used by the controller to fail fast with a clear log.
export const assertFlowCryptoConfigured = (): void => {
  if (!CONFIG.WHATSAPP_FLOW_PRIVATE_KEY) {
    throw new Error('WHATSAPP_FLOW_PRIVATE_KEY is not configured');
  }
};
