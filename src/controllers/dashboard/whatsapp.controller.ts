import type { Request, Response } from 'express';
import { z } from 'zod';

import { WhatsappConnectionStatus } from '../../constants/models.ts';
import { logger } from '../../services/logger.ts';
import type { ConnectFailureReason } from '../../services/whatsappOnboarding.ts';
import {
  connectTenantWhatsapp,
  disconnectTenantWhatsapp,
  getTenantWhatsappConnection,
} from '../../services/whatsappOnboarding.ts';

const TAG = '[whatsappConnect]';

// Graph ids are numeric strings; a sane length cap keeps junk out of the index.
const graphId = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,20}$/, `${label} must be a numeric Meta id.`);

const connectSchema = z.object({
  phoneNumberId: graphId('phoneNumberId'),
  wabaId: graphId('wabaId'),
  // Optional vendor token (their own Meta app). Write-only: stored encrypted,
  // never echoed back by any endpoint. Length-capped to bound what we encrypt.
  accessToken: z.string().trim().min(20).max(512).optional(),
});

// How each failure reaches the vendor. NOT_OWNED/GRAPH_DENIED are permanent —
// something must change on the Meta side; GRAPH_ERROR is transient, so the
// client may retry the same request unchanged.
const FAILURE_STATUS: Record<ConnectFailureReason, number> = {
  NOT_OWNED: 422,
  GRAPH_DENIED: 422,
  NUMBER_TAKEN: 409,
  GRAPH_ERROR: 502,
};

// POST /dashboard/whatsapp/connect — session-scoped (tenant from the session,
// never the body), owner-only. Verifies the phone number really belongs to the
// claimed WABA before anything is stored — see whatsappOnboarding for why that
// check is the security boundary.
export const connectWhatsappHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' });
    return;
  }

  try {
    const result = await connectTenantWhatsapp(parsed.data);
    if (!result.success) {
      // NUMBER_TAKEN deliberately does not reveal which tenant holds the number.
      res.status(FAILURE_STATUS[result.reason]).json({
        error: result.message,
        reason: result.reason,
      });
      return;
    }
    res.status(200).json({ status: WhatsappConnectionStatus.CONNECTED });
  } catch (err) {
    logger.error(`${TAG} connect failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Failed to connect WhatsApp. Please try again.' });
  }
};

// GET /dashboard/whatsapp/status — connection state for the wizard. Returns the
// ids and status only; whatsappCredentials is select:false and is never
// included here or on any other read.
export const whatsappStatusHandler = async (_req: Request, res: Response): Promise<void> => {
  const connection = await getTenantWhatsappConnection();
  if (!connection) {
    res.status(404).json({ error: 'Tenant not found.' });
    return;
  }
  res.status(200).json(connection);
};

// POST /dashboard/whatsapp/disconnect — owner-only. Marks the connection dead
// and revokes the stored credential; ids are kept so reconnecting is one click
// (see whatsappOnboarding.disconnectTenantWhatsapp for the full rationale).
export const disconnectWhatsappHandler = async (_req: Request, res: Response): Promise<void> => {
  await disconnectTenantWhatsapp();
  res.status(200).json({ status: WhatsappConnectionStatus.NOT_CONNECTED });
};
