import type { Request, Response } from 'express';

import { CONFIG } from '../../config.js';
import { UserRole, UserStatus } from '../../constants/models.js';
import { runWithoutTenant } from '../../context/tenantContext.js';
import Operator from '../../models/Operator.js';
import { client, getAuthConfig } from '../../services/authentik.js';
import { logger } from '../../services/logger.js';
import type { SessionUser } from '../../types/auth.js';

const TAG = 'AUTH';
const SCOPES = 'openid profile email';

// Authentik group name -> internal role, in descending privilege order. The
// first group a user belongs to wins, so create these groups in Authentik and
// assign operators to one (or rely on this precedence). A user in no mapped
// group is rejected at login (fail closed).
const GROUP_ROLE_PRECEDENCE: ReadonlyArray<[string, UserRole]> = [
  ['grocery-admins', UserRole.ADMIN],
  ['grocery-managers', UserRole.SHOP_MANAGER],
  ['grocery-vendors', UserRole.VENDOR],
  ['grocery-sales', UserRole.SALES_REP],
];

const mapGroupsToRole = (groups: string[]): UserRole | null => {
  for (const [group, role] of GROUP_ROLE_PRECEDENCE) {
    if (groups.includes(group)) {
      return role;
    }
  }
  return null;
};

// GET /auth/login — kick off the OIDC Authorization Code + PKCE flow.
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const config = await getAuthConfig();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    req.session.oauth = { state, nonce, codeVerifier };
    console.log(CONFIG.AUTH_REDIRECT_URI);
    const authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: CONFIG.AUTH_REDIRECT_URI,
      scope: SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    res.redirect(authorizationUrl.href);
  } catch (error) {
    logger.error(
      `[${TAG}] login init failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    res.status(500).send('Login is temporarily unavailable. Please try again.');
  }
};

// GET /auth/callback — exchange the code, provision the operator, open a session.
export const callback = async (req: Request, res: Response): Promise<void> => {
  console.log('Received callback with query:', req.query);
  const saved = req.session.oauth;
  if (!saved) {
    res.status(400).send('Your login session expired. Please start again.');
    return;
  }

  const config = await getAuthConfig();
  // Rebuild the callback URL from our known public base (not proxy-supplied
  // headers) so its origin+path matches the registered redirect_uri exactly.
  const currentUrl = new URL(req.originalUrl, CONFIG.PUBLIC_BASE_URL);

  let tokens;
  try {
    tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: saved.codeVerifier,
      expectedState: saved.state,
      expectedNonce: saved.nonce,
    });
  } catch (error) {
    logger.warn(
      `[${TAG}] token exchange failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    res.status(401).send('Authentication failed. Please try again.');
    return;
  }

  const claims = tokens.claims();
  if (!claims) {
    logger.warn(`[${TAG}] token response had no ID token`);
    res.status(401).send('Authentication failed. Please try again.');
    return;
  }

  const sub = claims.sub;
  const email = typeof claims.email === 'string' ? claims.email : undefined;
  const name =
    (typeof claims.name === 'string' && claims.name) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
    undefined;
  const groups = Array.isArray(claims.groups) ? (claims.groups as string[]) : [];

  const role = mapGroupsToRole(groups);
  if (!role) {
    logger.warn(`[${TAG}] ${email ?? sub} authenticated but is in no authorized group`);
    res.status(403).send('You are not authorized to access this dashboard.');
    return;
  }

  let operator;
  try {
    operator = await runWithoutTenant(
      'operator login upsert',
      `Operator.findOneAndUpdate({ authSub: ${sub} })`,
      () =>
        Operator.findOneAndUpdate(
          { authSub: sub },
          {
            $set: { email, name, role, lastLoginAt: new Date() },
            $setOnInsert: { status: UserStatus.ACTIVE },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        ),
    );
  } catch (error) {
    logger.error(
      `[${TAG}] operator upsert failed for ${sub}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    res.status(500).send('Could not complete sign-in. Please try again.');
    return;
  }

  if (operator && operator.status !== UserStatus.ACTIVE) {
    logger.warn(`[${TAG}] operator ${sub} is ${operator.status} — blocking sign-in`);
    res.status(403).send('Your account is not active. Contact an administrator.');
    return;
  }

  const sessionUser: SessionUser = {
    operatorId: String(operator?._id),
    sub,
    email,
    name,
    role,
    groups,
  };

  const expiresIn = tokens.expiresIn();

  // Regenerate the session id on privilege change to defeat session fixation.
  req.session.regenerate((regenErr) => {
    if (regenErr) {
      logger.error(`[${TAG}] session regenerate failed: ${regenErr.message}`);
      res.status(500).send('Could not complete sign-in. Please try again.');
      return;
    }

    req.session.user = sessionUser;
    req.session.tokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresAt: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined,
    };

    req.session.save((saveErr) => {
      if (saveErr) {
        logger.error(`[${TAG}] session save failed: ${saveErr.message}`);
        res.status(500).send('Could not complete sign-in. Please try again.');
        return;
      }
      res.redirect(CONFIG.DASHBOARD_URL);
    });
  });
};

// POST /auth/logout — destroy the session and return Authentik's end-session URL
// for the SPA to navigate to (so the IdP session is cleared too).
export const logout = async (req: Request, res: Response): Promise<void> => {
  const idToken = req.session.tokens?.idToken;

  let endSessionUrl = CONFIG.DASHBOARD_URL;
  if (idToken) {
    try {
      const config = await getAuthConfig();
      endSessionUrl = client.buildEndSessionUrl(config, {
        id_token_hint: idToken,
        post_logout_redirect_uri: CONFIG.AUTHENTIK_POST_LOGOUT_REDIRECT,
      }).href;
    } catch (error) {
      logger.warn(
        `[${TAG}] could not build end-session URL: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  req.session.destroy((err) => {
    if (err) {
      logger.error(`[${TAG}] session destroy failed: ${err.message}`);
    }
    res.clearCookie(CONFIG.SESSION_COOKIE_NAME);
    res.json({ logoutUrl: endSessionUrl });
  });
};

// GET /auth/me — current operator, for the dashboard to hydrate its auth state.
export const me = (req: Request, res: Response): void => {
  res.json({ authenticated: true, user: req.session.user });
};
