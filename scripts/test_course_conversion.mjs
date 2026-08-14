/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards the LCM/SCM -> SCY conversion against fabricated factors.
 *
 * Two defects this locks down:
 *  1. `CONVERSION_FACTORS` was keyed "200 IM" while `normalizeEventLabel` emits
 *     "200 Individual Medley", so every IM conversion missed the table and
 *     silently reused the 50 Freestyle factor.
 *  2. Any event with no published factor fell back to 50 Freestyle, inventing a
 *     competition time that looks real.
 *
 * Test: npx tsx scripts/test_course_conversion.mjs
 */
import assert from 'node:assert/strict';
import {
  convertToSCY,
  convertSwimToSCY,
  hasConversionFactor,
  convertTimeToSeconds,
} from '../packages/core/src/lib/utils.ts';
import { CONVERSION_FACTORS } from '../packages/core/src/constants.ts';
import { Gender } from '../packages/core/src/types.ts';
import { mergeHistoryIndex, categorizeBestEvents } from '../packages/core/src/lib/athleteHistory.ts';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';

// --- 1. IM resolves under both spellings, and NOT to the 50 Free factor -------
{
  const fifty = CONVERSION_FACTORS['50 Freestyle'].men_lcm;
  const im200 = CONVERSION_FACTORS['200 IM'].men_lcm;
  const im400 = CONVERSION_FACTORS['400 IM'].men_lcm;
  assert.notEqual(im200, fifty, '200 IM factor must differ from 50 Free (else this test proves nothing)');

  const long200 = convertToSCY('2:05.40', '200 Individual Medley', Gender.MEN, 'LCM');
  const short200 = convertToSCY('2:05.40', '200 IM', Gender.MEN, 'LCM');
  assert.equal(long200, short200, 'both IM spellings must convert identically');

  const asFifty = convertToSCY('2:05.40', '50 Freestyle', Gender.MEN, 'LCM');
  assert.notEqual(long200, asFifty, '200 Individual Medley must not reuse the 50 Freestyle factor');

  const expected = convertTimeToSeconds('2:05.40') * im200;
  assert.ok(
    Math.abs(convertTimeToSeconds(long200) - expected) < 0.01,
    'converted 200 IM must use the published 200 IM factor'
  );

  const long400 = convertToSCY('4:32.63', '400 Individual Medley', Gender.MEN, 'LCM');
  const expected400 = convertTimeToSeconds('4:32.63') * im400;
  assert.ok(Math.abs(convertTimeToSeconds(long400) - expected400) < 0.01, '400 IM uses its own factor');

  assert.ok(hasConversionFactor('200 Individual Medley'));
  assert.ok(hasConversionFactor('400 Individual Medley'));
}

// --- 2. An event with no published factor raises rather than guessing --------
{
  assert.ok(!hasConversionFactor('200 Sidestroke'));
  assert.ok(!hasConversionFactor('100 Individual Medley'));
  assert.ok(!hasConversionFactor('25 Freestyle'));

  assert.throws(
    () => convertToSCY('2:10.00', '200 Sidestroke', Gender.MEN, 'LCM'),
    /No published LCM→SCY conversion factor/,
    'an unpublished event must raise, not borrow another event\'s factor'
  );
  assert.throws(
    () => convertToSCY('1:02.00', '100 Individual Medley', Gender.MEN, 'SCM'),
    /No published SCM→SCY conversion factor/
  );

  // SCY in, SCY out — never touches the factor table.
  assert.equal(convertToSCY('22.10', '25 Freestyle', Gender.MEN, 'SCY'), '22.10');
}

// --- 3. A 50 of a stroke may borrow the 100's factor (sanctioned) -----------
{
  assert.ok(hasConversionFactor('50 Backstroke'));
  const got = convertToSCY('30.00', '50 Backstroke', Gender.MEN, 'LCM');
  const expected = convertTimeToSeconds('30.00') * CONVERSION_FACTORS['100 Backstroke'].men_lcm;
  assert.ok(Math.abs(convertTimeToSeconds(got) - expected) < 0.01, '50 stroke uses the 100 stroke factor');
}

// --- 4. Relays pass through unconverted (no published relay factor) ---------
{
  const r = convertSwimToSCY('400 Freestyle Relay', '3:00.00', Gender.MEN, 'LCM');
  assert.equal(r.event, '400 Freestyle Relay', 'relay labels are never remapped');
  assert.equal(r.time, '3:00.00', 'relay times are never converted with a stroke factor');
  const medley = convertSwimToSCY('400 Medley Relay', '3:20.00', Gender.WOMEN, 'SCM');
  assert.equal(medley.time, '3:20.00');
}

// --- 5. Pipelines tolerate non-program metric swims without raising ---------
{
  const swims = [
    // Events with no published factor, in a metric course — these used to be
    // converted with the 50 Freestyle factor, and must now simply be skipped.
    mk('100 Individual Medley', '1:02.00', 'LCM'),
    mk('25 Freestyle', '11.00', 'SCM'),
    mk('200 Individual Medley', '2:05.40', 'LCM'),
    mk('500 Freestyle', '4:28.00', 'SCY'),
    mk('50 Freestyle', '22.50', 'SCY'),
  ];

  assert.doesNotThrow(() => mergeHistoryIndex([], swims), 'mergeHistoryIndex tolerates them');
  assert.doesNotThrow(
    () => categorizeBestEvents(swims, 'Test Team', Gender.MEN, 'Test, Swimmer', NSISC_PRESET_SETTINGS),
    'categorizeBestEvents tolerates them'
  );

  const profile = categorizeBestEvents(
    swims,
    'Test Team',
    Gender.MEN,
    'Test, Swimmer',
    NSISC_PRESET_SETTINGS
  );
  assert.ok(!profile.primaryEvents.includes('100 Individual Medley'), 'unconvertible event stays out');
  assert.ok(!profile.primaryEvents.includes('25 Freestyle'), 'unconvertible event stays out');

  const ws = {
    id: 'ws',
    name: 'ws',
    createdAt: Date.now(),
    menResults: [],
    womenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    scoringSettings: NSISC_PRESET_SETTINGS,
  };
  assert.doesNotThrow(
    () => importHistoryToRoster(ws, swims, { team: 'Test Team', gender: Gender.MEN }),
    'importHistoryToRoster tolerates them'
  );
  const res = importHistoryToRoster(ws, swims, { team: 'Test Team', gender: Gender.MEN });
  const events = res.patch.recruits.map(r => r.event);
  assert.ok(!events.includes('100 Individual Medley'));
  assert.ok(!events.includes('25 Freestyle'));
  assert.ok(events.includes('500 Freestyle'), 'real program events still import');
}

function mk(event, time, timeType) {
  return {
    id: `${event}-${timeType}`,
    name: 'Test, Swimmer',
    team: 'Test Team',
    gender: Gender.MEN,
    event,
    time,
    timeType,
    classYear: 'FR',
    source: 'swimcloud',
  };
}

console.log('course conversion: all assertions passed');
