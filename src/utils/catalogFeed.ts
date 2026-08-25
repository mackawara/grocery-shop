import type { ProductFields } from '../models/Product.ts';
import { ProductStatus } from '../constants/models.ts';
import { ProductNotSyncableError, toMetaProductData } from './metaProductFeed.ts';

export const CATALOG_FEED_HEADERS = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'brand',
  'sale_price',
  'sale_price_effective_date',
  'additional_image_link',
  'quantity_to_sell_on_facebook',
  'google_product_category',
  'fb_product_category',
  'product_type',
  'gtin',
  'mpn',
  'item_group_id',
  'color',
  'size',
  'gender',
  'age_group',
  'material',
  'pattern',
  'shipping_weight',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
  'status',
] as const;

type CatalogFeedHeader = (typeof CATALOG_FEED_HEADERS)[number];
type CatalogFeedRow = Partial<Record<CatalogFeedHeader, string | number>>;

export interface CatalogFeedContext {
  publicBaseUrl: string;
  tenantSlug: string;
  tenantDisplayName: string;
}

export interface SkippedCatalogProduct {
  sku: string;
  reasons: string[];
}

export interface CatalogFeedResult {
  csv: string;
  included: number;
  skipped: SkippedCatalogProduct[];
}

const csvCell = (value: string | number | undefined): string => {
  const text = value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
};

export const getPublicProductUrl = (
  publicBaseUrl: string,
  tenantSlug: string,
  sku: string,
): string => {
  const base = publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`;
  const path = `catalogs/${encodeURIComponent(tenantSlug)}/products/${encodeURIComponent(sku)}`;
  return new URL(path, base).href;
};

/**
 * Build a complete-replacement Meta CSV feed for one tenant.
 *
 * Only ACTIVE products are exported. ARCHIVED/DRAFT products are absent so a
 * Meta `schedule` (as opposed to `update_schedule`) removes them on its next
 * complete refresh. An ACTIVE legacy row that is missing a required Meta field
 * is skipped rather than making the whole tenant feed unparsable.
 */
export const buildCatalogFeed = (
  products: readonly ProductFields[],
  context: CatalogFeedContext,
): CatalogFeedResult => {
  const rows: CatalogFeedRow[] = [];
  const skipped: SkippedCatalogProduct[] = [];

  for (const product of products) {
    if (product.status !== ProductStatus.ACTIVE) {
      continue;
    }

    try {
      const productLink = getPublicProductUrl(
        context.publicBaseUrl,
        context.tenantSlug,
        product.sku,
      );
      const data = toMetaProductData(product, {
        productLink,
        displayName: context.tenantDisplayName,
      });
      rows.push({
        id: product.sku,
        ...data,
        status: 'active',
      });
    } catch (error) {
      if (error instanceof ProductNotSyncableError) {
        skipped.push({ sku: product.sku, reasons: error.reasons });
        continue;
      }
      throw error;
    }
  }

  const lines = [
    CATALOG_FEED_HEADERS.map((header) => csvCell(header)).join(','),
    ...rows.map((row) => CATALOG_FEED_HEADERS.map((header) => csvCell(row[header])).join(',')),
  ];

  return {
    csv: `${lines.join('\n')}\n`,
    included: rows.length,
    skipped,
  };
};
