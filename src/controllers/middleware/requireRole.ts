import type { Request, Response, NextFunction } from 'express';
import type { UserRole } from '../../constants/models.ts';
import type { DashboardActor } from './dashboardAuthResolver.ts';
import { logger } from '../../services/logger.ts';

const TAG = '[requireRole]';

// Route guard: allow only actors whose role is in `allowed`. MUST run after
// dashboardAuthResolver, which establishes the tenant context and populates
// res.locals.actor — this middleware only reads that actor, it does no tenant
// resolution of its own. Denies with 403 otherwise.
//
// Authorization is intentionally role-in-DB driven (the actor's role comes from
// the VendorUser row), not from any token claim — the IdP says who you are, our
// data says what you may do.
export const requireRole = (...allowed: UserRole[]) => {
  const allowedSet = new Set<string>(allowed);
  return (_req: Request, res: Response, next: NextFunction): void => {
    const actor = res.locals.actor as DashboardActor | undefined;
    if (!actor || !allowedSet.has(actor.role)) {
      logger.warn(
        `${TAG} role "${actor?.role ?? 'none'}" denied; requires one of [${allowed.join(', ')}]`,
      );
      res.status(403).json({ error: 'You do not have permission to perform this action.' });
      return;
    }
    next();
  };
};
