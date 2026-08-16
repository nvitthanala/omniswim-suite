/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards the standing duplicate-athlete scan on the lineup compliance checklist.
 *
 * The bug: `suggestAliasCandidates` only ran at IMPORT time, from the two import
 * panels. Nothing re-scanned a workspace that was already split, so a workspace
 * built before the detector existed — or one where the user closed the import
 * panel without acting — stayed split forever with no indication. A live
 * workspace held 181 distinct name strings against 6 aliases, with four athletes
 * living under two spellings each ("Camden Mask"/"Cam Mask",
 * "Steven Balistreri"/"Stevie Balistreri", "Afonso Campanico"/"Alfonso
 * Campanico", "Alan Alejan Gonzalez Mujica"/"Alan Gonzalez Mujica"). Each half
 * sat under the 7-event NSISC cap independently, so both halves got ranked and
 * entered, and the point-arbitrage panel listed both as separate cards.
 *
 * The false-positive half matters just as much: a standing checklist item that
 * cries wolf gets ignored, so sibling pairs and one-letter-apart surnames must
 * NOT be reported. Section 4 locks that down against the real trap set.
 *
 * Test: npx tsx scripts/test_duplicate_athletes.mjs
 */
import assert from 'node:assert/strict';
import { Gender } from '../packages/core/src/types.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import {
  buildTeamLineupAudit,
  detectDuplicateAthletes,
  dismissDuplicateAthletePair,
  linkDuplicateAthletePair,
} from '../packages/core/src/lib/rosterLineupAudit.ts';
import { buildAliasResolver, isAliasSuppression } from '../packages/core/src/lib/athleteAliases.ts';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection.ts';
import { calculatePoints, normalizeSwimmerName } from '../packages/core/src/lib/utils.ts';

const TEAM = 'Henderson State University';

let seq = 0;
const nextId = () => `row-${(seq += 1)}`;

/** A competed individual result row (counts as `competed` evidence). */
function meetSwim(name, event, time, classYear = 'JR') {
  return {
    id: nextId(),
    rank: 1,
    name,
    classYear,
    team: TEAM,
    time,
    points: 0,
    event,
    gender: Gender.MEN,
    roundSwam: 'A Final',
  };
}

/** A SwimCloud-style imported swim (import-only evidence, never `competed`). */
function importedSwim(name, event, time) {
  return {
    id: nextId(),
    name,
    team: TEAM,
    gender: Gender.MEN,
    event,
    time,
    timeType: 'SCY',
    classYear: 'FR',
    source: 'paste',
  };
}

function relayLegs(names, years, event = '200 Freestyle Relay') {
  const relayNames = names.map((n, i) => ({ name: n, year: years[i] }));
  return names.map((name, i) => ({
    id: `relay-${event}-${i}`,
    rank: 1,
    name,
    classYear: years[i],
    team: TEAM,
    time: '1:22.00',
    points: 0,
    event,
    gender: Gender.MEN,
    isRelay: true,
    relayLegIndex: i,
    roundSwam: 'A Final',
    relayNames,
  }));
}

function workspace(overrides = {}) {
  return {
    id: 'dup-ws',
    name: 'Duplicate athlete detection',
    createdAt: Date.now(),
    menResults: [],
    womenResults: [],
    recruits: [],
    athleteHistory: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    athleteAliases: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    ...overrides,
  };
}

/** Run the real projection pipeline, then the audit — same path the UI takes. */
function auditOf(ws, opts = {}) {
  const projected = buildWhatIfResults({
    workspace: ws,
    gender: Gender.MEN,
    removeSeniors: opts.removeSeniors ?? false,
  });
  return buildTeamLineupAudit({
    workspace: ws,
    gender: Gender.MEN,
    team: TEAM,
    settings: ws.scoringSettings,
    allResults: projected,
    allScored: calculatePoints(projected, ws.scoringSettings),
    removeSeniors: opts.removeSeniors ?? false,
    ...(opts.detectDuplicates == null ? {} : { detectDuplicates: opts.detectDuplicates }),
  });
}

const duplicateItems = audit => audit.checklistItems.filter(i => i.type === 'duplicate_athlete');

/** Does an item name BOTH spellings (in its message or its payload)? */
function namesBoth(item, a, b) {
  const inMessage = item.message.includes(a) && item.message.includes(b);
  const pair = item.duplicate;
  const inPayload =
    pair != null &&
    [pair.canonicalName, pair.aliasName].sort().join('|') === [a, b].sort().join('|');
  return inMessage && inPayload;
}

// --- 1. A split athlete produces exactly one checklist item naming both ------
{
  const ws = workspace({
    // "Camden Mask" raced; "Cam Mask" only exists in an imported SwimCloud paste.
    menResults: [meetSwim('Camden Mask', '100 Breaststroke', '55.52')],
    athleteHistory: [importedSwim('Cam Mask', '200 Breaststroke', '2:02.10')],
  });

  const items = duplicateItems(auditOf(ws));
  assert.equal(
    items.length,
    1,
    `expected exactly one duplicate item, got ${JSON.stringify(items.map(i => i.message))}`
  );
  assert.ok(
    namesBoth(items[0], 'Camden Mask', 'Cam Mask'),
    `item must name both spellings, got "${items[0].message}"`
  );
  assert.equal(items[0].group, 'roster', 'duplicate items live in the roster group');
  assert.ok(items[0].duplicate, 'item must carry the pair payload for Link / dismiss');
  // The competed spelling is the one that survives the link (published record).
  assert.equal(items[0].duplicate.canonicalName, 'Camden Mask');
  assert.equal(items[0].duplicate.aliasName, 'Cam Mask');
  assert.equal(items[0].duplicate.team, TEAM);
  assert.equal(items[0].duplicate.gender, Gender.MEN);

  // Both spellings are badged on the athlete rows, not just in the checklist.
  const issuesFor = n => auditOf(ws).athleteIssues.get(normalizeSwimmerName(n)) ?? [];
  assert.ok(issuesFor('Camden Mask').some(i => i.type === 'duplicate_athlete'));
  assert.ok(issuesFor('Cam Mask').some(i => i.type === 'duplicate_athlete'));

  // Opting out is possible, and is the ONLY way to get silence here.
  assert.equal(duplicateItems(auditOf(ws, { detectDuplicates: false })).length, 0);
}

// --- 2. All four real HSU splits are detected, on a recruit-driven workspace -
//
// This is the case `planAutoAliasLinks` alone cannot reach: with no meet loaded
// NEITHER spelling has competed, so every pair scores `tier: null` under the
// auto-link rules and would be silently missed. The HSU planning workflow is
// exactly this shape (SwimCloud imports + planned entries, no PDF).
{
  const pairs = [
    ['Alan Alejan Gonzalez Mujica', 'Alan Gonzalez Mujica'],
    ['Camden Mask', 'Cam Mask'],
    ['Steven Balistreri', 'Stevie Balistreri'],
    ['Alfonso Campanico', 'Afonso Campanico'],
  ];
  const ws = workspace({
    athleteHistory: pairs.flatMap(([a, b], i) => [
      importedSwim(a, '50 Freestyle', `2${i}.11`),
      importedSwim(b, '100 Freestyle', `4${i}.22`),
    ]),
  });

  const found = detectDuplicateAthletes(ws, { team: TEAM, gender: Gender.MEN });
  assert.equal(found.length, 4, `expected all four splits, got ${JSON.stringify(found)}`);
  for (const [a, b] of pairs) {
    assert.ok(
      found.some(p => [p.canonicalName, p.aliasName].sort().join('|') === [a, b].sort().join('|')),
      `missed the "${a}" / "${b}" split`
    );
  }
  // Name shape alone never claims auto-link authority here.
  assert.ok(found.every(p => p.autoLinkable === false && p.tier === 'moderate'));
  assert.equal(duplicateItems(auditOf(ws)).length, 4);
}

// --- 2b. Surname typo + diacritics: the other two real HSU shapes -----------
{
  // "Tristen Fergunson" (meet PDF) vs "Tristin Ferguson" (recruit) differs in
  // BOTH names by one letter. That class is capped at `strong` — it is reported
  // only because the two spellings share exact individual-event times. The
  // relay clock (all four legs carry 1:31.73) can never corroborate a pair.
  const ws = workspace({
    menResults: [
      meetSwim('Tristen Fergunson', '50 Freestyle', '20.59'),
      meetSwim('Tristen Fergunson', '100 Freestyle', '46.50'),
      ...relayLegs(
        ['Tristen Fergunson', 'Stevie Balistreri', 'Ace Alpha', 'Dan Delta'],
        ['JR', 'SO', 'JR', 'FR'],
        '200 Medley Relay'
      ),
    ],
    athleteHistory: [
      importedSwim('Tristin Ferguson', '50 Freestyle', '20.59'),
      importedSwim('Tristin Ferguson', '100 Freestyle', '46.50'),
    ],
  });

  const found = detectDuplicateAthletes(ws, { team: TEAM, gender: Gender.MEN });
  const ferg = found.find(p => p.aliasName === 'Tristin Ferguson');
  assert.ok(ferg, `expected the surname-typo split, got ${JSON.stringify(found)}`);
  assert.equal(ferg.tier, 'strong', 'a near-surname pair needs time corroboration');
  assert.ok(ferg.timeMatches.length >= 1, 'the shared individual times must be carried');
  assert.ok(
    ferg.timeMatches.every(t => !/relay/i.test(t.event)),
    'a relay clock may never corroborate a pair'
  );
  // The four relay legs share 1:31.73 but are four different humans.
  assert.equal(
    found.filter(p => p.canonicalName === 'Stevie Balistreri' || p.aliasName === 'Stevie Balistreri')
      .length,
    0,
    'sharing a relay team time is not evidence of anything'
  );

  // Diacritics-only: the same identity key by the codebase's own definition.
  const accents = workspace({
    menResults: [meetSwim('Olivér Pózvai', '200 Butterfly', '1:48.90')],
    athleteHistory: [importedSwim('Oliver Pozvai', '100 Butterfly', '49.80')],
  });
  const acc = detectDuplicateAthletes(accents, { team: TEAM, gender: Gender.MEN });
  assert.equal(acc.length, 1);
  assert.equal(acc[0].tier, 'conclusive');
  assert.equal(acc[0].canonicalName, 'Olivér Pózvai', 'the competed spelling is the record');
}

// --- 3. An already-linked pair produces NO item ------------------------------
{
  const base = workspace({
    menResults: [meetSwim('Camden Mask', '100 Breaststroke', '55.52')],
    athleteHistory: [importedSwim('Cam Mask', '200 Breaststroke', '2:02.10')],
  });
  assert.equal(duplicateItems(auditOf(base)).length, 1, 'precondition: one item before linking');

  const pair = duplicateItems(auditOf(base))[0].duplicate;
  const { patch, inverse, description } = linkDuplicateAthletePair(base, pair);
  const linked = { ...base, ...patch };

  assert.equal(duplicateItems(auditOf(linked)).length, 0, 'a linked pair must stop being reported');
  assert.equal(detectDuplicateAthletes(linked, { team: TEAM, gender: Gender.MEN }).length, 0);

  // The link is a live alias row (not a tombstone) and actually resolves.
  const link = (patch.athleteAliases ?? []).find(l => !isAliasSuppression(l));
  assert.ok(link, 'expected a live alias link row');
  assert.equal(link.canonicalName, 'Camden Mask');
  assert.equal(link.aliasName, 'Cam Mask');
  assert.equal(link.provenance.origin, 'user', 'a checklist Link is a human decision');
  assert.equal(
    buildAliasResolver(linked).resolveAthleteName('Cam Mask', TEAM, Gender.MEN),
    'Camden Mask'
  );
  assert.ok(description.includes('Cam Mask'));
  assert.deepEqual(inverse.athleteAliases, [], 'undo restores the prior alias array');
}

// --- 4. Genuinely different athletes produce NO item ------------------------
//
// The assertion that matters most. Every pair below is two people (or too
// ambiguous for a standing nag), and every one of them is one small edit apart.
{
  const distinct = [
    // Consonant swaps: identity-bearing, never a transcription artifact.
    ['Jack Groce', 'Jane Groce'],
    ['Jack Groce', 'Jake Groce'],
    ['Ben Carter', 'Ken Carter'],
    ['Sam Ortiz', 'Pam Ortiz'],
    ['Erik Larsen', 'Eric Larsen'],
    // Short names where the vowel IS the name.
    ['Tom Nguyen', 'Tim Nguyen'],
    ['Dan Perez', 'Don Perez'],
    // Same first name, surname one letter apart — the library's worked example
    // of two different humans. Needs an exact shared individual time to link.
    ['Ryan Johnson', 'Ryan Johnston'],
    // A bare initial cannot distinguish Jake from Jack.
    ['S Balistreri', 'Steven Balistreri'],
    // Unrelated names that happen to share a first name / a surname.
    ['Matthew Ford', 'Michael Ford'],
    ['Oliver Pozvai', 'Oliver Fergunson'],
  ];
  const ws = workspace({
    athleteHistory: distinct.flatMap(([a, b], i) => [
      importedSwim(a, '50 Freestyle', `2${i % 10}.13`),
      importedSwim(b, '100 Butterfly', `5${i % 10}.24`),
    ]),
  });

  const found = detectDuplicateAthletes(ws, { team: TEAM, gender: Gender.MEN });
  assert.deepEqual(
    found.map(p => `${p.canonicalName} / ${p.aliasName}`),
    [],
    'no genuinely-distinct pair may be reported'
  );
  assert.equal(duplicateItems(auditOf(ws)).length, 0);
}

// --- 4b. Siblings: same surname + a real first-name variant, both competed ---
//
// "Kate Smith" / "Katie Smith" is an indel first name on an identical surname —
// indistinguishable from a genuine split on NAME SHAPE alone. What separates
// them is that both spellings appear in competed meet results: you cannot race
// yourself, so they are two humans (auto-linker hard blocker 1).
{
  const bothCompeted = workspace({
    menResults: [
      meetSwim('Kate Smith', '50 Freestyle', '23.10'),
      meetSwim('Katie Smith', '100 Freestyle', '51.40'),
    ],
  });
  assert.equal(
    detectDuplicateAthletes(bothCompeted, { team: TEAM, gender: Gender.MEN }).length,
    0,
    'two spellings that each raced are two humans'
  );

  // Control: the SAME name pair, with one side import-only, IS reported — so the
  // assertion above is the competed guard firing, not the matcher missing it.
  const oneCompeted = workspace({
    menResults: [meetSwim('Katie Smith', '100 Freestyle', '51.40')],
    athleteHistory: [importedSwim('Kate Smith', '50 Freestyle', '23.10')],
  });
  assert.equal(detectDuplicateAthletes(oneCompeted, { team: TEAM, gender: Gender.MEN }).length, 1);
}

// --- 4c. Cross-team and cross-gender pairs are never proposed ----------------
{
  const ws = workspace({
    menResults: [meetSwim('Camden Mask', '100 Breaststroke', '55.52')],
    athleteHistory: [{ ...importedSwim('Cam Mask', '200 Breaststroke', '2:02.10'), team: 'Drury University' }],
    womenResults: [
      { ...meetSwim('Camden Mask', '100 Breaststroke', '65.52'), gender: Gender.WOMEN },
    ],
  });
  assert.equal(
    detectDuplicateAthletes(ws, { team: TEAM, gender: Gender.MEN }).length,
    0,
    'a different team is a different athlete'
  );
}

// --- 5. A dismissed pair produces no item, durably --------------------------
{
  const base = workspace({
    menResults: [meetSwim('Camden Mask', '100 Breaststroke', '55.52')],
    athleteHistory: [importedSwim('Cam Mask', '200 Breaststroke', '2:02.10')],
  });
  const pair = duplicateItems(auditOf(base))[0].duplicate;
  const { patch, inverse } = dismissDuplicateAthletePair(base, pair);
  const dismissed = { ...base, ...patch };

  assert.equal(duplicateItems(auditOf(dismissed)).length, 0, 'a rejected pair must stop nagging');
  assert.equal(detectDuplicateAthletes(dismissed, { team: TEAM, gender: Gender.MEN }).length, 0);

  // Persistence route: a tombstone row inside `athleteAliases` — same array, same
  // `athlete_aliases` table, no Workspace schema field. It must resolve NOTHING.
  const rows = patch.athleteAliases ?? [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'suppressed');
  assert.equal(rows[0].provenance.suppressedReason, 'user_reject');
  assert.equal(rows[0].team, TEAM);
  assert.equal(
    buildAliasResolver(dismissed).resolveAthleteName('Cam Mask', TEAM, Gender.MEN),
    'Cam Mask',
    'a tombstone must not unify the two names'
  );
  assert.deepEqual(inverse.athleteAliases, []);

  // Re-importing the same rows cannot resurrect the suggestion.
  const reimported = {
    ...dismissed,
    athleteHistory: [
      ...dismissed.athleteHistory,
      importedSwim('Cam Mask', '100 Breaststroke', '56.90'),
    ],
  };
  assert.equal(duplicateItems(auditOf(reimported)).length, 0, 'a re-import must not undo a rejection');
}

// --- 6. The existing checklist items still appear ---------------------------
{
  // Ace: one PDF swim + 6 active plans + 1 relay leg = 8 entries against the
  // NSISC total-only cap of 7. Senior Swimmer sits on the relay and is removed,
  // vacating a leg. Neither has anything to do with duplicate detection.
  const events = [
    ['100 Butterfly', '52.00'],
    ['200 Butterfly', '1:55.00'],
    ['200 IM', '1:58.00'],
    ['400 IM', '4:10.00'],
    ['100 Backstroke', '50.00'],
    ['200 Backstroke', '1:50.00'],
  ];
  const ws = workspace({
    menResults: [
      meetSwim('Ace Alpha', '50 Freestyle', '20.50'),
      meetSwim('Bob Beta', '50 Freestyle', '21.00', 'SO'),
      meetSwim('Senior Swimmer', '50 Freestyle', '21.50', 'SR'),
      meetSwim('Dan Delta', '100 Freestyle', '48.00', 'FR'),
      ...relayLegs(
        ['Ace Alpha', 'Bob Beta', 'Senior Swimmer', 'Dan Delta'],
        ['JR', 'SO', 'SR', 'FR']
      ),
    ],
    meetEntryPlans: events.map(([event, time], i) => ({
      id: `plan-${i}`,
      name: 'Ace Alpha',
      team: TEAM,
      gender: Gender.MEN,
      event,
      time,
      source: 'manual',
      active: true,
    })),
    activeEntryIds: events.map((_, i) => `plan-${i}`),
  });

  const audit = auditOf(ws, { removeSeniors: true });
  assert.ok(
    audit.checklistItems.some(i => i.type === 'over_entry_limit' && i.group === 'entries'),
    `entry-limit items must survive, got ${JSON.stringify(audit.checklistItems.map(i => i.type))}`
  );
  assert.ok(audit.vacantRelayLegCount >= 1, 'senior on a relay still vacates a leg');
  assert.ok(
    audit.checklistItems.some(i => i.group === 'relays'),
    'relay-gap items must survive'
  );
  assert.ok(
    (audit.athleteIssues.get(normalizeSwimmerName('Senior Swimmer')) ?? []).some(
      i => i.type === 'relay_leg_vacant'
    ),
    'per-athlete relay issues must survive'
  );
  // ...and none of these roster names are mistaken for each other.
  assert.equal(duplicateItems(audit).length, 0);

  // Every checklist item keeps a unique id (the React key).
  const ids = audit.checklistItems.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length, 'checklist ids must stay unique');
}

// --- 7. The scan is pure and order-independent ------------------------------
{
  const swims = [
    importedSwim('Steven Balistreri', '100 Breaststroke', '57.10'),
    importedSwim('Stevie Balistreri', '200 Breaststroke', '2:05.30'),
    importedSwim('Alfonso Campanico', '500 Freestyle', '4:35.00'),
    importedSwim('Afonso Campanico', '1000 Freestyle', '9:40.00'),
  ];
  const forward = detectDuplicateAthletes(workspace({ athleteHistory: swims }), {
    team: TEAM,
    gender: Gender.MEN,
  });
  const reversed = detectDuplicateAthletes(workspace({ athleteHistory: [...swims].reverse() }), {
    team: TEAM,
    gender: Gender.MEN,
  });
  assert.equal(forward.length, 2);
  assert.deepEqual(
    forward.map(p => `${p.canonicalName}|${p.aliasName}`),
    reversed.map(p => `${p.canonicalName}|${p.aliasName}`),
    'row order must not change which spelling wins'
  );
}

console.log('test_duplicate_athletes: all assertions passed');
