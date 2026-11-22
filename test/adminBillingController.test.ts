import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type { Request, Response } from 'express';
import mongoose, { Types } from 'mongoose';
import { Currency, TenantPlan } from '../src/constants/models.ts';
import Tenant from '../src/models/Tenant.ts';
import PlanRateVersion from '../src/billing/models/PlanRateVersion.ts';
import { PlatformBillingAuditEntry } from '../src/billing/models/BillingAuditEntry.ts';
import {
  cancelPlanRateHandler,
  getVendorRatesHandler,
  listPlatformBillingAuditHandler,
  schedulePlanRateHandler,
  scheduleVendorRateOverrideHandler,
} from '../src/controllers/billing/adminBilling.controller.ts';

// The admin billing HTTP contract: what is refused at the edge (400), how rule
// violations surface (422/409/404), and the shape of a successful schedule.
// Model statics are stubbed; there is no database.

mongoose.set('bufferCommands', false);

const platformActor = {
  platformUserId: new Types.ObjectId().toString(),
  email: 'ops@platform.test',
  role: 'super_admin',
};

interface FakeResponse {
  statusCode: number;
  body: Record<string, unknown>;
  locals: Record<string, unknown>;
}

const call = async (
  handler: (req: Request, res: Response) => Promise<void>,
  req: { body?: unknown; params?: Record<string, string>; query?: Record<string, string> },
): Promise<FakeResponse> => {
  const res = {
    statusCode: 0,
    body: {},
    locals: { platformActor },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      this.body = body;
      return this;
    },
  };
  await handler(
    { body: req.body ?? {}, params: req.params ?? {}, query: req.query ?? {} } as Request,
    res as unknown as Response,
  );
  return res;
};

const usd = (amount: number) => ({ amount, currency: Currency.USD });

// Far enough ahead to clear the notice rule whenever this suite runs.
const validPlanRate = () => ({
  plan: TenantPlan.STARTER,
  currency: Currency.USD,
  effectiveFrom: '2099-01',
  setupFee: usd(5000),
  monthlyFee: usd(2000),
  commissionBps: 300,
  commissionFixedFee: usd(25),
  reason: 'Launch pricing',
});

const query = (result: unknown) => {
  const chain = {
    sort: () => chain,
    select: () => chain,
    session: () => chain,
    limit: () => chain,
    lean: () => Promise.resolve(result),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return chain;
};

const stubTransactions = () => {
  const session = {
    withTransaction: <T>(work: (s: unknown) => Promise<T>) => work(session),
    endSession: async () => undefined,
  };
  mock.method(mongoose, 'startSession', async () => session);
};

afterEach(() => {
  mock.restoreAll();
});

describe('POST /admin/billing/plan-rates', () => {
  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ['no reason', { reason: undefined }, /^reason: /],
    ['a one-word shrug of a reason', { reason: 'ok' }, /^reason: /],
    ['an unsupported billing currency', { currency: Currency.ZAR }, /^currency: /],
    [
      'an amount in another currency',
      { monthlyFee: { amount: 2000, currency: Currency.ZWG } },
      /^monthlyFee\.currency: /,
    ],
    ['fractional cents', { setupFee: usd(49.99) }, /^setupFee\.amount: /],
    ['a percentage over 100%', { commissionBps: 10_001 }, /^commissionBps: /],
    ['a malformed month', { effectiveFrom: '2099-1' }, /^effectiveFrom: /],
    ['an unknown plan', { plan: 'platinum' }, /^plan: /],
    ['a field the server owns', { createdBy: { email: 'someone@else.test' } }, /createdBy/],
  ];

  for (const [label, patch, message] of refusals) {
    it(`refuses ${label} with 400`, async () => {
      const res = await call(schedulePlanRateHandler, { body: { ...validPlanRate(), ...patch } });
      assert.equal(res.statusCode, 400);
      assert.match(String(res.body.error), message);
    });
  }

  it('schedules a valid version (201) and returns it with its status and changes', async () => {
    stubTransactions();
    mock.method(PlanRateVersion, 'find', () => query([]));
    mock.method(PlanRateVersion, 'create', async (docs: object[]) =>
      docs.map((fields) => new PlanRateVersion(fields)),
    );
    mock.method(PlatformBillingAuditEntry, 'create', async (docs: object[]) =>
      docs.map((fields) => new PlatformBillingAuditEntry(fields)),
    );

    const res = await call(schedulePlanRateHandler, { body: validPlanRate() });

    assert.equal(res.statusCode, 201);
    const version = res.body.version as Record<string, unknown>;
    assert.equal(version.status, 'scheduled');
    assert.equal(version.plan, TenantPlan.STARTER);
    assert.equal(version.effectiveFrom, '2099-01');
    assert.deepEqual(version.monthlyFee, usd(2000));
    assert.deepEqual(version.createdBy, {
      platformUserId: platformActor.platformUserId,
      email: platformActor.email,
    });
    assert.equal((res.body.changes as unknown[]).length, 1);
  });

  it('reports a backdated change as 422 with its rule code', async () => {
    stubTransactions();
    mock.method(PlanRateVersion, 'find', () => query([]));
    const res = await call(schedulePlanRateHandler, {
      body: { ...validPlanRate(), effectiveFrom: '2020-01' },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, 'not_future');
  });
});

describe('POST /admin/billing/plan-rates/:rateId/cancel', () => {
  it('refuses a malformed id or a missing reason with 400', async () => {
    const badId = await call(cancelPlanRateHandler, {
      params: { rateId: 'nope' },
      body: { reason: 'Mistake' },
    });
    assert.equal(badId.statusCode, 400);
    const noReason = await call(cancelPlanRateHandler, {
      params: { rateId: new Types.ObjectId().toString() },
    });
    assert.equal(noReason.statusCode, 400);
  });

  it('is 404 for an unknown version', async () => {
    stubTransactions();
    mock.method(PlanRateVersion, 'findById', () => query(null));
    const res = await call(cancelPlanRateHandler, {
      params: { rateId: new Types.ObjectId().toString() },
      body: { reason: 'Mistake' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'not_found');
  });
});

describe('per-vendor billing endpoints', () => {
  it('refuses a malformed tenant id and 404s an unknown tenant before touching billing data', async () => {
    const badId = await call(getVendorRatesHandler, { params: { id: 'nope' } });
    assert.equal(badId.statusCode, 400);

    mock.method(Tenant, 'findById', () => query(null));
    const unknown = await call(scheduleVendorRateOverrideHandler, {
      params: { id: new Types.ObjectId().toString() },
      body: { currency: Currency.USD, effectiveFrom: '2099-01', reason: 'Pilot vendor' },
    });
    assert.equal(unknown.statusCode, 404);
  });

  it('refuses an override body that names a tenant', async () => {
    const res = await call(scheduleVendorRateOverrideHandler, {
      params: { id: new Types.ObjectId().toString() },
      body: {
        currency: Currency.USD,
        effectiveFrom: '2099-01',
        reason: 'Pilot vendor',
        tenantId: new Types.ObjectId().toString(),
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match(String(res.body.error), /tenantId/);
  });
});

describe('GET /admin/billing/audit', () => {
  it('validates paging parameters', async () => {
    for (const badQuery of [{ limit: '0' }, { limit: '500' }, { before: 'xyz' }]) {
      const res = await call(listPlatformBillingAuditHandler, { query: badQuery });
      assert.equal(res.statusCode, 400, JSON.stringify(badQuery));
    }
  });

  it('pages newest first and hands back a cursor when the page is full', async () => {
    const entries = [3, 2].map(
      () =>
        new PlatformBillingAuditEntry({
          action: 'plan_rate.scheduled',
          actor: { platformUserId: new Types.ObjectId(), email: 'ops@platform.test' },
          reason: 'Launch pricing',
          subject: { kind: 'plan_rate', id: new Types.ObjectId() },
          details: {},
        }),
    );
    const find = mock.method(PlatformBillingAuditEntry, 'find', () => query(entries));
    const res = await call(listPlatformBillingAuditHandler, { query: { limit: '2' } });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(find.mock.calls[0]?.arguments[0], {});
    assert.equal((res.body.entries as unknown[]).length, 2);
    assert.equal(res.body.nextBefore, String(entries[1]?._id));
  });
});
