/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * S3: every workspace route acts as the signed-in user, with the scope passed on
 * each call, never through shared repo state.
 *
 * Runs the REAL route module on a real Express app over real HTTP, against a real
 * SQLite file, with `AUTH_REQUIRED: true` and a stand-in auth middleware that
 * reads the user from a header. Nothing here calls `repo.setScope`: a test that
 * did could not tell a scoped route from an unscoped one.
 *
 * The Postgres twin is `tests/workspaceScopePg.test.ts` (skipped without PG_TEST_URL).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import { SqliteRepo, type WorkspaceRepo } from '../apps/shell/lib/workspaceRepo';
import type { Workspace, ScoringSettings } from '../../packages/core/src/types';

const USERS: Record<string, { id: string; email: string; displayName: string; teamId: string }> = {
  alice: { id: 'user-alice', email: 'alice@x.test', displayName: 'Alice', teamId: 'team-a' },
  bob: { id: 'user-bob', email: 'bob@x.test', displayName: 'Bob', teamId: 'team-b' },
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
  vi.restoreAllMocks();
});

interface Harness {
  url: string;
  repo: WorkspaceRepo;
  setScopeSpy: ReturnType<typeof vi.spyOn>;
}

async function boot(opts: { authRequired: boolean; admins?: string[] }): Promise<Harness> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-scope-routes-'));
  const repo = new SqliteRepo(path.join(dir, 'omniswim.db'), path.join(dir, 'backups'), () => []);
  await repo.init();
  const setScopeSpy = vi.spyOn(repo, 'setScope' as never);

  const withUser: express.RequestHandler = (req, _res, next) => {
    const name = req.headers['x-test-user'];
    if (typeof name === 'string' && USERS[name]) (req as express.Request & { user?: unknown }).user = USERS[name];
    next();
  };
  const requireUser: express.RequestHandler = (req, res, next) => {
    withUser(req, res, () => {
      if (!(req as express.Request & { user?: unknown }).user) return res.status(401).json({ error: 'auth' });
      next();
    });
  };

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  registerWorkspaceRoutes(app, {
    repo,
    auth: null,
    shareLinks: null,
    AUTH_REQUIRED: opts.authRequired,
    requireAuth: requireUser,
    optionalAuth: withUser,
    defaultScoringSettings: {} as ScoringSettings,
    isAdmin: req => {
      const u = (req as express.Request & { user?: { id: string } }).user;
      return !!u && (opts.admins ?? []).includes(u.id);
    },
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
  return { url: `http://127.0.0.1:${addr.port}`, repo, setScopeSpy };
}

async function call(h: Harness, user: string | null, method: string, route: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  const res = await fetch(`${h.url}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html report */
  }
  return { status: res.status, json: json as any, text };
}

const ws = (id: string, name: string) => ({ id, name, menResults: [], womenResults: [], recruits: [], createdAt: 1 });

async function twoTenants(h: Harness) {
  expect((await call(h, 'alice', 'POST', '/api/workspaces', ws('ws-alice', 'Alice Meet'))).status).toBe(200);
  expect((await call(h, 'bob', 'POST', '/api/workspaces', ws('ws-bob', 'Bob Meet'))).status).toBe(200);
}

describe('S3: per-call scope on every workspace route (AUTH_REQUIRED)', () => {
  it('lists only the caller own workspaces, including under interleaved requests', async () => {
    const h = await boot({ authRequired: true });
    await twoTenants(h);

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => call(h, i % 2 ? 'bob' : 'alice', 'GET', '/api/workspaces'))
    );
    results.forEach((r, i) => {
      const ids = (r.json as Workspace[]).map(w => w.id);
      expect(ids).toEqual([i % 2 ? 'ws-bob' : 'ws-alice']);
    });
    // The acceptance is "not through a setter".
    expect(h.setScopeSpy).not.toHaveBeenCalled();
  });

  it('refuses another tenant on update, delete, report, snapshots and snapshot content', async () => {
    const h = await boot({ authRequired: true });
    await twoTenants(h);
    const snap = await call(h, 'alice', 'POST', '/api/workspaces/ws-alice/snapshots', { label: 'a' });
    expect(snap.status).toBe(200);

    expect((await call(h, 'bob', 'PUT', '/api/workspaces/ws-alice', { name: 'Hijacked' })).status).toBe(404);
    expect((await call(h, 'bob', 'GET', '/api/workspaces/ws-alice/report')).status).toBe(404);
    expect((await call(h, 'bob', 'POST', '/api/workspaces/ws-alice/snapshots', { label: 'x' })).status).toBe(400);
    expect((await call(h, 'bob', 'GET', '/api/workspaces/ws-alice/snapshots')).json).toEqual([]);
    // The blob is a full copy of Alice's workspace; its id is not a secret.
    expect((await call(h, 'bob', 'GET', `/api/snapshots/${snap.json.id}`)).status).toBe(404);
    expect((await call(h, 'bob', 'POST', `/api/snapshots/${snap.json.id}/restore`)).status).toBe(404);
    await call(h, 'bob', 'DELETE', '/api/workspaces/ws-alice');

    const mine = await call(h, 'alice', 'GET', '/api/workspaces');
    expect(mine.json).toHaveLength(1);
    expect(mine.json[0].name).toBe('Alice Meet');
    expect((await call(h, 'alice', 'GET', `/api/snapshots/${snap.json.id}`)).status).toBe(200);
  });

  it('a create with another tenant id is refused and leaves their data alone', async () => {
    const h = await boot({ authRequired: true });
    await twoTenants(h);
    const clash = await call(h, 'bob', 'POST', '/api/workspaces', { ...ws('ws-alice', 'Taken Over'), menResults: [] });
    expect(clash.status).toBe(409);
    const mine = await call(h, 'alice', 'GET', '/api/workspaces');
    expect(mine.json.map((w: Workspace) => w.name)).toEqual(['Alice Meet']);
  });

  it('backup list and restore are admin-only when AUTH_REQUIRED, and refuse before reading the body', async () => {
    const h = await boot({ authRequired: true, admins: ['user-alice'] });
    await twoTenants(h);
    const made = await call(h, 'alice', 'POST', '/api/workspaces/backup');
    expect(made.status).toBe(200);

    expect((await call(h, 'bob', 'GET', '/api/workspaces/backups')).status).toBe(403);
    const refused = await call(h, 'bob', 'POST', '/api/workspaces/restore', { file: made.json.file });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('ADMIN_REQUIRED');
    // Even a malformed body is a 403 for a non-admin, never a 400 that confirms the route exists.
    expect((await call(h, 'bob', 'POST', '/api/workspaces/restore', {})).status).toBe(403);
    // Bob's refusal changed nothing.
    expect((await call(h, 'alice', 'GET', '/api/workspaces')).json).toHaveLength(1);

    expect((await call(h, 'alice', 'GET', '/api/workspaces/backups')).status).toBe(200);
  });

  it('a manual backup holds only the caller workspaces', async () => {
    const h = await boot({ authRequired: true });
    await twoTenants(h);
    const made = await call(h, 'alice', 'POST', '/api/workspaces/backup');
    const body = JSON.parse(await fsp.readFile(path.join((h.repo as any).backupDir, made.json.file), 'utf-8'));
    expect(body.map((w: Workspace) => w.id)).toEqual(['ws-alice']);
  });

  it('a global restore keeps each tenant owner, so nothing is orphaned', async () => {
    const h = await boot({ authRequired: true, admins: ['user-alice'] });
    await twoTenants(h);
    // Admin restore is the only path that replaces everyone; the snapshot of all data comes from the repo.
    const file = path.basename(await h.repo.backup('manual', {}));
    await call(h, 'bob', 'PUT', '/api/workspaces/ws-bob', { name: 'Bob edited' });
    const restored = await call(h, 'alice', 'POST', '/api/workspaces/restore', { file });
    expect(restored.status).toBe(200);
    expect(restored.json.workspaces).toBe(2);
    const bob = await call(h, 'bob', 'GET', '/api/workspaces');
    expect(bob.json.map((w: Workspace) => w.name)).toEqual(['Bob Meet']);
    const alice = await call(h, 'alice', 'GET', '/api/workspaces');
    expect(alice.json.map((w: Workspace) => w.id)).toEqual(['ws-alice']);
  });

  it('without AUTH_REQUIRED (one local user) backups and restore behave as before', async () => {
    const h = await boot({ authRequired: false });
    await call(h, null, 'POST', '/api/workspaces', ws('ws-local', 'Local'));
    expect((await call(h, null, 'GET', '/api/workspaces/backups')).status).toBe(200);
    const made = await call(h, null, 'POST', '/api/workspaces/backup');
    expect((await call(h, null, 'POST', '/api/workspaces/restore', { file: made.json.file })).status).toBe(200);
  });
});
