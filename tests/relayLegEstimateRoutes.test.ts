/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A theoretical meet's leg rows saved before `relayLegEstimate` come back normalised from every route that
 * returns a workspace (A7): the list, the read-only snapshot content, and a snapshot restore. The source
 * copies (`sourceMenResults`, `sourceWomenResults`) are normalised with the working rows.
 *
 * Backups: `POST /api/workspaces/restore` replaces the stored workspaces and returns a count, not rows.
 * The restored rows are read back through the list route, which normalises them. Nothing to do there.
 */
import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import type { ScoringSettings, SwimmerResult, Workspace } from '../packages/core/src/types';

const legacyLeg = (suffix: string): SwimmerResult =>
  ({
    id: `tmresrelay|ws-old|Men|Alpha|200%20Free%20Relay%20SCY|leg${suffix}`,
    rank: 1,
    name: `A${suffix}`,
    classYear: 'JR',
    team: 'Alpha University',
    time: '1:23.00',
    points: 0,
    event: '200 Free Relay SCY',
    isRelay: true,
    relayLegIndex: Number(suffix) - 1,
    relayLegSplit: '20.50',
  }) as SwimmerResult;

const stored = (withSource: boolean): Workspace =>
  ({
    id: 'ws-old',
    name: 'old',
    createdAt: 1,
    version: 1,
    menResults: [legacyLeg('2')],
    womenResults: [],
    ...(withSource ? { sourceMenResults: [legacyLeg('2')], sourceWomenResults: [legacyLeg('3')] } : {}),
  }) as unknown as Workspace;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function serve(ws: Workspace): Promise<string> {
  const repo = {
    kind: 'sqlite',
    list: async () => [ws],
    getSnapshotContent: async () => ws,
    restoreSnapshot: async () => ws,
  };
  const app = express();
  app.use(express.json());
  const pass: express.RequestHandler = (_q, _s, n) => n();
  registerWorkspaceRoutes(app, {
    repo: repo as never,
    auth: null,
    shareLinks: null,
    AUTH_REQUIRED: false,
    requireAuth: pass,
    optionalAuth: pass,
    defaultScoringSettings: {} as ScoringSettings,
  });
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  cleanups.push(() => new Promise<void>(r => server.close(() => r())));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

function expectNormalised(rows: SwimmerResult[] | undefined, time: number): void {
  expect(rows).toHaveLength(1);
  expect(rows![0]!.relayLegSplit).toBeUndefined();
  expect(rows![0]!.relayLegEstimate?.time).toBe(time);
}

describe('workspace routes normalise saved theoretical leg rows', () => {
  it('the list normalises the working rows and the source copies', async () => {
    const url = await serve(stored(true));
    const [ws] = (await (await fetch(`${url}/api/workspaces`)).json()) as Workspace[];
    expectNormalised(ws!.menResults, 20.5);
    expectNormalised(ws!.sourceMenResults, 20.5);
    expectNormalised(ws!.sourceWomenResults, 20.5);
  });

  it('a workspace with no source copies gets none added', async () => {
    const url = await serve(stored(false));
    const [ws] = (await (await fetch(`${url}/api/workspaces`)).json()) as Workspace[];
    expect(ws).not.toHaveProperty('sourceMenResults');
    expect(ws).not.toHaveProperty('sourceWomenResults');
  });

  it('a snapshot read and a snapshot restore return normalised rows', async () => {
    const url = await serve(stored(true));
    const read = (await (await fetch(`${url}/api/snapshots/s1`)).json()) as Workspace;
    expectNormalised(read.menResults, 20.5);
    expectNormalised(read.sourceMenResults, 20.5);
    const restored = (await (await fetch(`${url}/api/snapshots/s1/restore`, { method: 'POST' })).json()) as Workspace;
    expectNormalised(restored.menResults, 20.5);
    expectNormalised(restored.sourceWomenResults, 20.5);
  });
});
