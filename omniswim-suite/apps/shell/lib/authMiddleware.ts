import type { Request, Response, NextFunction } from 'express';
import type { AuthService, AuthUser } from '../../../packages/db/src/AuthService.ts';

export type AuthedRequest = Request & { user?: AuthUser; sessionToken?: string };

const COOKIE_NAME = 'omni_session';

export function getSessionToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match?.[1];
}

export function setSessionCookie(res: Response, token: string, expiresAt: number): void {
  const maxAge = Math.max(0, expiresAt - Date.now());
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}`
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
}

export function createAuthMiddleware(auth: AuthService | null, requireAuth: boolean) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!auth) {
      if (requireAuth) {
        return res.status(503).json({ error: 'Auth not configured (requires OMNI_DB=postgres + DATABASE_URL)' });
      }
      return next();
    }
    const token = getSessionToken(req);
    if (!token) {
      if (requireAuth) return res.status(401).json({ error: 'Authentication required' });
      return next();
    }
    const user = await auth.validateSession(token);
    if (!user) {
      if (requireAuth) return res.status(401).json({ error: 'Invalid or expired session' });
      return next();
    }
    req.user = user;
    req.sessionToken = token;
    next();
  };
}
