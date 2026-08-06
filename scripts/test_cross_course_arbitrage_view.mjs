/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the CrossCourseArbitragePanel view-model helpers.
 *
 * The grouping rules are the interesting part: the arbitrage engine emits one
 * row per candidate pairing, and the panel collapses those into one row per
 * decision. Getting that wrong shows a coach several rows for the same move,
 * or hides alternates that exist.
 */
import assert from 'node:assert/strict';
import {
  courseEdges,
  formatMargin,
  formatPoints,
  groupRelaySwaps,
  groupSwaps,
} from '../packages/manager/src/components/crossCourseArbitrageView.ts';

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

// --- formatting ------------------------------------------------------------
{
  assert.equal(formatMargin(0.5), '+0.50s');
  assert.equal(formatMargin(1.005), '+1.00s', 'two decimals, no exponent');
  ok('formatMargin always signs positive and fixes two decimals');

  assert.equal(formatPoints(3), '+3.0 pts');
  assert.equal(formatPoints(-2.25), '-2.3 pts', 'negative uses a minus, magnitude rounded');
  assert.equal(formatPoints(0), '+0.0 pts', 'zero reads as positive, not "-0.0"');
  ok('formatPoints signs by value and never emits -0.0');
}

// --- courseEdges -----------------------------------------------------------
{
  const rows = [
    { event: 'A', convertedWinsBy: 0.4 },
    { event: 'B', convertedWinsBy: undefined },
    { event: 'C', convertedWinsBy: 1.2 },
    { event: 'D', convertedWinsBy: 0 },
    { event: 'E', convertedWinsBy: -0.3 },
  ];
  const out = courseEdges(rows);
  assert.deepEqual(out.map(r => r.event), ['C', 'A'], 'only positive edges, fastest first');
  ok('courseEdges keeps only a real edge and sorts it descending');

  // Absent is not an edge. A missing conversion must not be treated as zero-or-better.
  assert.equal(out.some(r => r.event === 'B'), false);
  assert.equal(out.some(r => r.event === 'D'), false, 'a zero margin is not an edge');
  ok('courseEdges excludes absent and zero margins rather than defaulting them');

  assert.deepEqual(rows.map(r => r.event), ['A', 'B', 'C', 'D', 'E'], 'input not reordered');
  ok('courseEdges does not mutate its input');
}

// --- groupSwaps ------------------------------------------------------------
{
  // Engine order is already delta-desc; the first row per key is the best one.
  const swaps = [
    { athlete: 'Reed', addEvent: '200 Free', dropEvent: '100 Free', delta: 5 },
    { athlete: 'Reed', addEvent: '200 Free', dropEvent: '50 Free', delta: 4 },
    { athlete: 'Reed', addEvent: '200 Free', dropEvent: '100 Back', delta: 3 },
    { athlete: 'Reed', addEvent: '500 Free', dropEvent: '100 Free', delta: 2 },
    { athlete: 'Ortiz', addEvent: '200 Free', dropEvent: '100 Free', delta: 1 },
  ];
  const groups = groupSwaps(swaps);

  assert.equal(groups.length, 3, 'keyed on athlete + addEvent');
  const reed200 = groups.find(g => g.best.athlete === 'Reed' && g.best.addEvent === '200 Free');
  assert.equal(reed200.best.dropEvent, '100 Free', 'keeps the first (best) row');
  assert.equal(reed200.otherDrops, 2, 'counts the alternates it collapsed');
  ok('groupSwaps collapses drops per add and counts the alternates');

  const ortiz = groups.find(g => g.best.athlete === 'Ortiz');
  assert.equal(ortiz.otherDrops, 0, 'a lone pairing has no alternates');
  ok('groupSwaps reports zero alternates for a single pairing');

  assert.deepEqual(groupSwaps([]), [], 'empty in, empty out');
  ok('groupSwaps handles an empty list');
}

// --- groupRelaySwaps -------------------------------------------------------
{
  const swaps = [
    { relayEntryKey: 'R1', legIndex: 0, candidate: 'Reed', delta: 5 },
    { relayEntryKey: 'R1', legIndex: 0, candidate: 'Ortiz', delta: 4 },
    { relayEntryKey: 'R1', legIndex: 1, candidate: 'Reed', delta: 3 },
    { relayEntryKey: 'R2', legIndex: 0, candidate: 'Reed', delta: 2 },
  ];
  const groups = groupRelaySwaps(swaps);

  assert.equal(groups.length, 3, 'keyed on relay entry + leg, not on candidate');
  const r1leg0 = groups.find(g => g.best.relayEntryKey === 'R1' && g.best.legIndex === 0);
  assert.equal(r1leg0.best.candidate, 'Reed', 'keeps the first (best) candidate');
  assert.equal(r1leg0.otherCandidates, 1);
  ok('groupRelaySwaps keeps one substitution per leg and counts the rest');

  // A leg can only take one substitution — same leg index on a different relay
  // entry is a different decision and must not be merged.
  const r2leg0 = groups.find(g => g.best.relayEntryKey === 'R2');
  assert.equal(r2leg0.otherCandidates, 0);
  ok('groupRelaySwaps does not merge the same leg index across relay entries');
}

console.log(`\ncross-course arbitrage view: ${n} checks passed`);
