import { Router } from "express";
import { verifyWebhookToken } from "../controllers/whatsapp/verifyWebhook";
import { incomingMessagesHandler } from "../controllers/whatsapp/incomingMessages";

const router = Router();

router.get("/messages", verifyWebhookToken());
router.post("/messages", incomingMessagesHandler);

export default router;
