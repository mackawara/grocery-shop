import { Router } from 'express';
import { verifyWebhookToken } from '../controllers/whatsapp/verifyWebhook.js';
import { incomingMessagesHandler } from '../controllers/whatsapp/incomingMessages.js';
import { whatsappTenantResolver } from '../controllers/middleware/whatsappTenantResolver.js';
import { flowsHandler } from '../controllers/whatsapp/flowsHandler.js';

const router = Router();

router.get('/messages', verifyWebhookToken());
// resolver sets tenant context so incoming messages (and flows) save with the right tenantId
router.post('/messages', whatsappTenantResolver, incomingMessagesHandler);
router.post('/flows', flowsHandler);

export default router;
