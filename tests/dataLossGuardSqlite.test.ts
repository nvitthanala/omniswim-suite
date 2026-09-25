/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A2 (production-readiness, 2026-09-24): prove the data-loss guard's
 * pre-shrink backup also fires for `SqliteRepo`, not just `JsonRepo`
 * (see `tests/dataLossGuardRoute.test.ts` for the JSON-backend proof).
 *
 * `SqliteRepo` wraps `WorkspaceService`, which uses `node:sqlite`
 * (`DatabaseSync`) — a built-in Node module, not a native addon that needs
 * compiling — so it runs fine under vitest on this machine (Node v24).
 * Same 550-row menResults drop as the JSON-backend test, against a real
 * temp SQLite database file.
 */
import { describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { SqliteRepo } from '../apps/shell/lib/workspaceRepo';
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-dataloss-sqlite-'));
  const dbPath = path.join(dir, 'omniswim.db');
  const backupDir = path.join(dir, 'backups');
  const repo = new SqliteRepo(dbPath, backupDir, () => [seedWorkspace]);
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

describe('applyWorkspaceUpdateWithGuard — route wiring against a real SqliteRepo', () => {
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

    // The backup really exists and really holds the pre-save data, even
    // though the live store is SQLite: `SqliteRepo.backup` still writes the
    // same JSON snapshot format as the other two backends (`writeJsonBackup`).
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
});
