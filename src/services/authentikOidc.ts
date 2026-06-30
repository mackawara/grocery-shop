import * as client from 'openid-client';

import { CONFIG } from '../config.ts';
import { logger } from './logger.ts';

const TAG = '[AUTHENTIK_OIDC]';

// Memoized OIDC configuration for the BFF login flow. Discovery is a network
// call, so it's done once and reused. On failure the cache is cleared so a
// later request retries rather than being stuck with a rejected promise.
let configPromise: Promise<client.Configuration> | null = null;

const buildConfig = async (): Promise<client.Configuration> => {
  const config = await client.discovery(
    new URL(CONFIG.AUTHENTIK_ISSUER),
    CONFIG.AUTHENTIK_CLIENT_ID,
    // Confidential client: the secret authenticates the backend at the token
    // endpoint during the code exchange.
    CONFIG.AUTHENTIK_CLIENT_SECRET,
  );
  logger.info(`${TAG} discovered issuer ${CONFIG.AUTHENTIK_ISSUER}`);
  return config;
};

export const getOidcConfig = (): Promise<client.Configuration> => {
  if (!configPromise) {
    configPromise = buildConfig().catch((error) => {
      configPromise = null;
      logger.error(
        `${TAG} OIDC discovery failed for ${CONFIG.AUTHENTIK_ISSUER}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    });
  }
  return configPromise;
};

export { client };
