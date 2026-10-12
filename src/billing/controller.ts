import type { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import Tenant from '../models/Tenant.ts';
import {
  Currency,
  OrderStatus,
  PaymentStatus,
  TenantPlan,
  TenantStatus,
} from '../constants/models.ts';
import { runWithTenant, runWithoutTenant } from '../context/tenantContext.ts';
import type { PlatformActor } from '../controllers/middleware/platformAdminResolver.ts';
import {
  Audit,
  CreditNote,
  GlobalAudit,
  Invoice,
  PlanRate,
  Policy,
  Promo,
  RateOverride,
  Waiver,
} from './models.ts';
import {
  audit,
  BillingError,
  billingSummary,
  ensureSetup,
  globalAudit,
  lockAccount,
  lockGlobal,
  startTrial,
  suspendTenant,
  transaction,
  createCredit,
} from './service.ts';
import { monthStart, validateEffectiveMonth } from './math.ts';
import Order from '../models/Order.ts';

const amount = z.number().int().safe().nonnegative();
const bps = amount.max(10_000);
const moneySchema = z.object({ amount, currency: z.literal(Currency.USD) }).strict();
const reason = z.string().trim().min(1).max(1000);
const at = z.coerce.date();
const rateFields = {
  currency: z.literal(Currency.USD),
  setupFee: moneySchema,
  monthlyFee: moneySchema,
  commissionBps: bps,
  commissionFixed: moneySchema,
};
const rateSchema = z
  .object({ ...rateFields, plan: z.enum(TenantPlan), effectiveAt: at.optional(), reason })
  .strict();
const overrideSchema = z
  .object({
    currency: z.literal(Currency.USD),
    setupFee: moneySchema.optional(),
    monthlyFee: moneySchema.optional(),
    commissionBps: bps.optional(),
    commissionFixed: moneySchema.optional(),
    effectiveAt: at,
    reason,
  })
  .strict();
const discountFields = {
  charge: z.enum(['setup', 'monthly', 'commission']),
  discountBps: bps,
  startsAt: at,
  endsAt: at,
  reason,
};
const waiverSchema = z
  .object(discountFields)
  .strict()
  .refine((d) => d.endsAt > d.startsAt, 'Discount must have a nonempty date range');
const promoSchema = z
  .object({
    ...discountFields,
    plan: z.enum(TenantPlan).optional(),
    signupFrom: at.optional(),
    signupTo: at.optional(),
  })
  .strict()
  .refine(
    (d) => d.endsAt > d.startsAt && (!d.signupFrom || !d.signupTo || d.signupTo > d.signupFrom),
    'Invalid promo date range',
  );
const creditSchema = z
  .object({
    invoiceId: z.string().refine(isValidObjectId, 'Invalid invoice id'),
    amount: moneySchema,
    key: z.string().uuid(),
    reason,
  })
  .strict();
const policySchema = z
  .object({
    effectiveAt: at,
    taxBps: bps,
    graceDays: amount.max(365),
    dueDays: amount.max(365),
    reason,
  })
  .strict();
const actorOf = (res: Response): string => (res.locals.platformActor as PlatformActor).email;

export const billingHandler =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid input' });
        return;
      }
      if (err instanceof BillingError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (err instanceof Error && 'code' in err && err.code === 11000) {
        res.status(409).json({ error: 'This billing record already exists' });
        return;
      }
      throw err;
    }
  };
export const vendorSummary = billingHandler(async (_req, res) => {
  res.json({ ...(await billingSummary()), actorRole: res.locals.actor.role });
});
export const adminState = billingHandler(async (_req, res) => {
  const rates = await PlanRate.find().sort({ effectiveAt: -1 }).lean();
  const promos = await Promo.find().sort({ createdAt: -1 }).lean();
  const policies = await Policy.find().sort({ effectiveAt: -1 }).lean();
  const auditLog = await GlobalAudit.find().sort({ at: -1 }).limit(100).lean();
  res.json({ rates, promos, policies, auditLog });
});
export const adminRate = billingHandler(async (req, res) => {
  const input = rateSchema.parse(req.body);
  const actor = actorOf(res);
  const now = new Date();
  const result = await transaction(async (session) => {
    await lockGlobal(session);
    const exists = await PlanRate.exists({ plan: input.plan, currency: input.currency }).session(
      session,
    );
    const effectiveAt = exists ? input.effectiveAt : monthStart(now);
    if (!effectiveAt) {
      throw new BillingError('An effective billing month is required', 400);
    }
    if (exists) {
      try {
        validateEffectiveMonth(effectiveAt, now);
      } catch (err) {
        throw new BillingError((err as Error).message, 400);
      }
    }
    const [rate] = await PlanRate.create([{ ...input, effectiveAt, actor }], { session });
    await globalAudit(actor, 'plan_rate', input.reason, rate.toObject(), session);
    return rate;
  });
  res.status(201).json(result);
});
export const adminPromo = billingHandler(async (req, res) => {
  const input = promoSchema.parse(req.body);
  const actor = actorOf(res);
  const result = await transaction(async (session) => {
    await lockGlobal(session);
    const [promo] = await Promo.create([{ ...input, actor }], { session });
    await globalAudit(actor, 'promo', input.reason, promo.toObject(), session);
    return promo;
  });
  res.status(201).json(result);
});
export const adminPolicy = billingHandler(async (req, res) => {
  const input = policySchema.parse(req.body);
  const actor = actorOf(res);
  try {
    validateEffectiveMonth(input.effectiveAt, new Date());
  } catch (err) {
    throw new BillingError((err as Error).message, 400);
  }
  const result = await transaction(async (session) => {
    await lockGlobal(session);
    const [policy] = await Policy.create([{ ...input, actor }], { session });
    await globalAudit(actor, 'policy', input.reason, policy.toObject(), session);
    return policy;
  });
  res.status(201).json(result);
});
// The admin URL is an explicit tenant choice. Log the resolution, then use the
// same tenant-scoped service as the vendor; never bypass the billing models.
export const adminTenantAction = billingHandler(async (req, res) => {
  const id = String(req.params.id);
  const action = String(req.params.action ?? 'summary');
  if (!isValidObjectId(id)) {
    throw new BillingError('Invalid tenant id', 400);
  }
  const tenant = await runWithoutTenant(
    'super admin billing tenant selection',
    `Tenant.findById(${id})`,
    () => Tenant.findById(id).exec(),
  );
  if (!tenant) {
    throw new BillingError('Tenant not found', 404);
  }
  const actor = actorOf(res);
  await runWithTenant(
    id,
    async () => {
      if (action === 'summary') {
        const summary = await billingSummary();
        const overrides = await RateOverride.find().sort({ effectiveAt: -1 }).lean();
        const waivers = await Waiver.find().sort({ createdAt: -1 }).lean();
        const auditLog = await Audit.find().sort({ at: -1 }).limit(100).lean();
        res.json({ ...summary, overrides, waivers, auditLog });
        return;
      }
      if (action === 'enroll') {
        if (![TenantStatus.TRIAL, TenantStatus.ACTIVE].includes(tenant.status)) {
          throw new BillingError('Only approved vendors can be enrolled');
        }
        await transaction(async (session) => {
          await ensureSetup(tenant, actor, new Date(), session);
          if (tenant.status === TenantStatus.ACTIVE) {
            await startTrial(new Date(), session);
          }
        });
        res.json({ message: 'Billing account initialized' });
        return;
      }
      if (action === 'suspend') {
        const input = z.object({ reason }).strict().parse(req.body);
        await suspendTenant(tenant, actor, input.reason);
        res.json({ status: tenant.status });
        return;
      }
      const result = await transaction(async (session) => {
        await lockGlobal(session);
        await lockAccount(session);
        if (action === 'override') {
          const input = overrideSchema.parse(req.body);
          try {
            validateEffectiveMonth(input.effectiveAt, new Date());
          } catch (err) {
            throw new BillingError((err as Error).message, 400);
          }
          const [override] = await RateOverride.create([{ ...input, actor }], { session });
          await audit(actor, 'rate_override', input.reason, override.toObject(), session);
          return override;
        }
        if (action === 'waiver') {
          const input = waiverSchema.parse(req.body);
          if (
            input.charge === 'setup' &&
            (await Invoice.exists({ key: 'setup' }).session(session))
          ) {
            throw new BillingError('Setup is already invoiced; issue a credit note instead');
          }
          const latest = await Invoice.findOne({ kind: 'monthly' })
            .sort({ periodEnd: -1 })
            .session(session);
          if (input.charge !== 'setup' && latest?.periodEnd && input.startsAt < latest.periodEnd) {
            throw new BillingError(
              'Discount starts in an invoiced period; use a credit note or a later start',
            );
          }
          const [waiver] = await Waiver.create([{ ...input, actor }], { session });
          await audit(actor, 'waiver', input.reason, waiver.toObject(), session);
          return waiver;
        }
        if (action === 'credit') {
          const input = creditSchema.parse(req.body);
          const existing = await CreditNote.findOne({ key: input.key }).session(session);
          if (existing) {
            if (
              String(existing.invoiceId) !== input.invoiceId ||
              existing.amount.amount !== input.amount.amount ||
              existing.reason !== input.reason
            ) {
              throw new BillingError('Idempotency key was already used for another credit');
            }
            return existing;
          }
          const invoice = await Invoice.findById(input.invoiceId).session(session);
          if (!invoice) {
            throw new BillingError('Invoice not found', 404);
          }
          const credits = await CreditNote.find({
            invoiceId: invoice._id,
            kind: 'correction',
          }).session(session);
          if (
            input.amount.amount <= 0 ||
            credits.reduce((sum, c) => sum + c.amount.amount, input.amount.amount) >
              invoice.total.amount
          ) {
            throw new BillingError(
              'Credit must be positive and cannot exceed the remaining invoice value',
              400,
            );
          }
          const credit = await createCredit(
            invoice._id,
            input.amount.amount,
            input.key,
            actor,
            input.reason,
            session,
          );
          if (!credit) {
            throw new BillingError('Invoice has already been fully credited');
          }
          await audit(actor, 'credit_note', input.reason, credit.toObject(), session);
          return credit;
        }
        throw new BillingError('Unknown billing action', 404);
      });
      res.status(201).json(result);
    },
    tenant.slug,
  );
});
export const orderBillingStatus = billingHandler(async (req, res) => {
  const id = String(req.params.id);
  if (!isValidObjectId(id)) {
    throw new BillingError('Invalid order id', 400);
  }
  const input = z
    .object({ action: z.enum(['complete', 'cancel', 'refund']) })
    .strict()
    .parse(req.body);
  const updated = await transaction(async (session) => {
    const order = await Order.findById(id).session(session);
    if (!order) {
      throw new BillingError('Order not found', 404);
    }
    if (input.action === 'complete') {
      if (
        order.status === OrderStatus.CANCELLED ||
        order.paymentDetails.status === PaymentStatus.REFUNDED
      ) {
        throw new BillingError('A cancelled/refunded order cannot be completed');
      }
      order.status = OrderStatus.COMPLETED;
    } else if (input.action === 'cancel') {
      order.status = OrderStatus.CANCELLED;
    } else {
      if (!order.completedAt) {
        throw new BillingError('Only a completed order can have a billing refund recorded');
      }
      // This records the vendor's refund; customer money settles at the vendor.
      order.paymentDetails.status = PaymentStatus.REFUNDED;
    }
    await order.save({ session });
    return order;
  });
  res.json({ order: updated });
});
