# Production deployment

Both apps run as Docker containers in one compose stack on one server. Host
Caddy terminates TLS and proxies to loopback ports. This directory is the
source of truth for the stack; the API deploy workflow rsyncs it to
`/home/ubuntu/repos/saas` on every deploy (`.env` on the server is never
overwritten by the sync). `api.env` is generated fresh on **every** API
deploy from GitHub secrets — see [Application secrets](#application-secrets-apienv)
below; it's excluded from the rsync only because it's written by its own
step, not because it's hand-maintained.

| App       | Image                    | Loopback port | Deployed by                      |
| --------- | ------------------------ | ------------- | -------------------------------- |
| API       | `<user>/grocery-shop-api` | `4000`        | grocery-shop `Deploy API`        |
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
   writes it from GitHub secrets on every run, before `deploy.sh` starts (see
   [Application secrets](#application-secrets-apienv) below). Just make sure
   those secrets are populated in GitHub before the first deploy.
4. Add an SSH keypair for deploys: private key → GitHub secret
   `SSH_PRIVATE_KEY` (in both repos), public key → the deploy user's
   `authorized_keys`.
5. Caddy (host install) — routes:

   ```caddy
   api.ventatech.duckdns.org {
       reverse_proxy 127.0.0.1:4000
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
| secret   | `DOCKERHUB_USERNAME` | Docker Hub username                   |
| secret   | `DEPLOY_PATH`        | optional, default `/home/ubuntu/repos/saas` |

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

| Secret                                 | Required | Notes                                                              |
| --------------------------------------- | -------- | -------------------------------------------------------------------- |
| `MONGODB_USERNAME`                      | yes      |                                                                      |
| `MONGODB_PASSWORD`                      | yes      |                                                                      |
| `MONGODB_HOST`                          | yes      |                                                                      |
| `WHATSAPP_WEBHOOK_VERIFICATION_TOKEN`   | yes      |                                                                      |
| `WHATSAPP_PHONE_NUMBER_ID`              | yes      |                                                                      |
| `WHATSAPP_SYSTEM_TOKEN`                 | yes      |                                                                      |
| `WHATSAPP_FLOW_PRIVATE_KEY`             | yes      | PEM, single line with literal `\n` (not real newlines) — see `whatsappFlowCrypto.ts` |
| `WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE`  | no       | only if the PEM above is encrypted                                 |
| `PUBLIC_BASE_URL`                       | yes      | e.g. `https://api.ventatech.duckdns.org`                           |
| `AUTHENTIK_ISSUER`                      | yes      |                                                                      |
| `AUTHENTIK_CLIENT_ID`                   | yes      |                                                                      |
| `AUTHENTIK_CLIENT_SECRET`               | yes      |                                                                      |
| `AUTHENTIK_BASE_URL`                    | yes      |                                                                      |
| `AUTHENTIK_ADMIN_TOKEN`                 | yes      |                                                                      |
| `AUTHENTIK_RECOVERY_EMAIL_STAGE`        | no       |                                                                      |
| `SESSION_SECRET`                        | yes      |                                                                      |
| `DASHBOARD_URL`                         | yes      |                                                                      |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`          | no       | only if product-image uploads to Drive are used                    |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`    | no       | same format note as the WhatsApp Flow key — see `googleDrive.ts`   |
| `GOOGLE_DRIVE_FOLDER_ID`                | no       |                                                                      |
| `PLATFORM_ADMIN_EMAILS`                 | no       | comma-separated break-glass admin allowlist                        |

`APP_ENV` and `REDIS_HOST_PORT` are hardcoded in the workflow, not secrets
(always `production` / `6379` in this stack). `PORT` and `REDIS_HOST` are
injected by `docker-compose.yml` directly — never set any of these four in a
secret.

**Fail-fast by design:** the workflow step checks every *required* secret
above is non-empty and stops the job — before touching the server at all — if
one is missing. This matters because `deploy.sh`'s automatic rollback
re-deploys the previous image tag but reads the *same* `api.env` on disk; a
broken `api.env` would break the rollback too, not just the new deploy. If
you add a new mandatory var to `src/config.ts`, add it to both the `for key
in ...` check and the `echo` block in the workflow, or a real deploy will
fail past that safety net with an unhelpful app-level crash instead of a
clear `::error::` in the Actions log.

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
