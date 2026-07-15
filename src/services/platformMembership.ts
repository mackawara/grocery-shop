import { CONFIG } from '../config.ts';
import { PlatformRole, PlatformUserStatus } from '../constants/models.ts';
import PlatformUser from '../models/PlatformUser.ts';
import { resolveMembership } from './vendorMembership.ts';

// Break-glass bootstrap: a verified, allowlisted email is always an active super
// admin, independent of any DB row (so an empty PlatformUser collection can't
// lock everyone out). Built from env at module load.
export const ALLOWLISTED_ADMIN_EMAILS = new Set(CONFIG.PLATFORM_ADMIN_EMAILS);

// Allowlist requires email_verified so an unverified claim can't impersonate an
// allowlisted address.
export const isAllowlistedAdmin = (email: string | undefined, emailVerified: boolean): boolean =>
  emailVerified && Boolean(email) && ALLOWLISTED_ADMIN_EMAILS.has(email ?? '');

// Read-only "is this identity a platform admin?" for login-time session typing.
// Uses the same matching rule as the vendor seat (subject first, verified-email
// anchor fallback — resolveMembership) so the auth callback and
// platformAdminResolver agree on who matches. PlatformUser is deliberately not
// tenant-scoped, so no tenant context is involved. This check never authorizes
// anything by itself: platformAdminResolver re-verifies (and binds the subject)
// on every /admin request.
export const checkPlatformAdmin = async (
  sub: string,
  email: string | undefined,
  emailVerified: boolean,
): Promise<boolean> => {
  if (isAllowlistedAdmin(email, emailVerified)) {
    return true;
  }
  const row = await resolveMembership(sub, email, emailVerified, (filter) =>
    PlatformUser.findOne(filter).lean().exec(),
  );
  return (
    row !== null &&
    row.status === PlatformUserStatus.ACTIVE &&
    row.role === PlatformRole.SUPER_ADMIN
  );
};
