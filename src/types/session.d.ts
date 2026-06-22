import 'express-session';
import type { SessionUser, OAuthFlowState, SessionTokens } from './auth.js';

declare module 'express-session' {
  interface SessionData {
    oauth?: OAuthFlowState;
    user?: SessionUser;
    tokens?: SessionTokens;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export {};
