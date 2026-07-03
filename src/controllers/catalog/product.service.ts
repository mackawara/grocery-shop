import type { Document, Types } from 'mongoose';
import { logger } from '../../services/logger.ts';
import { requireTenantId, runWithTenant } from '../../context/tenantContext.ts';
import ProductModel, { getProductSyncReadiness } from '../../models/Product.ts';
import type { IProduct } from '../../models/Product.ts';
import { ProductStatus, CatalogSyncStatus } from '../../constants/models.ts';
import { syncTenantCatalog } from './catalogSync.controller.ts';

const TAG = '[PRODUCT]';

// Tenant-scoped product CRUD. Owns the catalog source of truth and the sync
// lifecycle: every write recomputes the product's syncStatus from its lifecycle
// status and, when that queues a push, nudges an immediate sync. Failed pushes
// stay PENDING/ERROR until retried explicitly — see the sync-endpoint TODO on
// syncAllPendingCatalogs. All reads/writes go through the tenantScope-plugged
// model, so they are automatically scoped to the current tenant context.

// Fields a caller may set on a product (everything except Mongoose internals,
// timestamps, tenantId — stamped by the plugin — and the sync bookkeeping we
// own here).
export type ProductInput = Omit<
  IProduct,
  | keyof Document
  | 'createdAt'
  | 'updatedAt'
  | 'tenantId'
  | 'syncStatus'
  | 'fbItemId'
  | 'lastSyncedAt'
  | 'lastSyncError'
  | 'contentHash'
>;

// status/availability/condition all have schema defaults, so they're optional on
// create (Mongoose fills them in).
export type CreateProductInput = Omit<ProductInput, 'status' | 'availability' | 'condition'> &
  Partial<Pick<ProductInput, 'status' | 'availability' | 'condition'>>;
// sku is the Meta retailer id and is immutable — changing it would orphan the
// catalog item (delete + recreate), so it can't be patched.
export type UpdateProductInput = Partial<Omit<ProductInput, 'sku'>>;

export class ProductNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Product not found: ${id}`);
    this.name = 'ProductNotFoundError';
  }
}

export class ProductNotPublishableError extends Error {
  constructor(
    public readonly sku: string,
    public readonly missing: string[],
  ) {
    super(`Product "${sku}" cannot be published — missing: ${missing.join(', ')}`);
    this.name = 'ProductNotPublishableError';
  }
}

// Recompute syncStatus from lifecycle status:
//  ACTIVE   -> should be live  -> PENDING (but must be sync-ready first)
//  ARCHIVED -> should be gone  -> PENDING (a DELETE)
//  DRAFT    -> not published   -> NOT_SYNCED (never queued)
const applySyncState = (product: IProduct): void => {
  switch (product.status) {
    case ProductStatus.ACTIVE: {
      const readiness = getProductSyncReadiness(product);
      if (!readiness.ready) {
        throw new ProductNotPublishableError(product.sku, readiness.missing);
      }
      product.syncStatus = CatalogSyncStatus.PENDING;
      break;
    }
    case ProductStatus.ARCHIVED:
      product.syncStatus = CatalogSyncStatus.PENDING;
      break;
    default:
      product.syncStatus = CatalogSyncStatus.NOT_SYNCED;
  }
};

// Fire-and-forget an immediate push when a write queued one. Detached from the
// request, so re-enter the tenant context explicitly; failures are logged and
// the product stays PENDING until an explicit retry (see the sync-endpoint
// TODO on syncAllPendingCatalogs).
const triggerSyncIfQueued = (product: IProduct): void => {
  if (product.syncStatus !== CatalogSyncStatus.PENDING) {
    return;
  }
  const tenantId = requireTenantId('triggerSyncIfQueued');
  const id = (product._id as Types.ObjectId).toString();
  void runWithTenant(tenantId, () => syncTenantCatalog({ productIds: [id] })).catch((error) => {
    logger.error(`${TAG} background sync failed for ${product.sku}: ${error}`);
  });
};

// Every operation takes an explicit tenantId and runs its body inside
// runWithTenant, so the tenant scope is established by the operation itself and
// never depends on an ambient caller context. Callers (HTTP handlers, the
// importer, scripts, jobs) just pass the tenant they're acting for.

export const createProduct = (
  tenantId: string,
  input: CreateProductInput,
  options?: { deferSync?: boolean },
): Promise<IProduct> =>
  runWithTenant(tenantId, async () => {
    const product = new ProductModel(input); // tenantId stamped by tenantScope on save
    applySyncState(product);
    await product.save();
    logger.info(`${TAG} created ${product.sku} (status=${product.status})`);
    // Bulk callers (the importer) defer the push and sync once at the end so a
    // large import is one batched API call instead of N fire-and-forgets.
    if (!options?.deferSync) {
      triggerSyncIfQueued(product);
    }
    return product;
  });

export const updateProduct = (
  tenantId: string,
  id: string,
  patch: UpdateProductInput,
): Promise<IProduct> =>
  runWithTenant(tenantId, async () => {
    const product = await ProductModel.findById(id); // tenant-scoped
    if (!product) {
      throw new ProductNotFoundError(id);
    }
    Object.assign(product, patch);
    applySyncState(product);
    await product.save();
    logger.info(`${TAG} updated ${product.sku}`);
    triggerSyncIfQueued(product);
    return product;
  });

// Publish a draft: DRAFT -> ACTIVE. Throws ProductNotPublishableError if the
// product is missing Meta-required fields (applySyncState enforces readiness).
export const publishProduct = (tenantId: string, id: string): Promise<IProduct> =>
  updateProduct(tenantId, id, { status: ProductStatus.ACTIVE });

// Archive: -> ARCHIVED, which queues a DELETE from the Meta catalog on next sync.
export const archiveProduct = (tenantId: string, id: string): Promise<IProduct> =>
  updateProduct(tenantId, id, { status: ProductStatus.ARCHIVED });

export const getProduct = (tenantId: string, id: string): Promise<IProduct | null> =>
  runWithTenant(tenantId, async () => ProductModel.findById(id)); // tenant-scoped

// TODO: add pagination (limit + cursor) before the dashboard builds against
// this shape — a vendor with thousands of SKUs makes an unbounded find heavy.
export const listProducts = (
  tenantId: string,
  filter?: {
    status?: ProductStatus;
    syncStatus?: CatalogSyncStatus;
  },
): Promise<IProduct[]> =>
  runWithTenant(tenantId, async () => ProductModel.find(filter ?? {}).sort({ updatedAt: -1 }));
