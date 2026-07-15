# Grocery Shop — Backend API

The backend for a multi-tenant WhatsApp commerce SaaS. It integrates with the
**WhatsApp Cloud API** (webhooks, outbound messages, Flows) and serves the
**Vendor Dashboard** ([grocery-DASHBOARD](https://github.com/mackawara/grocery-DASHBOARD)).

- **Tenants = Vendors** — merchants who sell products.
- **Users = customers** — people who buy from a vendor over WhatsApp.

Every vendor is one `Tenant`; all vendor data is strictly scoped to its tenant
(see [Tenant isolation](#tenant-isolation)).

## Tech stack

| Layer         | Technology                                                        |
| ------------- | ----------------------------------------------------------------- |
| Runtime       | Node.js, TypeScript (strict)                                      |
| HTTP          | Express 5 (`helmet`, `cors`, `morgan`)                            |
| Database      | MongoDB via Mongoose                                              |
| Cache/state   | Redis (singleton `RedisService`)                                  |
| Auth (dashboard) | Authentik (OIDC via `openid-client`), `express-session` + Redis store |
| Payments      | Paynow SDK, pluggable per-tenant provider adapters                |
| Messaging     | WhatsApp Cloud API (webhooks, messages, encrypted Flows)          |
| Logging       | Winston, auto-prefixed with the current tenant                    |
| Tooling       | ESLint + Prettier (Husky pre-commit)                              |
| Containers    | Docker + Docker Compose (local dev and production)                |
| Reverse proxy | Caddy (host install on the production server)                     |

## Infrastructure

**Both the API and the Vendor Dashboard run on the same server**, as Docker
containers in a single compose stack ([deploy/docker-compose.yml](deploy/docker-compose.yml)).
A host-installed **Caddy** terminates TLS and reverse-proxies each subdomain to a
loopback-only port:

| Route                  | Proxies to       | Service                 |
| ---------------------- | ---------------- | ----------------------- |
| `api.<domain>`         | `127.0.0.1:5000` | API (this repo)         |
| `dashboard.<domain>`   | `127.0.0.1:8080` | Dashboard (grocery-DASHBOARD) |

Redis runs in the same stack and is reachable only on the compose network —
nothing except Caddy's loopback targets is published on the host.

Because the API and dashboard are co-located behind one Caddy instance on
sibling subdomains, cross-app concerns (CORS, cookies/sessions, adding a new
public route) are just Caddy + compose configuration — no extra infrastructure.

Deploys are per-service GitHub Actions workflows: build → push to Docker Hub →
SSH → health-gated restart with automatic rollback on failure. Full details,
one-time server setup, and the secrets matrix live in
[deploy/README.md](deploy/README.md).

## Getting started (local dev)

```bash
yarn install
cp .env.example .env   # or create .env — src/config.ts fails fast on missing vars
yarn dev               # nodemon + tsx, src/index.ts
```

Other scripts:

- `yarn build` / `yarn start` — compile to `dist/` and run.
- `yarn seed:local` — seed a local tenant.
- `yarn ngrok` — public tunnel for WhatsApp/Paynow callbacks in local dev.
- `yarn lint` / `yarn format:check` — lint and format checks.
- `docker-compose up` — local stack (app built from source + Redis).

## Tenant isolation

The most important system in the codebase — three layers keyed off an
AsyncLocalStorage tenant context:

1. **Tenant context** (`src/context/tenantContext.ts`) — every request that
   touches tenant data runs inside `runWithTenant`; cross-tenant access is only
   possible through the explicit, logged `runWithoutTenant` bypass.
2. **`tenantScope` Mongoose plugin** (`src/models/plugins/tenantScope.ts`) —
   injects and enforces `tenantId` on every query, save, insert, and aggregate.
3. **Tenant-scoped Redis keys** (`src/utils/tenantKey.ts`) — `tenantKey` /
   `globalKey` instead of hand-built keys.

See [CLAUDE.md](CLAUDE.md) for the full rules and conventions.
