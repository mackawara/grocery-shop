# Vendor billing (issue #53)

The backend issues one setup invoice at approval, then one calendar-month invoice
in arrears. Go-live requires a zero setup balance (payment, a full waiver before
approval, or an issued credit note). `TenantStatus.TRIAL` remains onboarding;
WhatsApp ordering requires `ACTIVE`. Billing has a separate, permanent first
go-live timestamp and exactly 30 days of free subscription and commission.

## Configuration and rollout

1. Deploy the API and the companion grocery-DASHBOARD changes together.
2. In `/console/billing`, initialize all four plan rate cards in USD. Prices are
   deliberately not invented or defaulted to zero. Approval fails with an
   actionable conflict until the vendor's plan has a rate card.
3. Configure `BILLING_PAYNOW_INTEGRATION_ID`, `BILLING_PAYNOW_INTEGRATION_KEY`, and
   `BILLING_PAYNOW_AUTH_EMAIL` using the **platform's own USD Paynow integration**.
   The deploy workflow writes these secrets into `api.env`. Tenant credentials
   continue to collect customers' money for the vendor. Billing Pay returns 503
   until all three platform values are configured.
4. Existing approved/active vendors can be explicitly enrolled through the
   console's Initialize billing action. Existing active vendors start their
   billing trial at enrollment; historical sales are not retroactively charged.
   Each account still receives exactly one setup invoice. Review a credit/waiver
   policy for existing vendors before enrollment.
5. Verify callbacks, invoice generation and transaction retries on a staging
   MongoDB **replica set**, and verify real platform Paynow collection before
   deploying to paying vendors. Confirm VAT registration and ZIMRA fiscalisation
   with the accountant, as called out in the issue.

Tax defaults to 0%. Invoices default to seven days until due, followed by seven
grace days. Admin policy revisions can change tax, due days and grace days from
a future billing month. An overdue flag is calculated from outstanding ledger
balances and the invoice's saved terms. Only an explicit, reasoned super-admin
action suspends a vendor.
Suspended vendors retain billing-only read/payment access. A super admin can
reactivate them without restarting the trial or charging setup again.

## Rates, discounts and corrections

Plan rate cards and tenant overrides are append-only revisions. Every money
value carries its currency and integer minor units; percentages use basis
points (100 = 1%). APIs currently accept USD only. Overrides are complete
replacement snapshots: blank fields inherit the plan from their effective month.

Initial plan cards take effect at the start of the current month. Subsequent
revisions must start at 00:00 UTC on the first of a future month, with at least
30 days' notice, including decreases. Vendors see upcoming changes on their
billing page and in dashboard notices. Promo rules initially support plan and
signup date range; dates are inclusive start, exclusive end. A vendor waiver
and a platform promo never stack: the highest applicable percentage wins.

Setup is discounted at approval; commission discounts use first completion
time; monthly discounts are prorated over their exact date ranges. The first
paid month is prorated over the time after the 30-day trial, using the actual
calendar month's duration. Discounts and tax round to cents, half up. Tax is
calculated per positive subscription/commission line so commission reversals
can credit exactly the tax originally billed. Delivery is excluded: commission
uses the snapshotted order-item subtotal, not `Order.totalAmount`.

Issued invoices are immutable. Credit notes are immutable too. A credit first
settles any unpaid balance on its source invoice; any remainder offsets the
next invoice. The next invoice displays the full credit and an offset for the
portion already used, preventing duplicate credit. Negative invoice totals
carry unused credit forward. Late excess platform payments create credit;
refunding that payment reverses the excess credit with a future adjustment.

## Isolation, recovery and APIs

All tenant billing models use `tenantScope`. Admin selection and worker account
enumeration use explicit logged `runWithoutTenant`, then enter `runWithTenant`
before ledger access. Plan cards, platform promos, policy history, their audit,
and the global serialization control are genuinely global.

Setup approval, activation/trial, monthly invoice generation, and verified
settlement use transactions. The worker initializes unique indexes before
running. Global and account revisions serialize invoice generation against
promo edits, vendor changes, completion and payment processing. Tenant-keyed
unique setup/month invoice, order accrual, credit allocation and receipt keys
prevent retry duplicates. A failed vendor does not stop other vendors' billing.

Order saves capture the first completion time and item subtotal. Lifecycle
changes update commission within the transaction; a reconciliation flag recovers
a process failure after a nontransactional save. The hourly worker reconciles
missed events and catches up all ended months at startup and thereafter. Paid
invoices are never rewritten: receipts and refund receipts determine balances.
Callbacks require the platform signature plus exact reference, poll identity
when stored, and payment amount. Duplicate callbacks are harmless. An ambiguous
gateway transport failure keeps the attempt pending, preventing duplicate pushes;
investigate such attempts with Paynow before retrying them.

| Endpoint                                                                  | Access / purpose                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `GET /dashboard/billing`                                                  | Owner/manager: rates, discounts, estimates, notices, invoices |
| `POST /dashboard/billing/invoices/:id/pay`                                | Owner: initiate platform EcoCash/O'mari payment               |
| `POST /dashboard/orders/:id/billing-status`                               | Owner/manager: complete, cancel, record vendor refund         |
| `GET /admin/billing`                                                      | Super admin: global history and audit                         |
| `POST /admin/billing/{rates,promos,policy}`                               | Super admin: append reasoned global revision                  |
| `GET /admin/tenants/:id/billing`                                          | Super admin: scoped vendor billing and audit                  |
| `POST /admin/tenants/:id/billing/{override,waiver,credit,enroll,suspend}` | Super admin: scoped action                                    |
| `POST /billing/paynow/webhook/:tenantId`                                  | Raw signed platform Paynow callback; no browser session       |

Reasons are mandatory and every admin billing change and generated credit has
an append-only audit entry. There are no invoice-edit, audit-edit or automatic
suspension endpoints. The completion endpoint preserves COD's pending customer
payment state; recording a refund describes a refund the vendor has already
handled and does not move customer money.

## Verification

`npm test`, `npm run build`, and `npm run lint` cover the math, eligibility,
immutable ledger middleware, tenant isolation, invoice assembly, idempotency,
setup settlement, signature checks and platform payment/refund handling.
The ledger tests stub the MongoDB driver boundary while running real Mongoose
validation and middleware; they do not prove live transaction behavior or index
enforcement. Browser checks exercise the vendor payment form and admin views
against representative API fixtures. Live MongoDB/Paynow checks are required
for rollout; the development environment blocks MongoDB binary downloads.
