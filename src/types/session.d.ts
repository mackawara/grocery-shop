import 'express-session';
import type { SessionAuth, OAuthFlowState, SessionTokens } from './auth.ts';

declare module 'express-session' {
  interface SessionData {
    oauth?: OAuthFlowState;
    auth?: SessionAuth;
    tokens?: SessionTokens;
  }
}

export {};
