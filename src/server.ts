import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import mongoose from 'mongoose';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { logger } from './services/logger.js';
import { CONFIG } from './config.js';
import { redisClient } from './services/redis.js';
import whatsappRoutes from './routes/whatsapp.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import authRoutes from './routes/auth.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { csrfGuard } from './controllers/middleware/csrf.js';
import cors from 'cors';
import helmet from 'helmet';

const app = express();

// Behind Caddy/HTTPS: trust the proxy so Secure cookies and req.protocol work.
app.set('trust proxy', 1);

// Cookie-based BFF sessions need a specific allowed origin + credentials, not
// the wide-open default.
app.use(cors({ origin: CONFIG.DASHBOARD_URL, credentials: true }));
app.use(express.json());
app.use(helmet());

// Unauthenticated readiness probe consumed by the Docker healthcheck and the
// deploy pipeline's rollback gate. Registered before the session middleware so
// health pings never touch the Redis session store or emit cookies. Reports
// dependency state only — no tenant data. 503 until Mongo and Redis are both
// connected.
app.get('/health', (req: Request, res: Response) => {
  const mongoReady = mongoose.connection.readyState === 1;
  const redisReady = redisClient.isReady;
  const healthy = mongoReady && redisReady;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'unavailable',
    mongo: mongoReady,
    redis: redisReady,
    uptime: process.uptime(),
  });
});

// Server-side session (Redis-backed). The browser only holds the signed cookie;
// OIDC tokens live in Redis, never in JS.
app.use(
  session({
    store: new RedisStore({ client: redisClient, prefix: 'gs:sess:' }),
    name: CONFIG.SESSION_COOKIE_NAME,
    secret: CONFIG.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: !CONFIG.IS_LOCAL_ENVIRONMENT,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8,
    },
  }),
);

//routes
// Browser-facing, cookie-session routes get csrfGuard (Origin/Referer check as a
// second layer behind SameSite=Lax). The WhatsApp/Paynow webhooks are
// server-to-server and legitimately send no Origin, so they must NOT be guarded.
app.use('/auth', csrfGuard, authRoutes);
app.use('/whatsapp', whatsappRoutes);
app.use('/payments', paymentRoutes);
app.use('/dashboard', csrfGuard, dashboardRoutes);
app.use('/admin', csrfGuard, adminRoutes);

app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'Server running and working',
  });
});

// Global backstop error handler. Individual handlers own their expected failures
// (validation, conflicts, provider errors) and respond directly; this catches
// anything that slips through — a thrown/rejected async handler Express 5 routes
// here, or a bug. It logs server-side and returns a generic 500 so no internal
// detail (stack, driver message, tenant hints) leaks to the client. Must keep all
// four args so Express recognises it as an error handler; declared last, after
// every route. If the response already started streaming, delegate to Express's
// default handler which will destroy the socket.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  logger.error(
    `[unhandled] ${req.method} ${req.originalUrl}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

export const startServer = () => {
  app.listen(CONFIG.PORT, () => {
    logger.info(`Server is running on port ${CONFIG.PORT}`);
  });
};

export default app;
