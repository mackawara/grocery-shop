import type { Request, Response, NextFunction } from 'express';
import type { Types } from 'mongoose';
import PlatformUser from '../../models/PlatformUser.ts';
import type { IPlatformUser } from '../../models/PlatformUser.ts';
import { PlatformRole, PlatformUserStatus } from '../../constants/models.ts';
import { isAllowlistedAdmin } from '../../services/platformMembership.ts';
import { resolveMembership } from '../../services/vendorMembership.ts';
import { logger } from '../../services/logger.ts';

const TAG = '[platformAdminResolver]';

// What downstream admin handlers read off res.locals.
export interface PlatformActor {
  platformUserId: string;
  email: string;
  role: string;
}

// Resolve (and on first login, bind) the PlatformUser. Matching is delegated to
// resolveMembership — the same rule the auth callback uses for session typing —
// so the two can never disagree: authSubject first, verified-email anchor
// fallback, refuse a row already bound to a different subject. Returns null
// when the identity isn't a platform user or is disabled. PlatformUser is not
// tenant-scoped, so these run without any tenant context.
const resolvePlatformUser = async (
  sub: string,
  email: string | undefined,
  emailVerified: boolean,
): Promise<IPlatformUser | null> => {
  const admin = await resolveMembership(sub, email, emailVerified, (filter) =>
    PlatformUser.findOne(filter).exec(),
  );

  if (!admin || admin.status === PlatformUserStatus.DISABLED) {
    return null;
  }

  if (!admin.authSubject) {
    admin.authSubject = sub;
  }
  admin.lastLoginAt = new Date();
  await admin.save();

  return admin;
};

// Upsert the PlatformUser for an allowlisted email: bind sub, force active super
// admin (self-heals a missing or disabled row), keep audit fields current. The
// env allowlist is authoritative here, so this never denies — to revoke an
// allowlisted admin, remove them from PLATFORM_ADMIN_EMAILS.
const ensureAllowlistedAdmin = async (
  sub: string,
  email: string,
): Promise<IPlatformUser | null> =>
  PlatformUser.findOneAndUpdate(
    { email },
    {
      $set: {
        authSubject: sub,
        role: PlatformRole.SUPER_ADMIN,
        status: PlatformUserStatus.ACTIVE,
        lastLoginAt: new Date(),
      },
      $setOnInsert: { email },
    },
    { upsert: true, new: true },
  );

// Gate for all platform-admin routes. Reads the identity from the BFF session,
// then requires it to be an active super admin. Unlike dashboardAuthResolver it
// establishes NO tenant context — admin handlers act across tenants and must
// scope any tenant-owned access explicitly.
export const platformAdminResolver = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // Identity established at login and read from the session.
  const auth = req.session.auth;
  if (!auth) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const { sub, email, emailVerified } = auth;

  // A verified, allowlisted email is authoritative; otherwise fall back to a
  // DB-managed PlatformUser. Allowlist requires email_verified so an unverified
  // claim can't impersonate an allowlisted address.
  const allowlisted = isAllowlistedAdmin(email, emailVerified);

  let admin: IPlatformUser | null;
  try {
    admin =
      allowlisted && email
        ? await ensureAllowlistedAdmin(sub, email)
        : await resolvePlatformUser(sub, email, emailVerified);
  } catch (err) {
    logger.error(`${TAG} platform user lookup failed: ${err instanceof Error ? err.message : err}`);
    res.status(500).json({ error: 'Authentication failed.' });
    return;
  }

  if (!admin || admin.role !== PlatformRole.SUPER_ADMIN) {
    logger.warn(`${TAG} denied — not an active super admin`);
    res.status(403).json({ error: 'Platform admin access required.' });
    return;
  }

  const actor: PlatformActor = {
    platformUserId: (admin._id as Types.ObjectId).toString(),
    email: admin.email,
    role: admin.role,
  };
  res.locals.platformActor = actor;
  next();
};
