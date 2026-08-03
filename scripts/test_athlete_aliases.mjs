/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Athlete name-aliasing tests (resolver, undo-able patches, suggestion engine,
 * and end-to-end import unification).
 * Run: npx tsx scripts/test_athlete_aliases.mjs
 */
import assert from 'node:assert/strict';
import {
  buildAliasResolver,
  addAliasLink,
  removeAliasLink,
  suggestAliasCandidates,
} from '../packages/core/src/lib/athleteAliases.ts';
import { previewHistoryImportActions } from '../packages/core/src/lib/historyImportRoster.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const WOMEN = Gender.WOMEN;

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

function link(id, aliasName, canonicalName, gender, team) {
  return { id, aliasName, canonicalName, gender, team, source: 'manual' };
}

/** Apply a patch then its inverse and assert the workspace is byte-for-byte restored. */
function assertRoundTrip(ws, ep, label) {
  const applied = { ...ws, ...ep.patch };
  const undone = { ...applied, ...ep.inverse };
  assert.deepStrictEqual(undone, ws, `${label}: inverse round-trips`);
  assert.notDeepStrictEqual(applied, ws, `${label}: patch changed the workspace`);
}

// --- resolver: transitivity -------------------------------------------------
{
  const links = [
    link('l1', 'Stevie Balistreri', 'Steve Balistreri', MEN),
    link('l2', 'Steve Balistreri', 'Steven Balistreri', MEN),
  ];
  const r = buildAliasResolver(links);
  assert.equal(
    r.resolveAthleteName('Stevie Balistreri', 'HSU', MEN),
    'Steven Balistreri',
    'A→B→C resolves transitively to C'
  );
  assert.equal(r.resolveAthleteName('Steve Balistreri', 'HSU', MEN), 'Steven Balistreri', 'B→C');
  assert.equal(r.resolveAthleteName('Unknown Person', 'HSU', MEN), 'Unknown Person', 'unlinked = identity');
  assert.ok(r.areLinked('Stevie Balistreri', 'Steven Balistreri', 'HSU', MEN), 'areLinked transitively');
  ok('resolver resolves transitively and defaults to identity');
}

// --- resolver: diacritic folding + cycle safety -----------------------------
{
  const folded = buildAliasResolver([link('l1', 'Jose Gonzalez', 'José González', MEN)]);
  assert.equal(
    folded.resolveAthleteName('JOSE   GONZALEZ', undefined, MEN),
    'José González',
    'diacritic + case + whitespace folding on the alias key'
  );

  // A→B, B→A must terminate (cycle-safe).
  const cyclic = buildAliasResolver([
    link('c1', 'A Name', 'B Name', MEN),
    link('c2', 'B Name', 'A Name', MEN),
  ]);
  const out = cyclic.resolveAthleteName('A Name', undefined, MEN);
  assert.ok(out === 'B Name' || out === 'A Name', 'cycle resolves to a fixed value without hanging');
  ok('resolver folds diacritics and is cycle-safe');
}

// --- resolver: "Last, First" comma-order folding ----------------------------
{
  // Link created FROM the comma-order spelling resolves for the natural order.
  const fromComma = buildAliasResolver([link('cf1', 'Balistreri, Stevie', 'Steven Balistreri', MEN)]);
  assert.equal(
    fromComma.resolveAthleteName('Stevie Balistreri', undefined, MEN),
    'Steven Balistreri',
    'link stored as "Balistreri, Stevie" resolves a "Stevie Balistreri" query'
  );

  // And vice versa: natural-order link resolves a comma-order query.
  const fromNatural = buildAliasResolver([link('cf2', 'Stevie Balistreri', 'Steven Balistreri', MEN)]);
  assert.equal(
    fromNatural.resolveAthleteName('Balistreri, Stevie', undefined, MEN),
    'Steven Balistreri',
    'link stored as "Stevie Balistreri" resolves a "Balistreri, Stevie" query'
  );

  // Backward compatibility: a PRE-EXISTING stored link whose aliasName was
  // saved un-folded (comma order, before the fold change) must still resolve —
  // keys are computed at build/lookup time, never persisted.
  const legacy = buildAliasResolver([
    { id: 'legacy1', aliasName: 'Balistreri, Stevie', canonicalName: 'Steven Balistreri', gender: MEN, team: 'HSU', source: 'manual' },
  ]);
  assert.equal(
    legacy.resolveAthleteName('Balistreri, Stevie', 'HSU', MEN),
    'Steven Balistreri',
    'legacy un-folded stored link still resolves its own spelling'
  );
  assert.equal(
    legacy.resolveAthleteName('Stevie Balistreri', 'HSU', MEN),
    'Steven Balistreri',
    'legacy un-folded stored link resolves the folded spelling too'
  );
  assert.ok(
    legacy.areLinked('Balistreri, Stevie', 'Steven Balistreri', 'HSU', MEN),
    'areLinked matches across comma order for legacy links'
  );

  // Canonical stored in comma order: identity keys still unify.
  const commaCanonical = buildAliasResolver([link('cf3', 'Stevie Balistreri', 'Balistreri, Steven', MEN)]);
  assert.ok(
    commaCanonical.areLinked('Stevie Balistreri', 'Steven Balistreri', undefined, MEN),
    'comma-order canonicalName unifies with the natural-order identity'
  );

  // Suffix safety: two-comma suffix forms are NOT folded (left as-is).
  const suffix = buildAliasResolver([link('sf1', 'Malone, Curtis, Jr.', 'Curtis Malone Jr.', MEN)]);
  assert.equal(
    suffix.resolveAthleteName('Malone, Curtis, Jr.', undefined, MEN),
    'Curtis Malone Jr.',
    'suffix form resolves via its own literal key'
  );
  assert.equal(
    suffix.resolveAthleteName('Curtis Jr. Malone', undefined, MEN),
    'Curtis Jr. Malone',
    'two-comma suffix names are not reordered (suffix-safe)'
  );
  ok('aliasNameKey folds "Last, First" and stays backward compatible with stored links');
}

// --- resolver: team/gender scoping precedence -------------------------------
{
  const r = buildAliasResolver([
    link('g1', 'Sam Smith', 'Samuel Smith', MEN), // global (no team)
    link('t1', 'Sam Smith', 'Sammy Smith', MEN, 'HSU'), // team-scoped
  ]);
  assert.equal(r.resolveAthleteName('Sam Smith', 'HSU', MEN), 'Sammy Smith', 'team-scoped link wins for its team');
  assert.equal(r.resolveAthleteName('Sam Smith', 'RIV', MEN), 'Samuel Smith', 'other team falls back to global');
  assert.equal(r.resolveAthleteName('Sam Smith', undefined, MEN), 'Samuel Smith', 'no team → global');
  // Gender scoping: a men's link must not apply to a women's query.
  assert.equal(r.resolveAthleteName('Sam Smith', 'HSU', WOMEN), 'Sam Smith', 'gender scoping isolates links');
  ok('resolver honors team/gender scope precedence');
}

// --- add / remove alias link round-trips ------------------------------------
{
  const ws = { id: 'ws', name: 'Alias Test', createdAt: 1, menResults: [], womenResults: [], recruits: [], athleteAliases: [] };
  const add = addAliasLink(ws, {
    canonicalName: 'Steven Balistreri',
    aliasName: 'Stevie Balistreri',
    gender: MEN,
    team: 'HSU',
  });
  assert.equal(add.patch.athleteAliases.length, 1, 'link appended');
  assert.equal(add.patch.athleteAliases[0].team, 'HSU', 'team carried through');
  assert.equal(add.patch.athleteAliases[0].source, 'manual', 'default source manual');
  assertRoundTrip(ws, add, 'addAliasLink');

  const wsWith = { ...ws, athleteAliases: [{ id: 'x1', aliasName: 'A', canonicalName: 'B', gender: MEN, source: 'manual' }] };
  assertRoundTrip(wsWith, removeAliasLink(wsWith, 'x1'), 'removeAliasLink');
  ok('addAliasLink / removeAliasLink patches round-trip');
}

// --- suggestion engine: motivating positive cases ---------------------------
{
  const existing = [
    { name: 'Steven Balistreri', team: 'HSU', gender: MEN },
    { name: 'Alan Gonzalez', team: 'HSU', gender: MEN },
    { name: 'Steven Balistreri', team: 'HSU', gender: MEN },
  ];
  const incoming = [
    { name: 'Stevie Balistreri', team: 'HSU', gender: MEN }, // nickname
    { name: 'Alan Gabriel Gonzalez Rodriguez', team: 'HSU', gender: MEN }, // long-form 4-token
    { name: 'Balistreri, Stevie', team: 'HSU', gender: MEN }, // comma order + nickname
    { name: 'Balistreri, Steven', team: 'HSU', gender: MEN }, // comma order, same identity
  ];
  const suggestions = suggestAliasCandidates(existing, incoming);

  const nickname = suggestions.find(s => s.incoming.name === 'Stevie Balistreri');
  assert.ok(nickname, 'Steven/Stevie Balistreri is suggested');
  assert.ok(nickname.score >= 0.6, `nickname score above threshold (${nickname?.score})`);

  const longForm = suggestions.find(s => s.incoming.name === 'Alan Gabriel Gonzalez Rodriguez');
  assert.ok(longForm, 'Alan Gonzalez ⊂ long-form 4-token name is suggested');
  assert.equal(longForm.existing.name, 'Alan Gonzalez', 'long-form matched to short roster name');

  // 'Balistreri, Stevie' folds to the SAME identity key as 'Stevie Balistreri',
  // so the stevie/steven pair is suggested exactly once (deduped across the
  // comma spelling) — not once per spelling.
  const stevieSuggestions = suggestions.filter(
    s => s.incoming.name === 'Stevie Balistreri' || s.incoming.name === 'Balistreri, Stevie'
  );
  assert.equal(stevieSuggestions.length, 1, 'comma spelling dedupes onto the same folded pair (one suggestion)');
  assert.equal(stevieSuggestions[0].existing.name, 'Steven Balistreri', 'folded pair matched to roster name');

  // "Balistreri, Steven" now FOLDS to the same identity key as "Steven
  // Balistreri" (aliasNameKey uses canonicalSwimmerName), so it is identical
  // after normalization — no link is needed and no suggestion is made.
  const commaSame = suggestions.find(s => s.incoming.name === 'Balistreri, Steven');
  assert.equal(commaSame, undefined, 'comma order of the SAME name folds to the same key — not suggested');

  // Sorted descending by score.
  for (let i = 1; i < suggestions.length; i += 1) {
    assert.ok(suggestions[i - 1].score >= suggestions[i].score, 'suggestions sorted desc by score');
  }
  ok('suggestion engine surfaces nickname, long-form, and comma-order cases');
}

// --- suggestion engine: NEGATIVE case (two brothers, same surname) ----------
{
  const existing = [{ name: 'Alan Gonzalez', team: 'HSU', gender: MEN }];
  const incoming = [{ name: 'Roberto Gonzalez', team: 'HSU', gender: MEN }]; // brother, unrelated first name
  const suggestions = suggestAliasCandidates(existing, incoming);
  assert.equal(suggestions.length, 0, 'two different people sharing only a surname are NOT suggested');

  // Gender mismatch never suggested even with a related name.
  const crossGender = suggestAliasCandidates(
    [{ name: 'Steven Balistreri', team: 'HSU', gender: MEN }],
    [{ name: 'Stevie Balistreri', team: 'HSU', gender: WOMEN }]
  );
  assert.equal(crossGender.length, 0, 'cross-gender pairs never suggested');
  ok('suggestion engine excludes unrelated surname-sharing and cross-gender pairs');
}

// --- suggestion engine: excludes already-linked + identical -----------------
{
  const existing = [{ name: 'Steven Balistreri', team: 'HSU', gender: MEN }];
  const incoming = [
    { name: 'Stevie Balistreri', team: 'HSU', gender: MEN },
    { name: 'steven  balistreri', team: 'HSU', gender: MEN }, // identical after normalization
  ];
  const resolver = buildAliasResolver([link('l1', 'Stevie Balistreri', 'Steven Balistreri', MEN, 'HSU')]);
  const suggestions = suggestAliasCandidates(existing, incoming, { resolver });
  assert.equal(suggestions.length, 0, 'already-linked and identical-after-normalization pairs excluded');
  ok('suggestion engine excludes already-linked and identical pairs');
}

// --- end-to-end: a confirmed link makes import treat alias as SAME athlete ---
{
  const rosterSwim = {
    id: 'm1',
    rank: 1,
    name: 'Steven Balistreri',
    classYear: 'JR',
    team: 'HSU',
    time: '21.00',
    points: 0,
    event: '50 Freestyle',
    gender: MEN,
    isRelay: false,
    roundSwam: 'A Final',
  };
  const preview = [
    { name: 'Stevie Balistreri', team: 'HSU', gender: MEN, event: '50 Freestyle', time: '20.50', timeType: 'SCY', source: 'paste' },
  ];

  // Without a link: the nickname reads as a brand-new recruit.
  const wsNoLink = { id: 'w', name: 'Import', createdAt: 1, menResults: [rosterSwim], womenResults: [], recruits: [], meetEntryPlans: [], athleteAliases: [] };
  const before = previewHistoryImportActions(wsNoLink, preview, { team: 'HSU', gender: MEN });
  assert.equal(before.length, 1, 'one swimmer previewed');
  assert.equal(before[0].action, 'new_recruit', 'without a link the alias is a NEW recruit');
  assert.equal(before[0].matchedRosterName, null, 'no roster match without a link');

  // With the confirmed link: the nickname unifies onto the existing athlete.
  const wsLinked = {
    ...wsNoLink,
    athleteAliases: [link('l1', 'Stevie Balistreri', 'Steven Balistreri', MEN, 'HSU')],
  };
  const after = previewHistoryImportActions(wsLinked, preview, { team: 'HSU', gender: MEN });
  assert.equal(after.length, 1, 'one swimmer previewed (linked)');
  assert.notEqual(after[0].action, 'new_recruit', 'linked alias is NOT a new recruit');
  assert.equal(after[0].matchedRosterName, 'Steven Balistreri', 'linked alias matches existing roster athlete');
  ok('confirmed alias link makes import treat the nickname as the SAME athlete');
}

console.log(`\n${n} checks passed`);
