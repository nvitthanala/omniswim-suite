/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Event-identity + merged/pdf_only scoring tests.
 * Run: npx tsx scripts/test_event_identity_scoring.mjs
 *
 * Covers:
 *  - canonicalProgramEvent HyTek<->canonical incl. gender markers, relay/diving/100 IM.
 *  - buildMeetEventLabelIndex dedup rule (most rows, then lowest event number).
 *  - merged mode: a canonical planned entry lands in the loaded meet's real event
 *    group and displaces field points.
 *  - pdf_only mode: totals equal PDF-base scoring (plans/recruits excluded).
 *  - roster-only workspace (no meet loaded): merged mode is unchanged (canonical labels).
 *  - visibleEvents filtering (relays/diving kept; 25s/100 IM/time trials/unmatched
 *    canonicals hidden) with team totals invariant.
 */
import assert from 'node:assert/strict';
import {
  buildMeetEventLabelIndex,
  canonicalProgramEvent,
} from '../packages/core/src/lib/eventIdentity.ts';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection.ts';
import { buildScoringBundle } from '../packages/core/src/lib/scoringEngine.ts';
import { calculatePoints } from '../packages/core/src/lib/utils.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;

const SETTINGS = {
  scoringPoints: [5, 3, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'event',
  relayEligibleFromScorerPool: false,
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 3,
  maxRelayEntriesPerSwimmer: 4,
};

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

function result(id, name, team, event, time, extra = {}) {
  return {
    id,
    rank: 0,
    name,
    classYear: 'JR',
    team,
    time,
    points: 0,
    event,
    gender: MEN,
    isRelay: false,
    ...extra,
  };
}

function baseWorkspace(overrides = {}) {
  return {
    id: 'ws',
    name: 'Test',
    createdAt: Date.now(),
    menResults: [],
    womenResults: [],
    recruits: [],
    scoringSettings: SETTINGS,
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    scorerRosterOverrides: [],
    ...overrides,
  };
}

function bundle(ws, applyWhatIf = true) {
  return buildScoringBundle({
    workspace: ws,
    gender: MEN,
    removeSeniors: false,
    applyWhatIf,
    scorerRosterOverrides: ws.scorerRosterOverrides ?? [],
  });
}

function teamTotals(sortedTeams) {
  return Object.fromEntries(sortedTeams.map(t => [t.teamName, t.totalPoints]));
}

// --- (1) canonicalProgramEvent: HyTek/canonical + gender markers + rejects ---
{
  assert.equal(canonicalProgramEvent('Event 24 Men 100 Yard Backstroke'), '100 Backstroke');
  assert.equal(canonicalProgramEvent('Event 24 Women 100 Yard Backstroke'), '100 Backstroke');
  assert.equal(canonicalProgramEvent('100 Backstroke'), '100 Backstroke');
  assert.equal(canonicalProgramEvent('Event 6 Men 200 Yard IM'), '200 Individual Medley');
  assert.equal(canonicalProgramEvent('Event 11 Men 200 Yard Medley Relay'), null);
  assert.equal(canonicalProgramEvent('Event 9 Men 1 mtr Diving'), null);
  assert.equal(canonicalProgramEvent('Event 30 Men 25 Yard Freestyle'), null);
  assert.equal(canonicalProgramEvent('100 Individual Medley'), null);
  ok('canonicalProgramEvent maps HyTek/canonical, strips gender, rejects relay/diving/25/100 IM');
}

// --- (2) buildMeetEventLabelIndex dedup: most rows, then lowest event number ---
{
  // Finals (Event 24, 3 rows) beats prelims (Event 23, 2 rows) on row count.
  const rows = [
    result('p1', 'A', 'Beta', 'Event 23 Men 100 Yard Backstroke', '50.0'),
    result('p2', 'B', 'Beta', 'Event 23 Men 100 Yard Backstroke', '51.0'),
    result('f1', 'A', 'Beta', 'Event 24 Men 100 Yard Backstroke', '49.5'),
    result('f2', 'B', 'Beta', 'Event 24 Men 100 Yard Backstroke', '50.5'),
    result('f3', 'C', 'Beta', 'Event 24 Men 100 Yard Backstroke', '51.5'),
    result('d1', 'D', 'Beta', 'Event 11 Men 200 Yard Medley Relay', '1:30.0', { isRelay: true }),
    result('t1', 'E', 'Beta', 'Event 40 Men 50 Yard Freestyle', '20.0', { isTimeTrial: true }),
  ];
  const idx = buildMeetEventLabelIndex(rows);
  assert.equal(idx.get('100 Backstroke'), 'Event 24 Men 100 Yard Backstroke', 'most rows wins');
  assert.equal(idx.has('50 Freestyle'), false, 'time-trial-only rows never become a target');
  assert.equal([...idx.keys()].length, 1, 'relays contribute no canonical target');

  // Tie on row count -> lowest event number wins.
  const tie = [
    result('a1', 'A', 'Beta', 'Event 23 Men 100 Yard Backstroke', '50.0'),
    result('a2', 'B', 'Beta', 'Event 23 Men 100 Yard Backstroke', '51.0'),
    result('b1', 'C', 'Beta', 'Event 24 Men 100 Yard Backstroke', '49.0'),
    result('b2', 'D', 'Beta', 'Event 24 Men 100 Yard Backstroke', '52.0'),
  ];
  assert.equal(
    buildMeetEventLabelIndex(tie).get('100 Backstroke'),
    'Event 23 Men 100 Yard Backstroke',
    'row-count tie -> lowest event number wins'
  );
  ok('buildMeetEventLabelIndex dedup: most rows, then lowest event number');
}

// --- (3) merged: a canonical planned entry lands in the real meet group + displaces ---
// --- (4) pdf_only: totals equal PDF-base scoring on the SAME workspace ---
{
  const ws = baseWorkspace({
    menResults: [
      result('b1', 'Beta One', 'Beta', 'Event 24 Men 100 Yard Backstroke', '50.00', { rank: 1, roundSwam: 'A Final' }),
      result('b2', 'Beta Two', 'Beta', 'Event 24 Men 100 Yard Backstroke', '51.00', { rank: 2, roundSwam: 'A Final' }),
      result('b3', 'Beta Three', 'Beta', 'Event 24 Men 100 Yard Backstroke', '52.00', { rank: 3, roundSwam: 'A Final' }),
    ],
    meetEntryPlans: [
      // Canonical label; a fast time that should place first in the loaded field.
      { id: 'a1-bk', name: 'Alpha One', team: 'Alpha', gender: MEN, classYear: 'JR', event: '100 Backstroke', time: '49.00', timeType: 'SCY', source: 'optimizer', active: true },
    ],
    activeEntryIds: ['a1-bk'],
  });

  // MERGED (default): plan remapped into "Event 24 Men 100 Yard Backstroke".
  const merged = bundle(ws);
  assert.ok(merged.events.includes('Event 24 Men 100 Yard Backstroke'), 'real meet event present');
  assert.ok(!merged.events.includes('100 Backstroke'), 'no phantom canonical event group');
  const mt = teamTotals(merged.sortedTeams);
  // Projected order 49/50/51/52 -> Alpha 5, Beta 3+1+0 = 4.
  assert.equal(mt['Alpha'], 5, 'planned entry scores first in the merged field');
  assert.equal(mt['Beta'], 4, 'field points displaced by the inserted entry');

  // PDF_ONLY: plan excluded -> pure loaded-meet scoring (Beta 5+3+1 = 9, no Alpha).
  const wsPdf = { ...ws, scoringView: 'pdf_only' };
  const pdf = bundle(wsPdf);
  const pt = teamTotals(pdf.sortedTeams);
  const control = calculatePoints(ws.menResults, mergeScoringSettings(SETTINGS), {
    scorerRosterOverrides: [],
    resultsForPdfHint: ws.menResults,
  }).reduce((m, r) => {
    const t = String(r.team ?? '').trim();
    m[t] = (m[t] ?? 0) + (typeof r.points === 'number' ? r.points : 0);
    return m;
  }, {});
  assert.equal(pt['Beta'], control['Beta'], 'pdf_only Beta total equals PDF-base scoring');
  assert.equal(pt['Beta'], 9, 'PDF-base Beta total');
  assert.equal(pt['Alpha'], undefined, 'pdf_only excludes the planned Alpha entry');
  ok('merged remaps planned entry into real meet group; pdf_only equals PDF-base scoring');
}

// --- (5) roster-only workspace (no meet loaded): merged is unchanged (canonical labels) ---
{
  const ws = baseWorkspace({
    // No meet results at all -> label index empty -> remap is a no-op.
    meetEntryPlans: [
      { id: 'p-bk', name: 'HSU Swimmer', team: 'HSU', gender: MEN, classYear: 'JR', event: '100 Backstroke', time: '48.00', timeType: 'SCY', source: 'optimizer', active: true },
      { id: 'p-fr', name: 'HSU Swimmer', team: 'HSU', gender: MEN, classYear: 'JR', event: '50 Freestyle', time: '20.00', timeType: 'SCY', source: 'optimizer', active: true },
    ],
    activeEntryIds: ['p-bk', 'p-fr'],
  });
  const rows = buildWhatIfResults({ workspace: ws, gender: MEN, removeSeniors: false });
  const events = new Set(rows.map(r => r.event));
  assert.ok(events.has('100 Backstroke'), 'canonical label preserved (roster-only)');
  assert.ok(events.has('50 Freestyle'), 'canonical label preserved (roster-only)');
  assert.ok(![...events].some(e => /Event\s+\d+/i.test(e)), 'no meet remapping when no meet loaded');
  ok('roster-plan-only workspace: merged mode unchanged (canonical labels, no remap)');
}

// --- (6) visibleEvents filtering with team totals invariant ---
{
  const ws = baseWorkspace({
    menResults: [
      // program individual (visible)
      result('bk1', 'Beta One', 'Beta', 'Event 24 Men 100 Yard Backstroke', '50.00', { rank: 1, roundSwam: 'A Final' }),
      result('bk2', 'Alpha One', 'Alpha', 'Event 24 Men 100 Yard Backstroke', '51.00', { rank: 2, roundSwam: 'A Final' }),
      // relay (visible)
      result('mr1', 'Beta', 'Beta', 'Event 11 Men 200 Yard Medley Relay', '1:30.00', { rank: 1, roundSwam: 'A Final', isRelay: true }),
      // diving (visible)
      result('dv1', 'Beta Diver', 'Beta', 'Event 9 Men 1 mtr Diving', '350.00', { rank: 1, roundSwam: 'A Final' }),
      // 25 free (hidden - non-program)
      result('tw1', 'Beta Two', 'Beta', 'Event 30 Men 25 Yard Freestyle', '10.00', { rank: 1, roundSwam: 'A Final' }),
      // 100 IM (hidden - non-program)
      result('im1', 'Beta Three', 'Beta', 'Event 31 Men 100 Yard Individual Medley', '52.00', { rank: 1, roundSwam: 'A Final' }),
      // time trial (hidden)
      result('tt1', 'Beta Four', 'Beta', 'Event 40 Men 50 Yard Freestyle', '20.00', { rank: 1, roundSwam: 'A Final', isTimeTrial: true }),
    ],
    // Recruit in an event the meet lacks -> unmatched canonical (hidden when meet loaded).
    recruits: [
      { id: 'r-fly', name: 'Alpha Recruit', team: 'Alpha', gender: MEN, classYear: 'FR', event: '200 Butterfly', time: '1:45.00', timeType: 'SCY' },
    ],
  });

  const b = bundle(ws);
  const vis = new Set(b.visibleEvents);
  assert.ok(vis.has('Event 24 Men 100 Yard Backstroke'), 'program event visible');
  assert.ok(vis.has('Event 11 Men 200 Yard Medley Relay'), 'relay visible');
  assert.ok(vis.has('Event 9 Men 1 mtr Diving'), 'diving visible');
  assert.ok(!vis.has('Event 30 Men 25 Yard Freestyle'), '25-yard event hidden');
  assert.ok(!vis.has('Event 31 Men 100 Yard Individual Medley'), '100 IM hidden');
  assert.ok(!vis.has('Event 40 Men 50 Yard Freestyle'), 'time-trial event hidden');
  assert.ok(!vis.has('200 Butterfly'), 'unmatched canonical (recruit-only) hidden when meet loaded');
  assert.ok(b.events.includes('200 Butterfly'), 'unmatched canonical still present in full events list');

  // Totals invariant: scoring ran over the full `events` set, never `visibleEvents`.
  // The hidden 25/100 IM events carry points, so a visible-only sum is strictly
  // smaller — proving visibility filtering did not drop any points from scoring.
  const fullPoints = b.allScored.reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
  const visiblePoints = b.allScored
    .filter(r => vis.has(r.event))
    .reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
  assert.ok(fullPoints > visiblePoints, 'hidden events still carry scored points (visibility is presentational)');

  // The scoreboard is unchanged whether or not the bundle exposes visibleEvents:
  // re-scoring the same what-if results reproduces the sortedTeams totals exactly.
  const rescored = calculatePoints(b.allResults, mergeScoringSettings(SETTINGS, { conference: ws.conference }), {
    scorerRosterOverrides: [],
    resultsForPdfHint: [...ws.menResults, ...ws.womenResults],
  });
  const rescoreByTeam = {};
  for (const r of rescored) {
    const tName = String(r.name ?? '').trim().toLowerCase();
    const tTeam = String(r.team ?? '').trim().toLowerCase();
    if (tName && tTeam === tName) continue; // mirror the relay team-name skip
    const key = String(r.team ?? 'Unknown').trim() || 'Unknown';
    rescoreByTeam[key] = (rescoreByTeam[key] ?? 0) + (typeof r.points === 'number' ? r.points : 0);
  }
  for (const t of b.sortedTeams) {
    assert.ok(
      Math.abs((rescoreByTeam[t.teamName] ?? 0) - t.totalPoints) < 1e-9,
      `sortedTeams total for ${t.teamName} unaffected by visibility filtering`
    );
  }
  ok('visibleEvents hides 25s/100 IM/TT/unmatched canonicals, keeps relays/diving, totals invariant');
}

console.log(`\nevent-identity scoring tests passed (${n} groups)`);
