/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P6: backups that survive.
 *
 * 1. `manual` and `pre-restore` backups have their own quotas, so no number of
 *    automatic backups (`pre-delete`, `pre-shrink`, `startup`) can evict them.
 * 2. OMNI_BACKUP_DIR receives a copy of every backup, plus (SQLite) a standalone
 *    copy of the live database made with VACUUM INTO. A failed copy is loud and
 *    never fails the backup.
 * 3. A backup copied from OMNI_BACKUP_DIR restores.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { promises as fsp, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {
  JsonRepo,
  SqliteRepo,
  getBackupMirrorStatus,
  __backupRetentionInternals,
  type WorkspaceRepo,
} from '../apps/shell/lib/workspaceRepo';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import type { ScoringSettings, Workspace } from '../packages/core/src/types';

const { pruneGeneratedBackups, EXTERNAL_DB_COPY_PATTERN } = __backupRetentionInternals;

const ENV_KEYS = ['OMNI_BACKUP_DIR', 'OMNI_BACKUP_KEEP', 'OMNI_BACKUP_KEEP_MANUAL', 'OMNI_BACKUP_KEEP_PRE_RESTORE'];
let saved: Record<string, string | undefined>;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined));
  return dir;
}

function workspace(id: string, name = id): Workspace {
  return {
    id,
    name,
    menResults: [{ id: `${id}-r`, name: 'A', event: '50 Y Free', time: '21.00' }],
    womenResults: [],
    recruits: [],
    createdAt: 1000,
  } as unknown as Workspace;
}

/** A name in exactly the shape the backup writer produces. */
function backupName(label: string, iso: string, prefix = 'meets', ext = 'json'): string {
  return `${prefix}-${label}-${iso.replace(/[:.]/g, '-')}.${ext}`;
}

function isoDay(day: number, hour = 12): string {
  return `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

async function boot(kind: 'json' | 'sqlite', dir?: string) {
  const root = dir ?? (await tempDir(`omni-quota-${kind}-`));
  const backups = path.join(root, 'backups');
  const repo: WorkspaceRepo =
    kind === 'json'
      ? new JsonRepo(path.join(root, 'meets.json'), backups, () => [])
      : new SqliteRepo(path.join(root, 'omniswim.db'), backups, () => []);
  await repo.init();
  return { repo, root, backups };
}

const tick = () => new Promise(r => setTimeout(r, 3)); // two backups in one millisecond share a file name

async function labelsIn(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir))
    .map(f => /^(?:meets|omniswim)-(.+)-\d{4}-\d{2}-\d{2}T[\dZ-]+\.(?:json|db)$/.exec(f)?.[1])
    .filter((l): l is string => Boolean(l));
}
const count = (labels: string[], label: string) => labels.filter(l => l === label).length;

describe('pools: other kinds can never evict manual or pre-restore', () => {
  it('30 newer pre-delete backups leave every manual and pre-restore one in place', async () => {
    const dir = await tempDir('omni-quota-unit-');
    const names = [
      backupName('manual', isoDay(1)),
      backupName('manual', isoDay(2)),
      backupName('pre-restore', isoDay(3)),
      ...Array.from({ length: 30 }, (_, i) => backupName('pre-delete', isoDay(10 + (i % 18), i))),
    ];
    for (const f of names) await fsp.writeFile(path.join(dir, f), '[]');

    await pruneGeneratedBackups(dir, 20);

    const left = await fsp.readdir(dir);
    expect(left).toContain(backupName('manual', isoDay(1)));
    expect(left).toContain(backupName('manual', isoDay(2)));
    expect(left).toContain(backupName('pre-restore', isoDay(3)));
    expect(count(await labelsIn(dir), 'pre-delete')).toBe(20);
  });

  it.each(['json', 'sqlite'] as const)('end to end on the %s store: one manual backup survives 30 pre-delete ones', async kind => {
    const { repo, backups } = await boot(kind);
    await repo.create(workspace('w1'));
    const manual = path.basename(await repo.backup('manual'));
    for (let i = 0; i < 30; i += 1) {
      await tick();
      await repo.backup('pre-delete');
    }
    const names = await fsp.readdir(backups);
    expect(names).toContain(manual);
    const labels = await labelsIn(backups);
    expect(count(labels, 'pre-delete')).toBe(20);
    expect(count(labels, 'manual')).toBe(1);
  });

  it('each protected pool is still bounded, to its own quota', async () => {
    const dir = await tempDir('omni-quota-bounded-');
    for (let i = 0; i < 25; i += 1) await fsp.writeFile(path.join(dir, backupName('manual', isoDay(1 + i, 1))), '[]');
    for (let i = 0; i < 15; i += 1) await fsp.writeFile(path.join(dir, backupName('pre-restore', isoDay(1 + i, 2))), '[]');

    await pruneGeneratedBackups(dir, 20);

    const labels = await labelsIn(dir);
    expect(count(labels, 'manual')).toBe(20);
    expect(count(labels, 'pre-restore')).toBe(10);
    // The oldest were the ones to go.
    const left = await fsp.readdir(dir);
    expect(left).not.toContain(backupName('manual', isoDay(1, 1)));
    expect(left).toContain(backupName('manual', isoDay(25, 1)));
  });

  it('the quotas can be set with OMNI_BACKUP_KEEP_MANUAL and OMNI_BACKUP_KEEP_PRE_RESTORE', async () => {
    process.env.OMNI_BACKUP_KEEP_MANUAL = '3';
    process.env.OMNI_BACKUP_KEEP_PRE_RESTORE = '2';
    const dir = await tempDir('omni-quota-env-');
    for (let i = 0; i < 6; i += 1) await fsp.writeFile(path.join(dir, backupName('manual', isoDay(1 + i))), '[]');
    for (let i = 0; i < 6; i += 1) await fsp.writeFile(path.join(dir, backupName('pre-restore', isoDay(1 + i))), '[]');
    await pruneGeneratedBackups(dir, __backupRetentionInternals.backupQuotas());
    const labels = await labelsIn(dir);
    expect(count(labels, 'manual')).toBe(3);
    expect(count(labels, 'pre-restore')).toBe(2);
  });

  it('age is the stamp, not the file name: an older startup backup goes before a newer pre-delete one', async () => {
    // Sorted by name, "pre-delete" comes before "startup", so a name sort would evict the NEWER file.
    const dir = await tempDir('omni-quota-age-');
    const oldStartup = backupName('startup', isoDay(1));
    const newerDelete = backupName('pre-delete', isoDay(20));
    const newestStartup = backupName('startup', isoDay(25));
    for (const f of [oldStartup, newerDelete, newestStartup]) await fsp.writeFile(path.join(dir, f), '[]');

    await pruneGeneratedBackups(dir, 2);

    expect((await fsp.readdir(dir)).sort()).toEqual([newerDelete, newestStartup].sort());
  });
});

describe('OMNI_BACKUP_DIR', () => {
  it('receives the JSON backup and a standalone, openable copy of the live SQLite database', async () => {
    const external = await tempDir('omni-offsite-');
    process.env.OMNI_BACKUP_DIR = external;
    const { repo, root } = await boot('sqlite');
    await repo.create(workspace('w1', 'Henderson State'));
    await repo.create(workspace('w2', 'Second'));

    // The service connection stays open, as the running server's does.
    const local = path.basename(await repo.backup('manual'));

    const status = getBackupMirrorStatus();
    expect(status?.ok, JSON.stringify(status)).toBe(true);
    const copied = (await fsp.readdir(external)).sort();
    const dbName = copied.find(f => EXTERNAL_DB_COPY_PATTERN.test(f));
    expect(copied).toContain(local);
    expect(dbName, `a database copy in ${copied.join(', ')}`).toBeTruthy();
    // One standalone file: no -wal or -shm companions, and no temp files left behind.
    expect(copied.filter(f => /-wal$|-shm$|\.tmp$/.test(f))).toEqual([]);

    // The JSON copy is the same bytes as the local backup.
    expect(await fsp.readFile(path.join(external, local), 'utf8')).toBe(
      await fsp.readFile(path.join(root, 'backups', local), 'utf8')
    );

    // The database copy opens on its own and is intact and complete.
    const copy = new DatabaseSync(path.join(external, dbName!), { readOnly: true });
    try {
      expect((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
      const rows = copy.prepare('SELECT id, name FROM workspaces ORDER BY id').all() as Array<{ id: string; name: string }>;
      expect(rows.map(r => r.id)).toEqual(['w1', 'w2']);
      expect(rows[0].name).toBe('Henderson State');
      const stamp = copy.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      expect(Number(stamp.value)).toBeGreaterThanOrEqual(8);
    } finally {
      copy.close();
    }
  });

  it('the database copy holds the newest commits that a plain file copy of the live file misses', async () => {
    const external = await tempDir('omni-offsite-');
    process.env.OMNI_BACKUP_DIR = external;
    const { repo, root } = await boot('sqlite');
    await repo.create(workspace('w1'));
    await repo.create(workspace('w2'));
    await repo.backup('manual');

    const rowsIn = (file: string): number | 'unreadable' => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return (db.prepare('SELECT count(*) AS c FROM workspaces').get() as { c: number }).c;
      } catch {
        return 'unreadable';
      } finally {
        db.close();
      }
    };
    // Why VACUUM INTO: the newest commits live in the -wal file, which a plain copy of the main
    // file leaves behind. The copy opens, but at a state the database never had.
    const naive = path.join(external, 'naive-copy.db');
    await fsp.copyFile(path.join(root, 'omniswim.db'), naive);
    expect(rowsIn(naive)).not.toBe(2);

    const dbName = (await fsp.readdir(external)).find(f => EXTERNAL_DB_COPY_PATTERN.test(f))!;
    expect(rowsIn(path.join(external, dbName))).toBe(2);
  });

  it('a backup copied from OMNI_BACKUP_DIR back into data/backups restores', async () => {
    const external = await tempDir('omni-offsite-');
    process.env.OMNI_BACKUP_DIR = external;
    const first = await boot('sqlite');
    await first.repo.create(workspace('keep-me', 'Roster to keep'));
    const local = path.basename(await first.repo.backup('manual'));
    delete process.env.OMNI_BACKUP_DIR;

    // A different machine, or the same one after the data folder was lost.
    const second = await boot('sqlite');
    expect(await second.repo.list()).toEqual([]);
    await fsp.mkdir(second.backups, { recursive: true });
    await fsp.copyFile(path.join(external, local), path.join(second.backups, local));

    expect(await second.repo.restoreBackup(local)).toBe(1);
    const restored = await second.repo.list();
    expect(restored.map(w => [w.id, w.name])).toEqual([['keep-me', 'Roster to keep']]);
    // The restore also wrote its own safety copy first.
    expect(count(await labelsIn(second.backups), 'pre-restore')).toBe(1);
  });

  it('on the JSON store it receives the JSON backup and no database copy', async () => {
    const external = await tempDir('omni-offsite-');
    process.env.OMNI_BACKUP_DIR = external;
    const { repo } = await boot('json');
    await repo.create(workspace('w1'));
    const local = path.basename(await repo.backup('manual'));
    expect(await fsp.readdir(external)).toEqual([local]);
  });

  it('is trimmed with the same pools: 30 pre-delete copies, one manual copy still there', async () => {
    const external = await tempDir('omni-offsite-');
    process.env.OMNI_BACKUP_DIR = external;
    const { repo } = await boot('sqlite');
    await repo.create(workspace('w1'));
    await repo.backup('manual');
    for (let i = 0; i < 30; i += 1) {
      await tick();
      await repo.backup('pre-delete');
    }
    const names = await fsp.readdir(external);
    const json = names.filter(f => f.endsWith('.json'));
    const db = names.filter(f => f.endsWith('.db'));
    expect(json.filter(f => f.includes('-manual-'))).toHaveLength(1);
    expect(db.filter(f => f.includes('-manual-'))).toHaveLength(1);
    expect(json.filter(f => f.includes('-pre-delete-'))).toHaveLength(20);
    expect(db.filter(f => f.includes('-pre-delete-'))).toHaveLength(20);
  });

  it('a hand-made file in OMNI_BACKUP_DIR is never pruned', async () => {
    const external = await tempDir('omni-offsite-');
    process.env.OMNI_BACKUP_DIR = external;
    process.env.OMNI_BACKUP_KEEP = '1';
    await fsp.writeFile(path.join(external, 'my-roster-notes.json'), '[]');
    await fsp.writeFile(path.join(external, 'omniswim.db.old.bak'), 'x');
    const { repo } = await boot('sqlite');
    await repo.create(workspace('w1'));
    for (let i = 0; i < 4; i += 1) {
      await tick();
      await repo.backup('pre-delete');
    }
    const names = await fsp.readdir(external);
    expect(names).toContain('my-roster-notes.json');
    expect(names).toContain('omniswim.db.old.bak');
  });

  it('a failed copy is logged loudly and does not fail or block the backup', async () => {
    const root = await tempDir('omni-offsite-broken-');
    // A path whose parent is a FILE can never become a directory.
    const blocker = path.join(root, 'not-a-folder');
    await fsp.writeFile(blocker, 'x');
    process.env.OMNI_BACKUP_DIR = path.join(blocker, 'sub');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { repo, backups } = await boot('sqlite');
    await repo.create(workspace('w1'));
    const local = await repo.backup('manual'); // must resolve

    expect(existsSync(local)).toBe(true);
    expect(await fsp.readdir(backups)).toContain(path.basename(local));
    const status = getBackupMirrorStatus();
    expect(status?.ok).toBe(false);
    expect(status?.error).toMatch(/cannot create/);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toMatch(/OMNI_BACKUP_DIR copy FAILED/);
    expect(String(errors.mock.calls[0][0])).toContain(path.basename(local));
  });

  it('is off when unset: nothing is written outside data/backups and the status is null', async () => {
    const { repo } = await boot('sqlite');
    await repo.create(workspace('w1'));
    await repo.backup('manual');
    expect(getBackupMirrorStatus()).toBeNull();
  });
});

describe('the backup route and a bulk delete of 39 workspaces (U3)', () => {
  async function serve(repo: WorkspaceRepo) {
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
    cleanups.push(() => new Promise<void>(r => server.close(() => r())));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    return `http://127.0.0.1:${addr.port}`;
  }

  it.each(['json', 'sqlite'] as const)('%s store: the manual backup taken first survives 39 deletes', async kind => {
    const { repo, backups } = await boot(kind);
    const url = await serve(repo);
    for (let i = 0; i < 39; i += 1) await repo.create(workspace(`ui-${i}`));

    const made = await (await fetch(`${url}/api/workspaces/backup`, { method: 'POST' })).json();
    expect(made.success).toBe(true);
    expect(made).not.toHaveProperty('mirror'); // OMNI_BACKUP_DIR is not set

    for (let i = 0; i < 39; i += 1) {
      await tick();
      const res = await fetch(`${url}/api/workspaces/ui-${i}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
    }
    expect(await repo.list()).toEqual([]);

    const names = await fsp.readdir(backups);
    expect(names).toContain(made.file);
    const labels = await labelsIn(backups);
    expect(count(labels, 'manual')).toBe(1);
    expect(count(labels, 'pre-delete')).toBe(20); // 39 were written; the pool keeps the newest 20

    // And the surviving manual backup brings all 39 back.
    expect(await repo.restoreBackup(made.file)).toBe(39);
    expect(await repo.list()).toHaveLength(39);
  });

  it('the manual-backup route reports a failed off-machine copy instead of a clean success', async () => {
    const root = await tempDir('omni-offsite-route-');
    const blocker = path.join(root, 'file');
    await fsp.writeFile(blocker, 'x');
    process.env.OMNI_BACKUP_DIR = path.join(blocker, 'sub');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { repo } = await boot('json');
    const url = await serve(repo);
    const body = await (await fetch(`${url}/api/workspaces/backup`, { method: 'POST' })).json();
    expect(body.success).toBe(true);
    expect(body.mirror.ok).toBe(false);
    expect(body.mirror.error).toMatch(/cannot create/);
  });
});
