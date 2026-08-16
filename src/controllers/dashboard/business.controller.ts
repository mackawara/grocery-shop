import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../services/logger.ts';
import Tenant from '../../models/Tenant.ts';
import { requireTenantId } from '../../context/tenantContext.ts';
import { DeliveryMethod } from '../../constants/models.ts';
import { seedDefaultDeliverySetup } from '../../delivery/index.ts';

const TAG = '[dashboard-business]';

// The tenant's own profile. Everything here runs behind dashboardAuthResolver,
// which has established the tenant context — the id never comes from the client.
//
// Only the operational fields are editable. displayName/slug/email are
// deliberately read-only: the slug is the tenant's identity in Paynow callback
// URLs and the Authentik group name, so renaming is a migration, not a settings
// toggle. Payment methods stay out too — they belong with payment credentials.
const PROFILE_FIELDS =
  'displayName slug email country status address location_gps deliveryMethods paymentMethods facebookPageUrl';

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? 'Invalid request.';

const gpsSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const addressSchema = z.object({
  streetNumber: z.string().trim().max(20).optional(),
  streetName: z.string().trim().max(120).optional(),
  area: z.string().trim().max(120).optional(),
  subArea: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
});

const updateSchema = z
  .object({
    address: addressSchema.optional(),
    // The shop origin. Ring zones are measured from here and per-km cells are
    // priced from here, so a tenant without it cannot quote a delivery at all.
    location_gps: gpsSchema.optional(),
    deliveryMethods: z.array(z.enum(DeliveryMethod)).min(1).optional(),
    facebookPageUrl: z.url().max(500).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update.' });

// GET /dashboard/business — the tenant profile the settings page edits.
export const getBusinessHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await Tenant.findById(requireTenantId('business profile read'))
      .select(PROFILE_FIELDS)
      .lean();
    if (!tenant) {
      res.status(404).json({ error: 'Business not found.' });
      return;
    }
    res.status(200).json({ business: tenant });
  } catch (err) {
    logger.error(`${TAG} read failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not load your business profile. Please try again.' });
  }
};

// PATCH /dashboard/business — update the operational profile fields.
export const updateBusinessHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }

  try {
    const tenant = await Tenant.findById(requireTenantId('business profile update')).select(
      PROFILE_FIELDS,
    );
    if (!tenant) {
      res.status(404).json({ error: 'Business not found.' });
      return;
    }

    tenant.set(parsed.data);
    await tenant.save();

    if (parsed.data.location_gps) {
      logger.info(`${TAG} shop location set for tenant ${String(tenant._id)}`);
    }
    res.status(200).json({ business: tenant.toObject() });
  } catch (err) {
    logger.error(`${TAG} update failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not save your business profile. Please try again.' });
  }
};

// POST /dashboard/delivery/defaults — give this tenant the starter delivery
// setup. Idempotent: a tenant that already has a zone is left untouched. Exists
// for tenants created before seeding was wired into signup, and as the
// "start over from the defaults" button on the delivery page.
export const seedDeliveryDefaultsHandler = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const result = await seedDefaultDeliverySetup(requireTenantId('delivery defaults'));
    res.status(200).json(result);
  } catch (err) {
    logger.error(`${TAG} delivery seeding failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Could not set up your default delivery rates.' });
  }
};
