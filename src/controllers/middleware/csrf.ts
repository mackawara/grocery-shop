import type { Request, Response, NextFunction } from 'express';

import { CONFIG } from '../../config.ts';
import { logger } from '../../services/logger.ts';

const TAG = '[csrf]';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defense for cookie-session, browser-facing routes. SameSite=Lax already
// stops cross-site cookie POSTs; this is the explicit second layer: every
// state-changing request must carry an Origin (or Referer) matching the
// dashboard. Mount it on /auth, /dashboard, /admin — NOT on the WhatsApp/Paynow
// webhooks, which are server-to-server and legitimately send no Origin.
export const csrfGuard = (req: Request, res: Response, next: NextFunction): void => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const allowed = CONFIG.DASHBOARD_URL;
  const origin = req.get('origin');

  if (origin) {
    if (origin === allowed) {
      next();
      return;
    }
    logger.warn(`${TAG} blocked ${req.method} ${req.originalUrl} — origin ${origin}`);
    res.status(403).json({ error: 'Cross-origin request blocked.' });
    return;
  }

  // Some same-origin browser requests omit Origin — fall back to Referer.
  const referer = req.get('referer');
  if (referer && referer.startsWith(allowed)) {
    next();
    return;
  }

  logger.warn(`${TAG} blocked ${req.method} ${req.originalUrl} — missing/disallowed origin`);
  res.status(403).json({ error: 'Cross-origin request blocked.' });
};
