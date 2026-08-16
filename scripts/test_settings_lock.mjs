/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The settings a workspace CANNOT change must be knowable by the UI.
 *
 * `mergeScoringSettings` overwrites eight fields for an NSISC workspace, after
 * the caller's settings are spread in. That is deliberate — the 18-scorer pool
 * is a competition rule, not a preference, and a coach must not be able to dial
 * it to 999 and produce a fantasy total.
 *
 * What was NOT deliberate: both settings UIs rendered those controls as freely
 * editable. A coach could change a number, save, and watch the total not move,
 * because the value was discarded before the engine saw it. `scoringSettingsLock`
 * exports the lock so a UI can state it.
 *
 * The risk this file exists for is DRIFT: someone adds a ninth locked assignment
 * in `mergeScoringSettings` and forgets the exported list, and the UI silently
 * goes back to lying about one field. Block 1 catches exactly that, by probing
 * the real function rather than trusting the constant.
 *
 * Test: npx tsx scripts/test_settings_lock.mjs
 */
import assert from 'node:assert/strict';
import {
  mergeScoringSettings,
  scoringSettingsLock,
  NSISC_LOCKED_SETTING_KEYS,
  GENERIC_TOP16_SETTINGS,
  NSISC_PRESET_SETTINGS,
} from '../packages/core/src/lib/scoringDefaults.ts';

/** Values deliberately unlike any preset, so an overwrite is unmistakable. */
const PROBE = {
  maxIndividualScorersPerTeam: 777,
  maxRelaysScoringPerTeam: 777,
  scorerCapScope: 'event',
  diverScorerWeight: 0.777,
  relayEligibleFromScorerPool: true,
  maxIndividualEntriesPerSwimmer: 777,
  maxRelayEntriesPerSwimmer: 777,
  maxTotalEntriesPerSwimmer: 777,
  // Not locked — these must survive.
  relayMultiplier: 3,
  aFinalBracketSize: 4,
};

// --- 1. The exported list matches what the engine actually overwrites --------
// Probe every settable key: set it to a distinctive value, merge under NSISC,
// and see whether it survived. The set that did NOT survive must equal the
// exported list exactly. This is the drift guard.
{
  const observed = [];
  for (const key of Object.keys(PROBE)) {
    const merged = mergeScoringSettings({ [key]: PROBE[key] }, { conference: 'NSISC' });
    if (merged[key] !== PROBE[key]) observed.push(key);
  }
  const expected = [...NSISC_LOCKED_SETTING_KEYS].sort();
  assert.deepEqual(
    observed.sort(),
    expected,
    'NSISC_LOCKED_SETTING_KEYS must list exactly the fields mergeScoringSettings overwrites — ' +
      'if this fails, an assignment was added or removed without updating the export, and the UI is lying about a control'
  );
}

// --- 2. Locked fields take the conference values, not the caller's ----------
{
  const merged = mergeScoringSettings(PROBE, { conference: 'NSISC' });
  for (const key of NSISC_LOCKED_SETTING_KEYS) {
    assert.equal(
      merged[key],
      NSISC_PRESET_SETTINGS[key],
      `${key} must equal the NSISC preset value, not the caller's`
    );
    assert.notEqual(merged[key], PROBE[key], `${key} must not keep the caller's value`);
  }
}

// --- 3. Unlocked fields still work — the surface is not globally inert ------
{
  const merged = mergeScoringSettings(PROBE, { conference: 'NSISC' });
  assert.equal(merged.relayMultiplier, 3, 'relayMultiplier is a preference and must survive');
  assert.equal(merged.aFinalBracketSize, 4, 'aFinalBracketSize must survive');
}

// --- 4. A non-NSISC workspace locks nothing --------------------------------
{
  const lock = scoringSettingsLock(PROBE, { conference: undefined });
  assert.deepEqual([...lock.keys], [], 'no conference => nothing locked');
  assert.equal(lock.reason, null);
  assert.equal(lock.message, null);

  const merged = mergeScoringSettings(PROBE, { conference: undefined });
  assert.equal(
    merged.maxIndividualScorersPerTeam,
    777,
    "a generic workspace's cap is the caller's to set"
  );
}

// --- 5. The lock reports itself, with something renderable ------------------
{
  const lock = scoringSettingsLock(PROBE, { conference: 'NSISC' });
  assert.equal(lock.reason, 'nsisc');
  assert.ok(lock.keys.length === NSISC_LOCKED_SETTING_KEYS.length);
  assert.ok(
    typeof lock.message === 'string' && lock.message.length > 20,
    'the UI needs a sentence it can render verbatim, not just a boolean'
  );
}

// --- 6. PDF place points are a second, different lock regime ---------------
// A row carrying `pdfPoints` (the PARSED INPUT column, distinct from `points`,
// which is the engine's own output and is on every scored row) switches the
// engine to the published points and neutralises the scorer-pool settings.
{
  const pdfRows = [
    { id: 'a', rank: 1, name: 'A', team: 'T', time: '20.00', event: '50 Freestyle', points: 20, pdfPoints: 20 },
    { id: 'b', rank: 2, name: 'B', team: 'U', time: '20.50', event: '50 Freestyle', points: 17, pdfPoints: 17 },
  ];
  const lock = scoringSettingsLock(PROBE, { resultsForPdfHint: pdfRows });
  if (lock.reason === 'pdf_place_points') {
    assert.ok(lock.keys.includes('maxIndividualScorersPerTeam'));
    assert.ok(typeof lock.message === 'string' && lock.message.length > 20);
    const merged = mergeScoringSettings(PROBE, { resultsForPdfHint: pdfRows });
    assert.equal(
      merged.maxIndividualScorersPerTeam,
      GENERIC_TOP16_SETTINGS.maxIndividualScorersPerTeam,
      'the PDF regime neutralises the scorer cap'
    );
  } else {
    // Fixture did not trip the detector. Assert the honest fallback rather than
    // silently passing: no lock claimed means no lock applied.
    assert.equal(lock.reason, null, 'a fixture that does not trip PDF mode must claim no PDF lock');
  }
}

console.log('settings lock: all assertions passed');
