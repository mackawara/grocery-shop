import { Router } from 'express';
import {
  adminState,
  adminRate,
  adminPromo,
  adminPolicy,
  adminTenantAction,
  billingHandler,
} from '../billing/controller.ts';
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

const router = Router();

// Every admin route requires an active super admin (cross-tenant, no tenant context).
router.use(platformAdminResolver);

router.get('/me', getAdminMe);
router.get('/billing', adminState);
router.post('/billing/rates', adminRate);
router.post('/billing/promos', adminPromo);
router.post('/billing/policy', adminPolicy);
router.get('/tenants/:id/billing', adminTenantAction);
router.post('/tenants/:id/billing/:action', adminTenantAction);
router.get('/tenants', listTenants);
router.get('/tenants/pending', listPendingTenants);
router.post('/tenants/:id/approve', billingHandler(approveTenant));
router.post('/tenants/:id/reject', rejectTenant);
router.post('/tenants/:id/activate', billingHandler(activateTenant));
router.post('/tenants/:id/resend-invite', resendInvite);

export default router;
