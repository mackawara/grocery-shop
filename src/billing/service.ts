import mongoose from 'mongoose';
import type { ClientSession, Types } from 'mongoose';
import Tenant from '../models/Tenant.ts';
import type { ITenant } from '../models/Tenant.ts';
import Order from '../models/Order.ts';
import { logger } from '../services/logger.ts';
import type { IOrder } from '../models/Order.ts';
import { OrderItem } from '../models/OrderItem.ts';
import { Currency, OrderStatus, PaymentStatus, TenantStatus } from '../constants/models.ts';
import { requireTenantId, runWithTenant, runWithoutTenant } from '../context/tenantContext.ts';
import {
  Accrual,
  Audit,
  BillingAccount,
  BillingControl,
  CreditAllocation,
  CreditNote,
  GlobalAudit,
  Invoice,
  PlanRate,
  Policy,
  Promo,
  RateOverride,
  Receipt,
  Waiver,
} from './models.ts';
import type { Account } from './models.ts';
import {
  bestDiscount,
  commission,
  DAY,
  discounted,
  money,
  monthStart,
  monthlyCharge,
  nextMonth,
  periodKey,
  ratio,
} from './math.ts';
import type { Discount, Rates } from './math.ts';

export class BillingError extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}
// Mongoose restores document dirty paths on retry/rollback. A raw driver
// withTransaction() would lose changes on documents loaded before the retry.
export const transaction = async <T>(fn: (session: ClientSession) => Promise<T>): Promise<T> =>
  mongoose.connection.transaction(fn);
export const lockGlobal = async (session: ClientSession): Promise<void> => {
  await BillingControl.updateOne(
    { _id: 'billing' },
    { $inc: { revision: 1 } },
    { session, upsert: true },
  );
};
export const lockAccount = async (session: ClientSession): Promise<void> => {
  requireTenantId('billing account lock');
  await BillingAccount.updateOne(
    { currency: Currency.USD },
    { $inc: { revision: 1 } },
    { session },
  );
};
export const audit = async (
  actor: string,
  action: string,
  reason: string,
  details: unknown,
  session: ClientSession,
): Promise<void> => {
  if (!reason.trim()) {
    throw new BillingError('A reason is required', 400);
  }
  await Audit.create([{ actor, action, reason, details }], { session });
};
export const globalAudit = async (
  actor: string,
  action: string,
  reason: string,
  details: unknown,
  session: ClientSession,
): Promise<void> => {
  if (!reason.trim()) {
    throw new BillingError('A reason is required', 400);
  }
  await GlobalAudit.create([{ actor, action, reason, details }], { session });
};
export const getPolicy = async (at: Date, session?: ClientSession) =>
  (await Policy.findOne({ effectiveAt: { $lte: at } })
    .sort({ effectiveAt: -1 })
    .session(session ?? null)
    .lean()) ?? { taxBps: 0, graceDays: 7, dueDays: 7 };
export const resolveRates = async (
  account: Account,
  at: Date,
  session?: ClientSession,
): Promise<Rates> => {
  const base = await PlanRate.findOne({
    plan: account.plan,
    currency: account.currency,
    effectiveAt: { $lte: at },
  })
    .sort({ effectiveAt: -1 })
    .session(session ?? null)
    .lean();
  if (!base) {
    throw new BillingError(`Initialize the ${account.plan} ${account.currency} rate card first`);
  }
  const override = await RateOverride.findOne({
    currency: account.currency,
    effectiveAt: { $lte: at },
  })
    .sort({ effectiveAt: -1 })
    .session(session ?? null)
    .lean();
  return {
    currency: account.currency as Currency,
    setupFee: (override?.setupFee ?? base.setupFee) as Rates['setupFee'],
    monthlyFee: (override?.monthlyFee ?? base.monthlyFee) as Rates['monthlyFee'],
    commissionBps: override?.commissionBps ?? base.commissionBps,
    commissionFixed: (override?.commissionFixed ??
      base.commissionFixed) as Rates['commissionFixed'],
  };
};
export const allDiscounts = async (session?: ClientSession): Promise<Discount[]> => {
  const waivers = await Waiver.find()
    .session(session ?? null)
    .lean();
  const promos = await Promo.find()
    .session(session ?? null)
    .lean();
  return [...waivers, ...promos] as Discount[];
};

// Approval, setup invoice and lifecycle change commit together in the admin
// path. The unique account + invoice keys make retries safe for legacy tenants.
export const ensureSetup = async (
  tenant: ITenant,
  actor: string,
  at: Date,
  session: ClientSession,
): Promise<void> => {
  requireTenantId('setup invoice');
  await lockGlobal(session);
  let account = await BillingAccount.findOne({ currency: Currency.USD }).session(session);
  if (!account) {
    [account] = await BillingAccount.create(
      [
        {
          currency: Currency.USD,
          approvedAt: at,
          plan: tenant.plan,
          signupAt: tenant.get('createdAt') ?? at,
        },
      ],
      { session },
    );
  }
  await lockAccount(session);
  if (await Invoice.exists({ key: 'setup' }).session(session)) {
    return;
  }
  const rates = await resolveRates(account.toObject(), at, session);
  const discountBps = bestDiscount(
    await allDiscounts(session),
    'setup',
    at,
    account.plan,
    account.signupAt,
  );
  const amount = discounted(rates.setupFee.amount, discountBps);
  const policy = await getPolicy(at, session);
  const tax = ratio(amount, policy.taxBps, 10_000);
  await Invoice.create(
    [
      {
        key: 'setup',
        kind: 'setup',
        currency: Currency.USD,
        issuedAt: at,
        dueAt: new Date(at.getTime() + policy.dueDays * DAY),
        graceDays: policy.graceDays,
        lines: [
          {
            kind: 'setup',
            description: 'One-off platform setup fee',
            gross: rates.setupFee,
            amount: money(amount),
            discountBps,
          },
        ],
        subtotal: money(amount),
        taxBps: policy.taxBps,
        tax: money(tax),
        total: money(amount + tax),
      },
    ],
    { session },
  );
  await audit(
    actor,
    'setup_invoice',
    'Vendor approved; one-off setup charge',
    { discountBps, rates },
    session,
  );
};
export const invoiceBalance = async (
  invoice: { _id: Types.ObjectId; total: { amount: number } },
  session?: ClientSession,
): Promise<number> => {
  const receipts = await Receipt.find({ invoiceId: invoice._id })
    .session(session ?? null)
    .lean();
  const credits = await CreditNote.find({ invoiceId: invoice._id })
    .session(session ?? null)
    .lean();
  return Math.max(
    0,
    invoice.total.amount -
      receipts.reduce((sum, r) => sum + r.amount.amount, 0) -
      credits.reduce((sum, c) => sum + c.appliedToSource.amount, 0),
  );
};
export const setupSettled = async (session?: ClientSession): Promise<boolean> => {
  const invoice = await Invoice.findOne({ key: 'setup' })
    .session(session ?? null)
    .lean();
  if (!invoice) {
    return false;
  }
  return (await invoiceBalance(invoice, session)) === 0;
};
export const createCredit = async (
  invoiceId: Types.ObjectId,
  amount: number,
  key: string,
  actor: string,
  reason: string,
  session: ClientSession,
) => {
  const invoice = await Invoice.findById(invoiceId).session(session);
  if (!invoice) {
    throw new BillingError('Invoice not found', 404);
  }
  const existing = await CreditNote.find({ invoiceId, kind: 'correction' }).session(session);
  const available = Math.max(
    0,
    invoice.total.amount - existing.reduce((sum, c) => sum + c.amount.amount, 0),
  );
  const value = Math.min(amount, available);
  if (value <= 0) {
    return null;
  }
  const applied = Math.min(value, await invoiceBalance(invoice, session));
  const [credit] = await CreditNote.create(
    [
      {
        invoiceId,
        amount: money(value),
        appliedToSource: money(applied),
        key,
        actor,
        reason,
        currency: Currency.USD,
      },
    ],
    { session },
  );
  return credit;
};
export const startTrial = async (at: Date, session?: ClientSession): Promise<void> => {
  if (session) {
    await lockAccount(session);
  }
  const account = await BillingAccount.findOne({ currency: Currency.USD }).session(session ?? null);
  if (!account) {
    throw new BillingError('Vendor has no billing account');
  }
  if (!account.liveAt) {
    account.liveAt = at;
    account.trialEndsAt = new Date(at.getTime() + 30 * DAY);
    account.nextPeriod = monthStart(at);
    await account.save({ session });
  }
};

export const itemSubtotal = async (
  orderId: Types.ObjectId,
  session?: ClientSession,
): Promise<number> => {
  const items = await OrderItem.find({ order: orderId })
    .session(session ?? null)
    .lean();
  if (!items.length) {
    throw new BillingError('Completed order has no item snapshots');
  }
  return money(
    items.reduce((sum, item) => {
      if (
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        !Number.isFinite(item.priceAtOrder) ||
        item.priceAtOrder < 0
      ) {
        throw new BillingError('Invalid order item for commission');
      }
      return sum + Math.round(item.priceAtOrder * 100) * item.quantity;
    }, 0),
  ).amount;
};
export const captureOrder = async (order: IOrder, session: ClientSession): Promise<void> => {
  const account = await BillingAccount.findOne({ currency: Currency.USD }).session(session).lean();
  if (!account?.trialEndsAt || !order.completedAt) {
    return;
  }
  await lockAccount(session);
  let accrual = await Accrual.findOne({ orderId: order._id }).session(session);
  const reversed =
    order.status === OrderStatus.CANCELLED ||
    order.paymentDetails.status === PaymentStatus.REFUNDED;
  if (!accrual && order.completedAt >= account.trialEndsAt) {
    const rates = await resolveRates(account, order.completedAt, session);
    const items =
      order.billingItemsMinor ?? (await itemSubtotal(order._id as Types.ObjectId, session));
    [accrual] = await Accrual.create(
      [
        {
          currency: Currency.USD,
          orderId: order._id,
          completedAt: order.completedAt,
          items: money(items),
          gross: money(commission(items, rates)),
          commissionBps: rates.commissionBps,
          commissionFixed: rates.commissionFixed,
        },
      ],
      { session },
    );
  }
  if (accrual && reversed && !accrual.reversedAt) {
    accrual.reversedAt = new Date();
    if (accrual.invoiceId && accrual.billed && accrual.billedTax) {
      await createCredit(
        accrual.invoiceId,
        accrual.billed.amount + accrual.billedTax.amount,
        `reversal:${String(order._id)}`,
        'system',
        `Commission reversed for cancelled/refunded order ${order.orderNumber}`,
        session,
      );
      await audit(
        'system',
        'commission_reversal',
        'Order cancelled or refunded after billing',
        { orderId: order._id },
        session,
      );
    }
    await accrual.save({ session });
  }
};
// Recovery path for a process failure after saving an order. first completion
// time and item subtotal live on the order, so retries preserve the trial/rate.
export const reconcileOrders = async (session: ClientSession): Promise<void> => {
  const orders = await Order.find({
    completedAt: { $exists: true },
    billingNeedsSync: { $ne: false },
  }).session(session);
  for (const order of orders) {
    await syncOrderBilling(order, session);
  }
};
export const syncOrderBilling = async (order: IOrder, session: ClientSession): Promise<void> => {
  await captureOrder(order, session);
  // A concurrent lifecycle change must retain its own reconciliation flag.
  const result = await Order.updateOne(
    { _id: order._id, status: order.status, 'paymentDetails.status': order.paymentDetails.status },
    { $set: { billingNeedsSync: false } },
    { session },
  );
  if (result.matchedCount > 0) {
    order.billingNeedsSync = false;
    order.unmarkModified('billingNeedsSync');
  }
};

export const issueMonth = async (start: Date, now = new Date()): Promise<void> => {
  await transaction(async (session) => {
    await lockGlobal(session);
    await lockAccount(session);
    const end = nextMonth(start);
    if (end > now) {
      throw new BillingError('Cannot issue a month before it ends');
    }
    const account = await BillingAccount.findOne({ currency: Currency.USD }).session(session);
    if (!account?.trialEndsAt || !account.liveAt) {
      return;
    }
    const key = `month:${periodKey(start)}`;
    if (await Invoice.exists({ key }).session(session)) {
      if (account.nextPeriod && account.nextPeriod <= start) {
        account.nextPeriod = end;
        await account.save({ session });
      }
      return;
    }
    await reconcileOrders(session);
    const rates = await resolveRates(account.toObject(), start, session);
    const discounts = await allDiscounts(session);
    const policy = await getPolicy(start, session);
    const monthly = monthlyCharge(
      start,
      end,
      account.trialEndsAt,
      rates,
      discounts,
      account.plan,
      account.signupAt,
    );
    const invoiceId = new mongoose.Types.ObjectId();
    const lines = [
      {
        kind: 'monthly',
        description: `Platform subscription ${periodKey(start)} (prorated)`,
        gross: rates.monthlyFee,
        amount: money(monthly),
        discountBps: 0,
        sourceId: undefined as Types.ObjectId | undefined,
      },
    ];
    let taxable = monthly;
    let tax = ratio(monthly, policy.taxBps, 10_000);
    const accruals = await Accrual.find({
      completedAt: { $lt: end },
      invoiceId: { $exists: false },
      reversedAt: { $exists: false },
    }).session(session);
    for (const accrual of accruals) {
      const discountBps = bestDiscount(
        discounts,
        'commission',
        accrual.completedAt,
        account.plan,
        account.signupAt,
      );
      const amount = discounted(accrual.gross.amount, discountBps);
      const lineTax = ratio(amount, policy.taxBps, 10_000);
      taxable += amount;
      tax += lineTax;
      lines.push({
        kind: 'commission',
        description: `Sales commission for order ${String(accrual.orderId)}`,
        gross: accrual.gross as Rates['setupFee'],
        amount: money(amount),
        discountBps,
        sourceId: accrual._id,
      });
      accrual.invoiceId = invoiceId;
      accrual.billed = money(amount);
      accrual.billedTax = money(lineTax);
      await accrual.save({ session });
    }
    const allocated = await CreditAllocation.find().session(session).distinct('creditId');
    const credits = await CreditNote.find({ _id: { $nin: allocated } }).session(session);
    let creditTotal = 0;
    for (const credit of credits) {
      creditTotal += credit.amount.amount - credit.appliedToSource.amount;
      lines.push({
        kind: 'credit',
        description: credit.reason,
        gross: money(-credit.amount.amount),
        amount: money(-credit.amount.amount),
        discountBps: 0,
        sourceId: credit._id,
      });
      await CreditAllocation.create([{ creditId: credit._id, invoiceId }], { session });
      if (credit.appliedToSource.amount > 0) {
        lines.push({
          kind: 'credit_applied',
          description: 'Credit already applied to the original outstanding invoice',
          gross: credit.appliedToSource as Rates['setupFee'],
          amount: credit.appliedToSource as Rates['setupFee'],
          discountBps: 0,
          sourceId: credit._id,
        });
      }
    }
    const total = taxable + tax - creditTotal;
    await Invoice.create(
      [
        {
          _id: invoiceId,
          key,
          kind: 'monthly',
          currency: Currency.USD,
          periodStart: start,
          periodEnd: end,
          issuedAt: now,
          dueAt: new Date(now.getTime() + policy.dueDays * DAY),
          graceDays: policy.graceDays,
          lines,
          subtotal: money(taxable - creditTotal),
          taxBps: policy.taxBps,
          tax: money(tax),
          total: money(total),
        },
      ],
      { session },
    );
    if (total < 0) {
      // Carry surplus credit forward exactly once, without changing the invoice.
      await CreditNote.create(
        [
          {
            key: `carry:${key}`,
            invoiceId,
            currency: Currency.USD,
            amount: money(-total),
            appliedToSource: money(0),
            kind: 'carry',
            actor: 'system',
            reason: 'Unused invoice credit carried to the next month',
          },
        ],
        { session },
      );
      await audit(
        'system',
        'carry_credit',
        'Unused invoice credit carried to the next month',
        { invoiceId, amount: money(-total) },
        session,
      );
    }
    account.nextPeriod = end;
    await account.save({ session });
    await audit(
      'system',
      'monthly_invoice',
      'Calendar month ended',
      { key, invoiceId, rates },
      session,
    );
  });
};
export const runBilling = async (now = new Date()): Promise<void> => {
  const accounts = await runWithoutTenant(
    'monthly billing worker',
    'BillingAccount.find eligible tenants',
    () =>
      BillingAccount.find({ liveAt: { $exists: true } })
        .select('tenantId nextPeriod')
        .lean()
        .exec(),
  );
  for (const entry of accounts) {
    try {
      await runWithTenant(entry.tenantId, async () => {
        await transaction(async (session) => {
          await lockAccount(session);
          await reconcileOrders(session);
        });
        let start = entry.nextPeriod;
        while (start && nextMonth(start) <= now) {
          await issueMonth(start, now);
          start = nextMonth(start);
        }
      });
    } catch {
      logger.error(
        `[billing] Tenant ${String(entry.tenantId)} failed invoice reconciliation; retrying next tick`,
      );
    }
  }
};
export const billingSummary = async (now = new Date()) => {
  requireTenantId('billing summary');
  const account = await BillingAccount.findOne({ currency: Currency.USD }).lean();
  if (!account) {
    throw new BillingError('Billing account is not initialized', 404);
  }
  const rates = await resolveRates(account, now);
  const discounts = await allDiscounts();
  const invoices = await Invoice.find().sort({ issuedAt: -1 }).lean();
  const history = [];
  let overdue = false;
  for (const invoice of invoices) {
    const balance = await invoiceBalance(invoice);
    const status =
      balance === 0
        ? 'paid'
        : now.getTime() > invoice.dueAt.getTime() + invoice.graceDays * DAY
          ? 'overdue'
          : now > invoice.dueAt
            ? 'grace'
            : 'unpaid';
    overdue ||= status === 'overdue';
    history.push({ ...invoice, balance: money(balance), status });
  }
  const upcomingPlanRates = await PlanRate.find({
    plan: account.plan,
    currency: account.currency,
    effectiveAt: { $gt: now },
  })
    .sort({ effectiveAt: 1 })
    .lean();
  const upcomingOverrides = await RateOverride.find({
    currency: account.currency,
    effectiveAt: { $gt: now },
  })
    .sort({ effectiveAt: 1 })
    .lean();
  const start = monthStart(now);
  const policy = await getPolicy(start);
  const monthly = account.trialEndsAt
    ? monthlyCharge(
        start,
        now,
        account.trialEndsAt,
        rates,
        discounts,
        account.plan,
        account.signupAt,
      )
    : 0;
  const accruals = await Accrual.find({
    invoiceId: { $exists: false },
    reversedAt: { $exists: false },
    completedAt: { $lte: now },
  }).lean();
  let commissions = 0;
  let tax = ratio(monthly, policy.taxBps, 10_000);
  for (const accrual of accruals) {
    const amount = discounted(
      accrual.gross.amount,
      bestDiscount(discounts, 'commission', accrual.completedAt, account.plan, account.signupAt),
    );
    commissions += amount;
    tax += ratio(amount, policy.taxBps, 10_000);
  }
  const allocated = await CreditAllocation.find().distinct('creditId');
  const creditNotes = await CreditNote.find({ _id: { $nin: allocated } }).lean();
  const creditTotal = creditNotes.reduce(
    (sum, c) => sum + c.amount.amount - c.appliedToSource.amount,
    0,
  );
  const tenantId = requireTenantId('billing profile');
  const tenant = await runWithoutTenant(
    'billing tenant profile',
    `Tenant.findById(${tenantId})`,
    () => Tenant.findById(tenantId).select('status').lean().exec(),
  );
  return {
    account,
    rates,
    discounts: discounts.filter(
      (d) =>
        d.endsAt > now &&
        (!d.plan || d.plan === account.plan) &&
        (!d.signupFrom || account.signupAt >= d.signupFrom) &&
        (!d.signupTo || account.signupAt < d.signupTo),
    ),
    upcomingPlanRates,
    upcomingOverrides,
    invoices: history,
    creditNotes,
    overdue,
    tenantStatus: tenant?.status,
    estimate: {
      monthly: money(monthly),
      commission: money(commissions),
      tax: money(tax),
      credits: money(creditTotal),
      total: money(monthly + commissions + tax - creditTotal),
    },
    setupSettled: await setupSettled(),
    trialActive: Boolean(account.trialEndsAt && now < account.trialEndsAt),
  };
};

export const suspendTenant = async (
  tenant: ITenant,
  actor: string,
  reason: string,
): Promise<void> => {
  await transaction(async (session) => {
    await lockAccount(session);
    tenant.status = TenantStatus.SUSPENDED;
    await tenant.save({ session });
    await audit(actor, 'suspend', reason, { tenantId: tenant._id }, session);
  });
};
