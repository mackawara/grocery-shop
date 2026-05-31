import { Router } from 'express';
import { verifyWebhookToken } from '../controllers/whatsapp/verifyWebhook';
import { incomingMessagesHandler } from '../controllers/whatsapp/incomingMessages';
import { whatsappTenantResolver } from '../controllers/middleware/whatsappTenantResolver';

const router = Router();

router.get('/messages', verifyWebhookToken());
router.post('/messages', whatsappTenantResolver, incomingMessagesHandler);

export default router;
