/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards the ONE ENTRY PER DISTINCT EVENT, REGARDLESS OF ROUND rule in
 * per-swimmer entry-limit counting.
 *
 * THE BUG: a swimmer who swims prelims and then swims the final of that same
 * event used ONE meet entry. `countSwimmerEntries` keyed relay entries on
 * `relayEntryKey`, which is `team|event|roundSwam|rank|clock`. That key names one
 * physical relay SWIM — the right identity for landing a leg override on the
 * correct heat, the wrong one for a cap. A squad that swims a relay in prelims
 * and again in the final produces two rows whose round, rank and clock all
 * differ, so every leg swimmer was charged TWO entries for ONE relay:
 *
 *     3 individual + 4 relays, each relay swum prelims + final
 *       counted   3 ind + 8 relay = 11 of 7   OVER CAP (false)
 *       actual    3 ind + 4 relay =  7 of 7   at the cap
 *
 * Under the NSISC cap of 7 that reports a compliant swimmer as over-entered, and
 * the "N/7 total" label the coach reads is wrong by the number of relays the
 * squad qualified through prelims. The individual side already keyed on the
 * event alone and was already correct; this fixture pins both.
 *
 * THE FIX: `entryCapKey(r)` — the trimmed event, for individual and relay rows
 * alike. `countSwimmerEntries` uses it on both branches, so every consumer of
 * the counts (`formatEntryLimitLabel`, `swimmerExceedsEntryLimits`,
 * `canAcceptAnotherEntry`, `buildTeamLineupAudit`, `scoringTheory`, arbitrage)
 * inherits the corrected number.
 *
 * NOT "count prelims only": a prelims-only swim (missed the final) and a
 * timed-final-only swim are each still one entry. Blocks 3 and 4 pin that, so a
 * literal prelims filter cannot pass this file.
 *
 * Test: npx tsx scripts/test_entry_limits_prelims_finals.mjs
 */
import assert from 'node:assert/strict';
import {
  canAcceptAnotherEntry,
  countSwimmerEntries,
  entryCapKey,
  formatEntryLimitLabel,
  swimmerExceedsEntryLimits,
} from '../packages/core/src/lib/swimmerEntryLimits.ts';
import { buildTeamLineupAudit } from '../packages/core/src/lib/rosterLineupAudit.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const TEAM = 'Henderson State University';
const SWIMMER = 'Colin Candebat';

/** NSISC: total-only cap of 7 entries per swimmer, any individual/relay mix. */
const NSISC = mergeScoringSettings({}, { conference: 'NSISC Championship' });
assert.equal(NSISC.maxTotalEntriesPerSwimmer, 7, 'fixture depends on the NSISC total cap being 7');

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} — ${msg}`);
};

/** One individual swim row. */
function ind(id, event, roundSwam, extra = {}) {
  return {
    id,
    rank: 4,
    name: SWIMMER,
    classYear: 'JR',
    team: TEAM,
    time: '48.10',
    points: 0,
    event,
    gender: MEN,
    isRelay: false,
    roundSwam,
    ...extra,
  };
}

/**
 * One relay LEG row, as the PDF parser emits it. The parser keys relay rows on
 * `(school, event, gender, round, finals_time, rank)`, so a relay contested in
 * prelims AND in the final really does reach the counter as two rows.
 */
function relayLeg(id, event, roundSwam, rank, clock, extra = {}) {
  return {
    id,
    rank,
    name: SWIMMER,
    classYear: 'JR',
    team: TEAM,
    time: clock,
    relayTeamTime: clock,
    finalsTime: clock,
    points: 0,
    event,
    gender: MEN,
    isRelay: true,
    relayLegIndex: 0,
    roundSwam,
    relayNames: [{ name: SWIMMER, year: 'JR' }],
    ...extra,
  };
}

const IND_EVENTS = [
  'Event 8 Men 50 Yard Freestyle',
  'Event 24 Men 100 Yard Backstroke',
  'Event 35 Men 100 Yard Freestyle',
];
const RELAY_EVENTS = [
  'Event 11 Men 4x50 Yard Medley Relay',
  'Event 20 Men 4x100 Yard Medley Relay',
  'Event 31 Men 4x50 Yard Freestyle Relay',
  'Event 42 Men 4x100 Yard Freestyle Relay',
];

// ============================================================================
// BLOCK 1 — THE REGRESSION. Three individual events and four relays, every one
// of them swum in prelims and again in the final: 7 entries, at the cap.
// ============================================================================

const TWO_ROUND = [
  ...IND_EVENTS.flatMap((event, i) => [
    ind(`i${i}-pre`, event, 'Preliminaries', { rank: 9, time: '48.90', prelimsTime: '48.90' }),
    ind(`i${i}-fin`, event, 'A Final', { rank: 4, time: '48.10', prelimsTime: '48.90', finalsTime: '48.10' }),
  ]),
  ...RELAY_EVENTS.flatMap((event, i) => [
    relayLeg(`r${i}-pre`, event, 'Preliminaries', 5, '1:32.10'),
    relayLeg(`r${i}-fin`, event, 'A Final', 2, '1:31.44'),
  ]),
];

{
  assert.equal(TWO_ROUND.length, 14, 'fixture is 14 rows — 7 entries each swum twice');

  const counts = countSwimmerEntries(TWO_ROUND, TEAM, MEN, SWIMMER);
  assert.equal(counts.individual, 3, 'three individual events, not six rows');
  assert.equal(counts.relayCount, 4, 'THE BUG: four relays, not eight — prelims + final is one entry');
  assert.equal(counts.total, 7, 'seven entries total');
  assert.equal(
    counts.relayEvents.size,
    counts.relayCount,
    'relayCount still tracks the relayEvents set'
  );

  const over = swimmerExceedsEntryLimits(counts, NSISC);
  assert.equal(over.totalOver, false, 'a swimmer AT the cap is not over it');
  assert.equal(over.individualOver, false, 'no per-type individual violation');
  assert.equal(over.relayOver, false, 'no per-type relay violation');

  assert.equal(
    formatEntryLimitLabel(counts, NSISC),
    '7/7 total (3 ind · 4 relay)',
    'the label a coach reads counts each event once'
  );

  assert.equal(
    canAcceptAnotherEntry(counts, NSISC, 'Event 6 Men 200 Yard IM'),
    false,
    'a swimmer at exactly 7 still cannot take an 8th entry'
  );

  ok('prelims + final of the same event is ONE entry — 3 ind + 4 relay = 7/7, not 11/7');
}

// ============================================================================
// BLOCK 2 — the same rule reaches the lineup audit, which is what puts the
// "over entry limit" badge and checklist row in front of the coach.
// ============================================================================

const workspaceOf = rows => ({
  id: 'entry-cap-ws',
  name: 'Entry cap regression',
  createdAt: 0,
  conference: 'NSISC Championship',
  menResults: rows,
  womenResults: [],
});

const auditOf = rows =>
  buildTeamLineupAudit({
    workspace: workspaceOf(rows),
    gender: MEN,
    team: TEAM,
    settings: NSISC,
    allResults: rows,
    allScored: rows,
    removeSeniors: false,
    detectDuplicates: false,
  });

const entryLimitItems = audit => audit.checklistItems.filter(i => i.type === 'over_entry_limit');

{
  const audit = auditOf(TWO_ROUND);
  assert.equal(
    entryLimitItems(audit).length,
    0,
    'no entry-limit checklist item for a swimmer at exactly the cap'
  );
  const issues = audit.athleteIssues.get('colin candebat') ?? [];
  assert.equal(
    issues.filter(i => i.type === 'over_entry_limit').length,
    0,
    'no over_entry_limit badge on the roster row either'
  );

  // The audit must still fire on a GENUINE violation — an 8th distinct event.
  const overRows = [...TWO_ROUND, ind('i9', 'Event 6 Men 200 Yard IM', 'A Final')];
  const overCounts = countSwimmerEntries(overRows, TEAM, MEN, SWIMMER);
  assert.equal(overCounts.total, 8, 'an 8th distinct event is an 8th entry');
  assert.equal(
    swimmerExceedsEntryLimits(overCounts, NSISC).totalOver,
    true,
    'eight entries trips the NSISC total cap'
  );
  const overAudit = auditOf(overRows);
  assert.equal(
    entryLimitItems(overAudit).length,
    1,
    'the audit still reports a real over-entry — the fix is not a blanket suppression'
  );
  assert.match(
    entryLimitItems(overAudit)[0].message,
    /over total entry limit/,
    'and names the total cap'
  );

  ok('buildTeamLineupAudit inherits the rule: clean at 7, still flags a real 8');
}

// ============================================================================
// BLOCK 3 — a prelims-only swim is still ONE entry. A literal "count prelims,
// ignore finals" filter would pass block 1 and fail nothing else, so this block
// and block 4 exist to make that shortcut fail.
// ============================================================================
{
  const prelimsOnly = [
    ind('po-i', 'Event 8 Men 50 Yard Freestyle', 'Preliminaries', { rank: 21, prelimsTime: '22.90' }),
    relayLeg('po-r', 'Event 11 Men 4x50 Yard Medley Relay', 'Preliminaries', 12, '1:35.80'),
  ];
  const counts = countSwimmerEntries(prelimsOnly, TEAM, MEN, SWIMMER);
  assert.equal(counts.individual, 1, 'a swimmer who missed the final still spent an individual entry');
  assert.equal(counts.relayCount, 1, 'a relay that missed the final still spent a relay entry');
  assert.equal(counts.total, 2, 'two entries');
  ok('prelims-only swims (no final) each still count as one entry');
}

// ============================================================================
// BLOCK 4 — a timed-final / finals-only swim, which has no prelims round at
// all, is also ONE entry.
// ============================================================================
{
  const finalsOnly = [
    // Distance timed final: HyTek labels it "Finals" with no prelims row.
    ind('fo-i', 'Event 4 Men 1000 Yard Freestyle', 'Finals', { rank: 3, finalsTime: '9:41.20' }),
    ind('fo-a', 'Event 33 Men 1650 Yard Freestyle', 'A Final', { rank: 5, finalsTime: '16:44.90' }),
    relayLeg('fo-r', 'Event 2 Men 4x200 Yard Freestyle Relay', 'A Final', 1, '6:35.54'),
  ];
  const counts = countSwimmerEntries(finalsOnly, TEAM, MEN, SWIMMER);
  assert.equal(counts.individual, 2, 'two timed-final individual events, two entries');
  assert.equal(counts.relayCount, 1, 'one timed-final relay, one entry');
  assert.equal(counts.total, 3, 'three entries');
  ok('finals-only swims (timed finals) each still count as one entry');
}

// ============================================================================
// BLOCK 5 — the fix must not over-merge. Distinct relay events stay distinct,
// and rounds are the ONLY thing collapsed.
// ============================================================================
{
  const distinct = RELAY_EVENTS.map((event, i) =>
    relayLeg(`d${i}`, event, 'A Final', i + 1, '1:31.00')
  );
  assert.equal(
    countSwimmerEntries(distinct, TEAM, MEN, SWIMMER).relayCount,
    4,
    'four different relay events are four entries'
  );

  // Two legs of the SAME relay entry — the shape a squad's own roster produces —
  // are one entry, as before.
  const twoLegs = [
    relayLeg('L0', RELAY_EVENTS[0], 'A Final', 2, '1:31.44', { relayLegIndex: 0 }),
    relayLeg('L3', RELAY_EVENTS[0], 'A Final', 2, '1:31.44', { relayLegIndex: 3 }),
  ];
  assert.equal(
    countSwimmerEntries(twoLegs, TEAM, MEN, SWIMMER).relayCount,
    1,
    'one human cannot occupy two legs of one relay entry — still one entry'
  );

  ok('distinct relay events stay distinct; only the round is collapsed');
}

// ============================================================================
// BLOCK 6 — `entryCapKey` itself: the round is not in the key, and an unlabeled
// row is COUNTED rather than silently dropped from a competition-rule count.
// ============================================================================
{
  const pre = relayLeg('k-pre', RELAY_EVENTS[0], 'Preliminaries', 5, '1:32.10');
  const fin = relayLeg('k-fin', RELAY_EVENTS[0], 'A Final', 2, '1:31.44');
  assert.equal(entryCapKey(pre), entryCapKey(fin), 'round, rank and clock are not in the cap key');
  assert.equal(entryCapKey(pre), RELAY_EVENTS[0], 'the cap key IS the event');
  assert.equal(
    entryCapKey({ id: 'x', event: '  Event 8 Men 50 Yard Freestyle  ' }),
    'Event 8 Men 50 Yard Freestyle',
    'surrounding whitespace does not split one entry in two'
  );

  // Absent != dropped. A row with no event name is a data defect; it must not
  // quietly reduce a cap count, because an under-count hides a violation.
  const blank = [
    ind('b1', '', 'A Final'),
    ind('b2', '', 'Preliminaries'),
    relayLeg('b3', '', 'A Final', 1, '1:31.00'),
  ];
  assert.notEqual(entryCapKey(blank[0]), entryCapKey(blank[1]), 'unlabeled rows never merge');
  const blankCounts = countSwimmerEntries(blank, TEAM, MEN, SWIMMER);
  assert.equal(blankCounts.individual, 2, 'both unlabeled individual rows are still counted');
  assert.equal(blankCounts.relayCount, 1, 'the unlabeled relay row is still counted');
  assert.equal(blankCounts.total, 3, 'nothing vanished from the count');

  ok('entryCapKey drops the round, keeps the event, and never silently drops a row');
}

console.log(`entry limit prelims/finals tests passed (${n} blocks)`);
