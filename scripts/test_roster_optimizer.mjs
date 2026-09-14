import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { optimizeRosterForTeam, optimizeScorersForTeam } from '../packages/core/src/lib/rosterOptimizer.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const ws = meets[0];
const settings = mergeScoringSettings(ws.scoringSettings, { conference: 'NSISC' });

const team = 'Ouachita Baptist University';
const result = optimizeRosterForTeam(ws, Gender.MEN, team, false, settings, 'scorers');

assert.ok(Array.isArray(result.overrides), 'overrides array');
assert.equal(typeof result.projectedTotal, 'number', 'projected total');
console.log(
  'optimizer',
  team,
  'projected',
  result.projectedTotal.toFixed(1),
  'was',
  result.previousTotal.toFixed(1),
  'override deltas',
  result.overrides.length
);

// --- consideredButRejected: rejected-candidate surfacing (2026-09-14) ------

assert.ok(Array.isArray(result.consideredButRejected), 'consideredButRejected is an array when the scorers stage ran');

// NSISC's scorer cap is locked by mergeScoringSettings (deliberately — see
// NSISC_LOCKED_SETTING_KEYS in scoringDefaults.ts) whenever
// `workspace.conference` is NSISC, so a settings override alone can't move
// it against this real workspace. Clone with conference cleared so the cap
// this test passes actually takes effect, same as any non-NSISC workspace.
const unlockedWs = { ...ws, conference: undefined };

// A cap far larger than the roster can hold rejects nobody.
const wideOpen = optimizeScorersForTeam(
  unlockedWs,
  Gender.MEN,
  team,
  false,
  { ...settings, maxIndividualScorersPerTeam: 999 }
);
assert.equal(wideOpen.rejected.length, 0, 'a cap wider than the roster rejects nobody');

// A cap of 1 forces real rejections on any team with more than one swimmer.
const tight = optimizeScorersForTeam(unlockedWs, Gender.MEN, team, false, { ...settings, maxIndividualScorersPerTeam: 1 });
assert.ok(tight.rejected.length > 0, 'a cap of 1 rejects real candidates on a multi-swimmer team');
for (const r of tight.rejected) {
  assert.ok(Number.isFinite(r.points) && r.points >= 0, `rejected candidate ${r.name} has a real points value`);
  assert.ok(Number.isFinite(r.behindByPoints) && r.behindByPoints >= 0, `rejected candidate ${r.name} has a non-negative margin`);
  assert.equal(r.team, team, `rejected candidate ${r.name} is reported under the team being optimized`);
}
// The rejected list and the roster's actual final scorers must be disjoint —
// nobody both made the cut (per the returned overrides) and appears as rejected.
const rejectedNames = new Set(tight.rejected.map(r => r.name));
for (const o of tight.overrides) {
  if (o.team === team && o.isScorer) {
    assert.ok(!rejectedNames.has(o.name), `${o.name} is marked a scorer by an override but also appears rejected`);
  }
}

console.log(`optimizer consideredButRejected: ${tight.rejected.length} rejected at cap=1, 0 at cap=999`);
console.log('roster optimizer tests passed');
