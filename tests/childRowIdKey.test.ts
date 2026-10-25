/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Schema v9: a child-table row id is unique per workspace, not store-wide.
 *
 * Before v9, `meet_results.id` (and five sibling tables) was the table's primary
 * key. Creating a copy of a workspace, which reuses its row ids, while the original
 * existed returned a 500 on SQLite and PostgreSQL. This file proves:
 *   - the create succeeds and BOTH workspaces read back intact, over real HTTP, on
 *     the SQLite store (the PostgreSQL twin is in `workspaceScopePg.test.ts`);
 *   - a v8 database is migrated with every row kept, the stamp moves to 9, and a
 *     second open does nothing;
 *   - a migration that cannot finish rolls back, leaves the v8 tables and stamp
 *     alone, and does not stamp 9;
 *   - the migrated tables have the same shape as a fresh v9 database;
 *   - an id used twice inside ONE workspace is a coded 409 that stores nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { promises as fsp, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import { SqliteRepo } from '../apps/shell/lib/workspaceRepo';
import { WorkspaceService } from '../packages/db/src/WorkspaceService';
import { SCHEMA_VERSION } from '../packages/db/src/schema';
import {
  ID_KEYED_CHILD_TABLES,
  CHILD_KEY_MIGRATION_BACKUP_FAILED_CODE,
  CHILD_KEY_MIGRATION_BLOCKED_CODE,
  migrateSqliteChildKeys,
} from '../packages/db/src/childKeyMigration';
import { DUPLICATE_ROW_ID_CODE } from '../packages/db/src/workspacePersistence';
import type { ScoringSettings, Workspace } from '../packages/core/src/types';

const TABLES = ID_KEYED_CHILD_TABLES.map(t => t.table);

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-rowid-'));
});
afterEach(async () => {
  // Windows keeps a SQLite handle that the HTTP tests' repo still holds; the OS temp cleaner takes it.
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

/** A workspace with a row in every id-keyed table, all carrying the SAME ids a copy would. */
function workspaceWithRows(id: string, name: string): Record<string, unknown> {
  const men = (i: number) => ({ id: `m${i}`, name: `Man ${i}`, gender: 'Men', event: '50 Y Free', time: '21.00', team: 'HSU' });
  const women = (i: number) => ({ id: `w${i}`, name: `Woman ${i}`, gender: 'Women', event: '50 Y Free', time: '23.00', team: 'HSU' });
  return {
    id,
    name,
    createdAt: 1000,
    menResults: [men(1), men(2)],
    womenResults: [women(1)],
    sourceMenResults: [men(1), men(2)],
    sourceWomenResults: [women(1)],
    psychMenResults: [{ ...men(1), id: 'pm1' }],
    psychWomenResults: [{ ...women(1), id: 'pw1' }],
    recruits: [{ id: 'rec1', name: 'Recruit', team: 'X', event: '50 Y Free', time: '22.00', gender: 'Men', classYear: 'FR', timeType: 'SCY' }],
    meetEntryPlans: [{ id: 'plan1', meetName: 'Dual', entries: [] }],
    athleteAliases: [{ id: 'alias1', from: 'Bob', to: 'Robert' }],
  };
}

/** Everything a client sees for the id-keyed collections, for before/after comparison. */
function keyed(ws: Workspace | Record<string, unknown>) {
  const w = ws as Record<string, unknown>;
  return {
    menResults: w.menResults,
    womenResults: w.womenResults,
    sourceMenResults: w.sourceMenResults,
    sourceWomenResults: w.sourceWomenResults,
    psychMenResults: w.psychMenResults,
    psychWomenResults: w.psychWomenResults,
    recruits: w.recruits,
    meetEntryPlans: w.meetEntryPlans,
    athleteAliases: w.athleteAliases,
  };
}

/** The v8 DDL of the tables the migration rebuilds, exactly as shipped before v9. */
const V8_TABLES_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, conference TEXT,
  entry_plan_mode TEXT, scoring_view TEXT, scoring_settings TEXT, loaded_meet TEXT, loaded_psych TEXT,
  official_team_scores TEXT, active_entry_ids TEXT, history_sources TEXT,
  sort_index INTEGER NOT NULL DEFAULT 0, owner_id TEXT, team_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
);
${['meet_results', 'source_meet_results', 'psych_results']
  .map(
    t => `CREATE TABLE ${t} (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  gender TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
);
CREATE INDEX idx_${t}_ws ON ${t}(workspace_id);`
  )
  .join('\n')}
${['recruits', 'meet_entry_plans', 'athlete_aliases']
  .map(
    t => `CREATE TABLE ${t} (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
);
CREATE INDEX idx_${t}_ws ON ${t}(workspace_id);`
  )
  .join('\n')}
`;

/** Write `ws` into a v8-shaped file by hand, the way the v8 build stored it. */
function insertV8(db: DatabaseSync, ws: Record<string, unknown>, sortIndex: number) {
  db.prepare(
    'INSERT INTO workspaces(id, name, created_at, sort_index, updated_at, version) VALUES(?,?,?,?,?,?)'
  ).run(ws.id as string, ws.name as string, ws.createdAt as number, sortIndex, 1, 1);
  const withGender = (table: string, rows: Array<Record<string, unknown>>, prefix = '') =>
    rows.forEach((r, i) =>
      db
        .prepare(`INSERT INTO ${table}(id, workspace_id, gender, position, data) VALUES(?,?,?,?,?)`)
        .run(`${prefix}${r.id as string}`, ws.id as string, r.gender as string, i, JSON.stringify(r))
    );
  const plain = (table: string, rows: Array<Record<string, unknown>>) =>
    rows.forEach((r, i) =>
      db
        .prepare(`INSERT INTO ${table}(id, workspace_id, position, data) VALUES(?,?,?,?)`)
        .run(r.id as string, ws.id as string, i, JSON.stringify(r))
    );
  withGender('meet_results', [...(ws.menResults as []), ...(ws.womenResults as [])]);
  withGender('source_meet_results', [...(ws.sourceMenResults as []), ...(ws.sourceWomenResults as [])], 'src-');
  withGender('psych_results', [...(ws.psychMenResults as []), ...(ws.psychWomenResults as [])]);
  plain('recruits', ws.recruits as []);
  plain('meet_entry_plans', ws.meetEntryPlans as []);
  plain('athlete_aliases', ws.athleteAliases as []);
}

function makeV8File(file: string, workspaces: Array<Record<string, unknown>>, stamp = '8') {
  const db = new DatabaseSync(file);
  db.exec(V8_TABLES_SQL);
  db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(stamp);
  workspaces.forEach((ws, i) => insertV8(db, ws, i));
  db.close();
}

type Pragma = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };
function tableShape(file: string, table: string): Pragma[] {
  const db = new DatabaseSync(file);
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Pragma[];
  db.close();
  return rows.map(r => ({ name: r.name, type: r.type, notnull: Number(r.notnull), dflt_value: r.dflt_value, pk: Number(r.pk) }));
}
function stamp(file: string): string | undefined {
  const db = new DatabaseSync(file);
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
  db.close();
  return row?.value;
}

describe('schema v9 migration (SQLite)', () => {
  it('rebuilds a v8 file with every row kept, stamps 9, and then accepts reused row ids', () => {
    const file = path.join(dir, 'v8.db');
    const a = workspaceWithRows('ws-a', 'Original');
    makeV8File(file, [a]);
    expect(tableShape(file, 'meet_results').find(c => c.name === 'id')?.pk).toBe(1);
    expect(tableShape(file, 'meet_results').find(c => c.name === 'workspace_id')?.pk).toBe(0);

    const svc = new WorkspaceService(file);
    for (const table of TABLES) {
      const shape = tableShape(file, table);
      expect(shape.find(c => c.name === 'workspace_id')?.pk, table).toBe(1);
      expect(shape.find(c => c.name === 'id')?.pk, table).toBe(2);
    }
    expect(stamp(file)).toBe(String(SCHEMA_VERSION));
    expect(SCHEMA_VERSION).toBe(9);

    // Every row survived, in order, with its original id.
    const back = svc.getWorkspace('ws-a')!;
    expect(keyed(back)).toEqual(keyed({ ...a, sourceMenResults: a.sourceMenResults, sourceWomenResults: a.sourceWomenResults }));

    // The create that used to be a 500: same row ids, a different workspace.
    const copy = { ...workspaceWithRows('ws-b', 'Copy') } as unknown as Workspace;
    svc.createWorkspace(copy);
    expect(keyed(svc.getWorkspace('ws-b')!)).toEqual(keyed(workspaceWithRows('ws-b', 'Copy')));
    expect(keyed(svc.getWorkspace('ws-a')!)).toEqual(keyed(back));
    svc.close();
  });

  it('a second open of a migrated file changes nothing', () => {
    const file = path.join(dir, 'twice.db');
    makeV8File(file, [workspaceWithRows('ws-a', 'Original')]);
    new WorkspaceService(file).close();
    const shapes = TABLES.map(t => tableShape(file, t));
    const svc = new WorkspaceService(file);
    expect(TABLES.map(t => tableShape(file, t))).toEqual(shapes);
    expect(svc.getWorkspace('ws-a')!.menResults).toHaveLength(2);
    svc.close();
  });

  it('an unstamped file with the old key is migrated too (the gate is the key, not the stamp)', () => {
    const file = path.join(dir, 'unstamped.db');
    makeV8File(file, [workspaceWithRows('ws-a', 'Original')]);
    const db = new DatabaseSync(file);
    db.exec("DELETE FROM meta WHERE key = 'schema_version'");
    db.close();
    new WorkspaceService(file).close();
    expect(tableShape(file, 'recruits').find(c => c.name === 'id')?.pk).toBe(2);
    expect(stamp(file)).toBe('9');
  });

  it('migrated tables have the same shape as a fresh v9 database', () => {
    const migrated = path.join(dir, 'migrated.db');
    makeV8File(migrated, [workspaceWithRows('ws-a', 'Original')]);
    new WorkspaceService(migrated).close();
    const fresh = path.join(dir, 'fresh.db');
    new WorkspaceService(fresh).close();
    for (const table of TABLES) {
      expect(tableShape(migrated, table), table).toEqual(tableShape(fresh, table));
    }
  });

  const preV9Copies = () => fsReaddir().filter(f => /-pre-v9-/.test(f));
  const fsReaddir = () => readdirSync(dir);

  /** The v8 file is exactly as it was: old key on every table, stamp 8, no half-built table. */
  function expectV8Intact(file: string, rows: { meet_results: number }) {
    expect(stamp(file)).toBe('8');
    for (const table of TABLES) {
      expect(tableShape(file, table).find(c => c.name === 'id')?.pk, table).toBe(1);
    }
    const check = new DatabaseSync(file);
    const left = check.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__v9'").all();
    const meetRows = check.prepare('SELECT COUNT(*) AS n FROM meet_results').get() as { n: number };
    check.close();
    expect(left).toEqual([]);
    expect(meetRows.n).toBe(rows.meet_results);
  }

  it('writes a VACUUM INTO copy of the v8 file before it rebuilds, and none when nothing is rebuilt', () => {
    const file = path.join(dir, 'v8.db');
    makeV8File(file, [workspaceWithRows('ws-a', 'Original')]);
    new WorkspaceService(file).close();
    const copies = preV9Copies();
    expect(copies).toHaveLength(1);
    const copy = path.join(dir, copies[0]!);
    expect(copies[0]).toMatch(/^v8-pre-v9-\d{8}T\d{6}Z\.db$/);
    // The copy is a whole database in its v8 state: old key, stamp 8, every row.
    expectV8Intact(copy, { meet_results: 3 });
    // The live file moved on.
    expect(stamp(file)).toBe('9');

    // Reopening, and a fresh database, write no copy.
    new WorkspaceService(file).close();
    new WorkspaceService(path.join(dir, 'fresh.db')).close();
    expect(preV9Copies()).toHaveLength(1);
  });

  it('does not migrate, and says which path, when the pre-migration copy cannot be written', () => {
    const file = path.join(dir, 'nocopy.db');
    makeV8File(file, [workspaceWithRows('ws-a', 'Original')]);
    const db = new DatabaseSync(file);
    const target = path.join(dir, 'missing-folder', 'copy.db');
    let caught: (Error & { code?: string }) | undefined;
    try {
      migrateSqliteChildKeys(db, { backupPath: target });
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    db.close();
    expect(caught?.code).toBe(CHILD_KEY_MIGRATION_BACKUP_FAILED_CODE);
    expect(caught?.message).toContain(target);
    expect(caught?.message).toContain('Nothing was changed');
    expectV8Intact(file, { meet_results: 3 });
  });

  it('refuses, naming table, count and workspace id, when a row has no workspace; leaves v8 intact', () => {
    const file = path.join(dir, 'orphan.db');
    makeV8File(file, [workspaceWithRows('ws-a', 'Original')]);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      "INSERT INTO meet_results(id, workspace_id, gender, position, data) VALUES('lost-1', 'ghost-ws', 'Men', 0, '{}')"
    ).run();
    db.close();

    let caught: (Error & { code?: string }) | undefined;
    try {
      new WorkspaceService(file);
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught?.code).toBe(CHILD_KEY_MIGRATION_BLOCKED_CODE);
    expect(caught?.message).toContain('meet_results: 1 row(s) belong to a workspace that does not exist');
    expect(caught?.message).toContain('"ghost-ws"');
    expect(caught?.message).toContain('Restore a backup');
    expectV8Intact(file, { meet_results: 4 });
    // Refused before any copy is written.
    expect(preV9Copies()).toEqual([]);
  });

  it('refuses, naming table and count, when a row has a NULL id; leaves v8 intact', () => {
    const file = path.join(dir, 'nullid.db');
    makeV8File(file, [workspaceWithRows('ws-a', 'Original')]);
    // The v8 key allowed a NULL id (SQLite's historic TEXT PRIMARY KEY quirk). v9 forbids it.
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO recruits(id, workspace_id, position, data) VALUES(NULL, ?, 9, ?)').run('ws-a', '{}');
    db.close();

    let caught: (Error & { code?: string }) | undefined;
    try {
      new WorkspaceService(file);
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught?.code).toBe(CHILD_KEY_MIGRATION_BLOCKED_CODE);
    expect(caught?.message).toContain('recruits: 1 row(s) have a NULL id');
    expect(caught?.message).toContain('"ws-a"');
    expectV8Intact(file, { meet_results: 3 });
    const check = new DatabaseSync(file);
    const kept = check.prepare('SELECT COUNT(*) AS n FROM recruits').get() as { n: number };
    check.close();
    expect(kept.n).toBe(2);
    expect(preV9Copies()).toEqual([]);
  });

  it('rolls back every table already rebuilt when a later step fails, and does not stamp 9', () => {
    const file = path.join(dir, 'midway.db');
    makeV8File(file, [workspaceWithRows('ws-a', 'Original')]);
    // A VIEW squatting on a scratch name makes DROP TABLE IF EXISTS fail AFTER meet_results,
    // source_meet_results and psych_results were rebuilt inside the transaction.
    const db = new DatabaseSync(file);
    db.exec('CREATE VIEW recruits__v9 AS SELECT 1 AS x');
    db.close();

    expect(() => new WorkspaceService(file)).toThrow();
    const check = new DatabaseSync(file);
    check.exec('DROP VIEW recruits__v9');
    check.close();
    expectV8Intact(file, { meet_results: 3 });
  });
});

describe('row ids on the SQLite store, over HTTP', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (open.length) await open.pop()!();
  });

  async function boot() {
    const repo = new SqliteRepo(path.join(dir, 'omniswim.db'), path.join(dir, 'backups'), () => []);
    await repo.init();
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
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    open.push(() => new Promise<void>(r => server.close(() => r())));
    return `http://127.0.0.1:${addr.port}`;
  }
  async function http(url: string, method: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }

  it('creating a copy that reuses every row id is 200 and both workspaces read back intact', async () => {
    const url = await boot();
    const original = workspaceWithRows('orig', 'Original');
    expect((await http(`${url}/api/workspaces`, 'POST', original)).status).toBe(200);

    // Same row ids in every id-keyed collection, a different workspace id, original still present.
    const copy = workspaceWithRows('copy', 'Copy');
    const created = await http(`${url}/api/workspaces`, 'POST', copy);
    expect(created.status).toBe(200);

    const list = (await http(`${url}/api/workspaces`, 'GET')).json as Array<Record<string, unknown>>;
    expect(list.map(w => w.id).sort()).toEqual(['copy', 'orig']);
    for (const w of list) {
      const source = w.id === 'orig' ? original : copy;
      expect(keyed(w), String(w.id)).toEqual(keyed(source));
    }

    // And a later save of the copy still works (the delete-then-insert rewrite).
    const put = await http(`${url}/api/workspaces/copy`, 'PUT', { name: 'Copy renamed' });
    expect(put.status).toBe(200);
    const orig = (await http(`${url}/api/workspaces`, 'GET')).json.find((w: any) => w.id === 'orig');
    expect(keyed(orig)).toEqual(keyed(original));
  });

  it('a row id used twice inside one workspace is a coded 409 that stores nothing', async () => {
    const url = await boot();
    const dup = {
      ...workspaceWithRows('dup', 'Dup'),
      menResults: [
        { id: 'same', name: 'A', gender: 'Men', event: '50 Y Free', time: '21.00' },
        { id: 'same', name: 'B', gender: 'Men', event: '50 Y Free', time: '22.00' },
      ],
    };
    const res = await http(`${url}/api/workspaces`, 'POST', dup);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe(DUPLICATE_ROW_ID_CODE);
    expect(res.json.details ?? res.json.error).toBeTruthy();
    expect((await http(`${url}/api/workspaces`, 'GET')).json).toEqual([]);

    // A Men row and a Women row sharing an id in meet_results is the same conflict.
    const cross = {
      ...workspaceWithRows('cross', 'Cross'),
      menResults: [{ id: 'x', name: 'A', gender: 'Men', event: '50 Y Free', time: '21.00' }],
      womenResults: [{ id: 'x', name: 'B', gender: 'Women', event: '50 Y Free', time: '23.00' }],
    };
    expect((await http(`${url}/api/workspaces`, 'POST', cross)).status).toBe(409);

    // PUT: same rule, and the stored workspace is untouched.
    const ok = workspaceWithRows('keep', 'Keep');
    expect((await http(`${url}/api/workspaces`, 'POST', ok)).status).toBe(200);
    const put = await http(`${url}/api/workspaces/keep`, 'PUT', { menResults: dup.menResults });
    expect(put.status).toBe(409);
    expect(put.json.code).toBe(DUPLICATE_ROW_ID_CODE);
    const after = (await http(`${url}/api/workspaces`, 'GET')).json.find((w: any) => w.id === 'keep');
    expect(keyed(after)).toEqual(keyed(ok));
    expect(after.version).toBe(1);
  });

  it('restoring a snapshot or a backup file that holds a repeated row id is a coded 409, not 404 or 500', async () => {
    const url = await boot();
    const ok = workspaceWithRows('keep', 'Keep');
    expect((await http(`${url}/api/workspaces`, 'POST', ok)).status).toBe(200);
    const dupRows = [
      { id: 'same', name: 'A', gender: 'Men', event: '50 Y Free', time: '21.00' },
      { id: 'same', name: 'B', gender: 'Men', event: '50 Y Free', time: '22.00' },
    ];

    // Snapshot whose stored blob names one row id twice.
    const snap = await http(`${url}/api/workspaces/keep/snapshots`, 'POST', { label: 'before' });
    expect(snap.status).toBe(200);
    const raw = new DatabaseSync(path.join(dir, 'omniswim.db'));
    const blob = JSON.parse((raw.prepare('SELECT blob FROM workspace_snapshots WHERE id = ?').get(snap.json.id) as { blob: string }).blob);
    raw.prepare('UPDATE workspace_snapshots SET blob = ? WHERE id = ?').run(
      JSON.stringify({ ...blob, menResults: dupRows }),
      snap.json.id
    );
    raw.close();
    const restoredSnap = await http(`${url}/api/snapshots/${snap.json.id}/restore`, 'POST');
    expect(restoredSnap.status).toBe(409);
    expect(restoredSnap.json.code).toBe(DUPLICATE_ROW_ID_CODE);

    // Backup file with the same defect.
    const backupDir = path.join(dir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const file = 'meets-manual-2026-01-01T00-00-00-000Z.json';
    writeFileSync(path.join(backupDir, file), JSON.stringify([{ ...workspaceWithRows('keep', 'Keep'), menResults: dupRows }]));
    const restoredFile = await http(`${url}/api/workspaces/restore`, 'POST', { file });
    expect(restoredFile.status).toBe(409);
    expect(restoredFile.json.code).toBe(DUPLICATE_ROW_ID_CODE);

    // Nothing was replaced.
    const after = (await http(`${url}/api/workspaces`, 'GET')).json.find((w: any) => w.id === 'keep');
    expect(keyed(after)).toEqual(keyed(ok));
  });
});
