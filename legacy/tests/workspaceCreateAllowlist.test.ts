/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * POST /api/workspaces takes the same allowlist and the same collection checks
 * as PUT (improvement plan P1 follow-up: `createWorkspaceSchema` was still
 * `.passthrough()`).
 *
 * Runs the REAL route module over real HTTP on both file-backed stores.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import { JsonRepo, SqliteRepo, type WorkspaceRepo } from '../apps/shell/lib/workspaceRepo';
import { createWorkspaceSchema, workspacePatchShape } from '../../packages/core/src/schemas/workspace';
import type { ScoringSettings } from '../../packages/core/src/types';

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function boot(kind: 'json' | 'sqlite') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `omni-create-${kind}-`));
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
    defaultScoringSettings: { scoringPoints: [9, 4, 3] } as unknown as ScoringSettings,
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
  return { url: `http://127.0.0.1:${addr.port}` };
}

async function http(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

/** One value of the right shape for every key the allowlist names. */
const FULL_PAYLOAD: Record<string, unknown> = {
  id: 'full-1',
  name: 'Every field',
  createdAt: 1234,
  // Rows carry `gender`, as real rows do: the SQLite store files a row under men or
  // women by it.
  menResults: [{ id: 'm1', name: 'M', gender: 'Men', event: '50 Y Free', time: '21.00', extra: { kept: true } }],
  womenResults: [{ id: 'w1', name: 'W', gender: 'Women', event: '50 Y Free', time: '23.00' }],
  sourceMenResults: [{ id: 'sm1', name: 'M', gender: 'Men', event: '50 Y Free', time: '21.00' }],
  sourceWomenResults: [{ id: 'sw1', name: 'W', gender: 'Women', event: '50 Y Free', time: '23.00' }],
  recruits: [{ id: 'r1', name: 'R' }],
  scoringSettings: { scoringPoints: [9, 4, 3, 2, 1], customKey: 'kept' },
  conference: 'NSISC',
  deletedSwimmers: [{ name: 'Gone', gender: 'Men' }],
  scorerRosterOverrides: [{ name: 'S', team: 'HSU', gender: 'Men', isScorer: true }],
  officialTeamScores: { HSU: 100 },
  relayLegOverrides: [{ key: 'k', legIndex: 0 }],
  loadedMeet: { pdfFilename: 'meet.pdf' },
  psychMenResults: [{ id: 'p1', name: 'P', gender: 'Men' }],
  psychWomenResults: [{ id: 'p2', name: 'Q', gender: 'Women' }],
  loadedPsych: { pdfFilename: 'psych.pdf' },
  meetEntryPlans: [{ id: 'e1' }],
  entryPlanMode: 'plan_sheet',
  scoringView: 'pdf_only',
  activeEntryIds: ['e1', 'e2'],
  athleteHistory: [{ name: 'H', event: '50 Y Free', time: '22.00' }],
  raceAnalyses: [{ id: 'ra1' }],
  historySources: [{ type: 'paste', label: 'x', importedAt: 1 }],
  relayLegCredits: [{ name: 'L' }],
  athleteAliases: [{ aliasName: 'A', canonicalName: 'B' }],
};

describe('createWorkspaceSchema', () => {
  it('names exactly the keys a workspace patch names, plus id and createdAt', () => {
    const create = Object.keys(createWorkspaceSchema.shape).sort();
    const expected = [...Object.keys(workspacePatchShape), 'id', 'createdAt'].sort();
    expect(create).toEqual(expected);
  });

  it('the full payload fixture covers every allowlisted key, so the round trip below is complete', () => {
    expect(Object.keys(FULL_PAYLOAD).sort()).toEqual(Object.keys(createWorkspaceSchema.shape).sort());
  });

  it('accepts an empty body, because the server fills every default', () => {
    expect(createWorkspaceSchema.safeParse({}).success).toBe(true);
  });

  it('strips an unknown key and the client version', () => {
    const parsed = createWorkspaceSchema.parse({ name: 'x', version: 9, isAdmin: true, ownerId: 'u' });
    expect(parsed).toEqual({ name: 'x' });
  });
});

describe.each(['json', 'sqlite'] as const)('POST /api/workspaces on the %s store', kind => {
  it('every allowlisted field a client sends on create is stored and read back intact', async () => {
    const h = await boot(kind);
    const created = await http(`${h.url}/api/workspaces`, 'POST', FULL_PAYLOAD);
    expect(created.status).toBe(200);
    const stored = (await http(`${h.url}/api/workspaces`, 'GET')).json.find((w: any) => w.id === 'full-1');
    for (const [key, value] of Object.entries(FULL_PAYLOAD)) {
      expect(stored[key], key).toEqual(value);
    }
  });

  it('a malformed create is 400 with a code, and nothing is stored', async () => {
    const h = await boot(kind);
    const bad: unknown[] = [
      { menResults: { not: 'an array' } },
      { menResults: [1, 2, 3] },
      { womenResults: 'nope' },
      { recruits: 'nope' },
      { activeEntryIds: [{ id: 'x' }] },
      { name: 42 },
      { id: 42 },
      { createdAt: 'yesterday' },
      { scoringView: 'sideways' },
      { entryPlanMode: 'both' },
      { loadedMeet: [] },
      { officialTeamScores: 'x' },
      { scoringSettings: { scoringPoints: [9, null, 3] } },
    ];
    for (const body of bad) {
      const r = await http(`${h.url}/api/workspaces`, 'POST', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.code, JSON.stringify(body)).toBe('INVALID_WORKSPACE_PAYLOAD');
    }
    expect((await http(`${h.url}/api/workspaces`, 'GET')).json).toEqual([]);
  });

  it('a body that is not an object is refused', async () => {
    const h = await boot(kind);
    for (const body of ['"text"', '[1,2]', '42']) {
      const res = await fetch(`${h.url}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status, body).toBe(400);
    }
  });

  it('an unknown key is dropped and the client version is not stored', async () => {
    const h = await boot(kind);
    const r = await http(`${h.url}/api/workspaces`, 'POST', {
      id: 'unk',
      name: 'Unknown keys',
      version: 99,
      isAdmin: true,
      ownerId: 'someone-else',
    });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(1);
    const stored = (await http(`${h.url}/api/workspaces`, 'GET')).json.find((w: any) => w.id === 'unk');
    expect(stored).not.toHaveProperty('isAdmin');
    expect(stored).not.toHaveProperty('ownerId');
    expect(stored.version).toBe(1);
  });

  it('defaults still fill in what the client left out', async () => {
    const h = await boot(kind);
    const r = await http(`${h.url}/api/workspaces`, 'POST', {});
    expect(r.status).toBe(200);
    expect(r.json.name).toBe('New Workspace');
    expect(r.json.menResults).toEqual([]);
    expect(r.json.womenResults).toEqual([]);
    expect(r.json.recruits).toEqual([]);
    expect(r.json.deletedSwimmers).toEqual([]);
    expect(r.json.scoringSettings).toEqual({ scoringPoints: [9, 4, 3] });
    expect(typeof r.json.id).toBe('string');
    expect(typeof r.json.createdAt).toBe('number');
  });

  it('restoring a workspace as it came back from GET (with its version) round-trips', async () => {
    const h = await boot(kind);
    await http(`${h.url}/api/workspaces`, 'POST', { ...FULL_PAYLOAD, id: 'orig' });
    await http(`${h.url}/api/workspaces/orig`, 'PUT', { name: 'Edited' });
    const fetched = (await http(`${h.url}/api/workspaces`, 'GET')).json.find((w: any) => w.id === 'orig');
    expect(fetched.version).toBe(2);
    // The client's restore is the undo of a delete: createWorkspace(workspace.name, workspace).
    // Row ids are unique per store, so the original goes first.
    expect((await http(`${h.url}/api/workspaces/orig`, 'DELETE')).status).toBe(200);
    const restored = await http(`${h.url}/api/workspaces`, 'POST', { ...fetched, id: 'restored' });
    expect(restored.status).toBe(200);
    expect(restored.json.version).toBe(1);
    for (const key of Object.keys(FULL_PAYLOAD)) {
      if (key === 'id' || key === 'name') continue;
      expect(restored.json[key], key).toEqual(fetched[key]);
    }
    expect(restored.json.name).toBe('Edited');
  });
});
