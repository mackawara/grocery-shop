import axios from 'axios';

import { WhatsappConnectionStatus } from '../constants/models.ts';
import { requireTenantId } from '../context/tenantContext.ts';
import Tenant from '../models/Tenant.ts';
import { logger } from '../services/logger.ts';
import {
  GRAPH_BASE_URL,
  graphAuthHeaders,
  graphErrorMessage,
  isTransientGraphError,
} from '../utils/graph.ts';
import { encryptSecret } from '../utils/tenantSecret.ts';

const TAG = '[whatsappOnboarding]';

/**
 * Connects a tenant to WhatsApp: verifies ownership, subscribes our app to the
 * WABA's webhooks, and stamps the ids (and optionally an encrypted credential)
 * onto the tenant.
 *
 * This is the single entry point for every onboarding source — the manual
 * dashboard endpoint today, the Embedded Signup callback later. Both feed the
 * same values here; only where the values come from differs.
 *
 * Must run inside runWithTenant — it reads the tenant from context and the
 * tenantScope plugin guards the save.
 */

export interface ConnectParams {
  phoneNumberId: string;
  wabaId: string;
  // Vendor-scoped token from their own Meta app/system user. Optional: under
  // the partner-sharing model our platform system token drives shared WABAs,
  // so most tenants never supply one.
  accessToken?: string;
}

// Every way connecting can fail that the caller must tell the vendor about.
// Kept as a discriminated result rather than exceptions so each onboarding
// source (dashboard now, Embedded Signup later) maps outcomes to its own
// transport identically — including NUMBER_TAKEN, which is a business outcome
// of connecting, not an infrastructure error to be sniffed out of a driver code.
export type ConnectFailureReason =
  // The phone number is not attached to the WABA the caller claims.
  | 'NOT_OWNED'
  // Another tenant already connected this phone number.
  | 'NUMBER_TAKEN'
  // Meta refused: bad/expired token, or our app has no access to this WABA
  // (not shared with us, or no advanced access yet).
  | 'GRAPH_DENIED'
  // Transient Graph failure — worth retrying unchanged.
  | 'GRAPH_ERROR';

export type ConnectResult =
  | { success: true }
  | { success: false; reason: ConnectFailureReason; message: string };

/** Connection state as the dashboard/wizard sees it. */
export interface WhatsappConnection {
  status: WhatsappConnectionStatus;
  phoneNumberId: string | null;
  wabaId: string | null;
}

// One place that turns a thrown Graph error into a ConnectResult, so both calls
// below classify and log failures identically.
const graphFailure = (err: unknown, operation: string): ConnectResult => {
  const message = graphErrorMessage(err);
  logger.error(`${TAG} ${operation} failed: ${message}`);
  return {
    success: false,
    reason: isTransientGraphError(err) ? 'GRAPH_ERROR' : 'GRAPH_DENIED',
    message,
  };
};

/**
 * Ownership check — the security boundary of onboarding. The webhook resolver
 * trusts whatsappPhoneNumberId to decide which tenant an inbound message
 * belongs to, so a tenant must prove the number really lives in the WABA they
 * claim before we store it. Without this, a vendor could register another
 * business's phone_number_id and receive their messages.
 */
const verifyPhoneNumberInWaba = async (
  wabaId: string,
  phoneNumberId: string,
  accessToken?: string,
): Promise<ConnectResult> => {
  try {
    const response = await axios.get<{ data?: { id: string }[] }>(
      `${GRAPH_BASE_URL}/${wabaId}/phone_numbers`,
      { headers: graphAuthHeaders(accessToken) },
    );
    const numbers = response.data?.data ?? [];
    if (!numbers.some((n) => n.id === phoneNumberId)) {
      return {
        success: false,
        reason: 'NOT_OWNED',
        message: 'That phone number is not part of the given WhatsApp Business Account.',
      };
    }
    return { success: true };
  } catch (err) {
    return graphFailure(err, `phone_numbers lookup for WABA ${wabaId}`);
  }
};

/**
 * Subscribe our app to the WABA so its webhooks (messages, statuses) start
 * flowing to /whatsapp/messages. Idempotent on Meta's side — resubscribing an
 * already-subscribed app succeeds.
 */
const subscribeAppToWaba = async (wabaId: string, accessToken?: string): Promise<ConnectResult> => {
  try {
    await axios.post(
      `${GRAPH_BASE_URL}/${wabaId}/subscribed_apps`,
      {},
      { headers: graphAuthHeaders(accessToken) },
    );
    return { success: true };
  } catch (err) {
    return graphFailure(err, `subscribed_apps for WABA ${wabaId}`);
  }
};

const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

/**
 * Full connect sequence: verify ownership -> subscribe webhooks -> persist.
 * Persistence is last so a Graph failure never leaves a half-connected tenant;
 * the worst case of failing *after* subscribe is a subscribed WABA with no
 * tenant record, which is inert (the resolver finds no tenant and acks).
 */
export const connectTenantWhatsapp = async (params: ConnectParams): Promise<ConnectResult> => {
  const { phoneNumberId, wabaId, accessToken } = params;
  const tenantId = requireTenantId('whatsappOnboarding.connect');

  const owned = await verifyPhoneNumberInWaba(wabaId, phoneNumberId, accessToken);
  if (!owned.success) {
    return owned;
  }

  const subscribed = await subscribeAppToWaba(wabaId, accessToken);
  if (!subscribed.success) {
    return subscribed;
  }

  const tenant = await Tenant.findById(tenantId);
  if (!tenant) {
    // Unreachable for a session-authenticated caller; the controller's catch-all
    // logs and 500s, which is the honest answer for an impossible state.
    throw new Error(`Tenant ${tenantId} not found while connecting WhatsApp.`);
  }

  tenant.whatsappPhoneNumberId = phoneNumberId;
  tenant.whatsappBusinessId = wabaId;
  tenant.whatsappConnectionStatus = WhatsappConnectionStatus.CONNECTED;
  if (accessToken) {
    // Stored encrypted (see utils/tenantSecret); the raw token is never
    // persisted or logged.
    tenant.whatsappCredentials = { accessToken: encryptSecret(accessToken), grantedAt: new Date() };
  }

  try {
    await tenant.save();
  } catch (err) {
    // Sparse unique index on whatsappPhoneNumberId: another tenant already
    // claimed this number. A business outcome, so it joins the result union
    // rather than escaping as a driver error every caller must decode.
    if (isDuplicateKeyError(err)) {
      logger.warn(`${TAG} phone ${phoneNumberId} already connected to another tenant`);
      return {
        success: false,
        reason: 'NUMBER_TAKEN',
        message: 'That phone number is already connected to another account.',
      };
    }
    throw err;
  }

  logger.info(`${TAG} connected WABA ${wabaId} / phone ${phoneNumberId}`);
  return { success: true };
};

/**
 * Disconnect: mark the connection dead and time-stamp any stored credential as
 * revoked. The ids are deliberately kept — they still identify the vendor's own
 * number (reconnect should be one click, and the unique index keeps the number
 * reserved for this tenant) — but inbound processing must gate on
 * whatsappConnectionStatus, not on the ids' presence.
 *
 * We do NOT call DELETE /{waba}/subscribed_apps: under partner sharing the
 * subscription is per-app, and other tenants' traffic does not flow through
 * this WABA, so leaving it subscribed is inert; dropping it with a dead token
 * would also fail for vendor-token tenants.
 */
export const disconnectTenantWhatsapp = async (): Promise<void> => {
  const tenantId = requireTenantId('whatsappOnboarding.disconnect');

  // Read-modify-write rather than $set: setting whatsappCredentials.revokedAt
  // directly would materialise a subdoc missing its required accessToken/
  // grantedAt when no credential exists. Projected down to just the two paths
  // touched — `+` only re-includes the select:false field, it doesn't narrow.
  const tenant = await Tenant.findById(tenantId).select(
    'whatsappConnectionStatus +whatsappCredentials',
  );
  if (!tenant) {
    return;
  }

  tenant.whatsappConnectionStatus = WhatsappConnectionStatus.NOT_CONNECTED;
  if (tenant.whatsappCredentials) {
    tenant.whatsappCredentials.revokedAt = new Date();
  }
  await tenant.save();
  logger.info(`${TAG} disconnected WhatsApp for tenant`);
};

/**
 * Current connection state. Lives here rather than in the controller so the one
 * rule about documents predating whatsappConnectionStatus — treat a missing
 * value as NOT_CONNECTED — has a single home as more readers appear.
 */
export const getTenantWhatsappConnection = async (): Promise<WhatsappConnection | null> => {
  const tenantId = requireTenantId('whatsappOnboarding.status');
  const tenant = await Tenant.findById(tenantId)
    .select('whatsappConnectionStatus whatsappPhoneNumberId whatsappBusinessId')
    .lean();
  if (!tenant) {
    return null;
  }
  return {
    status: tenant.whatsappConnectionStatus ?? WhatsappConnectionStatus.NOT_CONNECTED,
    phoneNumberId: tenant.whatsappPhoneNumberId ?? null,
    wabaId: tenant.whatsappBusinessId ?? null,
  };
};
