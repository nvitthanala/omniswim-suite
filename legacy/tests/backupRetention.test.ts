/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Backup retention must bound the automatic backups and must never touch
 * anything a human put in the backup directory.
 *
 * ## Why this is worth a test of its own
 *
 * Automatic backups only became safe to add once retention existed: the SQLite
 * and Postgres repos wrote through `writeJsonBackup`, which pruned nothing, and
 * SQLite is the production default. Backing up on every server start without a
 * cap would grow `data/backups/` without bound -- a full export is roughly the
 * size of `data/meets.json`, which is 3MB today.
 *
 * The dangerous half is the deletion, not the write. `data/backups/` already
 * holds hand-made copies from manual maintenance:
 *
 *   meets.json.pre-swimcloud-verify.20260908-131351.bak
 *   omniswim.db.pre-swimcloud-verify.20260908-131351.bak
 *   omniswim.db-wal.pre-swimcloud-verify.20260908-131351.bak
 *
 * Those are somebody's deliberate safety copies taken before a risky change. A
 * prune matching on `.json`, or on a loose prefix, would eventually delete them
 * to make room for an automatic snapshot -- destroying the exact thing the
 * feature exists to protect. Retention may only ever remove files the backup
 * writer itself produced, and that is what these cases pin down.
 */

import { describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __backupRetentionInternals } from '../apps/shell/lib/workspaceRepo';

const { GENERATED_BACKUP_PATTERN, pruneGeneratedBackups } = __backupRetentionInternals;

/** A filename in exactly the shape `writeJsonBackup` produces. */
function generatedName(label: string, iso: string): string {
  return `meets-${label}-${iso.replace(/[:.]/g, '-')}.json`;
}

async function tempBackupDir(files: string[]): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-backup-retention-'));
  for (const f of files) await fsp.writeFile(path.join(dir, f), '[]', 'utf-8');
  return dir;
}

describe('GENERATED_BACKUP_PATTERN', () => {
  it('matches what the backup writer produces', () => {
    expect(GENERATED_BACKUP_PATTERN.test(generatedName('startup', '2026-09-20T19:09:06.076Z'))).toBe(true);
    expect(GENERATED_BACKUP_PATTERN.test(generatedName('pre-delete', '2026-09-20T19:09:06.076Z'))).toBe(true);
    expect(GENERATED_BACKUP_PATTERN.test(generatedName('manual', '2026-01-01T00:00:00.000Z'))).toBe(true);
  });

  it('does not match the hand-made .bak copies that already exist on disk', () => {
    // Verbatim from data/backups/ as of 2026-09-20.
    for (const real of [
      'meets.json.pre-swimcloud-verify.20260908-131351.bak',
      'omniswim.db.pre-swimcloud-verify.20260908-131351.bak',
      'omniswim.db-shm.pre-swimcloud-verify.20260908-131351.bak',
      'omniswim.db-wal.pre-swimcloud-verify.20260908-131351.bak',
    ]) {
      expect(GENERATED_BACKUP_PATTERN.test(real), `${real} must be untouchable`).toBe(false);
    }
  });

  it('does not match a plain .json file a person dropped in the directory', () => {
    for (const notOurs of [
      'meets.json',
      'index.json',
      'my-notes.json',
      'meets-backup.json', // prefix-like, but carries no timestamp
      'workspaces-startup-2026-09-20T19-09-06-076Z.json', // right shape, wrong prefix
    ]) {
      expect(GENERATED_BACKUP_PATTERN.test(notOurs), `${notOurs} must not be pruned`).toBe(false);
    }
  });
});

describe('pruneGeneratedBackups', () => {
  it('keeps the newest N and deletes only the oldest generated ones', async () => {
    const names = Array.from({ length: 8 }, (_, i) =>
      generatedName('startup', `2026-09-${String(10 + i).padStart(2, '0')}T12:00:00.000Z`)
    );
    const dir = await tempBackupDir(names);

    await pruneGeneratedBackups(dir, 3);

    const left = (await fsp.readdir(dir)).sort();
    expect(left).toStrictEqual(names.slice(-3).sort());
  });

  it('never deletes a hand-made copy, even when far over the limit', async () => {
    const handMade = [
      'meets.json.pre-swimcloud-verify.20260908-131351.bak',
      'omniswim.db.pre-swimcloud-verify.20260908-131351.bak',
    ];
    const generated = Array.from({ length: 6 }, (_, i) =>
      generatedName('startup', `2026-09-${String(10 + i).padStart(2, '0')}T12:00:00.000Z`)
    );
    const dir = await tempBackupDir([...handMade, ...generated]);

    await pruneGeneratedBackups(dir, 1);

    const left = await fsp.readdir(dir);
    // The load-bearing assertion: retention is over-eager by one generated file
    // here, and the hand-made copies still survive it untouched.
    for (const keep of handMade) expect(left).toContain(keep);
    expect(left.filter(f => GENERATED_BACKUP_PATTERN.test(f))).toHaveLength(1);
  });

  it('does nothing when the directory holds fewer than the limit', async () => {
    const names = [generatedName('manual', '2026-09-20T12:00:00.000Z')];
    const dir = await tempBackupDir(names);
    await pruneGeneratedBackups(dir, 20);
    expect(await fsp.readdir(dir)).toStrictEqual(names);
  });

  it('deletes nothing when one short of the limit', async () => {
    // Regression guard found by mutation testing. Removing the
    // `generated.length <= keep` early return did NOT fail any earlier case,
    // because the one above uses a single file: slice(0, 1 - 20) is
    // slice(0, -19), whose negative index clamps to 0 on a 1-element array and
    // yields nothing to delete. Two files against a limit of three is the shape
    // that actually exposes it -- slice(0, 2 - 3) is slice(0, -1), which
    // selects the OLDEST file and deletes a backup while under the limit.
    const names = [
      generatedName('startup', '2026-09-19T12:00:00.000Z'),
      generatedName('startup', '2026-09-20T12:00:00.000Z'),
    ];
    const dir = await tempBackupDir(names);

    await pruneGeneratedBackups(dir, 3);

    expect((await fsp.readdir(dir)).sort()).toStrictEqual([...names].sort());
  });

  it('does not throw when the backup directory does not exist', async () => {
    const missing = path.join(os.tmpdir(), 'omni-backup-retention-does-not-exist-12345');
    await expect(pruneGeneratedBackups(missing, 5)).resolves.toBeUndefined();
  });
});
