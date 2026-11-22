import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import mongoose, { Types } from 'mongoose';
import { BillingAuditAction, BillingAuditSubject } from '../src/constants/billing.ts';
import { Currency, TenantPlan } from '../src/constants/models.ts';
import { TenantContextMissingError, runWithTenant } from '../src/context/tenantContext.ts';
import PlanRateVersion from '../src/billing/models/PlanRateVersion.ts';
import VendorRateOverride from '../src/billing/models/VendorRateOverride.ts';
import {
  BillingAuditEntry,
  PlatformBillingAuditEntry,
} from '../src/billing/models/BillingAuditEntry.ts';
import { ImmutableRecordError } from '../src/billing/models/plugins/immutableRecord.ts';

// No database here. With buffering off, a query that gets past the model's
// middleware fails at the (absent) connection instead of waiting for one, so
// "reached the driver" and "stopped by middleware" are told apart by error.
mongoose.set('bufferCommands', false);
const NO_CONNECTION = /before initial connection is complete/;

const usd = (amount: number) => ({ amount, currency: Currency.USD });
const actor = { platformUserId: new Types.ObjectId(), email: 'ops@platform.test' };

const planRateFields = () => ({
  plan: TenantPlan.STARTER,
  currency: Currency.USD,
  effectiveFrom: '2027-01',
  setupFee: usd(5000),
  monthlyFee: usd(2000),
  commissionBps: 300,
  commissionFixedFee: usd(25),
  reason: 'Launch pricing',
  createdBy: actor,
});

const errorPaths = async (doc: mongoose.Document): Promise<string[]> => {
  try {
    await doc.validate();
    return [];
  } catch (error) {
    return Object.keys((error as mongoose.Error.ValidationError).errors).sort();
  }
};

describe('PlanRateVersion validation', () => {
  it('accepts a complete card in integer minor units', async () => {
    assert.deepEqual(await errorPaths(new PlanRateVersion(planRateFields())), []);
  });

  it('rejects amounts in another currency than the card', async () => {
    const doc = new PlanRateVersion({
      ...planRateFields(),
      monthlyFee: { amount: 2000, currency: Currency.ZAR },
    });
    assert.deepEqual(await errorPaths(doc), ['monthlyFee']);
  });

  it('rejects fractional cents, fractional or out-of-range basis points, and bad months', async () => {
    const doc = new PlanRateVersion({
      ...planRateFields(),
      setupFee: usd(49.99),
      commissionBps: 10_001,
      effectiveFrom: '2027-13',
    });
    assert.deepEqual(await errorPaths(doc), ['commissionBps', 'effectiveFrom', 'setupFee.amount']);
    const fractional = new PlanRateVersion({ ...planRateFields(), commissionBps: 2.5 });
    assert.deepEqual(await errorPaths(fractional), ['commissionBps']);
  });

  it('requires all four rates and a reason', async () => {
    const doc = new PlanRateVersion({
      plan: TenantPlan.PRO,
      currency: Currency.USD,
      effectiveFrom: '2027-01',
      reason: 'no',
      createdBy: actor,
    });
    assert.deepEqual(await errorPaths(doc), [
      'commissionBps',
      'commissionFixedFee',
      'monthlyFee',
      'reason',
      'setupFee',
    ]);
  });

  it('cannot be created already cancelled', async () => {
    const doc = new PlanRateVersion({ ...planRateFields(), cancelled: true });
    assert.deepEqual(await errorPaths(doc), ['cancelled']);
  });
});

describe('immutableRecord on rate versions', () => {
  const id = new Types.ObjectId();
  const cancellation = { at: new Date(), by: actor, reason: 'Announced in error' };

  it('lets the one-way cancellation through to the database', async () => {
    await assert.rejects(
      PlanRateVersion.findOneAndUpdate(
        { _id: id, cancelled: false },
        { $set: { cancelled: true, cancellation } },
        { timestamps: false },
      ),
      NO_CONNECTION,
    );
    // Default options add $setOnInsert.createdAt, which is inert without upsert.
    await assert.rejects(
      PlanRateVersion.updateOne(
        { _id: id, cancelled: false },
        { $set: { cancelled: true, cancellation } },
      ),
      NO_CONNECTION,
    );
  });

  it('refuses every other update', async () => {
    const pinned = { _id: id, cancelled: false };
    const cancel = { $set: { cancelled: true, cancellation } };
    // Thunks, so each attempt starts only when it is awaited.
    const refused: Array<[string, () => PromiseLike<unknown>]> = [
      [
        'editing a price',
        () => PlanRateVersion.findOneAndUpdate(pinned, { $set: { 'monthlyFee.amount': 1 } }),
      ],
      [
        'cancelling and editing at once',
        () =>
          PlanRateVersion.updateOne(pinned, {
            $set: { cancelled: true, cancellation, commissionBps: 0 },
          }),
      ],
      [
        'un-cancelling',
        () =>
          PlanRateVersion.updateOne({ _id: id, cancelled: true }, { $set: { cancelled: false } }),
      ],
      [
        'cancelling without pinning the state',
        () => PlanRateVersion.updateOne({ _id: id }, cancel),
      ],
      [
        'cancelling without pinning the record',
        () => PlanRateVersion.updateOne({ cancelled: false }, cancel),
      ],
      ['upserting', () => PlanRateVersion.updateOne(pinned, cancel, { upsert: true })],
      [
        'another operator',
        () =>
          PlanRateVersion.updateOne(pinned, { $set: { cancelled: true }, $unset: { reason: 1 } }),
      ],
      ['updateMany', () => PlanRateVersion.updateMany({}, { $set: { cancelled: true } })],
      ['replaceOne', () => PlanRateVersion.replaceOne({ _id: id }, planRateFields())],
      ['findOneAndReplace', () => PlanRateVersion.findOneAndReplace({ _id: id }, planRateFields())],
      ['deleteOne', () => PlanRateVersion.deleteOne({ _id: id })],
      ['deleteMany', () => PlanRateVersion.deleteMany({})],
      ['findOneAndDelete', () => PlanRateVersion.findOneAndDelete({ _id: id })],
      ['bulkWrite', () => PlanRateVersion.bulkWrite([{ deleteOne: { filter: { _id: id } } }])],
    ];
    for (const [label, attempt] of refused) {
      await assert.rejects(attempt, ImmutableRecordError, label);
    }
  });

  it('refuses saving or deleting a loaded document', async () => {
    const loaded = PlanRateVersion.hydrate({ _id: id, ...planRateFields(), cancelled: false });
    loaded.set('monthlyFee', usd(1));
    await assert.rejects(loaded.save(), ImmutableRecordError);
    await assert.rejects(loaded.deleteOne(), ImmutableRecordError);
  });

  it('never lets an audit entry be cancelled, edited or removed', async () => {
    const entryId = new Types.ObjectId();
    await assert.rejects(
      PlatformBillingAuditEntry.updateOne(
        { _id: entryId, cancelled: false },
        { $set: { cancelled: true } },
      ),
      ImmutableRecordError,
    );
    await assert.rejects(PlatformBillingAuditEntry.deleteMany({}), ImmutableRecordError);
    const tenantId = new Types.ObjectId();
    await runWithTenant(tenantId, async () => {
      await assert.rejects(
        BillingAuditEntry.findOneAndUpdate({ _id: entryId }, { $set: { reason: 'rewritten' } }),
        ImmutableRecordError,
      );
    });
  });

  it('still allows inserts', async () => {
    await assert.rejects(PlanRateVersion.create(planRateFields()), NO_CONNECTION);
  });
});

describe('tenant scoping of vendor billing records', () => {
  const overrideFields = () => ({
    currency: Currency.USD,
    effectiveFrom: '2027-01',
    monthlyFee: usd(0),
    reason: 'Pilot vendor',
    createdBy: actor,
  });

  it('refuses to validate or query an override outside a tenant context', async () => {
    await assert.rejects(
      new VendorRateOverride(overrideFields()).validate(),
      TenantContextMissingError,
    );
    await assert.rejects(
      VendorRateOverride.find({ currency: Currency.USD }),
      TenantContextMissingError,
    );
  });

  it('stamps the context tenant on new records and scopes every query to it', async () => {
    const tenantId = new Types.ObjectId();
    await runWithTenant(tenantId, async () => {
      const override = new VendorRateOverride(overrideFields());
      await override.validate();
      assert.equal(String(override.tenantId), String(tenantId));

      const entry = new BillingAuditEntry({
        action: BillingAuditAction.VENDOR_RATE_OVERRIDE_SCHEDULED,
        actor,
        reason: 'Pilot vendor',
        subject: { kind: BillingAuditSubject.VENDOR_RATE_OVERRIDE, id: override._id },
        details: {},
      });
      await entry.validate();
      assert.equal(String(entry.tenantId), String(tenantId));

      const query = VendorRateOverride.find({ currency: Currency.USD });
      await assert.rejects(query.exec(), NO_CONNECTION);
      assert.equal(String(query.getFilter().tenantId), String(tenantId));
    });
  });

  it("refuses a record carrying another tenant's id", async () => {
    await runWithTenant(new Types.ObjectId(), async () => {
      const foreign = new VendorRateOverride({
        ...overrideFields(),
        tenantId: new Types.ObjectId(),
      });
      await assert.rejects(foreign.validate(), /does not match context/);
    });
  });

  it('keeps per-vendor overrides optional and in the vendor currency', async () => {
    await runWithTenant(new Types.ObjectId(), async () => {
      const backToPlan = new VendorRateOverride({ ...overrideFields(), monthlyFee: undefined });
      assert.deepEqual(await errorPaths(backToPlan), []);
      const wrongCurrency = new VendorRateOverride({
        ...overrideFields(),
        commissionFixedFee: { amount: 10, currency: Currency.ZWG },
      });
      assert.deepEqual(await errorPaths(wrongCurrency), ['commissionFixedFee']);
    });
  });
});
