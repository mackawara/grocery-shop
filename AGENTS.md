# Project: Grocery Shop — Backend API

The backend for a **multi-tenant SaaS**. It is the API that (1) integrates with the
**WhatsApp Cloud API** (webhooks, outbound messages, Flows) and (2) serves the
**Vendor Dashboard** (`grocery-DASHBOARD`).

- **Tenants = Vendors** — merchants who sell products.
- **Users = customers** — people who buy from a vendor over WhatsApp.

Every vendor is one `Tenant`. All vendor data (users, orders, payments, messages,
addresses) is owned by exactly one tenant and must never cross tenant boundaries.

---

## Prime directives (read before writing any code)

These two outrank every other rule in this file. If a task seems to require breaking
one, **stop and ask** — do not work around it silently.

1. **Tenant isolation is mandatory.** Every database read/write and every WhatsApp
   operation must be scoped to a single tenant. Cross-tenant access is only ever
   allowed through an explicit, logged opt-out (`runWithoutTenant`).
2. **Security is paramount.** Treat all webhook input as untrusted, verify every
   signature, never log secrets, never weaken signature/credential checks to "make
   it work."

When several implementation options exist, surface them and recommend the one that
best preserves tenant isolation — don't just pick one.

---

## Stack

- **Runtime:** Node.js, **TypeScript strict**, **CommonJS** (`module: commonjs`, target es2017).
- **HTTP:** Express 5 (`helmet`, `cors`, `morgan`).
- **DB:** MongoDB via **Mongoose** (`mongodb+srv`).
- **Cache/state:** Redis (`redis` v5), singleton `RedisService`.
- **Payments:** Paynow SDK (per-tenant credentials), pluggable provider adapters.
- **Logging:** Winston (`logger`), auto-prefixed with the current tenant label.
- **Lint/format:** ESLint + Prettier (Husky pre-commit). Run `yarn lint` / `yarn format:check`.

### Scripts

- `yarn dev` — nodemon + ts-node (`src/index.ts`).
- `yarn build` — `tsc` → `dist/`. `yarn start` — `node dist/index.js`.
- `yarn seed:local` — seed a local tenant (`src/scripts/seedLocalTenant.ts`).
- `yarn ngrok` — public tunnel for WhatsApp/Paynow callbacks in local dev.

Boot order (`src/index.ts`): connect Redis (with timeout) → start HTTP server → connect Mongo.

---

## Infrastructure & deployment

**The API and the Vendor Dashboard run on the same server**, as Docker containers
in one compose stack (`deploy/docker-compose.yml`). A host-installed **Caddy**
terminates TLS and reverse-proxies each subdomain to a loopback-only port:

- `api.<domain>` → `127.0.0.1:5000` (this API)
- `dashboard.<domain>` → `127.0.0.1:8080` (grocery-DASHBOARD)

Redis lives in the same stack, reachable only on the compose network. Deploys are
per-service GitHub Actions workflows (build → Docker Hub → SSH → health-gated
restart with automatic rollback); `api.env` is regenerated from GitHub secrets on
every API deploy. Full details in `deploy/README.md`.

Implications when developing:

- The API and dashboard are co-located on sibling subdomains behind one Caddy —
  CORS, cookie/session settings, and redirect URLs can assume this topology.
- A new publicly reachable endpoint or hostname only needs a Caddy route +
  compose port mapping — no new infrastructure.
- Containers publish **loopback-only** ports; never publish a port on `0.0.0.0`
  in the production compose file — Caddy is the sole public entry point.
- A new required env var must also be added to the deploy workflow's `api.env`
  generation (see `deploy/README.md` → Application secrets), or deploys fail.

---

## Tenant isolation — how it works

This is the most important system in the codebase. Three layers, all keyed off an
**AsyncLocalStorage** tenant context.

### 1. The tenant context (`src/context/tenantContext.ts`)

A request's tenant lives in async-local storage, not in a passed-around argument.

- `runWithTenant(tenantId, fn, slug?)` — run `fn` with a tenant in scope. **Everything
  that touches tenant data must run inside this.**
- `runWithoutTenant(reason, queryDescription, fn)` — the **only** sanctioned way to
  cross tenants (e.g. resolving which tenant a webhook belongs to). It logs a `BYPASS`
  warning every time. Use it sparingly and never to paper over a missing context.
- `requireTenantId(op)` — throws `TenantContextMissingError` if there's no context.
- `getTenantId()` / `getTenantSlug()` — read-only accessors (return `undefined` under bypass).

Logs are auto-prefixed with the tenant slug/id via `setTenantLabelProvider`, so you
generally don't need to add the tenant to log messages yourself.

### 2. The `tenantScope` Mongoose plugin (`src/models/plugins/tenantScope.ts`)

Apply this plugin to **every tenant-owned model**. The model must declare a
`tenantId` ObjectId path (the plugin asserts this at boot). It then, on every op:

- **Queries** (`find`, `findOne`, `update*`, `delete*`, `count`, `distinct`, …): injects
  `tenantId` into the filter. Update/replace payloads are sanitized so a caller can't
  smuggle a different `tenantId` (mismatch → throw; `$unset tenantId` → throw).
- **`save` / `validate`:** injects `tenantId` on new docs; rejects saving/modifying a
  doc whose `tenantId` doesn't match the context.
- **`insertMany`:** stamps/validates `tenantId` on each doc.
- **`aggregate`:** prepends a `$match` on `tenantId`, and **rejects** pipelines with
  cross-collection stages (`$lookup`, `$graphLookup`, `$unionWith`, `$merge`, `$out`)
  because the plugin can't scope the joined/target collection.
- **Refuses outright** (these can't be safely scoped): `bulkWrite`,
  `estimatedDocumentCount`. Use scoped `updateMany`/`insertMany` / `countDocuments`.

All of these are skipped only under `runWithoutTenant` (bypass).

> When you add a new tenant-owned model: declare `tenantId` (indexed), `plugin(tenantScope)`,
> and add a compound `{ tenantId, <natural key> }` unique index (see `User.ts`).

### 3. Tenant-scoped Redis (`src/utils/tenantKey.ts`)

- `tenantKey(rawKey)` → `t:<tenantId>:<rawKey>` — requires a tenant context.
- `globalKey(rawKey)` → `global:<rawKey>` — for genuinely cross-tenant data only.

**Never build a Redis key by hand for tenant data** — always go through `tenantKey`.

### Checklist for any tenant-touching code

- [ ] Runs inside `runWithTenant` (or an explicit, justified `runWithoutTenant`).
- [ ] DB access goes through a `tenantScope`-plugged model (no raw driver calls).
- [ ] Redis keys built with `tenantKey` / `globalKey`.
- [ ] No cross-tenant `$lookup`/`bulkWrite` without an explicit, reviewed bypass.

---

## WhatsApp pipeline

Routes: `src/routes/whatsapp.routes.ts`.

- `GET /whatsapp/messages` — webhook verification (`verifyWebhookToken`, checks
  `WHATSAPP_WEBHOOK_VERIFICATION_TOKEN`).
- `POST /whatsapp/messages` — **`whatsappTenantResolver` → `incomingMessagesHandler`.**
  The resolver reads `phone_number_id` from the payload, looks up the `Tenant`
  (under `runWithoutTenant`), **fails closed** on tenant status (only `ACTIVE`/`TRIAL`
  allowed), then wraps the handler in `runWithTenant`. Always `200`-acks dropped
  messages so WhatsApp doesn't retry forever; `500` only on transient lookup failure.
- `POST /whatsapp/flows` — encrypted WhatsApp Flows endpoint (`flowsHandler`,
  crypto in `src/utils/whatsappFlowCrypto.ts`, `WHATSAPP_FLOW_PRIVATE_KEY`).

**Rule:** any handler that reacts to an inbound message and reads/writes data must run
inside the tenant context the resolver established. Don't add a WhatsApp route that
skips `whatsappTenantResolver` unless it genuinely has no tenant data (and say why).

---

## Payments

- Routes: `src/routes/payment.routes.ts`. Paynow `resultUrl` callback is
  `POST /payments/paynow/webhook/:slug` — **raw text body** (the SDK re-hashes exact
  bytes; do not JSON-parse it). The `:slug` identifies the tenant.
- Per-tenant credentials live on `Tenant.paymentCredentials` with **`select:false`** —
  they never ride along on incidental tenant reads; the payment layer queries them
  explicitly. **Never remove `select:false` or log these.**
- Provider adapters: `src/controllers/payments/providers/` with a registry
  (`registry.ts`). Method→gateway routing per tenant (`paymentRouting`, falling back to
  `DEFAULT_PAYMENT_ROUTING`). Cash-on-delivery has no adapter (settled via orchestrator).

---

## Project structure

```
src/
  config.ts          # env validation (fails fast on missing vars) + CONFIG
  index.ts           # boot sequence
  server.ts          # express app + route mounting
  context/           # tenantContext (AsyncLocalStorage)
  models/            # Mongoose models + plugins/tenantScope
  models/plugins/    # tenantScope (the isolation plugin)
  controllers/
    middleware/      # whatsappTenantResolver
    whatsapp/        # incoming/outgoing messages, flows, order handler
    payments/        # controller, providers/, gateways/
    delivery/        # delivery address + flow
    redis/           # redis controller
  routes/            # whatsapp.routes, payment.routes
  services/          # database, redis (singleton), logger
  utils/             # tenantKey, whatsapp*, geo, sanitize
  constants/         # enums (models, orderFlow, payments, whatsapp)
  scripts/           # seedLocalTenant
  types/             # shared TS types + paynow.d.ts
```

---

## Conventions

- **TypeScript strict**, CommonJS imports. Prefer `import type` for type-only imports.
- **Always use curly braces `{}`** for `if`/loops, even single-line bodies.
- **Logging:** use the Winston `logger` with a `[TAG]` prefix (e.g. `[whatsappTenantResolver]`);
  the tenant label is added automatically. **Never log secrets, tokens, or payment credentials.**
- **Config:** all env access goes through `CONFIG` (`src/config.ts`), which validates
  required vars at boot. Add new required vars to `mandatoryEnvironmentConstants`.
- **Enums** live in `src/constants/` — reuse them; don't hardcode status/method strings.
- **Webhook handlers** ack appropriately: `200` to stop provider retries on permanent
  drops, non-2xx only when you genuinely want a retry.

---

## Working rules

- **Agile, not waterfall.** For multi-faceted tasks, break the work into buckets and
  review together after each rather than doing it all at once.
- **Grill on options.** When several reasonable approaches exist, present them and
  recommend the one best for the multi-tenant architecture — don't silently choose.
- **Ask when unsure** which direction to take.
- **Ask before editing a widely-imported file** (tenant context, `tenantScope`, models,
  config). Show the blast radius first.
- **When debugging, change only what fixes the bug** — no drive-by refactors.
- If a request conflicts with a Prime Directive above, surface the conflict before acting.
