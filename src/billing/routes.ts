import { Router, text } from 'express';
import { paymentWebhook } from './payments.ts';

const router = Router();
router.post('/paynow/webhook/:tenantId', text({ type: () => true, limit: '16kb' }), paymentWebhook);
export default router;
