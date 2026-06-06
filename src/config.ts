import * as dotenv from 'dotenv';
import path from 'path';

import { logger } from './services/logger';
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

export const CONFIG = {
  IS_LOCAL_ENVIRONMENT: isLocal,
  PORT: parseInt(process.env.PORT || '0', 10) || 4000,
  REDIS_HOST_PORT: process.env.REDIS_HOST_PORT
    ? parseInt(process.env.REDIS_HOST_PORT)
    : 6379,
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_CONNECT_TIMEOUT: parseInt(
    process.env.REDIS_CONNECT_TIMEOUT || '0',
    10,
  ) || 90000,
  WHATSAPP_WEBHOOK_VERIFICATION_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFICATION_TOKEN || '',
  MONGODB_USERNAME: process.env.MONGODB_USERNAME || '',
  MONGODB_PASSWORD: process.env.MONGODB_PASSWORD || '',
  MONGODB_HOST: process.env.MONGODB_HOST || '',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  WHATSAPP_SYSTEM_TOKEN: process.env.WHATSAPP_SYSTEM_TOKEN || '',
  WHATSAPP_FLOW_PRIVATE_KEY: process.env.WHATSAPP_FLOW_PRIVATE_KEY || '',
  WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE: process.env.WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE || '',
  NGROK_DOMAIN: process.env.NGROK_DOMAIN || '',
  // Publicly reachable base URL gateways use for callbacks (Paynow resultUrl).
  // Explicit PUBLIC_BASE_URL wins; locally we fall back to the ngrok tunnel.
  PUBLIC_BASE_URL:
    process.env.PUBLIC_BASE_URL ||
    (isLocal && process.env.NGROK_DOMAIN
      ? `https://${process.env.NGROK_DOMAIN}`
      : ''),
};
logger.warn(
  `[${TAG}] Running in ${CONFIG.IS_LOCAL_ENVIRONMENT ? 'LOCAL' : 'PRODUCTION'} environment`,
);
