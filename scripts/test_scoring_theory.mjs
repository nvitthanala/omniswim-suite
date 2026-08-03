/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Scoring-theory parser + apply tests (relay squads, alternates, nickname resolution).
 */
import assert from 'node:assert/strict';
import {
  parseScoringTheory,
  expandEventToken,
  resolveTheoryName,
  applyScoringTheory,
} from '../packages/core/src/lib/scoringTheory.ts';
import { ClassYear, Gender } from '../packages/core/src/types.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import { normalizeSwimmerName } from '../packages/core/src/lib/utils.ts';

const TEAM = 'Henderson State University';

const THEORY = [
  'Scoring team relays',
  '',
  '800 FR',
  'A River, Beni, Curtis, Colton',
  'B Noel, Gavin, Stevie, Colton/Hunter/Alan',
  '',
  'Scoring team possibilities',
  '',
  'Beni Bona (50, 100, 200, 500 fr)',
  'Mate Hozzsu (50, 100, 200 fr, ?)',
  'Cam Mask (2IM, 4IM, 1br, 2br)',
  '',
  'Other possibilities:',
  'Tristin F (sprint fr)',
].join('\n');

// --- event abbreviation expander ---
{
  assert.equal(expandEventToken('50'), '50 Freestyle');
  assert.equal(expandEventToken('500 fr'), '500 Freestyle');
  assert.equal(expandEventToken('1000'), '1000 Freestyle');
  assert.equal(expandEventToken('1650'), '1650 Freestyle');
  assert.equal(expandEventToken('1fr'), '100 Freestyle');
  assert.equal(expandEventToken('2fr'), '200 Freestyle');
  assert.equal(expandEventToken('1fly'), '100 Butterfly');
  assert.equal(expandEventToken('2fly'), '200 Butterfly');
  assert.equal(expandEventToken('1back'), '100 Backstroke');
  assert.equal(expandEventToken('2back'), '200 Backstroke');
  assert.equal(expandEventToken('1br'), '100 Breaststroke');
  assert.equal(expandEventToken('2br'), '200 Breaststroke');
  assert.equal(expandEventToken('2IM'), '200 Individual Medley');
  assert.equal(expandEventToken('4IM'), '400 Individual Medley');
  assert.equal(expandEventToken('1back?'), '100 Backstroke'); // strip trailing '?'
  assert.equal(expandEventToken('1fr/2br'), '100 Freestyle'); // first slashed option
  assert.equal(expandEventToken('?'), null);
  assert.equal(expandEventToken('sprint fr'), null); // unrecognized freeform note
}

// --- parse: relays incl. alternates, swimmers, '?', others ---
{
  const p = parseScoringTheory(THEORY);
  assert.equal(p.relays.length, 2);
  const a = p.relays.find(r => r.squad === 'A');
  const b = p.relays.find(r => r.squad === 'B');
  assert.equal(a.event, '800 Freestyle Relay');
  assert.deepEqual(a.legs.map(l => l.name), ['River', 'Beni', 'Curtis', 'Colton']);
  // Alternates on the B anchor leg.
  const altLeg = b.legs[3];
  assert.equal(altLeg.name, 'Colton');
  assert.deepEqual(altLeg.alternates, ['Hunter', 'Alan']);

  const beni = p.swimmers.find(s => s.rawName === 'Beni Bona');
  assert.deepEqual(beni.events, ['50 Freestyle', '100 Freestyle', '200 Freestyle', '500 Freestyle']);
  // '?' → fewer events, not an error.
  const mate = p.swimmers.find(s => s.rawName === 'Mate Hozzsu');
  assert.deepEqual(mate.events, ['50 Freestyle', '100 Freestyle', '200 Freestyle']);
  const cam = p.swimmers.find(s => s.rawName === 'Cam Mask');
  assert.deepEqual(cam.events, [
    '200 Individual Medley',
    '400 Individual Medley',
    '100 Breaststroke',
    '200 Breaststroke',
  ]);

  assert.equal(p.others.length, 1);
  assert.equal(p.others[0].rawName, 'Tristin F');
  assert.equal(p.others[0].note, 'sprint fr');
}

// --- name resolution ---
{
  const roster = [
    'Benedek BONA',
    'Máté Hosszú',
    'Camden Mask',
    'Tristin Ferguson',
    'Colton Bennett',
    'Hunter Rytting',
    'Alan Gonzalez',
    'River Paulk',
    'Noel Kis',
    'Gavin Kock',
    'Steven Balistreri',
  ];
  assert.equal(resolveTheoryName('Beni Bona', roster).match, 'Benedek BONA');
  assert.equal(resolveTheoryName('Mate Hozzsu', roster).match, 'Máté Hosszú'); // misspelled surname
  assert.equal(resolveTheoryName('Cam Mask', roster).match, 'Camden Mask'); // nickname
  assert.equal(resolveTheoryName('Tristin F', roster).match, 'Tristin Ferguson'); // First L
  assert.equal(resolveTheoryName('Beni', roster).match, 'Benedek BONA'); // relay first-name
  assert.equal(resolveTheoryName('Stevie', roster).match, 'Steven Balistreri'); // nickname first-name
  assert.equal(resolveTheoryName('River', roster).match, 'River Paulk');
  // Unresolvable → null, never guessed.
  assert.equal(resolveTheoryName('Zephyr Nobody', roster).match, null);
}

function indResult(id, name, event, time) {
  return { id, rank: 1, name, classYear: 'JR', team: TEAM, time, points: 0, event, gender: Gender.MEN };
}
function relayResult(id, rank, time) {
  return {
    id,
    rank,
    name: TEAM,
    classYear: '',
    team: TEAM,
    time,
    relayTeamTime: time,
    points: 0,
    event: '800 Yard Freestyle Relay',
    gender: Gender.MEN,
    isRelay: true,
    roundSwam: 'A Final',
  };
}

function workspace(overrides = {}) {
  return {
    id: 'ws',
    name: 'Test',
    createdAt: Date.now(),
    menResults: [
      indResult('c1', 'River Paulk', '50 Freestyle', '20.10'),
      indResult('c2', 'Noel Kis', '50 Freestyle', '20.90'),
      indResult('c3', 'Gavin Kock', '50 Freestyle', '21.00'),
      indResult('c4', 'Steven Balistreri', '200 Individual Medley', '1:52.00'),
      indResult('c5', 'Colton Bennett', '1000 Freestyle', '9:40.00'),
      indResult('c6', 'Hunter Rytting', '200 Backstroke', '1:48.00'),
      indResult('c7', 'Alan Gonzalez', '1650 Freestyle', '16:10.00'),
      relayResult('rel1', 1, '6:40.00'),
      relayResult('rel2', 2, '6:45.00'),
    ],
    womenResults: [],
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [
      hist('Benedek BONA', '50 Freestyle', '20.50'),
      hist('Benedek BONA', '100 Freestyle', '45.00'),
      hist('Benedek BONA', '200 Freestyle', '1:40.00'),
      hist('Benedek BONA', '500 Freestyle', '4:30.00'),
      hist('Máté Hosszú', '50 Freestyle', '20.90'),
      hist('Máté Hosszú', '100 Freestyle', '45.50'),
      hist('Máté Hosszú', '200 Freestyle', '1:41.00'),
      hist('Camden Mask', '200 Individual Medley', '1:50.00'),
      hist('Camden Mask', '100 Breaststroke', '55.00'),
    ],
    historySources: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    ...overrides,
  };
}
function hist(name, event, time) {
  return { name, team: TEAM, gender: Gender.MEN, event, time, timeType: 'SCY', source: 'paste' };
}

// --- apply: scorers, plans (from history, capped), relays, alternates ---
{
  const parsed = parseScoringTheory(THEORY);
  const result = applyScoringTheory(workspace(), parsed, {
    team: TEAM,
    gender: Gender.MEN,
    classYearOverrides: { 'benedek bona': ClassYear.SR },
  });

  // Scorers marked (roster mode).
  const overrides = result.patch.scorerRosterOverrides ?? [];
  for (const nm of ['Benedek BONA', 'Máté Hosszú', 'Camden Mask']) {
    assert.ok(
      overrides.some(o => normalizeSwimmerName(o.name) === normalizeSwimmerName(nm) && o.isScorer),
      `${nm} marked scorer`
    );
  }

  // Plans created from history. NSISC is total-only (7 combined): all 4 of
  // Beni's history events fit as individual plans.
  const plans = result.patch.meetEntryPlans ?? [];
  const beniPlans = plans.filter(p => normalizeSwimmerName(p.name) === normalizeSwimmerName('Benedek BONA'));
  assert.equal(beniPlans.length, 4, 'all 4 history events fit under the 7-total cap');
  assert.ok(beniPlans.every(p => p.source === 'optimizer'));
  assert.ok(beniPlans.every(p => p.classYear === ClassYear.SR), 'class-year override applied');
  // Times come from history, not invented.
  const beni50 = beniPlans.find(p => p.event === '50 Freestyle');
  assert.ok(beni50 && beni50.time === '20.50');

  // Relay leg overrides created against the existing 800 FR entries.
  const legOverrides = result.patch.relayLegOverrides ?? [];
  assert.ok(legOverrides.some(o => o.assigneeName === 'Benedek BONA'), 'Beni placed on A relay');
  assert.ok(legOverrides.some(o => o.assigneeName === 'River Paulk'));
  assert.ok(result.summary.relayLegsAssigned >= 6);

  // Alternates recorded in summary for the B anchor leg.
  assert.ok(
    result.summary.relayAlternates.some(
      a => a.chosen === 'Colton Bennett' && a.alternates.includes('Hunter')
    ),
    'alternates recorded'
  );

  // "Curtis" is not on the roster → warned, never guessed.
  assert.ok(result.warnings.some(w => /Curtis/.test(w)));
}

// --- apply: never overwrites a conflicting existing plan ---
{
  const ws = workspace({
    meetEntryPlans: [
      {
        id: 'existing',
        name: 'Benedek BONA',
        team: TEAM,
        gender: Gender.MEN,
        event: '50 Freestyle',
        time: '20.99',
        source: 'manual',
        active: true,
      },
    ],
  });
  const parsed = parseScoringTheory(THEORY);
  const result = applyScoringTheory(ws, parsed, { team: TEAM, gender: Gender.MEN });
  // Existing manual plan preserved untouched.
  const existing = (result.patch.meetEntryPlans ?? []).find(p => p.id === 'existing');
  assert.ok(existing && existing.time === '20.99' && existing.source === 'manual');
  // No second 50 Free plan was added for Benedek.
  const beni50 = (result.patch.meetEntryPlans ?? []).filter(
    p => normalizeSwimmerName(p.name) === normalizeSwimmerName('Benedek BONA') && p.event === '50 Freestyle'
  );
  assert.equal(beni50.length, 1);
  assert.ok(result.warnings.some(w => /already has a plan for 50 Freestyle/.test(w)));
}

console.log('scoring theory tests passed');
