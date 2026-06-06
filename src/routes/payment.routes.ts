import { Router, text } from 'express';
import type { Request, Response } from 'express';
import { isPaynowWebhookAccepted } from '../controllers/payments/payment.controller';
import { logger } from '../services/logger';

const router = Router();
// TODO Fix the route and make it less broad
// Paynow's resultUrl callback — the final status that flips an order to paid.
// Raw body (not urlencoded) because the SDK re-hashes the exact bytes.
router.post(
  '/paynow/webhook/:slug',
  text({ type: () => true }),
  async (req: Request, res: Response): Promise<void> => {
    const slug = String(req.params.slug);
    const rawBody = typeof req.body === 'string' ? req.body : '';
    try {
      const accepted = await isPaynowWebhookAccepted(slug, rawBody);
      // 200 'ok' so Paynow stops retrying; 400 nudges a retry on bad/forged data.
      res.status(accepted ? 200 : 400).send(accepted ? 'ok' : 'error');
    } catch (error) {
      logger.error(`[PAYMENT_ROUTE] Paynow webhook error for ${slug}: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).send('error');
    }
  },
);

// Unused by mobile push, but Paynow requires the returnUrl to exist.
router.get('/paynow/return', (_req: Request, res: Response): void => {
  res.send('Thank you! You can return to WhatsApp — we\'ll confirm your payment there.');
});

export default router;
