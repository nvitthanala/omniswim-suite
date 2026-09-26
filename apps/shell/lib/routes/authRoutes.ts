/**
 * Auth routes (PostgreSQL deployments only — see `AuthService`).
 *
 * Extracted from `server.ts`'s `startServer` (H2, code-health refactor,
 * 2026-09-25) with no behavior change: same paths, methods, middleware and
 * error handling. `auth` is `null` on the JSON/SQLite backends, where every
 * route below answers 503.
 */
import type { Express, RequestHandler } from 'express';
import { setSessionCookie, clearSessionCookie, type AuthedRequest } from '../authMiddleware.ts';
import type { AuthService } from '../../../../packages/db/src/AuthService.ts';

export interface AuthRoutesDeps {
  auth: AuthService | null;
  optionalAuth: RequestHandler;
  requireAuth: RequestHandler;
  AUTH_REQUIRED: boolean;
}

export function registerAuthRoutes(app: Express, deps: AuthRoutesDeps): void {
  const { auth, optionalAuth, requireAuth, AUTH_REQUIRED } = deps;

  app.post('/api/auth/register', async (req, res) => {
    if (!auth) return res.status(503).json({ error: 'Auth requires PostgreSQL backend' });
    try {
      const { email, password, displayName } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Valid email and password (6+ chars) required' });
      }
      const session = await auth.register(email, password, displayName);
      setSessionCookie(res, session.token, session.expiresAt);
      res.json({ user: session.user });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg === 'EMAIL_EXISTS' ? 409 : 500).json({ error: msg });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    if (!auth) return res.status(503).json({ error: 'Auth requires PostgreSQL backend' });
    try {
      const { email, password } = req.body ?? {};
      const session = await auth.login(String(email ?? ''), String(password ?? ''));
      setSessionCookie(res, session.token, session.expiresAt);
      res.json({ user: session.user });
    } catch (_err) {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });

  app.post('/api/auth/logout', optionalAuth, async (req: AuthedRequest, res) => {
    if (auth && req.sessionToken) await auth.logout(req.sessionToken);
    clearSessionCookie(res);
    res.json({ success: true });
  });

  app.get('/api/auth/me', optionalAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.user ?? null, authRequired: AUTH_REQUIRED });
  });

  app.post('/api/auth/invite', requireAuth, async (req: AuthedRequest, res) => {
    if (!auth || !req.user?.teamId) return res.status(503).json({ error: 'Invite unavailable' });
    try {
      await auth.inviteToTeam(req.user.teamId, req.user.id, String(req.body?.email ?? ''));
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });
}
