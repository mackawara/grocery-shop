import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import type { ClientSession } from 'mongoose';
import {
  Accrual,
  Audit,
  BillingAccount,
  BillingControl,
  CreditAllocation,
  CreditNote,
  Invoice,
  PaymentAttempt,
  PlanRate,
  Policy,
  Promo,
  RateOverride,
  Receipt,
  Waiver,
} from '../src/billing/models.ts';
import { Currency, OrderStatus, PaymentStatus, TenantPlan } from '../src/constants/models.ts';
import { runWithTenant } from '../src/context/tenantContext.ts';
import {
  captureOrder,
  createCredit,
  ensureSetup,
  issueMonth,
  setupSettled,
  startTrial,
  transaction,
} from '../src/billing/service.ts';
import { money } from '../src/billing/math.ts';
import Order from '../src/models/Order.ts';
import Tenant, { missingActivationFields } from '../src/models/Tenant.ts';
import { settleVerifiedPayment } from '../src/billing/settlement.ts';
import type { Model } from 'mongoose';

// Stub the driver boundary, rather than Mongoose models. Actual schema
// validation, tenantScope and immutable-document middleware still execute.
// Live Mongo transaction/index tests are separate and require a replica set.
const tenantId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const at = (value: string) => new Date(value);
// A class instance preserves session identity through Mongoose option cloning,
// as a real ClientSession does. Plain objects would clone the transaction map.
class FakeSession {
  transaction = {};
  inTransaction() {
    return true;
  }
  async withTransaction(fn: (session: ClientSession) => Promise<unknown>) {
    return fn(this as unknown as ClientSession);
  }
  async endSession() {}
}
const session = new FakeSession() as unknown as ClientSession;
const collection = (model: Model<unknown>) => model.collection;
const readMany = (model: Model<unknown>, rows: unknown[]) =>
  mock.method(collection(model), 'find', async () => ({ toArray: async () => rows }));
const readOne = (model: Model<unknown>, row: unknown) =>
  mock.method(collection(model), 'findOne', async () => row);
const account = {
  _id: new mongoose.Types.ObjectId(),
  tenantId,
  currency: Currency.USD,
  plan: TenantPlan.FREE,
  approvedAt: at('2026-09-01'),
  signupAt: at('2026-08-01'),
  liveAt: at('2026-09-15'),
  trialEndsAt: at('2026-10-15'),
  nextPeriod: at('2026-10-01'),
  revision: 0,
};
const rate = {
  _id: new mongoose.Types.ObjectId(),
  plan: TenantPlan.FREE,
  currency: Currency.USD,
  setupFee: money(5000),
  monthlyFee: money(3100),
  commissionBps: 250,
  commissionFixed: money(30),
  effectiveAt: at('2026-09-01'),
  actor: 'admin',
  reason: 'Initial rates',
};
const locks = () => {
  mock.method(BillingAccount.collection, 'updateOne', async () => ({
    matchedCount: 1,
    modifiedCount: 1,
  }));
  mock.method(BillingControl.collection, 'updateOne', async () => ({
    matchedCount: 1,
    modifiedCount: 1,
  }));
};
afterEach(() => mock.restoreAll());
describe('billing tenant isolation and immutable ledger', () => {
  it('fails closed for reads and writes without a tenant', async () => {
    await assert.rejects(Invoice.findOne(), /Tenant context missing/);
    await assert.rejects(
      Waiver.create({
        charge: 'monthly',
        discountBps: 10000,
        startsAt: new Date(),
        endsAt: new Date(),
        actor: 'admin',
        reason: 'test',
      }),
      /Tenant context missing/,
    );
  });
  it('injects the current tenant into queries even when a foreign tenant filter is supplied', async () => {
    let filter: Record<string, unknown> = {};
    mock.method(Invoice.collection, 'findOne', async (value: Record<string, unknown>) => {
      filter = value;
      return null;
    });
    await runWithTenant(tenantId, () => Invoice.findOne({ tenantId: otherId }).exec());
    assert.equal(String(filter.tenantId), String(tenantId));
  });
  it('rejects foreign-owned credit notes and non-integer money', async () => {
    await runWithTenant(tenantId, async () => {
      const credit = new CreditNote({
        tenantId: otherId,
        currency: Currency.USD,
        key: '1',
        invoiceId: otherId,
        amount: money(10),
        appliedToSource: money(0),
        actor: 'admin',
        reason: 'test',
      });
      await assert.rejects(credit.validate(), /does not match context/);
      const receipt = new Receipt({
        invoiceId: otherId,
        attemptId: otherId,
        key: '1',
        amount: { amount: 1.1, currency: Currency.USD },
        paidAt: new Date(),
      });
      await assert.rejects(receipt.validate(), /amount/);
    });
  });
  it('rejects invoice edits/deletes and audit rewrites before reaching the database', async () => {
    await runWithTenant(tenantId, async () => {
      await assert.rejects(Invoice.updateOne({}, { $set: { total: money(0) } }), /immutable/);
      await assert.rejects(Invoice.deleteMany({}), /immutable/);
      const issued = Invoice.hydrate({ _id: otherId, tenantId });
      await assert.rejects(issued.deleteOne(), /immutable/);
      await assert.rejects(
        Audit.findOneAndUpdate({}, { $set: { reason: 'changed' } }),
        /immutable/,
      );
    });
  });
});
describe('commission and setup settlement', () => {
  const order = (completedAt: Date, method = 'cash_on_delivery') =>
    Order.hydrate({
      _id: otherId,
      tenantId,
      orderNumber: '1001',
      status: OrderStatus.COMPLETED,
      orderDate: completedAt,
      completedAt,
      billingItemsMinor: 10000,
      totalAmount: 150,
      paymentDetails: { status: PaymentStatus.PENDING, method },
    });
  it('accrues items-only percent plus fixed fee for online and COD orders', async () => {
    readOne(BillingAccount, account);
    readOne(Accrual, null);
    readOne(PlanRate, rate);
    readOne(RateOverride, null);
    locks();
    const inserted: Record<string, unknown>[] = [];
    mock.method(Accrual.collection, 'insertOne', async (doc: Record<string, unknown>) => {
      inserted.push(doc);
      return { insertedId: doc._id };
    });
    await runWithTenant(tenantId, async () => {
      await captureOrder(order(at('2026-10-15')), session);
      await captureOrder(order(at('2026-10-15'), 'ecocash'), session);
    });
    assert.equal(inserted.length, 2);
    for (const accrual of inserted) {
      assert.deepEqual(accrual.gross, { amount: 280, currency: 'USD' });
    }
  });
  it('never accrues commission during the trial, including fixed per-order fees', async () => {
    readOne(BillingAccount, account);
    readOne(Accrual, null);
    locks();
    const insert = mock.method(Accrual.collection, 'insertOne', async () => {
      throw new Error('Must not accrue');
    });
    await runWithTenant(tenantId, () => captureOrder(order(at('2026-10-14T23:59:59Z')), session));
    assert.equal(insert.mock.callCount(), 0);
  });
  it('blocks activation until setup is paid or credited, without reissuing it', async () => {
    readOne(Invoice, { _id: otherId, tenantId, total: money(5000) });
    readMany(Receipt, []);
    readMany(CreditNote, []);
    assert.equal(await runWithTenant(tenantId, () => setupSettled()), false);
    mock.restoreAll();
    readOne(Invoice, { _id: otherId, tenantId, total: money(5000) });
    readMany(Receipt, [{ amount: money(2000) }]);
    readMany(CreditNote, [{ appliedToSource: money(3000) }]);
    assert.equal(await runWithTenant(tenantId, () => setupSettled()), true);
  });
  it('credits an unpaid source balance first and carries only the unused credit forward', async () => {
    readOne(Invoice, { _id: otherId, tenantId, total: money(5000) });
    readMany(Receipt, [{ amount: money(4000) }]);
    readMany(CreditNote, []);
    let inserted: Record<string, unknown> = {};
    mock.method(CreditNote.collection, 'insertOne', async (doc: Record<string, unknown>) => {
      inserted = doc;
      return { insertedId: doc._id };
    });
    await runWithTenant(tenantId, () =>
      createCredit(otherId, 2000, 'credit-1', 'admin', 'Refund', session),
    );
    assert.deepEqual(inserted.amount, money(2000));
    assert.deepEqual(inserted.appliedToSource, money(1000));
  });
  it('removes unbilled commission on cancellation and credits billed commission with its saved tax', async () => {
    readOne(BillingAccount, account);
    locks();
    const accrual = {
      _id: new mongoose.Types.ObjectId(),
      tenantId,
      currency: Currency.USD,
      orderId: otherId,
      completedAt: at('2026-10-20'),
      items: money(10000),
      gross: money(280),
      commissionBps: 250,
      commissionFixed: money(30),
    };
    readOne(Accrual, accrual);
    const changes: Record<string, unknown>[] = [];
    mock.method(
      Accrual.collection,
      'updateOne',
      async (_f: unknown, change: Record<string, unknown>) => {
        changes.push(change);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    );
    const cancelled = order(at('2026-10-20'));
    cancelled.status = OrderStatus.CANCELLED;
    await runWithTenant(tenantId, () => captureOrder(cancelled, session));
    assert.ok((changes[0].$set as { reversedAt?: Date }).reversedAt);
    readOne(Accrual, { ...accrual, invoiceId: otherId, billed: money(280), billedTax: money(28) });
    readOne(Invoice, { _id: otherId, tenantId, total: money(308) });
    readMany(Receipt, [{ amount: money(308) }]);
    readMany(CreditNote, []);
    let credit: Record<string, unknown> = {};
    mock.method(CreditNote.collection, 'insertOne', async (doc) => {
      credit = doc;
      return { insertedId: doc._id };
    });
    mock.method(Audit.collection, 'insertOne', async () => ({ insertedId: otherId }));
    await runWithTenant(tenantId, () => captureOrder(cancelled, session));
    assert.deepEqual(credit.amount, money(308));
    assert.deepEqual(credit.appliedToSource, money(0));
  });
  it('issues setup only once, applies a full waiver and reports the billing activation gate', async () => {
    locks();
    readOne(BillingAccount, account);
    readOne(PlanRate, rate);
    readOne(RateOverride, null);
    readOne(Policy, null);
    readMany(Waiver, [
      {
        charge: 'setup',
        discountBps: 10000,
        startsAt: at('2026-10-01'),
        endsAt: at('2026-11-01'),
        reason: 'Launch waiver',
      },
    ]);
    readMany(Promo, []);
    let issued: Record<string, unknown> | null = null;
    mock.method(Invoice.collection, 'findOne', async () => issued);
    const insert = mock.method(Invoice.collection, 'insertOne', async (doc) => {
      issued = doc;
      return { insertedId: doc._id };
    });
    mock.method(Audit.collection, 'insertOne', async () => ({ insertedId: otherId }));
    const tenant = Tenant.hydrate({
      _id: tenantId,
      displayName: 'Vendor',
      slug: 'vendor',
      email: 'vendor@example.test',
      country: 'Zimbabwe',
      whatsappPhoneNumberId: '123',
      whatsappBusinessId: '456',
      paymentMethods: ['cash_on_delivery'],
      deliveryMethods: ['collect'],
    });
    await runWithTenant(tenantId, async () => {
      await ensureSetup(tenant, 'admin', at('2026-10-11'), session);
      await ensureSetup(tenant, 'admin', at('2026-10-12'), session);
    });
    assert.equal(insert.mock.callCount(), 1);
    assert.deepEqual(issued?.total, money(0));
    readMany(Receipt, []);
    readMany(CreditNote, []);
    assert.deepEqual(await missingActivationFields(tenant), []);
    readOne(Invoice, null);
    assert.deepEqual(await missingActivationFields(tenant), ['setupFee']);
  });
  it('starts the billing trial at go-live and never resets it on reactivation', async () => {
    locks();
    const stored = {
      ...account,
      liveAt: undefined as Date | undefined,
      trialEndsAt: undefined as Date | undefined,
      nextPeriod: undefined as Date | undefined,
    };
    readOne(BillingAccount, stored);
    mock.method(
      BillingAccount.collection,
      'updateOne',
      async (_f: unknown, update: { $set?: Record<string, unknown> }) => {
        Object.assign(stored, update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    );
    await runWithTenant(tenantId, () => startTrial(at('2026-10-11T15:00:00Z'), session));
    assert.equal(stored.trialEndsAt?.toISOString(), '2026-11-10T15:00:00.000Z');
    await runWithTenant(tenantId, () => startTrial(at('2026-12-01'), session));
    assert.equal(stored.liveAt?.toISOString(), '2026-10-11T15:00:00.000Z');
  });
});
describe('monthly invoice snapshot', () => {
  it('restores document changes when a transaction callback is retried', async () => {
    readOne(BillingAccount, account);
    mock.method(mongoose.connection, 'startSession', async () => session);
    mock.method(session, 'withTransaction', async (fn: (s: ClientSession) => Promise<unknown>) => {
      try {
        return await fn(session);
      } catch {
        return fn(session);
      }
    });
    const updates = mock.method(BillingAccount.collection, 'updateOne', async () => ({
      matchedCount: 1,
      modifiedCount: 1,
    }));
    const doc = BillingAccount.hydrate(account);
    let firstAttempt = true;
    await runWithTenant(tenantId, () =>
      transaction(async (s) => {
        doc.revision = 5;
        await doc.save({ session: s });
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error('Simulated transient transaction conflict');
        }
      }),
    );
    assert.equal(updates.mock.callCount(), 2);
  });
  it('combines proration, best discount, tax and credit without changing issued invoices', async () => {
    mock.method(mongoose.connection, 'startSession', async () => session);
    locks();
    readOne(BillingAccount, account);
    readOne(Invoice, null);
    readOne(PlanRate, rate);
    readOne(RateOverride, null);
    readOne(Policy, { taxBps: 1000, dueDays: 7, graceDays: 7 });
    readMany(Order, []);
    readMany(Waiver, [
      {
        charge: 'commission',
        discountBps: 1000,
        startsAt: at('2026-10-01'),
        endsAt: at('2026-11-01'),
        reason: 'Waiver',
      },
    ]);
    readMany(Promo, [
      {
        charge: 'commission',
        discountBps: 2000,
        startsAt: at('2026-10-01'),
        endsAt: at('2026-11-01'),
        reason: 'Promo',
      },
    ]);
    readMany(Accrual, [
      {
        _id: new mongoose.Types.ObjectId(),
        tenantId,
        currency: Currency.USD,
        orderId: otherId,
        completedAt: at('2026-10-20'),
        items: money(10000),
        gross: money(280),
        commissionBps: 250,
        commissionFixed: money(30),
      },
    ]);
    mock.method(Accrual.collection, 'updateOne', async () => ({
      matchedCount: 1,
      modifiedCount: 1,
    }));
    mock.method(CreditAllocation.collection, 'distinct', async () => []);
    readMany(CreditNote, [
      {
        _id: new mongoose.Types.ObjectId(),
        tenantId,
        amount: money(500),
        appliedToSource: money(0),
        reason: 'Refund from prior invoice',
      },
    ]);
    mock.method(CreditAllocation.collection, 'insertOne', async () => ({ insertedId: otherId }));
    mock.method(Audit.collection, 'insertOne', async () => ({ insertedId: otherId }));
    let issued: Record<string, unknown> = {};
    const insert = mock.method(
      Invoice.collection,
      'insertOne',
      async (doc: Record<string, unknown>) => {
        issued = doc;
        return { insertedId: doc._id };
      },
    );
    await runWithTenant(tenantId, () => issueMonth(at('2026-10-01'), at('2026-11-01')));
    assert.deepEqual(issued.subtotal, money(1424)); // $17 + ($2.80 less 20%) - $5 credit
    assert.deepEqual(issued.tax, money(192)); // $1.70 + $0.22
    assert.deepEqual(issued.total, money(1616));
    assert.equal(insert.mock.callCount(), 1);
    readOne(Invoice, { _id: otherId });
    await runWithTenant(tenantId, () => issueMonth(at('2026-10-01'), at('2026-11-01')));
    assert.equal(insert.mock.callCount(), 1);
  });
});

describe('verified platform invoice settlement', () => {
  const fixture = (appliedCredit = 0) => {
    locks();
    const source = { _id: otherId, tenantId, total: money(10000) };
    const attempt = {
      _id: new mongoose.Types.ObjectId(),
      tenantId,
      invoiceId: otherId,
      reference: 'billing-attempt',
      amount: money(10000),
      status: 'pending',
      pollUrl: 'https://paynow.co.zw/poll/1',
    };
    const receipts: { key: string; amount: { amount: number }; _id: unknown }[] = [];
    const notes: Record<string, unknown>[] = [];
    readOne(Invoice, source);
    readOne(PaymentAttempt, attempt);
    mock.method(
      PaymentAttempt.collection,
      'updateOne',
      async (_filter: unknown, update: { $set?: Record<string, unknown> }) => {
        Object.assign(attempt, update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    );
    mock.method(
      Receipt.collection,
      'findOne',
      async (filter: { key: string }) => receipts.find((r) => r.key === filter.key) ?? null,
    );
    readMany(Receipt, receipts);
    mock.method(Receipt.collection, 'insertOne', async (doc) => {
      receipts.push(doc);
      return { insertedId: doc._id };
    });
    readMany(
      CreditNote,
      appliedCredit
        ? [{ amount: money(appliedCredit), appliedToSource: money(appliedCredit) }]
        : [],
    );
    mock.method(
      CreditNote.collection,
      'findOne',
      async (filter: { key: string }) => notes.find((n) => n.key === filter.key) ?? null,
    );
    mock.method(CreditNote.collection, 'insertOne', async (doc) => {
      notes.push(doc);
      return { insertedId: doc._id };
    });
    mock.method(Audit.collection, 'insertOne', async () => ({ insertedId: otherId }));
    return { attempt, receipts, notes };
  };
  const update = {
    reference: 'billing-attempt',
    status: 'Paid',
    amountMinor: 10000,
    pollUrl: 'https://paynow.co.zw/poll/1',
  };
  it('requires the exact amount and payment-attempt identity before settlement', async () => {
    const { receipts } = fixture();
    await runWithTenant(tenantId, async () => {
      assert.equal(await settleVerifiedPayment({ ...update, amountMinor: 9999 }, session), false);
      assert.equal(
        await settleVerifiedPayment(
          { ...update, pollUrl: 'https://paynow.co.zw/poll/other' },
          session,
        ),
        false,
      );
    });
    assert.equal(receipts.length, 0);
  });
  it('records a paid receipt once and never regresses it on a late failure', async () => {
    const { receipts, attempt } = fixture();
    await runWithTenant(tenantId, async () => {
      assert.equal(await settleVerifiedPayment(update, session), true);
      assert.equal(await settleVerifiedPayment(update, session), true);
      await settleVerifiedPayment({ ...update, status: 'Cancelled' }, session);
    });
    assert.equal(receipts.length, 1);
    assert.equal(attempt.status, 'paid');
  });
  it('reverses a platform payment once and ignores stale paid retries after refund', async () => {
    const { receipts, attempt } = fixture();
    await runWithTenant(tenantId, async () => {
      await settleVerifiedPayment(update, session);
      await settleVerifiedPayment({ ...update, status: 'Refunded' }, session);
      await settleVerifiedPayment({ ...update, status: 'Refunded' }, session);
      await settleVerifiedPayment(update, session);
    });
    assert.equal(receipts.length, 2);
    assert.equal(
      receipts.reduce((sum, r) => sum + r.amount.amount, 0),
      0,
    );
    assert.equal(attempt.status, 'refunded');
  });
  it('carries a late payment excess forward and reverses that credit if the payment is refunded', async () => {
    const { notes } = fixture(3000);
    await runWithTenant(tenantId, async () => {
      await settleVerifiedPayment(update, session);
      await settleVerifiedPayment({ ...update, status: 'Refunded' }, session);
    });
    assert.equal(notes.length, 2);
    assert.deepEqual(notes[0].amount, money(3000));
    assert.deepEqual(notes[1].amount, money(-3000));
  });
});
