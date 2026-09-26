/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Characterization test for `SqliteRepo.restoreBackup` (H2, code-health
 * refactor, 2026-09-25).
 *
 * `SqliteRepo.restoreBackup` and `PgRepo.restoreBackup` were an identical
 * 14-line clone, deduplicated into a shared `restoreBackupIntoService`
 * helper in `apps/shell/lib/workspaceRepo.ts`. Neither method had a direct
 * test before this refactor — `tests/backupRestore.test.ts` only exercises
 * the `resolveBackupPath`/`readBackupWorkspaces` building blocks, and
 * `tests/dataLossGuardSqlite.test.ts` never calls `restoreBackup` — so this
 * pins the end-to-end behavior the shared helper must preserve: restoring
 * replaces every workspace, takes its own `pre-restore` backup first, and
 * returns the restored workspace count.
 */
import { describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { SqliteRepo } from '../apps/shell/lib/workspaceRepo';
import type { Workspace } from '../packages/core/src/types';

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

async function makeRepo(seedWorkspace: Workspace) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-restore-sqlite-'));
  const dbPath = path.join(dir, 'omniswim.db');
  const backupDir = path.join(dir, 'backups');
  const repo = new SqliteRepo(dbPath, backupDir, () => [seedWorkspace]);
  await repo.init();
  return { repo, backupDir };
}

describe('SqliteRepo.restoreBackup', () => {
  it('replaces every workspace, takes a pre-restore backup, and returns the restored count', async () => {
    const seed = baseWorkspace({ name: 'Before restore' });
    const { repo } = await makeRepo(seed);

    // Snapshot the seeded state, then mutate it so restoring is observable.
    const manualBackupPath = await repo.backup('manual');
    const manualBackupFile = path.basename(manualBackupPath);

    await repo.update(seed.id, { name: 'Mutated after backup' });
    expect((await repo.list()).find(w => w.id === seed.id)?.name).toBe('Mutated after backup');

    const restoredCount = await repo.restoreBackup(manualBackupFile);

    expect(restoredCount).toBe(1);
    const afterRestore = await repo.list();
    expect(afterRestore).toHaveLength(1);
    expect(afterRestore[0]?.name).toBe('Before restore');

    // A pre-restore backup was taken before the destructive replace, so the
    // mutated state is still recoverable even though it was never asked for.
    const backups = await repo.listBackups();
    expect(backups.some(b => /^meets-pre-restore-.+\.json$/.test(b.file))).toBe(true);
  });

  it('refuses a file name that is not one this app wrote', async () => {
    const seed = baseWorkspace();
    const { repo } = await makeRepo(seed);

    await expect(repo.restoreBackup('../../etc/passwd')).rejects.toThrow(/Not a backup this app wrote/);
  });
});
