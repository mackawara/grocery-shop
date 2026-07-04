import currency from 'currency.js';
import type { ProductFields, IMoney } from '../models/Product.ts';
import { getProductSyncReadiness } from '../models/Product.ts';
import {
  ProductAvailability,
  ProductCondition,
  Currency,
  WEIGHT_UNIT,
} from '../constants/models.ts';

// Maps our internal Product model -> the payload the Meta (Facebook) Catalog
// Batch API expects. Pure and side-effect free: no DB, no network. The sync
// service (Bucket C) owns the HTTP call and the batch envelope; this module only
// shapes a single item. Money/weight are formatted to Meta's strings HERE, on
// demand — never stored in that shape (storage is minor units for arithmetic).

// Meta availability strings (space-separated, unlike our snake_case enum).
const AVAILABILITY_TO_META: Record<ProductAvailability, string> = {
  [ProductAvailability.IN_STOCK]: 'in stock',
  [ProductAvailability.OUT_OF_STOCK]: 'out of stock',
  [ProductAvailability.PREORDER]: 'preorder',
  [ProductAvailability.AVAILABLE_FOR_ORDER]: 'available for order',
  [ProductAvailability.DISCONTINUED]: 'discontinued',
};

// Meta condition strings happen to match our enum values, but map explicitly so
// a future enum addition is a compile error here rather than a silent bad feed.
const CONDITION_TO_META: Record<ProductCondition, string> = {
  [ProductCondition.NEW]: 'new',
  [ProductCondition.REFURBISHED]: 'refurbished',
  [ProductCondition.USED]: 'used',
};

/**
 * Minor units + currency -> Meta's "9.99 USD" price string.
 *
 * Uses currency.js (`fromCents`) so the minor-units -> decimal conversion is
 * exact. The supported currencies (USD, ZAR, ZWG) are all 2-decimal. Meta
 * requires a '.' decimal and NO thousands separator, so both are forced here.
 */
export const formatMoney = (money: IMoney): string => {
  if (!Object.values(Currency).includes(money.currency)) {
    throw new Error(`Unsupported currency: ${money.currency}`);
  }
  const amount = currency(money.amount, {
    fromCents: true,
    symbol: '',
    separator: '',
    decimal: '.',
    precision: 2,
  }).format();
  return `${amount} ${money.currency}`;
};

/** Weight (kg) -> Meta's "1.5 kg" shipping_weight string. */
export const formatWeight = (weightKg: number): string => `${weightKg} ${WEIGHT_UNIT}`;

/** Closed ISO-8601 range Meta wants for sale_price_effective_date. */
const formatDateRange = (start: Date, end: Date): string =>
  `${start.toISOString()}/${end.toISOString()}`;

export enum MetaBatchMethod {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
}

// The `data` object for a product item. Snake_case to match Meta's field names.
export interface MetaProductData {
  title: string;
  description: string;
  availability: string;
  condition: string;
  price: string;
  link: string;
  image_link: string;
  brand?: string;
  sale_price?: string;
  sale_price_effective_date?: string;
  additional_image_link?: string;
  quantity_to_sell_on_facebook?: number;
  google_product_category?: string;
  fb_product_category?: string;
  product_type?: string;
  gtin?: string;
  mpn?: string;
  item_group_id?: string;
  color?: string;
  size?: string;
  gender?: string;
  age_group?: string;
  material?: string;
  pattern?: string;
  shipping_weight?: string;
  [customLabel: `custom_label_${number}`]: string | undefined;
}

export interface MetaBatchRequest {
  method: MetaBatchMethod;
  retailer_id: string;
  data?: MetaProductData;
}

// The product fields the exporter reads: every writable field except the ones
// that never go to Meta (status is internal; dimensions/minVehicle are ours for
// delivery). Derived from ProductFields so new catalog fields flow through
// without editing a hand-kept list. Accepts leans/DTOs, not just hydrated docs.
type ProductForMeta = Omit<ProductFields, 'status' | 'dimensions' | 'minVehicle'>;

// The tenant fields the exporter needs: `facebookPageUrl` is the product `link`;
// `displayName` is the brand fallback when a product has no brand of its own.
export interface MetaExportTenant {
  facebookPageUrl?: string;
  displayName: string;
}

export class ProductNotSyncableError extends Error {
  constructor(
    public readonly retailerId: string,
    public readonly reasons: string[],
  ) {
    super(`Product "${retailerId}" is not syncable: ${reasons.join(', ')}`);
    this.name = 'ProductNotSyncableError';
  }
}

/**
 * Build the Meta `data` object for one product. `link` comes from the tenant's
 * facebookPageUrl (WhatsApp commerce has no per-product page). Throws
 * ProductNotSyncableError if the product is missing Meta-required fields or the
 * tenant has no facebookPageUrl — CREATE/UPDATE must never ship a partial item.
 */
export const toMetaProductData = (
  product: ProductForMeta,
  tenant: MetaExportTenant,
): MetaProductData => {
  const readiness = getProductSyncReadiness(product);
  const reasons = [...readiness.missing];
  if (!tenant.facebookPageUrl) {
    reasons.push('tenant.facebookPageUrl');
  }
  if (reasons.length > 0) {
    throw new ProductNotSyncableError(product.sku, reasons);
  }

  // imageLink is guaranteed non-empty by the readiness check above.
  const data: MetaProductData = {
    title: product.title,
    description: product.description,
    availability: AVAILABILITY_TO_META[product.availability],
    condition: CONDITION_TO_META[product.condition],
    price: formatMoney(product.price),
    link: tenant.facebookPageUrl as string,
    image_link: product.imageLink as string,
    // brand is required for most Meta categories; fall back to the tenant's name.
    brand: product.brand ?? tenant.displayName,
  };

  if (product.salePrice) {
    data.sale_price = formatMoney(product.salePrice);
  }
  if (product.salePriceEffectiveStart && product.salePriceEffectiveEnd) {
    data.sale_price_effective_date = formatDateRange(
      product.salePriceEffectiveStart,
      product.salePriceEffectiveEnd,
    );
  }
  if (product.additionalImageLinks && product.additionalImageLinks.length > 0) {
    // Comma-separated — accepted by both the feed and items_batch.
    data.additional_image_link = product.additionalImageLinks.join(',');
  }
  if (typeof product.quantity === 'number') {
    data.quantity_to_sell_on_facebook = product.quantity;
  }
  if (product.googleProductCategory) {
    data.google_product_category = product.googleProductCategory;
  }
  if (product.fbProductCategory) {
    data.fb_product_category = product.fbProductCategory;
  }
  if (product.productType) {
    data.product_type = product.productType;
  }
  if (product.gtin) {
    data.gtin = product.gtin;
  }
  if (product.mpn) {
    data.mpn = product.mpn;
  }
  if (product.itemGroupId) {
    data.item_group_id = product.itemGroupId;
  }
  if (product.color) {
    data.color = product.color;
  }
  if (product.size) {
    data.size = product.size;
  }
  if (product.gender) {
    data.gender = product.gender;
  }
  if (product.ageGroup) {
    data.age_group = product.ageGroup;
  }
  if (product.material) {
    data.material = product.material;
  }
  if (product.pattern) {
    data.pattern = product.pattern;
  }
  if (typeof product.weight === 'number') {
    data.shipping_weight = formatWeight(product.weight);
  }
  if (product.customLabels) {
    product.customLabels.slice(0, 5).forEach((label, i) => {
      if (label) {
        data[`custom_label_${i}` as const] = label;
      }
    });
  }

  return data;
};

/**
 * Build a single items_batch request. DELETE carries only the retailer_id;
 * CREATE/UPDATE carry the full data object (and validate syncability).
 */
export const toMetaProductRequest = (
  product: ProductForMeta,
  tenant: MetaExportTenant,
  method: MetaBatchMethod,
): MetaBatchRequest => {
  if (method === MetaBatchMethod.DELETE) {
    return { method, retailer_id: product.sku };
  }
  return {
    method,
    retailer_id: product.sku,
    data: toMetaProductData(product, tenant),
  };
};
