/**
 * PostgreSQL-backed workspace persistence (shared multi-user deployment).
 */
import pg from 'pg';
import type { Workspace, SwimmerResult } from '@omniswim/core/types';
import { PG_SCHEMA_VERSION, CREATE_PG_TABLES_SQL } from './pgSchema';
import {
  assembleWorkspace,
  duplicateWorkspaceError,
  insertPositionalRows,
  insertResultsRows,
  insertWithIdRows,
  parseJson,
  versionConflictError,
  workspaceRowValues,
  type WorkspaceScope,
} from './workspacePersistence';
import { assertSchemaNotNewer, SchemaVersionError } from './schemaGuard';

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

  /**
   * Compare BEFORE creating or stamping anything: a refusal must leave the
   * database untouched. to_regclass follows the connection's search_path and
   * returns NULL (not an error) on a database with no meta table yet.
   */
  private async refuseNewerSchema(client: pg.PoolClient): Promise<void> {
    const hasMeta = await client.query("SELECT to_regclass('meta') AS t");
    if (!hasMeta.rows[0]?.t) return;
    const stored = await client.query("SELECT value FROM meta WHERE key = 'schema_version'");
    assertSchemaNotNewer(
      (stored.rows[0]?.value as string | null | undefined) ?? null,
      PG_SCHEMA_VERSION,
      'the PostgreSQL database'
    );
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    let refusal: SchemaVersionError | null = null;
    try {
      await this.refuseNewerSchema(client);
      await client.query(CREATE_PG_TABLES_SQL);
      // Additive column migration for pre-existing deployments (idempotent).
      await client.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS scoring_view TEXT');
      await client.query(
        'INSERT INTO meta(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
        ['schema_version', String(PG_SCHEMA_VERSION)]
      );
    } catch (err) {
      if (!(err instanceof SchemaVersionError)) throw err;
      refusal = err;
    } finally {
      client.release();
    }
    if (refusal) {
      // The pool has no use once the service refuses to run; release its sockets so a
      // caller that catches this error can exit.
      await this.pool.end().catch(() => undefined);
      throw refusal;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Default scope for calls that do not pass one. Kept for scripts and tests; the
   * server passes the scope on every call instead (a shared mutable scope is how a
   * request ran under the previous request's tenant).
   */
  setScope(scope: WorkspaceScope): void {
    this.scope = scope;
  }

  async count(scope: WorkspaceScope = this.scope): Promise<number> {
    const { where, params } = this.scopeFilter(scope);
    const res = await this.pool.query(`SELECT COUNT(*)::int AS n FROM workspaces ${where}`, params);
    return res.rows[0]?.n ?? 0;
  }

  async listWorkspaces(scope: WorkspaceScope = this.scope): Promise<Workspace[]> {
    const { where, params } = this.scopeFilter(scope);
    const res = await this.pool.query(
      `SELECT id FROM workspaces ${where} ORDER BY sort_index ASC, created_at ASC`,
      params
    );
    const out: Workspace[] = [];
    for (const row of res.rows) {
      const ws = await this.getWorkspace(row.id as string, scope);
      if (ws) out.push(ws);
    }
    return out;
  }

  async getWorkspace(id: string, scope: WorkspaceScope = this.scope): Promise<Workspace | undefined> {
    const { where, params } = this.scopeFilter(scope, 'id = $1', [id]);
    const res = await this.pool.query(`SELECT * FROM workspaces ${where}`, params);
    const row = res.rows[0];
    if (!row) return undefined;

    const childData = async (table: string) => {
      const childRes = await this.pool.query(
        `SELECT data FROM ${table} WHERE workspace_id = $1 ORDER BY position ASC`,
        [id]
      );
      return childRes.rows
        .map((r: { data: unknown }) => parseJson<unknown>(r.data, null))
        .filter((d): d is NonNullable<typeof d> => d != null);
    };

    const tables = [
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
    ] as const;
    const dataMap: Record<string, unknown[]> = {};
    for (const t of tables) dataMap[t] = await childData(t);

    return assembleWorkspace(row, table => dataMap[table] ?? []);
  }

  async getWorkspaceMeta(
    id: string,
    scope: WorkspaceScope = this.scope
  ): Promise<{ version: number; updatedAt: number } | undefined> {
    const { where, params } = this.scopeFilter(scope, 'id = $1', [id]);
    const res = await this.pool.query(`SELECT version, updated_at FROM workspaces ${where}`, params);
    const row = res.rows[0];
    if (!row) return undefined;
    return { version: Number(row.version), updatedAt: Number(row.updated_at) };
  }

  /**
   * Insert a new workspace. Refuses with `DUPLICATE_WORKSPACE_ID` when the id is
   * taken by ANY tenant: ids are the table's primary key, and the upsert in
   * `writeWorkspaceUnsafe` would otherwise overwrite another tenant's rows and take
   * over their owner.
   */
  async createWorkspace(
    ws: Workspace,
    sortIndex?: number,
    scope: WorkspaceScope = this.scope
  ): Promise<Workspace> {
    const index = sortIndex ?? (await this.count(scope));
    await this.writeWorkspace(ws, index, { bumpVersion: false }, scope, async client => {
      // Two creates of one id can both see "free" before either inserts; the advisory
      // lock (held to the end of this transaction) makes the second wait and then see it.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ws.id]);
      const taken = await client.query('SELECT 1 FROM workspaces WHERE id = $1', [ws.id]);
      if (taken.rows.length > 0) throw duplicateWorkspaceError(ws.id);
    });
    return (await this.getWorkspace(ws.id, scope))!;
  }

  async updateWorkspace(
    id: string,
    patch: Partial<Workspace>,
    expectedVersion?: number,
    scope: WorkspaceScope = this.scope
  ): Promise<Workspace | undefined> {
    const existing = await this.getWorkspace(id, scope);
    if (!existing) return undefined;

    const merged: Workspace = { ...existing, ...patch, id };
    const sortRes = await this.pool.query('SELECT sort_index FROM workspaces WHERE id = $1', [id]);
    const sortIndex = Number(sortRes.rows[0]?.sort_index ?? 0);
    const opts: { bumpVersion: boolean; version?: number } = { bumpVersion: true };
    // The version is read, compared and bumped INSIDE the write transaction, under a row
    // lock. Reading it before the transaction (as this method used to) let two requests
    // that are not serialized by the route sequencer (two users on one team, two server
    // processes) both pass the check and both write the same next version.
    await this.writeWorkspace(merged, sortIndex, opts, scope, async client => {
      const locked = await client.query('SELECT version FROM workspaces WHERE id = $1 FOR UPDATE', [id]);
      const stored = Number(locked.rows[0]?.version ?? 1);
      if (expectedVersion != null && locked.rows.length > 0 && stored !== expectedVersion) {
        throw versionConflictError();
      }
      opts.version = stored + 1;
    });
    return this.getWorkspace(id, scope);
  }

  async deleteWorkspace(id: string, scope: WorkspaceScope = this.scope): Promise<void> {
    // Scoped: a tenant must not be able to destroy another tenant's workspace by id.
    const { where, params } = this.scopeFilter(scope, 'id = $1', [id]);
    await this.pool.query(`DELETE FROM workspaces ${where}`, params);
  }

  /**
   * Replace EVERY workspace, for every tenant (a global restore or a migration).
   * Deliberately not scoped: callers that must not do this check before calling.
   *
   * A workspace that already exists keeps its owner and team, and its revision
   * counter moves forward, so a restore neither orphans a tenant's data nor lets a
   * tab holding the old revision overwrite what was just restored.
   */
  async replaceAll(workspaces: Workspace[], scope: WorkspaceScope = this.scope): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const prevRes = await client.query('SELECT id, owner_id, team_id, version FROM workspaces');
      const previous = new Map<string, { owner: WorkspaceScope; version: number }>();
      for (const r of prevRes.rows as {
        id: string;
        owner_id: string | null;
        team_id: string | null;
        version: unknown;
      }[]) {
        previous.set(r.id, {
          owner: { ownerId: r.owner_id ?? undefined, teamId: r.team_id ?? undefined },
          version: Number(r.version),
        });
      }
      await client.query('DELETE FROM workspaces');
      for (const [i, workspace] of workspaces.entries()) {
        const prev = previous.get(workspace.id);
        await this.writeWorkspaceUnsafe(
          client,
          workspace,
          i,
          { bumpVersion: prev !== undefined, version: prev ? prev.version + 1 : 1 },
          prev ? prev.owner : scope
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async exportAll(scope: WorkspaceScope = this.scope): Promise<Workspace[]> {
    return this.listWorkspaces(scope);
  }

  async createSnapshot(
    workspaceId: string,
    label: string,
    scope: WorkspaceScope = this.scope
  ): Promise<{ id: string } | undefined> {
    const ws = await this.getWorkspace(workspaceId, scope);
    if (!ws) return undefined;
    const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.pool.query(
      'INSERT INTO workspace_snapshots(id, workspace_id, created_at, label, blob) VALUES($1, $2, $3, $4, $5)',
      [id, workspaceId, Date.now(), label, JSON.stringify(ws)]
    );
    return { id };
  }

  async listSnapshots(
    workspaceId: string,
    scope: WorkspaceScope = this.scope
  ): Promise<{ id: string; createdAt: number; label: string }[]> {
    // Snapshot labels leak workspace names, so gate the listing on the same scope
    // that governs reads rather than trusting the caller-supplied id.
    if (!(await this.isInScope(workspaceId, scope))) return [];
    const res = await this.pool.query(
      'SELECT id, created_at, label FROM workspace_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId]
    );
    return res.rows.map((r: { id: unknown; created_at: unknown; label?: unknown }) => ({
      id: r.id as string,
      createdAt: Number(r.created_at),
      label: (r.label as string) ?? '',
    }));
  }

  /** Read-only: snapshot's stored workspace content without restoring it. */
  async getSnapshotContent(
    snapshotId: string,
    scope: WorkspaceScope = this.scope
  ): Promise<Workspace | undefined> {
    const res = await this.pool.query(
      'SELECT workspace_id, blob FROM workspace_snapshots WHERE id = $1',
      [snapshotId]
    );
    const row = res.rows[0];
    if (!row) return undefined;
    // Same gate as restoreSnapshot: a snapshot is a full copy of someone's workspace,
    // and its id is not a secret.
    if (!(await this.isInScope(row.workspace_id as string, scope))) return undefined;
    return parseJson<Workspace | null>(row.blob, null) ?? undefined;
  }

  async restoreSnapshot(
    snapshotId: string,
    scope: WorkspaceScope = this.scope
  ): Promise<Workspace | undefined> {
    const res = await this.pool.query(
      'SELECT workspace_id, blob FROM workspace_snapshots WHERE id = $1',
      [snapshotId]
    );
    const row = res.rows[0];
    if (!row) return undefined;
    // Check scope before deserializing: the blob is a full workspace, so an
    // out-of-scope snapshot id must not pull another tenant's data into memory.
    if (!(await this.isInScope(row.workspace_id as string, scope))) return undefined;
    const ws = parseJson<Workspace | null>(row.blob, null);
    if (!ws) return undefined;
    return this.updateWorkspace(row.workspace_id as string, ws, undefined, scope);
  }

  /** True when `id` is visible under the current scope. Cheap existence probe. */
  private async isInScope(id: string, scope: WorkspaceScope): Promise<boolean> {
    const { where, params } = this.scopeFilter(scope, 'id = $1', [id]);
    const res = await this.pool.query(`SELECT 1 FROM workspaces ${where} LIMIT 1`, params);
    return res.rows.length > 0;
  }

  private scopeFilter(
    scope: WorkspaceScope,
    baseClause?: string,
    baseParams: unknown[] = []
  ): {
    where: string;
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params = [...baseParams];
    if (baseClause) clauses.push(baseClause);
    if (scope.teamId) {
      params.push(scope.teamId);
      clauses.push(`team_id = $${params.length}`);
    } else if (scope.ownerId) {
      params.push(scope.ownerId);
      clauses.push(`owner_id = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return { where, params };
  }

  private async writeWorkspace(
    ws: Workspace,
    sortIndex: number,
    opts: { bumpVersion: boolean; version?: number },
    owner: WorkspaceScope,
    beforeWrite?: (client: pg.PoolClient) => Promise<void>
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (beforeWrite) await beforeWrite(client);
      await this.writeWorkspaceUnsafe(client, ws, sortIndex, opts, owner);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** `owner` is stamped on the row: the caller's scope, or an existing row's owner on a global replace. */
  private async writeWorkspaceUnsafe(
    client: pg.PoolClient,
    ws: Workspace,
    sortIndex: number,
    opts: { bumpVersion: boolean; version?: number },
    owner: WorkspaceScope
  ): Promise<void> {
    const now = Date.now();
    const meta = {
      ownerId: owner.ownerId,
      teamId: owner.teamId,
      updatedAt: now,
      version: opts.version ?? 1,
    };
    const vals = workspaceRowValues(ws, sortIndex, meta);

    await client.query(
      `INSERT INTO workspaces
        (id, name, created_at, conference, entry_plan_mode, scoring_view, scoring_settings,
         loaded_meet, loaded_psych, official_team_scores, active_entry_ids, history_sources, sort_index,
         owner_id, team_id, updated_at, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT(id) DO UPDATE SET
         name = EXCLUDED.name,
         created_at = EXCLUDED.created_at,
         conference = EXCLUDED.conference,
         entry_plan_mode = EXCLUDED.entry_plan_mode,
         scoring_view = EXCLUDED.scoring_view,
         scoring_settings = EXCLUDED.scoring_settings,
         loaded_meet = EXCLUDED.loaded_meet,
         loaded_psych = EXCLUDED.loaded_psych,
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
        vals.version,
      ]
    );

    await this.deleteWorkspaceChildRows(client, ws.id);
    await this.insertMeetResultRows(client, ws);
    await this.insertSourceMeetResultRows(client, ws);
    await this.insertPsychResultRows(client, ws);
    await this.insertWithIdChildRows(client, ws);
    await this.insertPositionalChildRows(client, ws);
  }

  /**
   * Every workspace child table, wiped for one workspace before its rows are
   * reinserted below. `writeWorkspaceUnsafe` always rewrites a workspace's
   * children in full rather than diffing them.
   */
  private async deleteWorkspaceChildRows(client: pg.PoolClient, workspaceId: string): Promise<void> {
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
      await client.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
    }
  }

  private async insertMeetResultRows(client: pg.PoolClient, ws: Workspace): Promise<void> {
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
  }

  private async insertSourceMeetResultRows(client: pg.PoolClient, ws: Workspace): Promise<void> {
    const sourceMen = ws.sourceMenResults ?? ws.menResults ?? [];
    const sourceWomen = ws.sourceWomenResults ?? ws.womenResults ?? [];
    for (const row of insertResultsRows(ws.id, sourceMen, 'Men')) {
      await client.query(
        'INSERT INTO source_meet_results(id, workspace_id, gender, position, data) VALUES($1,$2,$3,$4,$5)',
        [`src-${row.id}`, row.workspace_id, row.gender, row.position, row.data]
      );
    }
    for (const row of insertResultsRows(ws.id, sourceWomen, 'Women')) {
      await client.query(
        'INSERT INTO source_meet_results(id, workspace_id, gender, position, data) VALUES($1,$2,$3,$4,$5)',
        [`src-${row.id}`, row.workspace_id, row.gender, row.position, row.data]
      );
    }
  }

  private async insertPsychResultRows(client: pg.PoolClient, ws: Workspace): Promise<void> {
    for (const row of insertResultsRows(ws.id, ws.psychMenResults ?? [], 'Men')) {
      await client.query(
        'INSERT INTO psych_results(id, workspace_id, gender, position, data) VALUES($1,$2,$3,$4,$5)',
        [row.id, row.workspace_id, row.gender, row.position, row.data]
      );
    }
    for (const row of insertResultsRows(ws.id, ws.psychWomenResults ?? [], 'Women')) {
      await client.query(
        'INSERT INTO psych_results(id, workspace_id, gender, position, data) VALUES($1,$2,$3,$4,$5)',
        [row.id, row.workspace_id, row.gender, row.position, row.data]
      );
    }
  }

  private async insertWithIdChildRows(client: pg.PoolClient, ws: Workspace): Promise<void> {
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
    for (const row of insertWithIdRows('athlete_aliases', ws.id, ws.athleteAliases ?? [])) {
      await client.query(
        'INSERT INTO athlete_aliases(id, workspace_id, position, data) VALUES($1,$2,$3,$4)',
        [row.id, row.workspace_id, row.position, row.data]
      );
    }
  }

  private async insertPositionalChildRows(client: pg.PoolClient, ws: Workspace): Promise<void> {
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
    for (const row of insertPositionalRows(ws.id, ws.raceAnalyses ?? [])) {
      await client.query(
        'INSERT INTO race_analyses(workspace_id, position, data) VALUES($1,$2,$3)',
        [row.workspace_id, row.position, row.data]
      );
    }
    for (const row of insertPositionalRows(ws.id, ws.relayLegCredits ?? [])) {
      await client.query(
        'INSERT INTO relay_leg_credits(workspace_id, position, data) VALUES($1,$2,$3)',
        [row.workspace_id, row.position, row.data]
      );
    }
  }
}

export type { Workspace, SwimmerResult };
