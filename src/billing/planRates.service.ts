import type { ClientSession } from 'mongoose';
import { BillingAuditAction, BillingAuditSubject } from '../constants/billing.ts';
import type { Currency, TenantPlan } from '../constants/models.ts';
import { logger } from '../services/logger.ts';
import { BillingRuleError, violationError } from './errors.ts';
import { PlatformBillingAuditEntry } from './models/BillingAuditEntry.ts';
import PlanRateVersion from './models/PlanRateVersion.ts';
import type { IPlanRateVersion } from './models/PlanRateVersion.ts';
import type { BillingPeriod } from './period.ts';
import { checkCancelVersion, checkScheduleVersion } from './rates.ts';
import type { RateChange } from './rates.ts';
import { inBillingTransaction, toRateVersion, toStoredActor } from './records.ts';
import type { BillingActor, RateCard, RateVersion } from './types.ts';

// Plan rate cards: global, so no tenant context is involved. Every change is a
// new version or a cancellation, written with its platform audit entry in one
// transaction (see models/PlanRateVersion.ts).

const TAG = '[billing]';

export interface PlanRateInput {
  plan: TenantPlan;
  currency: Currency;
  effectiveFrom: BillingPeriod;
  rates: RateCard;
  reason: string;
}

export interface PlanRateResult {
  version: IPlanRateVersion;
  changes: RateChange[];
}

export interface PlanRateFilter {
  plan?: TenantPlan;
  currency?: Currency;
}

// Every version, cancelled ones included: the full rate history (F2).
export const listPlanRateVersions = (filter: PlanRateFilter = {}): Promise<IPlanRateVersion[]> =>
  PlanRateVersion.find(filter).sort({ plan: 1, currency: 1, effectiveFrom: 1, createdAt: 1 });

// One plan's timeline in one currency, as the rules see it.
export const loadPlanTimeline = async (
  plan: TenantPlan,
  currency: Currency,
  session?: ClientSession,
): Promise<RateVersion[]> => {
  const records = await PlanRateVersion.find({ plan, currency })
    .sort({ effectiveFrom: 1, createdAt: 1 })
    .session(session ?? null)
    .lean();
  return records.map(toRateVersion);
};

export const schedulePlanRate = async (
  input: PlanRateInput,
  actor: BillingActor,
  now: Date = new Date(),
): Promise<PlanRateResult> => {
  const result = await inBillingTransaction(async (session) => {
    const plan = await loadPlanTimeline(input.plan, input.currency, session);
    const check = checkScheduleVersion({
      kind: 'plan',
      plan,
      proposed: { effectiveFrom: input.effectiveFrom, rates: input.rates },
      now,
    });
    if (!check.ok) {
      throw violationError(check.violation);
    }

    const [version] = await PlanRateVersion.create(
      [
        {
          plan: input.plan,
          currency: input.currency,
          effectiveFrom: input.effectiveFrom,
          ...input.rates,
          reason: input.reason,
          createdBy: toStoredActor(actor),
        },
      ],
      { session },
    );
    await PlatformBillingAuditEntry.create(
      [
        {
          action: BillingAuditAction.PLAN_RATE_SCHEDULED,
          actor: toStoredActor(actor),
          reason: input.reason,
          subject: { kind: BillingAuditSubject.PLAN_RATE, id: version._id },
          details: {
            plan: input.plan,
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
    `${TAG} plan rate ${String(result.version._id)} scheduled: ${input.plan}/${input.currency} ` +
      `from ${input.effectiveFrom} by ${actor.email}`,
  );
  return result;
};

export const cancelPlanRate = async (
  id: string,
  reason: string,
  actor: BillingActor,
  now: Date = new Date(),
): Promise<PlanRateResult> => {
  const result = await inBillingTransaction(async (session) => {
    const target = await PlanRateVersion.findById(id).session(session).lean();
    if (!target) {
      throw new BillingRuleError('not_found', 'Plan rate not found.');
    }
    const plan = await loadPlanTimeline(target.plan, target.currency, session);
    const check = checkCancelVersion({ kind: 'plan', plan, target: toRateVersion(target), now });
    if (!check.ok) {
      throw violationError(check.violation);
    }

    const cancellation = { at: now, by: toStoredActor(actor), reason };
    // The filter re-asserts `cancelled: false`, so a concurrent cancellation
    // matches nothing here instead of overwriting the first one's record.
    const version = await PlanRateVersion.findOneAndUpdate(
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
    await PlatformBillingAuditEntry.create(
      [
        {
          action: BillingAuditAction.PLAN_RATE_CANCELLED,
          actor: toStoredActor(actor),
          reason,
          subject: { kind: BillingAuditSubject.PLAN_RATE, id: target._id },
          details: {
            plan: target.plan,
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

  logger.info(`${TAG} plan rate ${id} cancelled by ${actor.email}`);
  return result;
};
