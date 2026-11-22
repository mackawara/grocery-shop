import {
  BILLING_TIME_ZONE,
  RATE_DECREASE_NOTICE_DAYS,
  RATE_INCREASE_NOTICE_DAYS,
  RateSource,
  RateVersionStatus,
} from '../constants/billing.ts';
import type { BillingPeriod } from './period.ts';
import { comparePeriods, periodOf, periodStart } from './period.ts';
import type { Money, PartialRateCard, RateField, RateVersion } from './types.ts';

// Rate resolution and the rate-change rules (decisions F1, F2). Pure: callers
// load the timelines and pass `now`. Keeping the rules free of I/O is what lets
// them be tested exhaustively and reused by invoicing later.

export const RATE_FIELDS: readonly RateField[] = [
  'setupFee',
  'monthlyFee',
  'commissionBps',
  'commissionFixedFee',
];

const DAY_MS = 86_400_000;

// --- Resolution -------------------------------------------------------------

type Versioned = Pick<RateVersion, 'effectiveFrom' | 'cancelled'>;

// The version that applies in `period`: the latest one, not cancelled, that
// starts in or before it.
export const versionInEffect = <V extends Versioned>(
  versions: readonly V[],
  period: BillingPeriod,
): V | undefined => {
  let found: V | undefined;
  for (const version of versions) {
    if (version.cancelled || comparePeriods(version.effectiveFrom, period) > 0) {
      continue;
    }
    if (!found || comparePeriods(version.effectiveFrom, found.effectiveFrom) > 0) {
      found = version;
    }
  }
  return found;
};

export interface EffectiveRates {
  period: BillingPeriod;
  // The fields that resolve. A field missing from both the plan card and the
  // override is listed in `missing` instead and is absent here.
  rates: PartialRateCard;
  sources: Partial<Record<RateField, RateSource>>;
  missing: RateField[];
  planVersionId?: string;
  overrideVersionId?: string;
}

const copyRate = <F extends RateField>(rates: PartialRateCard, field: F, value: unknown): void => {
  // Rebuild Money field by field so a hydrated Mongoose subdocument never
  // leaks its internals into what must be a plain value.
  if (typeof value === 'number') {
    (rates as Record<RateField, unknown>)[field] = value;
    return;
  }
  const money = value as Money;
  (rates as Record<RateField, unknown>)[field] = { amount: money.amount, currency: money.currency };
};

// What a vendor pays in `period`, field by field: the override's value where
// it sets one, else the plan card's (F1). An override version is a complete
// statement of the vendor's overrides from its month on, so a field it leaves
// out goes back to the plan rate.
export const resolveEffectiveRates = (
  period: BillingPeriod,
  planVersions: readonly RateVersion[],
  overrideVersions: readonly RateVersion[] = [],
): EffectiveRates => {
  const plan = versionInEffect(planVersions, period);
  const override = versionInEffect(overrideVersions, period);
  const rates: PartialRateCard = {};
  const sources: Partial<Record<RateField, RateSource>> = {};
  const missing: RateField[] = [];

  for (const field of RATE_FIELDS) {
    const overridden = override?.rates[field];
    const planned = plan?.rates[field];
    if (overridden !== undefined) {
      copyRate(rates, field, overridden);
      sources[field] = RateSource.OVERRIDE;
    } else if (planned !== undefined) {
      copyRate(rates, field, planned);
      sources[field] = RateSource.PLAN;
    } else {
      missing.push(field);
    }
  }

  return {
    period,
    rates,
    sources,
    missing,
    ...(plan ? { planVersionId: plan.id } : {}),
    ...(override ? { overrideVersionId: override.id } : {}),
  };
};

// --- Comparison -------------------------------------------------------------

const magnitude = (rates: PartialRateCard, field: RateField): number | undefined => {
  const value = rates[field];
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'number' ? value : value.amount;
};

export interface RateDiff {
  increased: RateField[];
  decreased: RateField[];
  // Gained a value it did not have (e.g. the very first rate card). Pricing
  // where there was none is not an increase over a known rate, so it does not
  // trigger the increase notice period.
  introduced: RateField[];
  // Lost its value, leaving nothing to charge from.
  removed: RateField[];
}

export const diffRates = (before: PartialRateCard, after: PartialRateCard): RateDiff => {
  const diff: RateDiff = { increased: [], decreased: [], introduced: [], removed: [] };
  for (const field of RATE_FIELDS) {
    const was = magnitude(before, field);
    const now = magnitude(after, field);
    if (was === undefined && now !== undefined) {
      diff.introduced.push(field);
    } else if (was !== undefined && now === undefined) {
      diff.removed.push(field);
    } else if (was !== undefined && now !== undefined && now > was) {
      diff.increased.push(field);
    } else if (was !== undefined && now !== undefined && now < was) {
      diff.decreased.push(field);
    }
  }
  return diff;
};

const isUnchanged = (diff: RateDiff): boolean =>
  !diff.increased.length &&
  !diff.decreased.length &&
  !diff.introduced.length &&
  !diff.removed.length;

const differs = (a: PartialRateCard, b: PartialRateCard): boolean => !isUnchanged(diffRates(a, b));

// --- Scheduling rules (F2) --------------------------------------------------
//
// 1. A change starts at the beginning of a FUTURE billing month — never the
//    current one (that would be mid-month) and never a past one (backdated).
// 2. A change that makes any charge dearer in some month needs at least
//    RATE_INCREASE_NOTICE_DAYS between now and the start of that month.
//
// "Dearer" is judged against what the schedule says that month would cost
// without the edit, field by field. Every month the edit changes is checked:
// a vendor-override edit can change several months at once, wherever the plan
// card itself changes inside the override's span.
//
// Why no lock serialises concurrent edits: if edits committed at the same time
// add up to a rise in some month, at least one of them is a rise on its own
// (≤ is transitive), and that edit's notice was checked at a month no later
// than the one where the vendor sees the rise, so the combined result still
// honours the rule. Two live versions in the same month are stopped by a
// partial unique index, not by this check.

export interface SchedulePolicy {
  timeZone: string;
  increaseNoticeDays: number;
  decreaseNoticeDays: number;
}

export const DEFAULT_SCHEDULE_POLICY: SchedulePolicy = {
  timeZone: BILLING_TIME_ZONE,
  increaseNoticeDays: RATE_INCREASE_NOTICE_DAYS,
  decreaseNoticeDays: RATE_DECREASE_NOTICE_DAYS,
};

export interface RateChange extends RateDiff {
  // First billing month the change applies to.
  period: BillingPeriod;
  before: PartialRateCard;
  after: PartialRateCard;
  // Whole days from now until `period` begins.
  noticeDays: number;
}

export type ScheduleViolation =
  | { code: 'not_future'; period: BillingPeriod; currentPeriod: BillingPeriod }
  | { code: 'period_taken'; period: BillingPeriod; versionId: string }
  | { code: 'in_effect'; period: BillingPeriod; currentPeriod: BillingPeriod }
  | { code: 'already_cancelled'; period: BillingPeriod; versionId: string }
  | {
      code: 'insufficient_notice';
      period: BillingPeriod;
      direction: 'increase' | 'decrease';
      fields: RateField[];
      requiredDays: number;
      noticeDays: number;
    };

export type ScheduleCheck =
  | { ok: true; changes: RateChange[] }
  | { ok: false; violation: ScheduleViolation };

// Which timeline an edit is on. A plan edit is judged on the plan card alone,
// which is exactly what every vendor who doesn't override a field will pay. A
// vendor edit is judged on that vendor's effective rates (plan + override).
export type RateTimeline = 'plan' | 'override';

interface Timelines {
  plan: readonly RateVersion[];
  overrides?: readonly RateVersion[];
}

const timelinesOf = (request: Timelines): Timelines => ({
  plan: request.plan,
  overrides: request.overrides ?? [],
});

const editedOf = (kind: RateTimeline, timelines: Timelines): readonly RateVersion[] =>
  kind === 'plan' ? timelines.plan : (timelines.overrides ?? []);

const withEdited = (
  kind: RateTimeline,
  timelines: Timelines,
  edited: readonly RateVersion[],
): Timelines =>
  kind === 'plan' ? { ...timelines, plan: edited } : { ...timelines, overrides: edited };

// Every month from `start` on at which either schedule can change value.
const changePoints = (start: BillingPeriod, schedules: Timelines[]): BillingPeriod[] => {
  const points = new Set<BillingPeriod>([start]);
  for (const schedule of schedules) {
    for (const version of [...schedule.plan, ...(schedule.overrides ?? [])]) {
      if (!version.cancelled && comparePeriods(version.effectiveFrom, start) > 0) {
        points.add(version.effectiveFrom);
      }
    }
  }
  return [...points].sort(comparePeriods);
};

const evaluateEdit = (
  start: BillingPeriod,
  before: Timelines,
  after: Timelines,
  now: Date,
  policy: SchedulePolicy,
): ScheduleCheck => {
  const changes: RateChange[] = [];
  for (const period of changePoints(start, [before, after])) {
    const was = resolveEffectiveRates(period, before.plan, before.overrides).rates;
    const will = resolveEffectiveRates(period, after.plan, after.overrides).rates;
    const diff = diffRates(was, will);
    if (isUnchanged(diff)) {
      continue;
    }
    const noticeMs = periodStart(period, policy.timeZone).getTime() - now.getTime();
    const noticeDays = Math.floor(noticeMs / DAY_MS);
    if (diff.increased.length && noticeMs < policy.increaseNoticeDays * DAY_MS) {
      return {
        ok: false,
        violation: {
          code: 'insufficient_notice',
          period,
          direction: 'increase',
          fields: diff.increased,
          requiredDays: policy.increaseNoticeDays,
          noticeDays,
        },
      };
    }
    if (diff.decreased.length && noticeMs < policy.decreaseNoticeDays * DAY_MS) {
      return {
        ok: false,
        violation: {
          code: 'insufficient_notice',
          period,
          direction: 'decrease',
          fields: diff.decreased,
          requiredDays: policy.decreaseNoticeDays,
          noticeDays,
        },
      };
    }
    changes.push({ period, before: was, after: will, noticeDays, ...diff });
  }
  return { ok: true, changes };
};

// Placeholder id for a version that does not exist yet.
const PROPOSED_ID = 'proposed';

export interface ScheduleRequest extends Timelines {
  kind: RateTimeline;
  proposed: { effectiveFrom: BillingPeriod; rates: PartialRateCard };
  now: Date;
  policy?: SchedulePolicy;
}

// May `proposed` be added to its timeline? On success, `changes` lists every
// month whose rates it changes, for the audit record.
export const checkScheduleVersion = (request: ScheduleRequest): ScheduleCheck => {
  const { kind, proposed, now, policy = DEFAULT_SCHEDULE_POLICY } = request;
  const current = periodOf(now, policy.timeZone);
  if (comparePeriods(proposed.effectiveFrom, current) <= 0) {
    return {
      ok: false,
      violation: { code: 'not_future', period: proposed.effectiveFrom, currentPeriod: current },
    };
  }
  const timelines = timelinesOf(request);
  const edited = editedOf(kind, timelines);
  const taken = edited.find((v) => !v.cancelled && v.effectiveFrom === proposed.effectiveFrom);
  if (taken) {
    return {
      ok: false,
      violation: { code: 'period_taken', period: proposed.effectiveFrom, versionId: taken.id },
    };
  }
  const candidate: RateVersion = {
    id: PROPOSED_ID,
    effectiveFrom: proposed.effectiveFrom,
    cancelled: false,
    rates: proposed.rates,
  };
  return evaluateEdit(
    proposed.effectiveFrom,
    timelines,
    withEdited(kind, timelines, [...edited, candidate]),
    now,
    policy,
  );
};

export interface CancellationRequest extends Timelines {
  kind: RateTimeline;
  target: RateVersion;
  now: Date;
  policy?: SchedulePolicy;
}

// May `target` be withdrawn? Only before it takes effect: once its month has
// started it is billing history. Withdrawing a scheduled decrease raises the
// rates for its months back up, so it is subject to the same notice rule.
export const checkCancelVersion = (request: CancellationRequest): ScheduleCheck => {
  const { kind, target, now, policy = DEFAULT_SCHEDULE_POLICY } = request;
  if (target.cancelled) {
    return {
      ok: false,
      violation: { code: 'already_cancelled', period: target.effectiveFrom, versionId: target.id },
    };
  }
  const current = periodOf(now, policy.timeZone);
  if (comparePeriods(target.effectiveFrom, current) <= 0) {
    return {
      ok: false,
      violation: { code: 'in_effect', period: target.effectiveFrom, currentPeriod: current },
    };
  }
  const timelines = timelinesOf(request);
  const remaining = editedOf(kind, timelines).filter((v) => v.id !== target.id);
  return evaluateEdit(
    target.effectiveFrom,
    timelines,
    withEdited(kind, timelines, remaining),
    now,
    policy,
  );
};

// --- Presentation helpers ---------------------------------------------------

export const versionStatus = (
  version: RateVersion,
  timeline: readonly RateVersion[],
  current: BillingPeriod,
): RateVersionStatus => {
  if (version.cancelled) {
    return RateVersionStatus.CANCELLED;
  }
  if (comparePeriods(version.effectiveFrom, current) > 0) {
    return RateVersionStatus.SCHEDULED;
  }
  return versionInEffect(timeline, current)?.id === version.id
    ? RateVersionStatus.IN_EFFECT
    : RateVersionStatus.SUPERSEDED;
};

// The months after `current` in which a vendor's effective rates change, with
// the rates from each. Feeds the "upcoming rate changes" view (F3).
export const upcomingRateChanges = (
  current: BillingPeriod,
  planVersions: readonly RateVersion[],
  overrideVersions: readonly RateVersion[] = [],
): EffectiveRates[] => {
  const schedule: Timelines = { plan: planVersions, overrides: overrideVersions };
  const upcoming: EffectiveRates[] = [];
  let previous = resolveEffectiveRates(current, planVersions, overrideVersions);
  for (const period of changePoints(current, [schedule])) {
    if (period === current) {
      continue;
    }
    const next = resolveEffectiveRates(period, planVersions, overrideVersions);
    if (differs(previous.rates, next.rates)) {
      upcoming.push(next);
    }
    previous = next;
  }
  return upcoming;
};
