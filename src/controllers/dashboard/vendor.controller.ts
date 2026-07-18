import type { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import type { Types } from 'mongoose';
import { z } from 'zod';
import Tenant from '../../models/Tenant.ts';
import VendorUser from '../../models/VendorUser.ts';
import { TenantStatus, UserRole, VendorUserStatus } from '../../constants/models.ts';
import { runWithoutTenant } from '../../context/tenantContext.ts';
import { authentik, isAuthentikApiError } from '../../services/authentik.ts';
import {
  generateSignupOtp,
  verifySignupOtp,
  OtpVerifyResult,
  claimPhoneForSignup,
  releasePhoneClaim,
} from '../../services/signupOtp.ts';
import whatsappMessager from '../whatsapp/outgoingMessages.ts';
import type { DashboardActor } from '../middleware/dashboardAuthResolver.ts';
import type { ActivationTarget } from '../middleware/activationResolver.ts';
import { redisClient } from '../../services/redis.ts';
import { globalKey } from '../../utils/tenantKey.ts';
import { normalizePhone, isValidPhone } from '../../utils/phone.ts';
import { SIGNUP_OTP_TTL_SECONDS } from '../../constants/auth.ts';
import { CONFIG } from '../../config.ts';
import { logger } from '../../services/logger.ts';

// Vendor (merchant-side) controller. Houses the vendor account lifecycle:
// signup (start/verify) today, approval and others to follow.

const TAG = '[vendor]';

// Business/account fields captured at /start and stashed in Redis so /verify
// (which only carries phone + code) can provision without trusting the client to
// resend — and without letting fields be tampered between the two calls.
interface PendingSignup {
  displayName: string;
  email: string;
  country: string;
  ownerName: string;
}

const pendingKey = (phone: string): string => globalKey(`signup-pending:${phone}`);

// Generic message returned by /start regardless of whether the phone was
// actually eligible — never reveal that a number is already registered.
const START_OK = {
  status: 'otp_sent',
  message: 'If this number can sign up, a verification code has been sent on WhatsApp.',
};

// --- Validation schemas (zod) ---------------------------------------------

// Normalize to digits then validate; output replaces the raw input value.
const phoneSchema = z
  .string()
  .transform(normalizePhone)
  .refine(isValidPhone, 'A valid phone number is required.');

const startSchema = z.object({
  displayName: z.string().trim().min(2, 'displayName must be 2–100 characters.').max(100),
  email: z.string().trim().toLowerCase().pipe(z.email('A valid email is required.')),
  country: z.string().trim().min(1, 'country is required.'),
  ownerName: z.string().trim().optional().default(''),
  phoneNumber: phoneSchema,
});

const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'A 6-digit code is required.'),
});

const verifySchema = codeSchema.extend({
  phoneNumber: phoneSchema,
});

const firstIssue = (error: z.ZodError): string =>
  error.issues[0]?.message ?? 'Invalid request body.';

// Send a 6-digit code over the WhatsApp `auth_otp` authentication template. The
// code fills both the body and the URL/copy button. Shared by signup and the
// staff first-login activation gate; the caller owns the tenant context (signup
// runs pre-tenant under a bypass, activation runs inside the tenant).
const sendAuthOtp = (to: string, code: string) =>
  whatsappMessager.sendTemplate({
    to,
    name: 'auth_otp',
    languageCode: CONFIG.WHATSAPP_VENDOR_AUTH_TEMPLATE_LANG,
    components: [
      { type: 'body', parameters: [{ type: 'text', text: code }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
    ],
  });

// --- Signup: start ---------------------------------------------------------

// POST /dashboard/signup/start — validate, confirm the phone is free, claim it,
// send the OTP, and stash the registration details for /verify. Always responds
// with the same generic success to avoid phone enumeration.
export const signupStart = async (req: Request, res: Response): Promise<void> => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { displayName, email, country, phoneNumber: phone } = parsed.data;
  const ownerName = parsed.data.ownerName || displayName;

  // Global phone uniqueness: bypass scopes the query across all tenants. Call
  // .exec() so the query actually runs *inside* the bypass context — a lazy
  // (unexecuted) query would run after storage.run() exits and lose the bypass.
  const existing = await runWithoutTenant(
    'vendor-signup phone uniqueness check',
    'VendorUser.findOne({ phoneNumber })',
    () => VendorUser.findOne({ phoneNumber: phone }).lean().exec(),
  );
  if (existing) {
    logger.info(`${TAG} start for already-registered phone — generic ack`);
    res.status(200).json(START_OK);
    return;
  }

  // Serialize concurrent signups for the same number. If we can't claim it,
  // a code was just sent by the in-flight request — same generic ack.
  const claimed = await claimPhoneForSignup(phone);
  if (!claimed) {
    res.status(200).json(START_OK);
    return;
  }

  try {
    const code = await generateSignupOtp(phone);

    // Signup happens before any Tenant exists, so the outbound-OTP audit write
    // (saveWhatsappMessage → WhatsappMessage.create, nested inside sendTemplate)
    // has no tenant to scope to. Run the whole send under an explicit bypass so
    // the tenantScope plugin skips injection instead of throwing
    // TenantContextMissingError; the record persists with no tenantId.
    const sent = await runWithoutTenant(
      'vendor-signup OTP send (pre-tenant: no Tenant exists yet)',
      'WhatsappMessage.create (outbound signup-OTP audit)',
      () => sendAuthOtp(phone, code),
    );
    if (CONFIG.IS_LOCAL_ENVIRONMENT) {
      logger.info(`${TAG} OTP for ${phone} is ${code}`);
      const pending: PendingSignup = { displayName, email, country, ownerName };
      await redisClient.set(pendingKey(phone), JSON.stringify(pending), {
        EX: SIGNUP_OTP_TTL_SECONDS,
      });

      res.status(200).json(START_OK);
      return;
    }
    if (!sent.success) {
      await releasePhoneClaim(phone);
      logger.error(`${TAG} OTP send failed: ${sent.error}`);
      res.status(502).json({ error: 'Could not send the verification code. Please try again.' });
      return;
    }

    const pending: PendingSignup = { displayName, email, country, ownerName };
    await redisClient.set(pendingKey(phone), JSON.stringify(pending), {
      EX: SIGNUP_OTP_TTL_SECONDS,
    });

    res.status(200).json(START_OK);
  } catch (err) {
    await releasePhoneClaim(phone);
    logger.error(`${TAG} start failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Signup could not be started. Please try again.' });
  }
};

// --- Signup: verify + provision -------------------------------------------

type DuplicateKeyError = { code: number; keyPattern?: Record<string, unknown> };

const isDuplicateKeyError = (err: unknown): err is DuplicateKeyError =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

// Thrown when a tenant-unique field (business name / email) collides — maps to 409.
class SignupConflictError extends Error {
  constructor(public readonly field: string) {
    super(`${field} already in use`);
    this.name = 'SignupConflictError';
  }
}

const MAX_SLUG_RETRIES = 3;

// Create the PENDING tenant, retrying on a slug collision (the pre-validate hook
// re-derives the next free suffix on each save — see Tenant.ts). Duplicate
// business name / email surface as a SignupConflictError.
const createPendingTenant = async (data: PendingSignup) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const tenant = new Tenant({
        status: TenantStatus.PENDING,
        displayName: data.displayName,
        email: data.email,
        country: data.country,
      });
      await tenant.save();
      return tenant;
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const field = Object.keys(err.keyPattern ?? {})[0] ?? 'unknown';
        if (field === 'slug' && attempt < MAX_SLUG_RETRIES) {
          continue;
        }
        throw new SignupConflictError(field === 'displayName' ? 'business name' : field);
      }
      throw err;
    }
  }
};

// POST /dashboard/signup/verify — check the OTP, then provision tenant +
// Authentik identity + owner VendorUser under a single bypass, rolling back any
// partial work on failure. Responds "pending approval" on success.
export const signupVerify = async (req: Request, res: Response): Promise<void> => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { phoneNumber: phone, code } = parsed.data;

  const result = await verifySignupOtp(phone, code);
  if (result === OtpVerifyResult.INVALID) {
    // Keep the pending data + claim so the user can retry the code.
    res.status(400).json({ error: 'Invalid verification code.' });
    return;
  }
  if (result !== OtpVerifyResult.OK) {
    // Expired or attempts exhausted — force a clean restart from /start.
    await cleanupSignupState(phone);
    res
      .status(result === OtpVerifyResult.TOO_MANY_ATTEMPTS ? 429 : 400)
      .json({ error: 'Verification code expired. Please start again.' });
    return;
  }

  const raw = await redisClient.get(pendingKey(phone));
  if (!raw) {
    await cleanupSignupState(phone);
    res.status(400).json({ error: 'Signup session expired. Please start again.' });
    return;
  }
  const pending = JSON.parse(raw) as PendingSignup;

  try {
    await runWithoutTenant(
      'vendor-signup provisioning',
      'create Tenant + Authentik group/user + owner VendorUser',
      async () => {
        // Defensive re-check inside the critical section.
        const dup = await VendorUser.findOne({ phoneNumber: phone }).lean();
        if (dup) {
          throw new SignupConflictError('phone number');
        }

        let tenantId: Types.ObjectId | undefined;
        let groupPk: string | undefined;
        let userPk: number | undefined;
        try {
          const tenant = await createPendingTenant(pending);
          tenantId = tenant._id as Types.ObjectId;

          const group = await authentik.createGroup(`tenant:${tenant.slug}`, {
            tenant_id: tenantId.toString(),
          });
          groupPk = group.pk;
          // Persist the group pk so staff invitations can target it later.
          tenant.authGroupPk = group.pk;
          await tenant.save();

          const user = await authentik.createUser({
            username: pending.email,
            email: pending.email,
            name: pending.ownerName,
            groups: [group.pk],
            attributes: { phone },
          });
          userPk = user.pk;

          // Owner VendorUser. This whole block is the tenant's bootstrap, so it
          // stays under the signup bypass rather than switching into the new
          // tenant's context; tenantScope doesn't stamp under runWithoutTenant,
          // so set tenantId explicitly (to the tenant we just created).
          await VendorUser.create({
            tenantId: tenant._id as Types.ObjectId,
            phoneNumber: phone,
            email: pending.email,
            name: pending.ownerName,
            role: UserRole.VENDOR,
            status: VendorUserStatus.INVITED,
            // The owner already proved phone control via the signup OTP above, so
            // they skip the first-login activation gate (unlike invited staff).
            phoneVerified: true,
            // Admin-API handle so tenant approval can trigger the recovery email.
            authUserPk: user.pk,
          });
        } catch (err) {
          // Best-effort compensating cleanup, reverse order. Each catch keeps a
          // cleanup failure from masking the original error.
          if (userPk !== undefined) {
            await authentik.deleteUser(userPk).catch((e) => logCleanup('user', e));
          }
          if (groupPk) {
            await authentik.deleteGroup(groupPk).catch((e) => logCleanup('group', e));
          }
          if (tenantId) {
            await Tenant.deleteOne({ _id: tenantId }).catch((e) => logCleanup('tenant', e));
          }
          throw err;
        }
      },
    );

    await cleanupSignupState(phone);
    res.status(201).json({
      status: 'pending_approval',
      message: 'Your account has been created and is pending approval.',
    });
  } catch (err) {
    await cleanupSignupState(phone);
    if (err instanceof SignupConflictError) {
      res.status(409).json({ error: `That ${err.field} is already registered.` });
      return;
    }
    if (isAuthentikApiError(err) && err.status === 409) {
      res.status(409).json({ error: 'That email is already registered.' });
      return;
    }
    logger.error(`${TAG} provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not complete signup. Please try again.' });
  }
};

// --- Current vendor --------------------------------------------------------

// GET /dashboard/me — returns the authenticated vendor + tenant. Runs behind
// dashboardAuthResolver, which has already established the tenant context and
// populated res.locals.actor.
export const getMe = async (_req: Request, res: Response): Promise<void> => {
  res.status(200).json({ actor: res.locals.actor });
};

// --- Staff invitations -----------------------------------------------------

// Which roles an actor may assign to / act on for a teammate, keyed by the
// actor's own role. An owner (VENDOR) manages both staff tiers; a shop manager
// manages only sales reps — never another manager, never the owner. This is the
// single authority for invite, revoke, remove and resend: an actor may only
// touch a teammate whose role is in their manageable set, so no action can
// escalate privilege or let a manager remove a peer/owner.
const MANAGEABLE_BY: Partial<Record<UserRole, readonly UserRole[]>> = {
  [UserRole.VENDOR]: [UserRole.SHOP_MANAGER, UserRole.SALES_REP, UserRole.DRIVER],
  [UserRole.SHOP_MANAGER]: [UserRole.SALES_REP, UserRole.DRIVER],
};

// Every role an actor could conceivably grant — used only for input validation;
// the per-actor narrowing (MANAGEABLE_BY) is enforced in the handler.
const INVITABLE_ROLES = [UserRole.SHOP_MANAGER, UserRole.SALES_REP, UserRole.DRIVER] as const;

const canManageRole = (actorRole: string, targetRole: UserRole): boolean =>
  (MANAGEABLE_BY[actorRole as UserRole] ?? []).includes(targetRole);

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('A valid email is required.')),
  phoneNumber: phoneSchema,
  name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(INVITABLE_ROLES, { message: 'role must be shop_manager, sales_rep or driver.' }),
});

// POST /dashboard/invitations — invite a teammate into the caller's tenant.
// Runs behind dashboardAuthResolver (tenant context + actor established). The
// invitee is provisioned straight into the tenant's Authentik group as an INVITED
// VendorUser; they become ACTIVE automatically on first login (the resolver binds
// their authSubject by email). Acceptance needs no separate endpoint.
export const inviteVendorUser = async (req: Request, res: Response): Promise<void> => {
  const actor = res.locals.actor as DashboardActor | undefined;
  if (!actor || !MANAGEABLE_BY[actor.role as UserRole]) {
    res.status(403).json({ error: 'You cannot invite team members.' });
    return;
  }

  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { email, phoneNumber: phone, name, role } = parsed.data;

  // Privilege gate: a manager may only invite sales reps, never another manager.
  if (!canManageRole(actor.role, role)) {
    res.status(403).json({ error: `You cannot invite a ${role.replace('_', ' ')}.` });
    return;
  }

  let tenant;
  try {
    // Email already on this tenant's team (scoped query)?
    const existingEmail = await VendorUser.findOne({ email }).lean();
    if (existingEmail) {
      res.status(409).json({ error: 'That email is already on your team.' });
      return;
    }
    // Global phone uniqueness (v1: one phone -> one tenant) — cross-tenant lookup.
    // .exec() runs the query inside the bypass context (see signupStart note).
    const phoneTaken = await runWithoutTenant(
      'staff-invite phone uniqueness check',
      'VendorUser.findOne({ phoneNumber })',
      () => VendorUser.findOne({ phoneNumber: phone }).lean().exec(),
    );
    if (phoneTaken) {
      res.status(409).json({ error: 'That phone number is already registered.' });
      return;
    }
    tenant = await Tenant.findById(actor.tenantId);
  } catch (err) {
    logger.error(
      `${TAG} invite pre-checks failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({ error: 'Could not send the invitation. Please try again.' });
    return;
  }

  if (!tenant?.authGroupPk) {
    logger.error(`${TAG} tenant ${actor.tenantId} has no authGroupPk — cannot invite`);
    res.status(500).json({ error: 'Cannot send invitations right now.' });
    return;
  }
  // No invites for an unapproved/suspended tenant. dashboardAuthResolver already
  // denies all /dashboard access unless the tenant is ACTIVE/TRIAL, so this is
  // belt-and-suspenders — but it states the rule explicitly at the invite site.
  if (![TenantStatus.ACTIVE, TenantStatus.TRIAL].includes(tenant.status)) {
    res.status(403).json({ error: 'Your account is not active yet.' });
    return;
  }

  let userPk: number | undefined;
  try {
    const user = await authentik.createUser({
      username: email,
      email,
      name: name ?? email,
      groups: [tenant.authGroupPk],
      attributes: { phone },
    });
    userPk = user.pk;
    await VendorUser.create({
      phoneNumber: phone,
      email,
      name,
      role,
      status: VendorUserStatus.INVITED,
      authUserPk: user.pk,
    });
  } catch (err) {
    if (userPk !== undefined) {
      await authentik.deleteUser(userPk).catch((e) => logCleanup('user', e));
    }
    if (isAuthentikApiError(err) && err.status === 409) {
      res.status(409).json({ error: 'That email is already registered.' });
      return;
    }
    if (isDuplicateKeyError(err)) {
      logger.warn(`${TAG} duplicate key on invite: ${err instanceof Error ? err.message : String(err)}`);
      res.status(409).json({ error: 'That teammate is already registered.' });
      return;
    }
    logger.error(`${TAG} invite failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not send the invitation. Please try again.' });
    return;
  }

  // Recovery email lets them set a password; non-fatal since phone-OTP is the
  // first-line login. Surface a warning so the UI can offer a resend later.
  let warning: string | undefined;
  try {
    await authentik.sendRecoveryEmail(userPk);
  } catch (err) {
    warning = 'Invited, but the setup email could not be sent.';
    logger.error(`${TAG} invite email failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  logger.info(`${TAG} invited ${role} to tenant ${actor.tenantId} by ${actor.email}`);
  res.status(201).json({ status: 'invited', email, role, ...(warning ? { warning } : {}) });
};

// Shared preamble for the per-teammate lifecycle actions (revoke/remove/resend):
// validate the id, authorise the actor against the target's role, and load the
// target (tenant-scoped, so a member of another tenant is simply not found).
// Returns the loaded VendorUser, or null after already writing the HTTP error.
const loadManageableTarget = async (
  req: Request,
  res: Response,
): Promise<InstanceType<typeof VendorUser> | null> => {
  const actor = res.locals.actor as DashboardActor | undefined;
  if (!actor || !MANAGEABLE_BY[actor.role as UserRole]) {
    res.status(403).json({ error: 'You cannot manage team members.' });
    return null;
  }

  const { id } = req.params;
  if (!isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid team member id.' });
    return null;
  }
  if (id === actor.vendorUserId) {
    res.status(400).json({ error: 'You cannot perform this action on yourself.' });
    return null;
  }

  let target;
  try {
    target = await VendorUser.findById(id);
  } catch (err) {
    logger.error(
      `${TAG} target lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
    return null;
  }
  if (!target) {
    res.status(404).json({ error: 'Team member not found.' });
    return null;
  }
  // Privilege gate: only roles the actor manages (a manager can touch sales reps
  // only; the owner is never in anyone's manageable set, so is untouchable here).
  if (!canManageRole(actor.role, target.role)) {
    res.status(403).json({ error: 'You cannot manage this team member.' });
    return null;
  }
  return target;
};

// DELETE /dashboard/invitations/:id — revoke a still-pending invite. Only valid
// while the invitee has never logged in (status INVITED, no bound authSubject):
// hard-delete the Authentik identity and the VendorUser row so the email/phone
// are freed for a fresh invite. To remove someone who has already joined, use
// DELETE /dashboard/team/:id (disable) instead.
export const revokeInvitation = async (req: Request, res: Response): Promise<void> => {
  const target = await loadManageableTarget(req, res);
  if (!target) {
    return;
  }
  if (target.status !== VendorUserStatus.INVITED || target.authSubject) {
    res.status(409).json({ error: 'That teammate has already joined — remove them instead.' });
    return;
  }

  try {
    // Authentik cleanup is best-effort (own .catch); the VendorUser delete is the
    // authoritative step, so a throw there surfaces as a 500.
    if (target.authUserPk !== undefined) {
      await authentik.deleteUser(target.authUserPk).catch((e) => logCleanup('user (revoke)', e));
    }
    await target.deleteOne();
  } catch (err) {
    logger.error(`${TAG} revoke failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not revoke the invitation. Please try again.' });
    return;
  }

  logger.info(`${TAG} revoked pending invite ${target._id} in tenant ${target.tenantId}`);
  res.status(200).json({ status: 'revoked' });
};

// DELETE /dashboard/team/:id — remove an active teammate. Reversible: sets the
// VendorUser DISABLED (dashboardAuthResolver denies DISABLED) and disables the
// Authentik identity, preserving the row for history/attribution. Use revoke for
// a still-pending invite (that path deletes outright).
export const removeStaff = async (req: Request, res: Response): Promise<void> => {
  const target = await loadManageableTarget(req, res);
  if (!target) {
    return;
  }
  if (target.status === VendorUserStatus.DISABLED) {
    res.status(409).json({ error: 'That teammate is already removed.' });
    return;
  }

  try {
    // The DISABLED write is authoritative (it's what dashboardAuthResolver gates
    // on); the Authentik disable is best-effort (own .catch). Order matters: lock
    // our side first so a failed Authentik call can't leave them locked-out here
    // but enabled at the IdP without us knowing — a throw surfaces as a 500.
    target.status = VendorUserStatus.DISABLED;
    await target.save();
    if (target.authUserPk !== undefined) {
      await authentik
        .setUserActive(target.authUserPk, false)
        .catch((e) => logCleanup('user (disable)', e));
    }
  } catch (err) {
    logger.error(`${TAG} remove failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not remove the team member. Please try again.' });
    return;
  }

  logger.info(`${TAG} removed teammate ${target._id} in tenant ${target.tenantId}`);
  res.status(200).json({ status: 'removed' });
};

// POST /dashboard/invitations/:id/resend — re-send the account-setup email to a
// teammate who has not yet joined (status INVITED). No-op for anyone who has
// already logged in.
export const resendInvitation = async (req: Request, res: Response): Promise<void> => {
  const target = await loadManageableTarget(req, res);
  if (!target) {
    return;
  }
  if (target.status !== VendorUserStatus.INVITED || target.authUserPk === undefined) {
    res.status(409).json({ error: 'That teammate has already joined.' });
    return;
  }

  try {
    await authentik.sendRecoveryEmail(target.authUserPk);
  } catch (err) {
    logger.error(`${TAG} resend failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(502).json({ error: 'Could not resend the invitation. Please try again.' });
    return;
  }

  logger.info(`${TAG} resent invite ${target._id} in tenant ${target.tenantId}`);
  res.status(200).json({ status: 'resent' });
};

// --- First-login activation (invited staff) --------------------------------

// POST /dashboard/activate/start — send the activation OTP to an invited staff
// member's own phone. Runs behind activationResolver, which admits only an
// invited-but-unverified seat and puts its server-side phone in res.locals — the
// client never supplies the number, so the code can't be redirected. Already
// inside the tenant context, so the outbound-OTP audit scopes normally (no bypass).
export const activationStart = async (_req: Request, res: Response): Promise<void> => {
  const target = res.locals.activation as ActivationTarget | undefined;
  if (!target) {
    res.status(500).json({ error: 'Activation is unavailable.' });
    return;
  }

  try {
    const code = await generateSignupOtp(target.phoneNumber);
    if (CONFIG.IS_LOCAL_ENVIRONMENT) {
      logger.info(`${TAG} activation OTP for ${target.vendorUserId} is ${code}`);
      res.status(200).json({ status: 'otp_sent' });
      return;
    }
    const sent = await sendAuthOtp(target.phoneNumber, code);
    if (!sent.success) {
      logger.error(`${TAG} activation OTP send failed: ${sent.error}`);
      res.status(502).json({ error: 'Could not send the verification code. Please try again.' });
      return;
    }
    res.status(200).json({ status: 'otp_sent' });
  } catch (err) {
    logger.error(
      `${TAG} activation start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({ error: 'Could not start activation. Please try again.' });
  }
};

// POST /dashboard/activate/verify — check the activation OTP and, on success,
// mark the phone verified and flip the seat ACTIVE. Runs behind activationResolver.
export const activationVerify = async (req: Request, res: Response): Promise<void> => {
  const target = res.locals.activation as ActivationTarget | undefined;
  if (!target) {
    res.status(500).json({ error: 'Activation is unavailable.' });
    return;
  }

  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }

  let result;
  try {
    result = await verifySignupOtp(target.phoneNumber, parsed.data.code);
  } catch (err) {
    logger.error(
      `${TAG} activation verify (otp) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({ error: 'Could not verify the code. Please try again.' });
    return;
  }
  if (result === OtpVerifyResult.INVALID) {
    res.status(400).json({ error: 'Invalid verification code.' });
    return;
  }
  if (result !== OtpVerifyResult.OK) {
    res
      .status(result === OtpVerifyResult.TOO_MANY_ATTEMPTS ? 429 : 400)
      .json({ error: 'Verification code expired. Please request a new one.' });
    return;
  }

  try {
    // Scoped load (we are inside the tenant context established by activationResolver).
    const vendorUser = await VendorUser.findById(target.vendorUserId);
    if (!vendorUser) {
      res.status(404).json({ error: 'Team member not found.' });
      return;
    }
    vendorUser.phoneVerified = true;
    vendorUser.status = VendorUserStatus.ACTIVE;
    await vendorUser.save();
    logger.info(`${TAG} activated seat ${vendorUser._id} in tenant ${vendorUser.tenantId}`);
  } catch (err) {
    // The code was already consumed, but activation didn't persist. The seat stays
    // in needs_activation; the user can re-run /activate/start for a fresh code.
    logger.error(
      `${TAG} activation persist failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({ error: 'Could not activate your account. Please try again.' });
    return;
  }

  res.status(200).json({ status: 'active' });
};

// GET /dashboard/team — list the caller's tenant members (scoped query).
export const listTeam = async (_req: Request, res: Response): Promise<void> => {
  try {
    const members = await VendorUser.find()
      .select('email phoneNumber name role status lastLoginAt createdAt')
      .sort({ createdAt: 1 })
      .lean();
    res.status(200).json({ members });
  } catch (err) {
    logger.error(`${TAG} list team failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not load the team. Please try again.' });
  }
};

// --- internal helpers ------------------------------------------------------

const cleanupSignupState = async (phone: string): Promise<void> => {
  await redisClient.del(pendingKey(phone)).catch(() => undefined);
  await releasePhoneClaim(phone).catch(() => undefined);
};

const logCleanup = (resource: string, err: unknown): void => {
  logger.error(
    `${TAG} rollback: failed to delete ${resource}: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
};
