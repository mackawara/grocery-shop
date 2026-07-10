# Production deployment

Both apps run as Docker containers in one compose stack on one server. Host
Caddy terminates TLS and proxies to loopback ports. This directory is the
source of truth for the stack; the API deploy workflow rsyncs it to
`/opt/grocery-shop` on every deploy (`.env` and `api.env` on the server are
never overwritten).

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
   sudo mkdir -p /opt/grocery-shop
   sudo chown -R <deploy-user> /opt/grocery-shop
   ```

3. Create `/opt/grocery-shop/api.env` with the production app environment
   (everything `src/config.ts` requires). Notes:
   - `REDIS_HOST` / `PORT` are injected by compose — don't set them here.
   - This file holds secrets: `chmod 600`, never commit it.
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
| variable | `DOCKERHUB_USERNAME` | Docker Hub username                   |
| variable | `DEPLOY_PATH`        | optional, default `/opt/grocery-shop` |

grocery-DASHBOARD additionally needs:

| Kind     | Name                | Value                                    |
| -------- | ------------------- | ---------------------------------------- |
| variable | `VITE_API_BASE_URL` | e.g. `https://api.ventatech.duckdns.org` |

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
