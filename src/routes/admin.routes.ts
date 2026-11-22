import { Router } from 'express';
import { platformAdminResolver } from '../controllers/middleware/platformAdminResolver.ts';
import {
  getAdminMe,
  listTenants,
  listPendingTenants,
  approveTenant,
  rejectTenant,
  activateTenant,
  resendInvite,
} from '../controllers/dashboard/admin.controller.ts';
import {
  listPlanRatesHandler,
  schedulePlanRateHandler,
  cancelPlanRateHandler,
  listPlatformBillingAuditHandler,
  getVendorRatesHandler,
  listVendorRateOverridesHandler,
  scheduleVendorRateOverrideHandler,
  cancelVendorRateOverrideHandler,
  listVendorBillingAuditHandler,
} from '../controllers/billing/adminBilling.controller.ts';

const router = Router();

// Every admin route requires an active super admin (cross-tenant, no tenant context).
router.use(platformAdminResolver);

router.get('/me', getAdminMe);
router.get('/tenants', listTenants);
router.get('/tenants/pending', listPendingTenants);
router.post('/tenants/:id/approve', approveTenant);
router.post('/tenants/:id/reject', rejectTenant);
router.post('/tenants/:id/activate', activateTenant);
router.post('/tenants/:id/resend-invite', resendInvite);

// Vendor billing (issue #53). Rates change only by scheduling a new version for
// a future month or cancelling one that hasn't started; nothing is edited or
// deleted, and every change requires a reason and lands in the audit log.
//
// Plan rate cards are global.
router.get('/billing/plan-rates', listPlanRatesHandler);
router.post('/billing/plan-rates', schedulePlanRateHandler);
router.post('/billing/plan-rates/:rateId/cancel', cancelPlanRateHandler);
router.get('/billing/audit', listPlatformBillingAuditHandler);
// Per-vendor billing is tenant-owned: the handlers resolve :id against Tenant,
// then the billing services enter that vendor's tenant context for every read
// and write, so another vendor's records are unreachable from these paths.
router.get('/tenants/:id/billing/rates', getVendorRatesHandler);
router.get('/tenants/:id/billing/rate-overrides', listVendorRateOverridesHandler);
router.post('/tenants/:id/billing/rate-overrides', scheduleVendorRateOverrideHandler);
router.post(
  '/tenants/:id/billing/rate-overrides/:overrideId/cancel',
  cancelVendorRateOverrideHandler,
);
router.get('/tenants/:id/billing/audit', listVendorBillingAuditHandler);

export default router;
