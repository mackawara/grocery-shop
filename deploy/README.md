# Production deployment

Both apps run as Docker containers in one compose stack on one server. Host
Caddy terminates TLS and proxies to loopback ports. This directory is the
source of truth for the stack; the API deploy workflow rsyncs it to
`/home/ubuntu/repos/saas` on every deploy (`.env` on the server is never
overwritten by the sync). `api.env` is generated fresh on **every** API
deploy from GitHub secrets — see [Application secrets](#application-secrets-apienv)
below; it's excluded from the rsync only because it's written by its own
step, not because it's hand-maintained.

| App       | Image                      | Loopback port | Deployed by                          |
| --------- | -------------------------- | ------------- | ------------------------------------ |
| API       | `<user>/grocery-shop-api`  | `5000`        | grocery-shop `Deploy API`            |
| Dashboard | `<user>/grocery-dashboard` | `8080`        | grocery-DASHBOARD `Deploy Dashboard` |

Both pipelines: build → push to Docker Hub (tagged `latest` + git SHA) → SSH →
`deploy.sh <service> <image> <sha>` → health-gated restart of that service
only, with automatic rollback to the previous tag on healthcheck failure.

The dashboard image bakes `VITE_API_BASE_URL` in at build time (Vite inlines
it) — changing the API URL requires a rebuild, not a restart.

## One-time server setup

1. Install Docker + the compose plugin; add the deploy user to the `docker` group.
2. Create the stack directory:

   ```bash
   mkdir -p /home/ubuntu/repos/saas
   ```

3. `api.env` needs no manual setup — the grocery-shop `Deploy API` workflow
   writes it from GitHub secrets on every run, before `deploy.sh` starts (see
   [Application secrets](#application-secrets-apienv) below). Just make sure
   those secrets are populated in GitHub before the first deploy.
4. Add an SSH keypair for deploys: private key → GitHub secret
   `SSH_PRIVATE_KEY` (in both repos), public key → the deploy user's
   `authorized_keys`.
5. Caddy (host install) — routes:

   ```caddy
   api.ventatech.duckdns.org {
       reverse_proxy 127.0.0.1:5000
   }

   dashboard.ventatech.duckdns.org {
       reverse_proxy 127.0.0.1:8080
   }
   ```

6. Run the grocery-shop `Deploy API` workflow once **before** the dashboard's —
   it syncs this directory (compose file + `deploy.sh`) to the server, which
   the dashboard workflow depends on.

## GitHub configuration (both repos, same values)

| Kind   | Name                 | Value                                       |
| ------ | -------------------- | ------------------------------------------- |
| secret | `DOCKERHUB_TOKEN`    | Docker Hub access token (write scope)       |
| secret | `SSH_PRIVATE_KEY`    | deploy key (PEM)                            |
| secret | `SSH_HOST`           | server hostname/IP                          |
| secret | `SSH_USER`           | deploy user                                 |
| secret | `DOCKERHUB_USERNAME` | Docker Hub username                         |
| secret | `DEPLOY_PATH`        | optional, default `/home/ubuntu/repos/saas` |

grocery-DASHBOARD additionally needs:

| Kind   | Name                | Value                                    |
| ------ | ------------------- | ---------------------------------------- |
| secret | `VITE_API_BASE_URL` | e.g. `https://api.ventatech.duckdns.org` |

## Application secrets (`api.env`)

grocery-shop only. Each `src/config.ts` value is its own GitHub secret so a
single credential can be rotated (update the secret, redeploy) without
touching any of the others. The **Write api.env from secrets** step in
`deploy.yml` assembles them into `api.env` and copies it to the server before
`deploy.sh` runs — never edit `api.env` by hand on the server, it's
overwritten on every deploy.

| Secret                                     | Required | Notes                                                                                                                                                                                                |
| ------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_USERNAME`                         | yes      |                                                                                                                                                                                                      |
| `MONGODB_PASSWORD`                         | yes      |                                                                                                                                                                                                      |
| `MONGODB_HOST`                             | yes      |                                                                                                                                                                                                      |
| `WHATSAPP_WEBHOOK_VERIFICATION_TOKEN`      | yes      |                                                                                                                                                                                                      |
| `WHATSAPP_PHONE_NUMBER_ID`                 | yes      |                                                                                                                                                                                                      |
| `WHATSAPP_SYSTEM_TOKEN`                    | yes      |                                                                                                                                                                                                      |
| `WHATSAPP_FLOW_PRIVATE_KEY`                | yes      | PEM, single line with literal `\n` (not real newlines) — see `whatsappFlowCrypto.ts`                                                                                                                 |
| `WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE`     | no       | only if the PEM above is encrypted                                                                                                                                                                   |
| `CREDENTIAL_ENC_KEY`                       | yes      | 32-byte AES-256 key, hex (`openssl rand -hex 32`). Encrypts per-tenant WhatsApp tokens at rest. **Rotating it invalidates every stored credential — vendors must reconnect.**                        |
| `WHATSAPP_APP_SECRET`                      | yes      | Meta app secret (App Dashboard → Settings → Basic); HMAC key for webhook `X-Hub-Signature-256` verification                                                                                          |
| `WHATSAPP_SIGNATURE_ENFORCE`               | no       | `true` = reject unsigned/mis-signed webhooks with 403. Unset/other = log-only. **Enable only after a clean log-only period** — a wrong app secret with this on rejects all inbound WhatsApp traffic. |
| `PUBLIC_BASE_URL`                          | yes      | e.g. `https://api.ventatech.duckdns.org`                                                                                                                                                             |
| `AUTHENTIK_ISSUER`                         | yes      |                                                                                                                                                                                                      |
| `AUTHENTIK_CLIENT_ID`                      | yes      |                                                                                                                                                                                                      |
| `AUTHENTIK_CLIENT_SECRET`                  | yes      |                                                                                                                                                                                                      |
| `AUTHENTIK_BASE_URL`                       | yes      |                                                                                                                                                                                                      |
| `AUTHENTIK_ADMIN_TOKEN`                    | yes      |                                                                                                                                                                                                      |
| `AUTHENTIK_RECOVERY_EMAIL_STAGE`           | no       | pk/slug of an Authentik email stage; **required for staff invitations** — see below                                                                                                                  |
| `SESSION_SECRET`                           | yes      |                                                                                                                                                                                                      |
| `DASHBOARD_URL`                            | yes      |                                                                                                                                                                                                      |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`             | no       | only if product-image uploads to Drive are used                                                                                                                                                      |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`       | no       | same format note as the WhatsApp Flow key — see `googleDrive.ts`                                                                                                                                     |
| `GOOGLE_DRIVE_FOLDER_ID`                   | no       |                                                                                                                                                                                                      |
| `PLATFORM_ADMIN_EMAILS`                    | no       | comma-separated break-glass admin allowlist; removal revokes allowlist-derived grants                                                                                                                |
| `WHATSAPP_DRIVER_ASSIGNMENT_TEMPLATE`      | no       | name of the approved driver-assignment template — see below. Blank = drivers are not notified                                                                                                        |
| `WHATSAPP_DRIVER_ASSIGNMENT_TEMPLATE_LANG` | no       | language code of that template; defaults to `en`                                                                                                                                                     |

`APP_ENV` and `REDIS_HOST_PORT` are hardcoded in the workflow, not secrets
(always `production` / `6379` in this stack). `PORT` and `REDIS_HOST` are
injected by `docker-compose.yml` directly — never set any of these four in a
secret.

**Fail-fast by design:** the workflow step checks every _required_ secret
above is non-empty and stops the job — before touching the server at all — if
one is missing. This matters because `deploy.sh`'s automatic rollback
re-deploys the previous image tag but reads the _same_ `api.env` on disk; a
broken `api.env` would break the rollback too, not just the new deploy. If
you add a new mandatory var to `src/config.ts`, add it to both the `for key
in ...` check and the `echo` block in the workflow, or a real deploy will
fail past that safety net with an unhelpful app-level crash instead of a
clear `::error::` in the Actions log.

## Driver assignment template

When the shop assigns a driver to a delivery, the API messages that driver on
WhatsApp. A driver is staff, not a customer, so there is no open 24-hour
customer-care window to send into — the message **must** be a pre-approved
template. Until one exists, leave `WHATSAPP_DRIVER_ASSIGNMENT_TEMPLATE` blank:
assignment still works and the dashboard still records it, the notification
simply stays dormant (and says so in the logs) instead of firing sends Meta
will reject.

To turn it on, submit a template on the WABA (Meta Business Manager → WhatsApp
Manager → Message templates):

- **Category:** Utility (not Marketing — this is transactional).
- **Language:** whatever you set in `WHATSAPP_DRIVER_ASSIGNMENT_TEMPLATE_LANG`.
- **Body**, with exactly five positional parameters in this order:

  ```
  New delivery assigned 🚚

  Order: {{1}}
  Customer: {{2}}
  Address: {{3}}
  Total: {{4}}
  Payment: {{5}}

  Open the dashboard for the map pin and full order details.
  ```

Then set `WHATSAPP_DRIVER_ASSIGNMENT_TEMPLATE` to the approved template's name
and redeploy. The parameter order is fixed in
`src/controllers/delivery/driverNotification.controller.ts` — if you change the
body, change both together or Meta rejects the send with error 132000
(parameter count mismatch).

## Authentik prerequisites (staff invitations)

Vendor signup and team invitations provision identities in Authentik via the
admin API and deliver a set-password link over Authentik's own SMTP. These are
**admin-console settings in Authentik, not code or `api.env` values** — the app
adds no new env var for them, but the invite loop is silent if any is missing.
Verify these once per environment. `yarn auth:doctor` covers the read-only API
checks, but it cannot prove the identity-policy checks in item 5.

1. **SMTP + email stage.** Authentik must have a working email (SMTP) backend,
   and `AUTHENTIK_RECOVERY_EMAIL_STAGE` must be the pk of an email stage that
   uses it.

   Creating the stage: **Admin interface → Flows and Stages → Stages → New
   Stage**, and pick **"Email stage"**. Two traps here. First, _Stages_ only
   appears in the **Admin** interface — from the user interface the menu is
   simply absent and the stage looks unavailable. Second, the type list contains
   both **"Email stage"** (this one — sends mail on our behalf) and **"Email
   authenticator setup stage"** (MFA enrolment, not this).

   Only `name` is actually required, so it is easy to save a valid stage that
   silently sends nothing. Tick **Use global connection settings** so it picks up the server's
   `AUTHENTIK_EMAIL__*` values instead of blank per-stage SMTP fields, leave
   **Activate user on success** off (our users are already active), and note that
   on 2026.8 **`token_expiry` is a duration string, not a number of minutes** —
   `minutes=30`, not `30`. Its documented separator is a comma
   (`hours=3,minutes=17`) while `recovery_cache_timeout` on the same object
   documents semicolons; if one is rejected, try the other.

   `yarn auth:doctor` lists every existing stage with a paste-ready
   `AUTHENTIK_RECOVERY_EMAIL_STAGE=<pk>` line. Invites and resends call `POST /core/users/{pk}/recovery_email/`
   with this stage. If SMTP is unconfigured the invite still succeeds but the API
   returns an `"Invited, but the setup email could not be sent."` warning and the
   invitee never gets a link. **Sanity check:** trigger one recovery email
   end-to-end (e.g. approve a tenant) and confirm it arrives.

2. **Admin token can PATCH users.** `AUTHENTIK_ADMIN_TOKEN` must permit
   `PATCH /core/users/{pk}/` (used to disable a removed teammate), on top of the
   create/delete/recovery it already uses. A full-admin token covers this; a
   narrowly-scoped token may not.
3. **Recovery flow enabled.** The emailed link lands on Authentik's recovery
   flow (set-password + email-verify stages). It must be enabled and reachable,
   or the link errors. On by default in a standard Authentik install.
4. **`email_verified` claim — no longer relied upon.** The OIDC provider should
   still include the `email` scope, but first-login seat binding no longer
   depends on the `email_verified` claim, and you should not configure a custom
   mapping to force it `true`.

   Authentik does not derive this claim, it hardcodes it — and since **2025.10**
   it hardcodes it to `false`, precisely because it "cannot vouch" for whether an
   address is verified. So the claim carries no information either way. While
   `resolveMembership` required it, that was a standing outage: no first login
   could ever bind a seat and every new vendor and invited staff member
   dead-ended at `/no-access`.

   Binding now keys off subject first. If no subject is bound yet, the email
   fallback accepts a row only when our row has `emailVerified`, a genuinely
   verified upstream IdP sends `email_verified: true`, or the row has the
   interim `authUserPk` provisioning marker. New vendor signup and invitation
   rows currently set `authUserPk`; they do **not** mint or consume a first-party
   email-verification token yet. Issue #51 adds that token flow and lets us
   remove the interim fallback.

5. **Identity trust policy is manual until issue #51 ships.** The interim
   `authUserPk` fallback is safe only if Authentik cannot let a different
   identity claim the same email. Confirm open self-enrolment is disabled, users
   cannot edit email addresses into someone else's seat, upstream identity
   mappings cannot rewrite email unexpectedly, duplicate emails are blocked or
   otherwise harmless, and recovery/credential issuance goes only to the account
   we provisioned. Public vendor signup verifies phone control, not mailbox
   control, so do not treat signup alone as email ownership.

## Authentik: MFA and recovering a broken login

### Symptoms that point here

| Symptom                                                            | Cause                                                | Fix                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------- |
| `/auth/login` returns 500, log says OIDC discovery failed          | no OAuth2 provider/application at `AUTHENTIK_ISSUER` | recreate it, below                                         |
| Signup returns 500 at the provisioning step; invites silently fail | `AUTHENTIK_ADMIN_TOKEN` invalid/expired              | reissue it, below                                          |
| Sign-in succeeds but everyone lands on `/no-access`                | the seat never bound                                 | check the `emailVerified` rules in the prerequisites above |

Rather than guessing, run the preflight. It checks the prerequisites it can read
from Authentik and prints the fix for whatever is broken:

```bash
yarn auth:doctor
```

It verifies the env vars, OIDC discovery, the advertised scopes, the admin
token, read access to users/groups, the recovery email stage, the brand recovery
flow, logout wiring, and that `AUTH_REDIRECT_URI` matches an authorization-type
redirect entry while the post-logout URL matches a logout-type entry.
It also prints warnings for provisioning permissions and identity trust settings
that must be checked manually. Read-only — it touches no database and prints no
secrets. Exits non-zero on failure; warnings leave exit status zero but mean the
report is not a complete rollout approval.

Run it again after each change in Authentik. A run with failures needs fixes; a
run with warnings needs the named manual checks before rollout. Note the issuer must be
`<base>/application/o/<application-slug>/`, with the trailing slash, and the
slug is the **application's**, not the provider's.

### Reissuing the admin token

Authentik → _Directory → Tokens and App passwords_ → create an **API token** for
a service account that can create/patch/delete users and groups and call
`/recovery_email/`. Copy it once, set it as the `AUTHENTIK_ADMIN_TOKEN` GitHub
secret and in local `.env`, and redeploy (the workflow regenerates `api.env`).
Verify with the `users/me/` call above before moving on.

### Recreating the OIDC application

Authentik → _Applications → Providers_ → create an **OAuth2/OpenID Provider**:

- Client type **Confidential**; copy the client ID and secret.
- Authorization-type redirect URI matching `AUTH_REDIRECT_URI`
  (`<PUBLIC_BASE_URL>/auth/callback`). Prefer strict matching for this fixed URL.
  Include the local one (`http://localhost:3000/auth/callback`) if you develop
  against this instance.
- Signing key: any configured certificate.
- Leave the scope mappings at the defaults — `openid`, `profile`, `email`. Do
  **not** add a custom mapping forcing `email_verified: true` (see prerequisite
  4 above).

Then _Applications → Applications_ → create an application bound to that
provider and note its **slug**. `AUTHENTIK_ISSUER` is
`<AUTHENTIK_BASE_URL>/application/o/<that-slug>/`.

### Platform admin grants and revocation

`PLATFORM_ADMIN_EMAILS` is a break-glass grant. An address on the current list
can bootstrap an active super admin; the resulting PlatformUser remains dependent
on that list. To revoke this access, remove the address from the deployed list
and redeploy. Existing sessions are checked against the current list on every
`/admin` request. An admin created with `yarn admin:create` has an independent
grant, so removing that address from the list does **not** revoke the explicit
grant; disable its PlatformUser record as well.

Rows created before grant provenance was recorded have no source marker. They
are treated as allowlist-dependent until an operator classifies them. Before
deploying this change, audit existing PlatformUser rows: keep intended break-glass
admins in `PLATFORM_ADMIN_EMAILS`, re-run `yarn admin:create --email=<address>`
for admins who should have an independent grant, and disable unwanted rows.
The script deliberately promotes an existing row to an independent grant, so
only run it for that purpose. Removing an address without this audit may lock
out a previously provisioned admin; leaving an unwanted address in the list
will continue to grant access. No automatic migration guesses a legacy row's
origin.

### Bootstrapping an admin when email is not working

A newly created Authentik account has **no usable password** — `createUser` sets
none. The recovery email is what issues the first credential, so if SMTP or the
email stage is broken, `yarn admin:create` leaves an admin who cannot log in at
all. Two flags set a password directly instead:

```bash
yarn admin:create --email=ops@yourco.com --generate-password   # prints one, once
yarn admin:create --email=ops@yourco.com --set-password        # prompts, hidden
```

`--generate-password` mints a 24-character random password and prints it to
stdout exactly once — never to the log, since logs are shipped and retained.
`--set-password` prompts without echoing, or reads one line from stdin when
there is no TTY, so it stays scriptable. Empty input is rejected before any
Authentik or MongoDB write. If Authentik later rejects a nonempty password,
the command reports whether it already created the identity; re-run with a
valid password to complete the PlatformUser grant.

Neither accepts the password as an argv value (`--password=...`) on purpose:
that form is captured by shell history and is visible to every user on the host
via `ps`. Both work on an existing account too, which makes `--set-password` the
recovery path when an admin is locked out rather than only a provisioning one.

### Checking that email actually sends

An API success is **not** a delivered email. `recovery_email` and invitations only
_queue_ an authentik `send_mail` task and return immediately; the SMTP login and
delivery happen later in the authentik **worker**. A broken mail path therefore
never surfaces as an API error — approvals report success while the task fails
and retries in the background, and the vendor never hears anything.

- `yarn auth:doctor` reads the task queue and reports **Email delivery** from the
  most recent email task, including the SMTP server's own reply when available.
  Empty, pending, unreadable, and incomplete queues are warnings, not success.
- `yarn auth:doctor --send-test-email=you@yourco.com` sends one real email.
  Authentik's recovery-email API returns 204 without a task id, so the command
  reports the enqueue as unverified; re-run the doctor and inspect the worker
  task before treating delivery as proven.
- On the authentik host, `docker compose logs worker` shows the same errors, and
  `docker compose exec worker ak test_email <address>` reproduces a send directly.

A `535 … BadCredentials - gsmtp` reply means Gmail refused the SMTP login. Gmail
SMTP needs a **Google App Password** (16 characters; requires 2-Step Verification;
not available for Workspace/school accounts or Advanced Protection), not the
account password. Set it as `AUTHENTIK_EMAIL__PASSWORD` on the authentik host and
recreate the containers with `docker compose up -d` — a plain `restart` keeps the
old environment. Then use **Resend** in the console rather than waiting for the
stuck task's retry: recovery links expire (30 minutes on `email-recovery`), so a
late retry can deliver a link that no longer works.

### Single sign-out

Signing out of the dashboard must also end the Authentik session, or the next
"Sign in" completes silently over SSO and looks like logout did nothing — a real
exposure on a shared machine, not just a UX wart. Two requirements:

1. **`AUTHENTIK_POST_LOGOUT_REDIRECT` must match a logout-type redirect entry.**
   The callback must separately match an authorization-type entry. Each entry
   can use strict or regex matching. `yarn auth:doctor` checks both types.
2. **`default-provider-invalidation-flow` must have a User Logout stage added.**
   This is the one that actually bites, and the default is wrong for us.

   Authentik runs _different_ flows depending on where logout starts: the brand's
   `default-invalidation-flow` when someone logs out of Authentik's own UI, and
   the provider's `default-provider-invalidation-flow` when an application
   initiates it (our case). Only the **User Logout** stage terminates the
   authentik session — and the provider flow ships **without** it, deliberately:
   out of the box it ends only that application's session and leaves the
   authentik session alive.

   The symptom is exactly the one that looks like a bug in our code: sign out,
   click "Continue with Authentik", and you are straight back in with no
   password prompt. Nothing in this repo can fix it; add the stage in
   _Flows & Stages → Flows → default-provider-invalidation-flow → Stage Bindings_.
   Doing so also enables Single Logout to other connected applications.

   **Verify it, don't assume it.** There are open upstream reports that
   `end-session/` sometimes does not trigger the invalidation flow at all
   (goauthentik/authentik#19201, #13780). Test by signing out and then hitting
   `/auth/login`: if it lands you back on the dashboard without prompting, the
   authentik session survived.

Behaviour worth knowing, confirmed against a live 2026.8 instance: Authentik
returns **400** for `post_logout_redirect_uri` unless `id_token_hint` is also
present. So `/auth/logout` sends the redirect only when it still holds an ID
token; otherwise it falls back to the `client_id`-only form, which logs the user
out but lands them on Authentik's own page instead of `/login`. The response's
`endsIdpSession` flag says which happened, and the dashboard warns the user when
the IdP session could not be cleared.

### Requiring MFA

MFA is Authentik configuration, not application code — the API only consumes the
resulting ID token, so nothing here needs to change to turn it on.

1. _Flows & Stages → Stages_ → add an **Authenticator Validation** stage. Set
   _Device classes_ to the factors you accept: TOTP (authenticator apps),
   WebAuthn (passkeys, Touch ID, security keys), and static recovery codes as a
   break-glass. Prefer WebAuthn where the vendor's device supports it; SMS is
   the weakest option and should not be the only factor.
2. Add matching **enrolment** stages (TOTP Authenticator Setup / WebAuthn
   Authenticator Setup) so a user with no device can register one.
3. Bind both into `default-authentication-flow` after the password stage.
4. To require MFA only for higher-risk seats rather than everyone, bind the
   validation stage with an **Expression Policy** — e.g. require it for members
   of the platform-admin group and for tenant owners, while staff enrol at their
   own pace. Forcing it on every seat at once will lock out anyone who has not
   enrolled, so stage the rollout.

Authentik emits `amr` (e.g. `["pwd","mfa"]`) in the ID token. If you later want
the API itself to _insist_ on MFA for the platform console rather than trusting
the flow binding, that claim is the hook: read it in the auth callback alongside
`email_verified` and gate `platformAdminResolver` on it. Not wired up today —
the flow binding is the enforcement point for now.

## Rollback

- **Automatic:** if a new container never turns healthy, `deploy.sh`
  re-deploys the previously running tag for that service and the workflow
  fails so you're alerted.
- **Manual:** run the repo's deploy workflow via _Run workflow_ and enter any
  previously pushed tag (a commit SHA) — the build is skipped and that image
  is deployed as-is.

## Local dev

`docker-compose.yml` at the grocery-shop repo root is the local dev stack
(builds from source, bind mounts). This directory is production only.
