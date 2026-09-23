/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Route-wiring test for the `PUT /api/workspaces/:id` data-loss guard.
 *
 * `apps/shell/server.ts` defines every route inside one `startServer()`
 * function that also opens a real listening socket on import, so it is not
 * importable as an Express app the way `swimcloudCaptureRoutes.ts` is (see
 * `tests/swimcloudCaptureRoutes.test.ts`). Per the brief, this exercises the
 * extracted handler logic instead: `applyWorkspaceUpdateWithGuard`, run
 * against a real `JsonRepo` on a real temp directory, which is exactly what
 * the PUT handler calls. This is the same wiring the route uses, minus
 * Express and HTTP.
 */
import { describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { JsonRepo } from '../apps/shell/lib/workspaceRepo';
import { applyWorkspaceUpdateWithGuard } from '../apps/shell/lib/dataLossGuard';
import type { Workspace } from '../packages/core/src/types';

function makeResults(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `r${i}`,
    name: `Swimmer ${i}`,
    event: '50 Free',
    time: '20.00',
  })) as unknown as Workspace['menResults'];
}

async function makeRepo(seedWorkspace: Workspace) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-dataloss-route-'));
  const filePath = path.join(dir, 'meets.json');
  const backupDir = path.join(dir, 'backups');
  const repo = new JsonRepo(filePath, backupDir, () => [seedWorkspace]);
  await repo.init();
  return { repo, dir, backupDir };
}

function baseWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: uuidv4(),
    name: 'HSU 2026-27',
    menResults: [],
    womenResults: [],
    recruits: [],
    deletedSwimmers: [],
    createdAt: Date.now(),
    scoringSettings: {} as Workspace['scoringSettings'],
    ...overrides,
  };
}

describe('applyWorkspaceUpdateWithGuard — route wiring against a real JsonRepo', () => {
  it('takes a pre-shrink backup and reports the warning when menResults wipes out', async () => {
    const seed = baseWorkspace({ menResults: makeResults(550) });
    const { repo, backupDir } = await makeRepo(seed);

    const { updated, dataLossWarning } = await applyWorkspaceUpdateWithGuard(repo, seed.id, {
      menResults: [],
    });

    expect(updated?.menResults).toEqual([]);
    expect(dataLossWarning).toBeDefined();
    expect(dataLossWarning?.drops).toEqual([{ collection: 'menResults', from: 550, to: 0 }]);
    expect(dataLossWarning?.backupError).toBeUndefined();
    expect(dataLossWarning?.backupFile).toMatch(/^meets-pre-shrink-.+\.json$/);

    // The backup really exists and really holds the pre-save data.
    const backupPath = path.join(backupDir, dataLossWarning!.backupFile!);
    const backedUp = JSON.parse(await fsp.readFile(backupPath, 'utf-8')) as Workspace[];
    expect(backedUp.find(w => w.id === seed.id)?.menResults).toHaveLength(550);

    // The save itself still went through — this guard never blocks.
    const stored = (await repo.list()).find(w => w.id === seed.id);
    expect(stored?.menResults).toEqual([]);
  });

  it('saves normally with no warning when nothing sharply drops', async () => {
    const seed = baseWorkspace({ menResults: makeResults(30) });
    const { repo } = await makeRepo(seed);

    const { updated, dataLossWarning } = await applyWorkspaceUpdateWithGuard(repo, seed.id, {
      menResults: makeResults(20),
    });

    expect(updated?.menResults).toHaveLength(20);
    expect(dataLossWarning).toBeUndefined();
  });

  it('does not evaluate a collection the patch never mentions', async () => {
    const seed = baseWorkspace({ menResults: makeResults(550), womenResults: makeResults(400) });
    const { repo } = await makeRepo(seed);

    // Only scoringSettings changes; menResults/womenResults are untouched.
    const { dataLossWarning } = await applyWorkspaceUpdateWithGuard(repo, seed.id, {
      scoringSettings: { conference: 'NSISC' } as Workspace['scoringSettings'],
    });

    expect(dataLossWarning).toBeUndefined();
  });

  it('still saves, and reports backupError, when the backup itself fails', async () => {
    const seed = baseWorkspace({ menResults: makeResults(550) });
    const { repo } = await makeRepo(seed);

    const failingRepo = {
      list: () => repo.list(),
      update: (id: string, patch: Partial<Workspace>, v?: number) => repo.update(id, patch, v),
      backup: async () => {
        throw new Error('disk full');
      },
    };

    const { updated, dataLossWarning } = await applyWorkspaceUpdateWithGuard(failingRepo, seed.id, {
      menResults: [],
    });

    expect(updated?.menResults).toEqual([]); // save still happened
    expect(dataLossWarning?.backupFile).toBeNull();
    expect(dataLossWarning?.backupError).toBe('disk full');
    expect(dataLossWarning?.drops).toEqual([{ collection: 'menResults', from: 550, to: 0 }]);
  });
});
