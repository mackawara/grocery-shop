import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import mongoose, { Types } from 'mongoose';
import { BillingAuditAction, BillingAuditSubject, RateSource } from '../src/constants/billing.ts';
import { Currency, TenantPlan } from '../src/constants/models.ts';
import { getTenantId } from '../src/context/tenantContext.ts';
import PlanRateVersion from '../src/billing/models/PlanRateVersion.ts';
import VendorRateOverride from '../src/billing/models/VendorRateOverride.ts';
import {
  BillingAuditEntry,
  PlatformBillingAuditEntry,
} from '../src/billing/models/BillingAuditEntry.ts';
import { BillingRuleError } from '../src/billing/errors.ts';
import { cancelPlanRate, schedulePlanRate } from '../src/billing/planRates.service.ts';
import {
  cancelVendorRateOverride,
  getVendorEffectiveRates,
  scheduleVendorRateOverride,
} from '../src/billing/vendorRates.service.ts';

// Service orchestration with the model statics stubbed: what is read, what is
// written, in which session, and in which tenant context. Documents the
// services would insert are still validated by the real schemas (including
// tenantScope), so a service handing the database something invalid fails here.
// Live transaction and index behaviour needs a MongoDB replica set and is not
// covered by this suite.

mongoose.set('bufferCommands', false);

const NOW = new Date('2026-11-22T10:00:00Z'); // billing month 2026-11 in Harare
const actor = { platformUserId: new Types.ObjectId().toString(), email: 'ops@platform.test' };
const usd = (amount: number) => ({ amount, currency: Currency.USD });
const card = (setup: number, monthly: number, bps: number, perOrder: number) => ({
  setupFee: usd(setup),
  monthlyFee: usd(monthly),
  commissionBps: bps,
  commissionFixedFee: usd(perOrder),
});

// What .lean() returns for a stored plan rate version.
const leanPlanRate = (effectiveFrom: string, monthly: number, cancelled = false) => ({
  _id: new Types.ObjectId(),
  plan: TenantPlan.STARTER,
  currency: Currency.USD,
  effectiveFrom,
  ...card(5000, monthly, 300, 25),
  reason: 'Seed',
  createdBy: { platformUserId: new Types.ObjectId(), email: 'ops@platform.test' },
  cancelled,
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

// A stand-in for a Mongoose query chain resolving to `result`.
const query = (result: unknown) => {
  const chain = {
    sort: () => chain,
    session: () => chain,
    lean: () => Promise.resolve(result),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return chain;
};

// Transactions run the work once, as the driver does when nothing conflicts.
const useFakeTransactions = () => {
  const session = {
    withTransaction: <T>(work: (s: unknown) => Promise<T>) => work(session),
    endSession: async () => undefined,
  };
  mock.method(mongoose, 'startSession', async () => session);
  return session;
};

interface Created {
  doc: mongoose.Document & { tenantId?: Types.ObjectId };
  options: { session?: unknown };
  contextTenantId?: string;
}

// Model.create stand-in: builds and validates each document with the real
// schema, in the caller's tenant context, and records it.
const captureCreates = (model: mongoose.Model<never>, log: Created[]) =>
  mock.method(model, 'create', async (docs: object[], options: { session?: unknown }) => {
    const created = [];
    for (const fields of docs) {
      const doc = new model(fields) as Created['doc'];
      await doc.validate();
      log.push({ doc, options, contextTenantId: getTenantId() });
      created.push(doc);
    }
    return created;
  });

const asModel = (model: unknown) => model as mongoose.Model<never>;

afterEach(() => {
  mock.restoreAll();
});

describe('schedulePlanRate', () => {
  it('writes the version and its platform audit entry in one transaction', async () => {
    const session = useFakeTransactions();
    const find = mock.method(PlanRateVersion, 'find', () => query([]));
    const versions: Created[] = [];
    const audits: Created[] = [];
    captureCreates(asModel(PlanRateVersion), versions);
    captureCreates(asModel(PlatformBillingAuditEntry), audits);

    const result = await schedulePlanRate(
      {
        plan: TenantPlan.STARTER,
        currency: Currency.USD,
        effectiveFrom: '2026-12',
        rates: card(5000, 2000, 300, 25),
        reason: 'Launch pricing',
      },
      actor,
      NOW,
    );

    assert.deepEqual(find.mock.calls[0]?.arguments[0], {
      plan: TenantPlan.STARTER,
      currency: Currency.USD,
    });
    assert.equal(versions.length, 1);
    assert.equal(audits.length, 1);
    assert.equal(versions[0]?.options.session, session);
    assert.equal(audits[0]?.options.session, session);

    const audit = audits[0]?.doc.toObject();
    assert.equal(audit?.action, BillingAuditAction.PLAN_RATE_SCHEDULED);
    assert.equal(audit?.subject.kind, BillingAuditSubject.PLAN_RATE);
    assert.equal(String(audit?.subject.id), String(result.version._id));
    assert.equal(audit?.reason, 'Launch pricing');
    assert.equal(audit?.actor.email, actor.email);
    assert.equal(String(audit?.actor.platformUserId), actor.platformUserId);
    assert.equal(result.changes[0]?.period, '2026-12');
  });

  it('writes nothing when the rules refuse the change', async () => {
    useFakeTransactions();
    mock.method(PlanRateVersion, 'find', () => query([leanPlanRate('2026-11', 2000)]));
    const writes: Created[] = [];
    captureCreates(asModel(PlanRateVersion), writes);
    captureCreates(asModel(PlatformBillingAuditEntry), writes);

    await assert.rejects(
      schedulePlanRate(
        {
          plan: TenantPlan.STARTER,
          currency: Currency.USD,
          effectiveFrom: '2026-12',
          rates: card(5000, 2500, 300, 25), // a rise, 8 days out
          reason: 'Price rise',
        },
        actor,
        NOW,
      ),
      (error: unknown) => error instanceof BillingRuleError && error.code === 'insufficient_notice',
    );
    assert.equal(writes.length, 0);
  });
});

describe('cancelPlanRate', () => {
  it('cancels through the one update immutableRecord allows, and records why', async () => {
    const session = useFakeTransactions();
    const current = leanPlanRate('2026-11', 2000);
    const scheduled = leanPlanRate('2027-01', 2500);
    mock.method(PlanRateVersion, 'findById', () => query(scheduled));
    mock.method(PlanRateVersion, 'find', () => query([current, scheduled]));
    const update = mock.method(PlanRateVersion, 'findOneAndUpdate', async () =>
      PlanRateVersion.hydrate({ ...scheduled, cancelled: true }),
    );
    const audits: Created[] = [];
    captureCreates(asModel(PlatformBillingAuditEntry), audits);

    await cancelPlanRate(String(scheduled._id), 'Announced in error', actor, NOW);

    const [filter, change, options] = update.mock.calls[0]?.arguments ?? [];
    assert.deepEqual(filter, { _id: scheduled._id, cancelled: false });
    assert.equal(change.$set.cancelled, true);
    assert.equal(change.$set.cancellation.reason, 'Announced in error');
    assert.equal(change.$set.cancellation.by.email, actor.email);
    assert.equal(options.session, session);
    assert.equal(audits[0]?.doc.get('action'), BillingAuditAction.PLAN_RATE_CANCELLED);
    assert.equal(audits[0]?.options.session, session);

    // Replayed against the real model, the same update clears immutableRecord
    // and only stops at the (absent) connection.
    mock.restoreAll();
    const { session: _session, ...realOptions } = options;
    await assert.rejects(
      PlanRateVersion.findOneAndUpdate(filter, change, realOptions),
      /before initial connection is complete/,
    );
  });

  it('reports losing a race to another cancellation, and writes no audit entry', async () => {
    useFakeTransactions();
    const scheduled = leanPlanRate('2027-01', 2500);
    mock.method(PlanRateVersion, 'findById', () => query(scheduled));
    mock.method(PlanRateVersion, 'find', () => query([scheduled]));
    mock.method(PlanRateVersion, 'findOneAndUpdate', async () => null);
    const audits: Created[] = [];
    captureCreates(asModel(PlatformBillingAuditEntry), audits);

    await assert.rejects(
      cancelPlanRate(String(scheduled._id), 'Announced in error', actor, NOW),
      (error: unknown) => error instanceof BillingRuleError && error.code === 'already_cancelled',
    );
    assert.equal(audits.length, 0);
  });

  it('is not_found for an unknown id', async () => {
    useFakeTransactions();
    mock.method(PlanRateVersion, 'findById', () => query(null));
    await assert.rejects(
      cancelPlanRate(new Types.ObjectId().toString(), 'Announced in error', actor, NOW),
      (error: unknown) => error instanceof BillingRuleError && error.code === 'not_found',
    );
  });
});

describe('vendor rate overrides', () => {
  const vendor = {
    tenantId: new Types.ObjectId().toString(),
    slug: 'fresh-foods',
    plan: TenantPlan.STARTER,
  };

  it("reads and writes inside the vendor's tenant context only", async () => {
    useFakeTransactions();
    const planFind = mock.method(PlanRateVersion, 'find', () =>
      query([leanPlanRate('2026-11', 2000)]),
    );
    const overrideFindContexts: (string | undefined)[] = [];
    mock.method(VendorRateOverride, 'find', () => {
      overrideFindContexts.push(getTenantId());
      return query([]);
    });
    const overrides: Created[] = [];
    const audits: Created[] = [];
    captureCreates(asModel(VendorRateOverride), overrides);
    captureCreates(asModel(BillingAuditEntry), audits);

    await scheduleVendorRateOverride(
      vendor,
      {
        currency: Currency.USD,
        effectiveFrom: '2026-12',
        rates: { monthlyFee: usd(0) },
        reason: 'Pilot vendor',
      },
      actor,
      NOW,
    );

    assert.deepEqual(planFind.mock.calls[0]?.arguments[0], {
      plan: TenantPlan.STARTER,
      currency: Currency.USD,
    });
    assert.deepEqual(overrideFindContexts, [vendor.tenantId]);
    for (const write of [...overrides, ...audits]) {
      assert.equal(write.contextTenantId, vendor.tenantId);
      // Stamped by tenantScope during validation, from the context.
      assert.equal(String(write.doc.tenantId), vendor.tenantId);
    }
    assert.equal(audits[0]?.doc.get('action'), BillingAuditAction.VENDOR_RATE_OVERRIDE_SCHEDULED);
    assert.equal(audits[0]?.doc.get('details').plan, TenantPlan.STARTER);
    assert.equal(getTenantId(), undefined, 'the context ends with the call');
  });

  it("looks up a cancellation target inside the vendor's context", async () => {
    useFakeTransactions();
    const lookups: (string | undefined)[] = [];
    mock.method(VendorRateOverride, 'findById', () => {
      lookups.push(getTenantId());
      return query(null);
    });
    await assert.rejects(
      cancelVendorRateOverride(vendor, new Types.ObjectId().toString(), 'Mistake', actor, NOW),
      (error: unknown) => error instanceof BillingRuleError && error.code === 'not_found',
    );
    assert.deepEqual(lookups, [vendor.tenantId]);
  });

  it('shows the effective rates with their sources and the upcoming changes', async () => {
    mock.method(PlanRateVersion, 'find', () =>
      query([leanPlanRate('2026-11', 2000), leanPlanRate('2027-01', 2500)]),
    );
    mock.method(VendorRateOverride, 'find', () =>
      query([
        {
          _id: new Types.ObjectId(),
          currency: Currency.USD,
          effectiveFrom: '2026-12',
          commissionBps: 150,
          cancelled: false,
        },
      ]),
    );

    const view = await getVendorEffectiveRates(vendor, Currency.USD, undefined, NOW);

    assert.equal(view.currentPeriod, '2026-11');
    assert.equal(view.effective.period, '2026-11');
    assert.equal(view.effective.rates.commissionBps, 300);
    assert.deepEqual(
      view.upcoming.map((u) => [u.period, u.rates.commissionBps, u.rates.monthlyFee?.amount]),
      [
        ['2026-12', 150, 2000],
        ['2027-01', 150, 2500],
      ],
    );
    assert.equal(view.upcoming[0]?.sources.commissionBps, RateSource.OVERRIDE);
  });
});
