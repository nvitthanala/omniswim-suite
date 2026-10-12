/**
 * Auth routes (PostgreSQL deployments only — see `AuthService`).
 *
 * Extracted from `server.ts`'s `startServer` (H2, code-health refactor,
 * 2026-09-25). `auth` is `null` on the JSON/SQLite backends, where every
 * route below answers 503.
 *
 * ## Hardening when `AUTH_REQUIRED` (improvement plan S4, decision U11)
 *
 * With `AUTH_REQUIRED` off, the routes behave as they always did. With it on:
 *
 * - **Registration is invite-only.** There is no admin role in the database, so
 *   the gate is configured in the environment, with no schema change:
 *   - `OMNI_INVITE_CODES`: comma-separated secrets, each at least 12 characters.
 *     A caller registers by sending one as `inviteCode` in the JSON body. A code
 *     is a shared secret, not a single-use token: rotate it by editing the list
 *     and restarting.
 *   - `OMNI_ADMIN_EMAILS`: comma-separated emails. A signed-in user whose email is
 *     on the list can register another account with no code. The new account does
 *     not become the admin's session: no cookie is set and the session minted by
 *     `AuthService.register` is deleted straight away.
 *   - With neither variable set, registration is closed. It fails closed, not open.
 * - **Passwords are at least 12 characters.**
 * - **A failed registration is one generic answer.** A duplicate email, a database
 *   error and any other failure all return the same 400 body. The real cause goes
 *   to the server log. The invite check runs before `auth.register`, so a caller
 *   without an invite learns nothing about which emails exist.
 * - **Failed logins are rate limited** in memory: 10 failures per account and
 *   address, and 50 per address, per 15 minutes, answered 429 with `Retry-After`.
 *   Bad invite codes count against the per-address limit. Behind a reverse proxy
 *   every client shares the proxy's address unless Express `trust proxy` is set.
 * - **The session cookie is `Secure`** when the request is not loopback.
 */
import crypto from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import { clearSessionCookie, setSessionCookie, type AuthedRequest } from '../authMiddleware.ts';
import type { AuthService } from '../../../../packages/db/src/AuthService.ts';
import { createAttemptLimiter } from '../middleware/attemptLimiter.ts';
import { isLoopbackRequest, setSessionCookieForRequest } from '../middleware/sessionCookie.ts';

/** Password minimum when `AUTH_REQUIRED`. The open (auth off) path keeps its 6. */
export const MIN_PASSWORD_LENGTH_AUTH_REQUIRED = 12;
/** An invite code shorter than this is refused at startup: a guessable code is no gate. */
export const MIN_INVITE_CODE_LENGTH = 12;

export interface RegistrationConfig {
  /** Shared invite secrets. Empty means no invite registration. */
  readonly inviteCodes: readonly string[];
  /** Lowercase emails allowed to register other users. Empty means no admin registration. */
  readonly adminEmails: readonly string[];
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(entry => entry !== '');
}

/** Read `OMNI_INVITE_CODES` and `OMNI_ADMIN_EMAILS`. Throws on an invite code that is too short. */
export function registrationConfigFromEnv(env: {
  readonly OMNI_INVITE_CODES?: string | undefined;
  readonly OMNI_ADMIN_EMAILS?: string | undefined;
}): RegistrationConfig {
  const inviteCodes = splitList(env.OMNI_INVITE_CODES);
  const short = inviteCodes.find(code => code.length < MIN_INVITE_CODE_LENGTH);
  if (short !== undefined) {
    throw new Error(
      `OMNI_INVITE_CODES holds a code shorter than ${MIN_INVITE_CODE_LENGTH} characters. Use long random codes.`
    );
  }
  return {
    inviteCodes,
    adminEmails: splitList(env.OMNI_ADMIN_EMAILS).map(email => email.toLowerCase()),
  };
}

/** Startup banner lines for the registration gate. */
export function registrationBannerLines(config: RegistrationConfig): readonly string[] {
  if (config.inviteCodes.length === 0 && config.adminEmails.length === 0) {
    return [
      'Registration: CLOSED. Set OMNI_INVITE_CODES (invite codes) or OMNI_ADMIN_EMAILS (admins who register users) to allow it.',
    ];
  }
  return [
    `Registration: invite-only (${config.inviteCodes.length} invite code(s), ${config.adminEmails.length} admin email(s)).`,
  ];
}

export interface AuthRateLimitSettings {
  /** Failed logins allowed per address and account in a window. Default 10. */
  readonly maxPerAccount?: number;
  /** Failed attempts allowed per address in a window. Default 50. */
  readonly maxPerAddress?: number;
  /** Window length. Default 15 minutes. */
  readonly windowMs?: number;
  /** Clock, for tests. */
  readonly now?: () => number;
}

export interface AuthRoutesDeps {
  auth: AuthService | null;
  optionalAuth: RequestHandler;
  requireAuth: RequestHandler;
  AUTH_REQUIRED: boolean;
  /** Invite and admin settings. Omitted means registration is closed when `AUTH_REQUIRED`. */
  registration?: RegistrationConfig;
  rateLimit?: AuthRateLimitSettings;
  /** Override the loopback test used for the `Secure` cookie flag. Tests only. */
  isLoopbackRequest?: (req: Request) => boolean;
}

const OPEN_MIN_PASSWORD_LENGTH = 6;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
const GENERIC_REGISTER_FAILURE = 'Could not register. Check the details, or ask the administrator.';

/** Compare secrets without leaking length or early-exit timing. */
function secretMatches(expected: string, received: string): boolean {
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(received).digest();
  return crypto.timingSafeEqual(a, b);
}

export function registerAuthRoutes(app: Express, deps: AuthRoutesDeps): void {
  const { auth, optionalAuth, requireAuth, AUTH_REQUIRED } = deps;
  const registration: RegistrationConfig = deps.registration ?? { inviteCodes: [], adminEmails: [] };
  const loopback = deps.isLoopbackRequest ?? isLoopbackRequest;

  // One limiter pair per registered route set, never a module singleton, so two
  // apps (or two tests) in one process do not share counters.
  const windowMs = deps.rateLimit?.windowMs ?? 15 * 60 * 1000;
  const clock = deps.rateLimit?.now;
  const limiterBase = { windowMs, ...(clock === undefined ? {} : { now: clock }) };
  const accountLimiter = createAttemptLimiter({ ...limiterBase, maxAttempts: deps.rateLimit?.maxPerAccount ?? 10 });
  const addressLimiter = createAttemptLimiter({ ...limiterBase, maxAttempts: deps.rateLimit?.maxPerAddress ?? 50 });

  const addressOf = (req: Request): string => req.ip ?? req.socket?.remoteAddress ?? 'unknown';

  /** Answer 429 and return true when `keys` are over their limit. */
  const rateLimited = (res: Response, checks: ReadonlyArray<ReturnType<typeof accountLimiter.check>>): boolean => {
    const blocked = checks.find(check => !check.allowed);
    if (blocked === undefined || blocked.allowed) return false;
    res.setHeader('Retry-After', String(blocked.retryAfterSeconds));
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
    return true;
  };

  /* ---- register ---------------------------------------------------------- */

  /** Auth off: the original behavior, unchanged. */
  const openRegister = async (req: Request, res: Response) => {
    if (!auth) return res.status(503).json({ error: 'Auth requires PostgreSQL backend' });
    try {
      const { email, password, displayName } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string' || password.length < OPEN_MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: 'Valid email and password (6+ chars) required' });
      }
      const session = await auth.register(email, password, displayName);
      setSessionCookie(res, session.token, session.expiresAt);
      res.json({ user: session.user });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg === 'EMAIL_EXISTS' ? 409 : 500).json({ error: msg });
    }
  };

  /** Who is allowed to register: a signed-in admin, an invite code, or nobody. */
  const registrationRoute = (req: AuthedRequest): 'admin' | 'invite' | undefined => {
    const adminEmail = req.user?.email?.toLowerCase();
    if (adminEmail !== undefined && registration.adminEmails.includes(adminEmail)) return 'admin';
    const code = (req.body as { inviteCode?: unknown } | undefined)?.inviteCode;
    if (typeof code === 'string' && registration.inviteCodes.some(known => secretMatches(known, code))) {
      return 'invite';
    }
    return undefined;
  };

  /** Auth required: invite-only, 12-character minimum, one generic failure. */
  const hardenedRegister = async (req: AuthedRequest, res: Response) => {
    if (!auth) return res.status(503).json({ error: 'Auth requires PostgreSQL backend' });
    const address = addressOf(req);
    if (rateLimited(res, [addressLimiter.check(address)])) return undefined;

    const route = registrationRoute(req);
    if (route === undefined) {
      addressLimiter.fail(address);
      return res.status(403).json({ error: 'Registration is by invitation only.' });
    }

    const { email, password, displayName } = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof email !== 'string' ||
      !EMAIL_SHAPE.test(email.trim()) ||
      typeof password !== 'string' ||
      password.length < MIN_PASSWORD_LENGTH_AUTH_REQUIRED
    ) {
      return res.status(400).json({
        error: `A valid email and a password of at least ${MIN_PASSWORD_LENGTH_AUTH_REQUIRED} characters are required.`,
      });
    }

    try {
      const name = typeof displayName === 'string' ? displayName.slice(0, 100) : undefined;
      const session = await auth.register(email, password, name);
      if (route === 'admin') {
        // Do not swap the admin's session for the new user's, and do not leave
        // an unused 30-day session row behind.
        await auth.logout(session.token);
        return res.json({ user: session.user });
      }
      setSessionCookieForRequest(req, res, session.token, session.expiresAt, loopback);
      return res.json({ user: session.user });
    } catch (err) {
      // The cause (duplicate email, database error) goes to the log only.
      console.error('Registration failed:', err instanceof Error ? err.message : String(err));
      return res.status(400).json({ error: GENERIC_REGISTER_FAILURE });
    }
  };

  app.post(
    '/api/auth/register',
    AUTH_REQUIRED ? optionalAuth : (_req, _res, next) => next(),
    async (req: AuthedRequest, res) => {
      if (AUTH_REQUIRED) return hardenedRegister(req, res);
      return openRegister(req, res);
    }
  );

  /* ---- login ------------------------------------------------------------- */

  /** Auth off: the original behavior, unchanged. */
  const openLogin = async (req: Request, res: Response) => {
    if (!auth) return res.status(503).json({ error: 'Auth requires PostgreSQL backend' });
    try {
      const { email, password } = req.body ?? {};
      const session = await auth.login(String(email ?? ''), String(password ?? ''));
      setSessionCookie(res, session.token, session.expiresAt);
      res.json({ user: session.user });
    } catch (_err) {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  };

  /** Auth required: rate limited, and the cookie is `Secure` off loopback. */
  const hardenedLogin = async (req: Request, res: Response) => {
    if (!auth) return res.status(503).json({ error: 'Auth requires PostgreSQL backend' });
    const address = addressOf(req);
    const email = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254);
    const accountKey = `${address}|${email}`;
    if (rateLimited(res, [accountLimiter.check(accountKey), addressLimiter.check(address)])) return undefined;
    try {
      const session = await auth.login(email, String(req.body?.password ?? ''));
      accountLimiter.reset(accountKey);
      setSessionCookieForRequest(req, res, session.token, session.expiresAt, loopback);
      return res.json({ user: session.user });
    } catch (err) {
      // Only a wrong password or unknown email counts. A database outage must
      // not lock real users out.
      if (err instanceof Error && err.message === 'INVALID_CREDENTIALS') {
        accountLimiter.fail(accountKey);
        addressLimiter.fail(address);
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  };

  app.post('/api/auth/login', async (req, res) => {
    if (AUTH_REQUIRED) return hardenedLogin(req, res);
    return openLogin(req, res);
  });

  /* ---- session and invite ------------------------------------------------ */

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
