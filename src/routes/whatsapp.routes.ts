import { Router } from 'express';
import { verifyWebhookToken } from '../controllers/whatsapp/verifyWebhook';
import { incomingMessagesHandler } from '../controllers/whatsapp/incomingMessages';
//import { whatsappTenantResolver } from '../controllers/middleware/whatsappTenantResolver';
import { flowsHandler } from '../controllers/whatsapp/flowsHandler';

const router = Router();

router.get('/messages', verifyWebhookToken());
//router.post('/messages', whatsappTenantResolver, incomingMessagesHandler);// reinstate tenant resolver middleware for incoming messages to ensure correct tenant context is set for flows
router.post('/messages', incomingMessagesHandler);// reinstate tenant resolver middleware for incoming messages to ensure correct tenant context is set for flows
router.post('/flows', flowsHandler);

export default router;
