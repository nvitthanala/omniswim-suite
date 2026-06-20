/**
 * PostgreSQL-backed workspace persistence (shared multi-user deployment).
 */
import pg from 'pg';
import type { Workspace, SwimmerResult } from '@omniswim/core/types';
import { PG_SCHEMA_VERSION, CREATE_PG_TABLES_SQL } from './pgSchema';
import {
  assembleWorkspace,
  insertPositionalRows,
  insertResultsRows,
  insertWithIdRows,
  parseJson,
  workspaceRowValues,
  type WorkspaceScope,
} from './workspacePersistence';

const { Pool } = pg;

export type PgWorkspaceServiceOptions = {
  connectionString: string;
  scope?: WorkspaceScope;
};

export class PgWorkspaceService {
  private pool: pg.Pool;
  private scope: WorkspaceScope;

  constructor(options: PgWorkspaceServiceOptions) {
    this.pool = new Pool({ connectionString: options.connectionString });
    this.scope = options.scope ?? {};
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(CREATE_PG_TABLES_SQL);
      await client.query(
        'INSERT INTO meta(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
        ['schema_version', String(PG_SCHEMA_VERSION)]
      );
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  setScope(scope: WorkspaceScope): void {
    this.scope = scope;
  }

  async count(): Promise<number> {
    const { where, params } = this.scopeFilter();
    const res = await this.pool.query(`SELECT COUNT(*)::int AS n FROM workspaces ${where}`, params);
    return res.rows[0]?.n ?? 0;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const { where, params } = this.scopeFilter();
    const res = await this.pool.query(
      `SELECT id FROM workspaces ${where} ORDER BY sort_index ASC, created_at ASC`,
      params
    );
    const out: Workspace[] = [];
    for (const row of res.rows) {
      const ws = await this.getWorkspace(row.id as string);
      if (ws) out.push(ws);
    }
    return out;
  }

  async getWorkspace(id: string): Promise<Workspace | undefined> {
    const { where, params } = this.scopeFilter('id = $1', [id]);
    const res = await this.pool.query(`SELECT * FROM workspaces ${where}`, params);
    const row = res.rows[0];
    if (!row) return undefined;

    const childData = async (table: string) => {
      const childRes = await this.pool.query(
        `SELECT data FROM ${table} WHERE workspace_id = $1 ORDER BY position ASC`,
        [id]
      );
      return childRes.rows
        .map(r => parseJson<unknown>(r.data, null))
        .filter((d): d is NonNullable<typeof d> => d != null);
    };

    const tables = [
      'meet_results',
      'recruits',
      'roster_overrides',
      'meet_entry_plans',
      'relay_leg_overrides',
      'deleted_swimmers',
      'athlete_history',
    ] as const;
    const dataMap: Record<string, unknown[]> = {};
    for (const t of tables) dataMap[t] = await childData(t);

    return assembleWorkspace(row, table => dataMap[table] ?? []);
  }

  async getWorkspaceMeta(id: string): Promise<{ version: number; updatedAt: number } | undefined> {
    const res = await this.pool.query(
      'SELECT version, updated_at FROM workspaces WHERE id = $1',
      [id]
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return { version: Number(row.version), updatedAt: Number(row.updated_at) };
  }

  async createWorkspace(ws: Workspace, sortIndex?: number): Promise<Workspace> {
    await this.writeWorkspace(ws, sortIndex ?? (await this.count()), { bumpVersion: false });
    return (await this.getWorkspace(ws.id))!;
  }

  async updateWorkspace(
    id: string,
    patch: Partial<Workspace>,
    expectedVersion?: number
  ): Promise<Workspace | undefined> {
    const existing = await this.getWorkspace(id);
    if (!existing) return undefined;

    if (expectedVersion != null) {
      const meta = await this.getWorkspaceMeta(id);
      if (meta && meta.version !== expectedVersion) {
        const err = new Error('VERSION_CONFLICT');
        (err as Error & { code: string }).code = 'VERSION_CONFLICT';
        throw err;
      }
    }

    const merged: Workspace = { ...existing, ...patch, id };
    const sortRes = await this.pool.query('SELECT sort_index FROM workspaces WHERE id = $1', [id]);
    const sortIndex = Number(sortRes.rows[0]?.sort_index ?? 0);
    const currentVersion = (await this.getWorkspaceMeta(id))?.version ?? 1;
    await this.writeWorkspace(merged, sortIndex, {
      bumpVersion: true,
      version: currentVersion + 1,
    });
    return this.getWorkspace(id);
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.pool.query('DELETE FROM workspaces WHERE id = $1', [id]);
  }

  async replaceAll(workspaces: Workspace[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM workspaces');
      for (let i = 0; i < workspaces.length; i++) {
        await this.writeWorkspaceUnsafe(client, workspaces[i], i, { bumpVersion: false });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async exportAll(): Promise<Workspace[]> {
    return this.listWorkspaces();
  }

  async createSnapshot(workspaceId: string, label: string): Promise<{ id: string } | undefined> {
    const ws = await this.getWorkspace(workspaceId);
    if (!ws) return undefined;
    const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.pool.query(
      'INSERT INTO workspace_snapshots(id, workspace_id, created_at, label, blob) VALUES($1, $2, $3, $4, $5)',
      [id, workspaceId, Date.now(), label, JSON.stringify(ws)]
    );
    return { id };
  }

  async listSnapshots(
    workspaceId: string
  ): Promise<{ id: string; createdAt: number; label: string }[]> {
    const res = await this.pool.query(
      'SELECT id, created_at, label FROM workspace_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId]
    );
    return res.rows.map(r => ({
      id: r.id as string,
      createdAt: Number(r.created_at),
      label: (r.label as string) ?? '',
    }));
  }

  async restoreSnapshot(snapshotId: string): Promise<Workspace | undefined> {
    const res = await this.pool.query(
      'SELECT workspace_id, blob FROM workspace_snapshots WHERE id = $1',
      [snapshotId]
    );
    const row = res.rows[0];
    if (!row) return undefined;
    const ws = parseJson<Workspace | null>(row.blob, null);
    if (!ws) return undefined;
    return this.updateWorkspace(row.workspace_id as string, ws);
  }

  private scopeFilter(baseClause?: string, baseParams: unknown[] = []): {
    where: string;
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params = [...baseParams];
    if (baseClause) clauses.push(baseClause);
    if (this.scope.teamId) {
      params.push(this.scope.teamId);
      clauses.push(`team_id = $${params.length}`);
    } else if (this.scope.ownerId) {
      params.push(this.scope.ownerId);
      clauses.push(`owner_id = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return { where, params };
  }

  private async writeWorkspace(
    ws: Workspace,
    sortIndex: number,
    opts: { bumpVersion: boolean; version?: number }
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.writeWorkspaceUnsafe(client, ws, sortIndex, opts);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async writeWorkspaceUnsafe(
    client: pg.PoolClient,
    ws: Workspace,
    sortIndex: number,
    opts: { bumpVersion: boolean; version?: number }
  ): Promise<void> {
    const now = Date.now();
    const meta = {
      ownerId: this.scope.ownerId,
      teamId: this.scope.teamId,
      updatedAt: now,
      version: opts.version ?? 1,
    };
    const vals = workspaceRowValues(ws, sortIndex, meta);

    await client.query(
      `INSERT INTO workspaces
        (id, name, created_at, conference, entry_plan_mode, scoring_settings,
         loaded_meet, official_team_scores, active_entry_ids, history_sources, sort_index,
         owner_id, team_id, updated_at, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT(id) DO UPDATE SET
         name = EXCLUDED.name,
         created_at = EXCLUDED.created_at,
         conference = EXCLUDED.conference,
         entry_plan_mode = EXCLUDED.entry_plan_mode,
         scoring_settings = EXCLUDED.scoring_settings,
         loaded_meet = EXCLUDED.loaded_meet,
         official_team_scores = EXCLUDED.official_team_scores,
         active_entry_ids = EXCLUDED.active_entry_ids,
         history_sources = EXCLUDED.history_sources,
         sort_index = EXCLUDED.sort_index,
         owner_id = COALESCE(EXCLUDED.owner_id, workspaces.owner_id),
         team_id = COALESCE(EXCLUDED.team_id, workspaces.team_id),
         updated_at = EXCLUDED.updated_at,
         version = EXCLUDED.version`,
      [
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
        vals.version,
      ]
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
      await client.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [ws.id]);
    }

    for (const row of insertResultsRows(ws.id, ws.menResults ?? [], 'Men')) {
      await client.query(
        'INSERT INTO meet_results(id, workspace_id, gender, position, data) VALUES($1,$2,$3,$4,$5)',
        [row.id, row.workspace_id, row.gender, row.position, row.data]
      );
    }
    for (const row of insertResultsRows(ws.id, ws.womenResults ?? [], 'Women')) {
      await client.query(
        'INSERT INTO meet_results(id, workspace_id, gender, position, data) VALUES($1,$2,$3,$4,$5)',
        [row.id, row.workspace_id, row.gender, row.position, row.data]
      );
    }
    for (const row of insertWithIdRows('recruits', ws.id, ws.recruits ?? [])) {
      await client.query(
        'INSERT INTO recruits(id, workspace_id, position, data) VALUES($1,$2,$3,$4)',
        [row.id, row.workspace_id, row.position, row.data]
      );
    }
    for (const row of insertWithIdRows('meet_entry_plans', ws.id, ws.meetEntryPlans ?? [])) {
      await client.query(
        'INSERT INTO meet_entry_plans(id, workspace_id, position, data) VALUES($1,$2,$3,$4)',
        [row.id, row.workspace_id, row.position, row.data]
      );
    }
    for (const row of insertPositionalRows(ws.id, ws.scorerRosterOverrides ?? [])) {
      await client.query(
        'INSERT INTO roster_overrides(workspace_id, position, data) VALUES($1,$2,$3)',
        [row.workspace_id, row.position, row.data]
      );
    }
    for (const row of insertPositionalRows(ws.id, ws.relayLegOverrides ?? [])) {
      await client.query(
        'INSERT INTO relay_leg_overrides(workspace_id, position, data) VALUES($1,$2,$3)',
        [row.workspace_id, row.position, row.data]
      );
    }
    for (const row of insertPositionalRows(ws.id, ws.deletedSwimmers ?? [])) {
      await client.query(
        'INSERT INTO deleted_swimmers(workspace_id, position, data) VALUES($1,$2,$3)',
        [row.workspace_id, row.position, row.data]
      );
    }
    for (const row of insertPositionalRows(ws.id, ws.athleteHistory ?? [])) {
      await client.query(
        'INSERT INTO athlete_history(workspace_id, position, data) VALUES($1,$2,$3)',
        [row.workspace_id, row.position, row.data]
      );
    }
  }
}

export type { Workspace, SwimmerResult };
