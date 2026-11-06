/**
 * Workspace scope-isolation test.
 * Run: npx tsx scripts/test_workspace_scope.mjs
 *
 * `setScope()` is what separates tenants in a shared deployment: the server calls
 * it from `applyRepoScope(req)` before every workspace route. Any service method
 * that takes a workspace id and ignores the scope is a cross-tenant hole — most
 * severely `deleteWorkspace`, where it means one tenant can destroy another's data.
 *
 * This drives the SQLite service (no external database needed, so it always runs)
 * through the id-addressable methods as a second tenant and asserts each one
 * refuses. `test_pg_roundtrip.mjs` makes the same assertions against Postgres.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { WorkspaceService } from '../packages/db/src/WorkspaceService.ts';

const tmp = path.join(os.tmpdir(), `omni-scope-${process.pid}.db`);

function cleanup() {
  for (const s of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${tmp}${s}`);
    } catch {
      /* ignore */
    }
  }
}

const ws = (id, name) => ({
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

try {
  const svc = new WorkspaceService(tmp);

  // Two tenants, one workspace each.
  svc.setScope({ teamId: 'team-a' });
  svc.createWorkspace(ws('ws-a', 'Alpha Meet'));
  const snapA = svc.createSnapshot('ws-a', 'alpha-snapshot');
  assert.ok(snapA, 'tenant A could not snapshot its own workspace');

  svc.setScope({ teamId: 'team-b' });
  svc.createWorkspace(ws('ws-b', 'Bravo Meet'));

  // ---- Tenant B must not see or touch tenant A's workspace ----
  assert.strictEqual(svc.getWorkspace('ws-a'), undefined, 'B could read A workspace');
  assert.strictEqual(svc.getWorkspaceMeta('ws-a'), undefined, 'B could read A version metadata');
  assert.strictEqual(svc.updateWorkspace('ws-a', { name: 'Hijacked' }), undefined, 'B could update A');
  assert.deepStrictEqual(svc.listSnapshots('ws-a'), [], 'B could enumerate A snapshots');
  assert.strictEqual(svc.restoreSnapshot(snapA.id), undefined, 'B could restore an A snapshot');
  assert.strictEqual(svc.createSnapshot('ws-a', 'stolen'), undefined, 'B could snapshot A');

  assert.strictEqual(svc.count(), 1, 'B sees the wrong number of workspaces');
  assert.deepStrictEqual(
    svc.listWorkspaces().map(w => w.id),
    ['ws-b'],
    'B listing leaked A workspace'
  );

  // The destructive one: a delete from B must leave A's workspace intact.
  svc.deleteWorkspace('ws-a');
  svc.setScope({ teamId: 'team-a' });
  const survivor = svc.getWorkspace('ws-a');
  assert.ok(survivor, 'CROSS-TENANT DELETE: B destroyed A workspace');
  assert.strictEqual(survivor.name, 'Alpha Meet', 'A workspace was mutated by B');

  // A still owns its own snapshot after B tried to touch it.
  assert.strictEqual(svc.listSnapshots('ws-a').length, 1, 'A lost its snapshot');

  // ---- A tenant retains full control of its own workspace ----
  assert.ok(svc.updateWorkspace('ws-a', { name: 'Renamed' }), 'A could not update its own workspace');
  assert.strictEqual(svc.getWorkspace('ws-a').name, 'Renamed', 'A update did not apply');
  svc.deleteWorkspace('ws-a');
  assert.strictEqual(svc.getWorkspace('ws-a'), undefined, 'A could not delete its own workspace');

  // ---- Unscoped (local single-user) behaviour is unchanged ----
  svc.setScope({});
  svc.createWorkspace(ws('ws-local', 'Local Meet'));
  assert.ok(svc.getWorkspace('ws-local'), 'unscoped read broke');
  assert.ok(svc.getWorkspaceMeta('ws-local'), 'unscoped meta read broke');
  const snapLocal = svc.createSnapshot('ws-local', 'local-snap');
  assert.strictEqual(svc.listSnapshots('ws-local').length, 1, 'unscoped snapshot listing broke');
  assert.ok(svc.restoreSnapshot(snapLocal.id), 'unscoped restore broke');
  svc.deleteWorkspace('ws-local');
  assert.strictEqual(svc.getWorkspace('ws-local'), undefined, 'unscoped delete broke');

  svc.close();
  console.log('Workspace scope-isolation test PASSED');
} catch (err) {
  console.error('Workspace scope-isolation test FAILED:', err.message);
  cleanup();
  process.exit(1);
}
cleanup();
