/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Relay scoring against the real NSISC parsed output. Previously zero
 * assertions — 57 lines of console.log that exited 0 no matter what the
 * engine returned (docs/reference/TEST_COVERAGE_AUDIT.md, "Pushover").
 * Hardened 2026-09-14 with real invariants pinned to this real data's own
 * numbers, per this repo's "anything that moves a number carries a
 * before/after from the live workspaces" methodology.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { calculatePoints, mergeScoringSettings, relayEntryGroupKey } from '../packages/core/src/lib/utils.ts';
import { Gender } from '../packages/core/src/types.ts';

const parserOut = JSON.parse(readFileSync('tests/test_nsisc_output.json', 'utf8'));
const toResult = (a) => ({
  id: crypto.randomUUID(),
  rank: a.rank ? parseInt(a.rank, 10) || 0 : 0,
  name: a.name,
  classYear: a.year || 'UNKNOWN',
  team: a.team,
  time: a.finals_time || a.prelims_time || 'NT',
  finalsTime: a.finals_time,
  roundSwam: a.round_swam,
  points: 0,
  event: a.event,
  gender: a.gender === 'Women' ? Gender.WOMEN : Gender.MEN,
  isRelay: Boolean(a.is_relay),
  relayTeamTime: a.relay_team_time,
});
const parsed = parserOut.map(toResult);
const wsSettings = JSON.parse(readFileSync('data/meets.json', 'utf8'))[0].scoringSettings;
const merged = mergeScoringSettings(wsSettings, { conference: 'NSISC' });
const allScored = calculatePoints(parsed, merged);
const relays = allScored.filter((r) => r.isRelay);
const groups = new Map();
for (const r of parsed.filter((x) => x.isRelay)) {
  const k = relayEntryGroupKey(r);
  groups.set(k, (groups.get(k) || 0) + 1);
}
const sizes = [...groups.values()];
console.log('relay entry group sizes', [...new Set(sizes)].sort());
console.log('Parsed PDF shape -> TS:', relays.length, 'pos', relays.filter((r) => r.points > 0).length);
const units = new Set(
  relays.filter((r) => r.points > 0).map((r) => relayEntryGroupKey(r))
);
console.log('scoring relay entries (TS)', units.size);

assert.ok(relays.length > 0, 'the real NSISC output parses real relay rows');
// A relay leg is one of 4 swimmers on a 4-person relay — this data has no
// other relay shape. A group size other than 4 means relayEntryGroupKey is
// splitting or merging entries wrong.
assert.deepEqual([...new Set(sizes)], [4], 'every parsed relay entry groups exactly 4 legs');
assert.ok(units.size > 0, 'at least one relay entry scores points');
assert.ok(units.size < relays.length, 'fewer distinct scoring entries than raw leg rows (4 legs each)');

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const ws = meets[0];
const men = (ws.menResults || []).filter((r) => r.isRelay && String(r.event || '').includes('Event 2'));
const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
const scored = calculatePoints(men, settings, { scorerRosterOverrides: ws.scorerRosterOverrides || [] });
const pts = scored.map((r) => r.points);
console.log('merge+conference roster mode:', settings.scorerEligibilityMode);
console.log('relay pool rule would be:', settings.relayEligibleFromScorerPool && settings.scorerEligibilityMode !== 'roster');
console.log('Event 2 men relay legs:', pts.length, 'positive', pts.filter((p) => p > 0).length, 'sample', pts.slice(0, 8));

// Pinned to this real committed workspace's own Event 2 (4x200 Free Relay):
// 48 leg rows, all scoring — a regression here means a real points count moved.
assert.equal(pts.length, 48, 'Event 2 men relay carries 48 leg rows in the committed NSISC data');
assert.ok(pts.every((p) => p > 0), 'every Event 2 relay leg scores in this fully-populated final');

const legPts = scored.filter((r) => r.points > 0).map((r) => r.points);
assert.ok(legPts.length >= 4, 'at least one full relay entry (4 legs) scored');
console.log('per-leg pts (first 4)', legPts.slice(0, 4), 'sum', legPts.slice(0, 4).reduce((a, b) => a + b, 0));

// A relay's team placement earns the SAME points on every leg — this is the
// specific invariant docs/reference/IMPROVEMENT_BRAINSTORM_2026-09-02.md's
// sibling relay-double-charge fix (0efcd602) protects. Four legs from the
// same real entry that carry different point values would mean that bug, or
// a new one just like it, is back.
const firstFour = legPts.slice(0, 4);
assert.equal(new Set(firstFour).size, 1, 'all 4 legs of one relay entry earn identical points');
assert.equal(firstFour[0] * 4, firstFour.reduce((a, b) => a + b, 0), 'the 4-leg sum is exactly 4x one leg\'s points');

const settingsNoMerge = { ...ws.scoringSettings };
const scored2 = calculatePoints(men, settingsNoMerge);
const pts2 = scored2.map((r) => r.points);
console.log('raw workspace settings (no merge):', settingsNoMerge.scorerEligibilityMode);
console.log('Event 2 positive:', pts2.filter((p) => p > 0).length);
assert.equal(pts2.length, pts.length, 'the raw workspace settings score the same row count as the merged settings');

console.log('OK — test_relay_scoring assertions passed');
