import * as client from 'openid-client';

import { CONFIG } from '../config.js';
import { logger } from './logger.js';

const TAG = 'AUTHENTIK';

// Memoized OIDC configuration. Discovery is a network call, so we do it once and
// reuse it. On failure we clear the cache so a later request retries rather than
// being stuck with a rejected promise.
let configPromise: Promise<client.Configuration> | null = null;

const buildConfig = async (): Promise<client.Configuration> => {
  const config = await client.discovery(
    new URL(CONFIG.AUTHENTIK_ISSUER),
    CONFIG.AUTHENTIK_CLIENT_ID,
    CONFIG.AUTHENTIK_CLIENT_SECRET,
  );
  logger.info(`[${TAG}] Discovered issuer: ${CONFIG.AUTHENTIK_ISSUER}`);
  return config;
};

export const getAuthConfig = (): Promise<client.Configuration> => {
  if (!configPromise) {
    configPromise = buildConfig().catch((error) => {
      configPromise = null;
      logger.error(
        `[${TAG}] OIDC discovery failed for ${CONFIG.AUTHENTIK_ISSUER}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    });
  }
  return configPromise;
};

export { client };
