import { logger } from '../../services/logger.ts';
import { runWithTenant } from '../../context/tenantContext.ts';
import type { IMoney } from '../../models/Product.ts';
import {
  ProductAvailability,
  ProductCondition,
  ProductStatus,
  Currency,
} from '../../constants/models.ts';
import { createProduct } from './product.service.ts';
import type { CreateProductInput } from './product.service.ts';
import { syncTenantCatalog } from './catalogSync.controller.ts';

const TAG = '[CATALOG_IMPORT]';

// Maps a Meta "catalog feed template" export into our Product model.
//
// The template has TWO header rows — long descriptions, then the machine field
// keys (id, title, price, ...) — with data below. This module works on already
// keyed rows (fieldKey -> value); turning the .xlsx/.csv bytes into those rows
// is the caller's job (upload adapter / script), so the mapping logic here stays
// format-agnostic and unit-testable.

export type FeedRow = Record<string, unknown>;

// Reverse of the export maps in metaProductFeed: Meta's space-separated strings
// back to our internal enums.
const AVAILABILITY_FROM_META: Record<string, ProductAvailability> = {
  'in stock': ProductAvailability.IN_STOCK,
  'out of stock': ProductAvailability.OUT_OF_STOCK,
  preorder: ProductAvailability.PREORDER,
  'available for order': ProductAvailability.AVAILABLE_FOR_ORDER,
  discontinued: ProductAvailability.DISCONTINUED,
};

const CONDITION_FROM_META: Record<string, ProductCondition> = {
  new: ProductCondition.NEW,
  used: ProductCondition.USED,
  refurbished: ProductCondition.REFURBISHED,
};

const SUPPORTED_CURRENCIES = new Set<string>(Object.values(Currency));

// Trimmed non-empty string, or undefined.
const str = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
};

// Non-negative integer quantity, or undefined when the column is empty. Throws
// on garbage ("abc", "-2", "1.5") so the row fails with a message the vendor
// can act on, instead of an opaque Mongoose NaN validation error.
const parseFeedQuantity = (value: unknown): number | undefined => {
  const raw = str(value);
  if (!raw) {
    return undefined;
  }
  const quantity = Number(raw.replace(/,/g, ''));
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(`Invalid quantity: "${raw}"`);
  }
  return quantity;
};

/**
 * Parse a Meta price string into our minor-units money. Tolerant of the real
 * dirty data seen in exports: "0.75 USD" and the space-less "22.00USD" both
 * work; thousands separators are stripped. Throws on an unparseable amount or an
 * unsupported currency.
 */
export const parseFeedMoney = (raw: string): IMoney => {
  const match = raw.trim().match(/^([\d.,]+)\s*([A-Za-z]{3})$/);
  if (!match) {
    throw new Error(`Unparseable price: "${raw}"`);
  }
  const amountMajor = Number(match[1].replace(/,/g, ''));
  const currency = match[2].toUpperCase();
  if (!Number.isFinite(amountMajor)) {
    throw new Error(`Invalid price amount: "${raw}"`);
  }
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  // All supported currencies are 2-decimal; round to guard float noise.
  return { amount: Math.round(amountMajor * 100), currency: currency as Currency };
};

// Collect indexed label columns (product_tags[0..] / custom_label_0..) into one
// list, capped at Meta's 5 custom labels.
const collectLabels = (row: FeedRow): string[] | undefined => {
  const labels: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (/^(product_tags\[\d+\]|custom_label_\d+)$/.test(key)) {
      const label = str(value);
      if (label) {
        labels.push(label);
      }
    }
  }
  return labels.length > 0 ? labels.slice(0, 5) : undefined;
};

/**
 * Map one keyed feed row to a CreateProductInput. Imported products are ACTIVE
 * (auto-sync). Missing weight/minVehicle is fine — those gate delivery
 * readiness, not import. Throws if a Meta-required field is missing/unparseable.
 */
export const mapFeedRowToInput = (row: FeedRow): CreateProductInput => {
  const sku = str(row.id);
  const title = str(row.title);
  const description = str(row.description);
  const priceRaw = str(row.price);
  const imageLink = str(row.image_link);

  if (!sku || !title || !description || !priceRaw) {
    throw new Error('missing required field (id, title, description or price)');
  }

  const availabilityRaw = str(row.availability)?.toLowerCase();
  const conditionRaw = str(row.condition)?.toLowerCase();

  const input: CreateProductInput = {
    sku,
    title,
    description,
    price: parseFeedMoney(priceRaw),
    status: ProductStatus.ACTIVE,
    availability: availabilityRaw ? AVAILABILITY_FROM_META[availabilityRaw] : undefined,
    condition: conditionRaw ? CONDITION_FROM_META[conditionRaw] : undefined,
    imageLink,
    brand: str(row.brand),
    quantity: parseFeedQuantity(row.quantity_to_sell_on_facebook),
    salePrice: str(row.sale_price) ? parseFeedMoney(str(row.sale_price) as string) : undefined,
    googleProductCategory: str(row.google_product_category),
    fbProductCategory: str(row.fb_product_category),
    productType: str(row.product_type),
    gtin: str(row.gtin),
    mpn: str(row.mpn),
    itemGroupId: str(row.item_group_id),
    color: str(row.color),
    size: str(row.size),
    gender: str(row.gender),
    ageGroup: str(row.age_group),
    material: str(row.material),
    pattern: str(row.pattern),
    customLabels: collectLabels(row),
  };

  return input;
};

export interface ImportRowError {
  row: number; // 1-based index within the data rows
  sku?: string;
  error: string;
}

export interface ImportResult {
  total: number;
  created: number;
  failed: ImportRowError[];
}

/**
 * Import a batch of keyed feed rows for a tenant. Each row is created ACTIVE
 * with sync deferred; after all rows are in, one batched sync pushes the whole
 * lot to Meta. Per-row failures are collected so a bad row never aborts the run.
 */
export const importProducts = async (tenantId: string, rows: FeedRow[]): Promise<ImportResult> => {
  const result: ImportResult = { total: rows.length, created: 0, failed: [] };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    try {
      const input = mapFeedRowToInput(row);
      await createProduct(tenantId, input, { deferSync: true });
      result.created += 1;
    } catch (error) {
      result.failed.push({
        row: i + 1,
        sku: str(row.id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info(`${TAG} imported ${result.created}/${result.total} (failed=${result.failed.length})`);

  // One batched push for everything just created (fire-and-forget). If it
  // errors, products stay PENDING/ERROR until retried explicitly — see the
  // sync-endpoint TODO on syncAllPendingCatalogs.
  if (result.created > 0) {
    void runWithTenant(tenantId, () => syncTenantCatalog()).catch((error) => {
      logger.error(`${TAG} post-import sync failed: ${error}`);
    });
  }

  return result;
};
