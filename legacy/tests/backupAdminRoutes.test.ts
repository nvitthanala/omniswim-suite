/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * E9: under `AUTH_REQUIRED`, listing and restoring backups is for an administrator,
 * and an administrator is a signed-in user whose email is in `OMNI_ADMIN_EMAILS`.
 *
 * The real route module runs on a real Express app over real HTTP against a real
 * SQLite file. `isAdmin` is built the way `server.ts` builds it, from
 * `registrationConfigFromEnv` and `isAdminUser`, so this tests the wiring and not a
 * stub keyed on user ids. Only the sign-in step is a stand-in: it reads the user
 * from a header.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import { isAdminUser, registrationConfigFromEnv } from '../apps/shell/lib/routes/authRoutes';
import { SqliteRepo } from '../apps/shell/lib/workspaceRepo';
import type { ScoringSettings } from '../../packages/core/src/types';

const USERS: Record<string, { id: string; email: string; displayName: string; teamId: string }> = {
  alice: { id: 'user-alice', email: 'alice@x.test', displayName: 'Alice', teamId: 'team-a' },
  bob: { id: 'user-bob', email: 'bob@x.test', displayName: 'Bob', teamId: 'team-b' },
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function boot(adminEmails: string | undefined) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-backup-admin-'));
  const repo = new SqliteRepo(path.join(dir, 'omniswim.db'), path.join(dir, 'backups'), () => []);
  await repo.init();

  type Req = express.Request & { user?: (typeof USERS)[string] };
  const withUser: express.RequestHandler = (req, _res, next) => {
    const name = req.headers['x-test-user'];
    if (typeof name === 'string' && USERS[name]) (req as Req).user = USERS[name];
    next();
  };
  const requireUser: express.RequestHandler = (req, res, next) => {
    withUser(req, res, () => {
      if (!(req as Req).user) return res.status(401).json({ error: 'auth' });
      next();
    });
  };

  const registration = registrationConfigFromEnv({ OMNI_ADMIN_EMAILS: adminEmails });
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, {
    repo,
    auth: null,
    shareLinks: null,
    AUTH_REQUIRED: true,
    requireAuth: requireUser,
    optionalAuth: withUser,
    defaultScoringSettings: {} as ScoringSettings,
    isAdmin: req => isAdminUser(registration, (req as Req).user),
  });
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  open.push(async () => {
    await new Promise<void>(r => server.close(() => r()));
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return `http://127.0.0.1:${addr.port}`;
}

async function call(url: string, user: string | null, method: 'GET' | 'POST', route: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  const res = await fetch(`${url}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json: json as { code?: string } | unknown[] | null };
}

describe('E9: backup list and restore are for OMNI_ADMIN_EMAILS under AUTH_REQUIRED', () => {
  it('lets an administrator list backups, whatever the case or spacing in the env value', async () => {
    const url = await boot(' Alice@X.Test , someone-else@x.test ');
    const list = await call(url, 'alice', 'GET', '/api/workspaces/backups');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.json)).toBe(true);
  });

  it('lets an administrator reach restore (an empty body is then refused as a 400, not a 403)', async () => {
    const url = await boot('alice@x.test');
    const restore = await call(url, 'alice', 'POST', '/api/workspaces/restore', {});
    expect(restore.status).toBe(400);
    expect((restore.json as { code?: string }).code).toBe('BACKUP_FILE_REQUIRED');
  });

  it('answers 403 ADMIN_REQUIRED to a signed-in user who is not listed, on list and on restore', async () => {
    const url = await boot('alice@x.test');
    const list = await call(url, 'bob', 'GET', '/api/workspaces/backups');
    expect(list.status).toBe(403);
    expect((list.json as { code?: string }).code).toBe('ADMIN_REQUIRED');
    const restore = await call(url, 'bob', 'POST', '/api/workspaces/restore', { file: 'anything.json' });
    expect(restore.status).toBe(403);
    expect((restore.json as { code?: string }).code).toBe('ADMIN_REQUIRED');
  });

  it('answers 401 when nobody is signed in, before the admin check', async () => {
    const url = await boot('alice@x.test');
    expect((await call(url, null, 'GET', '/api/workspaces/backups')).status).toBe(401);
    expect((await call(url, null, 'POST', '/api/workspaces/restore', { file: 'x' })).status).toBe(401);
  });

  it('answers 403 to everyone when the env list is empty or unset', async () => {
    for (const env of [undefined, '', ' , ,']) {
      const url = await boot(env);
      expect((await call(url, 'alice', 'GET', '/api/workspaces/backups')).status).toBe(403);
      expect((await call(url, 'alice', 'POST', '/api/workspaces/restore', {})).status).toBe(403);
    }
  });
});

describe('isAdminUser', () => {
  const config = registrationConfigFromEnv({ OMNI_ADMIN_EMAILS: 'Boss@Example.com' });

  it('matches the email without regard to case or surrounding spaces', () => {
    expect(isAdminUser(config, { email: ' boss@EXAMPLE.com ' })).toBe(true);
  });

  it('is false for another email, no email and no user', () => {
    expect(isAdminUser(config, { email: 'other@example.com' })).toBe(false);
    expect(isAdminUser(config, { email: '' })).toBe(false);
    expect(isAdminUser(config, {})).toBe(false);
    expect(isAdminUser(config, undefined)).toBe(false);
  });

  it('is false for every user when the list is empty', () => {
    expect(isAdminUser(registrationConfigFromEnv({}), { email: 'boss@example.com' })).toBe(false);
  });
});
