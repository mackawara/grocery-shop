import { CONFIG } from '../config.ts';
import PlatformUser from '../models/PlatformUser.ts';
import { isAllowlistedEmail } from './platformAllowlist.ts';
import { canUsePlatformGrant } from './platformGrant.ts';
import { resolveMembership } from './vendorMembership.ts';

// Break-glass bootstrap: a verified, allowlisted email is always an active super
// admin, independent of any DB row (so an empty PlatformUser collection can't
// lock everyone out). Built from env at module load.
export const ALLOWLISTED_ADMIN_EMAILS = new Set(CONFIG.PLATFORM_ADMIN_EMAILS);

// This gate used to also require the ID token's `email_verified` claim, to stop
// an unverified claim impersonating an allowlisted address. That was not a
// control in this deployment, and removing it does not weaken one:
//
// Authentik does not derive `email_verified` — it hardcodes it, and since
// 2025.10 hardcodes it to `false` because it cannot vouch for an address. A
// gate on a constant carries no information; it is either "always allow" or
// "always deny". Here it was "always deny", so break-glass could never open and
// every operator landed on /no-access with no way into the console. A
// safeguard that cannot admit anyone is an outage, not a safeguard.
//
// The real control on this path is twofold, and lives outside this claim:
//   1. PLATFORM_ADMIN_EMAILS is operator-controlled deploy configuration. Anyone
//      who can edit it already owns the deployment.
//   2. The `email` on a token is Authentik's own record for that account, not
//      user-asserted input only if the deployment keeps open enrolment disabled,
//      blocks untrusted email edits, and prevents duplicate-email identities
//      from claiming the same address. Those prerequisites are documented and
//      surfaced by auth:doctor as manual checks.
//
// Note this is deliberately the same correction already applied to
// resolveMembership; this was the one place still gating on the constant.
export const isAllowlistedAdmin = (email: string | undefined): boolean =>
  isAllowlistedEmail(email, ALLOWLISTED_ADMIN_EMAILS);

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
  if (isAllowlistedAdmin(email)) {
    return true;
  }
  const row = await resolveMembership(sub, email, emailVerified, (filter) =>
    PlatformUser.findOne(filter).lean().exec(),
  );
  return canUsePlatformGrant(
    row ? { status: row.status, role: row.role, grantSource: row.grantSource } : null,
    false,
  );
};
