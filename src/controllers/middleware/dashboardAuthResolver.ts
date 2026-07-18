import type { Request, Response, NextFunction } from 'express';
import type { Types } from 'mongoose';
import Tenant from '../../models/Tenant.ts';
import VendorUser from '../../models/VendorUser.ts';
import type { IVendorUser } from '../../models/VendorUser.ts';
import { TenantStatus, UserRole, VendorUserStatus } from '../../constants/models.ts';
import { runWithTenant, runWithoutTenant } from '../../context/tenantContext.ts';
import { resolveMembership } from '../../services/vendorMembership.ts';
import { logger } from '../../services/logger.ts';

const TAG = '[dashboardAuthResolver]';

// What downstream dashboard handlers read off res.locals.
export interface DashboardActor {
  vendorUserId: string;
  tenantId: string;
  email: string;
  role: string;
}

// Outcome of resolving the acting VendorUser for a session identity:
//  - ok               — a usable, active seat (bound); grant dashboard access.
//  - needs_activation — an invited seat whose phone is not yet verified; the
//                       first-login WhatsApp OTP gate must run before access.
//  - denied           — no seat for this tenant, disabled, or email bound to a
//                       different subject.
export type VendorResolution =
  | { kind: 'ok'; vendorUser: IVendorUser }
  | { kind: 'needs_activation'; vendorUser: IVendorUser }
  | { kind: 'denied' };

// Resolve (and on first login, bind) the VendorUser for this identity. Applies
// the shared membership rule (see resolveMembership) — subject first, then the
// verified-email anchor on first login — with a tenant-scoped finder: we have
// already established the session's tenant, so a stale session pointing at the
// wrong tenant simply finds no row here and is denied (fails closed). Binds the
// subject and stamps lastLoginAt on every call. An INVITED seat activates only
// once its phone is verified; otherwise it is held in `needs_activation` for the
// OTP gate. Owners are verified by construction (they pass the signup OTP before
// their row exists), so they never stall here even if the flag predates this
// field. Runs inside runWithTenant (scoped).
export const resolveVendorUser = async (
  sub: string,
  email: string | undefined,
  emailVerified: boolean,
): Promise<VendorResolution> => {
  const vendorUser = await resolveMembership(sub, email, emailVerified, (filter) =>
    VendorUser.findOne(filter).exec(),
  );

  if (!vendorUser || vendorUser.status === VendorUserStatus.DISABLED) {
    return { kind: 'denied' };
  }

  if (!vendorUser.authSubject) {
    vendorUser.authSubject = sub;
  }
  vendorUser.lastLoginAt = new Date();

  const phoneVerified = vendorUser.phoneVerified || vendorUser.role === UserRole.VENDOR;
  if (vendorUser.status === VendorUserStatus.INVITED && !phoneVerified) {
    await vendorUser.save();
    return { kind: 'needs_activation', vendorUser };
  }
  if (vendorUser.status === VendorUserStatus.INVITED) {
    vendorUser.status = VendorUserStatus.ACTIVE;
  }
  await vendorUser.save();

  return { kind: 'ok', vendorUser };
};

// Shared scaffolding for the authenticated dashboard middlewares. Reads the BFF
// session identity, resolves the tenant from the tenant_id claim (fail closed on
// status), then runs `handle` with the VendorResolution inside the tenant
// context. Each caller decides how to treat each resolution kind — the standard
// gate denies `needs_activation`, the activation gate is the one place that
// admits it. Returns after `handle` has written the response (or called next()).
export const withVendorSession = async (
  req: Request,
  res: Response,
  handle: (resolution: VendorResolution, tenant: InstanceType<typeof Tenant>) => void,
): Promise<void> => {
  const auth = req.session.auth;
  if (!auth) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  const { sub, email, emailVerified } = auth;
  const tenantClaim = auth.tenantId;

  if (!tenantClaim) {
    logger.warn(`${TAG} session is not scoped to a tenant`);
    res.status(403).json({ error: 'Not scoped to a tenant.' });
    return;
  }

  let tenant;
  try {
    tenant = await runWithoutTenant(
      'dashboard auth tenant resolution',
      `Tenant.findById(${tenantClaim})`,
      () => Tenant.findById(tenantClaim),
    );
  } catch (err) {
    logger.error(`${TAG} tenant lookup failed: ${err instanceof Error ? err.message : err}`);
    res.status(500).json({ error: 'Authentication failed.' });
    return;
  }

  if (!tenant) {
    res.status(403).json({ error: 'Tenant not found.' });
    return;
  }

  // Fail closed: only ACTIVE/TRIAL tenants get dashboard access (PENDING awaits
  // approval; REJECTED/SUSPENDED/INACTIVE are denied). Mirrors the WhatsApp resolver.
  const ALLOWED_STATUSES = [TenantStatus.ACTIVE, TenantStatus.TRIAL];
  if (!ALLOWED_STATUSES.includes(tenant.status)) {
    logger.warn(`${TAG} tenant ${tenant._id} is ${tenant.status} — denying`);
    res.status(403).json({ error: 'This account is not active.' });
    return;
  }

  await runWithTenant(
    tenant._id as Types.ObjectId,
    async () => {
      const resolution = await resolveVendorUser(sub, email, emailVerified);
      handle(resolution, tenant);
    },
    tenant.slug,
  );
};

// Gate for all authenticated /dashboard routes. An active seat proceeds; an
// invited-but-unverified seat is bounced to the activation gate (distinct
// `activation_required` code so the SPA can route there); anything else is denied.
export const dashboardAuthResolver = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  await withVendorSession(req, res, (resolution, tenant) => {
    if (resolution.kind === 'denied') {
      logger.warn(`${TAG} no active VendorUser for sub in tenant ${tenant._id}`);
      res.status(403).json({ error: 'You do not have access to this account.' });
      return;
    }
    if (resolution.kind === 'needs_activation') {
      res.status(403).json({ error: 'Verify your phone to activate your account.', code: 'activation_required' });
      return;
    }
    const { vendorUser } = resolution;
    const actor: DashboardActor = {
      vendorUserId: (vendorUser._id as Types.ObjectId).toString(),
      tenantId: (tenant._id as Types.ObjectId).toString(),
      email: vendorUser.email,
      role: vendorUser.role,
    };
    res.locals.actor = actor;
    next();
  });
};
