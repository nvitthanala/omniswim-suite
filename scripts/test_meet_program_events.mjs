/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The loaded meet decides which events a swimmer can be entered in.
 *
 * Two bugs this locks down:
 *  1. Athlete profiles were built from ALL history, so 50 Butterfly / 50 Backstroke /
 *     50 Breaststroke / 25s / 375 Freestyle became "scoring opportunities" the
 *     optimizer and the arbitrage panel would suggest — in a meet that contests
 *     none of them.
 *  2. Profiles keyed on the raw history label, so a 400 Free LCM sat in the profile
 *     as "400 Freestyle" rather than folding into the 500 Free it actually competes
 *     in, and a meet's HyTek label ("Event 22 Men 500 Yard Freestyle") appeared as a
 *     SEPARATE event from the canonical "500 Freestyle".
 *
 * The program is read from the meet, never a hardcoded list: NSISC does not contest
 * the 100 IM, but a conference that does must get it.
 *
 * Test: npx tsx scripts/test_meet_program_events.mjs
 */
import assert from 'node:assert/strict';
import {
  meetProgramEvents,
  canonicalMeetEventLabel,
  getAthleteProfile,
} from '../packages/core/src/lib/athleteHistory.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const TEAM = 'Henderson State University';

function meetRow(event, extra = {}) {
  return {
    id: `m-${event}`,
    rank: 1,
    name: 'Field, Swimmer',
    classYear: 'SR',
    team: TEAM,
    time: '1:00.00',
    points: 0,
    event,
    gender: Gender.MEN,
    ...extra,
  };
}

function swim(event, time, timeType = 'SCY') {
  return {
    name: 'Test, Athlete',
    team: TEAM,
    gender: Gender.MEN,
    event,
    time,
    timeType,
    source: 'swimcloud',
  };
}

// --- 1. HyTek labels canonicalize; relays, diving and time trials are excluded ---
{
  assert.equal(canonicalMeetEventLabel('Event 22 Men 500 Yard Freestyle'), '500 Freestyle');
  assert.equal(canonicalMeetEventLabel('Event 24 Men 100 Yard Backstroke'), '100 Backstroke');
  assert.equal(canonicalMeetEventLabel('Event 6 Men 200 Yard IM'), '200 Individual Medley');
  assert.equal(canonicalMeetEventLabel('Event 20 Men 4x100 Yard Medley Relay'), null, 'relay');
  assert.equal(canonicalMeetEventLabel('Event 9 Men 1 mtr Diving'), null, 'diving');

  const program = meetProgramEvents([
    meetRow('Event 8 Men 50 Yard Freestyle'),
    meetRow('Event 22 Men 500 Yard Freestyle'),
    meetRow('Event 31 Men 4x50 Yard Freestyle Relay', { isRelay: true }),
    meetRow('Event 9 Men 1 mtr Diving'),
    meetRow('Event 300 Men 50 Yard Butterfly Time Trial', { isTimeTrial: true }),
  ]);
  assert.deepEqual([...program].sort(), ['50 Freestyle', '500 Freestyle']);
  assert.ok(!program.has('50 Butterfly'), 'a time trial is not a scoring opportunity');
}

// --- 2. A conference that contests the 100 IM gets it -----------------------
{
  const program = meetProgramEvents([
    meetRow('Event 5 Men 100 Yard IM'),
    meetRow('Event 8 Men 50 Yard Freestyle'),
  ]);
  assert.ok(program.has('100 Individual Medley'), '100 IM must be admitted when the meet contests it');

  const ws = workspaceWith(
    [meetRow('Event 5 Men 100 Yard IM'), meetRow('Event 8 Men 50 Yard Freestyle')],
    [swim('100 Individual Medley', '52.00'), swim('50 Freestyle', '20.50')]
  );
  const profile = getAthleteProfile(ws, TEAM, Gender.MEN, 'Test, Athlete', NSISC_PRESET_SETTINGS);
  assert.ok(
    Object.keys(profile.bestByEvent).includes('100 Individual Medley'),
    'the profile offers the 100 IM in a meet that contests it'
  );
}

// --- 3. Off-program events never enter a profile ---------------------------
{
  const ws = workspaceWith(
    [
      meetRow('Event 8 Men 50 Yard Freestyle'),
      meetRow('Event 35 Men 100 Yard Freestyle'),
      meetRow('Event 22 Men 500 Yard Freestyle'),
    ],
    [
      swim('50 Freestyle', '20.50'),
      swim('100 Freestyle', '45.00'),
      swim('500 Freestyle', '4:30.00'),
      // None of these are contested by the meet above.
      swim('50 Butterfly', '22.00'),
      swim('50 Backstroke', '23.00'),
      swim('50 Breaststroke', '25.00'),
      swim('100 Individual Medley', '52.00'),
      swim('25 Freestyle', '10.00'),
      swim('375 Freestyle', '3:30.00'),
    ]
  );
  const profile = getAthleteProfile(ws, TEAM, Gender.MEN, 'Test, Athlete', NSISC_PRESET_SETTINGS);
  const offered = Object.keys(profile.bestByEvent).sort();
  assert.deepEqual(offered, ['100 Freestyle', '50 Freestyle', '500 Freestyle']);
  for (const banned of ['50 Butterfly', '50 Backstroke', '50 Breaststroke', '100 Individual Medley', '25 Freestyle', '375 Freestyle']) {
    assert.ok(!offered.includes(banned), `${banned} must not be offered — the meet does not contest it`);
  }
  assert.ok(
    profile.primaryEvents.every(e => offered.includes(e)),
    'primaryEvents is a subset of the offered program events'
  );
}

// --- 4. Metric distance swims fold into the SCY event they compete in -------
{
  const ws = workspaceWith(
    [meetRow('Event 22 Men 500 Yard Freestyle'), meetRow('Event 33 Men 1650 Yard Freestyle')],
    [swim('400 Freestyle', '4:00.00', 'LCM'), swim('1500 Freestyle', '16:00.00', 'LCM')]
  );
  const profile = getAthleteProfile(ws, TEAM, Gender.MEN, 'Test, Athlete', NSISC_PRESET_SETTINGS);
  const offered = Object.keys(profile.bestByEvent).sort();
  assert.deepEqual(offered, ['1650 Freestyle', '500 Freestyle']);
  assert.ok(!offered.includes('400 Freestyle'), '400 Free LCM competes in the 500, not its own slot');
  assert.ok(!offered.includes('1500 Freestyle'), '1500 Free LCM competes in the 1650');
}

// --- 5. A meet's own HyTek label does not become a second event -------------
{
  const ws = workspaceWith(
    [meetRow('Event 22 Men 500 Yard Freestyle')],
    [swim('500 Freestyle', '4:30.00'), swim('Event 22 Men 500 Yard Freestyle', '4:31.00')]
  );
  const profile = getAthleteProfile(ws, TEAM, Gender.MEN, 'Test, Athlete', NSISC_PRESET_SETTINGS);
  assert.deepEqual(Object.keys(profile.bestByEvent), ['500 Freestyle']);
  assert.equal(profile.bestByEvent['500 Freestyle'].time, '4:30.00', 'keeps the faster of the two');
}

// --- 6. No meet loaded → championship-program fallback, still no 50 strokes --
{
  const ws = workspaceWith(
    [],
    [swim('50 Freestyle', '20.50'), swim('50 Butterfly', '22.00'), swim('200 Individual Medley', '1:50.00')]
  );
  const profile = getAthleteProfile(ws, TEAM, Gender.MEN, 'Test, Athlete', NSISC_PRESET_SETTINGS);
  const offered = Object.keys(profile.bestByEvent).sort();
  assert.deepEqual(offered, ['200 Individual Medley', '50 Freestyle']);
  assert.ok(!offered.includes('50 Butterfly'), 'recruit-driven workspaces still exclude 50s of stroke');
}

function workspaceWith(menResults, athleteHistory) {
  return {
    id: 'ws',
    name: 'ws',
    createdAt: Date.now(),
    menResults,
    womenResults: [],
    sourceMenResults: menResults,
    sourceWomenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory,
    scorerRosterOverrides: [],
    scoringSettings: NSISC_PRESET_SETTINGS,
    conference: 'NSISC',
  };
}

console.log('meet program events: all assertions passed');
