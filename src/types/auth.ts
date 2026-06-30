// Identity established at login (from the validated ID token) and kept in the
// session. The dashboard/admin resolvers read this instead of re-verifying a
// bearer token per request. Deliberately minimal — claims only, no DB rows.
export interface SessionAuth {
  sub: string;
  email?: string;
  // email_verified claim — required before an email may be trusted for the
  // platform-admin allowlist (see platformAdminResolver).
  emailVerified: boolean;
  // tenant_id claim — present for vendor identities, absent for platform admins.
  tenantId?: string;
  groups: string[];
}

// OAuth state stashed between /auth/login and /auth/callback: CSRF (state),
// replay protection (nonce), and PKCE (codeVerifier).
export interface OAuthFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
}

// OIDC tokens held server-side only — never sent to the browser. idToken is
// kept for the end-session (logout) hint.
export interface SessionTokens {
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}
