import { Router } from 'express';

import { callback, login, logout, me } from '../controllers/auth/auth.controller.js';
import { requireAuth } from '../controllers/middleware/requireAuth.js';

const router = Router();

// Public — start and complete the OIDC login.
router.get('/login', login);
router.get('/callback', callback);

// Authenticated — current session.
router.post('/logout', logout);
router.get('/me', requireAuth, me);

export default router;
