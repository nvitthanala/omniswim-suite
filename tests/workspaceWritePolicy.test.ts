/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P1 (allowlisted patch), P2 (duplicate id), P3 server half (expected version),
 * against the REAL route module over real HTTP on BOTH file-backed stores (JSON
 * and SQLite). The same assertions run on Postgres in
 * `tests/workspaceScopePg.test.ts` when PG_TEST_URL is set.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { promises as fsp } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import { JsonRepo, SqliteRepo, type WorkspaceRepo } from '../apps/shell/lib/workspaceRepo';
import { EXPECTED_VERSION_HEADER } from '../packages/core/src/api/saveSequence';
import { updateWorkspaceSchema, workspacePatchShape } from '../packages/core/src/schemas/workspace';
import type { Workspace, ScoringSettings } from '../packages/core/src/types';

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function boot(kind: 'json' | 'sqlite') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `omni-policy-${kind}-`));
  const backups = path.join(dir, 'backups');
  const repo: WorkspaceRepo =
    kind === 'json'
      ? new JsonRepo(path.join(dir, 'meets.json'), backups, () => [])
      : new SqliteRepo(path.join(dir, 'omniswim.db'), backups, () => []);
  await repo.init();
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  const pass: express.RequestHandler = (_q, _s, n) => n();
  registerWorkspaceRoutes(app, {
    repo,
    auth: null,
    shareLinks: null,
    AUTH_REQUIRED: false,
    requireAuth: pass,
    optionalAuth: pass,
    defaultScoringSettings: {} as ScoringSettings,
  });
  const server: Server = await new Promise(r => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  open.push(async () => {
    await new Promise<void>(r => server.close(() => r()));
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return { url: `http://127.0.0.1:${addr.port}`, repo };
}

async function http(url: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const base = (id: string) => ({
  id,
  name: 'HSU',
  menResults: [{ id: 'r1', name: 'A', event: '50 Y Free', time: '21.00' }],
  womenResults: [],
  recruits: [],
  createdAt: 1000,
});

describe.each(['json', 'sqlite'] as const)('workspace write policy on the %s store', kind => {
  it('P2: a second create with the same id is 409 and changes nothing', async () => {
    const h = await boot(kind);
    expect((await http(`${h.url}/api/workspaces`, 'POST', base('dup'))).status).toBe(200);
    const again = await http(`${h.url}/api/workspaces`, 'POST', { ...base('dup'), name: 'Overwritten' });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('DUPLICATE_WORKSPACE_ID');
    const list = await http(`${h.url}/api/workspaces`, 'GET');
    expect(list.json).toHaveLength(1);
    expect(list.json[0].name).toBe('HSU');
    expect(list.json[0].menResults).toHaveLength(1);
  });

  it('P1: a malformed patch is 400 and writes nothing', async () => {
    const h = await boot(kind);
    await http(`${h.url}/api/workspaces`, 'POST', base('p1'));
    for (const bad of [
      { menResults: { not: 'an array' } },
      { menResults: [1, 2, 3] },
      { recruits: 'nope' },
      { activeEntryIds: [{ id: 'x' }] },
      { name: 42 },
      { scoringView: 'sideways' },
      { loadedMeet: [] },
    ]) {
      const r = await http(`${h.url}/api/workspaces/p1`, 'PUT', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const after = (await http(`${h.url}/api/workspaces`, 'GET')).json[0];
    expect(after.name).toBe('HSU');
    expect(after.menResults).toHaveLength(1);
    expect(after.version).toBe(1);
  });

  it('P1: id, createdAt and version in a patch are ignored; unknown keys are dropped', async () => {
    const h = await boot(kind);
    await http(`${h.url}/api/workspaces`, 'POST', base('p1b'));
    const r = await http(`${h.url}/api/workspaces/p1b`, 'PUT', {
      id: 'stolen',
      createdAt: 5,
      version: 1,
      name: 'Renamed',
      isAdmin: true,
    });
    expect(r.status).toBe(200);
    expect(r.json.id).toBe('p1b');
    expect(r.json.createdAt).toBe(1000);
    expect(r.json.name).toBe('Renamed');
    expect(r.json.version).toBe(2); // the store's counter, not the client's 1
    expect(r.json).not.toHaveProperty('isAdmin');
    const list = (await http(`${h.url}/api/workspaces`, 'GET')).json as Workspace[];
    expect(list.map(w => w.id)).toEqual(['p1b']);
  });

  it('P1: a patch that sets every collection the app saves round-trips intact', async () => {
    const h = await boot(kind);
    await http(`${h.url}/api/workspaces`, 'POST', base('p1c'));
    const patch = {
      menResults: [{ id: 'm', name: 'M', event: '100 Y Back', time: '50.00', extra: { kept: true } }],
      deletedSwimmers: [{ name: 'Gone', gender: 'Men' }],
      scorerRosterOverrides: [{ name: 'S', team: 'HSU', gender: 'Men', isScorer: true }],
      activeEntryIds: ['e1', 'e2'],
      scoringView: 'pdf_only',
      conference: 'NSISC',
    };
    const r = await http(`${h.url}/api/workspaces/p1c`, 'PUT', patch);
    expect(r.status).toBe(200);
    expect(r.json.menResults[0].extra).toEqual({ kept: true });
    expect(r.json.deletedSwimmers).toEqual(patch.deletedSwimmers);
    expect(r.json.scorerRosterOverrides).toEqual(patch.scorerRosterOverrides);
    expect(r.json.activeEntryIds).toEqual(['e1', 'e2']);
    expect(r.json.scoringView).toBe('pdf_only');
    expect(r.json.conference).toBe('NSISC');
  });

  it('P3: the stored version is returned, bumps on every save, and a stale one is 409 with nothing written', async () => {
    const h = await boot(kind);
    const created = await http(`${h.url}/api/workspaces`, 'POST', { ...base('p3'), version: 77 });
    expect(created.json.version).toBe(1); // a client-supplied version never becomes the store's

    const tabA = await http(`${h.url}/api/workspaces/p3`, 'PUT', { name: 'A' }, { [EXPECTED_VERSION_HEADER]: '1' });
    expect(tabA.status).toBe(200);
    expect(tabA.json.version).toBe(2);

    const tabB = await http(`${h.url}/api/workspaces/p3`, 'PUT', { name: 'B' }, { [EXPECTED_VERSION_HEADER]: '1' });
    expect(tabB.status).toBe(409);
    expect(tabB.json.code).toBe('VERSION_CONFLICT');

    const now = (await http(`${h.url}/api/workspaces`, 'GET')).json[0];
    expect(now.name).toBe('A');
    expect(now.version).toBe(2);

    // The current version is accepted; no version at all stays last-writer-wins.
    expect((await http(`${h.url}/api/workspaces/p3`, 'PUT', { name: 'C' }, { [EXPECTED_VERSION_HEADER]: '2' })).status).toBe(200);
    expect((await http(`${h.url}/api/workspaces/p3`, 'PUT', { name: 'D' })).json.version).toBe(4);
  });

  it('P3: a body version is still honoured as the expected version (older callers), and a bad header is 400', async () => {
    const h = await boot(kind);
    await http(`${h.url}/api/workspaces`, 'POST', base('p3b'));
    expect((await http(`${h.url}/api/workspaces/p3b`, 'PUT', { name: 'x', version: 9 })).status).toBe(409);
    expect(
      (await http(`${h.url}/api/workspaces/p3b`, 'PUT', { name: 'x' }, { [EXPECTED_VERSION_HEADER]: 'abc' })).status
    ).toBe(400);
    expect((await http(`${h.url}/api/workspaces`, 'GET')).json[0].name).toBe('HSU');
  });

  it('P3: a restore from backup moves the version on, so a tab holding an older one gets 409', async () => {
    const h = await boot(kind);
    await http(`${h.url}/api/workspaces`, 'POST', base('p3r'));
    await http(`${h.url}/api/workspaces/p3r`, 'PUT', { name: 'A' }, { [EXPECTED_VERSION_HEADER]: '1' }); // v2
    const file = path.basename(await h.repo.backup('manual'));
    const afterB = await http(`${h.url}/api/workspaces/p3r`, 'PUT', { name: 'B' }, { [EXPECTED_VERSION_HEADER]: '2' });
    expect(afterB.json.version).toBe(3); // a second tab is open holding v3

    const restored = await http(`${h.url}/api/workspaces/restore`, 'POST', { file });
    expect(restored.status).toBe(200);
    const now = (await http(`${h.url}/api/workspaces`, 'GET')).json[0];
    expect(now.name).toBe('A');
    expect(now.version).toBeGreaterThan(3); // not the backup's own 2, and not back to 3

    // Every version a tab could be holding from before the restore is refused, nothing is written.
    for (const held of ['2', '3']) {
      const r = await http(`${h.url}/api/workspaces/p3r`, 'PUT', { name: 'stale' }, { [EXPECTED_VERSION_HEADER]: held });
      expect(r.status, `held v${held}`).toBe(409);
      expect(r.json.code).toBe('VERSION_CONFLICT');
    }
    expect((await http(`${h.url}/api/workspaces`, 'GET')).json[0].name).toBe('A');
    // A tab that reloaded holds the new version and saves normally.
    const ok = await http(`${h.url}/api/workspaces/p3r`, 'PUT', { name: 'C' }, { [EXPECTED_VERSION_HEADER]: String(now.version) });
    expect(ok.status).toBe(200);
  });
});

describe('P1 allowlist covers what the app saves', () => {
  it('the committed chart fixture (a real saved workspace) passes through unchanged except id and createdAt', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(import.meta.dirname, 'fixtures', 'chart-workspace.json'), 'utf8')
    ) as Record<string, unknown>;
    const parsed = updateWorkspaceSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const expectedKeys = Object.keys(fixture).filter(k => k !== 'id' && k !== 'createdAt' && k !== 'version');
    expect(Object.keys(parsed.data).sort()).toEqual(expectedKeys.sort());
  });

  it('the allowlist never contains id, createdAt or version', () => {
    for (const k of ['id', 'createdAt', 'version']) expect(workspacePatchShape).not.toHaveProperty(k);
  });
});
