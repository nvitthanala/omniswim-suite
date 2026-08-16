/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards the key integrity of `CONVERSION_FACTORS` against the defect fixed on
 * 2026-08-14.
 *
 * The table was keyed `'200 IM'`, but `normalizeEventLabel` rewrites every IM
 * label to the long form, so callers arrived at the table holding
 * `'200 Individual Medley'` — a key that did not exist. The lookup missed, the
 * old fallback substituted the 50 Freestyle factor, and 57 real swims across the
 * live workspaces were converted with the wrong number. Nothing threw; every
 * converted time looked like a competition time.
 *
 * A key whose canonical spelling is absent from the table is therefore not a
 * cosmetic inconsistency — it is unreachable, and unreachable is how that bug
 * shipped. The rows below are hand-typed, so this file also checks the values
 * are shaped like published conversion factors rather than typos.
 *
 * Test: npx tsx scripts/test_conversion_keys.mjs
 */
import assert from 'node:assert/strict';
import { CONVERSION_FACTORS } from '../packages/core/src/constants.ts';
import { hasConversionFactor, convertToSCY, convertTimeToSeconds } from '../packages/core/src/lib/utils.ts';
import { normalizeEventLabel } from '../packages/core/src/lib/athleteHistory.ts';
import { Gender } from '../packages/core/src/types.ts';

const KEYS = Object.keys(CONVERSION_FACTORS);

// --- 1. Every key is reachable under its canonical label --------------------
{
  assert.ok(KEYS.length > 0, 'the conversion table must not be empty');

  // A caller reaches this table holding whatever `normalizeEventLabel` emitted.
  // If a key's canonical form is not itself a key, nothing that goes through the
  // normalizer can ever hit that row.
  const unreachable = KEYS.filter(key => {
    const canonical = normalizeEventLabel(key);
    return canonical !== key && !(canonical in CONVERSION_FACTORS);
  });
  assert.deepEqual(
    unreachable,
    [],
    `unreachable CONVERSION_FACTORS keys (canonical label missing from the table): ${unreachable
      .map(k => `"${k}" -> "${normalizeEventLabel(k)}"`)
      .join(', ')}`
  );

  // The abbreviations are deliberately kept alongside the canonical spellings —
  // published tables use the short form, the normalizer emits the long one. Both
  // must remain present; deleting either half re-opens the 2026-08-14 defect.
  for (const short of ['200 IM', '400 IM']) {
    const long = normalizeEventLabel(short);
    assert.notEqual(long, short, `${short} must normalize to the long form`);
    assert.ok(long in CONVERSION_FACTORS, `${long} must exist as a key`);
    assert.ok(short in CONVERSION_FACTORS, `${short} must remain as a key`);
  }
}

// --- 2. Every key resolves through the public lookup ------------------------
{
  for (const key of KEYS) {
    assert.ok(hasConversionFactor(key), `hasConversionFactor("${key}") must be true`);
    const canonical = normalizeEventLabel(key);
    assert.ok(
      hasConversionFactor(canonical),
      `hasConversionFactor("${canonical}") must be true — that is the spelling callers arrive with`
    );

    // End-to-end, not just the predicate: an unreachable key raises here, since
    // `convertToSCY` refuses to borrow another event's factor.
    for (const gender of [Gender.MEN, Gender.WOMEN]) {
      for (const course of ['LCM', 'SCM']) {
        assert.doesNotThrow(
          () => convertToSCY('1:00.00', canonical, gender, course),
          `converting ${course} "${canonical}" (${gender}) must find a published factor`
        );
      }
    }
  }
}

// --- 3. Every row is shaped like published conversion factors ---------------
{
  for (const key of KEYS) {
    const row = CONVERSION_FACTORS[key];
    for (const field of ['men_lcm', 'women_lcm', 'both_scm']) {
      const value = row[field];
      assert.equal(typeof value, 'number', `${key}.${field} must be a number`);
      assert.ok(Number.isFinite(value), `${key}.${field} must be finite`);
      // A course conversion nudges a time; it never halves or doubles it. Anything
      // outside this band is a transcription error, not a published factor.
      assert.ok(value > 0.5, `${key}.${field} = ${value} is implausibly small`);
      assert.ok(value < 1.5, `${key}.${field} = ${value} is implausibly large`);
    }
  }
}

// --- 4. Regression guard: the IM rows, by name ------------------------------
{
  const short200 = CONVERSION_FACTORS['200 IM'];
  const long200 = CONVERSION_FACTORS['200 Individual Medley'];
  const short400 = CONVERSION_FACTORS['400 IM'];
  const long400 = CONVERSION_FACTORS['400 Individual Medley'];
  const fifty = CONVERSION_FACTORS['50 Freestyle'];

  // Two spellings of one event. They may never drift apart.
  assert.deepEqual(short200, long200, '"200 IM" and "200 Individual Medley" are the same event');
  assert.deepEqual(short400, long400, '"400 IM" and "400 Individual Medley" are the same event');

  // The exact wrong answer the old fallback produced.
  assert.notDeepEqual(long200, fifty, '200 IM must not carry the 50 Freestyle factors');
  assert.notDeepEqual(long400, fifty, '400 IM must not carry the 50 Freestyle factors');

  // Snapshotted so a silent edit to the table breaks CI rather than the lineup.
  assert.deepEqual(long200, { men_lcm: 0.867, women_lcm: 0.877, both_scm: 0.906 });
  assert.deepEqual(long400, { men_lcm: 0.875, women_lcm: 0.886, both_scm: 0.906 });
  assert.deepEqual(fifty, { men_lcm: 0.87, women_lcm: 0.881, both_scm: 0.906 });

  // Same claim at the conversion boundary, where the defect was actually felt.
  const viaLong = convertToSCY('2:05.40', '200 Individual Medley', Gender.MEN, 'LCM');
  const viaShort = convertToSCY('2:05.40', '200 IM', Gender.MEN, 'LCM');
  const viaFifty = convertToSCY('2:05.40', '50 Freestyle', Gender.MEN, 'LCM');
  assert.equal(viaLong, viaShort, 'both spellings must convert identically');
  assert.notEqual(viaLong, viaFifty, 'the 200 IM must not convert as a 50 Freestyle');
  assert.ok(
    Math.abs(convertTimeToSeconds(viaLong) - convertTimeToSeconds('2:05.40') * long200.men_lcm) < 0.01,
    'the converted time must come from the published 200 IM factor'
  );
}

console.log('conversion keys: all assertions passed');
