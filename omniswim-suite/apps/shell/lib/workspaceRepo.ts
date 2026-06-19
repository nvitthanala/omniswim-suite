/**
 * Storage adapter abstraction for workspaces.
 *
 * Two interchangeable backends present the same async surface to the server:
 *   - JsonRepo:   the v1 single-writer JSON queue (default, zero setup)
 *   - SqliteRepo: node:sqlite via @omniswim/db WorkspaceService (OMNI_DB=sqlite)
 *
 * Both keep an on-demand JSON backup in data/backups/ for portability.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../../../packages/core/src/types.ts';
import { JsonStore } from './jsonStore.ts';
import { WorkspaceService } from '../../../packages/db/src/WorkspaceService.ts';

export type SnapshotMeta = { id: string; createdAt: number; label: string };

export interface WorkspaceRepo {
  readonly kind: 'json' | 'sqlite';
  init(): Promise<void>;
  list(): Promise<Workspace[]>;
  create(ws: Workspace): Promise<Workspace>;
  update(id: string, patch: Partial<Workspace>): Promise<Workspace | undefined>;
  remove(id: string): Promise<void>;
  backup(label?: string): Promise<string>;
  snapshot(id: string, label: string): Promise<SnapshotMeta | undefined>;
  listSnapshots(id: string): Promise<SnapshotMeta[]>;
  restoreSnapshot(snapshotId: string): Promise<Workspace | undefined>;
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
  return dest;
}

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
  // Snapshots are SQLite-only; JSON repo returns no-ops.
  async snapshot() {
    return undefined;
  }
  async listSnapshots() {
    return [];
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

  constructor(dbPath: string, backupDir: string, seed: () => Workspace[]) {
    this.service = new WorkspaceService(dbPath);
    this.backupDir = backupDir;
    this.seed = seed;
  }

  async init() {
    if (this.service.count() === 0) {
      for (const ws of this.seed()) this.service.createWorkspace(ws);
    }
  }
  async list() {
    return this.service.listWorkspaces();
  }
  async create(ws: Workspace) {
    return this.service.createWorkspace(ws);
  }
  async update(id: string, patch: Partial<Workspace>) {
    return this.service.updateWorkspace(id, patch);
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
  async restoreSnapshot(snapshotId: string) {
    return this.service.restoreSnapshot(snapshotId);
  }
}
