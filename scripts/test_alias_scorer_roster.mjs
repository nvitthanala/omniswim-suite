/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards alias resolution in the scorer roster.
 *
 * THE BUG: a user can link two spellings of one athlete ("Steven Balistreri" ==
 * "Stevie Balistreri"). The link is stored in `workspace.athleteAliases` and
 * `buildAliasResolver` honours it — but `buildScorerRosterLookup` keyed rows on
 * the RAW name, so both spellings became separate roster rows. Measured against
 * the live "Blank Workspace 1": 47 rows for Henderson State men, 6 of which were
 * second halves of linked identities. The user corrected the data and the
 * correction was silently discarded downstream — a duplicated athlete eats an
 * extra scorer slot, and each half sits independently under the 7-event NSISC
 * cap, so one human can hold 14 entries without tripping the checklist.
 *
 * THE FIX: `buildScorerRosterLookup`, `aggregateSwimmerMeetPoints` and
 * `getAthleteCreditedSwims` take a trailing
 * `resolver: AthleteAliasResolver = IDENTITY_ALIAS_RESOLVER`, matching the
 * convention `categorizeBestEvents` / `relayEventsForAthlete` already use.
 *
 * The default is deliberately identity — assertion block 4 is what proves the
 * default did not move, so wiring callers stays a reviewable decision rather
 * than a silent behaviour change for every existing consumer.
 *
 * Test: npx tsx scripts/test_alias_scorer_roster.mjs
 */
import assert from 'node:assert/strict';
import {
  buildScorerRosterLookup,
  aggregateSwimmerMeetPoints,
  getAthleteCreditedSwims,
  scorerRosterKey,
} from '../packages/core/src/lib/scorerRoster.ts';
import {
  buildAliasResolver,
  IDENTITY_ALIAS_RESOLVER,
} from '../packages/core/src/lib/athleteAliases.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const TEAM = 'Henderson State University';
const SETTINGS = mergeScoringSettings({ scorerEligibilityMode: 'roster' });

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} — ${msg}`);
};

/** Minimal individual swim row. `A Final` makes it an auto-scorer. */
function swim(id, name, event, time, extra = {}) {
  return {
    id,
    rank: 1,
    name,
    classYear: 'JR',
    team: TEAM,
    time,
    points: 0,
    event,
    gender: MEN,
    isRelay: false,
    roundSwam: 'A Final',
    ...extra,
  };
}

/** A live link: `aliasName` resolves to `canonicalName`. */
function link(id, aliasName, canonicalName, extra = {}) {
  return {
    id,
    gender: MEN,
    team: TEAM,
    canonicalName,
    aliasName,
    source: 'manual',
    createdAt: '2026-08-15T00:00:00.000Z',
    ...extra,
  };
}

// The two spellings the user linked, plus an unrelated athlete who must never
// be swept into the merge.
const ROWS = [
  swim('a1', 'Stevie Balistreri', '50 Freestyle', '20.59'),
  swim('a2', 'Steven Balistreri', '100 Freestyle', '46.50'),
  swim('b1', 'Ryan Johnson', '200 Freestyle', '1:42.10'),
];

const LINKED_WS = { athleteAliases: [link('L1', 'Steven Balistreri', 'Stevie Balistreri')] };
const linkedResolver = buildAliasResolver(LINKED_WS);

const rowsFor = (lookup, name) =>
  lookup.rows.filter(r => r.name === name);

// --- 1. two linked spellings produce ONE roster row, not two -----------------
{
  const lookup = buildScorerRosterLookup(ROWS, SETTINGS, [], MEN, linkedResolver);
  const teamRows = lookup.rows.filter(r => r.team === TEAM);

  assert.equal(teamRows.length, 2, 'two humans => two roster rows (was 3 before the fix)');

  const balistreri = teamRows.filter(r => r.name.includes('Balistreri'));
  assert.equal(balistreri.length, 1, 'both Balistreri spellings collapse to one row');
  assert.equal(
    balistreri[0].name,
    'Stevie Balistreri',
    'the surviving row carries the CANONICAL spelling, not whichever row came first'
  );
  assert.equal(
    balistreri[0].key,
    scorerRosterKey(TEAM, MEN, 'Stevie Balistreri'),
    'the row key is the canonical key'
  );
  ok('two linked spellings collapse into one roster row under the canonical name');
}

// --- 1b. row identity is NOT dependent on input order ------------------------
{
  const forward = buildScorerRosterLookup(ROWS, SETTINGS, [], MEN, linkedResolver);
  const reversed = buildScorerRosterLookup([...ROWS].reverse(), SETTINGS, [], MEN, linkedResolver);
  const names = l => l.rows.map(r => r.name).sort();
  assert.deepEqual(
    names(reversed),
    names(forward),
    'feeding the alias spelling first must not rename the merged row'
  );
  ok('merged row name is input-order independent');
}

// --- 2. the merged row is reachable under EITHER spelling via isScorer -------
{
  const lookup = buildScorerRosterLookup(ROWS, SETTINGS, [], MEN, linkedResolver);
  assert.equal(lookup.isScorer('Stevie Balistreri', TEAM, MEN), true, 'canonical spelling is a scorer');
  assert.equal(lookup.isScorer('Steven Balistreri', TEAM, MEN), true, 'alias spelling reaches the same row');
  ok('isScorer answers identically for both spellings of the merged athlete');
}

// --- 3. an override recorded against EITHER spelling applies to the merge ----
{
  // Recorded against the ALIAS spelling — the one that no longer names a row.
  const viaAlias = buildScorerRosterLookup(
    ROWS,
    SETTINGS,
    [{ name: 'Steven Balistreri', team: TEAM, gender: MEN, isScorer: false }],
    MEN,
    linkedResolver
  );
  const rowA = rowsFor(viaAlias, 'Stevie Balistreri')[0];
  assert.ok(rowA, 'merged row still exists with an override applied');
  assert.equal(rowA.isScorer, false, 'override recorded on the alias spelling applies to the merged row');
  assert.equal(rowA.source, 'manual', 'and is reported as a manual decision');
  assert.equal(
    viaAlias.isScorer('Stevie Balistreri', TEAM, MEN),
    false,
    'isScorer honours the alias-recorded override under the canonical spelling too'
  );

  // Recorded against the CANONICAL spelling — same outcome.
  const viaCanonical = buildScorerRosterLookup(
    ROWS,
    SETTINGS,
    [{ name: 'Stevie Balistreri', team: TEAM, gender: MEN, isScorer: false }],
    MEN,
    linkedResolver
  );
  assert.equal(
    rowsFor(viaCanonical, 'Stevie Balistreri')[0].isScorer,
    false,
    'override recorded on the canonical spelling applies too'
  );
  assert.equal(
    viaCanonical.isScorer('Steven Balistreri', TEAM, MEN),
    false,
    'and is visible when queried by the alias spelling'
  );
  ok('a scorer override recorded against either spelling governs the merged athlete');
}

// --- 4. WITHOUT a resolver the default is byte-identical to today ------------
// This is the assertion that proves the default is safe: every existing caller
// (none of which passes a resolver) keeps its exact current behaviour.
{
  const omitted = buildScorerRosterLookup(ROWS, SETTINGS, [], MEN);
  const explicitIdentity = buildScorerRosterLookup(ROWS, SETTINGS, [], MEN, IDENTITY_ALIAS_RESOLVER);

  assert.equal(omitted.rows.length, 3, 'no resolver => the two spellings stay two rows (todays behaviour)');
  assert.deepEqual(
    omitted.rows,
    explicitIdentity.rows,
    'omitting the resolver equals passing IDENTITY_ALIAS_RESOLVER, row for row'
  );
  assert.deepEqual(
    omitted.rows.map(r => r.name).sort(),
    ['Ryan Johnson', 'Steven Balistreri', 'Stevie Balistreri'],
    'both spellings still present, spelled exactly as the input rows spelled them'
  );
  assert.equal(omitted.isScorer('Steven Balistreri', TEAM, MEN), true);
  assert.equal(omitted.isScorer('Stevie Balistreri', TEAM, MEN), true);

  // An alias-spelling override must NOT leak onto the other row without a resolver.
  const noResolverOverride = buildScorerRosterLookup(
    ROWS,
    SETTINGS,
    [{ name: 'Steven Balistreri', team: TEAM, gender: MEN, isScorer: false }],
    MEN
  );
  assert.equal(rowsFor(noResolverOverride, 'Steven Balistreri')[0].isScorer, false);
  assert.equal(
    rowsFor(noResolverOverride, 'Stevie Balistreri')[0].isScorer,
    true,
    'without a resolver the two spellings remain independently overridable'
  );
  ok('default (no resolver) is byte-identical to pre-fix behaviour');
}

// --- 5. a suppressed alias does NOT merge (a dismissed pair is two people) ---
{
  const suppressedWs = {
    athleteAliases: [
      link('S1', 'Steven Balistreri', 'Stevie Balistreri', {
        status: 'suppressed',
        provenance: { origin: 'user', suppressedReason: 'user_reject', suppressedAt: '2026-08-15T00:00:00.000Z' },
      }),
    ],
  };
  const suppressedResolver = buildAliasResolver(suppressedWs);
  assert.equal(
    suppressedResolver.resolveAthleteName('Steven Balistreri', TEAM, MEN),
    'Steven Balistreri',
    'a tombstone resolves nothing'
  );

  const lookup = buildScorerRosterLookup(ROWS, SETTINGS, [], MEN, suppressedResolver);
  assert.equal(lookup.rows.length, 3, 'a suppressed pair stays two roster rows');
  assert.deepEqual(
    lookup.rows.map(r => r.name).sort(),
    ['Ryan Johnson', 'Steven Balistreri', 'Stevie Balistreri'],
    'both spellings survive a suppression tombstone'
  );
  ok('a status:"suppressed" alias never merges two rows');
}

// --- 6. two genuinely different athletes are never merged -------------------
{
  // Near-miss names with NO link between them. The roster must not guess.
  const rows = [
    swim('c1', 'Ryan Johnson', '50 Freestyle', '20.59'),
    swim('c2', 'Ryan Johnston', '100 Freestyle', '46.50'),
    swim('c3', 'Stevie Balistreri', '200 Freestyle', '1:42.10'),
  ];
  const lookup = buildScorerRosterLookup(rows, SETTINGS, [], MEN, linkedResolver);
  assert.equal(lookup.rows.length, 3, 'no link => no merge, however similar the spellings');
  assert.equal(
    lookup.isScorer('Ryan Johnson', TEAM, MEN),
    true,
    'each unlinked athlete keeps their own row'
  );

  // A link in ANOTHER gender scope must not merge these men.
  const wrongScope = buildAliasResolver({
    athleteAliases: [
      { ...link('W1', 'Ryan Johnston', 'Ryan Johnson'), gender: Gender.WOMEN },
    ],
  });
  const scoped = buildScorerRosterLookup(rows, SETTINGS, [], MEN, wrongScope);
  assert.equal(scoped.rows.length, 3, 'a womens-scope link must not merge mens roster rows');

  // A link scoped to a DIFFERENT team must not merge these rows either.
  const otherTeam = buildAliasResolver({
    athleteAliases: [{ ...link('W2', 'Ryan Johnston', 'Ryan Johnson'), team: 'Delta State University' }],
  });
  const scopedTeam = buildScorerRosterLookup(rows, SETTINGS, [], MEN, otherTeam);
  assert.equal(scopedTeam.rows.length, 3, 'another teams link must not merge this teams rows');
  ok('unlinked look-alikes, and links scoped to another gender/team, never merge');
}

// --- 7. points and credited swims follow the merged identity ----------------
// Without this the merged row displays one row but reports only half its swims.
{
  const scored = [
    swim('p1', 'Stevie Balistreri', '50 Freestyle', '20.59', { points: 20 }),
    swim('p2', 'Steven Balistreri', '100 Freestyle', '46.50', { points: 17 }),
    swim('p3', 'Ryan Johnson', '200 Freestyle', '1:42.10', { points: 9 }),
  ];
  const mergedKey = scorerRosterKey(TEAM, MEN, 'Stevie Balistreri');

  const identityTotals = aggregateSwimmerMeetPoints(scored, MEN);
  assert.equal(identityTotals.get(mergedKey), 20, 'default: only the canonical half is credited (unchanged)');
  assert.equal(
    identityTotals.get(scorerRosterKey(TEAM, MEN, 'Steven Balistreri')),
    17,
    'default: the alias half sits under its own key (unchanged)'
  );

  const mergedTotals = aggregateSwimmerMeetPoints(scored, MEN, linkedResolver);
  assert.equal(mergedTotals.get(mergedKey), 37, 'with a resolver both halves are credited to one key');
  assert.equal(
    mergedTotals.get(scorerRosterKey(TEAM, MEN, 'Steven Balistreri')),
    undefined,
    'and nothing is left stranded under the alias key'
  );
  assert.equal(mergedTotals.get(scorerRosterKey(TEAM, MEN, 'Ryan Johnson')), 9, 'unrelated athlete untouched');

  // Credited swims: either spelling returns the merged athletes full list.
  const viaCanonical = getAthleteCreditedSwims(scored, TEAM, 'Stevie Balistreri', MEN, linkedResolver);
  const viaAlias = getAthleteCreditedSwims(scored, TEAM, 'Steven Balistreri', MEN, linkedResolver);
  assert.equal(viaCanonical.length, 2, 'merged athlete shows both swims');
  assert.deepEqual(
    viaAlias.map(s => s.id).sort(),
    viaCanonical.map(s => s.id).sort(),
    'querying by either spelling returns the same swim list'
  );

  const defaultSwims = getAthleteCreditedSwims(scored, TEAM, 'Stevie Balistreri', MEN);
  assert.equal(defaultSwims.length, 1, 'default: unchanged, only the queried spellings swim');
  ok('aggregateSwimmerMeetPoints and getAthleteCreditedSwims follow the merged identity, default unchanged');
}

// --- 8. transitive links collapse to a single row ---------------------------
{
  const rows = [
    swim('t1', 'Alan Gonzalez Mujica', '50 Freestyle', '21.00'),
    swim('t2', 'Alan Alejan Gonzalez Mujica', '100 Freestyle', '47.00'),
    swim('t3', 'A Gonzalez Mujica', '200 Freestyle', '1:44.00'),
  ];
  const chain = buildAliasResolver({
    athleteAliases: [
      link('C1', 'A Gonzalez Mujica', 'Alan Alejan Gonzalez Mujica'),
      link('C2', 'Alan Alejan Gonzalez Mujica', 'Alan Gonzalez Mujica'),
    ],
  });
  const lookup = buildScorerRosterLookup(rows, SETTINGS, [], MEN, chain);
  assert.equal(lookup.rows.length, 1, 'A->B->C collapses to one roster row');
  assert.equal(lookup.rows[0].name, 'Alan Gonzalez Mujica', 'under the end-of-chain canonical name');
  for (const nm of ['A Gonzalez Mujica', 'Alan Alejan Gonzalez Mujica', 'Alan Gonzalez Mujica']) {
    assert.equal(lookup.isScorer(nm, TEAM, MEN), true, `${nm} reaches the merged row`);
  }
  ok('transitive alias chains collapse to a single roster row');
}

console.log('alias scorer roster: all assertions passed');
