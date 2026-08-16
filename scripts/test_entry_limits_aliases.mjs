/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards alias resolution in per-swimmer ENTRY LIMIT counting.
 *
 * THE BUG: a user can link two spellings of one athlete ("Olivér Pózvai" ==
 * "Oliver Pozvai"). `workspace.athleteAliases` stores it, `buildAliasResolver`
 * honours it, and `buildScorerRosterLookup` now applies it — but
 * `countSwimmerEntries` keyed on `normalizeSwimmerName(name)` with no resolver,
 * so each spelling was counted against its own cap. Measured on the live
 * "Blank Workspace 1", Henderson State men, projected view, against the NSISC cap
 * of 7 total entries per swimmer:
 *
 *     Olivér Pózvai      3  +  Oliver Pozvai      7   =>  merged 8   OVER CAP
 *     Steven Balistreri  3  +  Stevie Balistreri  7   =>  merged 9   OVER CAP
 *     Tristin Ferguson   3  +  Tristen Fergunson  7   =>  merged 7   at cap
 *
 * Two real NSISC entry-limit violations were invisible. That is a competition
 * rule, not a display detail — an over-entered swimmer's swims can be voided.
 * (Merged totals are below 3+7=10 because the halves share individual events:
 * a recruit row remapped onto the meet's own event label is the SAME entry.)
 *
 * WHY IT HAD TO SHIP WITH THE ROSTER FIX: `TeamRosterPanel.tsx:574` and
 * `rosterLineupAudit.ts:241` call `countSwimmerEntries(..., row.name)` with a
 * name from `buildScorerRosterLookup`. Once that lookup takes a resolver,
 * `row.name` is the CANONICAL spelling — so an unresolved count would scan only
 * that half (7 of 9) and still report compliant. Making the roster alias-aware
 * alone does not fix the cap bug; it relabels which half is counted and hides the
 * violation more thoroughly.
 *
 * THE FIX: `countSwimmerEntries` takes a trailing
 * `resolver: AthleteAliasResolver = IDENTITY_ALIAS_RESOLVER`, matching the
 * convention `buildScorerRosterLookup` (scorerRoster.ts) already uses, and
 * resolves BOTH the queried name and every scanned row's name. Block 2 is what
 * proves the default did not move.
 *
 * Test: npx tsx scripts/test_entry_limits_aliases.mjs
 */
import assert from 'node:assert/strict';
import {
  countSwimmerEntries,
  swimmerExceedsEntryLimits,
  canAcceptAnotherEntry,
} from '../packages/core/src/lib/swimmerEntryLimits.ts';
import {
  buildAliasResolver,
  IDENTITY_ALIAS_RESOLVER,
} from '../packages/core/src/lib/athleteAliases.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const TEAM = 'Henderson State University';

/** NSISC: total-only cap of 7 entries per swimmer, any individual/relay mix. */
const NSISC = mergeScoringSettings({}, { conference: 'NSISC Championship' });
assert.equal(NSISC.maxTotalEntriesPerSwimmer, 7, 'fixture depends on the NSISC total cap being 7');

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} — ${msg}`);
};

/** Individual swim row. */
function ind(id, name, event, extra = {}) {
  return {
    id,
    rank: 1,
    name,
    classYear: 'JR',
    team: TEAM,
    time: '50.00',
    points: 0,
    event,
    gender: MEN,
    isRelay: false,
    roundSwam: 'Preliminaries',
    ...extra,
  };
}

/** One relay LEG. Distinct `event` => distinct relayEntryKey => distinct entry. */
function relayLeg(id, name, event, extra = {}) {
  return {
    id,
    rank: 1,
    name,
    classYear: 'JR',
    team: TEAM,
    time: '21.00',
    relayTeamTime: '1:24.00',
    points: 0,
    event,
    gender: MEN,
    isRelay: true,
    relayLegIndex: 1,
    roundSwam: 'A Final',
    ...extra,
  };
}

/** A live alias link: `aliasName` resolves to `canonicalName`. */
function link(id, aliasName, canonicalName, extra = {}) {
  return {
    id,
    gender: MEN,
    team: TEAM,
    canonicalName,
    aliasName,
    source: 'manual',
    createdAt: '2026-08-16T00:00:00.000Z',
    ...extra,
  };
}

const countOf = (rows, name, resolver) =>
  resolver === undefined
    ? countSwimmerEntries(rows, TEAM, MEN, name)
    : countSwimmerEntries(rows, TEAM, MEN, name, resolver);

// ============================================================================
// FIXTURE A — a clean 3 + 7 split with NO overlapping entries, so the merged
// count is the exact sum. This is the shape the brief describes; fixture C below
// carries the real (partially overlapping) production data.
// ============================================================================

const CANON = 'Oliver Pozvai'; // 7 entries: 4 individual + 3 relay
const ALIAS = 'Olivér Pózvai'; // 3 entries: 2 individual + 1 relay

const DISJOINT = [
  ind('c1', CANON, 'Event 8 Men 50 Yard Freestyle'),
  ind('c2', CANON, 'Event 24 Men 100 Yard Backstroke'),
  ind('c3', CANON, 'Event 35 Men 100 Yard Freestyle'),
  ind('c4', CANON, 'Event 6 Men 200 Yard IM'),
  relayLeg('c5', CANON, 'Event 11 Men 4x50 Yard Medley Relay'),
  relayLeg('c6', CANON, 'Event 31 Men 4x50 Yard Freestyle Relay'),
  relayLeg('c7', CANON, 'Event 42 Men 4x100 Yard Freestyle Relay'),

  ind('a1', ALIAS, 'Event 13 Men 100 Yard Butterfly'),
  ind('a2', ALIAS, 'Event 28 Men 200 Yard Butterfly'),
  relayLeg('a3', ALIAS, 'Event 20 Men 4x100 Yard Medley Relay'),

  // An unrelated athlete who must never be swept into the merge.
  ind('z1', 'Ryan Johnson', 'Event 8 Men 50 Yard Freestyle'),
  ind('z2', 'Ryan Johnson', 'Event 35 Men 100 Yard Freestyle'),
];

const LINKED = buildAliasResolver({ athleteAliases: [link('L1', ALIAS, CANON)] });

// --- 1. 3 + 7 linked spellings count as ONE athlete with 10 entries, over cap -
{
  const merged = countOf(DISJOINT, CANON, LINKED);
  assert.equal(merged.total, 10, '3 + 7 linked entries count as 10 against one cap');
  assert.equal(
    merged.total,
    merged.individual + merged.relayCount,
    'total stays consistent with individual + relayCount under merging'
  );

  const over = swimmerExceedsEntryLimits(merged, NSISC);
  assert.equal(over.totalOver, true, '10 entries trips the NSISC cap of 7');
  assert.equal(
    canAcceptAnotherEntry(merged, NSISC, 'Event 26 Men 100 Yard Breaststroke'),
    false,
    'an athlete already over the cap cannot accept another entry'
  );
  ok('two linked spellings (3 + 7) count as one athlete with 10 entries, over the 7 cap');
}

// --- 2. WITHOUT a resolver the default is byte-identical to today -------------
// This is the assertion that proves the default is safe: every existing caller
// (none of which passes a resolver) keeps its exact current behaviour — and it
// documents the bug, because BOTH halves report compliant.
{
  const canonOnly = countOf(DISJOINT, CANON);
  const aliasOnly = countOf(DISJOINT, ALIAS);

  assert.equal(canonOnly.total, 7, 'no resolver: the canonical spelling counts only its own 7');
  assert.equal(aliasOnly.total, 3, 'no resolver: the alias spelling counts only its own 3');
  assert.equal(
    swimmerExceedsEntryLimits(canonOnly, NSISC).totalOver,
    false,
    'THE BUG: the 7-entry half reports compliant (at the cap, not over)'
  );
  assert.equal(
    swimmerExceedsEntryLimits(aliasOnly, NSISC).totalOver,
    false,
    'THE BUG: the 3-entry half reports compliant, so a 10-entry human is invisible'
  );

  // Omitting the argument must equal passing IDENTITY_ALIAS_RESOLVER exactly.
  for (const nm of [CANON, ALIAS, 'Ryan Johnson']) {
    const omitted = countOf(DISJOINT, nm);
    const explicit = countOf(DISJOINT, nm, IDENTITY_ALIAS_RESOLVER);
    assert.equal(omitted.individual, explicit.individual, `${nm}: individual unchanged`);
    assert.equal(omitted.relayCount, explicit.relayCount, `${nm}: relayCount unchanged`);
    assert.equal(omitted.total, explicit.total, `${nm}: total unchanged`);
    assert.deepEqual(
      [...omitted.relayEvents].sort(),
      [...explicit.relayEvents].sort(),
      `${nm}: relayEvents set unchanged`
    );
  }
  ok('default (omitted resolver) === IDENTITY_ALIAS_RESOLVER, and reproduces the pre-fix undercount');
}

// --- 3. either spelling returns the SAME merged count ------------------------
// The caller decides which spelling it holds (a roster row carries the canonical
// one, a raw result row may carry either). Both must answer identically.
{
  const viaCanonical = countOf(DISJOINT, CANON, LINKED);
  const viaAlias = countOf(DISJOINT, ALIAS, LINKED);

  assert.equal(viaAlias.total, viaCanonical.total, 'querying by the alias spelling gives the merged total');
  assert.equal(viaAlias.individual, viaCanonical.individual, 'individual matches');
  assert.equal(viaAlias.relayCount, viaCanonical.relayCount, 'relayCount matches');
  assert.deepEqual(
    [...viaAlias.relayEvents].sort(),
    [...viaCanonical.relayEvents].sort(),
    'the same relay entries are attributed either way'
  );
  ok('querying by either spelling returns the identical merged count');
}

// --- 3b. a spelling with ZERO rows still resolves (the silent-empty case) ----
// `buildScoringBundle` (scoringEngine.ts) eagerly rewrites every row's name to
// the canonical spelling when the workspace has alias links. So in that pipeline
// the ALIAS spelling matches no row at all — and today `countSwimmerEntries`
// answers 0 entries / compliant for a real athlete. Measured live on "Blank
// Workspace 1": querying "Olivér Pózvai" against the projected bundle returns 0,
// not 8. An absent lookup must never be indistinguishable from "no entries".
{
  const rewritten = DISJOINT.map(r =>
    r.name === ALIAS ? { ...r, name: CANON } : r
  );

  const silent = countOf(rewritten, ALIAS);
  assert.equal(silent.total, 0, "THE BUG: today the alias spelling matches nothing and reports 0 entries");
  assert.equal(
    swimmerExceedsEntryLimits(silent, NSISC).totalOver,
    false,
    'and a silent zero reports compliant, which is the worst possible answer'
  );

  const resolved = countOf(rewritten, ALIAS, LINKED);
  assert.equal(resolved.total, 10, 'with a resolver the alias spelling reaches the merged athlete');
  assert.equal(
    resolved.total,
    countOf(rewritten, CANON, LINKED).total,
    'and agrees with the canonical spelling'
  );
  assert.equal(swimmerExceedsEntryLimits(resolved, NSISC).totalOver, true, 'and correctly trips the cap');
  ok('a spelling whose rows were rewritten away still resolves, instead of silently counting 0');
}

// --- 4. the individual / relay split survives merging ------------------------
// A merged total that is right while its parts are wrong would still mis-drive
// per-type caps and the "N/7 total (x ind · y relay)" label.
{
  const canonOnly = countOf(DISJOINT, CANON);
  const aliasOnly = countOf(DISJOINT, ALIAS);
  const merged = countOf(DISJOINT, CANON, LINKED);

  assert.equal(canonOnly.individual, 4);
  assert.equal(canonOnly.relayCount, 3);
  assert.equal(aliasOnly.individual, 2);
  assert.equal(aliasOnly.relayCount, 1);

  assert.equal(
    merged.individual,
    canonOnly.individual + aliasOnly.individual,
    'merged individual count is the sum of the halves (disjoint events)'
  );
  assert.equal(
    merged.relayCount,
    canonOnly.relayCount + aliasOnly.relayCount,
    'merged relay count is the sum of the halves (disjoint relay entries)'
  );
  assert.equal(merged.relayEvents.size, merged.relayCount, 'relayCount tracks the relayEvents set');
  assert.equal(merged.total, merged.individual + merged.relayCount, 'total === individual + relayCount');
  ok('the individual / relay split survives merging and total stays consistent');
}

// --- 4b. two spellings on the SAME entry are counted ONCE, not twice ---------
// One human occupies one relay slot and swims one event however the leg or entry
// was spelled. Merging must not manufacture entries.
{
  const sameEntry = [
    // Same individual event under both spellings.
    ind('s1', CANON, 'Event 8 Men 50 Yard Freestyle'),
    ind('s2', ALIAS, 'Event 8 Men 50 Yard Freestyle'),
    // Same relay entry (same event, round, rank and clock) under both spellings.
    relayLeg('s3', CANON, 'Event 11 Men 4x50 Yard Medley Relay', { relayLegIndex: 1 }),
    relayLeg('s4', ALIAS, 'Event 11 Men 4x50 Yard Medley Relay', { relayLegIndex: 2 }),
  ];
  const merged = countOf(sameEntry, CANON, LINKED);
  assert.equal(merged.individual, 1, 'one individual event, not two');
  assert.equal(merged.relayCount, 1, 'one relay entry, not two');
  assert.equal(merged.total, 2, 'merging dedups shared entries rather than double counting');
  ok('spellings sharing an entry are counted once, not doubled');
}

// --- 5. a suppressed alias does NOT merge ------------------------------------
// A dismissed pair is a recorded human decision that these are two people, each
// with an independent cap.
{
  const suppressed = buildAliasResolver({
    athleteAliases: [
      link('S1', ALIAS, CANON, {
        status: 'suppressed',
        provenance: {
          origin: 'user',
          suppressedReason: 'user_reject',
          suppressedAt: '2026-08-16T00:00:00.000Z',
        },
      }),
    ],
  });
  assert.equal(
    suppressed.resolveAthleteName(ALIAS, TEAM, MEN),
    ALIAS,
    'a tombstone resolves nothing'
  );

  assert.equal(countOf(DISJOINT, CANON, suppressed).total, 7, 'suppressed: canonical keeps its own 7');
  assert.equal(countOf(DISJOINT, ALIAS, suppressed).total, 3, 'suppressed: alias keeps its own 3');
  assert.equal(
    swimmerExceedsEntryLimits(countOf(DISJOINT, CANON, suppressed), NSISC).totalOver,
    false,
    'a suppressed pair is two compliant athletes, not one violation'
  );
  ok('a status:"suppressed" alias never merges two entry counts');
}

// --- 6. genuinely unrelated athletes are never merged ------------------------
{
  const lookAlikes = [
    ind('u1', 'Ryan Johnson', 'Event 8 Men 50 Yard Freestyle'),
    ind('u2', 'Ryan Johnson', 'Event 35 Men 100 Yard Freestyle'),
    ind('u3', 'Ryan Johnston', 'Event 6 Men 200 Yard IM'),
    ind('u4', 'Ryan Johnston', 'Event 13 Men 100 Yard Butterfly'),
    ind('u5', 'Ryan Johnston', 'Event 24 Men 100 Yard Backstroke'),
  ];

  // The Pózvai link must not bleed onto anyone else.
  assert.equal(countOf(lookAlikes, 'Ryan Johnson', LINKED).total, 2, 'unlinked athlete keeps his own 2');
  assert.equal(countOf(lookAlikes, 'Ryan Johnston', LINKED).total, 3, 'the near-miss name keeps his own 3');

  // No link => no merge, however similar the spellings. The counter never guesses.
  assert.equal(countOf(lookAlikes, 'Ryan Johnson').total, 2, 'no link, no merge');

  // A link scoped to the WOMEN's roster must not merge these men.
  const wrongGender = buildAliasResolver({
    athleteAliases: [{ ...link('W1', 'Ryan Johnston', 'Ryan Johnson'), gender: Gender.WOMEN }],
  });
  assert.equal(
    countOf(lookAlikes, 'Ryan Johnson', wrongGender).total,
    2,
    "a women's-scope link must not merge men's entry counts"
  );

  // A link scoped to ANOTHER team must not merge this team's rows.
  const wrongTeam = buildAliasResolver({
    athleteAliases: [{ ...link('W2', 'Ryan Johnston', 'Ryan Johnson'), team: 'Delta State University' }],
  });
  assert.equal(
    countOf(lookAlikes, 'Ryan Johnson', wrongTeam).total,
    2,
    "another team's link must not merge this team's entry counts"
  );

  // And an unrelated athlete on a DIFFERENT team is never pulled in.
  const otherTeamRows = [
    ...lookAlikes,
    { ...ind('x1', 'Ryan Johnson', 'Event 26 Men 100 Yard Breaststroke'), team: 'Delta State University' },
  ];
  assert.equal(
    countOf(otherTeamRows, 'Ryan Johnson', LINKED).total,
    2,
    'the team filter still applies after resolution'
  );
  ok('unlinked look-alikes, other-gender/other-team links and other teams never merge');
}

// ============================================================================
// FIXTURE C — REGRESSION: the three real Henderson State men pairs, reproduced
// row-for-row from the live "Blank Workspace 1" projected view (menResults +
// recruit rows remapped onto meet event labels). Hermetic: no DB read.
//
// Each pair is 7 competed entries + 3 import-only entries. The merged totals are
// 8 / 9 / 7 rather than 10 because the import rows land on individual events the
// athlete already swam — the same entry, not a new one.
// ============================================================================
{
  const REAL = [
    // --- Oliver Pozvai (7): 3 individual + 4 relay ---------------------------
    ind('p1', 'Oliver Pozvai', 'Event 8 Men 50 Yard Freestyle'),
    ind('p2', 'Oliver Pozvai', 'Event 24 Men 100 Yard Backstroke'),
    ind('p3', 'Oliver Pozvai', 'Event 35 Men 100 Yard Freestyle'),
    relayLeg('p4', 'Oliver Pozvai', 'Event 11 Men 4x50 Yard Medley Relay'),
    relayLeg('p5', 'Oliver Pozvai', 'Event 20 Men 4x100 Yard Medley Relay'),
    relayLeg('p6', 'Oliver Pozvai', 'Event 31 Men 4x50 Yard Freestyle Relay'),
    relayLeg('p7', 'Oliver Pozvai', 'Event 42 Men 4x100 Yard Freestyle Relay'),
    // Olivér Pózvai (3): two duplicate his events, one is new (100 Fly).
    ind('p8', 'Olivér Pózvai', 'Event 8 Men 50 Yard Freestyle', { isRecruit: true }),
    ind('p9', 'Olivér Pózvai', 'Event 35 Men 100 Yard Freestyle', { isRecruit: true }),
    ind('p10', 'Olivér Pózvai', 'Event 13 Men 100 Yard Butterfly', { isRecruit: true }),

    // --- Stevie Balistreri (7): 4 individual + 3 relay -----------------------
    ind('b1', 'Stevie Balistreri', 'Event 6 Men 200 Yard IM'),
    ind('b2', 'Stevie Balistreri', 'Event 13 Men 100 Yard Butterfly'),
    ind('b3', 'Stevie Balistreri', 'Event 28 Men 200 Yard Butterfly'),
    ind('b4', 'Stevie Balistreri', 'Event 33 Men 1650 Yard Freestyle'),
    relayLeg('b5', 'Stevie Balistreri', 'Event 11 Men 4x50 Yard Medley Relay', { roundSwam: 'B Final', rank: 10 }),
    relayLeg('b6', 'Stevie Balistreri', 'Event 20 Men 4x100 Yard Medley Relay', { roundSwam: 'B Final', rank: 10 }),
    relayLeg('b7', 'Stevie Balistreri', 'Event 31 Men 4x50 Yard Freestyle Relay', { roundSwam: 'B Final', rank: 9 }),
    // Steven Balistreri (3): one duplicates 100 Fly, two are new.
    ind('b8', 'Steven Balistreri', 'Event 8 Men 50 Yard Freestyle', { isRecruit: true }),
    ind('b9', 'Steven Balistreri', 'Event 35 Men 100 Yard Freestyle', { isRecruit: true }),
    ind('b10', 'Steven Balistreri', 'Event 13 Men 100 Yard Butterfly', { isRecruit: true }),

    // --- Tristen Fergunson (7): 4 individual + 3 relay -----------------------
    ind('f1', 'Tristen Fergunson', 'Event 8 Men 50 Yard Freestyle'),
    ind('f2', 'Tristen Fergunson', 'Event 13 Men 100 Yard Butterfly'),
    ind('f3', 'Tristen Fergunson', 'Event 26 Men 100 Yard Breaststroke'),
    ind('f4', 'Tristen Fergunson', 'Event 35 Men 100 Yard Freestyle'),
    relayLeg('f5', 'Tristen Fergunson', 'Event 11 Men 4x50 Yard Medley Relay', { roundSwam: 'B Final', rank: 10, relayLegIndex: 3 }),
    relayLeg('f6', 'Tristen Fergunson', 'Event 31 Men 4x50 Yard Freestyle Relay', { relayLegIndex: 1 }),
    relayLeg('f7', 'Tristen Fergunson', 'Event 42 Men 4x100 Yard Freestyle Relay', { roundSwam: 'B Final', rank: 10, relayLegIndex: 2 }),
    // Tristin Ferguson (3): ALL three duplicate events he already swam.
    ind('f8', 'Tristin Ferguson', 'Event 8 Men 50 Yard Freestyle', { isRecruit: true }),
    ind('f9', 'Tristin Ferguson', 'Event 35 Men 100 Yard Freestyle', { isRecruit: true }),
    ind('f10', 'Tristin Ferguson', 'Event 13 Men 100 Yard Butterfly', { isRecruit: true }),
  ];

  const REAL_RESOLVER = buildAliasResolver({
    athleteAliases: [
      link('R1', 'Olivér Pózvai', 'Oliver Pozvai', { provenance: { origin: 'auto' } }),
      link('R2', 'Steven Balistreri', 'Stevie Balistreri', { provenance: { origin: 'auto' } }),
      link('R3', 'Tristin Ferguson', 'Tristen Fergunson', { provenance: { origin: 'auto' } }),
    ],
  });

  const CASES = [
    { canonical: 'Oliver Pozvai', alias: 'Olivér Pózvai', merged: 8, ind: 4, relay: 4, over: true },
    { canonical: 'Stevie Balistreri', alias: 'Steven Balistreri', merged: 9, ind: 6, relay: 3, over: true },
    { canonical: 'Tristen Fergunson', alias: 'Tristin Ferguson', merged: 7, ind: 4, relay: 3, over: false },
  ];

  let hiddenBefore = 0;
  for (const c of CASES) {
    // Halves as they are counted TODAY (no resolver).
    const half7 = countOf(REAL, c.canonical);
    const half3 = countOf(REAL, c.alias);
    assert.equal(half7.total, 7, `${c.canonical}: competed half is 7 entries`);
    assert.equal(half3.total, 3, `${c.alias}: import-only half is 3 entries`);
    assert.equal(
      swimmerExceedsEntryLimits(half7, NSISC).totalOver,
      false,
      `${c.canonical}: today's count reports compliant`
    );
    assert.equal(
      swimmerExceedsEntryLimits(half3, NSISC).totalOver,
      false,
      `${c.alias}: today's count reports compliant`
    );

    // Merged, and reachable identically from either spelling.
    const viaCanonical = countOf(REAL, c.canonical, REAL_RESOLVER);
    const viaAlias = countOf(REAL, c.alias, REAL_RESOLVER);
    assert.equal(viaCanonical.total, c.merged, `${c.canonical}: merged total is ${c.merged}`);
    assert.equal(viaAlias.total, c.merged, `${c.alias}: same merged total from the alias spelling`);
    assert.equal(viaCanonical.individual, c.ind, `${c.canonical}: merged individual is ${c.ind}`);
    assert.equal(viaCanonical.relayCount, c.relay, `${c.canonical}: merged relay is ${c.relay}`);
    assert.equal(
      viaCanonical.total,
      viaCanonical.individual + viaCanonical.relayCount,
      `${c.canonical}: total === individual + relayCount`
    );

    const over = swimmerExceedsEntryLimits(viaCanonical, NSISC);
    assert.equal(over.totalOver, c.over, `${c.canonical}: over the 7 cap === ${c.over}`);
    if (c.over) hiddenBefore += 1;
  }

  assert.equal(
    hiddenBefore,
    2,
    'exactly two real NSISC violations (Pózvai 8, Balistreri 9) become visible; Ferguson sits at 7'
  );

  // Ferguson is AT the cap, not over — but must not be allowed an 8th entry.
  const ferguson = countOf(REAL, 'Tristen Fergunson', REAL_RESOLVER);
  assert.equal(
    canAcceptAnotherEntry(ferguson, NSISC, 'Event 6 Men 200 Yard IM'),
    false,
    'an athlete merged to exactly 7 cannot take an 8th entry'
  );
  // THE BUG, one step short of a violation: a caller holding the OTHER spelling
  // sees a 3-entry athlete and offers four more slots to a swimmer who has none.
  assert.equal(
    canAcceptAnotherEntry(countOf(REAL, 'Tristin Ferguson'), NSISC, 'Event 6 Men 200 Yard IM'),
    true,
    "THE BUG: today's 3-entry half is offered four free slots on a swimmer already at 7"
  );

  ok('the three live Henderson State pairs merge to 8 / 9 / 7 — two hidden NSISC violations surface');
}

console.log('entry limit alias tests: all assertions passed');
