/**
 * Storage adapter abstraction for workspaces.
 *
 * Three interchangeable backends:
 *   - JsonRepo:    single-writer JSON queue (OMNI_DB=json)
 *   - SqliteRepo:  node:sqlite via WorkspaceService (default, OMNI_DB=sqlite)
 *   - PgRepo:      PostgreSQL via PgWorkspaceService (OMNI_DB=postgres)
 */
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Workspace } from '../../../../packages/core/src/types.ts';
import { JsonStore } from './jsonStore.ts';
import { WorkspaceService } from '../../../packages/db/src/WorkspaceService.ts';
import { PgWorkspaceService } from '../../../packages/db/src/PgWorkspaceService.ts';
import {
  duplicateWorkspaceError,
  stripProtectedPatchFields,
  versionConflictError,
  workspaceVersionOf,
  type WorkspaceScope,
} from '../../../packages/db/src/workspacePersistence.ts';

export type SnapshotMeta = { id: string; createdAt: number; label: string };

export type RepoKind = 'json' | 'sqlite' | 'postgres';

/**
 * Every method that reads or writes tenant data takes the caller's `scope` as its
 * LAST argument. Pass it on every call. Leaving it off falls back to whatever
 * `setScope` last stored on the repo, which is shared by every in-flight request;
 * that fallback exists only for scripts and older tests.
 *
 * JsonRepo has one tenant and ignores `scope`.
 */
export interface WorkspaceRepo {
  readonly kind: RepoKind;
  init(): Promise<void>;
  list(scope?: WorkspaceScope): Promise<Workspace[]>;
  /**
   * Rejects with `code: 'DUPLICATE_WORKSPACE_ID'` when the id is already taken, by any
   * tenant. The stored copy always starts at version 1.
   */
  create(ws: Workspace, scope?: WorkspaceScope): Promise<Workspace>;
  /**
   * `id`, `version` and `createdAt` in `patch` are ignored. When `expectedVersion` is
   * given and is not the stored version, rejects with `code: 'VERSION_CONFLICT'` and
   * writes nothing. Resolves undefined when the id is not in `scope`.
   */
  update(
    id: string,
    patch: Partial<Workspace>,
    expectedVersion?: number,
    scope?: WorkspaceScope
  ): Promise<Workspace | undefined>;
  remove(id: string, scope?: WorkspaceScope): Promise<void>;
  /** Writes the workspaces visible to `scope` (everything when it is empty). */
  backup(label?: string, scope?: WorkspaceScope): Promise<string>;
  listBackups(): Promise<BackupFileMeta[]>;
  /**
   * Replace EVERY workspace, for every tenant, with the contents of a generated
   * backup. Returns how many were restored. There is no scoped form: callers must
   * decide who may do this (the route requires an admin under AUTH_REQUIRED).
   */
  restoreBackup(file: string): Promise<number>;
  snapshot(id: string, label: string, scope?: WorkspaceScope): Promise<SnapshotMeta | undefined>;
  listSnapshots(id: string, scope?: WorkspaceScope): Promise<SnapshotMeta[]>;
  /** Read-only snapshot content (no restore). Undefined on JSON backend, unknown id, or out of scope. */
  getSnapshotContent(snapshotId: string, scope?: WorkspaceScope): Promise<Workspace | undefined>;
  restoreSnapshot(snapshotId: string, scope?: WorkspaceScope): Promise<Workspace | undefined>;
  /** Default scope for calls that pass none. The server does not use it. */
  setScope?(scope: WorkspaceScope): void;
}

/**
 * ## Backups: what is kept, where, and how to restore
 *
 * Every backup is a full export of the workspaces as one JSON array,
 * `data/backups/meets-<label>-<UTC stamp>.json`. The labels this app writes:
 *
 *   manual       the "Back up now" button (POST /api/workspaces/backup)
 *   pre-restore  taken automatically just before a restore replaces everything
 *   pre-delete   before every workspace delete
 *   pre-shrink   before a save that would remove most of a collection
 *   startup      once per server start
 *
 * ### Retention (P6)
 *
 * Three pools, each trimmed to its newest N independently:
 *
 *   manual        OMNI_BACKUP_KEEP_MANUAL       default 20
 *   pre-restore   OMNI_BACKUP_KEEP_PRE_RESTORE  default 10
 *   everything else (pre-delete, pre-shrink, startup)
 *                 OMNI_BACKUP_KEEP              default 20
 *
 * Before P6 all five labels shared one pool of 20, so a day of editing (a pre-shrink or
 * pre-delete on most saves) could push out the one backup somebody took by hand. Because the
 * pools are separate, no number of automatic backups can evict a manual or pre-restore one.
 * A value below 1 is ignored rather than honoured: "keep zero backups" is far more likely to be a
 * typo than an intention, and acting on it would delete the file that was just written.
 *
 * Retention only ever removes files this module wrote (see {@link GENERATED_BACKUP_PATTERN}).
 *
 * ### Off-machine copy (OMNI_BACKUP_DIR)
 *
 * When `OMNI_BACKUP_DIR` names a folder (for example one a sync client watches), each backup is
 * also copied there, and on the SQLite backend so is a standalone copy of the live database,
 * `omniswim-<label>-<stamp>.db`, made with `VACUUM INTO` (never by copying the file, which can
 * miss the newest commits held in `-wal`). The folder is pruned with the same pools. A failed copy
 * is logged with `console.error` and recorded in {@link getBackupMirrorStatus}; it never fails
 * the backup or the save that triggered it. Nothing else in the app writes outside `data/`.
 *
 * ### Restore
 *
 * From the app's own folder: `POST /api/workspaces/restore` with `{ "file": "<bare name>" }`
 * (`GET /api/workspaces/backups` lists the names). The server first writes a `pre-restore`
 * backup, then replaces EVERY workspace of EVERY user with the file's contents, and bumps each
 * workspace's version so a tab that still holds the old one gets a conflict, not an overwrite.
 *
 * From OMNI_BACKUP_DIR: copy the `meets-*.json` file into `data/backups/`, then restore it by
 * name as above. To go back to a whole database copy instead: stop the server, delete
 * `data/omniswim.db`, `data/omniswim.db-wal` and `data/omniswim.db-shm`, copy the chosen
 * `omniswim-*.db` file to `data/omniswim.db`, and start the server. The JSON restore is
 * preferred: it keeps a `pre-restore` safety copy and works while the server runs.
 */
export const DEFAULT_BACKUP_KEEP = 20;
export const DEFAULT_MANUAL_BACKUP_KEEP = 20;
export const DEFAULT_PRE_RESTORE_BACKUP_KEEP = 10;

export interface BackupQuotas {
  /** pre-delete, pre-shrink, startup and any other label. */
  readonly other: number;
  readonly manual: number;
  readonly preRestore: number;
}

function keepFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= 1 ? raw : fallback;
}

/** The size of the shared pool (`OMNI_BACKUP_KEEP`). Kept for callers that predate the quotas. */
function backupKeepCount(): number {
  return keepFromEnv('OMNI_BACKUP_KEEP', DEFAULT_BACKUP_KEEP);
}

function backupQuotas(): BackupQuotas {
  return {
    other: backupKeepCount(),
    manual: keepFromEnv('OMNI_BACKUP_KEEP_MANUAL', DEFAULT_MANUAL_BACKUP_KEEP),
    preRestore: keepFromEnv('OMNI_BACKUP_KEEP_PRE_RESTORE', DEFAULT_PRE_RESTORE_BACKUP_KEEP),
  };
}

/**
 * Filename this module generates, and the only shape {@link pruneGeneratedBackups}
 * will ever delete.
 *
 * Deliberately narrow. `data/backups/` also holds hand-made copies from manual
 * maintenance (`meets.json.pre-swimcloud-verify.20260908-131351.bak`,
 * `omniswim.db-wal.…bak`). A prune that matched on `.json` alone, or on a bare
 * prefix, would eventually delete a human's deliberate safety copy to make room
 * for an automatic one. Retention may only ever remove files this function
 * itself wrote.
 *
 * The label admits only letters, digits, `_` and `-` (every caller passes a
 * fixed word such as `manual` or `pre-restore`), and the stamp is exactly what
 * `toISOString()` yields after `:` and `.` become `-`. No separator of any
 * platform can match, so a backslash is refused on Linux as well as Windows,
 * where `path.basename` alone only treats it as a separator on Windows.
 */
const GENERATED_BACKUP_PATTERN = /^meets-[A-Za-z0-9][A-Za-z0-9_-]*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

/** The database copies written into OMNI_BACKUP_DIR. Same narrowness, different prefix and suffix. */
const EXTERNAL_DB_COPY_PATTERN = /^omniswim-[A-Za-z0-9][A-Za-z0-9_-]*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;

/** Split `<prefix>-<label>-<stamp>.<ext>` into its label and its stamp. Null when it is not ours. */
function splitBackupName(file: string): { label: string; stamp: string } | null {
  const m = /^(?:meets|omniswim)-(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(?:json|db)$/.exec(file);
  // Both groups are mandatory in the pattern, so a match always has both.
  const label = m?.[1];
  const stamp = m?.[2];
  return label !== undefined && stamp !== undefined ? { label, stamp } : null;
}

function quotaFor(label: string, quotas: BackupQuotas): { pool: string; keep: number } {
  if (label === 'manual') return { pool: 'manual', keep: quotas.manual };
  if (label === 'pre-restore') return { pool: 'pre-restore', keep: quotas.preRestore };
  return { pool: 'other', keep: quotas.other };
}

/**
 * Delete the oldest generated backups beyond each pool's quota. Never throws.
 *
 * `keep` is the size of the shared pool (a bare number, as every caller before P6 passed) or a
 * full {@link BackupQuotas}. Age is the stamp in the name, NOT the file name: names start with
 * the label, so a name sort would rank every `pre-delete` before every `startup` and evict the
 * wrong files.
 *
 * `pattern` selects what may be removed; it defaults to the JSON backups of `data/backups/`.
 */
async function pruneGeneratedBackups(
  backupDir: string,
  keep: number | BackupQuotas,
  pattern: RegExp = GENERATED_BACKUP_PATTERN
): Promise<void> {
  try {
    const quotas: BackupQuotas = typeof keep === 'number' ? { ...backupQuotas(), other: keep } : keep;
    const pools = new Map<string, { keep: number; files: Array<{ file: string; stamp: string }> }>();
    for (const file of await fsp.readdir(backupDir)) {
      if (!pattern.test(file)) continue;
      const parts = splitBackupName(file);
      if (!parts) continue;
      const q = quotaFor(parts.label, quotas);
      const pool = pools.get(q.pool) ?? { keep: q.keep, files: [] };
      pool.files.push({ file, stamp: parts.stamp });
      pools.set(q.pool, pool);
    }
    const stale: string[] = [];
    for (const pool of pools.values()) {
      if (pool.files.length <= pool.keep) continue;
      // Oldest first. The stamp sorts as time; the name breaks a tie so the order is stable.
      pool.files.sort((a, b) => a.stamp.localeCompare(b.stamp) || a.file.localeCompare(b.file));
      for (const f of pool.files.slice(0, pool.files.length - pool.keep)) stale.push(f.file);
    }
    await Promise.all(stale.map(f => fsp.unlink(path.join(backupDir, f)).catch(() => undefined)));
  } catch {
    /* Retention is best-effort. Failing to prune must never fail the backup. */
  }
}

/** What happened to the most recent OMNI_BACKUP_DIR copy. Null when it is not configured. */
export interface BackupMirrorStatus {
  readonly dir: string;
  readonly ok: boolean;
  /** Bare names written to `dir`. */
  readonly files: readonly string[];
  /** Why the copy failed; every failed step is listed. */
  readonly error?: string;
  readonly at: string;
}

let lastBackupMirror: BackupMirrorStatus | null = null;

/** The outcome of the latest backup's off-machine copy, or null if `OMNI_BACKUP_DIR` is unset. */
export function getBackupMirrorStatus(): BackupMirrorStatus | null {
  return lastBackupMirror;
}

function externalBackupDir(): string | null {
  const raw = process.env.OMNI_BACKUP_DIR?.trim();
  return raw ? path.resolve(raw) : null;
}

/** Write `produce(tempPath)` then rename it into place, so a half-written file never has a final name. */
async function placeAtomically(dir: string, finalName: string, produce: (tempPath: string) => Promise<void> | void) {
  const temp = path.join(dir, `.backup-${randomUUID()}.tmp`);
  try {
    await produce(temp);
    await fsp.rename(temp, path.join(dir, finalName));
  } finally {
    await fsp.unlink(temp).catch(() => undefined);
  }
}

/**
 * Copy the backup that was just written into OMNI_BACKUP_DIR. Never throws: a synced folder that
 * is offline must not turn a save, a delete or a restore into a failure. It is logged loudly
 * instead, with the folder and the reason, and the status stays readable for the backup route.
 */
async function mirrorBackup(
  dest: string,
  label: string,
  databaseCopy: ((destPath: string) => void) | undefined
): Promise<void> {
  const dir = externalBackupDir();
  if (dir === null) {
    lastBackupMirror = null;
    return;
  }
  const files: string[] = [];
  const errors: string[] = [];
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    errors.push(`cannot create ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (errors.length === 0) {
    const jsonName = path.basename(dest);
    try {
      await placeAtomically(dir, jsonName, temp => fsp.copyFile(dest, temp));
      files.push(jsonName);
    } catch (err) {
      errors.push(`JSON copy ${jsonName}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (databaseCopy) {
      const stamp = splitBackupName(jsonName)?.stamp ?? new Date().toISOString().replace(/[:.]/g, '-');
      const dbName = `omniswim-${label}-${stamp}.db`;
      try {
        await placeAtomically(dir, dbName, temp => databaseCopy(temp));
        files.push(dbName);
      } catch (err) {
        errors.push(`database copy ${dbName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Same pools as data/backups/, applied to the files this app put there and nothing else.
    const quotas = backupQuotas();
    await pruneGeneratedBackups(dir, quotas, GENERATED_BACKUP_PATTERN);
    await pruneGeneratedBackups(dir, quotas, EXTERNAL_DB_COPY_PATTERN);
  }
  const at = new Date().toISOString();
  if (errors.length > 0) {
    const error = errors.join('; ');
    lastBackupMirror = { dir, ok: false, files, error, at };
    console.error(
      `[backup] OMNI_BACKUP_DIR copy FAILED (${dir}). The local backup ${path.basename(dest)} was written; ` +
        `the off-machine copy was not. ${error}`
    );
  } else {
    lastBackupMirror = { dir, ok: true, files, at };
  }
}

async function writeJsonBackup(
  backupDir: string,
  workspaces: Workspace[],
  label: string,
  options: { databaseCopy?: (destPath: string) => void } = {}
): Promise<string> {
  await fsp.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `meets-${label}-${stamp}.json`);
  const temp = path.join(backupDir, `.backup-${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, JSON.stringify(workspaces, null, 2), 'utf-8');
    await fsp.rename(temp, dest);
  } finally {
    await fsp.unlink(temp).catch(() => undefined);
  }
  // After the write, never before: a prune that ran first could take the count
  // to the limit and then add one, leaving `keep + 1` on disk.
  await pruneGeneratedBackups(backupDir, backupQuotas());
  // The local backup is safe on disk. Whatever the off-machine copy does, it cannot undo that.
  await mirrorBackup(dest, label, options.databaseCopy);
  return dest;
}

/** One generated backup on disk, newest first when listed. */
export interface BackupFileMeta {
  /** Bare filename. The only thing a caller may pass back to restore. */
  readonly file: string;
  readonly bytes: number;
  /** ISO instant, parsed from the filename rather than from mtime, which a copy rewrites. */
  readonly writtenAt: string | null;
  /** The label the backup was written under: startup, pre-delete, manual, pre-restore. */
  readonly label: string | null;
}

function parseGeneratedBackupName(file: string): { label: string | null; writtenAt: string | null } {
  const m = /^meets-(.+)-(\d{4}-\d{2}-\d{2}T[\dZ-]+)\.json$/.exec(file);
  if (!m) return { label: null, writtenAt: null };
  // The stamp was written with ':' and '.' replaced by '-'; put them back so it parses.
  const label = m[1];
  const stampText = m[2];
  // Both groups are mandatory in the pattern, so a match always has both.
  if (label === undefined || stampText === undefined) return { label: null, writtenAt: null };
  const iso = stampText.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  const d = new Date(iso);
  return { label, writtenAt: Number.isNaN(d.getTime()) ? null : d.toISOString() };
}

/** Newest first. Only ever lists backups this app generated. */
export async function listGeneratedBackups(backupDir: string): Promise<BackupFileMeta[]> {
  let names: string[];
  try {
    names = await fsp.readdir(backupDir);
  } catch {
    return [];
  }
  const out: BackupFileMeta[] = [];
  for (const file of names) {
    if (!GENERATED_BACKUP_PATTERN.test(file)) continue;
    let bytes = 0;
    try {
      bytes = (await fsp.stat(path.join(backupDir, file))).size;
    } catch {
      continue;
    }
    out.push({ file, bytes, ...parseGeneratedBackupName(file) });
  }
  // Sorted on the parsed instant, NOT on the filename. The name starts with the
  // label ("meets-manual-…", "meets-startup-…"), so a lexicographic sort orders
  // by label and only then by time — which puts a January "manual" above a
  // December "startup". A backup list in the wrong order is how somebody
  // restores the wrong file.
  return out.sort((a, b) => {
    if (a.writtenAt !== null && b.writtenAt !== null) return b.writtenAt.localeCompare(a.writtenAt);
    if (a.writtenAt !== null) return -1;
    if (b.writtenAt !== null) return 1;
    return b.file.localeCompare(a.file);
  });
}

/**
 * Turn a caller-supplied name into a path inside `backupDir`, or refuse.
 *
 * A restore endpoint takes a filename from outside the process, so this is the
 * boundary where `../../../etc/passwd` has to die. Three independent gates, all
 * required: the name must match the pattern this app's own writer produces
 * (which admits no slashes, dots-dot, or drive letters), `path.basename` must
 * return it unchanged, and the resolved path must still sit inside the resolved
 * backup directory. Any one of them would stop traversal; all three are cheap.
 */
export function resolveBackupPath(backupDir: string, file: string): string | null {
  if (typeof file !== 'string' || file.length === 0) return null;
  if (!GENERATED_BACKUP_PATTERN.test(file)) return null;
  if (path.basename(file) !== file) return null;
  const root = path.resolve(backupDir);
  const resolved = path.resolve(root, file);
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(withSep)) return null;
  return resolved;
}

/** Read a backup and validate it really is a workspace array before anything is replaced. */
export async function readBackupWorkspaces(fullPath: string): Promise<Workspace[]> {
  const raw = await fsp.readFile(fullPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Backup file is not a workspace array.');
  }
  for (const ws of parsed) {
    if (typeof ws !== 'object' || ws === null || typeof (ws as Workspace).id !== 'string') {
      throw new Error('Backup file contains an entry with no workspace id.');
    }
  }
  return parsed as Workspace[];
}

/**
 * Shared by `SqliteRepo.restoreBackup` and `PgRepo.restoreBackup` — the two
 * were an identical 14-line clone (H2, code-health refactor, 2026-09-25).
 * `JsonRepo.restoreBackup` is left as its own method (it mutates through
 * `store.mutate`, not a `service.replaceAll`, so folding it in here would be
 * merging genuinely different code, not deduplicating identical code).
 *
 * Takes its own `pre-restore` backup first, always. A restore is the one
 * operation that destroys more than a delete does, and a coach who restores
 * the wrong file must still have a way back. The file is read and validated
 * BEFORE anything is replaced, so a corrupt backup fails with nothing
 * touched rather than halfway through.
 */
async function restoreBackupIntoService(
  backupDir: string,
  file: string,
  backupBeforeRestore: () => Promise<string>,
  replaceAll: (workspaces: Workspace[]) => void | Promise<void>
): Promise<number> {
  const full = resolveBackupPath(backupDir, file);
  if (full === null) throw new Error(`Not a backup this app wrote: ${file}`);
  const workspaces = await readBackupWorkspaces(full);
  await backupBeforeRestore();
  await replaceAll(workspaces);
  return workspaces.length;
}

/** Exported for tests. Same rules as the private caller above. */
export const __backupRetentionInternals = {
  GENERATED_BACKUP_PATTERN,
  pruneGeneratedBackups,
  backupKeepCount,
  backupQuotas,
  EXTERNAL_DB_COPY_PATTERN,
};

export class JsonRepo implements WorkspaceRepo {
  readonly kind = 'json' as const;
  private store: JsonStore<Workspace[]>;
  private backupDir: string;

  constructor(filePath: string, backupDir: string, seed: () => Workspace[]) {
    this.store = new JsonStore<Workspace[]>(filePath, seed, backupDir);
    this.backupDir = backupDir;
  }

  init() {
    return this.store.init();
  }
  /** A document with no `version` is revision 1; the file is not rewritten to say so. */
  async list() {
    return (await this.store.read()).map(w => ({ ...w, version: workspaceVersionOf(w) }) as Workspace);
  }
  async create(ws: Workspace) {
    const stored = { ...ws, version: 1 } as Workspace;
    // The existence check and the append share one write-lock turn, so two creates of
    // one id cannot both pass it.
    await this.store.mutate(list => {
      if (list.some(w => w.id === ws.id)) throw duplicateWorkspaceError(ws.id);
      return [...list, stored];
    });
    return stored;
  }
  async update(id: string, patch: Partial<Workspace>, expectedVersion?: number) {
    let updated: Workspace | undefined;
    const fields = stripProtectedPatchFields(patch);
    await this.store.mutate(list =>
      list.map(w => {
        if (w.id !== id) return w;
        const current = workspaceVersionOf(w);
        if (expectedVersion != null && current !== expectedVersion) throw versionConflictError();
        updated = { ...w, ...fields, version: current + 1 } as Workspace;
        return updated;
      })
    );
    return updated;
  }
  async remove(id: string) {
    await this.store.mutate(list => list.filter(w => w.id !== id));
  }
  async backup(label = 'manual') {
    // The shared writer, not `JsonStore.backup`: that one prunes every `.json` in the directory
    // from one pool of 20 and knows nothing about the protected quotas or OMNI_BACKUP_DIR.
    return writeJsonBackup(this.backupDir, await this.store.read(), label);
  }

  async listBackups() {
    return listGeneratedBackups(this.backupDir);
  }

  /**
   * Replace every workspace with a backup's contents.
   *
   * Takes its own `pre-restore` backup first, always. A restore is the one
   * operation that destroys more than a delete does, and a coach who restores
   * the wrong file must still have a way back. The file is read and validated
   * BEFORE anything is replaced, so a corrupt backup fails with nothing
   * touched rather than halfway through.
   */
  async restoreBackup(file: string) {
    const full = resolveBackupPath(this.backupDir, file);
    if (full === null) throw new Error(`Not a backup this app wrote: ${file}`);
    const workspaces = await readBackupWorkspaces(full);
    await this.backup('pre-restore');
    // A restore is a change to every workspace it touches: an id that exists moves
    // forward, so a tab holding the old revision is refused instead of overwriting
    // what was just restored.
    await this.store.mutate(current => {
      const before = new Map(current.map(w => [w.id, workspaceVersionOf(w)]));
      return workspaces.map(w => {
        const prev = before.get(w.id);
        const restored = workspaceVersionOf(w);
        return {
          ...w,
          version: prev === undefined ? restored : Math.max(prev, restored) + 1,
        } as Workspace;
      });
    });
    return workspaces.length;
  }
  async snapshot() {
    return undefined;
  }
  async listSnapshots() {
    return [];
  }
  async getSnapshotContent() {
    return undefined;
  }
  async restoreSnapshot() {
    return undefined;
  }
}

export class SqliteRepo implements WorkspaceRepo {
  readonly kind = 'sqlite' as const;
  private service: WorkspaceService;
  private backupDir: string;
  private seed: () => Workspace[];
  private jsonSourcePath?: string;

  constructor(
    dbPath: string,
    backupDir: string,
    seed: () => Workspace[],
    jsonSourcePath?: string
  ) {
    this.service = new WorkspaceService(dbPath);
    this.backupDir = backupDir;
    this.seed = seed;
    this.jsonSourcePath = jsonSourcePath;
  }

  setScope(scope: WorkspaceScope): void {
    this.service.setScope(scope);
  }

  async init() {
    if (this.service.count() === 0) {
      if (this.jsonSourcePath) {
        try {
          const raw = await fsp.readFile(this.jsonSourcePath, 'utf-8');
          const workspaces = JSON.parse(raw) as Workspace[];
          if (Array.isArray(workspaces) && workspaces.length > 0) {
            this.service.replaceAll(workspaces);
            return;
          }
        } catch {
          /* no json to migrate */
        }
      }
      for (const ws of this.seed()) this.service.createWorkspace(ws);
    }
  }
  async list(scope?: WorkspaceScope) {
    return this.service.listWorkspaces(scope);
  }
  async create(ws: Workspace, scope?: WorkspaceScope) {
    return this.service.createWorkspace(ws, undefined, scope);
  }
  async update(id: string, patch: Partial<Workspace>, expectedVersion?: number, scope?: WorkspaceScope) {
    return this.service.updateWorkspace(id, patch, expectedVersion, scope);
  }
  async remove(id: string, scope?: WorkspaceScope) {
    this.service.deleteWorkspace(id, scope);
  }
  async backup(label = 'manual', scope?: WorkspaceScope) {
    return writeJsonBackup(this.backupDir, this.service.exportAll(scope), label, {
      // Only when OMNI_BACKUP_DIR is set: a standalone copy of the live database (VACUUM INTO).
      databaseCopy: dest => this.service.copyDatabaseTo(dest),
    });
  }

  async listBackups() {
    return listGeneratedBackups(this.backupDir);
  }

  /**
   * Replace every workspace with a backup's contents.
   *
   * Takes its own `pre-restore` backup first, always. A restore is the one
   * operation that destroys more than a delete does, and a coach who restores
   * the wrong file must still have a way back. The file is read and validated
   * BEFORE anything is replaced, so a corrupt backup fails with nothing
   * touched rather than halfway through.
   */
  async restoreBackup(file: string) {
    return restoreBackupIntoService(
      this.backupDir,
      file,
      // The restore replaces every tenant, so the safety copy must hold every tenant.
      () => this.backup('pre-restore', {}),
      workspaces => this.service.replaceAll(workspaces)
    );
  }
  async snapshot(id: string, label: string, scope?: WorkspaceScope) {
    const res = this.service.createSnapshot(id, label, scope);
    if (!res) return undefined;
    return { id: res.id, createdAt: Date.now(), label };
  }
  async listSnapshots(id: string, scope?: WorkspaceScope) {
    return this.service.listSnapshots(id, scope);
  }
  async getSnapshotContent(snapshotId: string, scope?: WorkspaceScope) {
    return this.service.getSnapshotContent(snapshotId, scope);
  }
  async restoreSnapshot(snapshotId: string, scope?: WorkspaceScope) {
    return this.service.restoreSnapshot(snapshotId, scope);
  }
}

export class PgRepo implements WorkspaceRepo {
  readonly kind = 'postgres' as const;
  private service: PgWorkspaceService;
  private backupDir: string;

  constructor(connectionString: string, backupDir: string, scope?: WorkspaceScope) {
    this.service = new PgWorkspaceService({ connectionString, scope });
    this.backupDir = backupDir;
  }

  setScope(scope: WorkspaceScope): void {
    this.service.setScope(scope);
  }

  async init() {
    await this.service.init();
  }
  async list(scope?: WorkspaceScope) {
    return this.service.listWorkspaces(scope);
  }
  async create(ws: Workspace, scope?: WorkspaceScope) {
    return this.service.createWorkspace(ws, undefined, scope);
  }
  async update(id: string, patch: Partial<Workspace>, expectedVersion?: number, scope?: WorkspaceScope) {
    return this.service.updateWorkspace(id, patch, expectedVersion, scope);
  }
  async remove(id: string, scope?: WorkspaceScope) {
    await this.service.deleteWorkspace(id, scope);
  }
  async backup(label = 'manual', scope?: WorkspaceScope) {
    return writeJsonBackup(this.backupDir, await this.service.exportAll(scope), label);
  }

  async listBackups() {
    return listGeneratedBackups(this.backupDir);
  }

  /**
   * Replace every workspace with a backup's contents.
   *
   * Takes its own `pre-restore` backup first, always. A restore is the one
   * operation that destroys more than a delete does, and a coach who restores
   * the wrong file must still have a way back. The file is read and validated
   * BEFORE anything is replaced, so a corrupt backup fails with nothing
   * touched rather than halfway through.
   */
  async restoreBackup(file: string) {
    return restoreBackupIntoService(
      this.backupDir,
      file,
      // The restore replaces every tenant, so the safety copy must hold every tenant.
      () => this.backup('pre-restore', {}),
      workspaces => this.service.replaceAll(workspaces)
    );
  }
  async snapshot(id: string, label: string, scope?: WorkspaceScope) {
    const res = await this.service.createSnapshot(id, label, scope);
    if (!res) return undefined;
    return { id: res.id, createdAt: Date.now(), label };
  }
  async listSnapshots(id: string, scope?: WorkspaceScope) {
    return this.service.listSnapshots(id, scope);
  }
  async getSnapshotContent(snapshotId: string, scope?: WorkspaceScope) {
    return this.service.getSnapshotContent(snapshotId, scope);
  }
  async restoreSnapshot(snapshotId: string, scope?: WorkspaceScope) {
    return this.service.restoreSnapshot(snapshotId, scope);
  }
}
