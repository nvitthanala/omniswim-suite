/**
 * SQLite round-trip integrity test.
 * Run: npx tsx scripts/test_sqlite_roundtrip.mjs
 *
 * Writes a synthetic workspace with every collection populated, reads it back
 * from a fresh service instance, and deep-compares. Exits non-zero on mismatch.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { WorkspaceService } from '../packages/db/src/WorkspaceService.ts';

const tmp = path.join(os.tmpdir(), `omni-roundtrip-${Date.now()}.db`);

function cleanup() {
  for (const s of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${tmp}${s}`);
    } catch {
      /* ignore */
    }
  }
}

const sample = {
  id: 'ws-test-1',
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
  psychWomenResults: [],
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

try {
  const service = new WorkspaceService(tmp);
  service.createWorkspace(sample);
  service.close();

  // Re-open from disk (fresh instance) to prove durability.
  const reopened = new WorkspaceService(tmp);
  const got = reopened.getWorkspace('ws-test-1');
  assert.ok(got, 'workspace not found after reopen');

  assert.strictEqual(got.name, sample.name, 'name');
  assert.strictEqual(got.conference, sample.conference, 'conference');
  assert.strictEqual(got.createdAt, sample.createdAt, 'createdAt');
  sortedEqual(got.scoringSettings, sample.scoringSettings, 'scoringSettings');
  sortedEqual(got.officialTeamScores, sample.officialTeamScores, 'officialTeamScores');
  sortedEqual(got.activeEntryIds, sample.activeEntryIds, 'activeEntryIds');
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

  // Snapshot + update + restore.
  const snap = reopened.createSnapshot('ws-test-1', 'before-edit');
  assert.ok(snap, 'snapshot create failed');
  reopened.updateWorkspace('ws-test-1', { name: 'Edited Name' });
  assert.strictEqual(reopened.getWorkspace('ws-test-1').name, 'Edited Name', 'update name');
  reopened.restoreSnapshot(snap.id);
  assert.strictEqual(
    reopened.getWorkspace('ws-test-1').name,
    'Round Trip Meet',
    'restore name'
  );

  reopened.close();
  console.log('SQLite round-trip test PASSED');
} catch (err) {
  console.error('SQLite round-trip test FAILED:', err.message);
  cleanup();
  process.exit(1);
}
cleanup();
