import axios from 'axios';

import { CONFIG } from '../config.ts';
import UTILS from './index.ts';

/**
 * Shared primitives for talking to the Meta Graph API. Deliberately neutral —
 * no Flows/catalog/onboarding specifics — so every caller agrees on the base
 * URL, the auth header shape, and what counts as a retryable failure.
 */

/** Single source of truth for the Graph host + version. */
export const GRAPH_BASE_URL = `https://graph.facebook.com/${CONFIG.WHATSAPP_GRAPH_API_VERSION}`;

/**
 * Bearer header for a Graph call. Pass a tenant's own token when it has one
 * (their WABA, their credential); omit for the platform system token, which is
 * what drives WABAs shared with us. Never logged either way.
 */
export const graphAuthHeaders = (accessToken?: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken ?? CONFIG.WHATSAPP_SYSTEM_TOKEN}`,
});

/** Human-readable message from a Graph error, falling back to the raw error. */
export const graphErrorMessage = (err: unknown): string => {
  if (UTILS.isFacebookAPIError(err)) {
    return err.response.data.error.message;
  }
  return err instanceof Error ? err.message : 'Unknown error';
};

/**
 * Is this Graph failure worth retrying? 5xx and 429 are transient (Meta is
 * unavailable or throttling us); other 4xx are permanent — bad token, missing
 * permission, wrong id — and the caller must change something to succeed.
 *
 * 429 sits on the transient side deliberately: it is rate limiting, not a
 * rejection, so surfacing it as "fix your setup" would be wrong.
 */
export const isTransientGraphError = (err: unknown): boolean => {
  if (!axios.isAxiosError(err) || !err.response) {
    // No response at all — network/DNS/timeout. Retryable.
    return true;
  }
  const { status } = err.response;
  return status === 429 || status >= 500;
};
