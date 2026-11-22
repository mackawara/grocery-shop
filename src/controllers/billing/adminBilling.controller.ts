import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import {
  BASIS_POINTS_PER_WHOLE,
  BILLING_CURRENCIES,
  BILLING_TIME_ZONE,
} from '../../constants/billing.ts';
import { Currency, TenantPlan } from '../../constants/models.ts';
import Tenant from '../../models/Tenant.ts';
import {
  BillingRuleError,
  cancelPlanRate,
  cancelVendorRateOverride,
  getVendorEffectiveRates,
  isBillingPeriod,
  listPlanRateVersions,
  listPlatformBillingAudit,
  listVendorBillingAudit,
  listVendorRateOverrides,
  periodOf,
  schedulePlanRate,
  scheduleVendorRateOverride,
  toRateVersion,
  versionStatus,
} from '../../billing/index.ts';
import type {
  BillingActor,
  BillingErrorCode,
  BillingPeriod,
  IBillingAuditEntry,
  IPlanRateVersion,
  IPlatformBillingAuditEntry,
  IVendorRateOverride,
  RateVersion,
  VendorBillingRef,
} from '../../billing/index.ts';
import type { PlatformActor } from '../middleware/platformAdminResolver.ts';
import { logger } from '../../services/logger.ts';

// Super-admin billing endpoints (issue #53, bucket 1): plan rate cards,
// per-vendor rate overrides, effective rates and the billing audit log.
//
// Mounted behind platformAdminResolver, so these run with NO tenant context.
// Plan rate cards are global. Everything vendor-specific goes through the
// billing services, which enter that vendor's tenant context themselves; the
// tenant id in the path is resolved against the (global) Tenant collection
// first, so an unknown id is a 404 and never reaches tenant-owned data.

const TAG = '[admin-billing]';

// --- Validation -------------------------------------------------------------

const firstIssue = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) {
    return 'Invalid request.';
  }
  return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
};

const moneySchema = z.strictObject({
  amount: z.number().int().nonnegative(), // minor units, e.g. 2500 = $25.00
  currency: z.enum(Currency),
});

const billingCurrencySchema = z.enum(Currency).refine((c) => BILLING_CURRENCIES.includes(c), {
  message: `Billing is priced in ${BILLING_CURRENCIES.join(', ')} only for now.`,
});

const periodSchema = z.string().refine(isBillingPeriod, {
  message: 'Expected a billing month written YYYY-MM.',
});

const reasonSchema = z
  .string()
  .trim()
  .min(3, 'A reason (at least 3 characters) is required.')
  .max(500);

const commissionBpsSchema = z.number().int().min(0).max(BASIS_POINTS_PER_WHOLE);

const MONEY_FIELDS = ['setupFee', 'monthlyFee', 'commissionFixedFee'] as const;

type MoneyFieldsShape = { currency: Currency } & Partial<
  Record<(typeof MONEY_FIELDS)[number], { currency: Currency }>
>;

// Every amount must be in the rate's own currency (the key it is filed under).
const sameCurrency = (value: MoneyFieldsShape, ctx: z.RefinementCtx): void => {
  for (const field of MONEY_FIELDS) {
    const money = value[field];
    if (money && money.currency !== value.currency) {
      ctx.addIssue({
        code: 'custom',
        path: [field, 'currency'],
        message: `Must be ${value.currency}, the rate's currency.`,
      });
    }
  }
};

// Strict objects: an unknown key (say, createdBy or tenantId) is rejected, not
// silently dropped.
const planRateCreateSchema = z
  .strictObject({
    plan: z.enum(TenantPlan),
    currency: billingCurrencySchema,
    effectiveFrom: periodSchema,
    setupFee: moneySchema,
    monthlyFee: moneySchema,
    commissionBps: commissionBpsSchema,
    commissionFixedFee: moneySchema,
    reason: reasonSchema,
  })
  .superRefine(sameCurrency);

// Only the overridden fields; anything left out follows the plan. Sending no
// rate fields at all schedules a return to plain plan pricing.
const overrideCreateSchema = z
  .strictObject({
    currency: billingCurrencySchema,
    effectiveFrom: periodSchema,
    setupFee: moneySchema.optional(),
    monthlyFee: moneySchema.optional(),
    commissionBps: commissionBpsSchema.optional(),
    commissionFixedFee: moneySchema.optional(),
    reason: reasonSchema,
  })
  .superRefine(sameCurrency);

const cancelSchema = z.strictObject({ reason: reasonSchema });

const planRateQuerySchema = z.object({
  plan: z.enum(TenantPlan).optional(),
  currency: z.enum(Currency).optional(),
});

const overrideQuerySchema = z.object({ currency: z.enum(Currency).optional() });

const effectiveRatesQuerySchema = z.object({
  currency: billingCurrencySchema.optional(),
  period: periodSchema.optional(),
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z
    .string()
    .regex(/^[0-9a-f]{24}$/i, 'before must be an audit entry id.')
    .optional(),
});

// --- Helpers ----------------------------------------------------------------

const actorOf = (res: Response): BillingActor => {
  const actor = res.locals.platformActor as PlatformActor | undefined;
  if (!actor) {
    // platformAdminResolver sets this before any admin handler runs.
    throw new Error('platform actor missing; is the route behind platformAdminResolver?');
  }
  return { platformUserId: actor.platformUserId, email: actor.email };
};

const currentPeriod = (): BillingPeriod => periodOf(new Date(), BILLING_TIME_ZONE);

// Resolve the vendor named in the path. Tenant is not tenant-scoped, so this
// needs no context; responds and returns undefined when there is no such vendor.
const loadVendor = async (req: Request, res: Response): Promise<VendorBillingRef | undefined> => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    res.status(400).json({ error: 'Invalid tenant id.' });
    return undefined;
  }
  // Hydrated rather than lean so the schema default for `plan` applies to any
  // tenant stored before the field existed, exactly as other Tenant reads see it.
  const tenant = await Tenant.findById(id).select('slug plan');
  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found.' });
    return undefined;
  }
  return { tenantId: String(tenant._id), slug: tenant.slug, plan: tenant.plan };
};

const STATUS_BY_CODE: Record<BillingErrorCode, number> = {
  not_found: 404,
  already_cancelled: 409,
  period_taken: 409,
  not_future: 422,
  in_effect: 422,
  insufficient_notice: 422,
};

const handleError = (error: unknown, res: Response): void => {
  if (error instanceof BillingRuleError) {
    res.status(STATUS_BY_CODE[error.code]).json({
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as { code?: number; name?: string; message?: string };
    if (e.code === 11000) {
      // Lost a race with a concurrent change for the same month.
      res.status(409).json({
        error: 'A rate version already starts in that billing month.',
        code: 'period_taken',
      });
      return;
    }
    if (e.name === 'ValidationError') {
      res.status(400).json({ error: e.message ?? 'Validation failed.' });
      return;
    }
  }
  logger.error(
    `${TAG} unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
};

// --- Response shapes --------------------------------------------------------

type RateRecord = IPlanRateVersion | IVendorRateOverride;

const actorDto = (actor: { platformUserId: Types.ObjectId; email: string }) => ({
  platformUserId: String(actor.platformUserId),
  email: actor.email,
});

const versionDto = (
  record: RateRecord,
  timeline: readonly RateVersion[],
  current: BillingPeriod,
) => {
  const version = toRateVersion(record);
  return {
    id: version.id,
    ...('plan' in record ? { plan: record.plan } : {}),
    currency: record.currency,
    effectiveFrom: record.effectiveFrom,
    ...version.rates,
    status: versionStatus(version, timeline, current),
    reason: record.reason,
    createdBy: actorDto(record.createdBy),
    createdAt: record.createdAt,
    ...(record.cancellation
      ? {
          cancellation: {
            at: record.cancellation.at,
            by: actorDto(record.cancellation.by),
            reason: record.cancellation.reason,
          },
        }
      : {}),
  };
};

// Status depends on the rest of a version's timeline, so group first.
const versionDtos = <R extends RateRecord>(records: R[], timelineKey: (record: R) => string) => {
  const current = currentPeriod();
  const timelines = new Map<string, RateVersion[]>();
  for (const record of records) {
    const key = timelineKey(record);
    const timeline = timelines.get(key) ?? [];
    timeline.push(toRateVersion(record));
    timelines.set(key, timeline);
  }
  return {
    currentPeriod: current,
    versions: records.map((record) =>
      versionDto(record, timelines.get(timelineKey(record)) ?? [], current),
    ),
  };
};

// A freshly scheduled or cancelled version, on its own.
const singleVersionDto = (record: RateRecord) =>
  versionDto(record, [toRateVersion(record)], currentPeriod());

const auditDto = (entry: IBillingAuditEntry | IPlatformBillingAuditEntry) => ({
  id: String(entry._id),
  action: entry.action,
  actor: actorDto(entry.actor),
  reason: entry.reason,
  subject: { kind: entry.subject.kind, id: String(entry.subject.id) },
  details: entry.details,
  createdAt: entry.createdAt,
});

const auditPageDto = (
  entries: (IBillingAuditEntry | IPlatformBillingAuditEntry)[],
  limit: number,
) => {
  const last = entries[entries.length - 1];
  return {
    entries: entries.map(auditDto),
    // Pass as `before` to fetch the next (older) page.
    ...(entries.length === limit && last ? { nextBefore: String(last._id) } : {}),
  };
};

// --- Plan rate cards (global) -----------------------------------------------

// GET /admin/billing/plan-rates?plan=&currency= — the full rate history.
export const listPlanRatesHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = planRateQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const records = await listPlanRateVersions(parsed.data);
    res.status(200).json(versionDtos(records, (r) => `${r.plan}:${r.currency}`));
  } catch (error) {
    handleError(error, res);
  }
};

// POST /admin/billing/plan-rates — schedule a new version of a plan's card.
export const schedulePlanRateHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = planRateCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const { plan, currency, effectiveFrom, reason, ...rates } = parsed.data;
    const result = await schedulePlanRate(
      { plan, currency, effectiveFrom, rates, reason },
      actorOf(res),
    );
    res.status(201).json({ version: singleVersionDto(result.version), changes: result.changes });
  } catch (error) {
    handleError(error, res);
  }
};

// POST /admin/billing/plan-rates/:rateId/cancel — withdraw a scheduled version.
export const cancelPlanRateHandler = async (req: Request, res: Response): Promise<void> => {
  const { rateId } = req.params;
  if (!isValidObjectId(rateId)) {
    res.status(400).json({ error: 'Invalid plan rate id.' });
    return;
  }
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const result = await cancelPlanRate(String(rateId), parsed.data.reason, actorOf(res));
    res.status(200).json({ version: singleVersionDto(result.version), changes: result.changes });
  } catch (error) {
    handleError(error, res);
  }
};

// GET /admin/billing/audit?limit=&before= — platform-level billing changes.
export const listPlatformBillingAuditHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const entries = await listPlatformBillingAudit(parsed.data);
    res.status(200).json(auditPageDto(entries, parsed.data.limit));
  } catch (error) {
    handleError(error, res);
  }
};

// --- Per-vendor (tenant-scoped) ---------------------------------------------

// GET /admin/tenants/:id/billing/rates?currency=&period= — what the vendor pays
// in a month (default: this one), field by field with its source, plus every
// upcoming change.
export const getVendorRatesHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = effectiveRatesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const vendor = await loadVendor(req, res);
    if (!vendor) {
      return;
    }
    const currency = parsed.data.currency ?? BILLING_CURRENCIES[0];
    const view = await getVendorEffectiveRates(vendor, currency, parsed.data.period);
    res.status(200).json({
      tenant: { id: vendor.tenantId, slug: vendor.slug, plan: vendor.plan },
      currency,
      ...view,
    });
  } catch (error) {
    handleError(error, res);
  }
};

// GET /admin/tenants/:id/billing/rate-overrides?currency= — override history.
export const listVendorRateOverridesHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = overrideQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const vendor = await loadVendor(req, res);
    if (!vendor) {
      return;
    }
    const records = await listVendorRateOverrides(vendor, parsed.data);
    res.status(200).json(versionDtos(records, (r) => r.currency));
  } catch (error) {
    handleError(error, res);
  }
};

// POST /admin/tenants/:id/billing/rate-overrides — schedule a new version of
// the vendor's overrides.
export const scheduleVendorRateOverrideHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = overrideCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const vendor = await loadVendor(req, res);
    if (!vendor) {
      return;
    }
    const { currency, effectiveFrom, reason, ...rates } = parsed.data;
    const result = await scheduleVendorRateOverride(
      vendor,
      { currency, effectiveFrom, rates, reason },
      actorOf(res),
    );
    res.status(201).json({ version: singleVersionDto(result.version), changes: result.changes });
  } catch (error) {
    handleError(error, res);
  }
};

// POST /admin/tenants/:id/billing/rate-overrides/:overrideId/cancel
export const cancelVendorRateOverrideHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { overrideId } = req.params;
  if (!isValidObjectId(overrideId)) {
    res.status(400).json({ error: 'Invalid rate override id.' });
    return;
  }
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const vendor = await loadVendor(req, res);
    if (!vendor) {
      return;
    }
    const result = await cancelVendorRateOverride(
      vendor,
      String(overrideId),
      parsed.data.reason,
      actorOf(res),
    );
    res.status(200).json({ version: singleVersionDto(result.version), changes: result.changes });
  } catch (error) {
    handleError(error, res);
  }
};

// GET /admin/tenants/:id/billing/audit?limit=&before= — the vendor's billing
// audit log.
export const listVendorBillingAuditHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const vendor = await loadVendor(req, res);
    if (!vendor) {
      return;
    }
    const entries = await listVendorBillingAudit(vendor, parsed.data);
    res.status(200).json(auditPageDto(entries, parsed.data.limit));
  } catch (error) {
    handleError(error, res);
  }
};
