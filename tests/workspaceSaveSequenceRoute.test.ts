/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Out-of-order saves on `PUT /api/workspaces/:id`, against the REAL route module
 * (`registerWorkspaceRoutes`) mounted on a real Express app, over real HTTP, on a
 * real JSON store and a real SQLite file in a temp directory.
 *
 * The known gap this closes: save A, then save B. B lands first, A second. The
 * server used to keep A (stale) and say nothing. Now A is refused with a 409
 * and B stays.
 *
 * PostgreSQL is not exercised here (it needs a server). The sequencing lives in
 * the route layer above `WorkspaceRepo`, so `PgRepo` goes through the same code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import { JsonRepo, SqliteRepo, type WorkspaceRepo } from '../apps/shell/lib/workspaceRepo';
import { SaveSequencer } from '../apps/shell/lib/saveSequencer';
import {
  SAVE_CLIENT_HEADER,
  SAVE_SEQ_HEADER,
  SAVE_UNCHECKED_HEADER,
  STALE_SAVE_CODE,
} from '../packages/core/src/api/saveSequence';
import type { Workspace, ScoringSettings } from '../packages/core/src/types';

const WS_ID = 'ws-seq-1';
const CLIENT = 'client-aaaaaaaa';
const OTHER_CLIENT = 'client-bbbbbbbb';

function seedWorkspace(): Workspace {
  return {
    id: WS_ID,
    name: 'HSU 2026-27',
    menResults: [],
    womenResults: [],
    recruits: [],
    deletedSwimmers: [],
    createdAt: 1,
    activeEntryIds: ['seed'],
  } as unknown as Workspace;
}

interface Harness {
  url: string;
  repo: WorkspaceRepo;
  sequencer: SaveSequencer;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
  vi.restoreAllMocks();
});

async function boot(kind: 'json' | 'sqlite'): Promise<Harness> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `omni-seq-${kind}-`));
  const backupDir = path.join(dir, 'backups');
  const repo: WorkspaceRepo =
    kind === 'json'
      ? new JsonRepo(path.join(dir, 'meets.json'), backupDir, () => [seedWorkspace()])
      : new SqliteRepo(path.join(dir, 'omniswim.db'), backupDir, () => [seedWorkspace()]);
  await repo.init();
  const sequencer = new SaveSequencer();
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  const pass: express.RequestHandler = (_req, _res, next) => next();
  registerWorkspaceRoutes(app, {
    repo,
    auth: null,
    shareLinks: null,
    AUTH_REQUIRED: false,
    requireAuth: pass,
    optionalAuth: pass,
    defaultScoringSettings: {} as ScoringSettings,
    saveSequencer: sequencer,
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
  return { url: `http://127.0.0.1:${addr.port}`, repo, sequencer };
}

async function put(
  h: Harness,
  patch: Record<string, unknown>,
  seq?: number | string,
  client: string = CLIENT
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (seq !== undefined) {
    headers[SAVE_CLIENT_HEADER] = client;
    headers[SAVE_SEQ_HEADER] = String(seq);
  }
  const res = await fetch(`${h.url}/api/workspaces/${WS_ID}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(patch),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

async function stored(h: Harness): Promise<Workspace> {
  const ws = (await h.repo.list()).find(w => w.id === WS_ID);
  if (!ws) throw new Error('workspace vanished');
  return ws;
}

describe.each(['json', 'sqlite'] as const)('PUT save sequencing on the %s backend', kind => {
  it('out of order: B (seq 2) lands first, A (seq 1) is refused with 409 and B is kept', async () => {
    const h = await boot(kind);
    const b = await put(h, { activeEntryIds: ['B'] }, 2);
    expect(b.res.status).toBe(200);

    const a = await put(h, { activeEntryIds: ['A'] }, 1);
    expect(a.res.status).toBe(409);
    expect(a.body.code).toBe(STALE_SAVE_CODE);
    expect(a.body.lastAppliedSeq).toBe(2);
    expect(a.body.receivedSeq).toBe(1);

    expect((await stored(h)).activeEntryIds).toEqual(['B']);
  });

  it('in order: A then B both apply and B is final', async () => {
    const h = await boot(kind);
    const a = await put(h, { activeEntryIds: ['A'] }, 1);
    const b = await put(h, { activeEntryIds: ['B'] }, 2);
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);
    expect(a.res.headers.get(SAVE_UNCHECKED_HEADER)).toBeNull();
    expect((await stored(h)).activeEntryIds).toEqual(['B']);
  });

  it('a repeated sequence number is refused (a duplicate cannot re-apply old data)', async () => {
    const h = await boot(kind);
    expect((await put(h, { activeEntryIds: ['A'] }, 5)).res.status).toBe(200);
    const again = await put(h, { activeEntryIds: ['A-again'] }, 5);
    expect(again.res.status).toBe(409);
    expect((await stored(h)).activeEntryIds).toEqual(['A']);
  });

  it('missing headers: the save still works, is flagged, and is logged once', async () => {
    const h = await boot(kind);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = await put(h, { activeEntryIds: ['legacy'] });
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get(SAVE_UNCHECKED_HEADER)).toBe('no-sequence');
    await put(h, { activeEntryIds: ['legacy-2'] });
    expect((await stored(h)).activeEntryIds).toEqual(['legacy-2']);
    const flagged = warn.mock.calls.filter(c => String(c[0]).includes('had no save sequence'));
    expect(flagged).toHaveLength(1);
  });

  it('an unchecked save neither fails nor moves the recorded sequence', async () => {
    const h = await boot(kind);
    await put(h, { activeEntryIds: ['B'] }, 2);
    expect((await put(h, { activeEntryIds: ['script'] })).res.status).toBe(200);
    expect(h.sequencer.peek(`|${WS_ID}`)?.seq).toBe(2);
    expect((await put(h, { activeEntryIds: ['C'] }, 3)).res.status).toBe(200);
  });

  it('a different client id is last-writer-wins, as before (two tabs)', async () => {
    const h = await boot(kind);
    await put(h, { activeEntryIds: ['tab1'] }, 9, CLIENT);
    const tab2 = await put(h, { activeEntryIds: ['tab2'] }, 1, OTHER_CLIENT);
    expect(tab2.res.status).toBe(200);
    expect((await stored(h)).activeEntryIds).toEqual(['tab2']);
  });

  it('malformed headers are a 400, not a silent downgrade, and write nothing', async () => {
    const h = await boot(kind);
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      const r = await put(h, { activeEntryIds: ['bad'] }, bad);
      expect(r.res.status, `seq=${JSON.stringify(bad)}`).toBe(400);
      expect(r.body.code).toBe('BAD_SAVE_SEQUENCE');
    }
    const short = await put(h, { activeEntryIds: ['bad'] }, 1, 'x');
    expect(short.res.status).toBe(400);
    // Seq without a client id.
    const res = await fetch(`${h.url}/api/workspaces/${WS_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', [SAVE_SEQ_HEADER]: '1' },
      body: JSON.stringify({ activeEntryIds: ['bad'] }),
    });
    expect(res.status).toBe(400);
    expect((await stored(h)).activeEntryIds).toEqual(['seed']);
  });

  it('a save for a workspace that does not exist is 404 and does not move the sequence', async () => {
    const h = await boot(kind);
    const res = await fetch(`${h.url}/api/workspaces/nope`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        [SAVE_CLIENT_HEADER]: CLIENT,
        [SAVE_SEQ_HEADER]: '7',
      },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
    expect(h.sequencer.peek('|nope')).toBeUndefined();
  });

  it('the sequence never reaches the stored workspace', async () => {
    const h = await boot(kind);
    await put(h, { activeEntryIds: ['A'] }, 1);
    const ws = (await stored(h)) as unknown as Record<string, unknown>;
    expect(JSON.stringify(ws)).not.toContain(CLIENT);
    expect(ws).not.toHaveProperty('saveSeq');
  });

  it('a refused stale save never reaches the data-loss guard, so it costs no backup slot', async () => {
    const h = await boot(kind);
    const big = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`,
      name: `S${i}`,
      event: '50 Free',
      time: '20.00',
    }));
    expect((await put(h, { menResults: big }, 2)).res.status).toBe(200);
    const backupsBefore = await h.repo.listBackups();
    // Stale AND a sharp shrink: refused before the guard looks at it.
    const stale = await put(h, { menResults: [] }, 1);
    expect(stale.res.status).toBe(409);
    expect(await h.repo.listBackups()).toEqual(backupsBefore);
    expect((await stored(h)).menResults).toHaveLength(30);
  });

  it('deleting a workspace forgets its sequence so a reused id starts clean', async () => {
    const h = await boot(kind);
    await put(h, { activeEntryIds: ['A'] }, 4);
    const del = await fetch(`${h.url}/api/workspaces/${WS_ID}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(h.sequencer.peek(`|${WS_ID}`)).toBeUndefined();
  });
});
