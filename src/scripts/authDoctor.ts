/**
 * Preflight for the Authentik integration. Every check here is a prerequisite
 * the app cannot satisfy on its own — they are admin-console settings and
 * secrets — and each one fails in a way that is hard to read from the outside:
 * a dead admin token surfaces as "signup 500", a missing OIDC application as
 * "login 500", a missing email stage as an invite that silently never arrives.
 *
 * Run it after changing anything in Authentik, and before concluding that a
 * signup or login bug is in this codebase.
 *
 * Usage:  yarn auth:doctor
 *
 * Touches no database and writes nothing — read-only probes against Authentik —
 * except `--send-test-email`, which deliberately sends one real email.
 * Never prints the admin token, the client secret, or any user's details.
 */
/* eslint-disable no-console --
 * This is an operator CLI whose output IS the deliverable: an aligned report
 * read at a terminal. The Winston logger (the convention for application code)
 * prefixes every line with a level, timestamp and tenant label, which makes the
 * report unreadable. Nothing here is application logging.
 */
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyMailDelivery } from './authDoctorMailEvidence.ts';
import type { MailTask } from './authDoctorMailEvidence.ts';
import { readAuthDoctorConfig } from './authDoctorConfig.ts';
import { checkRedirectEntry } from './authDoctorRedirect.ts';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });
const CONFIG = readAuthDoctorConfig(process.env);
const BASE = CONFIG.AUTHENTIK_BASE_URL.replace(/\/+$/, '');
const TIMEOUT_MS = 20000;

type Status = 'pass' | 'fail' | 'warn';

interface Result {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const results: Result[] = [];
const record = (r: Result): Result => {
  results.push(r);
  return r;
};

// Plain console output rather than the Winston logger: this is an operator tool
// run at a terminal, and the tenant-prefixed log format hurts readability here.
const ICON: Record<Status, string> = { pass: '  ok  ', fail: ' FAIL ', warn: ' warn ' };

const fetchWithTimeout = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${CONFIG.AUTHENTIK_ADMIN_TOKEN}`,
  'Content-Type': 'application/json',
});

// 1. Are the values even set? Everything downstream is meaningless otherwise.
const checkEnv = (): boolean => {
  const required: Array<[string, string]> = [
    ['AUTHENTIK_ISSUER', CONFIG.AUTHENTIK_ISSUER],
    ['AUTHENTIK_BASE_URL', CONFIG.AUTHENTIK_BASE_URL],
    ['AUTHENTIK_CLIENT_ID', CONFIG.AUTHENTIK_CLIENT_ID],
    ['AUTHENTIK_CLIENT_SECRET', CONFIG.AUTHENTIK_CLIENT_SECRET],
    ['AUTHENTIK_ADMIN_TOKEN', CONFIG.AUTHENTIK_ADMIN_TOKEN],
    ['AUTH_REDIRECT_URI', CONFIG.AUTH_REDIRECT_URI],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    record({
      name: 'Environment',
      status: 'fail',
      detail: `missing: ${missing.join(', ')}`,
      fix: 'Set these in .env locally, and as GitHub secrets for deploys (deploy/README.md → Application secrets).',
    });
    return false;
  }
  record({ name: 'Environment', status: 'pass', detail: 'all Authentik vars set' });
  return true;
};

// 2. The OIDC application. This is what /auth/login needs; a 404 here is the
//    single most common cause of "login is temporarily unavailable".
const checkDiscovery = async (): Promise<void> => {
  const issuer = CONFIG.AUTHENTIK_ISSUER.endsWith('/')
    ? CONFIG.AUTHENTIK_ISSUER
    : `${CONFIG.AUTHENTIK_ISSUER}/`;
  const url = `${issuer}.well-known/openid-configuration`;
  try {
    const res = await fetchWithTimeout(url);
    if (res.status === 404) {
      record({
        name: 'OIDC discovery',
        status: 'fail',
        detail: `404 at ${url} — no OIDC application at that slug`,
        fix: 'Create an OAuth2/OpenID provider + application in Authentik, then set AUTHENTIK_ISSUER to <base>/application/o/<application-slug>/ (trailing slash, the APPLICATION slug).',
      });
      return;
    }
    if (!res.ok) {
      record({
        name: 'OIDC discovery',
        status: 'fail',
        detail: `HTTP ${res.status} at ${url}`,
      });
      return;
    }
    const doc = (await res.json()) as { issuer?: string; scopes_supported?: string[] };
    record({
      name: 'OIDC discovery',
      status: 'pass',
      detail: `issuer ${doc.issuer ?? '(none reported)'}`,
    });

    // The login flow requests exactly these; a provider missing `email` cannot
    // supply the anchor resolveMembership falls back to.
    const scopes = doc.scopes_supported ?? [];
    const wanted = ['openid', 'profile', 'email'];
    const absent = wanted.filter((s) => !scopes.includes(s));
    record(
      absent.length === 0
        ? { name: 'OIDC scopes', status: 'pass', detail: wanted.join(', ') }
        : {
            name: 'OIDC scopes',
            status: 'fail',
            detail: `provider does not advertise: ${absent.join(', ')}`,
            fix: 'Add the default openid/profile/email scope mappings to the provider.',
          },
    );
  } catch (err) {
    record({
      name: 'OIDC discovery',
      status: 'fail',
      detail: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
};

// 3. The admin token. Signup provisioning, invitations, teammate disabling and
//    approval emails all go through it.
const checkAdminToken = async (): Promise<boolean> => {
  try {
    const res = await fetchWithTimeout(`${BASE}/api/v3/core/users/me/`, {
      headers: authHeaders(),
    });
    if (res.status === 401 || res.status === 403) {
      const body = await res.text();
      record({
        name: 'Admin token',
        status: 'fail',
        detail: `HTTP ${res.status} — ${body.slice(0, 120)}`,
        fix: 'Reissue in Authentik → Directory → Tokens and App passwords, then update the AUTHENTIK_ADMIN_TOKEN secret and .env.',
      });
      return false;
    }
    if (!res.ok) {
      record({ name: 'Admin token', status: 'fail', detail: `HTTP ${res.status}` });
      return false;
    }
    record({ name: 'Admin token', status: 'pass', detail: 'accepted by Authentik' });
    return true;
  } catch (err) {
    record({
      name: 'Admin token',
      status: 'fail',
      detail: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
    return false;
  }
};

// 4. Token scope. A read-only token passes the check above but fails the first
//    real signup, so probe the collections we actually write to.
const checkAdminScope = async (): Promise<void> => {
  for (const [name, path] of [
    ['users', '/api/v3/core/users/?page_size=1'],
    ['groups', '/api/v3/core/groups/?page_size=1'],
  ] as const) {
    try {
      const res = await fetchWithTimeout(`${BASE}${path}`, { headers: authHeaders() });
      record(
        res.ok
          ? { name: `Admin read access (${name})`, status: 'pass', detail: 'readable' }
          : {
              name: `Admin read access (${name})`,
              status: 'fail',
              detail: `HTTP ${res.status}`,
              fix: 'Grant the token a role that can create/modify users and groups.',
            },
      );
    } catch (err) {
      record({
        name: `Admin read access (${name})`,
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  record({
    name: 'Provisioning permissions',
    status: 'warn',
    detail: 'not verified by this read-only run',
    fix: 'Manually confirm the token can create, patch, delete, and send recovery email for users before rollout.',
  });
};

const checkIdentityTrust = (): void => {
  record({
    name: 'Identity trust policy',
    status: 'warn',
    detail: 'not verified by this script while interim email binding is enabled',
    fix: 'Manually confirm self-enrolment, profile email edits, duplicate email handling, upstream mappings, and recovery issuance cannot let another identity claim a seat email.',
  });
};

// Collected while probing, printed after the report so the fix line can point
// at it without interleaving into the aligned table.
const stageLines: string[] = [];
const AVAILABLE_STAGES_HINT = ' Candidates are printed under the report.';

// Read-only: list the email stages this instance actually has, so a stale pk is
// a copy-paste fix rather than a console hunt.
const listEmailStages = async (): Promise<void> => {
  try {
    const res = await fetchWithTimeout(`${BASE}/api/v3/stages/email/?page_size=100`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      stageLines.push(`  Could not list email stages (HTTP ${res.status}).`);
      return;
    }
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const stages = data.results ?? [];
    if (stages.length === 0) {
      stageLines.push('  This instance has NO email stages — create one backed by working SMTP.');
      return;
    }
    stageLines.push('  Email stages on this instance:');
    for (const st of stages) {
      stageLines.push(`    AUTHENTIK_RECOVERY_EMAIL_STAGE=${String(st.pk)}   # ${String(st.name)}`);
    }
  } catch (err) {
    stageLines.push(
      `  Could not list email stages: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

// 5. The email stage used for set-password / invitation mail. Optional in the
//    config, but without it every invite and approval mail silently no-ops —
//    including the one an approved vendor needs to set their first password.
const checkEmailStage = async (): Promise<void> => {
  const stage = CONFIG.AUTHENTIK_RECOVERY_EMAIL_STAGE;
  if (!stage) {
    record({
      name: 'Recovery email stage',
      status: 'warn',
      detail: 'AUTHENTIK_RECOVERY_EMAIL_STAGE is unset',
      fix: 'Staff invitations and approval emails will not be sent. Set it to the pk of an email stage backed by working SMTP.',
    });
    return;
  }
  try {
    const res = await fetchWithTimeout(`${BASE}/api/v3/stages/email/${stage}/`, {
      headers: authHeaders(),
    });
    if (res.status === 404) {
      // A stale pk is far more likely than a missing stage (Authentik reassigns
      // pks when a stage is recreated), so name the candidates rather than
      // sending the operator hunting through the console for them.
      record({
        name: 'Recovery email stage',
        status: 'fail',
        detail: `no email stage with pk ${stage}`,
        fix: `Set AUTHENTIK_RECOVERY_EMAIL_STAGE to one of the stages listed below.${AVAILABLE_STAGES_HINT}`,
      });
      await listEmailStages();
      return;
    }
    if (!res.ok) {
      record({ name: 'Recovery email stage', status: 'fail', detail: `HTTP ${res.status}` });
      return;
    }

    // Existing is not the same as working. Only `name` is required to save an
    // email stage, so it is easy to end up with one that has global settings OFF
    // and blank SMTP fields — it saves fine, passes an "exists" check, and then
    // silently sends nothing. Inspect the config rather than just the pk.
    const cfg = (await res.json()) as {
      name?: string;
      use_global_settings?: boolean;
      host?: string;
      from_address?: string;
      template?: string;
      activate_user_on_success?: boolean;
    };
    record({
      name: 'Recovery email stage',
      status: 'pass',
      detail: `${cfg.name ?? stage} exists`,
    });

    if (cfg.use_global_settings) {
      record({
        name: 'Email stage SMTP',
        status: 'pass',
        detail: "uses global settings (the server's AUTHENTIK_EMAIL__* values)",
      });
    } else if (!cfg.host) {
      record({
        name: 'Email stage SMTP',
        status: 'fail',
        detail: 'global settings OFF and no SMTP host set — this stage cannot send mail',
        fix: 'Edit the stage and tick "Use global connection settings", or fill in its own SMTP host/port/credentials.',
      });
    } else {
      record({
        name: 'Email stage SMTP',
        status: 'warn',
        detail: `per-stage SMTP host ${cfg.host} — credentials cannot be verified from here`,
        fix: 'Send one real recovery email to confirm delivery.',
      });
    }

    // activate_user_on_success flips is_active on the identified user. Our
    // accounts are already active, so it should be off; on, it is a quiet way to
    // re-enable someone an operator deliberately disabled.
    if (cfg.activate_user_on_success) {
      record({
        name: 'Email stage activation',
        status: 'warn',
        detail:
          'activate_user_on_success is ON — a recovery email will re-enable a disabled account',
        fix: 'Turn it off unless you are using this stage for pending-user enrolment.',
      });
    }
  } catch (err) {
    record({
      name: 'Recovery email stage',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
};

// --- Email delivery (the part the API cannot see) ---------------------------
// Every endpoint that "sends" mail — recovery_email, invitations — only QUEUES an
// authentik `send_mail` task and returns success immediately. The SMTP login and
// delivery happen later in the authentik WORKER. So a broken mail path never
// comes back as an API error: approvals report success while the task fails and
// retries in the background, and the vendor simply never gets the email. The
// only place the truth lives is the task queue, so read it.

const SEND_MAIL_ACTOR = 'authentik.stages.email.tasks.send_mail';

const listMailTasks = async (): Promise<{ tasks: MailTask[]; warning?: string }> => {
  const out: MailTask[] = [];
  let pageLimitHit = false;
  for (let page = 1; page <= 5; page += 1) {
    const res = await fetchWithTimeout(`${BASE}/api/v3/tasks/tasks/?page_size=100&page=${page}`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      return { tasks: out, warning: `could not read mail task page ${page} (HTTP ${res.status})` };
    }
    const body = (await res.json()) as { results?: unknown; pagination?: { next?: number } };
    if (!Array.isArray(body.results)) {
      return { tasks: out, warning: `mail task page ${page} had an unexpected response shape` };
    }
    out.push(...body.results.filter((t): t is MailTask => isMailTask(t)));
    if (!body.pagination?.next) {
      break;
    }
    if (page === 5) {
      pageLimitHit = true;
    }
  }
  return {
    tasks: out,
    ...(pageLimitHit
      ? { warning: 'mail task history is incomplete; page limit reached while more pages remain' }
      : {}),
  };
};

const isMailTask = (value: unknown): value is MailTask =>
  typeof value === 'object' &&
  value !== null &&
  (value as { actor_name?: unknown }).actor_name === SEND_MAIL_ACTOR &&
  typeof (value as { message_id?: unknown }).message_id === 'string' &&
  typeof (value as { state?: unknown }).state === 'string';

// 5c. Passive: is mail actually leaving? Judged by the MOST RECENT email task, so
//     a failure that has since been fixed does not keep this red forever.
const checkMailDelivery = async (): Promise<void> => {
  const name = 'Email delivery';
  try {
    const { tasks, warning } = await listMailTasks();
    record(classifyMailDelivery(name, tasks, warning));
  } catch (err) {
    record({ name, status: 'warn', detail: err instanceof Error ? err.message : String(err) });
  }
};

// Optional, opt-in, and the ONLY check here with a side effect: actually send a
// recovery email. Everything else is read-only, and every other check can pass
// while delivery is broken — a wrong SMTP password, a blocked port and a
// silently-dropped sender all look identical from the API. This is the only way
// to know the set-password mail a vendor depends on will really arrive.
//
// Not run by default precisely because it emails a real person. Usage:
//   yarn auth:doctor --send-test-email=you@yourco.com
const sendTestEmail = async (address: string): Promise<void> => {
  const name = 'Test recovery email';
  try {
    const lookup = await fetchWithTimeout(
      `${BASE}/api/v3/core/users/?email=${encodeURIComponent(address)}`,
      { headers: authHeaders() },
    );
    if (!lookup.ok) {
      record({ name, status: 'fail', detail: `user lookup failed (HTTP ${lookup.status})` });
      return;
    }
    const user = ((await lookup.json()) as { results?: Array<{ pk: number }> }).results?.[0];
    if (!user) {
      record({
        name,
        status: 'fail',
        detail: `no Authentik user with email ${address}`,
        fix: 'Use an address that already has an Authentik account — this sends a real recovery email to it.',
      });
      return;
    }

    const res = await fetchWithTimeout(`${BASE}/api/v3/core/users/${user.pk}/recovery_email/`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ email_stage: CONFIG.AUTHENTIK_RECOVERY_EMAIL_STAGE }),
    });
    if (!res.ok) {
      const body = await res.text();
      record({
        name,
        status: 'fail',
        detail: `HTTP ${res.status} — ${body.slice(0, 160)}`,
        fix: 'Authentik refused to send. Check the email stage and the server SMTP settings.',
      });
      return;
    }
    record({
      name,
      status: 'warn',
      detail:
        'recovery email was queued, but Authentik did not return a task id; re-run `yarn auth:doctor` and confirm the worker task succeeds',
    });
  } catch (err) {
    record({ name, status: 'fail', detail: err instanceof Error ? err.message : String(err) });
  }
};

// 7. Single sign-out. Authentik runs the *provider's* invalidation flow when an
//    application initiates logout, and that flow ships WITHOUT a User Logout
//    stage — so out of the box our /auth/logout ends only the application
//    session and leaves the authentik session alive. The user then clicks
//    "Sign in" and is straight back in with no password prompt, which looks
//    exactly like a bug in our code and is not one. Nothing in this repo can
//    fix it; the stage has to be bound in Authentik. So check it here.
const checkLogoutStage = async (): Promise<void> => {
  const name = 'Single sign-out';
  try {
    // Which invalidation flow does OUR provider actually use? Read it off the
    // provider rather than assuming the default slug — it is configurable.
    const provRes = await fetchWithTimeout(
      `${BASE}/api/v3/providers/oauth2/?client_id=${encodeURIComponent(CONFIG.AUTHENTIK_CLIENT_ID)}`,
      { headers: authHeaders() },
    );
    if (!provRes.ok) {
      record({ name, status: 'warn', detail: `could not read provider (HTTP ${provRes.status})` });
      return;
    }
    const provData = (await provRes.json()) as {
      results?: Array<{ invalidation_flow?: string | null }>;
    };
    const flowPk = provData.results?.[0]?.invalidation_flow;
    if (!flowPk) {
      record({
        name,
        status: 'fail',
        detail: 'provider has no invalidation flow set',
        fix: 'Set the provider’s Invalidation flow, then bind a User Logout stage to it.',
      });
      return;
    }

    // Every user_logout stage on the instance, and every stage bound to that flow.
    const [stagesRes, bindRes] = await Promise.all([
      fetchWithTimeout(`${BASE}/api/v3/stages/user_logout/?page_size=100`, {
        headers: authHeaders(),
      }),
      fetchWithTimeout(`${BASE}/api/v3/flows/bindings/?target=${encodeURIComponent(flowPk)}`, {
        headers: authHeaders(),
      }),
    ]);
    if (!stagesRes.ok || !bindRes.ok) {
      record({ name, status: 'warn', detail: 'could not read stages/bindings — check manually' });
      return;
    }
    const stages =
      ((await stagesRes.json()) as { results?: Array<{ pk: string; name: string }> }).results ?? [];
    const bindData = (await bindRes.json()) as { results?: Array<{ stage: string }> };
    const bindings = bindData.results ?? [];

    const logoutPks = new Set(stages.map((st) => st.pk));
    const bound = bindings.some((b) => logoutPks.has(b.stage));

    if (bound) {
      record({
        name,
        status: 'pass',
        detail: 'a User Logout stage is bound to the invalidation flow',
      });
      return;
    }

    record({
      name,
      status: 'fail',
      detail: 'no User Logout stage bound to the provider’s invalidation flow',
      fix: 'Signing out will NOT end the authentik session. Bind one — candidates printed under the report.',
    });
    stageLines.push('  Bind ONE of these to the provider invalidation flow:');
    if (stages.length === 0) {
      stageLines.push('    (none exist — create a User Logout stage first; it has no settings)');
    }
    for (const st of stages) {
      stageLines.push(`    ${st.name}   (pk ${st.pk})`);
    }
    // Resolve the flow's slug so the operator gets a link straight to the page
    // that needs editing, rather than a pk and a flow list to search.
    let flowSlug: string | undefined;
    try {
      // Flow detail is addressed by SLUG, not pk, so a detail call with the pk
      // 404s. Match on the list instead — that is the only way from pk to slug.
      const fRes = await fetchWithTimeout(`${BASE}/api/v3/flows/instances/?page_size=200`, {
        headers: authHeaders(),
      });
      if (fRes.ok) {
        const flows =
          ((await fRes.json()) as { results?: Array<{ pk: string; slug: string }> }).results ?? [];
        flowSlug = flows.find((f) => f.pk === flowPk)?.slug;
      }
    } catch {
      // Non-fatal: fall back to the pk and the flow index below.
    }
    stageLines.push(`  Flow to bind it to: ${flowSlug ?? `pk ${flowPk}`}`);
    stageLines.push(
      flowSlug
        ? `    ${BASE}/if/admin/#/flow/flows/${flowSlug}   (Stage Bindings tab -> Bind existing stage)`
        : `    ${BASE}/if/admin/#/flow/flows/`,
    );
  } catch (err) {
    record({ name, status: 'warn', detail: err instanceof Error ? err.message : String(err) });
  }
};

// 5b. The brand's recovery flow. Both recovery_email and the recovery-link
//     fallback build their link INTO this flow, so with none set Authentik
//     refuses outright — "No recovery flow set." — and an approved vendor gets
//     neither the email nor a link. The email stage existing is not enough; the
//     flow it points people into must exist too. Authentik picks the brand by
//     the Host header our API calls with: a brand whose domain matches that
//     host, else the default brand.
const checkBrandRecoveryFlow = async (): Promise<void> => {
  const name = 'Brand recovery flow';
  try {
    const host = new URL(BASE).host.toLowerCase();
    const res = await fetchWithTimeout(`${BASE}/api/v3/core/brands/?page_size=50`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      record({ name, status: 'warn', detail: `could not read brands (HTTP ${res.status})` });
      return;
    }
    const brands =
      (
        (await res.json()) as {
          results?: Array<{ domain: string; default: boolean; flow_recovery?: string | null }>;
        }
      ).results ?? [];
    const brand =
      brands.find((b) => host.endsWith(b.domain.toLowerCase())) ?? brands.find((b) => b.default);
    if (!brand) {
      record({
        name,
        status: 'fail',
        detail: `no brand matches ${host} and no default brand exists`,
      });
      return;
    }
    record(
      brand.flow_recovery
        ? { name, status: 'pass', detail: `brand "${brand.domain}" has a recovery flow` }
        : {
            name,
            status: 'fail',
            detail: `brand "${brand.domain}" has NO recovery flow — set-password emails and links will fail`,
            fix: 'Create or import a flow with designation Recovery, then System → Brands → edit the brand → Default flows → Recovery flow.',
          },
    );
  } catch (err) {
    record({ name, status: 'warn', detail: err instanceof Error ? err.message : String(err) });
  }
};

// 6. Redirect URI. A mismatch fails only at the callback, after the user has
//    already typed their password — the most confusing possible place.
const checkRedirectUri = async (): Promise<void> => {
  try {
    const res = await fetchWithTimeout(
      `${BASE}/api/v3/providers/oauth2/?client_id=${encodeURIComponent(CONFIG.AUTHENTIK_CLIENT_ID)}`,
      { headers: authHeaders() },
    );
    if (!res.ok) {
      record({
        name: 'Redirect URI',
        status: 'warn',
        detail: `could not read provider (HTTP ${res.status}) — check manually`,
      });
      return;
    }
    const data = (await res.json()) as {
      results?: Array<{ redirect_uris?: unknown }>;
    };
    const provider = data.results?.[0];
    if (!provider) {
      record({
        name: 'Redirect URI',
        status: 'fail',
        detail: 'no OAuth2 provider matches AUTHENTIK_CLIENT_ID',
        fix: 'AUTHENTIK_CLIENT_ID does not belong to any provider on this instance.',
      });
      return;
    }
    const raw = provider.redirect_uris;
    const wanted = CONFIG.AUTH_REDIRECT_URI;

    // The provider keeps authorization and logout redirects in typed entries.
    const postLogout = CONFIG.AUTHENTIK_POST_LOGOUT_REDIRECT;
    const logoutVerdict = postLogout
      ? checkRedirectEntry(raw, postLogout, 'logout')
      : { status: 'warn' as const, detail: 'no post-logout redirect is configured' };
    const callbackVerdict = checkRedirectEntry(raw, wanted, 'authorization');
    record({
      name: 'Post-logout redirect',
      ...logoutVerdict,
      ...(logoutVerdict.status === 'fail'
        ? { fix: 'Add a logout-type redirect entry to the Authentik OAuth2 provider.' }
        : {}),
    });

    record({
      name: 'Redirect URI',
      ...callbackVerdict,
      ...(callbackVerdict.status === 'fail'
        ? { fix: 'Add an authorization-type redirect entry to the Authentik OAuth2 provider.' }
        : {}),
    });
  } catch (err) {
    record({
      name: 'Redirect URI',
      status: 'warn',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
};

const main = async (): Promise<void> => {
  console.log(`\nAuthentik preflight — ${BASE}\n`);

  if (checkEnv()) {
    await checkDiscovery();
    const tokenOk = await checkAdminToken();
    if (tokenOk) {
      await checkAdminScope();
      checkIdentityTrust();
      await checkEmailStage();
      await checkBrandRecoveryFlow();
      await checkMailDelivery();
      await checkRedirectUri();
      await checkLogoutStage();

      // Opt-in and side-effecting, so it runs last and only when asked.
      const testTo = process.argv
        .find((a) => a.startsWith('--send-test-email='))
        ?.slice('--send-test-email='.length)
        .trim();
      if (testTo) {
        await sendTestEmail(testTo);
      }
    } else {
      console.log('  (skipping token-dependent checks — fix the admin token first)\n');
    }
  }

  for (const r of results) {
    console.log(`[${ICON[r.status]}] ${r.name}: ${r.detail}`);
    if (r.fix && r.status !== 'pass') {
      console.log(`          → ${r.fix}`);
    }
  }

  if (stageLines.length > 0) {
    console.log('');
    for (const line of stageLines) {
      console.log(line);
    }
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  console.log(
    `\n${results.length - failed - warned} passed, ${warned} warning(s), ${failed} failure(s).`,
  );
  console.log(
    failed === 0
      ? warned === 0
        ? 'Authentik looks ready. Sign-in and signup provisioning should work.\n'
        : 'Authentik has no failures, but warnings remain. Resolve or manually accept them before rollout.\n'
      : 'Fix the failures above — see deploy/README.md → "Authentik: MFA and recovering a broken login".\n',
  );

  // Non-zero on failure so this can gate a deploy or run in CI later.
  process.exit(failed > 0 ? 1 : 0);
};

void main();
