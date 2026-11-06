/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * S4 (decision U11): auth route hardening when `AUTH_REQUIRED`.
 * `apps/shell/lib/routes/authRoutes.ts`, `middleware/attemptLimiter.ts`,
 * `middleware/sessionCookie.ts`.
 *
 * The routes run in a real Express app on a real ephemeral socket against an
 * in-memory fake of `AuthService`, so the suite needs no PostgreSQL and adds no
 * skips. `auth: null` is covered too, so the 503 path stays proved.
 */
import express from 'express';
import { describe, expect, it } from 'vitest';
import type { AuthService } from '../packages/db/src/AuthService';
import { createAuthMiddleware, getSessionToken } from '../apps/shell/lib/authMiddleware';
import {
  MIN_PASSWORD_LENGTH_AUTH_REQUIRED,
  registerAuthRoutes,
  registrationBannerLines,
  registrationConfigFromEnv,
  type AuthRateLimitSettings,
  type RegistrationConfig,
} from '../apps/shell/lib/routes/authRoutes';
import { createAttemptLimiter } from '../apps/shell/lib/middleware/attemptLimiter';
import { startTestServer, type TestServer } from '../../tests/helpers/rawHttp';

const INVITE = 'invite-code-0123456789';
const ADMIN_EMAIL = 'admin@example.com';
const GOOD_PASSWORD = 'correct horse battery';

interface FakeUser {
  id: string;
  email: string;
  password: string;
}

/** Just enough of `AuthService` for the routes, with call recording. */
class FakeAuth {
  users = new Map<string, FakeUser>();
  sessions = new Map<string, string>();
  registerCalls = 0;
  loginCalls = 0;
  logoutCalls: string[] = [];
  /** When set, `login` throws this instead of checking credentials (a database outage). */
  loginFailure: Error | undefined;
  /** When set, `register` throws this after checking for a duplicate. */
  registerFailure: Error | undefined;
  private counter = 0;

  async register(email: string, password: string, displayName?: string) {
    this.registerCalls += 1;
    const normalized = email.trim().toLowerCase();
    if (this.users.has(normalized)) throw new Error('EMAIL_EXISTS');
    if (this.registerFailure) throw this.registerFailure;
    this.counter += 1;
    const user = { id: `u${this.counter}`, email: normalized, password };
    this.users.set(normalized, user);
    return this.session(user, displayName);
  }

  async login(email: string, password: string) {
    this.loginCalls += 1;
    if (this.loginFailure) throw this.loginFailure;
    const user = this.users.get(email.trim().toLowerCase());
    if (!user || user.password !== password) throw new Error('INVALID_CREDENTIALS');
    return this.session(user);
  }

  async validateSession(token: string) {
    const email = this.sessions.get(token);
    if (!email) return null;
    const user = this.users.get(email);
    return user ? { id: user.id, email: user.email, displayName: '', teamId: 'team-1' } : null;
  }

  async logout(token: string) {
    this.logoutCalls.push(token);
    this.sessions.delete(token);
  }

  async inviteToTeam() {}

  /** Seed a user and return a live session token for them. */
  seed(email: string, password = GOOD_PASSWORD): string {
    this.counter += 1;
    this.users.set(email, { id: `u${this.counter}`, email, password });
    const token = `seed-token-${this.counter}`;
    this.sessions.set(token, email);
    return token;
  }

  private session(user: FakeUser, displayName?: string) {
    const token = `token-${user.id}-${this.sessions.size}`;
    this.sessions.set(token, user.email);
    return {
      token,
      expiresAt: Date.now() + 60_000,
      user: { id: user.id, email: user.email, displayName: displayName ?? '', teamId: 'team-1' },
    };
  }
}

interface Setup {
  readonly auth: FakeAuth | null;
  readonly authRequired?: boolean;
  readonly registration?: RegistrationConfig;
  readonly rateLimit?: AuthRateLimitSettings;
}

async function mount(setup: Setup): Promise<TestServer> {
  return startTestServer(() => {
    const app = express();
    app.use(express.json());
    const service = setup.auth as unknown as AuthService | null;
    registerAuthRoutes(app, {
      auth: service,
      optionalAuth: createAuthMiddleware(service, false),
      requireAuth: createAuthMiddleware(service, true),
      AUTH_REQUIRED: setup.authRequired ?? true,
      ...(setup.registration === undefined ? {} : { registration: setup.registration }),
      ...(setup.rateLimit === undefined ? {} : { rateLimit: setup.rateLimit }),
    });
    return app;
  });
}

const invited: RegistrationConfig = { inviteCodes: [INVITE], adminEmails: [ADMIN_EMAIL] };
const register = (server: TestServer, body: unknown, headers: Record<string, string> = {}) =>
  server.request({ method: 'POST', path: '/api/auth/register', body, headers });
const login = (server: TestServer, email: string, password: string, headers: Record<string, string> = {}) =>
  server.request({ method: 'POST', path: '/api/auth/login', body: { email, password }, headers });

describe('S4 password minimum', () => {
  it('rejects an invited registration whose password is 11 characters, and never calls register', async () => {
    const auth = new FakeAuth();
    const server = await mount({ auth, registration: invited });
    try {
      const short = 'a'.repeat(MIN_PASSWORD_LENGTH_AUTH_REQUIRED - 1);
      const res = await register(server, { email: 'new@example.com', password: short, inviteCode: INVITE });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/12 characters/);
      expect(auth.registerCalls).toBe(0);

      const ok = await register(server, {
        email: 'new@example.com',
        password: 'a'.repeat(MIN_PASSWORD_LENGTH_AUTH_REQUIRED),
        inviteCode: INVITE,
      });
      expect(ok.status).toBe(200);
      expect(ok.json.user.email).toBe('new@example.com');
    } finally {
      await server.close();
    }
  });
});

describe('S4 invite-only registration', () => {
  it('refuses a caller with no invite and never reaches the database', async () => {
    const auth = new FakeAuth();
    auth.seed('taken@example.com');
    const server = await mount({ auth, registration: invited });
    try {
      const res = await register(server, { email: 'new@example.com', password: GOOD_PASSWORD });
      expect(res.status).toBe(403);
      // A caller with no invite gets the same answer for a taken email and a new one.
      const probe = await register(server, { email: 'taken@example.com', password: GOOD_PASSWORD });
      expect(probe.status).toBe(403);
      expect(probe.json).toEqual(res.json);
      expect(auth.registerCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('refuses a wrong invite code', async () => {
    const auth = new FakeAuth();
    const server = await mount({ auth, registration: invited });
    try {
      const res = await register(server, { email: 'new@example.com', password: GOOD_PASSWORD, inviteCode: 'not-it' });
      expect(res.status).toBe(403);
      expect(auth.registerCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('accepts a valid invite code and signs the new user in', async () => {
    const auth = new FakeAuth();
    const server = await mount({ auth, registration: invited });
    try {
      const res = await register(server, { email: 'New@Example.com', password: GOOD_PASSWORD, inviteCode: INVITE });
      expect(res.status).toBe(200);
      expect(String(res.headers['set-cookie'])).toMatch(/^omni_session=token-/);
      expect(auth.registerCalls).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('lets a signed-in admin register another user without swapping the admin session', async () => {
    const auth = new FakeAuth();
    const adminToken = auth.seed(ADMIN_EMAIL);
    const server = await mount({ auth, registration: invited });
    try {
      const res = await register(
        server,
        { email: 'coach@example.com', password: GOOD_PASSWORD },
        { Authorization: `Bearer ${adminToken}` }
      );
      expect(res.status).toBe(200);
      expect(res.json.user.email).toBe('coach@example.com');
      expect(res.headers['set-cookie']).toBeUndefined();
      // The session register() minted for the new user is deleted, not left behind.
      expect(auth.logoutCalls).toHaveLength(1);
      expect(auth.sessions.get(adminToken)).toBe(ADMIN_EMAIL);
    } finally {
      await server.close();
    }
  });

  it('does not let a signed-in user who is not on the admin list register someone', async () => {
    const auth = new FakeAuth();
    const memberToken = auth.seed('member@example.com');
    const server = await mount({ auth, registration: invited });
    try {
      const res = await register(
        server,
        { email: 'coach@example.com', password: GOOD_PASSWORD },
        { Authorization: `Bearer ${memberToken}` }
      );
      expect(res.status).toBe(403);
      expect(auth.registerCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('is closed, not open, when no invite code or admin is configured', async () => {
    const auth = new FakeAuth();
    const server = await mount({ auth });
    try {
      const res = await register(server, { email: 'new@example.com', password: GOOD_PASSWORD, inviteCode: '' });
      expect(res.status).toBe(403);
      expect(auth.registerCalls).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe('S4 generic registration failure', () => {
  it('answers a duplicate email and a database error with the same status and body', async () => {
    const auth = new FakeAuth();
    auth.seed('taken@example.com');
    const server = await mount({ auth, registration: invited });
    try {
      const duplicate = await register(server, {
        email: 'taken@example.com',
        password: GOOD_PASSWORD,
        inviteCode: INVITE,
      });
      auth.registerFailure = new Error('connect ECONNREFUSED 10.0.0.5:5432');
      const outage = await register(server, {
        email: 'fresh@example.com',
        password: GOOD_PASSWORD,
        inviteCode: INVITE,
      });
      expect(duplicate.status).toBe(400);
      expect(outage.status).toBe(400);
      expect(duplicate.json).toEqual(outage.json);
      expect(duplicate.text).not.toMatch(/exist|EMAIL|already|409|ECONNREFUSED/i);
    } finally {
      await server.close();
    }
  });
});

describe('S4 login rate limit', () => {
  it('blocks an account after repeated failures, answers 429 with Retry-After, and recovers after the window', async () => {
    const auth = new FakeAuth();
    auth.seed('coach@example.com');
    let now = 1_000_000;
    const server = await mount({
      auth,
      registration: invited,
      rateLimit: { maxPerAccount: 3, maxPerAddress: 100, windowMs: 60_000, now: () => now },
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await login(server, 'coach@example.com', 'wrong password')).status).toBe(401);
      }
      expect(auth.loginCalls).toBe(3);

      // The fourth try is refused before the database is asked, even with the right password.
      const blocked = await login(server, 'coach@example.com', GOOD_PASSWORD);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(auth.loginCalls).toBe(3);

      // A different account from the same address is not blocked by that account's counter.
      auth.seed('other@example.com');
      expect((await login(server, 'other@example.com', GOOD_PASSWORD)).status).toBe(200);

      now += 60_001;
      expect((await login(server, 'coach@example.com', GOOD_PASSWORD)).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('blocks an address that tries many different accounts', async () => {
    const auth = new FakeAuth();
    const server = await mount({
      auth,
      rateLimit: { maxPerAccount: 100, maxPerAddress: 3, windowMs: 60_000 },
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await login(server, `nobody${attempt}@example.com`, 'x')).status).toBe(401);
      }
      expect((await login(server, 'nobody9@example.com', 'x')).status).toBe(429);
    } finally {
      await server.close();
    }
  });

  it('counts bad invite codes against the address, so a code cannot be guessed freely', async () => {
    const auth = new FakeAuth();
    const server = await mount({
      auth,
      registration: invited,
      rateLimit: { maxPerAccount: 100, maxPerAddress: 3, windowMs: 60_000 },
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await register(server, { email: 'a@example.com', password: GOOD_PASSWORD, inviteCode: `guess-${attempt}` });
        expect(res.status).toBe(403);
      }
      // Now even the real code is refused until the window passes.
      const res = await register(server, { email: 'a@example.com', password: GOOD_PASSWORD, inviteCode: INVITE });
      expect(res.status).toBe(429);
      expect(auth.registerCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('does not count a database outage as a failed login', async () => {
    const auth = new FakeAuth();
    auth.loginFailure = new Error('connect ECONNREFUSED');
    const server = await mount({ auth, rateLimit: { maxPerAccount: 2, maxPerAddress: 2, windowMs: 60_000 } });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login(server, 'coach@example.com', 'x')).status).toBe(401);
      }
    } finally {
      await server.close();
    }
  });
});

describe('S4 Secure session cookie', () => {
  it('omits Secure for a loopback request and sets it when the Host is not loopback', async () => {
    const auth = new FakeAuth();
    auth.seed('coach@example.com');
    const server = await mount({ auth, registration: invited });
    try {
      const local = await login(server, 'coach@example.com', GOOD_PASSWORD);
      expect(local.status).toBe(200);
      const localCookie = String(local.headers['set-cookie']);
      expect(localCookie).toMatch(/HttpOnly/);
      expect(localCookie).not.toMatch(/Secure/);

      const remote = await login(server, 'coach@example.com', GOOD_PASSWORD, { Host: 'omni.example.com' });
      expect(remote.status).toBe(200);
      expect(String(remote.headers['set-cookie'])).toMatch(/; Secure$/);

      const registered = await register(
        server,
        { email: 'new@example.com', password: GOOD_PASSWORD, inviteCode: INVITE },
        { Host: 'omni.example.com' }
      );
      expect(String(registered.headers['set-cookie'])).toMatch(/; Secure$/);
    } finally {
      await server.close();
    }
  });

  it('writes a cookie the reader can parse back to the same token', async () => {
    const auth = new FakeAuth();
    auth.seed('coach@example.com');
    const server = await mount({ auth });
    try {
      const res = await login(server, 'coach@example.com', GOOD_PASSWORD, { Host: 'omni.example.com' });
      const header = String(res.headers['set-cookie']);
      const pair = header.split(';')[0];
      const token = getSessionToken({ headers: { cookie: pair } } as unknown as express.Request);
      const issued = [...auth.sessions.keys()].find(key => key.startsWith('token-'));
      expect(issued).toBeDefined();
      expect(token).toBe(issued);
    } finally {
      await server.close();
    }
  });
});

describe('S4 with auth off or unavailable', () => {
  it('keeps the old behavior when AUTH_REQUIRED is off', async () => {
    const auth = new FakeAuth();
    auth.seed('taken@example.com');
    const server = await mount({ auth, authRequired: false });
    try {
      // 6-character passwords and registration with no invite still work.
      const ok = await register(server, { email: 'new@example.com', password: 'abcdef' });
      expect(ok.status).toBe(200);
      // A duplicate email is still the distinct 409.
      const duplicate = await register(server, { email: 'taken@example.com', password: 'abcdef' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.json.error).toBe('EMAIL_EXISTS');
      // No rate limit, no Secure flag.
      for (let attempt = 0; attempt < 15; attempt += 1) {
        expect((await login(server, 'taken@example.com', 'wrong', { Host: 'omni.example.com' })).status).toBe(401);
      }
      const good = await login(server, 'taken@example.com', GOOD_PASSWORD, { Host: 'omni.example.com' });
      expect(good.status).toBe(200);
      expect(String(good.headers['set-cookie'])).not.toMatch(/Secure/);
    } finally {
      await server.close();
    }
  });

  it('answers 503 when there is no auth service', async () => {
    const server = await mount({ auth: null, registration: invited });
    try {
      expect((await register(server, { email: 'a@example.com', password: GOOD_PASSWORD, inviteCode: INVITE })).status).toBe(503);
      expect((await login(server, 'a@example.com', GOOD_PASSWORD)).status).toBe(503);
    } finally {
      await server.close();
    }
  });
});

describe('S4 configuration and limiter', () => {
  it('parses invite codes and admin emails from the environment', () => {
    const config = registrationConfigFromEnv({
      OMNI_INVITE_CODES: ` ${INVITE}, another-long-code-1234 `,
      OMNI_ADMIN_EMAILS: 'Admin@Example.com',
    });
    expect(config.inviteCodes).toEqual([INVITE, 'another-long-code-1234']);
    expect(config.adminEmails).toEqual(['admin@example.com']);
  });

  it('refuses an invite code that is too short to be a gate', () => {
    expect(() => registrationConfigFromEnv({ OMNI_INVITE_CODES: 'abc123' })).toThrow(/shorter than 12/);
  });

  it('says plainly when registration is closed', () => {
    expect(registrationBannerLines({ inviteCodes: [], adminEmails: [] }).join(' ')).toMatch(/CLOSED/);
    expect(registrationBannerLines(invited).join(' ')).toMatch(/invite-only/);
  });

  it('bounds memory: tracked keys never exceed the cap', () => {
    const limiter = createAttemptLimiter({ maxAttempts: 1, windowMs: 60_000, maxKeys: 5 });
    for (let key = 0; key < 50; key += 1) limiter.fail(`key-${key}`);
    // The oldest keys were evicted, so they are allowed again; the newest are still blocked.
    expect(limiter.check('key-0').allowed).toBe(true);
    expect(limiter.check('key-49').allowed).toBe(false);
  });
});
