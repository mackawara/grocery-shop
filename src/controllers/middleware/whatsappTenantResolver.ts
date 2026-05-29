import { Request, Response, NextFunction } from "express";
import type { Types } from "mongoose";
import Tenant from "../../models/Tenant";
import { TenantStatus } from "../../constants/models";
import {
  runWithTenant,
  runWithoutTenant,
} from "../../context/tenantContext";
import { logger } from "../../services/logger";
import type { WebhookNotificationBody } from "../../types/types";

export const whatsappTenantResolver = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const body = req.body as WebhookNotificationBody;
  const phoneNumberId =
    body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

  if (!phoneNumberId) {
    logger.warn(
      "[whatsappTenantResolver] no phone_number_id in webhook payload — acking 200",
    );
    res.status(200).json({ success: true });
    return;
  }

  let tenant;
  try {
    tenant = await runWithoutTenant(
      "whatsapp webhook tenant resolution",
      `Tenant.findOne({ whatsappPhoneNumberId: ${phoneNumberId} })`,
      () => Tenant.findOne({ whatsappPhoneNumberId: phoneNumberId }),
    );
  } catch (error) {
    logger.error(
      `[whatsappTenantResolver] tenant lookup failed for whatsappPhoneNumberId=${phoneNumberId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // Respond 500 so WhatsApp retries this transient failure rather than
    // silently dropping the message (unlike the permanent cases below).
    res.status(500).json({ success: false });
    return;
  }

  if (!tenant) {
    logger.warn(
      `[whatsappTenantResolver] no tenant for whatsappPhoneNumberId=${phoneNumberId} — acking 200`,
    );
    res.status(200).json({ success: true });
    return;
  }

  // Allowlist (fail closed): only these statuses get webhook access. TRIAL
  // tenants intentionally get full access. Any other/new status (INACTIVE,
  // SUSPENDED, or one added to the enum later) is rejected by default.
  const ALLOWED_STATUSES = [TenantStatus.ACTIVE, TenantStatus.TRIAL];
  if (!ALLOWED_STATUSES.includes(tenant.status)) {
    logger.warn(
      `[whatsappTenantResolver] tenant ${tenant._id} is ${tenant.status} — acking 200`,
    );
    res.status(200).json({ success: true });
    return;
  }

  runWithTenant(tenant._id as Types.ObjectId, () => next(), tenant.slug);
};
