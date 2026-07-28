import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

import { CONFIG } from '../../config.ts';
import { logger } from '../../services/logger.ts';

const TAG = '[verifyWhatsappSignature]';

// Request with the raw body buffer captured by express.json's verify hook in
// server.ts. Signature verification MUST run over the exact bytes Meta sent —
// re-serialising the parsed body is not byte-stable and would fail valid
// signatures.
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Verifies Meta's X-Hub-Signature-256 header: HMAC-SHA256 of the raw request
 * body, keyed with our app secret. This is the authenticity check for every
 * WhatsApp webhook — without it, anyone who learns a tenant's phone_number_id
 * can forge inbound messages for that tenant (the resolver trusts the payload).
 *
 * Rollout is two-phase via WHATSAPP_SIGNATURE_ENFORCE:
 *   - log-only (default): invalid/missing signatures are logged loudly but the
 *     request continues. Deploy this first and watch for [SIGNATURE-MISMATCH]
 *     in production — a misconfigured secret here would otherwise reject ALL
 *     inbound traffic at once.
 *   - enforcing: invalid signatures get 403 and are never processed. Flip the
 *     env var once the log-only period shows a clean signal.
 *
 * 403 (not 200) on rejection: we want Meta to retry a genuinely-signed message
 * that we misjudged, and a forger learns nothing useful from the status code.
 */
// Returns why the signature is unacceptable, or null when it verifies. Split
// out so there is exactly one value to reason about — a "valid but with a
// reason" state is not representable.
const signatureFailure = (req: Request): string | null => {
  const header = req.get('x-hub-signature-256');
  if (!header?.startsWith('sha256=')) {
    return 'missing or malformed X-Hub-Signature-256 header';
  }

  const rawBody = (req as RawBodyRequest).rawBody;
  if (!rawBody || rawBody.length === 0) {
    // No captured bytes to verify against (e.g. a route without the capturing
    // parser) — treat as unverifiable, never as trusted.
    return 'no raw body captured for this request';
  }

  const expected = createHmac('sha256', CONFIG.WHATSAPP_APP_SECRET).update(rawBody).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  // timingSafeEqual throws on length mismatch, so guard it (same pattern as
  // signupOtp). Length mismatch == invalid.
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return 'signature does not match body HMAC';
  }
  return null;
};

export const verifyWhatsappSignature = (req: Request, res: Response, next: NextFunction): void => {
  const detail = signatureFailure(req);
  if (detail === null) {
    next();
    return;
  }

  // Never log the body or the signature value — the body is untrusted attacker
  // input and partial HMACs aid offline guessing. Path + reason is enough.
  if (CONFIG.WHATSAPP_SIGNATURE_ENFORCE) {
    logger.warn(`${TAG} rejected ${req.path}: ${detail}`);
    res.status(403).json({ success: false });
    return;
  }
  logger.warn(
    `${TAG} [SIGNATURE-MISMATCH] ${req.path}: ${detail} — log-only mode, processing anyway`,
  );
  next();
};
