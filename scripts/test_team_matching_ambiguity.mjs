/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards `matchMeetTeamName`/`findMeetTeamBySubstring`
 * (`packages/core/src/data/teamAliases.ts`) and `matchOfficialTeamScore`
 * (`packages/core/src/lib/teamScoreMatching.ts`) against silently guessing
 * between two similarly-named teams in the same field.
 *
 * THE BUG: both functions' fuzzy tiers (substring containment, first-token
 * prefix) returned the FIRST candidate that matched, with no check for a
 * second one. Two schools that legitimately overlap on a normalized key
 * ("Ohio" and "Ohio State", "Wisconsin" and any UW-branch campus) would
 * silently resolve to whichever one the meet's team list happened to list
 * first — misattributing a truncated psych-sheet label or an official
 * published score to the wrong school with no signal anything went wrong.
 * `docs/reference/IMPROVEMENT_BRAINSTORM_2026-09-02.md` item 3 named this;
 * this test is the verification and the regression guard.
 *
 * THE FIX: each fuzzy tier now collects every match before deciding — an
 * unambiguous (exactly one) match still resolves exactly as before; two or
 * more candidates at the same tier now returns undefined (or, for
 * `matchMeetTeamName`, falls through to its own existing "return the
 * original label" fallback) instead of guessing.
 *
 * Test: npx tsx scripts/test_team_matching_ambiguity.mjs
 */
import assert from 'node:assert/strict';
import { matchMeetTeamName } from '../packages/core/src/data/teamAliases.ts';
import { matchOfficialTeamScore } from '../packages/core/src/lib/teamScoreMatching.ts';

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} — ${msg}`);
};

// --- matchMeetTeamName ------------------------------------------------------

{
  // "Ohio" is a substring of "Ohio State University" AND its own normalized
  // key contains neither of the other two — but "Ohio" the literal team name
  // is ALSO a distinct real school from "Ohio State University", both
  // present in the same meet field.
  const meetTeams = ['Ohio State University', 'Ohio University', 'Miami University'];

  // Exact match still resolves normally — never touched by the ambiguity guard.
  assert.equal(matchMeetTeamName('Ohio State University', meetTeams), 'Ohio State University');
  ok('an exact match is unaffected by the ambiguity guard');

  // A truncated "Ohio" is genuinely ambiguous between the two Ohio schools —
  // must NOT silently resolve to whichever one is listed first.
  const ambiguous = matchMeetTeamName('Ohio', meetTeams);
  assert.equal(
    ambiguous,
    'Ohio',
    'an ambiguous truncated label falls back to the original label, not a guessed team (was "Ohio State University" before the fix, first-in-list)'
  );
  ok('a truncated label ambiguous between two real teams is not silently resolved to the first one');

  // A label that only matches ONE team must still resolve — the guard must
  // not become so cautious it breaks the unambiguous case.
  assert.equal(matchMeetTeamName('Miami', meetTeams), 'Miami University');
  ok('an unambiguous fuzzy match still resolves normally');
}

// --- matchOfficialTeamScore --------------------------------------------------

{
  const officialScores = {
    'Ohio State University': 500,
    'Ohio University': 300,
  };

  // Exact key lookup is untouched.
  assert.equal(matchOfficialTeamScore('Ohio State University', officialScores), 500);
  ok('matchOfficialTeamScore: an exact key lookup is unaffected');

  // A team name only fuzzily related to both keys must not silently pick one.
  const ambiguousScore = matchOfficialTeamScore('Ohio', officialScores);
  assert.equal(
    ambiguousScore,
    undefined,
    'an official score ambiguous between two teams must come back absent, not a guessed number (was 500, the first key, before the fix)'
  );
  ok('matchOfficialTeamScore reports absent rather than guessing between two similarly-named official-score entries');

  // A genuinely unambiguous fuzzy match must still resolve.
  const singleScores = { 'Henderson State University': 1056 };
  assert.equal(matchOfficialTeamScore('Henderson State', singleScores), 1056);
  ok('matchOfficialTeamScore still resolves an unambiguous fuzzy match');
}

console.log(`PASS  test_team_matching_ambiguity.mjs (${n} assertions)`);
