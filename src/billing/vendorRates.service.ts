import type { ClientSession } from 'mongoose';
import {
  BILLING_TIME_ZONE,
  BillingAuditAction,
  BillingAuditSubject,
} from '../constants/billing.ts';
import type { Currency, TenantPlan } from '../constants/models.ts';
import { runWithTenant } from '../context/tenantContext.ts';
import { logger } from '../services/logger.ts';
import { BillingRuleError, violationError } from './errors.ts';
import { BillingAuditEntry } from './models/BillingAuditEntry.ts';
import VendorRateOverride from './models/VendorRateOverride.ts';
import type { IVendorRateOverride } from './models/VendorRateOverride.ts';
import type { BillingPeriod } from './period.ts';
import { periodOf } from './period.ts';
import { loadPlanTimeline } from './planRates.service.ts';
import {
  checkCancelVersion,
  checkScheduleVersion,
  resolveEffectiveRates,
  upcomingRateChanges,
} from './rates.ts';
import type { EffectiveRates, RateChange } from './rates.ts';
import { inBillingTransaction, toRateVersion, toStoredActor } from './records.ts';
import type { BillingActor, PartialRateCard, RateVersion } from './types.ts';

// Per-vendor rate overrides. Tenant-owned: every function enters the vendor's
// tenant context itself (runWithTenant), so callers — the admin controller,
// which runs with no tenant context — pass the vendor and never touch the
// scoped models directly. Writes commit with their tenant audit entry.

const TAG = '[billing]';

// The vendor as billing needs it. `plan` is the tenant's current plan
// (Tenant.plan); see getVendorEffectiveRates for what that implies.
export interface VendorBillingRef {
  tenantId: string;
  slug?: string;
  plan: TenantPlan;
}

export interface VendorOverrideInput {
  currency: Currency;
  effectiveFrom: BillingPeriod;
  // Only the fields being overridden; the rest follow the plan.
  rates: PartialRateCard;
  reason: string;
}

export interface VendorOverrideResult {
  version: IVendorRateOverride;
  changes: RateChange[];
}

export interface VendorRatesView {
  currentPeriod: BillingPeriod;
  effective: EffectiveRates;
  upcoming: EffectiveRates[];
}

const inVendor = <T>(vendor: VendorBillingRef, fn: () => Promise<T>): Promise<T> =>
  runWithTenant(vendor.tenantId, fn, vendor.slug);

const loadOverrideTimeline = async (
  currency: Currency,
  session?: ClientSession,
): Promise<RateVersion[]> => {
  const records = await VendorRateOverride.find({ currency })
    .sort({ effectiveFrom: 1, createdAt: 1 })
    .session(session ?? null)
    .lean();
  return records.map(toRateVersion);
};

// Every override version for the vendor, cancelled ones included.
export const listVendorRateOverrides = (
  vendor: VendorBillingRef,
  filter: { currency?: Currency } = {},
): Promise<IVendorRateOverride[]> =>
  inVendor(vendor, () =>
    VendorRateOverride.find(filter).sort({ currency: 1, effectiveFrom: 1, createdAt: 1 }),
  );

export const scheduleVendorRateOverride = (
  vendor: VendorBillingRef,
  input: VendorOverrideInput,
  actor: BillingActor,
  now: Date = new Date(),
): Promise<VendorOverrideResult> =>
  inVendor(vendor, async () => {
    const result = await inBillingTransaction(async (session) => {
      const plan = await loadPlanTimeline(vendor.plan, input.currency, session);
      const overrides = await loadOverrideTimeline(input.currency, session);
      const check = checkScheduleVersion({
        kind: 'override',
        plan,
        overrides,
        proposed: { effectiveFrom: input.effectiveFrom, rates: input.rates },
        now,
      });
      if (!check.ok) {
        throw violationError(check.violation);
      }

      const [version] = await VendorRateOverride.create(
        [
          {
            currency: input.currency,
            effectiveFrom: input.effectiveFrom,
            ...input.rates,
            reason: input.reason,
            createdBy: toStoredActor(actor),
          },
        ],
        { session },
      );
      await BillingAuditEntry.create(
        [
          {
            action: BillingAuditAction.VENDOR_RATE_OVERRIDE_SCHEDULED,
            actor: toStoredActor(actor),
            reason: input.reason,
            subject: { kind: BillingAuditSubject.VENDOR_RATE_OVERRIDE, id: version._id },
            details: {
              plan: vendor.plan,
              currency: input.currency,
              effectiveFrom: input.effectiveFrom,
              rates: input.rates,
              changes: check.changes,
            },
          },
        ],
        { session },
      );
      return { version, changes: check.changes };
    });

    logger.info(
      `${TAG} rate override ${String(result.version._id)} scheduled: ${input.currency} ` +
        `from ${input.effectiveFrom} by ${actor.email}`,
    );
    return result;
  });

export const cancelVendorRateOverride = (
  vendor: VendorBillingRef,
  id: string,
  reason: string,
  actor: BillingActor,
  now: Date = new Date(),
): Promise<VendorOverrideResult> =>
  inVendor(vendor, async () => {
    const result = await inBillingTransaction(async (session) => {
      // tenantScope adds this vendor's tenantId to the filter, so another
      // vendor's override id is simply "not found" here.
      const target = await VendorRateOverride.findById(id).session(session).lean();
      if (!target) {
        throw new BillingRuleError('not_found', 'Rate override not found.');
      }
      const plan = await loadPlanTimeline(vendor.plan, target.currency, session);
      const overrides = await loadOverrideTimeline(target.currency, session);
      const check = checkCancelVersion({
        kind: 'override',
        plan,
        overrides,
        target: toRateVersion(target),
        now,
      });
      if (!check.ok) {
        throw violationError(check.violation);
      }

      const cancellation = { at: now, by: toStoredActor(actor), reason };
      const version = await VendorRateOverride.findOneAndUpdate(
        { _id: target._id, cancelled: false },
        { $set: { cancelled: true, cancellation } },
        { returnDocument: 'after', runValidators: true, timestamps: false, session },
      );
      if (!version) {
        throw violationError({
          code: 'already_cancelled',
          period: target.effectiveFrom,
          versionId: String(target._id),
        });
      }
      await BillingAuditEntry.create(
        [
          {
            action: BillingAuditAction.VENDOR_RATE_OVERRIDE_CANCELLED,
            actor: toStoredActor(actor),
            reason,
            subject: { kind: BillingAuditSubject.VENDOR_RATE_OVERRIDE, id: target._id },
            details: {
              plan: vendor.plan,
              currency: target.currency,
              effectiveFrom: target.effectiveFrom,
              changes: check.changes,
            },
          },
        ],
        { session },
      );
      return { version, changes: check.changes };
    });

    logger.info(`${TAG} rate override ${id} cancelled by ${actor.email}`);
    return result;
  });

// What the vendor pays in `period` (default: this month), and every later
// month in which that changes.
//
// The plan side uses the vendor's CURRENT plan for every month. That is exact
// today because nothing changes a vendor's plan yet; scheduling plan changes
// (with the same future-month and notice rules) is an open question on #53.
export const getVendorEffectiveRates = (
  vendor: VendorBillingRef,
  currency: Currency,
  period?: BillingPeriod,
  now: Date = new Date(),
): Promise<VendorRatesView> =>
  inVendor(vendor, async () => {
    const plan = await loadPlanTimeline(vendor.plan, currency);
    const overrides = await loadOverrideTimeline(currency);
    const currentPeriod = periodOf(now, BILLING_TIME_ZONE);
    return {
      currentPeriod,
      effective: resolveEffectiveRates(period ?? currentPeriod, plan, overrides),
      upcoming: upcomingRateChanges(currentPeriod, plan, overrides),
    };
  });
