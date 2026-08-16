/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pins WHY `maxIndividualScorersPerTeam` looks inert on an NSISC workspace.
 *
 * THE FINDING (investigated 2026-08-15, live workspace "Blank Workspace 1",
 * Henderson State men): sweeping the cap over 1 / 5 / 18 / 999 produced the
 * identical team total of 1383.83 every time. Two explanations were proposed;
 * BOTH WERE WRONG, and this file exists so nobody re-runs that investigation.
 *
 *   NOT the PDF path. `calculatePoints` does have a short-circuit branch that
 *   copies HyTek place points straight out of the parsed rows, bypassing every
 *   cap. It reads `SwimmerResult.pdfPoints` — the *parsed input* column — not
 *   `SwimmerResult.points`, which is the engine's own *output* and is present
 *   on every scored row. Zero rows in the live workspace carry `pdfPoints`, so
 *   `resultsHavePdfPlacePoints` is false and the branch is never taken. The
 *   scoring-settings surface is NOT globally inert (see block 4).
 *
 *   NOT `scorerEligibilityMode: 'roster'` either. The cap is equally inert
 *   under `'points_pool'`, and the engine honours the cap identically in both
 *   modes once the value actually reaches it (block 3).
 *
 *   THE ACTUAL MECHANISM is in `mergeScoringSettings` (scoringDefaults.ts):
 *
 *       // NSISC meets always use meet-wide 18-scorer caps; stale generic
 *       // workspace caps must not win.
 *       if (nsiscConference) {
 *         merged.maxIndividualScorersPerTeam = NSISC_PRESET_SETTINGS.maxIndividualScorersPerTeam;
 *         ...
 *       }
 *
 *   Any workspace whose `conference` matches NSISC has seven fields
 *   unconditionally overwritten with the preset constants AFTER the caller's
 *   settings are spread in. The user's edit is discarded before the engine ever
 *   sees it. This is deliberate: the 18-scorer pool is a competition rule, not
 *   a preference, so a coach must not be able to dial it to 999 and produce a
 *   fantasy total. WORKING AS DESIGNED — the defect, if any, is that two
 *   settings UIs still render the control as editable for NSISC workspaces.
 *
 * Consequence worth knowing: an NSISC total responds to `scoringPoints`,
 * `relayMultiplier` and `aFinalBracketSize`, but not to the seven locked
 * fields. Block 4 pins exactly which side of that line each setting is on.
 *
 * Fixtures here are hermetic — no live DB, no meets.json.
 */
import assert from 'node:assert/strict';
import {
  calculatePoints,
  mergeScoringSettings,
} from '../packages/core/src/lib/utils.ts';
import {
  NSISC_PRESET_SETTINGS,
  resultsHavePdfPlacePoints,
  effectivePdfPlacePointsMode,
} from '../packages/core/src/lib/scoringDefaults.ts';

/**
 * Ten single-swimmer events, all first place, all on one team.
 * Ten (not six) because `resultsHavePdfPlacePoints` requires at least
 * `Math.max(8, 1% of rows)` rows carrying `pdfPoints` before it arms.
 */
const FIXTURE_SIZE = 10;

function buildFixture(team = 'Alpha University') {
  const events = [
    '200 Yard Freestyle',
    '100 Yard Backstroke',
    '100 Yard Breaststroke',
    '100 Yard Butterfly',
    '500 Yard Freestyle',
    '200 Yard IM',
    '50 Yard Freestyle',
    '200 Yard Backstroke',
    '200 Yard Breaststroke',
    '200 Yard Butterfly',
  ];
  return events.map((event, i) => ({
    id: `alpha-${i}`,
    rank: 1,
    name: `Alpha Swimmer ${i}`,
    classYear: 'FR',
    team,
    time: `1:${String(40 + i).padStart(2, '0')}.00`,
    finalsTime: `1:${String(40 + i).padStart(2, '0')}.00`,
    roundSwam: 'A Final',
    points: 0,
    event,
    gender: 'Men',
    isRelay: false,
  }));
}

const FIXTURE = buildFixture();

function totalFor(settings, options) {
  const scored = calculatePoints(FIXTURE, settings, options);
  return scored.reduce((sum, r) => sum + (typeof r.points === 'number' ? r.points : 0), 0);
}

function scorerCount(settings, options) {
  const scored = calculatePoints(FIXTURE, settings, options);
  return scored.filter(r => (r.points ?? 0) > 0).length;
}

// --- 1. The cap genuinely binds in the engine when it reaches it ---
// No conference is passed, so the NSISC lock in mergeScoringSettings does not
// fire and the caller's value survives. Every swimmer here is a distinct
// first-place finish, so an N-scorer meet pool must admit exactly N of them.
{
  const base = {
    ...NSISC_PRESET_SETTINGS,
    scorerEligibilityMode: 'points_pool',
    scorerAutoRules: undefined,
    scorerCapScope: 'meet',
  };

  const counts = [1, 2, 4, 999].map(cap =>
    scorerCount({ ...base, maxIndividualScorersPerTeam: cap })
  );

  assert.deepEqual(
    counts,
    [1, 2, 4, FIXTURE_SIZE],
    'meet-scope cap must admit exactly `cap` individual scorers (uncapped = all)'
  );

  // Monotonic: a tighter cap can never score more than a looser one.
  const t1 = totalFor({ ...base, maxIndividualScorersPerTeam: 1 });
  const t6 = totalFor({ ...base, maxIndividualScorersPerTeam: 999 });
  assert.ok(t1 < t6, 'cap=1 must total strictly less than an uncapped meet');
}

// --- 2. The NSISC conference lock discards the caller's cap ---
// This is the mechanism. Identical settings, identical fixture; the only
// difference is `conferenceForMerge`, and it flattens the whole sweep.
{
  const base = {
    ...NSISC_PRESET_SETTINGS,
    scorerEligibilityMode: 'points_pool',
    scorerAutoRules: undefined,
  };

  const locked = [1, 5, 18, 999].map(cap =>
    totalFor({ ...base, maxIndividualScorersPerTeam: cap }, { conferenceForMerge: 'NSISC' })
  );

  assert.equal(
    new Set(locked).size,
    1,
    'under an NSISC conference every cap value must produce the SAME total (the lock)'
  );

  const unlocked = [1, 5, 18, 999].map(cap =>
    totalFor({ ...base, maxIndividualScorersPerTeam: cap })
  );
  assert.ok(
    new Set(unlocked).size > 1,
    'without the conference the same sweep must produce differing totals'
  );

  // The lock is equally blind to eligibility mode — this is why the original
  // investigation saw no change when switching to points_pool.
  const rosterMode = mergeScoringSettings(
    { ...NSISC_PRESET_SETTINGS, maxIndividualScorersPerTeam: 1 },
    { conference: 'NSISC' }
  );
  const poolMode = mergeScoringSettings(
    { ...NSISC_PRESET_SETTINGS, maxIndividualScorersPerTeam: 1, scorerEligibilityMode: 'points_pool' },
    { conference: 'NSISC' }
  );
  assert.equal(rosterMode.maxIndividualScorersPerTeam, 18);
  assert.equal(poolMode.maxIndividualScorersPerTeam, 18);
  assert.equal(poolMode.scorerEligibilityMode, 'points_pool', 'mode itself survives the lock');
}

// --- 3. Exactly which fields the NSISC lock overwrites ---
// If this list ever changes, the settings UIs need to change with it: every
// field named here is inert for an NSISC workspace no matter what is saved.
{
  const absurd = {
    ...NSISC_PRESET_SETTINGS,
    maxIndividualScorersPerTeam: 999,
    maxRelaysScoringPerTeam: 999,
    scorerCapScope: 'event',
    diverScorerWeight: 1,
    relayEligibleFromScorerPool: true,
    maxIndividualEntriesPerSwimmer: 3,
    maxRelayEntriesPerSwimmer: 3,
    maxTotalEntriesPerSwimmer: 99,
    // Not locked — these must survive.
    relayMultiplier: 7,
    aFinalBracketSize: 4,
    halfRateRelaySwimmer: false,
    scoringPoints: NSISC_PRESET_SETTINGS.scoringPoints.map(p => p * 3),
  };
  const merged = mergeScoringSettings(absurd, { conference: 'NSISC' });

  const LOCKED = [
    'maxIndividualScorersPerTeam',
    'maxRelaysScoringPerTeam',
    'scorerCapScope',
    'diverScorerWeight',
    'relayEligibleFromScorerPool',
    'maxIndividualEntriesPerSwimmer',
    'maxRelayEntriesPerSwimmer',
    'maxTotalEntriesPerSwimmer',
  ];
  for (const key of LOCKED) {
    assert.deepEqual(
      merged[key],
      NSISC_PRESET_SETTINGS[key],
      `${key} must be forced back to the NSISC preset value`
    );
  }

  const SURVIVES = ['relayMultiplier', 'aFinalBracketSize', 'halfRateRelaySwimmer', 'scoringPoints'];
  for (const key of SURVIVES) {
    assert.deepEqual(
      merged[key],
      absurd[key],
      `${key} must NOT be locked — it is a real, editable knob on an NSISC meet`
    );
  }

  // Non-NSISC conference: nothing is locked.
  const free = mergeScoringSettings(absurd, { conference: 'ACC' });
  assert.equal(free.maxIndividualScorersPerTeam, 999, 'non-NSISC conference must not lock the cap');
}

// --- 4. The PDF short-circuit needs `pdfPoints`, not `points` ---
// The original investigation mistook output `points` for input `pdfPoints`.
// A row carrying only `points` must NOT arm the PDF branch.
{
  const pointsOnly = FIXTURE.map(r => ({ ...r, points: 20 }));
  assert.equal(
    resultsHavePdfPlacePoints(pointsOnly),
    false,
    '`points` alone must never arm PDF-place scoring — only parsed `pdfPoints` does'
  );

  const withPdf = FIXTURE.map((r, i) => ({ ...r, pdfPoints: 20 - i }));
  assert.equal(resultsHavePdfPlacePoints(withPdf), true);

  // Recruit rows are excluded from the detection sample.
  assert.equal(
    resultsHavePdfPlacePoints(withPdf.map(r => ({ ...r, isRecruit: true }))),
    false,
    'recruit rows must not arm PDF-place scoring'
  );

  // Explicit false beats detection; explicit true beats absence.
  const merged = mergeScoringSettings({}, {});
  assert.equal(effectivePdfPlacePointsMode({ ...merged, usePdfPlacePoints: false }, withPdf), false);
  assert.equal(effectivePdfPlacePointsMode({ ...merged, usePdfPlacePoints: true }, pointsOnly), true);
  assert.equal(effectivePdfPlacePointsMode(merged, pointsOnly), false);
}

// --- 5. When the PDF branch IS armed, it really does bypass the caps ---
// Documents the hazard the investigation suspected: with pdfPoints present the
// engine returns the meet's own arithmetic and no cap applies.
{
  const withPdf = FIXTURE.map((r, i) => ({ ...r, pdfPoints: 20 - i }));
  const expected = withPdf.reduce((s, r) => s + r.pdfPoints, 0);

  for (const cap of [1, 5, 999]) {
    const scored = calculatePoints(
      withPdf,
      { ...NSISC_PRESET_SETTINGS, maxIndividualScorersPerTeam: cap },
      { resultsForPdfHint: withPdf }
    );
    const total = scored.reduce((s, r) => s + (r.points ?? 0), 0);
    assert.equal(total, expected, 'PDF-place scoring must return the parsed points verbatim');
  }

  // And the merge neutralises the caps rather than leaving them misleading.
  const merged = mergeScoringSettings(
    { ...NSISC_PRESET_SETTINGS, maxIndividualScorersPerTeam: 18 },
    { conference: 'NSISC', resultsForPdfHint: withPdf }
  );
  assert.equal(merged.maxIndividualScorersPerTeam, 999, 'PDF lock neutralises the scorer cap');
  assert.equal(merged.scorerEligibilityMode, 'points_pool');
}

// --- 6. Settings that DO move an NSISC total ---
// Guards the "the whole surface is inert" over-reading: it is not.
{
  const nsisc = { ...NSISC_PRESET_SETTINGS };
  const opts = { conferenceForMerge: 'NSISC' };
  const baseline = totalFor(nsisc, opts);
  assert.ok(baseline > 0, 'fixture must score under NSISC settings');

  const doubled = totalFor(
    { ...nsisc, scoringPoints: nsisc.scoringPoints.map(p => p * 2) },
    opts
  );
  assert.equal(doubled, baseline * 2, 'scoringPoints must scale an NSISC total');

  const zeroed = totalFor({ ...nsisc, scoringPoints: nsisc.scoringPoints.map(() => 0) }, opts);
  assert.equal(zeroed, 0, 'a zeroed points table must zero an NSISC total');

  // ...and settings that do NOT, on this individual-only fixture.
  for (const cap of [1, 999]) {
    assert.equal(
      totalFor({ ...nsisc, maxIndividualScorersPerTeam: cap }, opts),
      baseline,
      'the scorer cap must not move an NSISC total (locked)'
    );
  }
}

console.log('test_scoring_settings_effect: all assertions passed');
