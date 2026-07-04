import { logger } from '../services/logger.ts';
import { runWithTenant } from '../context/tenantContext.ts';
import { haversineKm } from '../utils/geo.ts';
import DeliveryZoneModel, { DeliveryZoneKind } from './models/DeliveryZone.ts';
import type { IDeliveryZone, IZoneRing, IZoneGeometry } from './models/DeliveryZone.ts';
import { deleteRatesForZone } from './rate.service.ts';
import type { GeoPoint } from './types.ts';

const TAG = '[DELIVERY_ZONE]';

export interface ZoneInput {
  name: string;
  code?: string;
  kind: DeliveryZoneKind;
  priority?: number;
  active?: boolean;
  ring?: IZoneRing;
  geometry?: IZoneGeometry;
}

// --- Zone CRUD. Each scopes itself with tenantId (runWithTenant); create/save
// run the model's pre-validate (matcher must match kind). ---

export const createZone = (tenantId: string, input: ZoneInput): Promise<IDeliveryZone> =>
  runWithTenant(tenantId, () => DeliveryZoneModel.create(input));

export const listZones = (tenantId: string): Promise<IDeliveryZone[]> =>
  runWithTenant(tenantId, () => DeliveryZoneModel.find().sort({ priority: 1 }));

export const getZone = (tenantId: string, id: string): Promise<IDeliveryZone | null> =>
  runWithTenant(tenantId, () => DeliveryZoneModel.findById(id));

export const updateZone = (
  tenantId: string,
  id: string,
  patch: Partial<ZoneInput>,
): Promise<IDeliveryZone | null> =>
  runWithTenant(tenantId, async () => {
    const zone = await DeliveryZoneModel.findById(id);
    if (!zone) {
      return null;
    }
    zone.set(patch);
    await zone.save(); // re-runs the kind/matcher validation
    return zone;
  });

export const deleteZone = (tenantId: string, id: string): Promise<boolean> =>
  runWithTenant(tenantId, async () => {
    const result = await DeliveryZoneModel.deleteOne({ _id: id });
    if (result.deletedCount > 0) {
      // Cascade: a deleted zone's rate-matrix cells are meaningless — drop them
      // so the matrix never points at a zone that no longer exists.
      const removed = await deleteRatesForZone(tenantId, id);
      if (removed > 0) {
        logger.info(`${TAG} cascade-deleted ${removed} rate cell(s) for zone ${id}`);
      }
    }
    return result.deletedCount > 0;
  });

/**
 * Resolve which of a tenant's delivery zones a GPS pin falls in.
 *
 * Scopes itself with the given tenantId. `shopOrigin` is passed in by the caller
 * (the service never reads the Tenant model) — it's the anchor for ring zones;
 * pass undefined if the shop has no location, and ring zones are skipped.
 *
 * Polygon zones are matched by MongoDB ($geoIntersects), ring zones by haversine
 * distance from the shop. When several zones match, the lowest `priority` wins.
 * Returns null when the point is in no active zone (caller treats as out-of-area).
 */
export const resolveZone = (
  tenantId: string,
  shopOrigin: GeoPoint | undefined,
  point: GeoPoint,
): Promise<IDeliveryZone | null> =>
  runWithTenant(tenantId, async () => {
    const matches: IDeliveryZone[] = [];

    // 1. Polygon zones whose boundary geometrically contains the point. Mongo
    //    does the point-in-polygon work against the 2dsphere index. GeoJSON
    //    order is [longitude, latitude].
    const polygonMatches = await DeliveryZoneModel.find({
      kind: DeliveryZoneKind.POLYGON,
      active: true,
      geometry: {
        $geoIntersects: {
          $geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
        },
      },
    });
    matches.push(...polygonMatches);

    // 2. Ring zones: distance from the shop must fall in [minKm, maxKm).
    const ringZones = await DeliveryZoneModel.find({
      kind: DeliveryZoneKind.RING,
      active: true,
    });
    if (ringZones.length > 0) {
      if (shopOrigin) {
        const km = haversineKm(shopOrigin, point);
        for (const zone of ringZones) {
          if (zone.ring && km >= zone.ring.minKm && km < zone.ring.maxKm) {
            matches.push(zone);
          }
        }
      } else {
        logger.warn(`${TAG} no shopOrigin provided — ring zones skipped`);
      }
    }

    if (matches.length === 0) {
      return null;
    }
    matches.sort((a, b) => a.priority - b.priority);
    return matches[0];
  });
