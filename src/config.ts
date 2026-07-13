import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from './services/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const TAG = 'CONFIG';

const isLocal = process.env.APP_ENV?.toUpperCase() === 'LOCAL';

const mandatoryEnvironmentConstants = [
  'APP_ENV',
  'PORT',
  'REDIS_HOST_PORT',
  'REDIS_HOST',
  'WHATSAPP_WEBHOOK_VERIFICATION_TOKEN',
  'MONGODB_USERNAME',
  'MONGODB_PASSWORD',
  'MONGODB_HOST',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_SYSTEM_TOKEN',
  'WHATSAPP_FLOW_PRIVATE_KEY',
  // Locally PUBLIC_BASE_URL is derived from the ngrok tunnel; in production it
  // must be set explicitly so gateway callbacks (Paynow resultUrl) resolve.
  ...(isLocal ? ['NGROK_DOMAIN'] : ['PUBLIC_BASE_URL']),
  // Authentik OIDC (BFF login). The backend is the OAuth client and holds the
  // secret; the browser only ever gets a session cookie.
  'AUTHENTIK_ISSUER',
  'AUTHENTIK_CLIENT_ID',
  'AUTHENTIK_CLIENT_SECRET',
  // Authentik admin API (server-to-server provisioning of groups/users). The
  // token is a secret and is only ever sent in the Authorization header.
  'AUTHENTIK_BASE_URL',
  'AUTHENTIK_ADMIN_TOKEN',
  'SESSION_SECRET',
  'DASHBOARD_URL',
];

const missingEnvironmentVariables = mandatoryEnvironmentConstants.filter(
  (constant) => !process.env[constant],
);

if (missingEnvironmentVariables.length > 0) {
  const constantsString = JSON.stringify(missingEnvironmentVariables);

  logger.info(
    `[${TAG}] Environment variable(s) ${constantsString.substring(
      1,
      constantsString.length - 1,
    )} required. If running on local server, create a .env file in the root folder and define them in that file like: 
      
  MONGODB_USERNAME=username
  MONGODB_PASSWORD=password
  MONGODB_DATABASE_HOST=cluster_path/database_name
  ...
  `,
  );

  process.exit(1);
}

// Publicly reachable base URL gateways use for callbacks (Paynow resultUrl) and
// that Authentik redirects back to. Explicit PUBLIC_BASE_URL wins; locally we
// fall back to the ngrok tunnel.
const publicBaseUrl =
  process.env.PUBLIC_BASE_URL ||
  (isLocal && process.env.NGROK_DOMAIN ? `https://${process.env.NGROK_DOMAIN}` : '');

export const CONFIG = {
  IS_LOCAL_ENVIRONMENT: isLocal,
  PORT: parseInt(process.env.PORT || '0', 10) || 5000,
  REDIS_HOST_PORT: process.env.REDIS_HOST_PORT ? parseInt(process.env.REDIS_HOST_PORT) : 6379,
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_CONNECT_TIMEOUT: parseInt(process.env.REDIS_CONNECT_TIMEOUT || '0', 10) || 90000,
  WHATSAPP_WEBHOOK_VERIFICATION_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFICATION_TOKEN || '',
  MONGODB_USERNAME: process.env.MONGODB_USERNAME || '',
  MONGODB_PASSWORD: process.env.MONGODB_PASSWORD || '',
  MONGODB_HOST: process.env.MONGODB_HOST || '',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  WHATSAPP_SYSTEM_TOKEN: process.env.WHATSAPP_SYSTEM_TOKEN || '',
  // Single source of truth for the Meta Graph API version across all endpoints
  // (messages, flows, catalog items_batch). Bump here to move everything at once.
  WHATSAPP_GRAPH_API_VERSION: process.env.WHATSAPP_GRAPH_API_VERSION || 'v21.0',
  // Google Drive service account for product-image uploads. Not mandatory at
  // boot — the upload endpoint fails clearly if unset. The private key is a
  // secret (never logged); \n escapes in the env value are restored at use.
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '',
  GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  WHATSAPP_FLOW_PRIVATE_KEY: process.env.WHATSAPP_FLOW_PRIVATE_KEY || '',
  WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE: process.env.WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE || '',
  // Language code of the WhatsApp authentication template used to deliver vendor
  // signup OTPs (must match the template's configured language). Defaults to en_US.
  WHATSAPP_VENDOR_AUTH_TEMPLATE_LANG: process.env.WHATSAPP_VENDOR_AUTH_TEMPLATE_LANG || 'en',
  NGROK_DOMAIN: process.env.NGROK_DOMAIN || '',
  PUBLIC_BASE_URL: publicBaseUrl,
  // --- Authentik OIDC / BFF session ---
  // Issuer URL of the Authentik provider, e.g.
  // https://auth.ventatech.duckdns.org/application/o/<app-slug>/
  AUTHENTIK_ISSUER: process.env.AUTHENTIK_ISSUER || '',
  AUTHENTIK_CLIENT_ID: process.env.AUTHENTIK_CLIENT_ID || '',
  AUTHENTIK_CLIENT_SECRET: process.env.AUTHENTIK_CLIENT_SECRET || '',
  // Base URL of the Authentik admin API host (the /api/v3 path is appended in
  // the authentik service). e.g. https://auth.ventatech.duckdns.org
  AUTHENTIK_BASE_URL: process.env.AUTHENTIK_BASE_URL || '',
  // Bearer token for the admin API. Secret — never log it.
  AUTHENTIK_ADMIN_TOKEN: process.env.AUTHENTIK_ADMIN_TOKEN || '',
  // Optional: pk/slug of the Authentik email stage used to send recovery
  // emails. Required only for sendRecoveryEmail; absence is handled at runtime.
  AUTHENTIK_RECOVERY_EMAIL_STAGE: process.env.AUTHENTIK_RECOVERY_EMAIL_STAGE || '',
  // Where Authentik sends the user back after login. Defaults to the public
  // base URL + /auth/callback; override only if the callback host differs.
  AUTH_REDIRECT_URI:
    process.env.AUTH_REDIRECT_URI || (publicBaseUrl ? `${publicBaseUrl}/auth/callback` : ''),
  // SPA origin allowed through CORS and redirected to after a successful login.
  DASHBOARD_URL: process.env.DASHBOARD_URL || '',
  // Where Authentik returns the user after logout. Defaults to the dashboard.
  AUTHENTIK_POST_LOGOUT_REDIRECT:
    process.env.AUTHENTIK_POST_LOGOUT_REDIRECT || process.env.DASHBOARD_URL || '',
  // Signs the session cookie; rotate to invalidate all sessions.
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME || 'gs.sid',
  // Break-glass allowlist: comma-separated emails that are always treated as
  // active super admins (so an empty PlatformUser collection can't lock everyone
  // out). Normalized to lowercase; empty/blank entries dropped.
  PLATFORM_ADMIN_EMAILS: (process.env.PLATFORM_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
};
logger.warn(
  `[${TAG}] Running in ${CONFIG.IS_LOCAL_ENVIRONMENT ? 'LOCAL' : 'PRODUCTION'} environment`,
);
