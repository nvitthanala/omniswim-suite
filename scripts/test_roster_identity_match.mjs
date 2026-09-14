/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression: an athlete ALREADY on the roster, whose history is imported under a
 * variant spelling, must never be classified as a brand-new recruit.
 *
 * The live defect: `matchAthleteToRoster` compared raw normalized names with an
 * exact-or-substring test. It folded no diacritics and no comma order, so the
 * rostered "Olivér Pózvai" did not match an import spelled "Oliver Pozvai" — even
 * though `aliasNameKey`, this codebase's own identity key, says they are the same
 * athlete. The import then wrote a SECOND recruit under the second spelling.
 * Nothing threw. A coach reads a roster with one swimmer entered twice.
 *
 * `suggestAliasCandidates` could not rescue that pair either: it drops any pair
 * whose alias keys are equal as "nothing to link", which is exactly this pair. So
 * the athlete was mis-badged with no escape hatch at all.
 *
 * Two halves, and the split is the point:
 *   · Same athlete BY THE REPO'S OWN IDENTITY RULE (diacritics, comma order) →
 *     resolve it. No human needed.
 *   · Merely RELATED ("Alan Gonzalez" vs "Alan Alejan Gonzalez Mujica") → do NOT
 *     resolve it. Two brothers produce that same relation. Report the candidate
 *     and let a human confirm, per the alias engine's evidence rules.
 *
 * Test: npx tsx scripts/test_roster_identity_match.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  importHistoryToRoster,
  previewHistoryImportActions,
  rosterNamesForTeam,
  rosterReviewCandidates,
  ROSTER_MATCH_CONFIDENCE,
} from '../packages/core/src/lib/historyImportRoster.ts';
import { matchAthleteToRoster } from '../packages/core/src/lib/athleteHistory.ts';
import { ClassYear, Gender } from '../packages/core/src/types.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEAM = 'Henderson State University';
let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

/** A workspace whose ONLY roster presence for these athletes is recruit rows. */
function workspaceWithRecruits(names) {
  return {
    id: 'ws-identity',
    name: 'Identity',
    createdAt: 1,
    menResults: [],
    womenResults: [],
    recruits: names.map((name, i) => ({
      id: `rec-${i}`,
      name,
      team: TEAM,
      event: '200 Freestyle',
      time: '1:45.00',
      gender: Gender.MEN,
      classYear: ClassYear.HS,
      timeType: 'SCY',
    })),
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    historySources: [],
    scorerRosterOverrides: [],
    athleteAliases: [],
  };
}

const swims = name => [
  { name, team: TEAM, gender: Gender.MEN, event: '100 Backstroke', time: '51.94', source: 'paste' },
  { name, team: TEAM, gender: Gender.MEN, event: '200 Backstroke', time: '1:52.00', source: 'paste' },
];

const previewOne = (ws, name) =>
  previewHistoryImportActions(ws, swims(name), { team: TEAM, gender: Gender.MEN })[0];

// --- 1. diacritic-only variant is the SAME athlete, resolved with no human ----
{
  const ws = workspaceWithRecruits(['Olivér Pózvai']);
  const a = previewOne(ws, 'Oliver Pozvai');
  assert.equal(a.action, 'already_recruit', 'diacritic variant of a rostered recruit is not new');
  assert.notEqual(a.action, 'new_recruit');
  assert.equal(a.matchedRosterName, 'Olivér Pózvai', 'matches the roster spelling');
  assert.equal(a.reviewCandidates, undefined, 'a resolved match needs no human review');

  const result = importHistoryToRoster(ws, swims('Oliver Pozvai'), {
    team: TEAM,
    gender: Gender.MEN,
  });
  assert.equal(result.summary.newRecruits, 0, 'no second recruit row is created');
  const names = new Set((result.patch.recruits ?? []).map(r => r.name));
  assert.deepEqual([...names], ['Olivér Pózvai'], 'the roster keeps ONE spelling of the athlete');
  assert.ok(
    (result.patch.meetEntryPlans ?? []).every(p => p.name === 'Olivér Pózvai'),
    'entries are written under the roster spelling, not the import spelling'
  );
  ok('a diacritic-only variant resolves onto the rostered athlete, creating no duplicate');
}

// --- 1b. same case, but the athlete is on the roster via a MEET RESULT --------
{
  // No recruit row here, so the recruit-key lookup cannot rescue this. The only
  // thing that can recognize the athlete is `matchAthleteToRoster` itself, which
  // is exactly the function that was blind to diacritics.
  const ws = workspaceWithRecruits([]);
  ws.menResults = [
    {
      id: 'm1',
      rank: 1,
      name: 'Olivér Pózvai',
      classYear: 'SO',
      team: TEAM,
      time: '51.94',
      points: 0,
      event: '100 Backstroke',
      gender: Gender.MEN,
    },
  ];
  const a = previewOne(ws, 'Oliver Pozvai');
  assert.notEqual(a.action, 'new_recruit', 'a competed athlete is not a new recruit');
  assert.equal(a.matchedRosterName, 'Olivér Pózvai', 'matched to the competed spelling');

  const result = importHistoryToRoster(ws, swims('Oliver Pozvai'), {
    team: TEAM,
    gender: Gender.MEN,
  });
  assert.equal(result.summary.newRecruits, 0, 'a competed athlete never becomes a recruit row');
  assert.deepEqual(result.patch.recruits, [], 'no recruit row is written at all');
  ok('an athlete on the roster via a meet result is recognized under a variant spelling');
}

// --- 2. the fold is symmetric: rostered plain, imported accented --------------
{
  const ws = workspaceWithRecruits(['Oliver Pozvai']);
  const a = previewOne(ws, 'Olivér Pózvai');
  assert.equal(a.action, 'already_recruit', 'the fold works in both directions');
  assert.equal(a.matchedRosterName, 'Oliver Pozvai');
  ok('the identity fold is symmetric — either spelling finds the other');
}

// --- 3. comma order is not a different athlete either -------------------------
{
  const ws = workspaceWithRecruits(['Smith, John']);
  const a = previewOne(ws, 'John Smith');
  assert.equal(a.action, 'already_recruit', '"John Smith" is the rostered "Smith, John"');
  assert.equal(a.matchedRosterName, 'Smith, John');
  ok('comma-order spellings resolve to one athlete');
}

// --- 4. a merely RELATED name is reported, never silently merged --------------
{
  const ws = workspaceWithRecruits(['Alan Alejan Gonzalez Mujica']);
  const a = previewOne(ws, 'Alan Gonzalez');
  // Deliberately still `new_recruit`: a token subset is not proof. Two brothers
  // ("John Smith" / "John Michael Smith") produce this exact relation, so the
  // repo's rule is that it auto-links only on evidence planAutoAliasLinks holds.
  assert.equal(a.action, 'new_recruit', 'a token subset alone is not proof of identity');
  assert.equal(a.matchedRosterName, null, 'a possible match is never reported as a confident one');
  assert.ok(a.reviewCandidates?.length, 'the near-miss travels with the verdict');
  assert.equal(a.reviewCandidates[0].rosterName, 'Alan Alejan Gonzalez Mujica');
  assert.ok(a.reviewCandidates[0].score >= 0.9, 'token subset scores 0.9 in the alias engine');
  assert.ok(a.reviewCandidates[0].reason.length > 0, 'the relation says why');
  ok('a related-but-unproven name surfaces for review instead of merging or vanishing');
}

// --- 5. a genuinely unknown athlete stays a clean new recruit -----------------
{
  const ws = workspaceWithRecruits(['Olivér Pózvai', 'Alan Alejan Gonzalez Mujica']);
  const a = previewOne(ws, 'Blaise Vera');
  assert.equal(a.action, 'new_recruit');
  assert.equal(a.matchedRosterName, null);
  assert.equal(a.reviewCandidates, undefined, 'no candidate is invented for an unrelated name');
  ok('an unrelated name is a new recruit with no fabricated candidate');
}

// --- 6. near-surname look-alikes are two people, not one ----------------------
{
  const ws = workspaceWithRecruits(['Ryan Johnston']);
  const m = matchAthleteToRoster('Ryan Johnson', rosterNamesForTeam(ws, TEAM, Gender.MEN));
  assert.ok(
    m.match === null || m.confidence < ROSTER_MATCH_CONFIDENCE,
    'a one-letter surname difference never reaches a confident match'
  );
  const a = previewOne(ws, 'Ryan Johnson');
  assert.equal(a.action, 'new_recruit', 'Johnson and Johnston stay two athletes');
  assert.equal(a.matchedRosterName, null);
  ok('a near-surname look-alike is never silently merged');
}

// --- 7. a sub-threshold match can never shortcut to `already_recruit` ---------
{
  // The rule chain read `match.match` bare on its recruit shortcut, ignoring the
  // confidence it had just computed. Any match the matcher reports must clear the
  // threshold before it can resolve a swimmer onto a recruit row.
  const ws = workspaceWithRecruits(['Ryan Johnston', 'Alan Alejan Gonzalez Mujica']);
  for (const name of ['Ryan Johnson', 'Alan Gonzalez']) {
    const a = previewOne(ws, name);
    assert.equal(a.action, 'new_recruit', `${name} must not shortcut to already_recruit`);
  }
  ok('the recruit shortcut respects the confidence gate');
}

// --- 8. rosterReviewCandidates is quiet when the match is confident -----------
{
  const rosterNames = ['Olivér Pózvai', 'Alan Alejan Gonzalez Mujica'];
  assert.deepEqual(
    rosterReviewCandidates('Oliver Pozvai', rosterNames),
    [],
    'nothing to review once the athlete is identified'
  );
  const review = rosterReviewCandidates('Alan Gonzalez', rosterNames);
  assert.equal(review.length, 1);
  assert.equal(review[0].rosterName, 'Alan Alejan Gonzalez Mujica');
  ok('rosterReviewCandidates reports only genuine near-misses');
}

// --- 9. the real workspaces: every variant spelling stays recoverable ---------
{
  // Snapshotted against the committed workspaces so upstream data drift breaks CI
  // rather than drifting silently. These four athletes are the live cases: two
  // accented Hungarian names and two Hispanic double surnames.
  const meets = JSON.parse(readFileSync(join(repoRoot, 'data/meets.json'), 'utf8'));
  const hsu = meets.find(w => w.name === 'HSU 2026-27 Roster Plan');
  assert.ok(hsu, 'the HSU 2026-27 roster workspace is present in data/meets.json');
  const rosterNames = rosterNamesForTeam(hsu, TEAM, Gender.MEN);
  assert.ok(rosterNames.length > 0, 'the HSU roster returns names (a silent empty is the top risk)');

  for (const rostered of ['Olivér Pózvai', 'Alex Tarkovács', 'Máté Hosszú']) {
    assert.ok(rosterNames.includes(rostered), `${rostered} is on the committed HSU roster`);
    const plain = rostered.normalize('NFD').replace(/[̀-ͯ]/g, '');
    assert.notEqual(plain, rostered, `${rostered} actually carries diacritics`);
    const m = matchAthleteToRoster(plain, rosterNames);
    assert.equal(m.match, rostered, `"${plain}" resolves to the rostered "${rostered}"`);
    assert.ok(m.confidence >= ROSTER_MATCH_CONFIDENCE, 'and does so confidently');
  }

  // Every rostered HSU athlete, imported under a diacritic-stripped spelling, must
  // either resolve or surface a candidate. Never a silent duplicate.
  let silent = 0;
  for (const rostered of rosterNames) {
    const plain = rostered.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (plain === rostered || rosterNames.includes(plain)) continue;
    const a = previewHistoryImportActions(hsu, swims(plain), { team: TEAM, gender: Gender.MEN })[0];
    if (a && a.action === 'new_recruit' && !a.reviewCandidates?.length) silent += 1;
  }
  assert.equal(silent, 0, 'no HSU athlete can be silently duplicated by a diacritic variant');
  ok('the committed HSU roster admits no silently duplicated athlete');
}

console.log(`\nroster identity match: ${n} passed`);
