/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Closes a coverage gap found while refactoring `calculatePoints` for
 * cyclomatic complexity (code-health plan 2026-09-25, item H7/H8): no named
 * test asserted the point values the TIMED-FINAL individual path
 * (`scoreTimedFinalIndividualsInEvent`, private in `utils.ts`, reached
 * through `calculatePoints` for a distance / straight-final event) actually
 * produces.
 *
 * The rows below are the real 2026 NSISC Championships Men's 1000 and 1650
 * Yard Freestyle fields — both timed finals (`round_swam: 'Finals'`, no
 * separate prelims round) — taken verbatim (rank, name, team, class year,
 * time, round) from the committed parser output
 * `tests/test_nsisc_output.json`, which several other tests already treat as
 * ground truth for this meet (see `tests/relayFollowUpsR1.test.ts`,
 * `tests/relayLegEventMatching.test.ts`). Scored under
 * `NSISC_PRESET_SETTINGS`, the engine reproduces the NCAA TOP16 ladder
 * (`SCORING_POINTS` in `constants.ts`) exactly, place for place, across both
 * full fields (14 and 10 finishers respectively).
 *
 * Neither event has a real tied time in the meet's own results, so this data
 * carries no tie case for the timed-final split-the-slice-evenly path
 * (`awardTimedFinalPointEligibleGroup`'s `each = ... / pointEligible.length`).
 * That line is still covered here: dividing by group size only matters when a
 * group has more than one member, and every group below has exactly one, so
 * `each` reduces to the single table value for that place — a regression that
 * divided by the wrong denominator (e.g. `pointEligible.length + 1`) still
 * changes every value below and fails this test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Gender, type SwimmerResult } from '../packages/core/src/types';
import { calculatePoints } from '../packages/core/src/lib/utils';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

type ParserRow = {
  rank: number;
  name: string;
  year: string;
  team: string;
  finals_time: string | null;
  prelims_time: string | null;
  round_swam: string;
  event: string;
  gender: string;
  is_relay: boolean;
};

const parserOut = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'test_nsisc_output.json'), 'utf8')
) as ParserRow[];

/** The real parser row, mapped losslessly onto the `SwimmerResult` shape `calculatePoints` consumes. */
function toSwimmerResult(r: ParserRow, idx: number): SwimmerResult {
  return {
    id: `timed-final-probe-${idx}`,
    rank: r.rank,
    name: r.name,
    classYear: r.year,
    team: r.team,
    time: r.finals_time ?? '',
    prelimsTime: r.prelims_time ?? undefined,
    roundSwam: r.round_swam,
    event: r.event,
    gender: r.gender === 'Men' ? Gender.MEN : Gender.WOMEN,
    isRelay: r.is_relay,
    isExhibition: false,
    isTimeTrial: false,
    points: 0,
  } as SwimmerResult;
}

function rowsForEvent(event: string): SwimmerResult[] {
  return parserOut.filter(r => r.event === event && !r.is_relay).map(toSwimmerResult);
}

function pointsByRank(scored: SwimmerResult[]): [number, number][] {
  return [...scored]
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map(r => [r.rank ?? 0, r.points ?? 0]);
}

describe('scoreTimedFinalIndividualsInEvent (via calculatePoints), real NSISC data', () => {
  it('scores the real Men 1000 Yard Freestyle timed final against the NCAA TOP16 ladder', () => {
    const rows = rowsForEvent('Event 4 Men 1000 Yard Freestyle');
    expect(rows).toHaveLength(14);

    const scored = calculatePoints(rows, NSISC_PRESET_SETTINGS);

    expect(pointsByRank(scored)).toEqual([
      [1, 20],
      [2, 17],
      [3, 16],
      [4, 15],
      [5, 14],
      [6, 13],
      [7, 12],
      [8, 11],
      [9, 9],
      [10, 7],
      [11, 6],
      [12, 5],
      [13, 4],
      [14, 3],
    ]);
  });

  it('scores the real Men 1650 Yard Freestyle timed final against the NCAA TOP16 ladder', () => {
    const rows = rowsForEvent('Event 33 Men 1650 Yard Freestyle');
    expect(rows).toHaveLength(10);

    const scored = calculatePoints(rows, NSISC_PRESET_SETTINGS);

    expect(pointsByRank(scored)).toEqual([
      [1, 20],
      [2, 17],
      [3, 16],
      [4, 15],
      [5, 14],
      [6, 13],
      [7, 12],
      [8, 11],
      [9, 9],
      [10, 7],
    ]);
  });
});
