import type { Request, Response, NextFunction } from 'express';
import { redisClient } from '../../services/redis.ts';
import { globalKey } from '../../utils/tenantKey.ts';
import { logger } from '../../services/logger.ts';

// Fixed-window rate limiter backed by Redis. Used on the public, pre-tenant
// signup endpoints, so keys are built with globalKey (no tenant context). Fail
// OPEN: if Redis is unavailable we let the request through rather than block all
// signups — these endpoints have their own downstream guards (OTP attempt caps,
// phone-claim lock, uniqueness checks).
export interface RateLimitOptions {
  // Stable prefix identifying the limited action, e.g. 'signup-start'.
  keyPrefix: string;
  // Max requests allowed per window.
  max: number;
  // Window length in seconds.
  windowSeconds: number;
  // Derives the per-caller identity to limit on (e.g. IP, phone). Return
  // undefined to skip limiting this request (e.g. identity not yet known).
  identify: (req: Request) => string | undefined;
}

export const rateLimit = ({ keyPrefix, max, windowSeconds, identify }: RateLimitOptions) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identity = identify(req);
    if (!identity) {
      next();
      return;
    }

    const key = globalKey(`rl:${keyPrefix}:${identity}`);
    try {
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.expire(key, windowSeconds);
      }
      if (count > max) {
        logger.warn(`[rateLimit] ${keyPrefix} exceeded for ${identity} (${count}/${max})`);
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
      }
    } catch (err) {
      logger.error(
        `[rateLimit] Redis error on ${keyPrefix}, failing open: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    next();
  };
