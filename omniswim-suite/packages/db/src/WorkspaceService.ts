/**
 * WorkspaceService — SQLite-backed persistence for full `Workspace` aggregates.
 *
 * Built on Node's built-in `node:sqlite` (no native module compilation needed,
 * which matters on bleeding-edge Node where `better-sqlite3` has no prebuilt
 * binary). The public API returns/accepts complete `Workspace` objects so the
 * server routes and `SuiteWorkspaceProvider` stay unchanged.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace, SwimmerResult, Gender } from '@omniswim/core/types';
import { SCHEMA_VERSION, CREATE_TABLES_SQL } from './schema';

type Json = unknown;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class WorkspaceService {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(CREATE_TABLES_SQL);
    this.db
      .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  /** Number of workspaces currently stored (used to detect an empty DB). */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };
    return row?.n ?? 0;
  }

  listWorkspaces(): Workspace[] {
    const rows = this.db
      .prepare('SELECT id FROM workspaces ORDER BY sort_index ASC, created_at ASC')
      .all() as { id: string }[];
    return rows.map(r => this.getWorkspace(r.id)).filter((w): w is Workspace => w != null);
  }

  getWorkspace(id: string): Workspace | undefined {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;

    const childData = (table: string): Json[] => {
      const rows = this.db
        .prepare(`SELECT data FROM ${table} WHERE workspace_id = ? ORDER BY position ASC`)
        .all(id) as { data: string }[];
      return rows.map(r => parseJson<Json>(r.data, null)).filter(d => d != null);
    };

    const allResults = childData('meet_results') as SwimmerResult[];
    const menResults = allResults.filter(r => (r as { gender?: string }).gender !== 'Women');
    const womenResults = allResults.filter(r => (r as { gender?: string }).gender === 'Women');

    const workspace: Workspace = {
      id: String(row.id),
      name: String(row.name ?? ''),
      createdAt: Number(row.created_at ?? Date.now()),
      menResults,
      womenResults,
      recruits: childData('recruits') as Workspace['recruits'],
      deletedSwimmers: childData('deleted_swimmers') as Workspace['deletedSwimmers'],
      scorerRosterOverrides: childData('roster_overrides') as Workspace['scorerRosterOverrides'],
      meetEntryPlans: childData('meet_entry_plans') as Workspace['meetEntryPlans'],
      relayLegOverrides: childData('relay_leg_overrides') as Workspace['relayLegOverrides'],
      athleteHistory: childData('athlete_history') as Workspace['athleteHistory'],
      conference: row.conference != null ? String(row.conference) : undefined,
      entryPlanMode: (row.entry_plan_mode as Workspace['entryPlanMode']) ?? undefined,
      scoringSettings: parseJson<Workspace['scoringSettings']>(row.scoring_settings, undefined),
      loadedMeet: parseJson<Workspace['loadedMeet']>(row.loaded_meet, undefined),
      officialTeamScores: parseJson<Workspace['officialTeamScores']>(
        row.official_team_scores,
        undefined
      ),
      activeEntryIds: parseJson<string[] | undefined>(row.active_entry_ids, undefined),
      historySources: parseJson<Workspace['historySources']>(row.history_sources, undefined),
    };
    return workspace;
  }

  createWorkspace(ws: Workspace, sortIndex?: number): Workspace {
    this.writeWorkspace(ws, sortIndex ?? this.count());
    return this.getWorkspace(ws.id)!;
  }

  updateWorkspace(id: string, patch: Partial<Workspace>): Workspace | undefined {
    const existing = this.getWorkspace(id);
    if (!existing) return undefined;
    const merged: Workspace = { ...existing, ...patch, id };
    const sortRow = this.db.prepare('SELECT sort_index FROM workspaces WHERE id = ?').get(id) as
      | { sort_index: number }
      | undefined;
    this.writeWorkspace(merged, sortRow?.sort_index ?? this.count());
    return this.getWorkspace(id);
  }

  deleteWorkspace(id: string): void {
    // ON DELETE CASCADE clears child rows.
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  /** Replace the entire dataset (used by the JSON → SQLite migration). */
  replaceAll(workspaces: Workspace[]): void {
    this.tx(() => {
      this.db.exec('DELETE FROM workspaces');
      workspaces.forEach((ws, i) => this.writeWorkspaceUnsafe(ws, i));
    });
  }

  /** Full export for JSON backup / portability. */
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
    const ws = parseJson<Workspace | null>(row.blob, null);
    if (!ws) return undefined;
    return this.updateWorkspace(row.workspace_id, ws);
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

  private writeWorkspace(ws: Workspace, sortIndex: number): void {
    this.tx(() => this.writeWorkspaceUnsafe(ws, sortIndex));
  }

  /** Write without its own transaction (caller must provide one). */
  private writeWorkspaceUnsafe(ws: Workspace, sortIndex: number): void {
    {
      this.db
        .prepare(
          `INSERT INTO workspaces
            (id, name, created_at, conference, entry_plan_mode, scoring_settings,
             loaded_meet, official_team_scores, active_entry_ids, history_sources, sort_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
             sort_index = excluded.sort_index`
        )
        .run(
          ws.id,
          ws.name,
          ws.createdAt ?? Date.now(),
          ws.conference ?? null,
          ws.entryPlanMode ?? null,
          ws.scoringSettings ? JSON.stringify(ws.scoringSettings) : null,
          ws.loadedMeet ? JSON.stringify(ws.loadedMeet) : null,
          ws.officialTeamScores ? JSON.stringify(ws.officialTeamScores) : null,
          ws.activeEntryIds ? JSON.stringify(ws.activeEntryIds) : null,
          ws.historySources ? JSON.stringify(ws.historySources) : null,
          sortIndex
        );

      // Rewrite child collections.
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

      this.insertResults(ws.id, ws.menResults ?? [], 'Men');
      this.insertResults(ws.id, ws.womenResults ?? [], 'Women');
      this.insertWithId('recruits', ws.id, ws.recruits ?? []);
      this.insertWithId('meet_entry_plans', ws.id, ws.meetEntryPlans ?? []);
      this.insertPositional('roster_overrides', ws.id, ws.scorerRosterOverrides ?? []);
      this.insertPositional('relay_leg_overrides', ws.id, ws.relayLegOverrides ?? []);
      this.insertPositional('deleted_swimmers', ws.id, ws.deletedSwimmers ?? []);
      this.insertPositional('athlete_history', ws.id, ws.athleteHistory ?? []);
    }
  }

  private insertResults(workspaceId: string, results: SwimmerResult[], gender: string): void {
    const stmt = this.db.prepare(
      'INSERT INTO meet_results(id, workspace_id, gender, position, data) VALUES(?, ?, ?, ?, ?)'
    );
    results.forEach((r, i) => {
      const rid = (r as { id?: string }).id || `${workspaceId}_${gender}_${i}`;
      stmt.run(rid, workspaceId, gender, i, JSON.stringify(r));
    });
  }

  private insertWithId(
    table: string,
    workspaceId: string,
    rows: ReadonlyArray<{ id?: string }>
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO ${table}(id, workspace_id, position, data) VALUES(?, ?, ?, ?)`
    );
    rows.forEach((row, i) => {
      const rid = row.id || `${workspaceId}_${table}_${i}`;
      stmt.run(rid, workspaceId, i, JSON.stringify(row));
    });
  }

  private insertPositional(table: string, workspaceId: string, rows: unknown[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO ${table}(workspace_id, position, data) VALUES(?, ?, ?)`
    );
    rows.forEach((row, i) => stmt.run(workspaceId, i, JSON.stringify(row)));
  }
}

export type { Workspace, Gender };
