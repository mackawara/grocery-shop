// Identity established at login (from the validated ID token) and kept in the
// session. The dashboard/admin resolvers read this instead of re-verifying a
// bearer token per request.
//
// The capability flags are derived from OUR DB at login (VendorUser /
// PlatformUser) — Authentik asserts identity only, it carries no role or group
// claims. Both flags can be true for a dual-seat identity. They drive routing
// and UX only; dashboardAuthResolver and platformAdminResolver re-verify the
// underlying rows on every request, so a stale flag can never authorize.
export interface SessionAuth {
  sub: string;
  email?: string;
  // Raw email_verified claim. It is retained for resolvers that can consume a
  // genuinely verified upstream IdP signal, but the platform-admin allowlist no
  // longer depends on Authentik's default false claim.
  emailVerified: boolean;
  // Tenant of the VendorUser seat — present iff isVendor.
  tenantId?: string;
  // Holds a VendorUser seat (tenant vendor dashboard).
  isVendor: boolean;
  // Active PlatformUser super admin, or break-glass allowlisted email.
  isPlatformAdmin: boolean;
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
