import type { Request, Response } from 'express';

import { CONFIG } from '../../config.ts';
import VendorUser from '../../models/VendorUser.ts';
import { runWithoutTenant } from '../../context/tenantContext.ts';
import { resolveMembership } from '../../services/vendorMembership.ts';
import { client, getOidcConfig } from '../../services/authentikOidc.ts';
import { logger } from '../../services/logger.ts';

const TAG = '[AUTH]';
const SCOPES = 'openid profile email';

// GET /auth/login — start the OIDC Authorization Code + PKCE flow.
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const config = await getOidcConfig();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    req.session.oauth = { state, nonce, codeVerifier };
    const authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: CONFIG.AUTH_REDIRECT_URI,
      scope: SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    logger.info(`${TAG} authorize redirect_uri=[${CONFIG.AUTH_REDIRECT_URI}]`);
    logger.info(`${TAG} authorize endpoint=${authorizationUrl.origin}${authorizationUrl.pathname}`);

    res.redirect(authorizationUrl.href);
  } catch (error) {
    logger.error(
      `${TAG} login init failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    res.status(500).send('Login is temporarily unavailable. Please try again.');
  }
};

// GET /auth/callback — exchange the code, validate the ID token, open a session.
export const callback = async (req: Request, res: Response): Promise<void> => {
  const saved = req.session.oauth;
  if (!saved) {
    res.status(400).send('Your login session expired. Please start again.');
    return;
  }

  const config = await getOidcConfig();
  // Rebuild the callback URL from our known public base (not proxy-supplied
  // headers) so its origin+path matches the registered redirect_uri exactly.
  const currentUrl = new URL(req.originalUrl, CONFIG.PUBLIC_BASE_URL);
  logger.info(`${TAG} callback endpoint=${currentUrl.origin}${currentUrl.pathname}`);

  let tokens;
  try {
    tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: saved.codeVerifier,
      expectedState: saved.state,
      expectedNonce: saved.nonce,
    });
  } catch (error) {
    const err = error as {
      name?: string;
      code?: string;
      error?: string;
      error_description?: string;
      status?: number;
    };
    logger.warn(
      `${TAG} token exchange failed: name=${err?.name} code=${err?.code} ` +
        `status=${err?.status ?? ''} error=${err?.error ?? ''} ` +
        `error_description=${err?.error_description ?? ''} ` +
        `message=${error instanceof Error ? error.message : String(error)}`,
    );
    res.status(401).send('Authentication failed. Please try again.');
    return;
  }

  const claims = tokens.claims();
  if (!claims || !claims.sub) {
    logger.warn(`${TAG} token response had no usable ID token`);
    res.status(401).send('Authentication failed. Please try again.');
    return;
  }

  const sub = claims.sub;
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined;
  const emailVerified = claims.email_verified === true;
  const groups = Array.isArray(claims.groups)
    ? claims.groups.filter((g): g is string => typeof g === 'string')
    : [];
  const expiresIn = tokens.expiresIn();

  // Tenant membership is authoritative in our DB, not in the token: Authentik
  // asserts *who* this identity is; the VendorUser row asserts *which tenant*
  // they belong to (and dashboardAuthResolver re-checks it on every request).
  // The tenant is unknown until the row is found, so this is a sanctioned
  // cross-tenant read. No row means no vendor seat (e.g. a platform admin),
  // which falls through to the /console landing below.
  const membership = await runWithoutTenant(
    'oidc-callback vendor membership resolution',
    'VendorUser.findOne({ authSubject }) / findOne({ email })',
    () =>
      resolveMembership(sub, email, emailVerified, (filter) =>
        VendorUser.findOne(filter).lean().exec(),
      ),
  );
  const tenantId = membership ? membership.tenantId.toString() : undefined;

  // Regenerate the session id once the identity is established (defeats session
  // fixation), then persist the identity + tokens server-side.
  req.session.regenerate((regenErr) => {
    if (regenErr) {
      logger.error(`${TAG} session regenerate failed: ${regenErr.message}`);
      res.status(500).send('Could not complete sign-in. Please try again.');
      return;
    }

    req.session.auth = { sub, email, emailVerified, tenantId, groups };
    req.session.tokens = {
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined,
    };

    req.session.save((saveErr) => {
      if (saveErr) {
        logger.error(`${TAG} session save failed: ${saveErr.message}`);
        res.status(500).send('Could not complete sign-in. Please try again.');
        return;
      }
      // Land somewhere that works for who they are: vendors (tenant_id claim)
      // get the dashboard; identities with no tenant (platform admins) get the
      // admin console, which has its own session guard.
      const landingPath = tenantId ? '/dashboard' : '/console';
      res.redirect(new URL(landingPath, CONFIG.DASHBOARD_URL).href);
    });
  });
};

// POST /auth/logout — destroy the session and return Authentik's end-session URL
// for the SPA to navigate to (so the IdP session is cleared too).
export const logout = async (req: Request, res: Response): Promise<void> => {
  const idToken = req.session.tokens?.idToken;

  let logoutUrl = CONFIG.DASHBOARD_URL;
  if (idToken) {
    try {
      const config = await getOidcConfig();
      logoutUrl = client.buildEndSessionUrl(config, {
        id_token_hint: idToken,
        post_logout_redirect_uri: CONFIG.AUTHENTIK_POST_LOGOUT_REDIRECT,
      }).href;
    } catch (error) {
      logger.warn(
        `${TAG} could not build end-session URL: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  req.session.destroy((err) => {
    if (err) {
      logger.error(`${TAG} session destroy failed: ${err.message}`);
    }
    res.clearCookie(CONFIG.SESSION_COOKIE_NAME);
    res.json({ logoutUrl });
  });
};

// GET /auth/me — lightweight session status (raw identity). The tenant-scoped
// actor (VendorUser/tenant) is served by /dashboard/me behind its resolver.
export const me = (req: Request, res: Response): void => {
  const auth = req.session.auth;
  if (!auth) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true, identity: auth });
};
