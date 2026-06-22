import type { Request, Response, NextFunction } from 'express';

import type { UserRole } from '../../constants/models.js';

// Gate dashboard-facing API routes. Reads the BFF session cookie (resolved by
// express-session) and attaches the operator to req.user. NOT for the WhatsApp
// or Paynow webhooks — those are called by Meta/Paynow and have their own
// verification.
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.session.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  req.user = req.session.user;
  next();
};

// Restrict a route to specific roles. Use after (or instead of) requireAuth.
export const requireRole =
  (...roles: UserRole[]) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    req.user = user;
    next();
  };
