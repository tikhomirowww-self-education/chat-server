import 'express-session';

interface SessionUser {
  info?: Record<string, unknown>;
  username?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  picture?: string;
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
    nonce?: string;
    state?: string;
    codeVerifier?: string;
  }
}
