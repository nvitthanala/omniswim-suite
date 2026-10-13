/**
 * WorkspaceService — SQLite-backed persistence for full `Workspace` aggregates.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace, SwimmerResult } from '@omniswim/core/types';
import { SCHEMA_VERSION, CREATE_TABLES_SQL, SQLITE_MIGRATIONS_V2, SQLITE_MIGRATIONS_V3, SQLITE_MIGRATIONS_V4, SQLITE_MIGRATIONS_V5, SQLITE_MIGRATIONS_V6, SQLITE_MIGRATIONS_V7, SQLITE_MIGRATIONS_V8 } from './schema';
import {
  assembleWorkspace,
  duplicateWorkspaceError,
  insertPositionalRows,
  insertResultsRows,
  insertWithIdRows,
  versionConflictError,
  workspaceRowValues,
  type WorkspaceScope,
} from './workspacePersistence';
import { assertSchemaNotNewer } from './schemaGuard';

export class WorkspaceService {
  private db: DatabaseSync;
  private scope: WorkspaceScope = {};

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // Compare BEFORE anything runs against the file. The migrations below only add,
    // so they would "succeed" on a newer database and the stamp at the end of this
    // constructor would then downgrade it. A refusal must leave the file untouched.
    try {
      assertSchemaNotNewer(this.readStoredSchemaVersion(), SCHEMA_VERSION, dbPath);
    } catch (err) {
      this.db.close();
      throw err;
    }
    this.db.exec(CREATE_TABLES_SQL);
    for (const sql of SQLITE_MIGRATIONS_V2) {
      try {
        this.db.exec(sql);
      } catch {
        /* column already exists */
      }
    }
    for (const sql of SQLITE_MIGRATIONS_V3) {
      try {
        this.db.exec(sql);
      } catch {
        /* column/table already exists */
      }
    }
    for (const sql of SQLITE_MIGRATIONS_V4) {
      try {
        this.db.exec(sql);
      } catch {
        /* table already exists */
      }
    }
    for (const sql of SQLITE_MIGRATIONS_V5) {
      try {
        this.db.exec(sql);
      } catch {
        /* column already exists */
      }
    }
    for (const sql of SQLITE_MIGRATIONS_V6) {
      try {
        this.db.exec(sql);
      } catch {
        /* table already exists */
      }
    }
    for (const sql of SQLITE_MIGRATIONS_V7) {
      try {
        this.db.exec(sql);
      } catch {
        /* table already exists */
      }
    }
    for (const sql of SQLITE_MIGRATIONS_V8) {
      try {
        this.db.exec(sql);
      } catch {
        /* table already exists */
      }
    }
    this.db
      .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  /**
   * Default scope for calls that do not pass one. Kept for scripts and tests; the
   * server passes the scope on every call instead (a shared mutable scope is how a
   * request ran under the previous request's tenant).
   */
  setScope(scope: WorkspaceScope): void {
    this.scope = scope;
  }

  close(): void {
    this.db.close();
  }

  /** Raw `meta.schema_version`, or null for a file with no `meta` table or no stamp yet. */
  private readStoredSchemaVersion(): string | null {
    const hasMeta = this.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get();
    if (!hasMeta) return null;
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string | null }
      | undefined;
    return row?.value ?? null;
  }

  count(scope: WorkspaceScope = this.scope): number {
    const { where, params } = this.buildScopeWhere(scope);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM workspaces ${where}`).get(
      ...(params as (string | number | null)[])
    ) as {
      n: number;
    };
    return row?.n ?? 0;
  }

  listWorkspaces(scope: WorkspaceScope = this.scope): Workspace[] {
    const { where, params } = this.buildScopeWhere(scope);
    const rows = this.db
      .prepare(`SELECT id FROM workspaces ${where} ORDER BY sort_index ASC, created_at ASC`)
      .all(...(params as (string | number | null)[])) as { id: string }[];
    return rows.map(r => this.getWorkspace(r.id, scope)).filter((w): w is Workspace => w != null);
  }

  getWorkspace(id: string, scope: WorkspaceScope = this.scope): Workspace | undefined {
    const { where, params } = this.buildScopeWhere(scope, 'id = ?', [id]);
    const row = this.db
      .prepare(`SELECT * FROM workspaces ${where}`)
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

  getWorkspaceMeta(
    id: string,
    scope: WorkspaceScope = this.scope
  ): { version: number; updatedAt: number } | undefined {
    const { where, params } = this.buildScopeWhere(scope, 'id = ?', [id]);
    const row = this.db
      .prepare(`SELECT version, updated_at FROM workspaces ${where}`)
      .get(...(params as (string | number | null)[])) as
      | { version: number; updated_at: number }
      | undefined;
    if (!row) return undefined;
    return { version: Number(row.version ?? 1), updatedAt: Number(row.updated_at ?? 0) };
  }

  /**
   * Insert a new workspace. Refuses with `DUPLICATE_WORKSPACE_ID` when the id is
   * taken by ANY tenant: ids are the table's primary key, and the upsert below
   * would otherwise overwrite another tenant's rows and take over their owner.
   */
  createWorkspace(ws: Workspace, sortIndex?: number, scope: WorkspaceScope = this.scope): Workspace {
    this.tx(() => {
      const taken = this.db.prepare('SELECT 1 AS ok FROM workspaces WHERE id = ?').get(ws.id);
      if (taken) throw duplicateWorkspaceError(ws.id);
      this.writeWorkspaceUnsafe(ws, sortIndex ?? this.count(scope), { version: 1 }, scope);
    });
    return this.getWorkspace(ws.id, scope)!;
  }

  updateWorkspace(
    id: string,
    patch: Partial<Workspace>,
    expectedVersion?: number,
    scope: WorkspaceScope = this.scope
  ): Workspace | undefined {
    const existing = this.getWorkspace(id, scope);
    if (!existing) return undefined;
    const meta = this.getWorkspaceMeta(id, scope);
    if (expectedVersion != null && meta && meta.version !== expectedVersion) {
      throw versionConflictError();
    }
    const merged: Workspace = { ...existing, ...patch, id };
    const sortRow = this.db.prepare('SELECT sort_index FROM workspaces WHERE id = ?').get(id) as
      | { sort_index: number }
      | undefined;
    const currentVersion = meta?.version ?? 1;
    this.writeWorkspace(
      merged,
      sortRow?.sort_index ?? this.count(scope),
      { version: currentVersion + 1 },
      scope
    );
    return this.getWorkspace(id, scope);
  }

  deleteWorkspace(id: string, scope: WorkspaceScope = this.scope): void {
    // Scoped: a tenant must not be able to destroy another tenant's workspace by id.
    const { where, params } = this.buildScopeWhere(scope, 'id = ?', [id]);
    this.db.prepare(`DELETE FROM workspaces ${where}`).run(...(params as (string | number | null)[]));
  }

  /**
   * Replace EVERY workspace, for every tenant (a global restore or a migration).
   * Deliberately not scoped: callers that must not do this check before calling.
   *
   * A workspace that already exists keeps its owner and team, and its revision
   * counter moves forward, so a restore neither orphans a tenant's data nor lets a
   * tab holding the old revision overwrite what was just restored.
   */
  replaceAll(workspaces: Workspace[], scope: WorkspaceScope = this.scope): void {
    this.tx(() => {
      const previous = new Map<string, { ownerId?: string; teamId?: string; version: number }>();
      const rows = this.db.prepare('SELECT id, owner_id, team_id, version FROM workspaces').all() as {
        id: string;
        owner_id: string | null;
        team_id: string | null;
        version: number;
      }[];
      for (const r of rows) {
        previous.set(r.id, {
          ownerId: r.owner_id ?? undefined,
          teamId: r.team_id ?? undefined,
          version: Number(r.version),
        });
      }
      this.db.exec('DELETE FROM workspaces');
      workspaces.forEach((ws, i) => {
        const prev = previous.get(ws.id);
        this.writeWorkspaceUnsafe(
          ws,
          i,
          { version: prev ? prev.version + 1 : 1 },
          prev ? { ownerId: prev.ownerId, teamId: prev.teamId } : scope
        );
      });
    });
  }

  exportAll(scope: WorkspaceScope = this.scope): Workspace[] {
    return this.listWorkspaces(scope);
  }

  /**
   * Write a consistent, standalone copy of the live database to `destPath`.
   *
   * Copying `omniswim.db` with a file copy while the server runs can capture the main file
   * without the `-wal` pages that hold the newest commits, or a torn page mid-checkpoint. The
   * copy then opens, but not at any state the database was ever in. `VACUUM INTO` reads one
   * snapshot through SQLite itself and writes a single file with no `-wal` or `-shm` beside it,
   * so the result opens on its own.
   *
   * The copy holds EVERY tenant's rows (it is the whole database), not the current scope.
   * `destPath` must not exist: SQLite refuses to overwrite, and this refuses first with a clear
   * message. The caller writes to a temporary name and renames, so a half-written file never
   * carries a final name.
   */
  copyDatabaseTo(destPath: string): void {
    if (fs.existsSync(destPath)) {
      throw new Error(`Refusing to overwrite an existing file with a database copy: ${destPath}`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(destPath);
  }

  createSnapshot(
    workspaceId: string,
    label: string,
    scope: WorkspaceScope = this.scope
  ): { id: string } | undefined {
    const ws = this.getWorkspace(workspaceId, scope);
    if (!ws) return undefined;
    const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        'INSERT INTO workspace_snapshots(id, workspace_id, created_at, label, blob) VALUES(?, ?, ?, ?, ?)'
      )
      .run(id, workspaceId, Date.now(), label, JSON.stringify(ws));
    return { id };
  }

  listSnapshots(
    workspaceId: string,
    scope: WorkspaceScope = this.scope
  ): { id: string; createdAt: number; label: string }[] {
    // Snapshot labels leak workspace names, so gate the listing on the same scope
    // that governs reads rather than trusting the caller-supplied id.
    if (!this.isInScope(workspaceId, scope)) return [];
    const rows = this.db
      .prepare(
        'SELECT id, created_at, label FROM workspace_snapshots WHERE workspace_id = ? ORDER BY created_at DESC'
      )
      .all(workspaceId) as { id: string; created_at: number; label: string }[];
    return rows.map(r => ({ id: r.id, createdAt: r.created_at, label: r.label }));
  }

  /** Read-only: snapshot's stored workspace content without restoring it. */
  getSnapshotContent(snapshotId: string, scope: WorkspaceScope = this.scope): Workspace | undefined {
    const row = this.db
      .prepare('SELECT workspace_id, blob FROM workspace_snapshots WHERE id = ?')
      .get(snapshotId) as { workspace_id: string; blob: string } | undefined;
    if (!row) return undefined;
    // Same gate as restoreSnapshot: a snapshot is a full copy of someone's workspace,
    // and its id is not a secret.
    if (!this.isInScope(row.workspace_id, scope)) return undefined;
    try {
      return JSON.parse(row.blob) as Workspace;
    } catch {
      return undefined;
    }
  }

  restoreSnapshot(snapshotId: string, scope: WorkspaceScope = this.scope): Workspace | undefined {
    const row = this.db
      .prepare('SELECT workspace_id, blob FROM workspace_snapshots WHERE id = ?')
      .get(snapshotId) as { workspace_id: string; blob: string } | undefined;
    if (!row) return undefined;
    // Check scope before deserializing: the blob is a full workspace, so an
    // out-of-scope snapshot id must not pull another tenant's data into memory.
    if (!this.isInScope(row.workspace_id, scope)) return undefined;
    try {
      const ws = JSON.parse(row.blob) as Workspace;
      return this.updateWorkspace(row.workspace_id, ws, undefined, scope);
    } catch {
      return undefined;
    }
  }

  private buildScopeWhere(
    scope: WorkspaceScope,
    baseClause?: string,
    baseParams: unknown[] = []
  ): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params = [...baseParams];
    if (baseClause) clauses.push(baseClause);
    if (scope.teamId) {
      clauses.push('team_id = ?');
      params.push(scope.teamId);
    } else if (scope.ownerId) {
      clauses.push('owner_id = ?');
      params.push(scope.ownerId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return { where, params };
  }

  /** True when `id` is visible under the current scope. Cheap existence probe. */
  private isInScope(id: string, scope: WorkspaceScope): boolean {
    const { where, params } = this.buildScopeWhere(scope, 'id = ?', [id]);
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM workspaces ${where} LIMIT 1`)
      .get(...(params as (string | number | null)[]));
    return row != null;
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

  private writeWorkspace(
    ws: Workspace,
    sortIndex: number,
    meta: { version: number },
    scope: WorkspaceScope
  ): void {
    this.tx(() => this.writeWorkspaceUnsafe(ws, sortIndex, meta, scope));
  }

  /** `owner` is stamped on the row: the caller's scope, or an existing row's owner on a global replace. */
  private writeWorkspaceUnsafe(
    ws: Workspace,
    sortIndex: number,
    meta: { version: number },
    owner: WorkspaceScope
  ): void {
    const vals = workspaceRowValues(ws, sortIndex, {
      ownerId: owner.ownerId,
      teamId: owner.teamId,
      updatedAt: Date.now(),
      version: meta.version,
    });

    this.db
      .prepare(
        `INSERT INTO workspaces
          (id, name, created_at, conference, entry_plan_mode, scoring_view, scoring_settings,
           loaded_meet, loaded_psych, official_team_scores, active_entry_ids, history_sources, sort_index,
           owner_id, team_id, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           created_at = excluded.created_at,
           conference = excluded.conference,
           entry_plan_mode = excluded.entry_plan_mode,
           scoring_view = excluded.scoring_view,
           scoring_settings = excluded.scoring_settings,
           loaded_meet = excluded.loaded_meet,
           loaded_psych = excluded.loaded_psych,
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
        vals.scoring_view,
        vals.scoring_settings,
        vals.loaded_meet,
        vals.loaded_psych,
        vals.official_team_scores,
        vals.active_entry_ids,
        vals.history_sources,
        vals.sort_index,
        vals.owner_id,
        vals.team_id,
        vals.updated_at,
        vals.version
      );

    this.deleteWorkspaceChildRows(ws.id);
    this.insertMeetResultRows(ws);
    this.insertSourceMeetResultRows(ws);
    this.insertPsychResultRows(ws);
    this.insertWithIdChildRows(ws);
    this.insertPositionalChildRows(ws);
  }

  /**
   * Every workspace child table, wiped for one workspace before its rows are
   * reinserted below. `writeWorkspaceUnsafe` always rewrites a workspace's
   * children in full rather than diffing them.
   */
  private deleteWorkspaceChildRows(workspaceId: string): void {
    for (const table of [
      'meet_results',
      'source_meet_results',
      'psych_results',
      'recruits',
      'roster_overrides',
      'meet_entry_plans',
      'relay_leg_overrides',
      'deleted_swimmers',
      'athlete_history',
      'race_analyses',
      'athlete_aliases',
      'relay_leg_credits',
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
    }
  }

  private insertMeetResultRows(ws: Workspace): void {
    const insertResult = this.db.prepare(
      'INSERT INTO meet_results(id, workspace_id, gender, position, data) VALUES(?, ?, ?, ?, ?)'
    );
    for (const row of insertResultsRows(ws.id, ws.menResults ?? [], 'Men')) {
      insertResult.run(row.id, row.workspace_id, row.gender, row.position, row.data);
    }
    for (const row of insertResultsRows(ws.id, ws.womenResults ?? [], 'Women')) {
      insertResult.run(row.id, row.workspace_id, row.gender, row.position, row.data);
    }
  }

  private insertSourceMeetResultRows(ws: Workspace): void {
    const insertSource = this.db.prepare(
      'INSERT INTO source_meet_results(id, workspace_id, gender, position, data) VALUES(?, ?, ?, ?, ?)'
    );
    const sourceMen = ws.sourceMenResults ?? ws.menResults ?? [];
    const sourceWomen = ws.sourceWomenResults ?? ws.womenResults ?? [];
    for (const row of insertResultsRows(ws.id, sourceMen, 'Men')) {
      insertSource.run(`src-${row.id}`, row.workspace_id, row.gender, row.position, row.data);
    }
    for (const row of insertResultsRows(ws.id, sourceWomen, 'Women')) {
      insertSource.run(`src-${row.id}`, row.workspace_id, row.gender, row.position, row.data);
    }
  }

  private insertPsychResultRows(ws: Workspace): void {
    const insertPsych = this.db.prepare(
      'INSERT INTO psych_results(id, workspace_id, gender, position, data) VALUES(?, ?, ?, ?, ?)'
    );
    for (const row of insertResultsRows(ws.id, ws.psychMenResults ?? [], 'Men')) {
      insertPsych.run(row.id, row.workspace_id, row.gender, row.position, row.data);
    }
    for (const row of insertResultsRows(ws.id, ws.psychWomenResults ?? [], 'Women')) {
      insertPsych.run(row.id, row.workspace_id, row.gender, row.position, row.data);
    }
  }

  private insertWithIdChildRows(ws: Workspace): void {
    const insertWithId = (table: string) =>
      this.db.prepare(`INSERT INTO ${table}(id, workspace_id, position, data) VALUES(?, ?, ?, ?)`);
    for (const row of insertWithIdRows('recruits', ws.id, ws.recruits ?? [])) {
      insertWithId('recruits').run(row.id, row.workspace_id, row.position, row.data);
    }
    for (const row of insertWithIdRows('meet_entry_plans', ws.id, ws.meetEntryPlans ?? [])) {
      insertWithId('meet_entry_plans').run(row.id, row.workspace_id, row.position, row.data);
    }
    for (const row of insertWithIdRows('athlete_aliases', ws.id, ws.athleteAliases ?? [])) {
      insertWithId('athlete_aliases').run(row.id, row.workspace_id, row.position, row.data);
    }
  }

  private insertPositionalChildRows(ws: Workspace): void {
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
    for (const row of insertPositionalRows(ws.id, ws.raceAnalyses ?? [])) {
      insertPos('race_analyses').run(row.workspace_id, row.position, row.data);
    }
    for (const row of insertPositionalRows(ws.id, ws.relayLegCredits ?? [])) {
      insertPos('relay_leg_credits').run(row.workspace_id, row.position, row.data);
    }
  }
}

export type { Workspace, SwimmerResult };
