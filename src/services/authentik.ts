import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { logger } from './logger.ts';
import { CONFIG } from '../config.ts';

const TAG = '[AUTHENTIK]';

// Thin, stateless wrapper over the Authentik admin API (served under
// <base>/api/v3/). It knows nothing about tenants or Mongo — it only creates
// and links identities/groups. The meaning "this group == that tenant" is owned
// by the signup controller, which sets the tenant_id attribute, and read back by
// the dashboard auth resolver. Keep all tenant/DB logic out of this file.

// Subset of the Authentik group representation we consume. `pk` is the numeric
// id used to add members; `attributes` carries our tenant link.
export interface AuthentikGroup {
  pk: string;
  name: string;
  attributes?: Record<string, unknown>;
}

// Subset of the Authentik user representation we consume. `pk` is the numeric
// id; `uuid` is stable but the OIDC `sub` claim is configured separately — we
// store whatever the token presents at login (bucket 4), not assumed here.
export interface AuthentikUser {
  pk: number;
  uuid: string;
  username: string;
  email: string;
  name: string;
}

// Raised on any non-2xx from Authentik (or a transport failure). Carries the
// HTTP status so callers can distinguish a 409 conflict (group/email already
// exists) from a transient 5xx and decide whether to roll back or retry.
export class AuthentikApiError extends Error {
  readonly status?: number;
  readonly operation: string;

  constructor(operation: string, message: string, status?: number) {
    super(message);
    this.name = 'AuthentikApiError';
    this.operation = operation;
    this.status = status;
  }
}

export const isAuthentikApiError = (error: unknown): error is AuthentikApiError =>
  error instanceof AuthentikApiError;

// Single configured client. Base URL + bearer token are read once at module
// load (mirrors messagesEndpointUrl). The token is a secret and is only ever
// placed in the Authorization header — never logged.
const client: AxiosInstance = axios.create({
  baseURL: `${CONFIG.AUTHENTIK_BASE_URL.replace(/\/+$/, '')}/api/v3`,
  headers: {
    Authorization: `Bearer ${CONFIG.AUTHENTIK_ADMIN_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

// Normalize any axios failure into an AuthentikApiError without leaking the
// request config (which holds the bearer token). Pull Authentik's own error
// detail when present.
const toAuthentikError = (operation: string, err: unknown): AuthentikApiError => {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as Record<string, unknown> | undefined;
    const detail =
      (typeof data?.detail === 'string' && data.detail) ||
      (data ? JSON.stringify(data) : undefined) ||
      err.message;
    return new AuthentikApiError(operation, detail, status);
  }
  return new AuthentikApiError(operation, err instanceof Error ? err.message : String(err));
};

// Create a tenant's group. `name` is human-readable (e.g. tenant:<slug>);
// `attributes` carries the real join key (tenant_id = Mongo Tenant _id).
const createGroup = async (
  name: string,
  attributes: Record<string, unknown>,
): Promise<AuthentikGroup> => {
  try {
    const { data } = await client.post<AuthentikGroup>('/core/groups/', { name, attributes });
    logger.info(`${TAG} created group ${data.name} (pk ${data.pk})`);
    return data;
  } catch (err) {
    throw toAuthentikError('createGroup', err);
  }
};

// Create an internal (password-backed) user, optionally placing them straight
// into one or more groups by pk. The user is created without a usable password;
// they set one via the recovery link (createRecoveryLink).
const createUser = async (params: {
  username: string;
  email: string;
  name: string;
  groups?: string[];
  attributes?: Record<string, unknown>;
}): Promise<AuthentikUser> => {
  try {
    const { data } = await client.post<AuthentikUser>('/core/users/', {
      username: params.username,
      email: params.email,
      name: params.name,
      type: 'internal',
      groups: params.groups ?? [],
      attributes: params.attributes ?? {},
    });
    logger.info(`${TAG} created user ${data.username} (pk ${data.pk})`);
    return data;
  } catch (err) {
    throw toAuthentikError('createUser', err);
  }
};

// Add an existing user to an existing group (used for staff invitations onto a
// tenant's group after signup).
const addUserToGroup = async (groupPk: string, userPk: number): Promise<void> => {
  try {
    await client.post(`/core/groups/${groupPk}/add_user/`, { pk: userPk });
    logger.info(`${TAG} added user pk ${userPk} to group pk ${groupPk}`);
  } catch (err) {
    throw toAuthentikError('addUserToGroup', err);
  }
};

// Generate a one-time recovery link the vendor follows to set their password
// and verify their email. Returns the absolute link Authentik issues.
const createRecoveryLink = async (userPk: number): Promise<string> => {
  try {
    const { data } = await client.post<{ link: string }>(`/core/users/${userPk}/recovery/`, {});
    logger.info(`${TAG} issued recovery link for user pk ${userPk}`);
    return data.link;
  } catch (err) {
    throw toAuthentikError('createRecoveryLink', err);
  }
};

// Send a recovery email to the user via a configured Authentik email stage, so
// they can set a password and verify their email. Used when a tenant is approved.
// Unlike createRecoveryLink (which returns a link for us to deliver), Authentik
// owns delivery here via its SMTP backend. Requires AUTHENTIK_RECOVERY_EMAIL_STAGE.
const sendRecoveryEmail = async (userPk: number): Promise<void> => {
  const emailStage = CONFIG.AUTHENTIK_RECOVERY_EMAIL_STAGE;
  if (!emailStage) {
    throw new AuthentikApiError(
      'sendRecoveryEmail',
      'AUTHENTIK_RECOVERY_EMAIL_STAGE is not configured',
    );
  }
  try {
    await client.post(`/core/users/${userPk}/recovery_email/`, { email_stage: emailStage });
    logger.info(`${TAG} sent recovery email for user pk ${userPk}`);
  } catch (err) {
    throw toAuthentikError('sendRecoveryEmail', err);
  }
};

// Look up a user by exact email (the anchor). Returns the first match or null.
// Lets callers reuse an existing Authentik identity instead of creating a
// duplicate (e.g. provisioning a platform admin who already has an account).
const findUserByEmail = async (email: string): Promise<AuthentikUser | null> => {
  try {
    const { data } = await client.get<{ results: AuthentikUser[] }>('/core/users/', {
      params: { email },
    });
    return data.results?.[0] ?? null;
  } catch (err) {
    throw toAuthentikError('findUserByEmail', err);
  }
};

// Rollback helpers — best-effort cleanup when signup provisioning fails partway
// (e.g. group created but Tenant save threw). Callers should catch and log
// rather than letting a cleanup failure mask the original error.
const deleteUser = async (userPk: number): Promise<void> => {
  try {
    await client.delete(`/core/users/${userPk}/`);
    logger.info(`${TAG} deleted user pk ${userPk}`);
  } catch (err) {
    throw toAuthentikError('deleteUser', err);
  }
};

const deleteGroup = async (groupPk: string): Promise<void> => {
  try {
    await client.delete(`/core/groups/${groupPk}/`);
    logger.info(`${TAG} deleted group pk ${groupPk}`);
  } catch (err) {
    throw toAuthentikError('deleteGroup', err);
  }
};

export const authentik = {
  createGroup,
  createUser,
  addUserToGroup,
  createRecoveryLink,
  sendRecoveryEmail,
  findUserByEmail,
  deleteUser,
  deleteGroup,
};
