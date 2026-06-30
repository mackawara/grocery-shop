import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { isValidObjectId } from 'mongoose';
import Tenant from '../../models/Tenant.ts';
import type { ITenant } from '../../models/Tenant.ts';
import VendorUser from '../../models/VendorUser.ts';
import { TenantStatus, UserRole } from '../../constants/models.ts';
import { runWithTenant } from '../../context/tenantContext.ts';
import { authentik } from '../../services/authentik.ts';
import type { PlatformActor } from '../middleware/platformAdminResolver.ts';
import { logger } from '../../services/logger.ts';

// Platform-admin (super admin) actions. Gated by platformAdminResolver, which
// runs WITHOUT a tenant context — these handlers act across tenants. Tenant is
// not a tenant-scoped model, so its reads/writes need no tenant context.

const TAG = '[admin]';

// GET /admin/tenants/pending — list tenants awaiting approval, so the operator
// can find the id to approve/reject.
export const listPendingTenants = async (_req: Request, res: Response): Promise<void> => {
  const tenants = await Tenant.find({ status: TenantStatus.PENDING })
    .select('displayName slug email country createdAt')
    .sort({ createdAt: 1 })
    .lean();
  res.status(200).json({ tenants });
};

// GET /admin/me — the authenticated platform admin. Lets the console gate its
// route (200 = admin, 401/403 = not) without guessing from the vendor session.
export const getAdminMe = async (_req: Request, res: Response): Promise<void> => {
  res.status(200).json({ admin: res.locals.platformActor });
};

// GET /admin/tenants — every vendor with its status, for the admin overview.
export const listTenants = async (_req: Request, res: Response): Promise<void> => {
  const tenants = await Tenant.find()
    .select('displayName slug email country status plan createdAt')
    .sort({ createdAt: -1 })
    .lean();
  res.status(200).json({ tenants });
};

// Trigger the owner's Authentik recovery email so they can set a password and
// verify their email. The owner VendorUser is tenant-scoped, so the lookup runs
// inside the tenant context; its authUserPk (stamped at signup) is the admin-API
// handle. Throws on any failure so callers decide how to surface it.
const sendOwnerRecoveryEmail = async (tenant: ITenant): Promise<void> => {
  await runWithTenant(
    tenant._id as Types.ObjectId,
    async () => {
      const owner = await VendorUser.findOne({ role: UserRole.VENDOR });
      if (!owner) {
        throw new Error('owner VendorUser not found');
      }
      if (owner.authUserPk === undefined) {
        throw new Error('owner VendorUser has no authUserPk');
      }
      await authentik.sendRecoveryEmail(owner.authUserPk);
    },
    tenant.slug,
  );
};

// Flip a PENDING tenant to a terminal signup outcome. Only PENDING tenants are a
// valid source — approving/rejecting an already-active or already-decided tenant
// is a conflict, not an idempotent no-op (it would silently re-activate a
// suspended tenant, etc.).
const transitionPendingTenant = async (
  req: Request,
  res: Response,
  next: TenantStatus,
  verb: string,
): Promise<void> => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid tenant id.' });
    return;
  }

  const tenant = await Tenant.findById(id);
  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found.' });
    return;
  }
  if (tenant.status !== TenantStatus.PENDING) {
    res.status(409).json({ error: `Tenant is ${tenant.status}, not pending.` });
    return;
  }

  tenant.status = next;
  await tenant.save();

  const actor = res.locals.platformActor as PlatformActor | undefined;
  logger.info(
    `${TAG} ${verb} tenant ${tenant.slug} (${tenant._id}) by ${actor?.email ?? 'unknown'}`,
  );

  // On approval, send the owner their recovery email. The status flip already
  // committed, so an email failure is non-fatal: keep the approval, log it, and
  // flag it so the operator can re-send (POST .../resend-invite).
  let emailWarning: string | undefined;
  if (next === TenantStatus.TRIAL) {
    try {
      await sendOwnerRecoveryEmail(tenant);
    } catch (err) {
      emailWarning = 'Approved, but the recovery email could not be sent. Use resend-invite.';
      logger.error(
        `${TAG} recovery email failed for ${tenant.slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  res.status(200).json({
    status: tenant.status,
    tenant: { id: tenant._id, slug: tenant.slug },
    ...(emailWarning ? { warning: emailWarning } : {}),
  });
};

// POST /admin/tenants/:id/approve — PENDING -> TRIAL.
export const approveTenant = (req: Request, res: Response): Promise<void> =>
  transitionPendingTenant(req, res, TenantStatus.TRIAL, 'approved');

// POST /admin/tenants/:id/reject — PENDING -> REJECTED.
export const rejectTenant = (req: Request, res: Response): Promise<void> =>
  transitionPendingTenant(req, res, TenantStatus.REJECTED, 'rejected');

// POST /admin/tenants/:id/resend-invite — re-send the owner's recovery email for
// an already-approved tenant (approve is one-shot; it 409s once not PENDING). Use
// when the original send failed or the link expired before the owner used it.
export const resendInvite = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid tenant id.' });
    return;
  }

  const tenant = await Tenant.findById(id);
  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found.' });
    return;
  }
  // Only meaningful for approved (active) tenants — a PENDING/REJECTED owner
  // shouldn't be able to set a password yet.
  const ALLOWED = [TenantStatus.TRIAL, TenantStatus.ACTIVE];
  if (!ALLOWED.includes(tenant.status)) {
    res.status(409).json({ error: `Tenant is ${tenant.status}; approve it first.` });
    return;
  }

  try {
    await sendOwnerRecoveryEmail(tenant);
  } catch (err) {
    logger.error(
      `${TAG} resend-invite failed for ${tenant.slug}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    res.status(502).json({ error: 'Could not send the recovery email. Please try again.' });
    return;
  }

  const actor = res.locals.platformActor as PlatformActor | undefined;
  logger.info(`${TAG} resent invite for ${tenant.slug} by ${actor?.email ?? 'unknown'}`);
  res.status(200).json({ status: 'sent', tenant: { id: tenant._id, slug: tenant.slug } });
};
