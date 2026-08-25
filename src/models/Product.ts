import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import {
  ProductAvailability,
  ProductCondition,
  ProductStatus,
  CatalogSyncStatus,
  VehicleTier,
  Currency,
} from '../constants/models.ts';
import { tenantScope } from './plugins/tenantScope.ts';

export {
  ProductAvailability,
  ProductCondition,
  ProductStatus,
  CatalogSyncStatus,
  VehicleTier,
  Currency,
};

// Money is stored in MINOR UNITS (integer) + ISO-4217 currency, optimised for
// arithmetic/analytics (price, sale_price, delivery-fee math, reporting). Meta's
// "9.99 USD" string is produced on demand by the catalog formatter at sync time
// — it is never stored in that shape.
export interface IMoney {
  amount: number; // integer minor units, e.g. 999 = $9.99
  currency: Currency; // ISO 4217, restricted to the platform's supported set
}

// Dimensions are always in centimetres (see WEIGHT_UNIT/DIMENSION_UNIT).
export interface IProductDimensions {
  length: number;
  width: number;
  height: number;
}

// The canonical, caller-writable field set for a product — the create/update
// surface. Every other Product type derives from this: `IProduct` extends it
// with persistence/sync metadata, the service's `ProductInput` aliases it, and
// the Meta exporter picks the subset it sends. Keep field definitions here only.
export interface ProductFields {
  // Meta retailer id — a tenant-defined SKU, unique per tenant. Immutable once
  // set (changing it would orphan the catalog item).
  sku: string;

  // --- Meta feed fields (exported to the Facebook catalog) ---
  title: string;
  description: string;
  availability: ProductAvailability;
  condition: ProductCondition;
  price: IMoney;
  salePrice?: IMoney;
  salePriceEffectiveStart?: Date;
  salePriceEffectiveEnd?: Date;
  // Computed public HTTPS CDN URL. Optional so tenants can save imageless
  // DRAFTs, but image_link is Meta-required — a product without it is never
  // synced (see getProductSyncReadiness). The image pipeline validates Meta's
  // rules (HTTPS, format, min dimensions, size) before writing this.
  imageLink?: string;
  additionalImageLinks?: string[];
  brand?: string;
  quantity?: number; // inventory on hand
  googleProductCategory?: string;
  fbProductCategory?: string;
  productType?: string;
  gtin?: string;
  mpn?: string;
  itemGroupId?: string; // groups variants
  color?: string;
  size?: string;
  gender?: string;
  ageGroup?: string;
  material?: string;
  pattern?: string;
  customLabels?: string[];

  // --- Delivery physicals (source of truth). Only `weight` maps to Meta
  // (shipping_weight); dimensions + minVehicle are ours, used by the delivery
  // quote engine and never exported. Optional to store — existing catalogs have
  // none — and gate DELIVERY readiness (getProductDeliveryReadiness), not the
  // product's existence or its Meta sync. ---
  weight?: number; // kilograms
  dimensions?: IProductDimensions; // centimetres
  minVehicle?: VehicleTier;

  // Lifecycle. The complete-replacement feed includes ACTIVE products and omits
  // ARCHIVED/DRAFT products.
  status: ProductStatus;
}

export interface IProduct extends ProductFields, Document {
  tenantId: Types.ObjectId;

  // --- Legacy per-item Meta sync metadata (not caller-writable) ---
  // Retained for backwards-compatible reads of existing rows. Scheduled-feed
  // writes reset syncStatus to NOT_SYNCED and do not update the other fields.
  fbItemId?: string; // Meta's id for the synced item
  syncStatus: CatalogSyncStatus;
  lastSyncedAt?: Date;
  lastSyncError?: string;
  // Hash previously used by the retired per-item sync worker.
  contentHash?: string;

  // From { timestamps: true }.
  createdAt: Date;
  updatedAt: Date;
}

const MoneySchema = new Schema<IMoney>(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'amount must be an integer in minor units (e.g. cents)',
      },
    },
    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: Object.values(Currency),
    },
  },
  { _id: false },
);

const DimensionsSchema = new Schema<IProductDimensions>(
  {
    length: { type: Number, required: true, min: 0 },
    width: { type: Number, required: true, min: 0 },
    height: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const ProductSchema = new Schema<IProduct>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    sku: { type: String, required: true, trim: true, maxlength: 100 },

    // --- Meta feed fields ---
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 9999 },
    availability: {
      type: String,
      enum: Object.values(ProductAvailability),
      required: true,
      default: ProductAvailability.IN_STOCK,
    },
    condition: {
      type: String,
      enum: Object.values(ProductCondition),
      required: true,
      default: ProductCondition.NEW,
    },
    price: { type: MoneySchema, required: true },
    salePrice: { type: MoneySchema },
    salePriceEffectiveStart: { type: Date },
    salePriceEffectiveEnd: { type: Date },
    imageLink: { type: String, trim: true, match: /^https:\/\// },
    additionalImageLinks: { type: [String], default: undefined },
    brand: { type: String, trim: true },
    quantity: { type: Number, min: 0 },
    googleProductCategory: { type: String, trim: true },
    fbProductCategory: { type: String, trim: true },
    productType: { type: String, trim: true },
    gtin: { type: String, trim: true },
    mpn: { type: String, trim: true },
    itemGroupId: { type: String, trim: true },
    color: { type: String, trim: true },
    size: { type: String, trim: true },
    gender: { type: String, trim: true },
    ageGroup: { type: String, trim: true },
    material: { type: String, trim: true },
    pattern: { type: String, trim: true },
    customLabels: { type: [String], default: undefined },

    // --- Delivery physicals (optional; gate delivery readiness, not existence).
    // weight in kg, dimensions in cm — units are standardised, never stored. ---
    weight: { type: Number, min: 0 },
    dimensions: { type: DimensionsSchema },
    minVehicle: {
      type: String,
      enum: Object.values(VehicleTier),
    },

    // --- Lifecycle + sync metadata ---
    status: {
      type: String,
      enum: Object.values(ProductStatus),
      required: true,
      default: ProductStatus.DRAFT,
    },
    fbItemId: { type: String, trim: true },
    syncStatus: {
      type: String,
      enum: Object.values(CatalogSyncStatus),
      required: true,
      default: CatalogSyncStatus.NOT_SYNCED,
      index: true,
    },
    lastSyncedAt: { type: Date },
    lastSyncError: { type: String },
    contentHash: { type: String },
  },
  { timestamps: true },
);

// Retailer id (sku) is unique per tenant — this is the key Meta dedupes on.
ProductSchema.index({ tenantId: 1, sku: 1 }, { unique: true });
// Scheduled feed reads one tenant's ACTIVE products in SKU order.
ProductSchema.index({ tenantId: 1, status: 1, sku: 1 });
// Retained while legacy sync metadata remains queryable through the dashboard.
ProductSchema.index({ tenantId: 1, syncStatus: 1 });

ProductSchema.plugin(tenantScope);

// The Meta-required product fields that must be present before a product can
// appear in the scheduled feed. `link` is not stored here — the feed generates
// an exact public product URL from the tenant slug and SKU.
const SYNC_REQUIRED_FIELDS = [
  'sku',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'imageLink',
] as const satisfies readonly (keyof IProduct)[];

export interface ProductSyncReadiness {
  ready: boolean;
  missing: string[];
}

/**
 * Whether a product has everything Meta requires to be synced, and if not,
 * which fields are missing. Pure and side-effect free so it can back both the
 * feed builder (skip non-ready legacy rows) and the dashboard (tell the tenant
 * why a DRAFT cannot be published). Feed-level context such as `link` is
 * supplied separately by the exporter.
 */
export const getProductSyncReadiness = (
  product: Pick<IProduct, (typeof SYNC_REQUIRED_FIELDS)[number]>,
): ProductSyncReadiness => {
  const missing = SYNC_REQUIRED_FIELDS.filter((field) => {
    const value = product[field];
    return value === undefined || value === null || value === '';
  });
  return { ready: missing.length === 0, missing };
};

// The delivery physicals a product needs before the delivery quote engine can
// price/route it. Independent of Meta sync — a product can be live in the
// catalog yet not deliverable until these are filled (e.g. after a bulk import
// from a feed that had no weight/vehicle data).
const DELIVERY_REQUIRED_FIELDS = [
  'weight',
  'minVehicle',
] as const satisfies readonly (keyof IProduct)[];

export const getProductDeliveryReadiness = (
  product: Pick<IProduct, (typeof DELIVERY_REQUIRED_FIELDS)[number]>,
): ProductSyncReadiness => {
  const missing = DELIVERY_REQUIRED_FIELDS.filter((field) => {
    const value = product[field];
    return value === undefined || value === null;
  });
  return { ready: missing.length === 0, missing };
};

export default mongoose.model<IProduct>('Product', ProductSchema);
