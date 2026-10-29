# Direct EcoCash implementation work

Tracking: [issue #55](https://github.com/mackawara/grocery-shop/issues/55).
Started: 2026-10-29. Status: initial safety foundations; provider contract and live activation remain unverified.

## Current increment

Implemented isolated USD amount validation and outcome policy under
`src/controllers/payments/ecocash/`, with synthetic unit scenarios in
`test/ecocashAmount.test.ts` and `test/ecocashOutcome.test.ts`.
These modules have no database, Redis, environment, network or messaging access.
They are not registered as a provider or invoked by checkout. No direct EcoCash
collection, settings API, worker or dashboard feature is shipped by this increment.

The amount boundary accepts decimal strings, rejects unsupported precision and
currency, and keeps safe integer cents for items, delivery and totals. Zero fees
are valid; zero-priced items, empty carts and non-positive/fractional quantities
are rejected. Existing product prices are stored as cents: a future integration
must explicitly adapt those units and must never reinterpret cents as dollars.
Arithmetic safety is not evidence of provider amount/transaction limits.

The outcome policy uses normalized observations, not assumed provider response
codes. It preserves recorded success, withholds retries for uncertain results,
flags conflicting evidence and blocked lookup, and keeps sandbox results out of
ordinary order settlement. The deadline comparison is inclusive: a first success
observed at or after the saved deadline records paid funds but cancels/reviews the
order. Repeated evidence for a timely recorded success does not expire it.
Review reasons remain sticky until a separate accountable resolution is recorded.
The policy does not implement locks, persistence, expiry scheduling or fulfilment
guards. Its inputs must come from trusted persisted records and verified evidence.

## Provider confirmation and evidence ledger

Authoritative starting points:

- [Online Payments](https://developers.ecocash.co.zw/docs/online-payments)
- [Go Live](https://developers.ecocash.co.zw/docs/go-live)

These pages have not been retrieved or verified in this workspace. The configured
network allowlist does not include `developers.ecocash.co.zw`, and no browser tool
is available in this session. No endpoints, authentication scheme, wire field names,
status mappings or production readiness are inferred from the existing credential
placeholder or another EcoCash API family.

All items below are open launch dependencies. Attach provider confirmation and
sanitized sandbox evidence before closing them.

| Question                                | Evidence needed                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Separate merchants on one platform      | Provider approval process and per-shop onboarding/activation requirements.                                    |
| Production transport and authentication | Issued endpoint, credential types, signing/authentication rules and secret rotation process.                  |
| Merchant/payment identity               | Required merchant, registered number, terminal, location, display and metadata fields.                        |
| Payer/reference formats                 | Accepted phone normalization, reference character/length constraints and lookup identifiers.                  |
| USD amounts                             | Precision, minimum/maximum amounts, fees and representation on charge and lookup.                             |
| Response semantics                      | Charge and lookup examples for paid, pending, definitive failure, authentication failure and not-found.       |
| Debit certainty                         | Which exact observations prove no debit occurred; not-found alone remains unresolved.                         |
| Repeated references                     | Written idempotency/repetition guarantee; uncertain collections must not be replayed meanwhile.               |
| Timing and quotas                       | Prompt lifetime, request timeouts, lookup rate/concurrency limits and historical lookup window.               |
| Rotation and old transactions           | Whether same-merchant replacement credentials can query earlier transactions.                                 |
| Exceptions and support                  | Escalation owner, unresolved/late/duplicate-risk procedure and external resolution evidence.                  |
| Certification                           | Required sandbox cases and any provider-mandated reversal demonstration; product refunds remain out of scope. |

No provider fixtures have been captured yet. Unit inputs in this increment are
synthetic business scenarios, not provider test evidence. A future fixture set
must record source/date/API environment, sanitized charge and lookup request/result
pairs, expected normalized observation and the provider explanation supporting it.
Remove secrets and customer identifiers; preserve relevant response structure and
amount/currency/reference relationships with consistently substituted test values.
Do not commit credentials or raw customer/provider logs.

Until the contract is confirmed: HTTP acceptance is pending; timeout, transport
failure, malformed response, throttling and not-found are unresolved. Authentication
or revoked credentials block lookup rather than prove a payment failed. Only an
explicitly verified, matching paid result can confirm payment. A verified failure
must establish no debit before retry eligibility is granted.

## Repository gaps and implementation choice

The existing `providers/types.ts` models initiation only and has no durable lookup
contract. `payment.controller.ts` interprets unsuccessful initiation as failure and
can mark an attempt failed after result persistence fails. Those behaviors must not
be reused for an uncertain direct collection. `Payment` currently stores a gateway
handle but no immutable merchant/environment/credential version or reconciliation
schedule. `Tenant` has a direct-money credential placeholder, not a verified Online
Payments contract or credential history. Its existing payment secrets are hidden
from ordinary reads but are not encrypted by `tenantSecret.ts`.

Two implementation paths are possible: extend the current initiation-only flow,
or add a direct-payment lifecycle alongside it. Recommend the latter: immutable
tenant-owned merchant versions and attempts let old payments retain their original
provider association through configuration changes. Preserve Paynow/COD behavior
while the direct lifecycle is developed and verified. Integrate shared order
settlement only after durable decisions, authorization and expiry rules exist.

## Next reviewable increments

1. **Contract evidence (Phase A):** retrieve and review the official Online Payments
   contract; capture confirmed examples and classify them conservatively. Define a
   transport boundary with explicit charge versus lookup operations and no automatic
   charge retry. Record unresolved provider semantics as launch blockers.
2. **Merchant configuration (Phase B):** design a tenant-scoped merchant version and
   encrypted credential history, optimistic settings revision and actor audit data.
   Separate configuration completeness, provider approval, controlled pilot evidence,
   owner enablement and service health. Owner-only writes; manager-safe views;
   never return stored secrets. Saving settings cannot call charge. Revocation must
   leave outstanding attempts visible with a blocked-check reason.
3. **Checkout/attempt persistence (Phase C):** bind durable input receipts and consent
   to tenant, checkout owner, order and version. Preserve item subtotal and accepted
   fee. Freeze amount/payer/merchant after a collection may have started. Persist a
   stable provider reference before sending, with an atomic order/attempt reservation
   that also excludes prior paid or unresolved attempts. New attempts require fresh
   customer consent and cannot extend the original persisted payment deadline.
4. **Reconciliation/expiry (Phase D):** implement recoverable worker leases, bounded
   checks, backoff, manual refresh coalescing, explicit review and durable deadlines.
   If interrupted around sending, look up the original reference; never blindly
   replay a charge. A prepared attempt is safe to send only if recovery can prove
   it never crossed the send boundary. Otherwise retain it as uncertain. An atomic
   settlement/expiry decision must resolve races using the saved deadline and local
   observation policy. Continue reconciliation through collection disablement and
   preserve historical merchant association through rotation/revocation.
5. **Customer/shop experience (Phase E):** persist notification obligations with
   settlement; send through the attempt's shop identity, record unsuccessful send
   results, respect WhatsApp windows/templates, and surface follow-up work. Add
   Settings and existing Orders details/filters in `grocery-DASHBOARD`, including
   authorized lookup-only refresh. Enforce direct-payment eligibility in every
   backend fulfilment operation. Review cases never fulfil automatically.
6. **Verification/rollout (Phase F):** run issue #55's full acceptance matrix,
   including real database concurrency/restart tests and dashboard permissions.
   Provider sandbox certification and controlled, separately authorized merchant
   pilots with verified credits are required before ordinary production activation.
   Preserve historical Paynow reconciliation, other methods and compatible rollback.

The proposed 30-minute checkout and five-minute payment windows remain launch
policy proposals. Only new direct checkouts may receive these persisted deadlines;
historical orders and normal COD orders must not be retroactively expired.

Before changing shared models/configuration, present their affected call sites for
review as required by `AGENTS.md`. Expected model impact includes `Tenant`,
`Payment` and `Order`; checkout, delivery, dashboard readers and settlement paths
all depend on these contracts. This increment changes none of those contracts.

## Verification boundaries

The new unit scenarios address amount rules and normalized outcome decisions
(parts of AC-07, AC-10, AC-11, AC-13, AC-14 and AC-17). They do not establish any
acceptance criterion end to end. In particular, tenant isolation, provider parsing,
replay protection, persistence/concurrency, restarts, outbox recovery and production
merchant credit still require implementation and appropriate integration evidence.

Local checks for this increment (Node 24.19.0, installed dependencies):

- `npm test`: 60 tests passed, including 14 new EcoCash cases. The standard test
  command required execution outside the sandbox because `tsx` needs a local IPC
  socket; the existing auth diagnostic subprocess also passes there.
- `npm run build` and `npm run lint`: passed.
- Prettier check of all five added files: passed. Repository-wide
  `npm run format:check` reports existing formatting issues in 15 untouched files.
