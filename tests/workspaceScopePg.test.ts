/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL twin of `workspaceScopeRoutes.test.ts` and `workspaceWritePolicy.test.ts`
 * (S3, P1, P2, P3) plus the P7 refusal. Runs only when `PG_TEST_URL` (or
 * `DATABASE_URL`) names a THROWAWAY database; CI sets it on the postgres:16
 * service. Counted in `tests/skip-budget.json`.
 *
 * Isolation: ids are unique per run and removed afterwards; the two tenants get
 * their own users/teams rows (`workspaces.team_id` is a foreign key). The P7 test
 * works in its own throwaway database, so it never stamps the shared `meta` row
 * that other Postgres tests initialise in parallel (it needs CREATE DATABASE, which
 * the CI postgres user has).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import pg from 'pg';
import type { Server } from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import { PgRepo } from '../apps/shell/lib/workspaceRepo';
import { PgWorkspaceService } from '../packages/db/src/PgWorkspaceService';
import { ShareLinkService } from '../packages/db/src/AuthService';
import { PG_SCHEMA_VERSION } from '../packages/db/src/pgSchema';
import { ID_KEYED_CHILD_TABLES } from '../packages/db/src/childKeyMigration';
import type { Workspace } from '../packages/core/src/types';
import { SchemaVersionError } from '../packages/db/src/schemaGuard';
import { EXPECTED_VERSION_HEADER } from '../packages/core/src/api/saveSequence';
import type { ScoringSettings } from '../packages/core/src/types';

const pgUrl = process.env.PG_TEST_URL || process.env.DATABASE_URL;

describe.skipIf(!pgUrl)(
  pgUrl ? 'PostgreSQL workspace scope, write policy, schema guard' : 'PostgreSQL (SKIPPED: set PG_TEST_URL to a throwaway database)',
  () => {
    const run = `${process.pid}-${Date.now().toString(36)}`;
    const A = { userId: `u-pgs-a-${run}`, teamId: `t-pgs-a-${run}` };
    const B = { userId: `u-pgs-b-${run}`, teamId: `t-pgs-b-${run}` };
    const wsA = `ws-pgs-a-${run}`;
    const wsB = `ws-pgs-b-${run}`;
    const wsKeyOrig = `ws-pgk-orig-${run}`;
    const wsKeyCopy = `ws-pgk-copy-${run}`;
    const wsKeyDup = `ws-pgk-dup-${run}`;
    const users: Record<string, { id: string; email: string; displayName: string; teamId: string }> = {
      alice: { id: A.userId, email: `${A.userId}@x.test`, displayName: 'A', teamId: A.teamId },
      bob: { id: B.userId, email: `${B.userId}@x.test`, displayName: 'B', teamId: B.teamId },
    };

    let admin: pg.Pool;
    let dir: string;
    let repo: PgRepo;
    let server: Server;
    let url: string;
    let shareLinks: ShareLinkService;

    async function call(user: string, method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(`${url}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-test-user': user, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    }
    const ws = (id: string, name: string) => ({ id, name, menResults: [], womenResults: [], recruits: [], createdAt: 1 });

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: pgUrl });
      const boot = new PgWorkspaceService({ connectionString: pgUrl as string });
      await boot.init(); // creates the tables
      await boot.close();
      for (const t of [A, B]) {
        await admin.query(
          'INSERT INTO users(id, email, password_hash, display_name, created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING',
          [t.userId, `${t.userId}@x.test`, 'not-a-real-hash', t.userId, Date.now()]
        );
        await admin.query(
          'INSERT INTO teams(id, name, owner_id, created_at) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
          [t.teamId, t.teamId, t.userId, Date.now()]
        );
      }
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-pg-scope-'));
      repo = new PgRepo(pgUrl as string, path.join(dir, 'backups'));
      await repo.init();
      shareLinks = new ShareLinkService(pgUrl as string);

      const withUser: express.RequestHandler = (req, _res, next) => {
        const name = req.headers['x-test-user'];
        if (typeof name === 'string' && users[name]) (req as any).user = users[name];
        next();
      };
      const app = express();
      app.use(express.json({ limit: '50mb' }));
      registerWorkspaceRoutes(app, {
        repo,
        auth: null,
        shareLinks,
        AUTH_REQUIRED: true,
        requireAuth: withUser,
        optionalAuth: withUser,
        defaultScoringSettings: {} as ScoringSettings,
      });
      server = await new Promise(r => {
        const s = app.listen(0, '127.0.0.1', () => r(s));
      });
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      url = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      await new Promise<void>(r => server?.close(() => r()));
      if (admin) {
        await admin.query('DELETE FROM workspaces WHERE id = ANY($1)', [[wsA, wsB, wsKeyOrig, wsKeyCopy, wsKeyDup]]);
        await admin.query('DELETE FROM teams WHERE id = ANY($1)', [[A.teamId, B.teamId]]);
        await admin.query('DELETE FROM users WHERE id = ANY($1)', [[A.userId, B.userId]]);
        await admin.end();
      }
      if (dir) await fsp.rm(dir, { recursive: true, force: true });
    });

    it('S3: two users cannot list, touch, snapshot-read or restore each other data', async () => {
      expect((await call('alice', 'POST', '/api/workspaces', ws(wsA, 'Alice Meet'))).status).toBe(200);
      expect((await call('bob', 'POST', '/api/workspaces', ws(wsB, 'Bob Meet'))).status).toBe(200);

      const lists = await Promise.all(
        Array.from({ length: 20 }, (_, i) => call(i % 2 ? 'bob' : 'alice', 'GET', '/api/workspaces'))
      );
      lists.forEach((r, i) => {
        const mine = (r.json as { id: string }[]).map(w => w.id).filter(id => id === wsA || id === wsB);
        expect(mine).toEqual([i % 2 ? wsB : wsA]);
      });

      const snap = await call('alice', 'POST', `/api/workspaces/${wsA}/snapshots`, { label: 'a' });
      expect(snap.status).toBe(200);
      expect((await call('bob', 'PUT', `/api/workspaces/${wsA}`, { name: 'Hijacked' })).status).toBe(404);
      expect((await call('bob', 'GET', `/api/snapshots/${snap.json.id}`)).status).toBe(404);
      expect((await call('bob', 'POST', `/api/snapshots/${snap.json.id}/restore`)).status).toBe(404);
      expect((await call('bob', 'GET', `/api/workspaces/${wsA}/snapshots`)).json).toEqual([]);
      await call('bob', 'DELETE', `/api/workspaces/${wsA}`);
      expect((await call('alice', 'GET', '/api/workspaces')).json.map((w: any) => w.id)).toContain(wsA);

      // Backups and restore are administrator-only under AUTH_REQUIRED (none is wired).
      expect((await call('bob', 'GET', '/api/workspaces/backups')).status).toBe(403);
      expect((await call('bob', 'POST', '/api/workspaces/restore', { file: 'meets-manual-2026-01-01T00-00-00-000Z.json' })).status).toBe(403);
      expect((await call('alice', 'GET', `/api/snapshots/${snap.json.id}`)).status).toBe(200);
    });

    it('P2: a duplicate id is 409, including another tenant id, and their row keeps its owner', async () => {
      expect((await call('bob', 'POST', '/api/workspaces', { ...ws(wsA, 'Taken Over') })).status).toBe(409);
      expect((await call('alice', 'POST', '/api/workspaces', ws(wsA, 'Again'))).status).toBe(409);
      const row = await admin.query('SELECT name, owner_id, team_id FROM workspaces WHERE id = $1', [wsA]);
      expect(row.rows[0]).toMatchObject({ name: 'Alice Meet', owner_id: A.userId, team_id: A.teamId });
    });

    it('P1: bad patch 400; id, createdAt and version ignored', async () => {
      expect((await call('alice', 'PUT', `/api/workspaces/${wsA}`, { menResults: { nope: 1 } })).status).toBe(400);
      const r = await call('alice', 'PUT', `/api/workspaces/${wsA}`, { id: 'stolen', createdAt: 9, version: 1, name: 'Renamed' });
      expect(r.status).toBe(200);
      expect(r.json.id).toBe(wsA);
      expect(r.json.createdAt).toBe(1);
      expect(r.json.name).toBe('Renamed');
      const ids = await admin.query('SELECT id FROM workspaces WHERE id = ANY($1)', [['stolen']]);
      expect(ids.rows).toHaveLength(0);
    });

    it('P3: a stale expected version is 409 and writes nothing', async () => {
      const cur = (await call('alice', 'GET', '/api/workspaces')).json.find((w: any) => w.id === wsA);
      const v = cur.version as number;
      expect((await call('alice', 'PUT', `/api/workspaces/${wsA}`, { name: 'Tab A' }, { [EXPECTED_VERSION_HEADER]: String(v) })).status).toBe(200);
      const stale = await call('alice', 'PUT', `/api/workspaces/${wsA}`, { name: 'Tab B' }, { [EXPECTED_VERSION_HEADER]: String(v) });
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('VERSION_CONFLICT');
      const after = (await call('alice', 'GET', '/api/workspaces')).json.find((w: any) => w.id === wsA);
      expect(after.name).toBe('Tab A');
      expect(after.version).toBe(v + 1);
    });

    it('P3: two concurrent saves with one expected version cannot both win', async () => {
      const svc = new PgWorkspaceService({ connectionString: pgUrl as string });
      try {
        const id = `ws-pgs-race-${run}`;
        await svc.createWorkspace({ id, name: 'race', menResults: [], womenResults: [], recruits: [], createdAt: 1 } as never, undefined, {
          ownerId: A.userId,
          teamId: A.teamId,
        });
        const scope = { ownerId: A.userId, teamId: A.teamId };
        const outcomes = await Promise.allSettled(
          Array.from({ length: 8 }, (_, i) => svc.updateWorkspace(id, { name: `w${i}` }, 1, scope))
        );
        expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
        for (const o of outcomes) {
          if (o.status === 'rejected') expect((o.reason as { code?: string }).code).toBe('VERSION_CONFLICT');
        }
        expect((await svc.getWorkspaceMeta(id, scope))?.version).toBe(2);
        await svc.deleteWorkspace(id, scope);
      } finally {
        await svc.close();
      }
    });

    it('S3: a share link resolves under its own tenant, not under whoever called last', async () => {
      const made = await call('alice', 'POST', `/api/workspaces/${wsA}/share`, { label: 'Alice report' });
      expect(made.status).toBe(200);
      // Bob's request goes through in between. The old shared-setter code ran the anonymous
      // share read under bob's leftover scope and answered 404.
      await call('bob', 'GET', '/api/workspaces');
      const anon = await fetch(`${url}/api/share/${made.json.token}`);
      expect(anon.status).toBe(200);
      expect(((await anon.json()) as { workspace: { id: string } }).workspace.id).toBe(wsA);

      // A link whose recorded tenant cannot see the workspace must not reach it.
      const forged = await shareLinks.createLink(wsA, B.userId, B.teamId, 'forged');
      const refused = await fetch(`${url}/api/share/${forged.token}`);
      expect(refused.status).toBe(404);
    });

    it('S3: a global replace keeps each existing workspace owner and team', async () => {
      const before = await admin.query('SELECT owner_id, team_id, version FROM workspaces WHERE id = $1', [wsB]);
      const all = await repo.list({});
      const mine = all.filter(w => w.id === wsA || w.id === wsB);
      // Replace only inside a transaction we can verify, using the service the repo wraps.
      const svc = new PgWorkspaceService({ connectionString: pgUrl as string });
      try {
        const everything = await svc.listWorkspaces({});
        await svc.replaceAll(everything);
        const after = await admin.query('SELECT owner_id, team_id, version FROM workspaces WHERE id = $1', [wsB]);
        expect(after.rows[0].owner_id).toBe(before.rows[0].owner_id);
        expect(after.rows[0].team_id).toBe(before.rows[0].team_id);
        expect(Number(after.rows[0].version)).toBe(Number(before.rows[0].version) + 1);
        expect(mine).toHaveLength(2);
      } finally {
        await svc.close();
      }
    });

    // Schema v9: a child-table row id is unique per workspace (key is (workspace_id, id)),
    // not store-wide. Needs CREATE DATABASE, like the P7 test, because it re-keys the tables.
    it('v9: a v8-keyed database is re-keyed, keeps every row, and then accepts reused row ids', async () => {
      const dbName = `omni_v9_${Date.now().toString(36)}_${process.pid}`;
      await admin.query(`CREATE DATABASE ${dbName}`);
      const scopedUrl = new URL(pgUrl as string);
      scopedUrl.pathname = `/${dbName}`;
      const probe = new pg.Pool({ connectionString: scopedUrl.toString() });
      const keyWidths = async () => {
        const out: number[] = [];
        for (const { table } of ID_KEYED_CHILD_TABLES) {
          const r = await probe.query(
            "SELECT array_length(conkey, 1) AS w FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'p'",
            [table]
          );
          out.push(Number(r.rows[0].w));
        }
        return out;
      };
      try {
        const first = new PgWorkspaceService({ connectionString: scopedUrl.toString() });
        await first.init();
        await first.close();
        expect(await keyWidths()).toEqual([2, 2, 2, 2, 2, 2]);

        // Put the database back to its v8 shape: key on id alone, stamped 8, with rows in it.
        for (const { table } of ID_KEYED_CHILD_TABLES) {
          await probe.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey`);
          await probe.query(`ALTER TABLE ${table} ADD PRIMARY KEY (id)`);
        }
        await probe.query("UPDATE meta SET value = '8' WHERE key = 'schema_version'");
        expect(await keyWidths()).toEqual([1, 1, 1, 1, 1, 1]);
        await probe.query("INSERT INTO workspaces(id, name, created_at) VALUES('v9-a', 'A', 1)");
        for (const { table, gender } of ID_KEYED_CHILD_TABLES) {
          if (gender) {
            await probe.query(
              `INSERT INTO ${table}(id, workspace_id, gender, position, data) VALUES($1,'v9-a','Men',0,'{"id":"r1","gender":"Men"}')`,
              [`${table}-r1`]
            );
          } else {
            await probe.query(
              `INSERT INTO ${table}(id, workspace_id, position, data) VALUES($1,'v9-a',0,'{"id":"r1"}')`,
              [`${table}-r1`]
            );
          }
        }

        const svc = new PgWorkspaceService({ connectionString: scopedUrl.toString() });
        try {
          await svc.init();
          expect(await keyWidths()).toEqual([2, 2, 2, 2, 2, 2]);
          const stamp = await probe.query("SELECT value FROM meta WHERE key = 'schema_version'");
          expect(stamp.rows[0].value).toBe(String(PG_SCHEMA_VERSION));
          for (const { table } of ID_KEYED_CHILD_TABLES) {
            const n = await probe.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE workspace_id = 'v9-a'`);
            expect(n.rows[0].n, table).toBe(1);
          }
          // A second init is a no-op.
          await svc.init();
          expect(await keyWidths()).toEqual([2, 2, 2, 2, 2, 2]);

          // The create that used to fail: another workspace, the same row ids.
          const reused = {
            id: 'v9-b',
            name: 'B',
            createdAt: 2,
            menResults: [{ id: 'meet_results-r1', gender: 'Men' }],
            recruits: [{ id: 'recruits-r1' }],
          } as unknown as Workspace;
          await svc.createWorkspace(reused);
          const back = await svc.getWorkspace('v9-b');
          expect(back?.menResults).toHaveLength(1);
          expect(back?.recruits).toHaveLength(1);
          expect((await svc.getWorkspace('v9-a'))?.menResults).toHaveLength(1);
        } finally {
          await svc.close();
        }
      } finally {
        await probe.end();
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      }
    });

    it('v9: creating a copy that reuses every row id is 200; an id used twice in one workspace is a coded 409', async () => {
      const rows = (id: string, name: string) => ({
        id,
        name,
        createdAt: 1,
        menResults: [{ id: 'k-m1', name: 'A', gender: 'Men', event: '50 Y Free', time: '21.00' }],
        womenResults: [{ id: 'k-w1', name: 'B', gender: 'Women', event: '50 Y Free', time: '23.00' }],
        sourceMenResults: [{ id: 'k-m1', name: 'A', gender: 'Men', event: '50 Y Free', time: '21.00' }],
        recruits: [{ id: 'k-rec1', name: 'R' }],
        meetEntryPlans: [{ id: 'k-plan1' }],
        athleteAliases: [{ id: 'k-alias1' }],
      });
      expect((await call('alice', 'POST', '/api/workspaces', rows(wsKeyOrig, 'Original'))).status).toBe(200);
      expect((await call('alice', 'POST', '/api/workspaces', rows(wsKeyCopy, 'Copy'))).status).toBe(200);
      const list = (await call('alice', 'GET', '/api/workspaces')).json as Array<Record<string, unknown[]> & { id: string }>;
      for (const id of [wsKeyOrig, wsKeyCopy]) {
        const w = list.find(x => x.id === id)!;
        expect(w.menResults, id).toHaveLength(1);
        expect(w.womenResults, id).toHaveLength(1);
        expect(w.recruits, id).toHaveLength(1);
        expect(w.meetEntryPlans, id).toHaveLength(1);
        expect(w.athleteAliases, id).toHaveLength(1);
      }

      const dup = {
        ...rows(wsKeyDup, 'Dup'),
        menResults: [
          { id: 'same', name: 'A', gender: 'Men' },
          { id: 'same', name: 'B', gender: 'Men' },
        ],
      };
      const refused = await call('alice', 'POST', '/api/workspaces', dup);
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe('DUPLICATE_ROW_ID');
      const after = (await call('alice', 'GET', '/api/workspaces')).json as Array<{ id: string }>;
      expect(after.some(w => w.id === wsKeyDup)).toBe(false);
    });

    it('P7: a database stamped newer is refused and left untouched (own throwaway database)', async () => {
      // A database of its own: the guard reads and writes `meta`, which every other
      // Postgres test initialises in parallel on the shared database.
      const dbName = `omni_p7_${Date.now().toString(36)}_${process.pid}`;
      await admin.query(`CREATE DATABASE ${dbName}`);
      const scopedUrl = new URL(pgUrl as string);
      scopedUrl.pathname = `/${dbName}`;
      const probe = new pg.Pool({ connectionString: scopedUrl.toString() });
      try {
        const first = new PgWorkspaceService({ connectionString: scopedUrl.toString() });
        await first.init();
        await first.close();
        await probe.query("UPDATE meta SET value = $1 WHERE key = 'schema_version'", [String(PG_SCHEMA_VERSION + 1)]);

        const second = new PgWorkspaceService({ connectionString: scopedUrl.toString() });
        await expect(second.init()).rejects.toBeInstanceOf(SchemaVersionError);
        const stamp = await probe.query("SELECT value FROM meta WHERE key = 'schema_version'");
        expect(stamp.rows[0].value).toBe(String(PG_SCHEMA_VERSION + 1));
      } finally {
        await probe.end();
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      }
    });
  }
);
