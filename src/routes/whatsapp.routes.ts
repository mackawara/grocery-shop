import { Router } from 'express';
import { verifyWebhookToken } from '../controllers/whatsapp/verifyWebhook';
import { incomingMessagesHandler } from '../controllers/whatsapp/incomingMessages';
import { whatsappTenantResolver } from '../controllers/middleware/whatsappTenantResolver';
import { flowsHandler } from '../controllers/whatsapp/flowsHandler';

const router = Router();

router.get('/messages', verifyWebhookToken());
// resolver sets tenant context so incoming messages (and flows) save with the right tenantId
router.post('/messages', whatsappTenantResolver, incomingMessagesHandler);
router.post('/flows', flowsHandler);

export default router;
