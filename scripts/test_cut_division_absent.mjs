/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards the cut badges stamped onto imported history against the wrong
 * division's table.
 *
 * The defect: `enrichWithComputedCut` resolved its division through the
 * deprecated `divisionForTeam`, which answers `D1` for any team it does not
 * recognise — `LEGACY_UNKNOWN_TEAM_DIVISION` in `teamDivisions.ts`, labelled
 * there as "a legacy behaviour, not a correct one". D1 publishes the fastest
 * standards, so every swim from an unmapped program was judged against the
 * strictest table in the repo. Two silent, plausible outcomes: a D2/D3/NAIA
 * athlete's real cuts vanished, and a swim quick enough for the D1 mark was
 * stamped with a badge from a table that never applied to them.
 *
 * The rule being enforced is CLAUDE.md #5 ("Unknown division ≠ D1") and #4
 * ("Absent ≠ empty"): an unresolved division yields `computedCut: null`, and
 * that null must stay distinguishable from a real "did not achieve a cut". Per
 * `CutlineLookupStatus` in `cutlineUtils.ts`, only `status: 'ok'` licenses the
 * statement that a swimmer missed the cut.
 *
 * Test: npx tsx scripts/test_cut_division_absent.mjs
 */
import assert from 'node:assert/strict';
import {
  parseSwimCloudPersonalBests,
  parseSwimCloudRosterPaste,
} from '../packages/core/src/lib/athleteHistory.ts';
import { compareTimeToCutline } from '../packages/core/src/lib/cutlineUtils.ts';
import { divisionForTeamOrNull } from '../packages/core/src/data/teamDivisions.ts';
import { convertTimeToSeconds } from '../packages/core/src/lib/utils.ts';
import { Gender } from '../packages/core/src/types.ts';

// Primary workspace team, mapped as D2 in `teamDivisions.ts`.
const MAPPED_TEAM = 'Henderson State University';
// Deliberately absent from the registry — no alias, no substring, nothing.
const UNMAPPED_TEAM = 'Nowhere College';

// A 50 free that clears the published D2 B standard (20.36, 2026-2027) but not
// the D1 standard (19.43, 2025-2026, which publishes no B tier). Chosen because
// the two tables disagree about it: whichever table is used is visible in the
// answer, so this swim cannot pass by coincidence.
const SPLIT_VERDICT = '50 Free SCY\t20.00\t\tTest Invitational\tFeb 20, 2026';
// A 100 fly under the D1 standard (46.11). The legacy fallback stamped this 'A'
// for an unmapped team — a D1 badge for a program with no known division.
const UNDER_D1_MARK = '100 Fly SCY\t45.50\t\tTest Invitational\tFeb 20, 2026';
// Nowhere near any published standard in any division.
const OFF_EVERY_MARK = '50 Free SCY\t24.00\t\tTest Invitational\tFeb 20, 2026';

const parse = (paste, team, division) =>
  parseSwimCloudPersonalBests(paste, 'Test, Swimmer', team, Gender.MEN, division);

// --- 1. The fixture teams resolve as this test assumes ----------------------
{
  assert.equal(divisionForTeamOrNull(MAPPED_TEAM), 'D2', 'HSU must be registered D2');
  assert.equal(
    divisionForTeamOrNull(UNMAPPED_TEAM),
    null,
    'the unmapped fixture team must stay unmapped, or the rest of this file proves nothing'
  );
}

// --- 2. A mapped team is judged against ITS division, not D1 ----------------
{
  const [swim] = parse(SPLIT_VERDICT, MAPPED_TEAM);
  assert.ok(swim, 'paste parsed');
  assert.equal(swim.event, '50 Freestyle');
  assert.equal(swim.computedCut, 'B', 'HSU 20.00 clears the published D2 B standard');

  // The counterfactual that makes the assertion above mean something: the same
  // swim against D1 is a miss, so a 'B' here can only have come from the D2 table.
  const asD1 = compareTimeToCutline(convertTimeToSeconds('20.00'), Gender.MEN, '50 Freestyle', 'D1');
  assert.equal(asD1.status, 'ok');
  assert.equal(asD1.achieved, null, 'D1 publishes no standard this swim reaches');
}

// --- 3. An unmapped team gets no verdict at all -----------------------------
{
  const [split] = parse(SPLIT_VERDICT, UNMAPPED_TEAM);
  assert.equal(split.computedCut, null, 'no division, no table, no badge');

  const [fast] = parse(UNDER_D1_MARK, UNMAPPED_TEAM);
  assert.equal(fast.event, '100 Butterfly');
  assert.equal(fast.computedCut, null, 'an unmapped team is not a D1 team');

  // Proof the null is absence rather than a D1 verdict that happened to be null:
  // the D1 table WOULD have stamped this swim 'A'. Before the fix it did.
  const asD1 = compareTimeToCutline(convertTimeToSeconds('45.50'), Gender.MEN, '100 Butterfly', 'D1');
  assert.equal(asD1.status, 'ok');
  assert.equal(asD1.achieved, 'A', 'the D1 table does rate this swim — the fix is what suppresses it');
}

// --- 4. Absent ≠ "did not achieve a cut" ------------------------------------
{
  // Both swims below carry `computedCut: null`. They are not the same claim, and
  // the field alone cannot tell them apart — the division lookup can, which is
  // why callers must consult it before rendering "no cut".
  const [genuineMiss] = parse(OFF_EVERY_MARK, MAPPED_TEAM);
  const [unknown] = parse(OFF_EVERY_MARK, UNMAPPED_TEAM);
  assert.equal(genuineMiss.computedCut, null);
  assert.equal(unknown.computedCut, null);

  // Licensed to say "did not achieve a cut": we hold D2's table and the swim
  // missed every tier in it.
  const missDivision = divisionForTeamOrNull(genuineMiss.team);
  assert.equal(missDivision, 'D2');
  const missLookup = compareTimeToCutline(
    convertTimeToSeconds('24.00'),
    Gender.MEN,
    '50 Freestyle',
    missDivision
  );
  assert.equal(missLookup.status, 'ok', "only 'ok' licenses the statement 'did not achieve a cut'");
  assert.equal(missLookup.achieved, null);
  assert.ok(missLookup.bCutSec > 0, 'a real standard existed and was missed');

  // Not licensed: there is no table to have missed. Rendering "no cut" here
  // would assert something no governing body published.
  assert.equal(divisionForTeamOrNull(unknown.team), null);
}

// --- 5. The division argument is a three-state contract ---------------------
{
  // A caller who knows the division supplies it, and it wins over the registry.
  const [overridden] = parse(SPLIT_VERDICT, UNMAPPED_TEAM, 'D2');
  assert.equal(overridden.computedCut, 'B', 'an explicit division judges an unmapped team');

  // Explicit null is a caller saying "I already established this is unknown" —
  // it must not be re-resolved behind their back, even for a mapped team.
  const [suppressed] = parse(SPLIT_VERDICT, MAPPED_TEAM, null);
  assert.equal(suppressed.computedCut, null, 'explicit null is not the same as omitted');

  // Omitted still resolves from the team.
  const [resolved] = parse(SPLIT_VERDICT, MAPPED_TEAM);
  assert.equal(resolved.computedCut, 'B');
}

// --- 6. The roster-paste parser holds the same line -------------------------
{
  const row = 'Test Swimmer\t50 Freestyle\t20.00';
  const [mapped] = parseSwimCloudRosterPaste(row, MAPPED_TEAM, Gender.MEN);
  assert.equal(mapped.computedCut, 'B', 'roster paste judges a mapped team against D2');

  const [unmapped] = parseSwimCloudRosterPaste(row, UNMAPPED_TEAM, Gender.MEN);
  assert.equal(unmapped.computedCut, null, 'roster paste refuses the D1 fallback too');
}

// --- 7. Metric swims still carry no verdict ---------------------------------
{
  // Unchanged behaviour, asserted so the division fix cannot quietly start
  // rating converted times: the NCAA publishes SCY standards only.
  const [lcm] = parse('50 Free LCM\t22.48\t\tTest Invitational\tJun 19, 2026', MAPPED_TEAM);
  assert.equal(lcm.timeType, 'LCM');
  assert.equal(lcm.computedCut, null, 'a metric swim is never stamped with a cut');
}

console.log('cut division absent: all assertions passed');
