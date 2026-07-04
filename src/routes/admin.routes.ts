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

export default router;
