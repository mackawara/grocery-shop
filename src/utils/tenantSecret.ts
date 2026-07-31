import crypto from 'crypto';

import { CONFIG } from '../config.ts';

/**
 * Application-level encryption for high-value per-tenant secrets stored in
 * Mongo (currently the WhatsApp access token). The key is deliberately named
 * CREDENTIAL_ENC_KEY rather than after any one feature: payment credentials are
 * the obvious next candidate, and a feature-named key would mean either
 * encrypting them under a misleading name or migrating envelopes later.
 *
 * Why this exists on top of `select:false`: `select:false` stops a secret from
 * riding along on incidental reads, but it is still plaintext at rest. A
 * WhatsApp business token is a *bearer* credential — anyone holding it can send
 * messages as the vendor — so a database dump alone must not be enough to use
 * it. Payment credentials predate this helper and remain `select:false` only.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently yielding garbage. Encoded as `v1:<iv>:<tag>:<ciphertext>`, all
 * base64url; the version prefix lets us rotate the scheme later without having
 * to guess at the format of existing rows.
 */

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_LENGTH = 12; // 96-bit nonce, the GCM standard
const KEY_LENGTH = 32; // AES-256
const PARTS = 4;

export class TenantSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantSecretError';
  }
}

// Resolved lazily (not at module load) so importing this file never crashes a
// process that has no need to touch secrets — e.g. scripts and tests.
let cachedKey: Buffer | undefined;

const getKey = (): Buffer => {
  if (cachedKey) {
    return cachedKey;
  }
  const raw = CONFIG.CREDENTIAL_ENC_KEY;
  if (!raw) {
    throw new TenantSecretError('CREDENTIAL_ENC_KEY is not set');
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'hex');
  } catch {
    throw new TenantSecretError('CREDENTIAL_ENC_KEY is not valid hex');
  }
  if (key.length !== KEY_LENGTH) {
    // Never include the key or its contents in the message.
    throw new TenantSecretError(
      `CREDENTIAL_ENC_KEY must decode to ${KEY_LENGTH} bytes (got ${key.length}); generate one with: openssl rand -hex 32`,
    );
  }
  cachedKey = key;
  return cachedKey;
};

/** Encrypt a secret for storage. Returns the `v1:iv:tag:ciphertext` envelope. */
export const encryptSecret = (plaintext: string): string => {
  if (!plaintext) {
    throw new TenantSecretError('encryptSecret: plaintext is required');
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
};

/**
 * Decrypt a stored secret. Throws on a malformed envelope, an unknown version,
 * or a failed authentication tag (wrong key or tampered ciphertext) — callers
 * should treat any throw as "this credential is unusable", not retry it.
 */
export const decryptSecret = (envelope: string): string => {
  if (!envelope) {
    throw new TenantSecretError('decryptSecret: envelope is required');
  }
  const parts = envelope.split(':');
  if (parts.length !== PARTS) {
    throw new TenantSecretError('decryptSecret: malformed envelope');
  }
  const [version, iv, tag, ciphertext] = parts;
  if (version !== VERSION) {
    throw new TenantSecretError(`decryptSecret: unsupported envelope version ${version}`);
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    // Deliberately does not echo the envelope or the underlying error detail —
    // both can leak ciphertext material into logs.
    throw new TenantSecretError(
      `decryptSecret: failed to decrypt (wrong key or tampered ciphertext)${
        err instanceof Error && err.name ? ` [${err.name}]` : ''
      }`,
    );
  }
};
