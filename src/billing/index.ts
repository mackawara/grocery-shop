// Public facade for vendor billing (issue #53). The rest of the codebase
// imports from here (`../billing/index.ts`), never from a file inside the
// module.
//
// Delivered so far (bucket 1): plan rate cards per plan and currency, per-vendor
// rate overrides, full rate history with future-month scheduling and notice
// rules, and the append-only billing audit log. Later buckets add waivers and
// promos, commission accrual, invoicing and collection on top of these.

export type {
  Money,
  RateCard,
  RateField,
  PartialRateCard,
  BillingActor,
  RateVersion,
} from './types.ts';

export type { BillingPeriod } from './period.ts';
export { isBillingPeriod, comparePeriods, addMonths, periodOf, periodStart } from './period.ts';

// Pure rules
export {
  RATE_FIELDS,
  DEFAULT_SCHEDULE_POLICY,
  versionInEffect,
  resolveEffectiveRates,
  diffRates,
  checkScheduleVersion,
  checkCancelVersion,
  versionStatus,
  upcomingRateChanges,
} from './rates.ts';
export type {
  EffectiveRates,
  RateDiff,
  RateChange,
  RateTimeline,
  SchedulePolicy,
  ScheduleViolation,
  ScheduleCheck,
} from './rates.ts';

export { BillingRuleError } from './errors.ts';
export type { BillingErrorCode } from './errors.ts';
export { ImmutableRecordError } from './models/plugins/immutableRecord.ts';

// Plan rate cards (global)
export {
  listPlanRateVersions,
  loadPlanTimeline,
  schedulePlanRate,
  cancelPlanRate,
} from './planRates.service.ts';
export type { PlanRateInput, PlanRateResult, PlanRateFilter } from './planRates.service.ts';
export { default as PlanRateVersion } from './models/PlanRateVersion.ts';
export type { IPlanRateVersion } from './models/PlanRateVersion.ts';

// Vendor overrides and effective rates (tenant-scoped)
export {
  listVendorRateOverrides,
  scheduleVendorRateOverride,
  cancelVendorRateOverride,
  getVendorEffectiveRates,
} from './vendorRates.service.ts';
export type {
  VendorBillingRef,
  VendorOverrideInput,
  VendorOverrideResult,
  VendorRatesView,
} from './vendorRates.service.ts';
export { default as VendorRateOverride } from './models/VendorRateOverride.ts';
export type { IVendorRateOverride } from './models/VendorRateOverride.ts';

// Audit log
export { listPlatformBillingAudit, listVendorBillingAudit } from './audit.service.ts';
export type { AuditPage } from './audit.service.ts';
export { BillingAuditEntry, PlatformBillingAuditEntry } from './models/BillingAuditEntry.ts';
export type { IBillingAuditEntry, IPlatformBillingAuditEntry } from './models/BillingAuditEntry.ts';
export { toRateVersion } from './records.ts';
