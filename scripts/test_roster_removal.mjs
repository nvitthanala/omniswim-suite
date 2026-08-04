/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression tests for the roster/lineup removal bug-fix wave
 * (ROSTER_LINEUP_BUGS_DEEPDIVE.md). Covers:
 *   (a)1 simulateRoster safety block — a removed relay swimmer no longer reappears
 *        as a duplicate original leg, and the relay is not double-counted.
 *   (a)2 isGraduatingClassYear — GR/grad + case-insensitive senior parity.
 *   (a)3 canonicalSwimmerName — "Last, First" ≡ "First Last"; one-person-one-row.
 *   (a)4 placeholder relay-leg names ("—") never become roster rows.
 *   (b)4 removeAthleteFromWorkspace — permanent removal patch/inverse round-trip.
 *
 * Run: npx tsx scripts/test_roster_removal.mjs
 */
import assert from 'node:assert/strict';
import {
  canonicalSwimmerName,
  isGraduatingClassYear,
  simulateRoster,
  normalizeSwimmerName,
} from '../packages/core/src/lib/utils.ts';
import {
  buildScorerRosterLookup,
  isPlaceholderAthleteName,
} from '../packages/core/src/lib/scorerRoster.ts';
import {
  removeAthleteFromWorkspace,
  softRemoveSwimmerFromWorkspace,
  restoreSwimmerToWorkspace,
} from '../packages/core/src/lib/swimmerSoftRemove.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

// ---------------------------------------------------------------------------
// (a)3 canonicalSwimmerName folding
// ---------------------------------------------------------------------------
{
  assert.equal(canonicalSwimmerName('Malone, Curtis'), canonicalSwimmerName('Curtis Malone'));
  assert.equal(canonicalSwimmerName('Malone, Curtis'), 'curtis malone');
  assert.equal(canonicalSwimmerName('Curtis Malone'), 'curtis malone');
  // No comma → identical to normalizeSwimmerName semantics.
  assert.equal(canonicalSwimmerName('  Colin   Candebat '), normalizeSwimmerName('Colin Candebat'));
  // Suffix form with a second comma is left to normalize semantics (never mangled).
  assert.equal(canonicalSwimmerName('Malone, Curtis, Jr.'), normalizeSwimmerName('Malone, Curtis, Jr.'));
  // Single-comma with a suffix inside the first-name part still folds sanely.
  assert.equal(canonicalSwimmerName('Malone, Curtis Jr.'), 'curtis jr. malone');
  ok('canonicalSwimmerName folds "Last, First" ≡ "First Last"; suffixes/no-comma untouched');
}

// ---------------------------------------------------------------------------
// (a)2 isGraduatingClassYear
// ---------------------------------------------------------------------------
{
  for (const y of ['SR', 'Sr', 'sr', 'Senior', 'SENIOR', 'GR', 'Gr', 'grad', 'GRAD']) {
    assert.equal(isGraduatingClassYear(y), true, `${y} is graduating`);
  }
  for (const y of ['FR', 'SO', 'JR', 'HS', '', undefined, null, '5th']) {
    assert.equal(isGraduatingClassYear(y), false, `${y} is not graduating`);
  }
  ok('isGraduatingClassYear: SR/SENIOR/GR/GRAD (any case) true; FR/SO/JR false');
}

// ---------------------------------------------------------------------------
// (a)4 placeholder names
// ---------------------------------------------------------------------------
{
  for (const nm of ['—', '-', '', '  ', 'Unknown']) {
    assert.equal(isPlaceholderAthleteName(nm), true, `${JSON.stringify(nm)} placeholder`);
  }
  assert.equal(isPlaceholderAthleteName('Curtis Malone'), false);
  ok('isPlaceholderAthleteName flags "—"/empty/Unknown, not real names');
}

// ---------------------------------------------------------------------------
// (a)2 removeSeniors drops GR individuals (previously only SR)
// ---------------------------------------------------------------------------
{
  const TEAM = 'HSU';
  const ind = (id, name, year) => ({
    id, rank: 1, name, classYear: year, team: TEAM, time: '20.00', points: 0,
    event: '50 Freestyle', gender: MEN, isRelay: false, roundSwam: 'A Final',
  });
  const results = [ind('s1', 'Senior Sam', 'SR'), ind('g1', 'Grad Gary', 'GR'), ind('j1', 'Junior Jim', 'JR')];
  const out = simulateRoster(results, [], true, new Set(), [], new Set());
  const names = out.filter(r => !r.isRelay).map(r => r.name).sort();
  assert.deepEqual(names, ['Junior Jim'], 'both SR and GR dropped, JR kept');
  ok('removeSeniors drops GR (grad) individual as well as SR');
}

// ---------------------------------------------------------------------------
// (a)1 safety block — soft-removing a relay swimmer does NOT reappear the original
// leg, relay-leg count stays the same, removed name absent from roster rows.
// ---------------------------------------------------------------------------
{
  const TEAM = 'HSU';
  const ev = '200 Yard Medley Relay';
  const teamTime = '1:32.00';
  const legNames = ['Curtis Malone', 'Colin Candebat', 'Beni X', 'River Y'];
  const relayNames = legNames.map(nm => ({ name: nm, year: 'SR' }));
  const relayLegs = legNames.map((nm, i) => ({
    id: `rel-${i}`, rank: 1, name: nm, classYear: 'SR', team: TEAM,
    time: teamTime, finalsTime: teamTime, relayTeamTime: teamTime,
    relayLegSplit: '23.00', relayLegIndex: i, relayNames,
    points: 0, event: ev, gender: MEN, isRelay: true, roundSwam: 'A Final',
  }));
  const ind = (id, name) => ({
    id, rank: 1, name, classYear: 'JR', team: TEAM, time: '23.00', points: 0,
    event: '50 Backstroke', gender: MEN, isRelay: false, roundSwam: 'A Final',
  });
  const results = [ind('i-curtis', 'Curtis Malone'), ...relayLegs];

  const relayLegCountBefore = results.filter(r => r.isRelay).length;
  // Exclude by the OTHER name format to also exercise canonical folding on the leg.
  const excluded = new Set([canonicalSwimmerName('Malone, Curtis')]);
  const out = simulateRoster(results, [], false, excluded, [], new Set());

  const relayLegCountAfter = out.filter(r => r.isRelay).length;
  assert.equal(relayLegCountAfter, relayLegCountBefore, 'relay-leg count unchanged (no duplicate group)');

  // The removed swimmer's leg is vacated, never re-emitted under the original name.
  const curtisLegs = out.filter(r => r.isRelay && canonicalSwimmerName(r.name) === canonicalSwimmerName('Curtis Malone'));
  assert.equal(curtisLegs.length, 0, 'no surviving original leg under the removed name');

  // Exactly one team clock for the relay (not doubled).
  const clocks = new Set(out.filter(r => r.isRelay).map(r => r.relayTeamTime));
  assert.equal(clocks.size, 1, 'a single relay team clock (relay not double-counted)');

  // And the removed name is absent from the built roster rows.
  const settings = mergeScoringSettings({ scorerEligibilityMode: 'roster' });
  const lookup = buildScorerRosterLookup(out, settings, [], MEN);
  const rowNames = lookup.rows.map(r => canonicalSwimmerName(r.name));
  assert.ok(!rowNames.includes(canonicalSwimmerName('Curtis Malone')), 'removed swimmer absent from roster rows');
  assert.ok(!lookup.rows.some(r => isPlaceholderAthleteName(r.name)), 'no "—" placeholder roster row');
  ok('simulateRoster safety block: removed relay swimmer gone, leg count stable, relay not doubled, no phantom "—" row');
}

// ---------------------------------------------------------------------------
// (a)3/3.4 one athlete spelled two ways collapses to ONE roster row
// ---------------------------------------------------------------------------
{
  const TEAM = 'HSU';
  const settings = mergeScoringSettings({ scorerEligibilityMode: 'roster' });
  const results = [
    { id: 'a', rank: 1, name: 'Curtis Malone', classYear: 'JR', team: TEAM, time: '20.00', points: 0, event: '50 Freestyle', gender: MEN, isRelay: false, roundSwam: 'A Final' },
    // Relay leg spells the same human "Last, First".
    ...['Malone, Curtis', 'Colin Candebat', 'Beni X', 'River Y'].map((nm, i) => ({
      id: `r-${i}`, rank: 1, name: nm, classYear: 'JR', team: TEAM, time: '1:22.00', relayTeamTime: '1:22.00',
      relayLegIndex: i, points: 0, event: '200 Yard Freestyle Relay', gender: MEN, isRelay: true, roundSwam: 'A Final',
    })),
  ];
  const lookup = buildScorerRosterLookup(results, settings, [], MEN);
  const curtisRows = lookup.rows.filter(r => canonicalSwimmerName(r.name) === canonicalSwimmerName('Curtis Malone'));
  assert.equal(curtisRows.length, 1, 'one human, one roster row despite two spellings');
  ok('one person spelled "Curtis Malone" + "Malone, Curtis" collapses to a single roster row');
}

// ---------------------------------------------------------------------------
// (b)4 permanent removal patch/inverse round-trip + hidden vs removed tagging
// ---------------------------------------------------------------------------
{
  const TEAM = 'HSU';
  const menResults = [
    { id: 'i1', rank: 1, name: 'Curtis Malone', classYear: 'SR', team: TEAM, time: '20.00', points: 0, event: '50 Freestyle', gender: MEN, isRelay: false, roundSwam: 'A Final' },
    { id: 'i2', rank: 1, name: 'Colin Candebat', classYear: 'JR', team: TEAM, time: '21.00', points: 0, event: '50 Freestyle', gender: MEN, isRelay: false, roundSwam: 'A Final' },
    { id: 'r0', rank: 1, name: 'Curtis Malone', classYear: 'SR', team: TEAM, time: '1:22.00', relayTeamTime: '1:22.00', relayLegIndex: 0, points: 0, event: '200 Yard Freestyle Relay', gender: MEN, isRelay: true, roundSwam: 'A Final' },
  ];
  const ws = {
    id: 'ws', name: 'T', createdAt: Date.now(), menResults, womenResults: [],
    sourceMenResults: menResults.map(r => ({ ...r })), sourceWomenResults: [],
    recruits: [], meetEntryPlans: [{ id: 'p1', name: 'Curtis Malone', team: TEAM, gender: MEN, event: '100 Freestyle', time: '45.0', active: true, source: 'manual' }],
    activeEntryIds: ['p1'], athleteHistory: [{ id: 'h1', name: 'Curtis Malone', team: TEAM, gender: MEN, event: '50 Freestyle', time: '20.1', timeType: 'SCY', source: 'paste' }],
    scorerRosterOverrides: [{ name: 'Curtis Malone', team: TEAM, gender: MEN, isScorer: true }],
    relayLegOverrides: [], deletedSwimmers: [],
  };

  const { patch, inverse, description } = removeAthleteFromWorkspace(ws, { name: 'Curtis Malone', gender: MEN });

  // Individual working row stripped; relay leg kept; other athlete untouched.
  assert.ok(!patch.menResults.some(r => !r.isRelay && r.name === 'Curtis Malone'), 'individual row stripped from menResults');
  assert.ok(patch.menResults.some(r => r.isRelay && r.name === 'Curtis Malone'), 'relay leg kept (vacated by projection)');
  assert.ok(patch.menResults.some(r => r.name === 'Colin Candebat'), 'other athlete untouched');
  assert.ok(!patch.athleteHistory.some(h => h.name === 'Curtis Malone'), 'history row stripped');
  assert.ok(!patch.meetEntryPlans.some(p => p.name === 'Curtis Malone'), 'plan stripped');
  assert.equal(patch.deletedSwimmers.find(d => canonicalSwimmerName(d.name) === canonicalSwimmerName('Curtis Malone')).mode, 'removed', 'tagged removed');
  // Frozen source never touched.
  assert.deepEqual(ws.sourceMenResults, menResults.map(r => ({ ...r })), 'sourceMenResults untouched');
  assert.ok(description.includes('Curtis Malone'));

  // Inverse restores every touched field deep-equal.
  const applied = { ...ws, ...patch };
  const roundTripped = { ...applied, ...inverse };
  for (const f of Object.keys(patch)) {
    assert.deepEqual(roundTripped[f], ws[f], `inverse round-trips ${f}`);
  }

  // Restore rebuilds the individual working row from the frozen source.
  const restorePatch = restoreSwimmerToWorkspace(applied, { name: 'Curtis Malone', gender: MEN });
  assert.ok(!(restorePatch.deletedSwimmers ?? []).some(d => canonicalSwimmerName(d.name) === canonicalSwimmerName('Curtis Malone')), 'restore clears the removed entry');
  assert.ok((restorePatch.menResults ?? []).some(r => !r.isRelay && r.name === 'Curtis Malone'), 'restore rebuilds the individual row from source');
  ok('removeAthleteFromWorkspace: strips individual+plans+history, keeps relay leg + source, inverse round-trips, restore rebuilds');
}

// ---------------------------------------------------------------------------
// soft remove tags 'hidden' and matches across name formats
// ---------------------------------------------------------------------------
{
  const TEAM = 'HSU';
  const ws = {
    id: 'ws', name: 'T', createdAt: Date.now(), menResults: [], womenResults: [],
    recruits: [{ id: 'rc', name: 'Malone, Curtis', team: TEAM, gender: MEN, classYear: 'FR', event: '50 Freestyle', time: '20.0' }],
    meetEntryPlans: [{ id: 'p1', name: 'Malone, Curtis', team: TEAM, gender: MEN, event: '50 Freestyle', time: '20.0', active: true, source: 'manual' }],
    activeEntryIds: ['p1'], athleteHistory: [], scorerRosterOverrides: [], relayLegOverrides: [], deletedSwimmers: [],
  };
  // Soft-remove using the OTHER spelling — canonical match must still clear plans/recruits.
  const patch = softRemoveSwimmerFromWorkspace(ws, { name: 'Curtis Malone', gender: MEN });
  assert.equal(patch.recruits.length, 0, 'recruit cleared via canonical match');
  assert.equal(patch.meetEntryPlans.length, 0, 'plan cleared via canonical match');
  assert.equal(patch.deletedSwimmers[0].mode, 'hidden', 'soft-remove tagged hidden');
  ok('softRemoveSwimmerFromWorkspace matches across name formats and tags mode:hidden');
}

console.log(`\nroster removal tests passed (${n} groups)`);
