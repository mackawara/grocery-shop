import { createHash } from 'node:crypto';
import axios from 'axios';
import { CONFIG } from '../../config.ts';
import { logger } from '../../services/logger.ts';
import { requireTenantId, runWithTenant, runWithoutTenant } from '../../context/tenantContext.ts';
import ProductModel from '../../models/Product.ts';
import type { IProduct } from '../../models/Product.ts';
import { ProductStatus, CatalogSyncStatus } from '../../constants/models.ts';
import {
  CATALOG_BATCH_LIMIT,
  CATALOG_SYNC_MAX_RETRIES,
  CATALOG_SYNC_RETRY_BASE_MS,
} from '../../constants/catalog.ts';
import TenantModel from '../../models/Tenant.ts';
import {
  toMetaProductRequest,
  MetaBatchMethod,
  ProductNotSyncableError,
} from '../../utils/metaProductFeed.ts';
import type { MetaBatchRequest, MetaExportTenant } from '../../utils/metaProductFeed.ts';

const TAG = '[CATALOG_SYNC]';

const GRAPH_BASE_URL = `https://graph.facebook.com/${CONFIG.WHATSAPP_GRAPH_API_VERSION}`;

export interface CatalogSyncResult {
  tenantId: string;
  total: number; // products considered
  pushed: number; // create/update/delete requests actually sent to Meta
  skipped: number; // no-op (content unchanged since last successful sync)
  notReady: number; // missing required fields / not published — excluded
  failed: number; // requests Meta (or the network) rejected
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Fingerprint of the exact payload we would send for a product. Stored on the
// product as `contentHash` after a successful sync; on the next run, if the
// freshly-built request hashes to the same value the product is unchanged and we
// skip the API call (no-op). Not for security — just cheap change detection.
const hashRequest = (request: MetaBatchRequest): string =>
  createHash('sha1').update(JSON.stringify(request)).digest('hex');

/**
 * Low-level: push one chunk of item requests to a tenant's Meta catalog.
 * Retries transient failures. Throws on permanent failure or exhausted retries;
 * the caller records the error against the affected products.
 */
const sendItemsBatch = async (catalogId: string, requests: MetaBatchRequest[]): Promise<void> => {
  const url = `${GRAPH_BASE_URL}/${catalogId}/items_batch`;
  const body = {
    item_type: 'PRODUCT_ITEM',
    allow_upsert: true,
    requests,
  };

  let attempt = 0;
  for (;;) {
    try {
      await axios(url, {
        method: 'POST',
        headers: {
          // WHATSAPP_SYSTEM_TOKEN is a system-user token with catalog access.
          // Never logged. ASSUMES all tenant catalogs live under our own
          // WABA/Business Manager. TODO: if tenants ever bring their own Meta
          // assets, this needs per-tenant credentials (like paymentCredentials).
          Authorization: `Bearer ${CONFIG.WHATSAPP_SYSTEM_TOKEN}`,
          'Content-Type': 'application/json',
        },
        data: JSON.stringify(body),
      });
      return;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const transient = status === 429 || (status !== undefined && status >= 500);
      attempt += 1;
      if (!transient || attempt > CATALOG_SYNC_MAX_RETRIES) {
        // Surface Meta's error message (never the token) for the caller to store.
        const metaMessage = axios.isAxiosError(error)
          ? (error.response?.data?.error?.message ?? error.message)
          : String(error);
        throw new Error(metaMessage, { cause: error });
      }
      const backoff = CATALOG_SYNC_RETRY_BASE_MS * 2 ** (attempt - 1);
      logger.warn(
        `${TAG} items_batch transient error (status=${status}), retry ${attempt} in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
};

// Decide the Meta operation for a product from its lifecycle status.
// DRAFT products are never published; ACTIVE upserts; ARCHIVED deletes.
const resolveMethod = (product: IProduct): MetaBatchMethod | null => {
  switch (product.status) {
    case ProductStatus.ARCHIVED:
      return MetaBatchMethod.DELETE;
    case ProductStatus.ACTIVE:
      return MetaBatchMethod.UPDATE; // allow_upsert creates if missing
    default:
      return null; // DRAFT — skip
  }
};

interface PreparedItem {
  product: IProduct;
  request: MetaBatchRequest;
  hash: string;
}

/**
 * Sync the current tenant's products to their Meta (Facebook) catalog.
 * MUST run inside runWithTenant. Pass `productIds` to sync a specific set,
 * otherwise every PENDING product is swept. `force` re-pushes even unchanged
 * items. Out-of-stock products ARE synced (so they show as out of stock).
 */
export const syncTenantCatalog = async (options?: {
  productIds?: string[];
  force?: boolean;
}): Promise<CatalogSyncResult> => {
  const tenantId = requireTenantId('syncTenantCatalog');
  const result: CatalogSyncResult = {
    tenantId,
    total: 0,
    pushed: 0,
    skipped: 0,
    notReady: 0,
    failed: 0,
  };

  // Tenant is not tenant-scoped (it is the tenant); a plain read is correct.
  const tenant = await TenantModel.findById(tenantId)
    .select('displayName whatsappCatalogId facebookPageUrl')
    .lean();
  if (!tenant?.whatsappCatalogId) {
    logger.warn(`${TAG} Tenant has no whatsappCatalogId — nothing to sync`);
    return result;
  }
  const exportTenant: MetaExportTenant = {
    facebookPageUrl: tenant.facebookPageUrl,
    displayName: tenant.displayName,
  };

  const filter = options?.productIds
    ? { _id: { $in: options.productIds } }
    : { syncStatus: CatalogSyncStatus.PENDING };
  const products = await ProductModel.find(filter); // tenant-scoped by plugin
  result.total = products.length;

  const prepared: PreparedItem[] = [];
  for (const product of products) {
    const method = resolveMethod(product);
    if (method === null) {
      result.notReady += 1;
      await ProductModel.updateOne(
        { _id: product._id },
        {
          $set: { syncStatus: CatalogSyncStatus.NOT_SYNCED, lastSyncError: 'draft not published' },
        },
      );
      continue;
    }

    let request: MetaBatchRequest;
    try {
      request = toMetaProductRequest(product, exportTenant, method);
    } catch (error) {
      if (error instanceof ProductNotSyncableError) {
        result.notReady += 1;
        await ProductModel.updateOne(
          { _id: product._id },
          {
            $set: {
              syncStatus: CatalogSyncStatus.NOT_SYNCED,
              lastSyncError: `missing: ${error.reasons.join(', ')}`,
            },
          },
        );
        continue;
      }
      throw error;
    }

    // contentHash is only written after a successful push, so a match means Meta
    // already has this exact payload — skip regardless of current syncStatus
    // (a product re-queued to PENDING by an unrelated edit still dedupes here).
    const hash = hashRequest(request);
    if (!options?.force && product.contentHash === hash) {
      // Meta already has this payload, so resolve the queue state too —
      // otherwise an edit to non-exported fields (e.g. minVehicle) leaves the
      // product PENDING forever. Guarded on updatedAt so a concurrent edit
      // (which re-queues with new content) is not stomped.
      if (product.syncStatus !== CatalogSyncStatus.SYNCED) {
        await ProductModel.updateOne(
          { _id: product._id, updatedAt: product.updatedAt },
          { $set: { syncStatus: CatalogSyncStatus.SYNCED, lastSyncError: null } },
        );
      }
      result.skipped += 1;
      continue;
    }
    prepared.push({ product, request, hash });
  }

  // Push in chunks; record success/failure per product in that chunk.
  for (let i = 0; i < prepared.length; i += CATALOG_BATCH_LIMIT) {
    const chunk = prepared.slice(i, i + CATALOG_BATCH_LIMIT);
    try {
      await sendItemsBatch(
        tenant.whatsappCatalogId,
        chunk.map((item) => item.request),
      );
      // TODO: batch these write-backs (Promise.all per chunk; bulkWrite is
      // intentionally refused by tenantScope).
      for (const item of chunk) {
        // Meta validates items_batch asynchronously and returns handles, not
        // per-item ids; fbItemId is reconciled later. A 2xx means accepted.
        // Guarded on updatedAt: if the vendor edited the product while the push
        // was in flight, the edit re-queued it PENDING with new content — this
        // stale SYNCED/contentHash write must lose so the edit gets pushed.
        await ProductModel.updateOne(
          { _id: item.product._id, updatedAt: item.product.updatedAt },
          {
            $set: {
              syncStatus: CatalogSyncStatus.SYNCED,
              lastSyncedAt: new Date(),
              contentHash: item.hash,
              lastSyncError: null,
            },
          },
        );
      }
      result.pushed += chunk.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${TAG} items_batch chunk failed: ${message}`);
      for (const item of chunk) {
        // Same updatedAt guard: a concurrent edit's PENDING outranks this ERROR.
        await ProductModel.updateOne(
          { _id: item.product._id, updatedAt: item.product.updatedAt },
          { $set: { syncStatus: CatalogSyncStatus.ERROR, lastSyncError: message } },
        );
      }
      result.failed += chunk.length;
    }
  }

  logger.info(
    `${TAG} done: total=${result.total} pushed=${result.pushed} skipped=${result.skipped} ` +
      `notReady=${result.notReady} failed=${result.failed}`,
  );
  return result;
};

/**
 * Sweep every tenant that has PENDING products and sync each within its own
 * tenant context. The cross-tenant discovery of which tenants have pending work
 * is the only step that runs under runWithoutTenant.
 *
 * TODO: nothing invokes this yet. Decision: sync/resync is triggered explicitly
 * from a dashboard endpoint (not a cron sweep) — add a session-scoped
 * POST /dashboard/products/sync endpoint that calls syncTenantCatalog
 * (with `force` for resync), so vendors can retry PENDING/ERROR products.
 */
export const syncAllPendingCatalogs = async (): Promise<CatalogSyncResult[]> => {
  const tenantIds = await runWithoutTenant(
    'catalog sync sweep',
    'distinct Product.tenantId where syncStatus=pending',
    () => ProductModel.distinct('tenantId', { syncStatus: CatalogSyncStatus.PENDING }),
  );

  const results: CatalogSyncResult[] = [];
  for (const tenantId of tenantIds) {
    try {
      const result = await runWithTenant(tenantId.toString(), () => syncTenantCatalog());
      results.push(result);
    } catch (error) {
      logger.error(`${TAG} sweep failed for tenant ${tenantId}: ${error}`);
    }
  }
  return results;
};
