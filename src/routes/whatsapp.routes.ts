import { Router } from 'express';
import { verifyWebhookToken } from '../controllers/whatsapp/verifyWebhook.ts';
import { incomingMessagesHandler } from '../controllers/whatsapp/incomingMessages.ts';
import { whatsappTenantResolver } from '../controllers/middleware/whatsappTenantResolver.ts';
import { flowsHandler } from '../controllers/whatsapp/flowsHandler.ts';

const router = Router();

router.get('/messages', verifyWebhookToken());
// resolver sets tenant context so incoming messages (and flows) save with the right tenantId
router.post('/messages', whatsappTenantResolver, incomingMessagesHandler);
router.post('/flows', flowsHandler);

export default router;
