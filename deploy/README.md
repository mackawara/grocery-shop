# Production deployment

Both apps run as Docker containers in one compose stack on one server. Host
Caddy terminates TLS and proxies to loopback ports. This directory is the
source of truth for the stack; the API deploy workflow rsyncs it to
`/home/ubuntu/repos/saas` on every deploy (`.env` on the server is never
overwritten by the sync). `api.env` is generated fresh on **every** API
deploy from GitHub secrets and variables — see
[Application config](#application-config-apienv)
below; it's excluded from the rsync only because it's written by its own
step, not because it's hand-maintained.

| App       | Image                    | Loopback port | Deployed by                      |
| --------- | ------------------------ | ------------- | -------------------------------- |
| API       | `<user>/grocery-shop-api` | `5000`        | grocery-shop `Deploy API`        |
| Dashboard | `<user>/grocery-dashboard`| `8080`        | grocery-DASHBOARD `Deploy Dashboard` |

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
   writes it from GitHub secrets and variables on every run, before
   `deploy.sh` starts (see [Application config](#application-config-apienv)
   below). Just make sure those are populated in GitHub before the first
   deploy.
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

| Kind     | Name                 | Value                                 |
| -------- | -------------------- | ------------------------------------- |
| secret   | `DOCKERHUB_TOKEN`    | Docker Hub access token (write scope) |
| secret   | `SSH_PRIVATE_KEY`    | deploy key (PEM)                      |
| secret   | `SSH_HOST`           | server hostname/IP                    |
| secret   | `SSH_USER`           | deploy user                           |
| variable | `DOCKERHUB_USERNAME` | Docker Hub username                   |
| variable | `DEPLOY_PATH`        | optional, default `/home/ubuntu/repos/saas` |

`SSH_HOST` and `SSH_USER` are not credentials on their own, but they stay
secrets so a public Actions log never prints a ready-made `user@host` SSH
target.

grocery-DASHBOARD additionally needs:

| Kind   | Name                | Value                                    |
| ------ | ------------------- | ---------------------------------------- |
| secret | `VITE_API_BASE_URL` | e.g. `https://api.ventatech.duckdns.org` |

## Application config (`api.env`)

grocery-shop only. Each `src/config.ts` value is its own GitHub entry so a
single one can be rotated (update it, redeploy) without touching any of the
others. The **Write api.env from secrets and variables** step in `deploy.yml`
assembles them into `api.env` and copies it to the server before `deploy.sh`
runs — never edit `api.env` by hand on the server, it's overwritten on every
deploy.

**Secret or variable?** Credentials — anything whose disclosure is itself a
compromise — are **secrets**. Public identifiers, URLs and flags are
**variables**: masking them buys nothing and actively hurts debugging, since
GitHub redacts every occurrence of a secret's value in the log (a secret
`DOCKERHUB_USERNAME` turns the deployed image into `***/grocery-shop-api`,
and short values like `true` or `en` either garble unrelated output or aren't
masked at all). Variables are also readable in the repo settings UI, so you
can confirm what actually shipped. When in doubt, make it a secret.

| Kind     | Name                                   | Required | Notes                                                              |
| -------- | --------------------------------------- | -------- | ------------------------------------------------ |
| secret | `MONGODB_USERNAME`                      | yes      |                                                                      |
| secret | `MONGODB_PASSWORD`                      | yes      |                                                                      |
| secret | `MONGODB_HOST`                          | yes      |                                                                      |
| secret | `WHATSAPP_WEBHOOK_VERIFICATION_TOKEN`   | yes      |                                                                      |
| variable | `WHATSAPP_PHONE_NUMBER_ID`              | yes      |                                                                      |
| secret | `WHATSAPP_SYSTEM_TOKEN`                 | yes      |                                                                      |
| secret | `WHATSAPP_FLOW_PRIVATE_KEY`             | yes      | PEM, single line with literal `\n` (not real newlines) — see `whatsappFlowCrypto.ts` |
| secret | `WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE`  | no       | only if the PEM above is encrypted                                 |
| secret | `CREDENTIAL_ENC_KEY`           | yes      | 32-byte AES-256 key, hex (`openssl rand -hex 32`). Encrypts per-tenant WhatsApp tokens at rest. **Rotating it invalidates every stored credential — vendors must reconnect.** |
| secret | `WHATSAPP_APP_SECRET`                   | yes      | Meta app secret (App Dashboard → Settings → Basic); HMAC key for webhook `X-Hub-Signature-256` verification |
| variable | `WHATSAPP_SIGNATURE_ENFORCE`            | no       | `true` = reject unsigned/mis-signed webhooks with 403. Unset/other = log-only. **Enable only after a clean log-only period** — a wrong app secret with this on rejects all inbound WhatsApp traffic. |
| variable | `PUBLIC_BASE_URL`                       | yes      | e.g. `https://api.ventatech.duckdns.org`                           |
| variable | `AUTHENTIK_ISSUER`                      | yes      |                                                                      |
| variable | `AUTHENTIK_CLIENT_ID`                   | yes      |                                                                      |
| secret | `AUTHENTIK_CLIENT_SECRET`               | yes      |                                                                      |
| variable | `AUTHENTIK_BASE_URL`                    | yes      |                                                                      |
| secret | `AUTHENTIK_ADMIN_TOKEN`                 | yes      |                                                                      |
| variable | `AUTHENTIK_RECOVERY_EMAIL_STAGE`        | no       | pk/slug of an Authentik email stage; **required for staff invitations** — see below |
| secret | `SESSION_SECRET`                        | yes      |                                                                      |
| variable | `DASHBOARD_URL`                         | yes      |                                                                      |
| variable | `GOOGLE_SERVICE_ACCOUNT_EMAIL`          | no       | only if product-image uploads to Drive are used                    |
| secret | `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`    | no       | same format note as the WhatsApp Flow key — see `googleDrive.ts`   |
| variable | `GOOGLE_DRIVE_FOLDER_ID`                | no       |                                                                      |
| secret | `PLATFORM_ADMIN_EMAILS`                 | no       | comma-separated break-glass admin allowlist. Not a credential, but a variable would publish exactly whom to phish to bypass the dashboard |
| variable | `WHATSAPP_DRIVER_ASSIGNMENT_TEMPLATE`   | no       | name of the approved driver-assignment template — see below. Blank = drivers are not notified |
| variable | `WHATSAPP_DRIVER_ASSIGNMENT_TEMPLATE_LANG` | no    | language code of that template; defaults to `en`                   |

`APP_ENV` and `REDIS_HOST_PORT` are hardcoded in the workflow (always
`production` / `6379` in this stack). `PORT` and `REDIS_HOST` are injected by
`docker-compose.yml` directly — `PORT` from the server's own `.env`, not from
`api.env` — so never set any of these four as a secret or a variable.

**Fail-fast by design:** the workflow step checks every *required* entry
above is non-empty and stops the job — before touching the server at all — if
one is missing. This matters because `deploy.sh`'s automatic rollback
re-deploys the previous image tag but reads the *same* `api.env` on disk; a
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
Verify all four once per environment:

1. **SMTP + email stage.** Authentik must have a working email (SMTP) backend,
   and `AUTHENTIK_RECOVERY_EMAIL_STAGE` must be the pk/slug of an email stage
   that uses it. Invites and resends call `POST /core/users/{pk}/recovery_email/`
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
4. **`email_verified` claim.** The OIDC provider must include the `email` scope
   and emit `email_verified`. First-login seat binding (`resolveMembership`)
   ignores an unverified email, so without this an invited user silently
   dead-ends at `/no-access`. Authentik's default `email` scope mapping hardcodes
   `email_verified: true`; confirm the provider still uses it.

## Rollback

- **Automatic:** if a new container never turns healthy, `deploy.sh`
  re-deploys the previously running tag for that service and the workflow
  fails so you're alerted.
- **Manual:** run the repo's deploy workflow via *Run workflow* and enter any
  previously pushed tag (a commit SHA) — the build is skipped and that image
  is deployed as-is.

## Local dev

`docker-compose.yml` at the grocery-shop repo root is the local dev stack
(builds from source, bind mounts). This directory is production only.
