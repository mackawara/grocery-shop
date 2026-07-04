import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../services/logger.ts';
import { DeliveryZoneKind, DeliveryRateKind, VehicleTier, Currency } from '../../constants/models.ts';
import {
  createZone,
  listZones,
  getZone,
  updateZone,
  deleteZone,
  createVehicle,
  listVehicles,
  getVehicle,
  updateVehicle,
  deleteVehicle,
  upsertRate,
  listRates,
  deleteRate,
} from '../../delivery/index.ts';
import type { ZoneInput, VehicleInput, RateInput } from '../../delivery/index.ts';
import type { DashboardActor } from '../middleware/dashboardAuthResolver.ts';

const TAG = '[delivery-config]';

// Tenant comes solely from the authenticated session (dashboardAuthResolver).
const tenantOf = (res: Response): string => (res.locals.actor as DashboardActor).tenantId;

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? 'Invalid request.';

// Map service/DB errors to HTTP responses.
const handleError = (error: unknown, res: Response): void => {
  if (typeof error === 'object' && error !== null) {
    const e = error as { code?: number; name?: string; message?: string };
    if (e.code === 11000) {
      res.status(409).json({ error: 'A record with that unique key already exists.' });
      return;
    }
    if (e.name === 'ValidationError') {
      res.status(400).json({ error: e.message ?? 'Validation failed.' });
      return;
    }
  }
  logger.error(`${TAG} unexpected error: ${error}`);
  res.status(500).json({ error: 'Something went wrong.' });
};

// --- Zone validation --------------------------------------------------------

const ringSchema = z.object({
  minKm: z.number().nonnegative(),
  maxKm: z.number().positive(),
});

const geometrySchema = z.object({
  type: z.enum(['Polygon', 'MultiPolygon']),
  coordinates: z.array(z.unknown()),
});

const zoneBase = {
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().max(20).optional(),
  kind: z.enum(DeliveryZoneKind),
  priority: z.number().int().optional(),
  active: z.boolean().optional(),
  ring: ringSchema.optional(),
  geometry: geometrySchema.optional(),
};

// On create the matcher must match the kind (the model also enforces this).
const zoneCreateSchema = z.object(zoneBase).refine(
  (z_) => (z_.kind === DeliveryZoneKind.RING ? Boolean(z_.ring) : Boolean(z_.geometry)),
  { message: 'ring is required for kind "ring"; geometry for kind "polygon"' },
);
const zoneUpdateSchema = z.object(zoneBase).partial();

// --- Vehicle validation -----------------------------------------------------

const dimensionsSchema = z.object({
  length: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

const vehicleCreateSchema = z.object({
  tier: z.enum(VehicleTier),
  name: z.string().trim().min(1).max(100),
  maxWeightKg: z.number().nonnegative(),
  maxDimensionsCm: dimensionsSchema.optional(),
  active: z.boolean().optional(),
});
const vehicleUpdateSchema = vehicleCreateSchema.partial();

// --- Rate-matrix validation ---------------------------------------------------

const moneySchema = z.object({
  amount: z.number().int().nonnegative(), // minor units
  currency: z.enum(Currency),
});

// A cell must carry the pricing fields its kind needs (the model re-checks too).
const rateUpsertSchema = z
  .object({
    zone: z.string().trim().min(1),
    tier: z.enum(VehicleTier),
    kind: z.enum(DeliveryRateKind),
    flat: moneySchema.optional(),
    base: moneySchema.optional(),
    perKm: moneySchema.optional(),
  })
  .refine((r) => (r.kind === DeliveryRateKind.FLAT ? Boolean(r.flat) : true), {
    message: 'flat amount is required for kind "flat"',
  })
  .refine(
    (r) => (r.kind === DeliveryRateKind.BASE_PER_KM ? Boolean(r.base && r.perKm) : true),
    { message: 'base and perKm are required for kind "base_per_km"' },
  );

// --- Zone handlers ----------------------------------------------------------

export const createZoneHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = zoneCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const zone = await createZone(tenantOf(res), parsed.data as ZoneInput);
    res.status(201).json({ zone });
  } catch (error) {
    handleError(error, res);
  }
};

export const listZonesHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const zones = await listZones(tenantOf(res));
    res.status(200).json({ zones });
  } catch (error) {
    handleError(error, res);
  }
};

export const getZoneHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const zone = await getZone(tenantOf(res), String(req.params.id));
    if (!zone) {
      res.status(404).json({ error: 'Zone not found.' });
      return;
    }
    res.status(200).json({ zone });
  } catch (error) {
    handleError(error, res);
  }
};

export const updateZoneHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = zoneUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const id = String(req.params.id);
    const zone = await updateZone(tenantOf(res), id, parsed.data as Partial<ZoneInput>);
    if (!zone) {
      res.status(404).json({ error: 'Zone not found.' });
      return;
    }
    res.status(200).json({ zone });
  } catch (error) {
    handleError(error, res);
  }
};

export const deleteZoneHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteZone(tenantOf(res), String(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: 'Zone not found.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    handleError(error, res);
  }
};

// --- Vehicle handlers -------------------------------------------------------

export const createVehicleHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = vehicleCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const vehicle = await createVehicle(tenantOf(res), parsed.data as VehicleInput);
    res.status(201).json({ vehicle });
  } catch (error) {
    handleError(error, res);
  }
};

export const listVehiclesHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const vehicles = await listVehicles(tenantOf(res));
    res.status(200).json({ vehicles });
  } catch (error) {
    handleError(error, res);
  }
};

export const getVehicleHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const vehicle = await getVehicle(tenantOf(res), String(req.params.id));
    if (!vehicle) {
      res.status(404).json({ error: 'Vehicle not found.' });
      return;
    }
    res.status(200).json({ vehicle });
  } catch (error) {
    handleError(error, res);
  }
};

export const updateVehicleHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = vehicleUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const id = String(req.params.id);
    const vehicle = await updateVehicle(tenantOf(res), id, parsed.data as Partial<VehicleInput>);
    if (!vehicle) {
      res.status(404).json({ error: 'Vehicle not found.' });
      return;
    }
    res.status(200).json({ vehicle });
  } catch (error) {
    handleError(error, res);
  }
};

export const deleteVehicleHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteVehicle(tenantOf(res), String(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: 'Vehicle not found.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    handleError(error, res);
  }
};

// --- Rate-matrix handlers -----------------------------------------------------

export const listRatesHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const rates = await listRates(tenantOf(res));
    res.status(200).json({ rates });
  } catch (error) {
    handleError(error, res);
  }
};

// PUT semantics: the (zone, tier) pair identifies the cell; create or replace.
export const upsertRateHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = rateUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    // Reject cells pointing at another tenant's (or a nonexistent) zone before
    // writing — the zone read is tenant-scoped, so a foreign id comes back null.
    const zone = await getZone(tenantOf(res), parsed.data.zone);
    if (!zone) {
      res.status(404).json({ error: 'Zone not found.' });
      return;
    }
    const rate = await upsertRate(tenantOf(res), parsed.data as RateInput);
    res.status(200).json({ rate });
  } catch (error) {
    handleError(error, res);
  }
};

export const deleteRateHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteRate(tenantOf(res), String(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: 'Rate not found.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    handleError(error, res);
  }
};
