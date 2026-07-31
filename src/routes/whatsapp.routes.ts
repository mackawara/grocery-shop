import { Router } from 'express';
import { verifyWebhookToken } from '../controllers/whatsapp/verifyWebhook.ts';
import { incomingMessagesHandler } from '../controllers/whatsapp/incomingMessages.ts';
import { whatsappTenantResolver } from '../controllers/middleware/whatsappTenantResolver.ts';
import { flowsHandler } from '../controllers/whatsapp/flowsHandler.ts';
import { verifyWhatsappSignature } from '../controllers/middleware/verifyWhatsappSignature.ts';

const router = Router();

// Meta's hub-challenge handshake is an unsigned GET, so it is registered ahead
// of the signature gate — the ONLY exemption, and deliberately visible as one.
router.get('/messages', verifyWebhookToken());

// Everything below is signature-verified by default. Applied with router.use
// rather than per-route so a webhook added later cannot silently skip the check
// — the failure mode of forgetting it is forged inbound messages driving
// tenant-scoped writes, which is exactly what must not depend on memory.
// Signature runs before tenant resolution: the payload is untrusted until the
// X-Hub-Signature-256 HMAC passes, so nothing may read it beforehand. /flows is
// covered too — its body is encrypted to our public key, but anyone with that
// key can produce a well-formed payload; only the signature proves Meta sent it.
router.use(verifyWhatsappSignature);

router.post('/messages', whatsappTenantResolver, incomingMessagesHandler);
router.post('/flows', flowsHandler);

export default router;
