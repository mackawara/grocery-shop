import { Router } from 'express';
import multer from 'multer';
import {
  signupStart,
  signupVerify,
  getMe,
  inviteVendorUser,
  listTeam,
} from '../controllers/dashboard/vendor.controller.ts';
import {
  createProductHandler,
  listProductsHandler,
  getProductHandler,
  updateProductHandler,
  publishProductHandler,
  archiveProductHandler,
  importProductsHandler,
  uploadProductImageHandler,
} from '../controllers/catalog/product.controller.ts';
import {
  createZoneHandler,
  listZonesHandler,
  getZoneHandler,
  updateZoneHandler,
  deleteZoneHandler,
  createVehicleHandler,
  listVehiclesHandler,
  getVehicleHandler,
  updateVehicleHandler,
  deleteVehicleHandler,
  listRatesHandler,
  upsertRateHandler,
  deleteRateHandler,
} from '../controllers/delivery/deliveryConfig.controller.ts';
import { rateLimit } from '../controllers/middleware/rateLimit.ts';
import { dashboardAuthResolver } from '../controllers/middleware/dashboardAuthResolver.ts';
import { requireRole } from '../controllers/middleware/requireRole.ts';
import { UserRole } from '../constants/models.ts';
import { normalizePhone } from '../utils/phone.ts';

const router = Router();

// Public, pre-tenant signup. Rate-limited per IP (and per phone on /start) to
// blunt OTP-bombing and brute force; the OTP service adds attempt caps on top.
const byIp = (prefix: string) =>
  rateLimit({ keyPrefix: `${prefix}-ip`, max: 20, windowSeconds: 3600, identify: (req) => req.ip });

const byPhone = (prefix: string) =>
  rateLimit({
    keyPrefix: `${prefix}-phone`,
    max: 5,
    windowSeconds: 3600,
    identify: (req) => {
      const phone = (req.body as { phoneNumber?: unknown })?.phoneNumber;
      return typeof phone === 'string' ? normalizePhone(phone) : undefined;
    },
  });

router.post('/signup/start', byIp('signup-start'), byPhone('signup-start'), signupStart);
router.post('/signup/verify', byIp('signup-verify'), byPhone('signup-verify'), signupVerify);

// Authenticated routes — everything below requires a valid session.
router.get('/me', dashboardAuthResolver, getMe);
router.get('/team', dashboardAuthResolver, listTeam);
router.post('/invitations', dashboardAuthResolver, inviteVendorUser);

// Catalog CRUD. Session-scoped: dashboardAuthResolver establishes the tenant
// from the session (res.locals.actor.tenantId) and runs the handler inside
// runWithTenant. No tenant id in the path or body — the client never sends one,
// so there is no id to spoof (per the tenant-isolation rule in CLAUDE.md).
// Reads are open to any authenticated tenant member; writes (create/update/
// publish/archive/import/image) are owner- or manager-only, same gate as the
// delivery config below and the staff-invite path.
const catalog = [dashboardAuthResolver] as const;
const catalogWrite = [
  dashboardAuthResolver,
  requireRole(UserRole.VENDOR, UserRole.SHOP_MANAGER),
] as const;
const PRODUCTS = '/products';

// In-memory upload for the bulk import; xlsx feeds are small. Cap at 5 MB and
// only accept spreadsheet MIME types.
// TODO: cb(null, false) silently drops a rejected file, so the handler answers
// "No file uploaded" — pass an Error (+ error middleware) for an honest 400.
const XLSX_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);
const uploadFeed = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, XLSX_MIME.has(file.mimetype) || file.originalname.toLowerCase().endsWith('.xlsx'));
  },
});

// Product images: Meta caps at 8 MB; accept only image types.
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

router.post(PRODUCTS, ...catalogWrite, createProductHandler);
router.get(PRODUCTS, ...catalog, listProductsHandler);
router.post(
  `${PRODUCTS}/import`,
  ...catalogWrite,
  uploadFeed.single('file'),
  importProductsHandler,
);
router.post(
  `${PRODUCTS}/image`,
  ...catalogWrite,
  uploadImage.single('file'),
  uploadProductImageHandler,
);
router.get(`${PRODUCTS}/:productId`, ...catalog, getProductHandler);
router.patch(`${PRODUCTS}/:productId`, ...catalogWrite, updateProductHandler);
router.post(`${PRODUCTS}/:productId/publish`, ...catalogWrite, publishProductHandler);
router.post(`${PRODUCTS}/:productId/archive`, ...catalogWrite, archiveProductHandler);

// Delivery config — session-scoped like the rest of /dashboard. `config` is just
// the auth resolver (tenant comes from the session, never the URL); reads are
// open to any authenticated tenant member. `configWrite` adds a role gate so
// only the owner (VENDOR) or a shop manager can mutate zones/vehicles/rates —
// mirrors the staff-invite gating (INVITER_ROLES) so a sales rep can view the
// delivery setup but not change pricing/coverage.
const config = [dashboardAuthResolver] as const;
const configWrite = [
  dashboardAuthResolver,
  requireRole(UserRole.VENDOR, UserRole.SHOP_MANAGER),
] as const;
router.get('/zones', ...config, listZonesHandler);
router.post('/zones', ...configWrite, createZoneHandler);
router.get('/zones/:id', ...config, getZoneHandler);
router.patch('/zones/:id', ...configWrite, updateZoneHandler);
router.delete('/zones/:id', ...configWrite, deleteZoneHandler);
router.get('/vehicles', ...config, listVehiclesHandler);
router.post('/vehicles', ...configWrite, createVehicleHandler);
router.get('/vehicles/:id', ...config, getVehicleHandler);
router.patch('/vehicles/:id', ...configWrite, updateVehicleHandler);
router.delete('/vehicles/:id', ...configWrite, deleteVehicleHandler);
// Rate matrix: PUT sets a (zone × tier) cell — upsert, no separate POST/PATCH.
router.get('/rates', ...config, listRatesHandler);
router.put('/rates', ...configWrite, upsertRateHandler);
router.delete('/rates/:id', ...configWrite, deleteRateHandler);

export default router;
