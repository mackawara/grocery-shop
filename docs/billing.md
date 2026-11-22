# Vendor billing

Issue [#53](https://github.com/mackawara/grocery-shop/issues/53) bills each
vendor (tenant) a setup fee, a monthly fee and a commission on sales. It is
delivered in buckets, reviewed one at a time:

| #   | Bucket                                                                         | Status    |
| --- | ------------------------------------------------------------------------------ | --------- |
| 1   | Rate card per plan and currency, per-vendor overrides, rate history, audit log | This code |
| 2   | Waivers, promos and credit notes (best single discount)                        | Next      |
| 3   | Commission accrual from `COMPLETED` orders, reversal on refund or cancel       |           |
| 4   | Invoice generation on the 1st (setup, prorated monthly, commission, tax)       |           |
| 5   | Collection via platform Paynow, overdue flag, admin suspend, setup-fee gate    |           |
| 6   | Vendor dashboard billing page                                                  |           |

The code lives in `src/billing/` (facade: `src/billing/index.ts`), enums and
policy constants in `src/constants/billing.ts`, and the admin endpoints in
`src/controllers/billing/adminBilling.controller.ts`.

## Concepts

**Billing month.** A calendar month in `BILLING_TIME_ZONE` (`Africa/Harare`),
written `YYYY-MM`. Rates are keyed by month, not by a timestamp, so a change
can only start on a month boundary.

**Rate card.** Four numbers (decision F1):

| Field                | Type                                 | Meaning                                  |
| -------------------- | ------------------------------------ | ---------------------------------------- |
| `setupFee`           | money                                | One-off, once per vendor account         |
| `monthlyFee`         | money                                | Per calendar month, billed in arrears    |
| `commissionBps`      | integer basis points (`250` = 2.50%) | Share of each completed order's items    |
| `commissionFixedFee` | money                                | Fixed fee per completed order (may be 0) |

Money is always `{ amount, currency }`, with `amount` in integer minor units
(`2500` = $25.00). Rates are priced in `BILLING_CURRENCIES` (USD only for now).

**Plan rate card.** One timeline of versions per plan and currency. Global: the
same for every vendor on the plan.

**Vendor override.** One timeline of versions per vendor and currency,
tenant-owned. Each version lists the fields it overrides from its month on.
A field it leaves out uses the plan rate, so a version that sets no fields
returns the vendor to plan pricing.

**Effective rates.** For a vendor in a month, each field comes from the
override in effect if it sets that field, else from the plan card in effect.

**Version lifecycle.** A version is `scheduled` (starts in a future month),
`in_effect` (applies this month), `superseded` (applied earlier and was
replaced), or `cancelled` (withdrawn before it started). Status is derived and
never stored.

## Rules (decision F2)

1. A new version starts in a **future** month: never the current month
   (mid-month) and never a past one (backdated).
2. A change that makes any field **dearer** in some month needs at least
   `RATE_INCREASE_NOTICE_DAYS` (30) days between now and the start of that
   month. A decrease needs `RATE_DECREASE_NOTICE_DAYS` (0 for now).
3. "Dearer" compares what each affected month costs with the change and without
   it, field by field. For a vendor override that is the vendor's effective
   rate, checked at every month the override spans where the plan price
   changes too. Pricing a field that had no price before (the first card for a
   plan) is not an increase.
4. Nothing is edited or deleted. The only change to a stored version is a
   one-way cancellation, allowed until its month starts. Cancelling a scheduled
   decrease raises the price back, so rule 2 applies to it.
5. Every change needs a reason (3 to 500 characters). The change and its audit
   entry commit in one transaction.

## Isolation and immutability

| Model                       | Scope                  | Notes                                              |
| --------------------------- | ---------------------- | -------------------------------------------------- |
| `BillingPlanRateVersion`    | global                 | Unique live version per plan, currency and month   |
| `BillingVendorRateOverride` | tenant (`tenantScope`) | Unique live version per tenant, currency and month |
| `BillingAuditEntry`         | tenant (`tenantScope`) | Vendor-specific changes                            |
| `PlatformBillingAuditEntry` | global                 | Plan card changes                                  |

The audit log is split in two so tenant-owned entries are always read under a
tenant context and a vendor-facing read can never reach another vendor's.

The `immutableRecord` plugin (`src/billing/models/plugins/immutableRecord.ts`)
rejects every Mongoose update, replace, delete and `bulkWrite` path on these
models, and any save of an existing document. On rate versions it lets exactly
one update through: `{ $set: { cancelled: true, cancellation } }` against
`{ _id, cancelled: false }`, without upsert. Raw driver calls bypass the plugin,
which CLAUDE.md already forbids.

Admin routes run with no tenant context. Per-vendor handlers resolve the path's
tenant id against `Tenant` (404 if unknown), and the billing services then enter
that vendor's context with `runWithTenant` for every tenant-owned read and
write. No `runWithoutTenant` is used.

## Admin API

All routes are behind `csrfGuard` and `platformAdminResolver` (any super admin,
decision G1).

| Method and path                                                     | Purpose                                       |
| ------------------------------------------------------------------- | --------------------------------------------- |
| `GET /admin/billing/plan-rates?plan=&currency=`                     | Full plan rate history with status            |
| `POST /admin/billing/plan-rates`                                    | Schedule a plan rate version                  |
| `POST /admin/billing/plan-rates/:rateId/cancel`                     | Cancel a scheduled version (`{ reason }`)     |
| `GET /admin/billing/audit?limit=&before=`                           | Platform audit log, newest first              |
| `GET /admin/tenants/:id/billing/rates?currency=&period=`            | Effective rates, sources and upcoming changes |
| `GET /admin/tenants/:id/billing/rate-overrides?currency=`           | Vendor override history with status           |
| `POST /admin/tenants/:id/billing/rate-overrides`                    | Schedule a vendor override version            |
| `POST /admin/tenants/:id/billing/rate-overrides/:overrideId/cancel` | Cancel a scheduled override (`{ reason }`)    |
| `GET /admin/tenants/:id/billing/audit?limit=&before=`               | Vendor audit log, newest first                |

Example plan rate body:

```json
{
  "plan": "starter",
  "currency": "USD",
  "effectiveFrom": "2027-01",
  "setupFee": { "amount": 5000, "currency": "USD" },
  "monthlyFee": { "amount": 2000, "currency": "USD" },
  "commissionBps": 300,
  "commissionFixedFee": { "amount": 25, "currency": "USD" },
  "reason": "Launch pricing"
}
```

An override body has `currency`, `effectiveFrom`, `reason` and any subset of
the four rate fields. Unknown keys are refused. A successful schedule or
cancellation returns `{ version, changes }`, where `changes` lists each month
whose rates the edit changes, with before and after values.

| Status | Meaning                                                                        |
| ------ | ------------------------------------------------------------------------------ |
| 400    | Invalid body, query or id                                                      |
| 404    | Unknown tenant or version (`code: not_found`)                                  |
| 409    | `period_taken` (a live version already starts that month), `already_cancelled` |
| 422    | `not_future`, `in_effect`, `insufficient_notice` (with `details`)              |

Audit pages return `nextBefore` when full; pass it as `before` for the next page.

## Design choices

- **Versions keyed by month, append-only.** History is the records themselves.
  "Which rate applied in March" is a pure lookup, and a future change is just a
  version that hasn't started. The alternative, a mutable current rate plus a
  history log, keeps two sources of truth that can disagree.
- **Override versions are full snapshots.** One override version states every
  overridden field, rather than keeping a separate timeline per field. A vendor's
  terms read as one record per change, and returning to plan pricing is explicit.
- **Billing time zone `Africa/Harare`, not UTC.** Invoices follow the vendor's
  calendar month. Changing the constant is enough if UTC is preferred.
- **No lock around timeline edits.** The notice rule composes (see the comment
  in `src/billing/rates.ts`), and the partial unique indexes stop two live
  versions in one month. Transactions keep each change atomic with its audit
  entry, which needs the replica set the app already relies on.

## Open questions

1. **Changing a vendor's plan.** Nothing changes `Tenant.plan` today, so the
   effective-rates view uses the current plan for every month. Changing a plan
   changes all four rates, so it should probably follow rule 1 and rule 2 too.
   Proposed: a tenant-scoped plan assignment timeline, like overrides.
2. **Notice for decreases.** `RATE_DECREASE_NOTICE_DAYS` is 0 until decided.
3. **Setup fee for the first approvals.** B1 invoices the setup fee at approval.
   If no plan card is in effect in the approval month, bucket 4 or 5 must decide
   what to charge. With rule 1, the first cards can only start next month.
4. **Billing time zone.** `Africa/Harare` is assumed.
