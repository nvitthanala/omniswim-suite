/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards `buildScorerRosterLookup` against defaulting an ungendered row's
 * auto-scorer key to Men regardless of which gender the call itself is
 * scoped to.
 *
 * THE BUG: `buildScorerRosterLookup`'s own `meta`-building loop keys a row's
 * roster entry on `r.gender ?? genderFilter ?? Gender.MEN` — falling back to
 * the CALL's own gender scope before Men. But `deriveAutoScorerKeys`, called
 * earlier in the same function to decide which athletes qualify as
 * auto-scorers, keyed its own lookup on `r.gender ?? Gender.MEN` directly —
 * skipping `genderFilter` entirely. So a Women's-scoped call
 * (`buildScorerRosterLookup(rows, settings, [], Gender.WOMEN, resolver)`)
 * processing a row with no explicit `gender` field built its roster entry
 * under Women (correct) but its auto-scorer key under Men (wrong) — the two
 * could never match, and the row's `isScorer` flag silently came back
 * `false` for an athlete who plainly qualified. `IMPROVEMENT_BRAINSTORM_
 * 2026-09-02.md` item 7 named this as a real possibility without verifying
 * it end to end; this test is that verification.
 *
 * THE FIX: `deriveAutoScorerKeys` now takes `genderFilter` and applies the
 * identical fallback order the meta-building loop already used.
 *
 * Test: npx tsx scripts/test_scorer_gender_default.mjs
 */
import assert from 'node:assert/strict';
import { buildScorerRosterLookup } from '../packages/core/src/lib/scorerRoster.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const TEAM = 'Ouachita Baptist University';
const SETTINGS = mergeScoringSettings({ scorerEligibilityMode: 'roster' });

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} — ${msg}`);
};

/** An A-Final individual swim. Qualifies as an auto-scorer by itself. */
function swim(id, name, extra = {}) {
  return {
    id,
    rank: 1,
    name,
    classYear: 'SO',
    team: TEAM,
    time: '55.10',
    points: 0,
    event: '100 Yard Freestyle',
    isRelay: false,
    roundSwam: 'A Final',
    ...extra,
  };
}

// One row with gender stated, one without — both women, both otherwise
// identical qualifying swims, so both should score as auto-scorers when the
// whole call is scoped to Women.
const ROWS = [
  swim('w1', 'Maren Vik', { gender: Gender.WOMEN }),
  swim('w2', 'Ingrid Solberg'), // no `gender` field at all — the reproduction case
];

// --- 1. both women auto-scorer regardless of whether gender was stated on the row
{
  const lookup = buildScorerRosterLookup(ROWS, SETTINGS, [], Gender.WOMEN);
  const stated = lookup.rows.find(r => r.name === 'Maren Vik');
  const unstated = lookup.rows.find(r => r.name === 'Ingrid Solberg');

  assert.ok(stated, 'the row with gender stated is in the roster');
  assert.equal(stated.gender, Gender.WOMEN, 'stated gender is preserved');
  assert.equal(stated.isScorer, true, 'stated-gender row auto-scores (sanity check)');

  assert.ok(unstated, 'the row with no gender field is still in the roster');
  assert.equal(unstated.gender, Gender.WOMEN, "ungendered row inherits the call's own genderFilter, not Men");
  assert.equal(
    unstated.isScorer,
    true,
    'ungendered row auto-scores under Women — was false before the fix, because ' +
      "deriveAutoScorerKeys ignored genderFilter and built its key under Men, " +
      "which never matched the Women-keyed roster entry the loop built for the same row"
  );
  ok('an ungendered row auto-scores under the call\'s own genderFilter, not a hardcoded Men default');
}

// --- 2. a Men's-scoped call is unaffected (the default direction was already correct)
{
  const menRows = [swim('m1', 'Erik Johansson')];
  const lookup = buildScorerRosterLookup(menRows, SETTINGS, [], Gender.MEN);
  const row = lookup.rows.find(r => r.name === 'Erik Johansson');
  assert.ok(row);
  assert.equal(row.gender, Gender.MEN);
  assert.equal(row.isScorer, true, 'Men-scoped ungendered row still auto-scores (no regression)');
  ok("a Men's-scoped call with no genderFilter override still resolves ungendered rows to Men");
}

// --- 3. no genderFilter at all (module-wide callers) falls back to Men, unchanged
{
  const rows = [swim('n1', 'No Filter Athlete')];
  const lookup = buildScorerRosterLookup(rows, SETTINGS);
  const row = lookup.rows.find(r => r.name === 'No Filter Athlete');
  assert.ok(row);
  assert.equal(row.gender, Gender.MEN, 'omitting genderFilter entirely keeps the original Men default');
  assert.equal(row.isScorer, true);
  ok('omitting genderFilter entirely (no call-site change) keeps the pre-fix default behavior');
}

console.log(`PASS  test_scorer_gender_default.mjs (${n} assertions)`);
