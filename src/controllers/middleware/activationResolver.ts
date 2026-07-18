import type { Request, Response, NextFunction } from 'express';
import type { Types } from 'mongoose';
import { withVendorSession } from './dashboardAuthResolver.ts';
import { logger } from '../../services/logger.ts';

const TAG = '[activationResolver]';

// What the activation handlers read off res.locals. The phone is taken from the
// resolved (server-side) VendorUser, never from the request body — an invited
// user cannot redirect their activation OTP to a number they don't own.
export interface ActivationTarget {
  vendorUserId: string;
  phoneNumber: string;
}

// Gate for the first-login activation endpoints (/dashboard/activate/*). Unlike
// dashboardAuthResolver, this is the one place that *admits* a `needs_activation`
// seat — that is exactly who must run the OTP flow. An already-active seat is
// turned away (nothing to activate); a denied identity is refused. Shares the
// session + tenant scaffolding with the standard gate, so this runs inside the
// tenant context and the handlers below are tenant-scoped.
export const activationResolver = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  await withVendorSession(req, res, (resolution) => {
    if (resolution.kind === 'denied') {
      logger.warn(`${TAG} denied identity attempted activation`);
      res.status(403).json({ error: 'You do not have access to this account.' });
      return;
    }
    if (resolution.kind === 'ok') {
      res.status(409).json({ error: 'Your account is already active.' });
      return;
    }
    const { vendorUser } = resolution;
    const target: ActivationTarget = {
      vendorUserId: (vendorUser._id as Types.ObjectId).toString(),
      phoneNumber: vendorUser.phoneNumber,
    };
    res.locals.activation = target;
    next();
  });
};
