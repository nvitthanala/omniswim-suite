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

/** Exported for tests. Same rules as the private caller above. */
export const __backupRetentionInternals = { GENERATED_BACKUP_PATTERN, pruneGeneratedBackups, backupKeepCount };

export class JsonRepo implements WorkspaceRepo {
  readonly kind = 'json' as const;
  private store: JsonStore<Workspace[]>;

  constructor(filePath: string, backupDir: string, seed: () => Workspace[]) {
    this.store = new JsonStore<Workspace[]>(filePath, seed, backupDir);
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
