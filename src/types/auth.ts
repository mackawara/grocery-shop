import type { UserRole } from '../constants/models.js';

// The authenticated dashboard operator we persist in the session. Kept small —
// just what middleware and handlers need without a DB round-trip per request.
export interface SessionUser {
  operatorId: string;
  sub: string;
  email?: string;
  name?: string;
  role: UserRole;
  groups: string[];
}

// OAuth state stashed between /auth/login and /auth/callback for CSRF (state),
// replay protection (nonce) and PKCE (codeVerifier).
export interface OAuthFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
}

// OIDC tokens held server-side only — never sent to the browser.
export interface SessionTokens {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
}
