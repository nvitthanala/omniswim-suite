/**
 * WorkspaceService — SQLite-backed persistence for full `Workspace` aggregates.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace, SwimmerResult } from '@omniswim/core/types';
import { SCHEMA_VERSION, CREATE_TABLES_SQL, SQLITE_MIGRATIONS_V2 } from './schema';
import {
  assembleWorkspace,
  insertPositionalRows,
  insertResultsRows,
  insertWithIdRows,
  workspaceRowValues,
  type WorkspaceScope,
} from './workspacePersistence';

export class WorkspaceService {
  private db: DatabaseSync;
  private scope: WorkspaceScope = {};

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(CREATE_TABLES_SQL);
    for (const sql of SQLITE_MIGRATIONS_V2) {
      try {
        this.db.exec(sql);
      } catch {
        /* column already exists */
      }
    }
    this.db
      .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  setScope(scope: WorkspaceScope): void {
    this.scope = scope;
  }

  close(): void {
    this.db.close();
  }

  count(): number {
    const { where, params } = this.buildScopeWhere();
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM workspaces ${where}`).get(
      ...(params as (string | number | null)[])
    ) as {
      n: number;
    };
    return row?.n ?? 0;
  }

  listWorkspaces(): Workspace[] {
    const { where, params } = this.buildScopeWhere();
    const rows = this.db
      .prepare(`SELECT id FROM workspaces ${where} ORDER BY sort_index ASC, created_at ASC`)
      .all(...(params as (string | number | null)[])) as { id: string }[];
    return rows.map(r => this.getWorkspace(r.id)).filter((w): w is Workspace => w != null);
  }

  getWorkspace(id: string): Workspace | undefined {
    const clauses = ['id = ?'];
    const params: unknown[] = [id];
    if (this.scope.teamId) {
      clauses.push('team_id = ?');
      params.push(this.scope.teamId);
    } else if (this.scope.ownerId) {
      clauses.push('owner_id = ?');
      params.push(this.scope.ownerId);
    }
    const row = this.db
      .prepare(`SELECT * FROM workspaces WHERE ${clauses.join(' AND ')}`)
      .get(...(params as (string | number | null)[])) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const childData = (table: string) => {
      const rows = this.db
        .prepare(`SELECT data FROM ${table} WHERE workspace_id = ? ORDER BY position ASC`)
        .all(id) as { data: string }[];
      return rows
        .map(r => {
          try {
            return JSON.parse(r.data);
          } catch {
            return null;
          }
        })
        .filter(d => d != null);
    };

    return assembleWorkspace(row, childData);
  }

  getWorkspaceMeta(id: string): { version: number; updatedAt: number } | undefined {
    const row = this.db
      .prepare('SELECT version, updated_at FROM workspaces WHERE id = ?')
      .get(id) as { version: number; updated_at: number } | undefined;
    if (!row) return undefined;
    return { version: Number(row.version ?? 1), updatedAt: Number(row.updated_at ?? 0) };
  }

  createWorkspace(ws: Workspace, sortIndex?: number): Workspace {
    this.writeWorkspace(ws, sortIndex ?? this.count(), { version: 1 });
    return this.getWorkspace(ws.id)!;
  }

  updateWorkspace(id: string, patch: Partial<Workspace>, expectedVersion?: number): Workspace | undefined {
    const existing = this.getWorkspace(id);
    if (!existing) return undefined;
    if (expectedVersion != null) {
      const meta = this.getWorkspaceMeta(id);
      if (meta && meta.version !== expectedVersion) {
        const err = new Error('VERSION_CONFLICT');
        (err as Error & { code: string }).code = 'VERSION_CONFLICT';
        throw err;
      }
    }
    const merged: Workspace = { ...existing, ...patch, id };
    const sortRow = this.db.prepare('SELECT sort_index FROM workspaces WHERE id = ?').get(id) as
      | { sort_index: number }
      | undefined;
    const currentVersion = this.getWorkspaceMeta(id)?.version ?? 1;
    this.writeWorkspace(merged, sortRow?.sort_index ?? this.count(), { version: currentVersion + 1 });
    return this.getWorkspace(id);
  }

  deleteWorkspace(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  replaceAll(workspaces: Workspace[]): void {
    this.tx(() => {
      this.db.exec('DELETE FROM workspaces');
      workspaces.forEach((ws, i) => this.writeWorkspaceUnsafe(ws, i, { version: 1 }));
    });
  }

  exportAll(): Workspace[] {
    return this.listWorkspaces();
  }

  createSnapshot(workspaceId: string, label: string): { id: string } | undefined {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return undefined;
    const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        'INSERT INTO workspace_snapshots(id, workspace_id, created_at, label, blob) VALUES(?, ?, ?, ?, ?)'
      )
      .run(id, workspaceId, Date.now(), label, JSON.stringify(ws));
    return { id };
  }

  listSnapshots(workspaceId: string): { id: string; createdAt: number; label: string }[] {
    const rows = this.db
      .prepare(
        'SELECT id, created_at, label FROM workspace_snapshots WHERE workspace_id = ? ORDER BY created_at DESC'
      )
      .all(workspaceId) as { id: string; created_at: number; label: string }[];
    return rows.map(r => ({ id: r.id, createdAt: r.created_at, label: r.label }));
  }

  restoreSnapshot(snapshotId: string): Workspace | undefined {
    const row = this.db
      .prepare('SELECT workspace_id, blob FROM workspace_snapshots WHERE id = ?')
      .get(snapshotId) as { workspace_id: string; blob: string } | undefined;
    if (!row) return undefined;
    try {
      const ws = JSON.parse(row.blob) as Workspace;
      return this.updateWorkspace(row.workspace_id, ws);
    } catch {
      return undefined;
    }
  }

  private buildScopeWhere(): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (this.scope.teamId) {
      clauses.push('team_id = ?');
      params.push(this.scope.teamId);
    } else if (this.scope.ownerId) {
      clauses.push('owner_id = ?');
      params.push(this.scope.ownerId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return { where, params };
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private writeWorkspace(ws: Workspace, sortIndex: number, meta: { version: number }): void {
    this.tx(() => this.writeWorkspaceUnsafe(ws, sortIndex, meta));
  }

  private writeWorkspaceUnsafe(ws: Workspace, sortIndex: number, meta: { version: number }): void {
    const vals = workspaceRowValues(ws, sortIndex, {
      ownerId: this.scope.ownerId,
      teamId: this.scope.teamId,
      updatedAt: Date.now(),
      version: meta.version,
    });

    this.db
      .prepare(
        `INSERT INTO workspaces
          (id, name, created_at, conference, entry_plan_mode, scoring_settings,
           loaded_meet, official_team_scores, active_entry_ids, history_sources, sort_index,
           owner_id, team_id, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           created_at = excluded.created_at,
           conference = excluded.conference,
           entry_plan_mode = excluded.entry_plan_mode,
           scoring_settings = excluded.scoring_settings,
           loaded_meet = excluded.loaded_meet,
           official_team_scores = excluded.official_team_scores,
           active_entry_ids = excluded.active_entry_ids,
           history_sources = excluded.history_sources,
           sort_index = excluded.sort_index,
           owner_id = COALESCE(excluded.owner_id, owner_id),
           team_id = COALESCE(excluded.team_id, team_id),
           updated_at = excluded.updated_at,
           version = excluded.version`
      )
      .run(
        vals.id,
        vals.name,
        vals.created_at,
        vals.conference,
        vals.entry_plan_mode,
        vals.scoring_settings,
        vals.loaded_meet,
        vals.official_team_scores,
        vals.active_entry_ids,
        vals.history_sources,
        vals.sort_index,
        vals.owner_id,
        vals.team_id,
        vals.updated_at,
        vals.version
      );

    for (const table of [
      'meet_results',
      'recruits',
      'roster_overrides',
      'meet_entry_plans',
      'relay_leg_overrides',
      'deleted_swimmers',
      'athlete_history',
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(ws.id);
    }

    const insertResult = this.db.prepare(
      'INSERT INTO meet_results(id, workspace_id, gender, position, data) VALUES(?, ?, ?, ?, ?)'
    );
    for (const row of insertResultsRows(ws.id, ws.menResults ?? [], 'Men')) {
      insertResult.run(row.id, row.workspace_id, row.gender, row.position, row.data);
    }
    for (const row of insertResultsRows(ws.id, ws.womenResults ?? [], 'Women')) {
      insertResult.run(row.id, row.workspace_id, row.gender, row.position, row.data);
    }

    const insertWithId = (table: string) =>
      this.db.prepare(`INSERT INTO ${table}(id, workspace_id, position, data) VALUES(?, ?, ?, ?)`);
    for (const row of insertWithIdRows('recruits', ws.id, ws.recruits ?? [])) {
      insertWithId('recruits').run(row.id, row.workspace_id, row.position, row.data);
    }
    for (const row of insertWithIdRows('meet_entry_plans', ws.id, ws.meetEntryPlans ?? [])) {
      insertWithId('meet_entry_plans').run(row.id, row.workspace_id, row.position, row.data);
    }

    const insertPos = (table: string) =>
      this.db.prepare(`INSERT INTO ${table}(workspace_id, position, data) VALUES(?, ?, ?)`);
    for (const row of insertPositionalRows(ws.id, ws.scorerRosterOverrides ?? [])) {
      insertPos('roster_overrides').run(row.workspace_id, row.position, row.data);
    }
    for (const row of insertPositionalRows(ws.id, ws.relayLegOverrides ?? [])) {
      insertPos('relay_leg_overrides').run(row.workspace_id, row.position, row.data);
    }
    for (const row of insertPositionalRows(ws.id, ws.deletedSwimmers ?? [])) {
      insertPos('deleted_swimmers').run(row.workspace_id, row.position, row.data);
    }
    for (const row of insertPositionalRows(ws.id, ws.athleteHistory ?? [])) {
      insertPos('athlete_history').run(row.workspace_id, row.position, row.data);
    }
  }
}

export type { Workspace, SwimmerResult };
