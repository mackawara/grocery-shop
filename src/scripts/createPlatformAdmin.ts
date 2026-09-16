/**
 * Provision a platform super admin — the cross-tenant operator who approves/
 * rejects pending vendors. There is deliberately NO public admin signup; this is
 * the controlled onboarding path. It does the whole job in one command:
 *   1. Authentik identity  — find or create the user (so they can log in via OIDC)
 *   2. First credential    — set a password directly, or send a recovery email
 *   3. Authorization row   — upsert the PlatformUser (active super admin)
 * The Authentik `sub` binds automatically on first login (platformAdminResolver).
 *
 * Unlike seed:local this is NOT dev-gated: run it against whatever Mongo cluster
 * CONFIG points at, including production. Requires the Authentik admin token
 * (AUTHENTIK_BASE_URL/AUTHENTIK_ADMIN_TOKEN) and, for the email, an email stage.
 *
 * Usage:  yarn admin:create --email=ops@yourco.com [--name="Jane Doe"]
 *         yarn admin:create --email=ops@yourco.com --set-password
 *         yarn admin:create --email=ops@yourco.com --generate-password
 *
 * By default a newly created admin gets a recovery email and sets their own
 * password. That needs working SMTP and an email stage
 * (AUTHENTIK_RECOVERY_EMAIL_STAGE); when either is missing the account is left
 * with no usable password and no way in. The two password flags are the way out
 * of that hole:
 *
 *   --set-password       prompt for a password (hidden), or read one line from
 *                        stdin when stdin is not a terminal.
 *   --generate-password  mint a strong random one and print it ONCE.
 *
 * Neither takes the password as an argv value on purpose: a --password=... flag
 * would be captured by shell history and visible to every user on the box via
 * `ps`. The password is never logged.
 */
import { randomBytes } from 'crypto';
import readline from 'readline';
import mongoose from 'mongoose';
import { logger } from '../services/logger.ts';
import { connectDb } from '../services/database.ts';
import PlatformUser from '../models/PlatformUser.ts';
import { PlatformRole, PlatformUserStatus } from '../constants/models.ts';
import { PlatformGrantSource } from '../constants/platformGrantSource.ts';
import { authentik } from '../services/authentik.ts';
import { preparePlatformAdminPassword } from './platformAdminPassword.ts';

const TAG = 'CREATE_PLATFORM_ADMIN';

const getArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : undefined;
};

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

// A 24-char URL-safe password (~143 bits). Printed once by the caller and never
// logged; base64url avoids characters that get mangled when pasted into a shell
// or a browser form.
const generatePassword = (): string => randomBytes(18).toString('base64url');

// Read a password without echoing it. Falls back to a single line from stdin
// when there is no TTY (piped input, CI), so the script stays scriptable without
// ever putting the secret in argv.
const promptPassword = async (prompt: string): Promise<string> => {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line.trim();
    }
    return '';
  }

  return new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Suppress echo: readline still collects the keystrokes, the terminal just
    // does not render them.
    const asMutable = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput: unknown };
    asMutable._writeToOutput = () => {};
    process.stdout.write(prompt);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
};

const run = async (): Promise<void> => {
  const email = getArg('email')?.toLowerCase();
  const name = getArg('name');
  const setPasswordFlag = hasFlag('set-password');
  const generateFlag = hasFlag('generate-password');
  if (setPasswordFlag && generateFlag) {
    logger.error(`[${TAG}] Use either --set-password or --generate-password, not both.`);
    process.exit(1);
  }
  if (!email) {
    logger.error(`[${TAG}] --email is required. Usage: yarn admin:create --email=ops@yourco.com`);
    process.exit(1);
  }

  // Read operator input before any external write. Empty input must not leave
  // an Authentik identity without a matching PlatformUser grant.
  let password: string | undefined;
  try {
    password = await preparePlatformAdminPassword(
      setPasswordFlag,
      generateFlag,
      () => promptPassword('New password: '),
      generatePassword,
    );
  } catch {
    logger.error(`[${TAG}] No password supplied — aborting without changing anything.`);
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

  // 2. First credential. A freshly created Authentik account has NO usable
  //    password, so without this step there is no way to log in at all.
  //
  //    Default is the recovery email (the admin chooses their own password and
  //    it never passes through us). The explicit flags set one directly, which
  //    is the bootstrap path when SMTP or the email stage is not working —
  //    exactly the state that otherwise leaves a new admin locked out.
  //
  //    Applies to an existing Authentik account too: --set-password on a
  //    reused account is a deliberate password reset, which is what you want
  //    when recovering access rather than provisioning fresh.
  if (password) {
    try {
      await authentik.setPassword(authUser.pk, password);
    } catch (err) {
      // A 400 here is Authentik's own password policy rejecting the value.
      logger.error(
        `[${TAG}] Could not set password: ${err instanceof Error ? err.message : String(err)}. ` +
          (createdInAuthentik
            ? 'The Authentik identity was created but has no PlatformUser grant yet. Re-run this command after correcting the password.'
            : 'The existing Authentik identity was left unchanged. Re-run this command after correcting the password.'),
      );
      await mongoose.disconnect();
      process.exit(1);
    }
    if (generateFlag) {
      // The ONLY time this value is ever displayed, and deliberately via stdout
      // rather than the logger: logs get shipped and retained, and a generated
      // password must not end up in them.
      process.stdout.write(
        `\nGenerated password for ${email}:\n\n    ${password}\n\n` +
          'Shown once — it is not stored or logged. Save it now, and change it after first login.\n\n',
      );
    } else {
      logger.info(`[${TAG}] Password set for ${email}.`);
    }
  } else if (createdInAuthentik) {
    // Non-fatal: needs AUTHENTIK_RECOVERY_EMAIL_STAGE + SMTP. The account exists
    // either way, so point at the recovery flags rather than leaving the
    // operator to work out that the admin now cannot log in.
    try {
      await authentik.sendRecoveryEmail(authUser.pk);
      logger.info(`[${TAG}] Sent setup email to ${email}.`);
    } catch (err) {
      logger.warn(
        `[${TAG}] Could not send setup email (${
          err instanceof Error ? err.message : String(err)
        }). This admin has NO usable password yet — re-run with --generate-password ` +
          '(or --set-password) to set one directly.',
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
    existing.grantSource = PlatformGrantSource.PROVISIONED;
    existing.authUserPk = authUser.pk;
    // Operator-provisioned, so the email anchor is vouched for here rather than
    // by an IdP claim: whoever ran this script typed the address and holds the
    // Authentik admin token. Without this the row could never bind on first
    // login, because Authentik's email_verified claim is a hardcoded false
    // (see resolveMembership).
    existing.emailVerified = true;
    existing.emailVerifiedAt = new Date();
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
      grantSource: PlatformGrantSource.PROVISIONED,
      authUserPk: authUser.pk,
      emailVerified: true,
      emailVerifiedAt: new Date(),
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
