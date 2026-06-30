/**
 * Provision a platform super admin — the cross-tenant operator who approves/
 * rejects pending vendors. There is deliberately NO public admin signup; this is
 * the controlled onboarding path. It does the whole job in one command:
 *   1. Authentik identity  — find or create the user (so they can log in via OIDC)
 *   2. Setup email         — send a recovery email so a new admin can set a password
 *   3. Authorization row   — upsert the PlatformUser (active super admin)
 * The Authentik `sub` binds automatically on first login (platformAdminResolver).
 *
 * Unlike seed:local this is NOT dev-gated: run it against whatever Mongo cluster
 * CONFIG points at, including production. Requires the Authentik admin token
 * (AUTHENTIK_BASE_URL/AUTHENTIK_ADMIN_TOKEN) and, for the email, an email stage.
 *
 * Usage:  yarn admin:create --email=ops@yourco.com [--name="Jane Doe"]
 */
import mongoose from 'mongoose';
import { logger } from '../services/logger.ts';
import { connectDb } from '../services/database.ts';
import PlatformUser from '../models/PlatformUser.ts';
import { PlatformRole, PlatformUserStatus } from '../constants/models.ts';
import { authentik } from '../services/authentik.ts';

const TAG = 'CREATE_PLATFORM_ADMIN';

const getArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : undefined;
};

const run = async (): Promise<void> => {
  const email = getArg('email')?.toLowerCase();
  const name = getArg('name');
  if (!email) {
    logger.error(`[${TAG}] --email is required. Usage: yarn admin:create --email=ops@yourco.com`);
    process.exit(1);
  }

  await connectDb();

  // 1. Authentik identity — reuse an existing account or create one. Admins are
  //    not in any tenant group, so no groups are set here.
  let authUser = await authentik.findUserByEmail(email);
  let createdInAuthentik = false;
  if (!authUser) {
    authUser = await authentik.createUser({ username: email, email, name: name ?? email });
    createdInAuthentik = true;
    logger.info(`[${TAG}] Created Authentik user for ${email} (pk ${authUser.pk}).`);
  } else {
    logger.info(`[${TAG}] Reusing existing Authentik user for ${email} (pk ${authUser.pk}).`);
  }

  // 2. Setup email for a newly created admin so they can set a password. Non-fatal:
  //    needs AUTHENTIK_RECOVERY_EMAIL_STAGE + SMTP. If it fails, set a password for
  //    them directly in Authentik.
  if (createdInAuthentik) {
    try {
      await authentik.sendRecoveryEmail(authUser.pk);
      logger.info(`[${TAG}] Sent setup email to ${email}.`);
    } catch (err) {
      logger.warn(
        `[${TAG}] Could not send setup email (${
          err instanceof Error ? err.message : String(err)
        }). Set a password for ${email} in Authentik directly.`,
      );
    }
  }

  // 3. Authorization row — idempotent upsert by email. Re-running ensures the
  //    account is an active super admin and refreshes the Authentik pk; never
  //    clears a previously bound authSubject.
  const existing = await PlatformUser.findOne({ email });
  if (existing) {
    existing.role = PlatformRole.SUPER_ADMIN;
    existing.status = PlatformUserStatus.ACTIVE;
    existing.authUserPk = authUser.pk;
    if (name) {
      existing.name = name;
    }
    await existing.save();
    logger.info(`[${TAG}] Updated platform admin ${email} (active super admin).`);
  } else {
    await PlatformUser.create({
      email,
      name,
      role: PlatformRole.SUPER_ADMIN,
      status: PlatformUserStatus.ACTIVE,
      authUserPk: authUser.pk,
    });
    logger.info(`[${TAG}] Created platform admin ${email}. authSubject binds on first login.`);
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  logger.error(`[${TAG}] Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
