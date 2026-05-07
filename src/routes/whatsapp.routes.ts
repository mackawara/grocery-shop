import { Router } from "express";
import { verifyWebhookToken } from "../controllers/whatsapp/verifyWebhook";

const router = Router();

router.get("/messages", verifyWebhookToken());

export default router;
