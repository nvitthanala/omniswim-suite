/**
 * Storage adapter abstraction for workspaces.
 *
 * Three interchangeable backends:
 *   - JsonRepo:    single-writer JSON queue (OMNI_DB=json)
 *   - SqliteRepo:  node:sqlite via WorkspaceService (default, OMNI_DB=sqlite)
 *   - PgRepo:      PostgreSQL via PgWorkspaceService (OMNI_DB=postgres)
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../../../packages/core/src/types.ts';
import { JsonStore } from './jsonStore.ts';
import { WorkspaceService } from '../../../packages/db/src/WorkspaceService.ts';
import { PgWorkspaceService } from '../../../packages/db/src/PgWorkspaceService.ts';
import type { WorkspaceScope } from '../../../packages/db/src/workspacePersistence.ts';

export type SnapshotMeta = { id: string; createdAt: number; label: string };

export type RepoKind = 'json' | 'sqlite' | 'postgres';

export interface WorkspaceRepo {
  readonly kind: RepoKind;
  init(): Promise<void>;
  list(): Promise<Workspace[]>;
  create(ws: Workspace): Promise<Workspace>;
  update(id: string, patch: Partial<Workspace>, expectedVersion?: number): Promise<Workspace | undefined>;
  remove(id: string): Promise<void>;
  backup(label?: string): Promise<string>;
  listBackups(): Promise<BackupFileMeta[]>;
  /** Replace every workspace with the contents of a generated backup. Returns how many were restored. */
  restoreBackup(file: string): Promise<number>;
  snapshot(id: string, label: string): Promise<SnapshotMeta | undefined>;
  listSnapshots(id: string): Promise<SnapshotMeta[]>;
  /** Read-only snapshot content (no restore). Undefined on JSON backend / unknown id. */
  getSnapshotContent(snapshotId: string): Promise<Workspace | undefined>;
  restoreSnapshot(snapshotId: string): Promise<Workspace | undefined>;
  setScope?(scope: WorkspaceScope): void;
}

/**
 * How many generated backups to keep. Matches `JsonStore`'s own limit so the
 * two storage backends do not age their history differently.
 *
 * Override with `OMNI_BACKUP_KEEP`. A value below 1 is ignored rather than
 * honoured: "keep zero backups" is far more likely to be a typo than an
 * intention, and acting on it would delete the file that was just written.
 */
export const DEFAULT_BACKUP_KEEP = 20;

function backupKeepCount(): number {
  const raw = Number(process.env.OMNI_BACKUP_KEEP);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_BACKUP_KEEP;
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
 */
const GENERATED_BACKUP_PATTERN = /^meets-.+-\d{4}-\d{2}-\d{2}T[\dZ-]+\.json$/;

/** Delete the oldest generated backups beyond `keep`. Never throws. */
async function pruneGeneratedBackups(backupDir: string, keep: number): Promise<void> {
  try {
    const generated = (await fsp.readdir(backupDir)).filter(f => GENERATED_BACKUP_PATTERN.test(f)).sort();
    if (generated.length <= keep) return;
    const stale = generated.slice(0, generated.length - keep);
    await Promise.all(stale.map(f => fsp.unlink(path.join(backupDir, f)).catch(() => undefined)));
  } catch {
    /* Retention is best-effort. Failing to prune must never fail the backup. */
  }
}

async function writeJsonBackup(
  backupDir: string,
  workspaces: Workspace[],
  label: string
): Promise<string> {
  await fsp.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `meets-${label}-${stamp}.json`);
  await fsp.writeFile(dest, JSON.stringify(workspaces, null, 2), 'utf-8');
  // After the write, never before: a prune that ran first could take the count
  // to the limit and then add one, leaving `keep + 1` on disk.
  await pruneGeneratedBackups(backupDir, backupKeepCount());
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
  const iso = m[2].replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  const d = new Date(iso);
  return { label: m[1], writtenAt: Number.isNaN(d.getTime()) ? null : d.toISOString() };
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

/** Exported for tests. Same rules as the private caller above. */
export const __backupRetentionInternals = { GENERATED_BACKUP_PATTERN, pruneGeneratedBackups, backupKeepCount };

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
  list() {
    return this.store.read();
  }
  async create(ws: Workspace) {
    await this.store.mutate(list => [...list, ws]);
    return ws;
  }
  async update(id: string, patch: Partial<Workspace>) {
    let updated: Workspace | undefined;
    await this.store.mutate(list =>
      list.map(w => {
        if (w.id !== id) return w;
        updated = { ...w, ...patch };
        return updated;
      })
    );
    return updated;
  }
  async remove(id: string) {
    await this.store.mutate(list => list.filter(w => w.id !== id));
  }
  backup(label = 'manual') {
    return this.store.backup(label);
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
    await this.store.mutate(() => workspaces);
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
  async list() {
    return this.service.listWorkspaces();
  }
  async create(ws: Workspace) {
    return this.service.createWorkspace(ws);
  }
  async update(id: string, patch: Partial<Workspace>, expectedVersion?: number) {
    return this.service.updateWorkspace(id, patch, expectedVersion);
  }
  async remove(id: string) {
    this.service.deleteWorkspace(id);
  }
  async backup(label = 'manual') {
    return writeJsonBackup(this.backupDir, this.service.exportAll(), label);
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
    this.service.replaceAll(workspaces);
    return workspaces.length;
  }
  async snapshot(id: string, label: string) {
    const res = this.service.createSnapshot(id, label);
    if (!res) return undefined;
    return { id: res.id, createdAt: Date.now(), label };
  }
  async listSnapshots(id: string) {
    return this.service.listSnapshots(id);
  }
  async getSnapshotContent(snapshotId: string) {
    return this.service.getSnapshotContent(snapshotId);
  }
  async restoreSnapshot(snapshotId: string) {
    return this.service.restoreSnapshot(snapshotId);
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
  async list() {
    return this.service.listWorkspaces();
  }
  async create(ws: Workspace) {
    return this.service.createWorkspace(ws);
  }
  async update(id: string, patch: Partial<Workspace>, expectedVersion?: number) {
    return this.service.updateWorkspace(id, patch, expectedVersion);
  }
  async remove(id: string) {
    await this.service.deleteWorkspace(id);
  }
  async backup(label = 'manual') {
    return writeJsonBackup(this.backupDir, await this.service.exportAll(), label);
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
    await this.service.replaceAll(workspaces);
    return workspaces.length;
  }
  async snapshot(id: string, label: string) {
    const res = await this.service.createSnapshot(id, label);
    if (!res) return undefined;
    return { id: res.id, createdAt: Date.now(), label };
  }
  async listSnapshots(id: string) {
    return this.service.listSnapshots(id);
  }
  async getSnapshotContent(snapshotId: string) {
    return this.service.getSnapshotContent(snapshotId);
  }
  async restoreSnapshot(snapshotId: string) {
    return this.service.restoreSnapshot(snapshotId);
  }
}
