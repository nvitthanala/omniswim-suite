/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Restoring a backup — and, mostly, refusing to.
 *
 * ## Why the refusals are the important half
 *
 * `POST /api/workspaces/restore` takes a filename from outside the process and
 * reads that file off disk. That is the shape of every path-traversal bug ever
 * written, and this server runs on a coach's laptop alongside their own
 * documents. `resolveBackupPath` is the single boundary where a hostile name
 * has to die, so most of what follows is attempts to get past it.
 *
 * The second concern is destructiveness. A restore replaces *every* workspace,
 * which is more damage than deleting one, and there is no undo below it. So
 * `restoreBackup` takes its own `pre-restore` backup before touching anything,
 * and validates the file's contents before replacing anything — a corrupt
 * backup must fail with the live data untouched, not halfway through.
 */

import { describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listGeneratedBackups,
  resolveBackupPath,
  readBackupWorkspaces,
} from '../apps/shell/lib/workspaceRepo';

const VALID = 'meets-manual-2026-09-20T12-00-00-000Z.json';

async function tempDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-restore-'));
  for (const [name, body] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), body, 'utf-8');
  }
  return dir;
}

describe('resolveBackupPath — the traversal boundary', () => {
  it('accepts a name this app actually wrote', async () => {
    const dir = await tempDir();
    const resolved = resolveBackupPath(dir, VALID);
    expect(resolved).toBe(path.resolve(dir, VALID));
  });

  it('refuses every traversal shape', async () => {
    const dir = await tempDir();
    for (const hostile of [
      '../meets.json',
      '../../etc/passwd',
      '..\\..\\Windows\\System32\\config\\SAM',
      'subdir/meets-manual-2026-09-20T12-00-00-000Z.json',
      'subdir\\meets-manual-2026-09-20T12-00-00-000Z.json',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      './meets-manual-2026-09-20T12-00-00-000Z.json',
      '..%2Fmeets.json',
    ]) {
      expect(resolveBackupPath(dir, hostile), `${hostile} must be refused`).toBeNull();
    }
  });

  it('refuses a traversal that is disguised INSIDE a well-formed backup name', async () => {
    // Found by mutation testing: removing the path.basename check left all the
    // other cases green. The filename pattern is `meets-<label>-<stamp>.json`
    // and `.+` matches a slash, so a label can smuggle a path through it. This
    // is the case that proves the basename layer earns its place rather than
    // being belt-and-braces over the pattern.
    const dir = await tempDir();
    for (const smuggled of [
      'meets-../../../etc/passwd-2026-09-20T12-00-00-000Z.json',
      'meets-..%2F..%2Fx/y-2026-09-20T12-00-00-000Z.json',
      'meets-a/b-2026-09-20T12-00-00-000Z.json',
      'meets-a\\b-2026-09-20T12-00-00-000Z.json',
    ]) {
      expect(resolveBackupPath(dir, smuggled), `${smuggled} must be refused`).toBeNull();
    }
  });

  it('refuses a real file in the directory that this app did not write', async () => {
    // The hand-made .bak copies, and anything else a person dropped in.
    const dir = await tempDir();
    for (const notOurs of [
      'meets.json',
      'meets.json.pre-swimcloud-verify.20260908-131351.bak',
      'omniswim.db.pre-swimcloud-verify.20260908-131351.bak',
      'notes.json',
    ]) {
      expect(resolveBackupPath(dir, notOurs), `${notOurs} must be refused`).toBeNull();
    }
  });

  it('refuses an empty or non-string name', async () => {
    const dir = await tempDir();
    expect(resolveBackupPath(dir, '')).toBeNull();
    expect(resolveBackupPath(dir, undefined as unknown as string)).toBeNull();
    expect(resolveBackupPath(dir, null as unknown as string)).toBeNull();
  });
});

describe('listGeneratedBackups', () => {
  it('lists only generated backups, newest first, and never the hand-made copies', async () => {
    const dir = await tempDir({
      'meets-startup-2026-09-19T12-00-00-000Z.json': '[]',
      'meets-manual-2026-09-20T12-00-00-000Z.json': '[]',
      'meets-pre-delete-2026-09-18T12-00-00-000Z.json': '[]',
      'meets.json.pre-swimcloud-verify.20260908-131351.bak': 'x',
      'random.json': 'x',
    });

    const listed = await listGeneratedBackups(dir);

    expect(listed.map((b) => b.file)).toStrictEqual([
      'meets-manual-2026-09-20T12-00-00-000Z.json',
      'meets-startup-2026-09-19T12-00-00-000Z.json',
      'meets-pre-delete-2026-09-18T12-00-00-000Z.json',
    ]);
    expect(listed[0].label).toBe('manual');
    expect(listed[0].writtenAt).toBe('2026-09-20T12:00:00.000Z');
    expect(listed[2].label).toBe('pre-delete');
  });

  it('returns nothing rather than throwing when the directory does not exist', async () => {
    await expect(listGeneratedBackups(path.join(os.tmpdir(), 'omni-nope-98765'))).resolves.toStrictEqual([]);
  });
});

describe('readBackupWorkspaces — validate before replacing', () => {
  it('reads a real backup', async () => {
    const dir = await tempDir({ [VALID]: JSON.stringify([{ id: 'a', name: 'A' }]) });
    const ws = await readBackupWorkspaces(path.join(dir, VALID));
    expect(ws).toHaveLength(1);
    expect(ws[0].id).toBe('a');
  });

  it('refuses a file that is valid JSON but not a workspace array', async () => {
    const dir = await tempDir({ [VALID]: JSON.stringify({ workspaces: [] }) });
    await expect(readBackupWorkspaces(path.join(dir, VALID))).rejects.toThrow(/not a workspace array/i);
  });

  it('refuses an array whose entries have no workspace id', async () => {
    // The load-bearing case: this is a plausible-looking file that would
    // otherwise replace every real workspace with junk.
    const dir = await tempDir({ [VALID]: JSON.stringify([{ name: 'no id here' }]) });
    await expect(readBackupWorkspaces(path.join(dir, VALID))).rejects.toThrow(/no workspace id/i);
  });

  it('refuses malformed JSON', async () => {
    const dir = await tempDir({ [VALID]: '{not json' });
    await expect(readBackupWorkspaces(path.join(dir, VALID))).rejects.toThrow();
  });
});
