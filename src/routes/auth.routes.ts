import { Router } from 'express';

import { callback, login, logout, me } from '../controllers/auth/auth.controller.ts';

const router = Router();

// Public — start and complete the OIDC login.
router.get('/login', login);
router.get('/callback', callback);

// Session status + logout.
router.get('/me', me);
router.post('/logout', logout);

export default router;
