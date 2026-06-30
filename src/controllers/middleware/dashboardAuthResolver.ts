import type { Request, Response, NextFunction } from 'express';
import type { Types } from 'mongoose';
import Tenant from '../../models/Tenant.ts';
import VendorUser from '../../models/VendorUser.ts';
import type { IVendorUser } from '../../models/VendorUser.ts';
import { TenantStatus, VendorUserStatus } from '../../constants/models.ts';
import { runWithTenant, runWithoutTenant } from '../../context/tenantContext.ts';
import { logger } from '../../services/logger.ts';

const TAG = '[dashboardAuthResolver]';

// What downstream dashboard handlers read off res.locals.
export interface DashboardActor {
  vendorUserId: string;
  tenantId: string;
  email: string;
  role: string;
}

// Resolve (and on first login, bind) the VendorUser for this identity. Matches
// by authSubject; on first login the row was created INVITED with no subject, so
// we fall back to the email anchor and bind sub + activate. Returns null when the
// identity isn't provisioned for this tenant, is disabled, or the email row is
// already bound to a different subject. Runs inside runWithTenant (scoped).
const resolveVendorUser = async (
  sub: string,
  email: string | undefined,
): Promise<IVendorUser | null> => {
  let vendorUser = await VendorUser.findOne({ authSubject: sub });

  if (!vendorUser && email) {
    const byEmail = await VendorUser.findOne({ email });
    if (byEmail && byEmail.authSubject && byEmail.authSubject !== sub) {
      // Email belongs to a different identity — refuse rather than rebind.
      return null;
    }
    vendorUser = byEmail;
  }

  if (!vendorUser || vendorUser.status === VendorUserStatus.DISABLED) {
    return null;
  }

  if (!vendorUser.authSubject) {
    vendorUser.authSubject = sub;
  }
  if (vendorUser.status === VendorUserStatus.INVITED) {
    vendorUser.status = VendorUserStatus.ACTIVE;
  }
  vendorUser.lastLoginAt = new Date();
  await vendorUser.save();

  return vendorUser;
};

// Gate for all authenticated /dashboard routes. Reads the identity from the BFF
// session (established at login), resolves the tenant from the tenant_id claim
// (fail closed on status), binds the acting VendorUser, and runs the handler
// inside the tenant context.
export const dashboardAuthResolver = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // Identity is established at login and read from the session — no per-request
  // token verification.
  const auth = req.session.auth;
  if (!auth) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  const { sub, email } = auth;
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
      const vendorUser = await resolveVendorUser(sub, email);
      if (!vendorUser) {
        logger.warn(`${TAG} no active VendorUser for sub in tenant ${tenant._id}`);
        res.status(403).json({ error: 'You do not have access to this account.' });
        return;
      }
      const actor: DashboardActor = {
        vendorUserId: (vendorUser._id as Types.ObjectId).toString(),
        tenantId: (tenant._id as Types.ObjectId).toString(),
        email: vendorUser.email,
        role: vendorUser.role,
      };
      res.locals.actor = actor;
      next();
    },
    tenant.slug,
  );
};
