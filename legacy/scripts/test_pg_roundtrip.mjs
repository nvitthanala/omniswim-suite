/**
 * PostgreSQL round-trip integrity test — the Postgres twin of
 * `test_sqlite_roundtrip.mjs`, asserting the same fields survive a save/load.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost:5432/omni_test \
 *        npx tsx scripts/test_pg_roundtrip.mjs
 *
 * Needs a live database, so it skips (exit 0) when neither PG_TEST_URL nor
 * DATABASE_URL is set. The always-on structural guard is
 * `test_persistence_parity.mjs`, which needs no database.
 *
 * WARNING: this writes to the target database. Point it at a throwaway one.
 */
import assert from 'node:assert';
import pg from 'pg';
import { PgWorkspaceService } from '../packages/db/src/PgWorkspaceService.ts';

const url = process.env.PG_TEST_URL || process.env.DATABASE_URL;
if (!url) {
  console.log('SKIP  PostgreSQL round-trip test (set PG_TEST_URL to run)');
  process.exit(0);
}

const WS_ID = 'ws-pg-roundtrip-1';

const sample = {
  id: WS_ID,
  name: 'Round Trip Meet',
  createdAt: 1700000000000,
  conference: 'NSISC',
  entryPlanMode: 'overlay',
  scoringSettings: { scoringPoints: [20, 17, 16], relayMultiplier: 2 },
  loadedMeet: { pdfFilename: 'meet.pdf', uploadedAt: 1700000000001, conference: 'NSISC' },
  loadedPsych: { pdfFilename: 'psych.pdf', uploadedAt: 1700000000003 },
  officialTeamScores: { eventThrough: 5, men: { A: 100 }, women: { B: 90 } },
  activeEntryIds: ['e1', 'e2'],
  historySources: [{ type: 'paste', label: 'SwimCloud', importedAt: 1700000000002 }],
  menResults: [
    { id: 'm1', rank: 1, name: 'John Doe', classYear: 'SR', team: 'A', time: '44.10', points: 20, event: '100 Free', gender: 'Men', isRelay: false },
  ],
  womenResults: [
    { id: 'w1', rank: 1, name: 'Jane Roe', classYear: 'JR', team: 'B', time: '48.90', points: 20, event: '100 Free', gender: 'Women', isRelay: false },
  ],
  psychMenResults: [
    {
      id: 'pm1',
      rank: 2,
      name: 'John Doe',
      classYear: 'SR',
      team: 'A',
      time: '44.50',
      points: 0,
      event: '100 Free',
      gender: 'Men',
      isRelay: false,
      roundSwam: 'Psych Sheet',
      isPsychSheet: true,
    },
  ],
  psychWomenResults: [
    {
      id: 'pw1',
      rank: 3,
      name: 'Jane Roe',
      classYear: 'JR',
      team: 'B',
      time: '49.20',
      points: 0,
      event: '100 Free',
      gender: 'Women',
      isRelay: false,
      roundSwam: 'Psych Sheet',
      isPsychSheet: true,
    },
  ],
  recruits: [
    { id: 'r1', name: 'Recruit One', team: 'A', event: '200 Free', time: '1:38.0', gender: 'Men', classYear: 'FR', timeType: 'SCY' },
  ],
  deletedSwimmers: [{ name: 'Gone Swimmer', gender: 'Men' }],
  scorerRosterOverrides: [{ name: 'John Doe', gender: 'Men', isScorer: true }],
  meetEntryPlans: [{ id: 'p1', swimmerName: 'John Doe', event: '100 Free', gender: 'Men' }],
  relayLegOverrides: [{ relayEntryKey: 'k1', legIndex: 0, swimmerName: 'John Doe' }],
  athleteHistory: [{ name: 'John Doe', team: 'A', gender: 'Men', event: '100 Free', time: '44.0', source: 'paste' }],
};

function sortedEqual(a, b, label) {
  const norm = x => JSON.stringify(x);
  assert.strictEqual(norm(a), norm(b), `Mismatch in ${label}`);
}

/**
 * Workspace with no child rows, for the scope checks.
 * Child-table ids (`meet_results.id` et al) are global primary keys, not scoped
 * per workspace, so two workspaces built from `sample` would collide on 'm1'.
 */
const bare = (id, name) => ({
  id,
  name,
  createdAt: 1700000000000,
  menResults: [],
  womenResults: [],
  psychMenResults: [],
  psychWomenResults: [],
  recruits: [],
  deletedSwimmers: [],
  scorerRosterOverrides: [],
  meetEntryPlans: [],
  relayLegOverrides: [],
  athleteHistory: [],
});

let writer;
let reader;
let seedPool;
try {
  writer = new PgWorkspaceService({ connectionString: url });
  await writer.init();
  // Only ever touch this test's own workspace — the database may hold real data.
  await writer.deleteWorkspace(WS_ID);
  await writer.createWorkspace(sample);
  await writer.close();

  // Fresh service + fresh pool, to prove the data is durable rather than cached.
  reader = new PgWorkspaceService({ connectionString: url });
  await reader.init();
  const got = await reader.getWorkspace(WS_ID);
  assert.ok(got, 'workspace not found after reconnect');

  assert.strictEqual(got.name, sample.name, 'name');
  assert.strictEqual(got.conference, sample.conference, 'conference');
  assert.strictEqual(got.createdAt, sample.createdAt, 'createdAt');
  sortedEqual(got.scoringSettings, sample.scoringSettings, 'scoringSettings');
  sortedEqual(got.loadedMeet, sample.loadedMeet, 'loadedMeet');
  sortedEqual(got.officialTeamScores, sample.officialTeamScores, 'officialTeamScores');
  sortedEqual(got.activeEntryIds, sample.activeEntryIds, 'activeEntryIds');
  sortedEqual(got.historySources, sample.historySources, 'historySources');
  sortedEqual(got.menResults, sample.menResults, 'menResults');
  sortedEqual(got.womenResults, sample.womenResults, 'womenResults');
  sortedEqual(got.psychMenResults, sample.psychMenResults, 'psychMenResults');
  sortedEqual(got.psychWomenResults, sample.psychWomenResults, 'psychWomenResults');
  sortedEqual(got.loadedPsych, sample.loadedPsych, 'loadedPsych');
  sortedEqual(got.recruits, sample.recruits, 'recruits');
  sortedEqual(got.deletedSwimmers, sample.deletedSwimmers, 'deletedSwimmers');
  sortedEqual(got.scorerRosterOverrides, sample.scorerRosterOverrides, 'scorerRosterOverrides');
  sortedEqual(got.meetEntryPlans, sample.meetEntryPlans, 'meetEntryPlans');
  sortedEqual(got.relayLegOverrides, sample.relayLegOverrides, 'relayLegOverrides');
  sortedEqual(got.athleteHistory, sample.athleteHistory, 'athleteHistory');

  // An unrelated edit must not drop the psych payload — this is the shape the
  // original Postgres gap took: data written once, silently lost on next save.
  await reader.updateWorkspace(WS_ID, { name: 'Edited Name' });
  const edited = await reader.getWorkspace(WS_ID);
  assert.strictEqual(edited.name, 'Edited Name', 'update name');
  sortedEqual(edited.psychMenResults, sample.psychMenResults, 'psychMenResults after update');
  sortedEqual(edited.psychWomenResults, sample.psychWomenResults, 'psychWomenResults after update');
  sortedEqual(edited.loadedPsych, sample.loadedPsych, 'loadedPsych after update');

  // Snapshot + restore.
  const snap = await reader.createSnapshot(WS_ID, 'before-edit');
  assert.ok(snap, 'snapshot create failed');
  await reader.updateWorkspace(WS_ID, { name: 'Second Edit' });
  await reader.restoreSnapshot(snap.id);
  const restored = await reader.getWorkspace(WS_ID);
  assert.strictEqual(restored.name, 'Edited Name', 'restore name');
  sortedEqual(restored.psychMenResults, sample.psychMenResults, 'psychMenResults after restore');

  // ---- Cross-tenant isolation, mirroring test_workspace_scope.mjs ----
  // Postgres is the multi-user backend, so scope enforcement matters most here.
  //
  // Unlike SQLite, pgSchema declares `workspaces.team_id REFERENCES teams(id)`,
  // so a tenant scope must correspond to real users/teams rows — an arbitrary id
  // trips workspaces_team_id_fkey. Seed the two tenants directly rather than
  // going through AuthService, to keep this test about persistence scoping only.
  const A = 'ws-pg-scope-a';
  const B = 'ws-pg-scope-b';
  seedPool = new pg.Pool({ connectionString: url });
  for (const [userId, teamId] of [
    ['user-pg-scope-a', 'pg-team-a'],
    ['user-pg-scope-b', 'pg-team-b'],
  ]) {
    await seedPool.query(
      `INSERT INTO users(id, email, password_hash, display_name, created_at)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@roundtrip.test`, 'not-a-real-hash', userId, Date.now()]
    );
    await seedPool.query(
      `INSERT INTO teams(id, name, owner_id, created_at)
       VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      [teamId, teamId, userId, Date.now()]
    );
  }

  reader.setScope({});
  await reader.deleteWorkspace(A);
  await reader.deleteWorkspace(B);

  reader.setScope({ teamId: 'pg-team-a' });
  await reader.createWorkspace(bare(A, 'Alpha Meet'));
  const snapA = await reader.createSnapshot(A, 'alpha-snapshot');
  assert.ok(snapA, 'tenant A could not snapshot its own workspace');

  reader.setScope({ teamId: 'pg-team-b' });
  await reader.createWorkspace(bare(B, 'Bravo Meet'));

  assert.strictEqual(await reader.getWorkspace(A), undefined, 'B could read A workspace');
  assert.strictEqual(await reader.getWorkspaceMeta(A), undefined, 'B could read A version metadata');
  assert.strictEqual(
    await reader.updateWorkspace(A, { name: 'Hijacked' }),
    undefined,
    'B could update A'
  );
  assert.deepStrictEqual(await reader.listSnapshots(A), [], 'B could enumerate A snapshots');
  assert.strictEqual(await reader.restoreSnapshot(snapA.id), undefined, 'B could restore an A snapshot');
  assert.strictEqual(await reader.createSnapshot(A, 'stolen'), undefined, 'B could snapshot A');
  assert.deepStrictEqual(
    (await reader.listWorkspaces()).map(w => w.id),
    [B],
    'B listing leaked A workspace'
  );

  await reader.deleteWorkspace(A);
  reader.setScope({ teamId: 'pg-team-a' });
  const survivor = await reader.getWorkspace(A);
  assert.ok(survivor, 'CROSS-TENANT DELETE: B destroyed A workspace');
  assert.strictEqual(survivor.name, 'Alpha Meet', 'A workspace was mutated by B');

  reader.setScope({});
  await reader.deleteWorkspace(A);
  await reader.deleteWorkspace(B);
  await reader.deleteWorkspace(WS_ID);
  // Workspaces first: teams/users are only removable once nothing references them.
  await seedPool.query("DELETE FROM teams WHERE id IN ('pg-team-a','pg-team-b')");
  await seedPool.query("DELETE FROM users WHERE id IN ('user-pg-scope-a','user-pg-scope-b')");
  await seedPool.end();
  await reader.close();
  console.log('PostgreSQL round-trip test PASSED');
} catch (err) {
  console.error('PostgreSQL round-trip test FAILED:', err.message);
  for (const closable of [writer, reader]) {
    try {
      await closable?.close();
    } catch {
      /* pool already closed */
    }
  }
  try {
    await seedPool?.end();
  } catch {
    /* pool already closed */
  }
  process.exit(1);
}
