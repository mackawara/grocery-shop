import { Router } from 'express';
import {
  signupStart,
  signupVerify,
  getMe,
  inviteVendorUser,
  listTeam,
} from '../controllers/dashboard/vendor.controller.ts';
import { rateLimit } from '../controllers/middleware/rateLimit.ts';
import { dashboardAuthResolver } from '../controllers/middleware/dashboardAuthResolver.ts';
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

export default router;
