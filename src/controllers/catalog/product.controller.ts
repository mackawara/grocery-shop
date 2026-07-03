import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../services/logger.ts';
import {
  Currency,
  ProductAvailability,
  ProductCondition,
  ProductStatus,
  VehicleTier,
  WeightUnit,
  DimensionUnit,
  CatalogSyncStatus,
} from '../../constants/models.ts';
import {
  createProduct,
  updateProduct,
  publishProduct,
  archiveProduct,
  getProduct,
  listProducts,
  ProductNotFoundError,
  ProductNotPublishableError,
} from './product.service.ts';
import type { CreateProductInput, UpdateProductInput } from './product.service.ts';
import { imageSize } from 'image-size';
import { importProducts } from './catalogImport.ts';
import { parseMetaFeedWorkbook } from './feedFileParser.ts';
import { uploadImageToDrive } from '../../services/googleDrive.ts';
import type { DashboardActor } from '../middleware/dashboardAuthResolver.ts';

const TAG = '[product]';

// The tenant comes solely from the authenticated session (set by
// dashboardAuthResolver), never from the request path or body.
const tenantOf = (res: Response): string => (res.locals.actor as DashboardActor).tenantId;

const HTTPS_URL = /^https:\/\//;

// --- Validation schemas (zod) ---------------------------------------------

const moneySchema = z.object({
  amount: z.number().int().nonnegative(), // minor units (e.g. cents)
  currency: z.enum(Currency),
});

const weightSchema = z.object({
  value: z.number().nonnegative(),
  unit: z.enum(WeightUnit),
});

const dimensionsSchema = z.object({
  length: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  unit: z.enum(DimensionUnit),
});

const createSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(9999),
  price: moneySchema,
  // Optional (schema-defaulted or genuinely optional) fields:
  status: z.enum(ProductStatus).optional(),
  availability: z.enum(ProductAvailability).optional(),
  condition: z.enum(ProductCondition).optional(),
  imageLink: z.string().trim().regex(HTTPS_URL, 'imageLink must be an https URL').optional(),
  additionalImageLinks: z.array(z.string().trim().regex(HTTPS_URL)).optional(),
  brand: z.string().trim().optional(),
  quantity: z.number().int().nonnegative().optional(),
  salePrice: moneySchema.optional(),
  salePriceEffectiveStart: z.coerce.date().optional(),
  salePriceEffectiveEnd: z.coerce.date().optional(),
  googleProductCategory: z.string().trim().optional(),
  fbProductCategory: z.string().trim().optional(),
  productType: z.string().trim().optional(),
  gtin: z.string().trim().optional(),
  mpn: z.string().trim().optional(),
  itemGroupId: z.string().trim().optional(),
  color: z.string().trim().optional(),
  size: z.string().trim().optional(),
  gender: z.string().trim().optional(),
  ageGroup: z.string().trim().optional(),
  material: z.string().trim().optional(),
  pattern: z.string().trim().optional(),
  customLabels: z.array(z.string().trim()).max(5).optional(),
  // Delivery physicals — optional; gate delivery readiness, not existence.
  weight: weightSchema.optional(),
  dimensions: dimensionsSchema.optional(),
  minVehicle: z.enum(VehicleTier).optional(),
});

// sku is immutable; everything else is patchable.
const updateSchema = createSchema.partial().omit({ sku: true });

const listQuerySchema = z.object({
  status: z.enum(ProductStatus).optional(),
  syncStatus: z.enum(CatalogSyncStatus).optional(),
});

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? 'Invalid request.';

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;

// Map service/domain errors to HTTP responses.
const handleError = (error: unknown, res: Response): void => {
  if (error instanceof ProductNotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof ProductNotPublishableError) {
    res.status(422).json({ error: error.message, missing: error.missing });
    return;
  }
  if (isDuplicateKeyError(error)) {
    res.status(409).json({ error: 'A product with this SKU already exists.' });
    return;
  }
  logger.error(`${TAG} unexpected error: ${error}`);
  res.status(500).json({ error: 'Something went wrong.' });
};

// --- Handlers -------------------------------------------------------------
// Tenant scope comes from the session context (dashboardAuthResolver); the
// service is tenant-scoped, so handlers never read a tenant id off the request.

export const createProductHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const product = await createProduct(tenantOf(res), parsed.data as CreateProductInput);
    res.status(201).json({ product });
  } catch (error) {
    handleError(error, res);
  }
};

export const listProductsHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const products = await listProducts(tenantOf(res), parsed.data);
    res.status(200).json({ products });
  } catch (error) {
    handleError(error, res);
  }
};

export const getProductHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const product = await getProduct(tenantOf(res), String(req.params.productId));
    if (!product) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }
    res.status(200).json({ product });
  } catch (error) {
    handleError(error, res);
  }
};

export const updateProductHandler = async (req: Request, res: Response): Promise<void> => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  try {
    const productId = String(req.params.productId);
    const patch = parsed.data as UpdateProductInput;
    const product = await updateProduct(tenantOf(res), productId, patch);
    res.status(200).json({ product });
  } catch (error) {
    handleError(error, res);
  }
};

export const publishProductHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const product = await publishProduct(tenantOf(res), String(req.params.productId));
    res.status(200).json({ product });
  } catch (error) {
    handleError(error, res);
  }
};

export const archiveProductHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const product = await archiveProduct(tenantOf(res), String(req.params.productId));
    res.status(200).json({ product });
  } catch (error) {
    handleError(error, res);
  }
};

// Meta image rules we can enforce server-side before hosting the file.
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif']);
const MIN_IMAGE_DIMENSION = 500;

// Upload a single product image to Google Drive and return its public URL for
// the form to store as imageLink. Validates Meta's format + min-dimension rules.
export const uploadProductImageHandler = async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded (expected form field "file").' });
    return;
  }
  const { buffer, mimetype, originalname } = req.file;
  if (!ALLOWED_IMAGE_MIME.has(mimetype)) {
    res.status(400).json({ error: 'Image must be JPG, PNG or GIF.' });
    return;
  }
  try {
    // TODO: imageSize throws on a corrupt/unparseable buffer, which falls
    // through to handleError's 500 — catch it separately and return 400.
    const { width, height } = imageSize(buffer);
    if (!width || !height || width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION) {
      res
        .status(400)
        .json({ error: `Image must be at least ${MIN_IMAGE_DIMENSION}x${MIN_IMAGE_DIMENSION}px.` });
      return;
    }
    // TODO: derive the extension from the validated mimetype instead of the
    // user-supplied filename ("photo" -> ".photo", arbitrary chars pass through).
    const ext = originalname.split('.').pop()?.toLowerCase() || 'jpg';
    const fileName = `${tenantOf(res)}_${Date.now()}.${ext}`;
    const { url } = await uploadImageToDrive(buffer, fileName, mimetype);
    res.status(201).json({ imageLink: url });
  } catch (error) {
    handleError(error, res);
  }
};

// Bulk import from an uploaded Meta catalog-feed workbook (.xlsx). multer puts
// the file buffer on req.file (see route). Products are created ACTIVE and
// synced to Meta via the Batch API afterwards.
export const importProductsHandler = async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded (expected form field "file").' });
    return;
  }
  try {
    const rows = await parseMetaFeedWorkbook(req.file.buffer);
    if (rows.length === 0) {
      res.status(400).json({ error: 'No product rows found in the uploaded file.' });
      return;
    }
    const result = await importProducts(tenantOf(res), rows);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
};
