import mongoose, { Schema } from 'mongoose';
import type { InferSchemaType } from 'mongoose';
import { Currency, TenantPlan } from '../constants/models.ts';
import { tenantScope } from '../models/plugins/tenantScope.ts';

const integer = { type: Number, required: true, validate: Number.isSafeInteger };
const nonnegative = { ...integer, min: 0 };
const bps = { ...nonnegative, max: 10_000 };
const currency = { type: String, enum: Object.values(Currency), required: true };
const MoneySchema = new Schema({ amount: integer, currency }, { _id: false });
const tenantId = { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true };
const reason = { type: String, required: true, trim: true, maxlength: 1000 };
const actor = { type: String, required: true };
const effectiveAt = { type: Date, required: true };

// Ledger documents are append-only, including issued invoice snapshots. A
// payment receipt is a separate record: paying never rewrites an invoice.
export const appendOnly = (schema: Schema): void => {
  schema.pre('deleteOne', { document: true, query: false }, function () {
    throw new Error('Billing record is immutable');
  });
  schema.pre('save', function () {
    if (!this.isNew) {
      throw new Error('Billing record is immutable');
    }
  });
  for (const op of [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ] as const) {
    schema.pre(op, function () {
      throw new Error('Billing record is immutable');
    });
  }
  schema.pre('bulkWrite', function () {
    throw new Error('Billing record is immutable');
  });
  schema.pre('aggregate', function () {
    if (this.pipeline().some((stage) => '$out' in stage || '$merge' in stage)) {
      throw new Error('Billing record is immutable');
    }
  });
};
const rateFields = {
  currency,
  setupFee: { type: MoneySchema, required: true },
  monthlyFee: { type: MoneySchema, required: true },
  commissionBps: bps,
  commissionFixed: { type: MoneySchema, required: true },
  effectiveAt,
  actor,
  reason,
};
const RateSchema = new Schema(
  { plan: { type: String, enum: Object.values(TenantPlan), required: true }, ...rateFields },
  { timestamps: { createdAt: true, updatedAt: false } },
);
RateSchema.index({ plan: 1, currency: 1, effectiveAt: 1 }, { unique: true });
RateSchema.plugin(appendOnly);
export const PlanRate = mongoose.model('BillingPlanRate', RateSchema);

const OverrideSchema = new Schema(
  {
    tenantId,
    currency,
    effectiveAt,
    actor,
    reason,
    setupFee: MoneySchema,
    monthlyFee: MoneySchema,
    commissionBps: { ...bps, required: false },
    commissionFixed: MoneySchema,
    // Each row is a complete replacement of the override, with absent fields
    // inheriting the plan. Empty overrides are how an admin returns to the plan.
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
OverrideSchema.index({ tenantId: 1, currency: 1, effectiveAt: 1 }, { unique: true });
OverrideSchema.plugin(tenantScope);
OverrideSchema.plugin(appendOnly);
export const RateOverride = mongoose.model('BillingRateOverride', OverrideSchema);

const discountFields = {
  charge: { type: String, enum: ['setup', 'monthly', 'commission'], required: true },
  discountBps: bps,
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  actor,
  reason,
};
const WaiverSchema = new Schema(
  { tenantId, ...discountFields },
  { timestamps: { createdAt: true, updatedAt: false } },
);
WaiverSchema.index({ tenantId: 1, startsAt: 1 });
WaiverSchema.plugin(tenantScope);
WaiverSchema.plugin(appendOnly);
export const Waiver = mongoose.model('BillingWaiver', WaiverSchema);
const PromoSchema = new Schema(
  {
    ...discountFields,
    plan: { type: String, enum: Object.values(TenantPlan) },
    signupFrom: Date,
    signupTo: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
PromoSchema.plugin(appendOnly);
export const Promo = mongoose.model('BillingPromo', PromoSchema);

const AccountSchema = new Schema(
  {
    tenantId,
    currency,
    approvedAt: { type: Date, required: true },
    plan: { type: String, enum: Object.values(TenantPlan), required: true },
    signupAt: { type: Date, required: true },
    liveAt: Date,
    trialEndsAt: Date,
    nextPeriod: Date,
    revision: { type: Number, default: 0 },
  },
  { timestamps: true },
);
AccountSchema.index({ tenantId: 1, currency: 1 }, { unique: true });
AccountSchema.plugin(tenantScope);
export const BillingAccount = mongoose.model('BillingAccount', AccountSchema);
export type Account = InferSchemaType<typeof AccountSchema>;

const AccrualSchema = new Schema(
  {
    tenantId,
    currency,
    orderId: { type: Schema.Types.ObjectId, required: true },
    completedAt: { type: Date, required: true },
    items: { type: MoneySchema, required: true },
    gross: { type: MoneySchema, required: true },
    commissionBps: bps,
    commissionFixed: { type: MoneySchema, required: true },
    reversedAt: Date,
    invoiceId: Schema.Types.ObjectId,
    billed: MoneySchema,
    billedTax: MoneySchema,
  },
  { timestamps: true },
);
AccrualSchema.index({ tenantId: 1, orderId: 1 }, { unique: true });
AccrualSchema.index({ tenantId: 1, completedAt: 1 });
AccrualSchema.plugin(tenantScope);
export const Accrual = mongoose.model('BillingAccrual', AccrualSchema);

const LineSchema = new Schema(
  {
    kind: { type: String, required: true },
    description: { type: String, required: true },
    amount: { type: MoneySchema, required: true },
    discountBps: bps,
    gross: { type: MoneySchema, required: true },
    sourceId: Schema.Types.ObjectId,
  },
  { _id: false },
);
const InvoiceSchema = new Schema(
  {
    tenantId,
    currency,
    key: { type: String, required: true },
    kind: { type: String, enum: ['setup', 'monthly'], required: true },
    periodStart: Date,
    periodEnd: Date,
    issuedAt: { type: Date, required: true },
    dueAt: { type: Date, required: true },
    graceDays: nonnegative,
    lines: { type: [LineSchema], required: true },
    subtotal: { type: MoneySchema, required: true },
    taxBps: bps,
    tax: { type: MoneySchema, required: true },
    total: { type: MoneySchema, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
InvoiceSchema.index({ tenantId: 1, key: 1 }, { unique: true });
InvoiceSchema.plugin(tenantScope);
InvoiceSchema.plugin(appendOnly);
export const Invoice = mongoose.model('BillingInvoice', InvoiceSchema);

const CreditSchema = new Schema(
  {
    tenantId,
    currency,
    key: { type: String, required: true },
    invoiceId: { type: Schema.Types.ObjectId, required: true },
    amount: { type: MoneySchema, required: true },
    appliedToSource: { type: MoneySchema, required: true },
    kind: {
      type: String,
      enum: ['correction', 'overpayment', 'carry', 'adjustment'],
      default: 'correction',
      required: true,
    },
    actor,
    reason,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
CreditSchema.index({ tenantId: 1, key: 1 }, { unique: true });
CreditSchema.plugin(tenantScope);
CreditSchema.plugin(appendOnly);
export const CreditNote = mongoose.model('BillingCreditNote', CreditSchema);
// Allocation is separate from the credit note, keeping the note immutable too.
const AllocationSchema = new Schema({
  tenantId,
  creditId: { type: Schema.Types.ObjectId, required: true },
  invoiceId: { type: Schema.Types.ObjectId, required: true },
});
AllocationSchema.index({ tenantId: 1, creditId: 1 }, { unique: true });
AllocationSchema.plugin(tenantScope);
AllocationSchema.plugin(appendOnly);
export const CreditAllocation = mongoose.model('BillingCreditAllocation', AllocationSchema);

const AttemptSchema = new Schema(
  {
    tenantId,
    invoiceId: { type: Schema.Types.ObjectId, required: true },
    reference: { type: String, required: true },
    amount: { type: MoneySchema, required: true },
    status: {
      type: String,
      enum: ['initiating', 'pending', 'failed', 'paid', 'refunded'],
      default: 'initiating',
      required: true,
    },
    pollUrl: { type: String, select: false },
    instructions: String,
  },
  { timestamps: true },
);
AttemptSchema.index({ tenantId: 1, reference: 1 }, { unique: true });
// One live attempt per invoice, even across workers and double clicks.
AttemptSchema.index(
  { tenantId: 1, invoiceId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['initiating', 'pending'] } } },
);
AttemptSchema.plugin(tenantScope);
export const PaymentAttempt = mongoose.model('BillingPaymentAttempt', AttemptSchema);
const ReceiptSchema = new Schema({
  tenantId,
  invoiceId: { type: Schema.Types.ObjectId, required: true },
  attemptId: { type: Schema.Types.ObjectId, required: true },
  key: { type: String, required: true },
  amount: { type: MoneySchema, required: true },
  paidAt: { type: Date, required: true },
});
ReceiptSchema.index({ tenantId: 1, key: 1 }, { unique: true });
ReceiptSchema.plugin(tenantScope);
ReceiptSchema.plugin(appendOnly);
export const Receipt = mongoose.model('BillingReceipt', ReceiptSchema);

const AuditSchema = new Schema({
  tenantId,
  actor,
  action: { type: String, required: true },
  reason,
  details: { type: Schema.Types.Mixed, required: true },
  at: { type: Date, default: Date.now, required: true },
});
AuditSchema.index({ tenantId: 1, at: 1 });
AuditSchema.plugin(tenantScope);
AuditSchema.plugin(appendOnly);
export const Audit = mongoose.model('BillingAudit', AuditSchema);
// Global changes have a global append-only audit, never a fabricated tenant id.
const GlobalAuditSchema = new Schema({
  actor,
  action: { type: String, required: true },
  reason,
  details: { type: Schema.Types.Mixed, required: true },
  at: { type: Date, default: Date.now, required: true },
});
GlobalAuditSchema.plugin(appendOnly);
export const GlobalAudit = mongoose.model('BillingGlobalAudit', GlobalAuditSchema);
const PolicySchema = new Schema({
  effectiveAt,
  taxBps: bps,
  graceDays: nonnegative,
  dueDays: nonnegative,
  actor,
  reason,
});
PolicySchema.index({ effectiveAt: 1 }, { unique: true });
PolicySchema.plugin(appendOnly);
export const Policy = mongoose.model('BillingPolicy', PolicySchema);
// Serializes global promo/rate mutations with invoice snapshots in transactions.
const ControlSchema = new Schema({ _id: String, revision: { type: Number, default: 0 } });
export const BillingControl = mongoose.model('BillingControl', ControlSchema);
export const billingModels = [
  PlanRate,
  RateOverride,
  Waiver,
  Promo,
  BillingAccount,
  Accrual,
  Invoice,
  CreditNote,
  CreditAllocation,
  PaymentAttempt,
  Receipt,
  Audit,
  GlobalAudit,
  Policy,
  BillingControl,
];
