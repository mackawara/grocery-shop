import type { Request, Response } from 'express';
import express from 'express';
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

export const startServer = () => {
  app.listen(CONFIG.PORT, () => {
    logger.info(`Server is running on port ${CONFIG.PORT}`);
  });
};

export default app;
