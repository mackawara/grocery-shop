import { logger } from '../../services/logger.ts';
import { runWithTenant } from '../../context/tenantContext.ts';
import ProductModel, { getProductSyncReadiness } from '../../models/Product.ts';
import type { IProduct, ProductFields } from '../../models/Product.ts';
import { ProductAvailability, ProductStatus, CatalogSyncStatus } from '../../constants/models.ts';

const TAG = '[PRODUCT]';

// Tenant-scoped product CRUD. MongoDB is the source of truth; Meta periodically
// fetches the public complete-replacement feed, so product writes never depend
// on a Graph API call. All reads/writes go through the tenantScope-plugged model.

// The caller-writable field set is the model's canonical ProductFields —
// tenantId (stamped by the plugin), sync metadata, and timestamps are excluded
// there by construction.
export type ProductInput = ProductFields;

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

// Keep quantity and availability consistent. Restocking is explicit: increasing
// quantity does not automatically make a deliberately unavailable item live.
export const applyInventoryState = (product: Pick<IProduct, 'quantity' | 'availability'>): void => {
  if (product.quantity === 0) {
    product.availability = ProductAvailability.OUT_OF_STOCK;
  }
};

// Validate ACTIVE feed readiness and retire the legacy per-item push state. A
// scheduled feed has no per-row acknowledgement, so claiming SYNCED/PENDING here
// would be misleading; ingestion status belongs in Meta Commerce Manager.
const applyFeedState = (product: IProduct): void => {
  applyInventoryState(product);
  if (product.status === ProductStatus.ACTIVE) {
    const readiness = getProductSyncReadiness(product);
    if (!readiness.ready) {
      throw new ProductNotPublishableError(product.sku, readiness.missing);
    }
  }
  product.syncStatus = CatalogSyncStatus.NOT_SYNCED;
  product.lastSyncError = undefined;
};

// Every operation takes an explicit tenantId and runs its body inside
// runWithTenant, so the tenant scope is established by the operation itself and
// never depends on an ambient caller context. Callers (HTTP handlers, the
// importer, scripts, jobs) just pass the tenant they're acting for.

export const createProduct = (tenantId: string, input: CreateProductInput): Promise<IProduct> =>
  runWithTenant(tenantId, async () => {
    const product = new ProductModel(input); // tenantId stamped by tenantScope on save
    applyFeedState(product);
    await product.save();
    logger.info(`${TAG} created ${product.sku} (status=${product.status})`);
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
    applyFeedState(product);
    await product.save();
    logger.info(`${TAG} updated ${product.sku}`);
    return product;
  });

// Publish a draft: DRAFT -> ACTIVE. Throws ProductNotPublishableError if the
// product is missing Meta-required fields (applyFeedState enforces readiness).
export const publishProduct = (tenantId: string, id: string): Promise<IProduct> =>
  updateProduct(tenantId, id, { status: ProductStatus.ACTIVE });

// Archive: -> ARCHIVED, which omits the item from the next complete feed refresh.
export const archiveProduct = (tenantId: string, id: string): Promise<IProduct> =>
  updateProduct(tenantId, id, { status: ProductStatus.ARCHIVED });

export const markProductOutOfStock = (tenantId: string, id: string): Promise<IProduct> =>
  updateProduct(tenantId, id, {
    availability: ProductAvailability.OUT_OF_STOCK,
    quantity: 0,
  });

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
