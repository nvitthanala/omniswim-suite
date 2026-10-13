/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C7 follow-up (architect review 2026-10-13, finding 3; user decision U5: core
 * returns null past the end of a place-point table). The prelims and psych
 * expected-row builders read a seed past the end of the table as 0 expected
 * points, and the over/under lookup then dropped the entry with `expected <= 0`.
 * "The table has no row" and "the table scores 0" were the same row of output.
 *
 * Now a seed the table has no row for has no expectation and no row, and
 * `listPrelimsEntriesWithoutExpectation` / `listPsychEntriesWithoutExpectation`
 * name it. A seed the table scores 0 keeps its row with 0 points.
 *
 * The dual-meet preset scores 9-4-3-2-1-0 with an A-final bracket of 6, so seed
 * 6 is a scored 0 and seed 7 (first of the B final) is past the table.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import {
  buildPrelimsExpectedRows,
  buildPrelimsProjectedBundle,
  buildPrelimsOverUnderByEntryKey,
  entryKey,
  listPrelimsEntriesWithoutExpectation,
  pointsForPrelimsSeedRankOrNull,
} from '../packages/core/src/lib/prelimsProjection';
import {
  buildPsychExpectedRows,
  listPsychEntriesWithoutExpectation,
} from '../packages/core/src/lib/psychProjection';
import { settingsForBuiltInScoringPreset } from '../packages/core/src/lib/scoringDefaults';

const EVENT = 'Event 5 Men 100 Yard Backstroke';
const dual = settingsForBuiltInScoringPreset('ncaa-dual-six-lanes-or-more') as ScoringSettings;
const SEEDS = 7;

const swimmer = (seed: number, over: Partial<SwimmerResult> = {}): SwimmerResult =>
  ({
    id: `s${seed}`,
    rank: seed,
    name: `Swimmer ${seed}`,
    classYear: 'JR',
    team: 'Alpha U',
    time: `${50 + seed}.00`,
    points: 0,
    event: EVENT,
    gender: Gender.MEN,
    roundSwam: 'Preliminaries',
    ...over,
  }) as SwimmerResult;

const prelims = Array.from({ length: SEEDS }, (_, i) => swimmer(i + 1));
const psych = Array.from({ length: SEEDS }, (_, i) =>
  swimmer(i + 1, { roundSwam: 'Psych Sheet', isPsychSheet: true, id: `p${i + 1}` })
);

const pointsByName = (rows: SwimmerResult[]) => new Map(rows.map(r => [r.name, r.points]));

describe('the table the cases rest on', () => {
  it('scores seed 6 as 0 and has no row for seed 7', () => {
    expect(pointsForPrelimsSeedRankOrNull(6, EVENT, dual)).toBe(0);
    expect(pointsForPrelimsSeedRankOrNull(7, EVENT, dual)).toBeNull();
  });
});

describe('prelims expected rows', () => {
  const rows = buildPrelimsExpectedRows(prelims, dual);

  it('a seed the table scores 0 keeps its row, with 0 points', () => {
    const points = pointsByName(rows);
    expect(points.get('Swimmer 1')).toBe(9);
    expect(points.get('Swimmer 6')).toBe(0);
  });

  it('a seed past the end of the table has no row (it was a row of 0 points)', () => {
    expect(rows.map(r => r.name)).not.toContain('Swimmer 7');
    expect(rows).toHaveLength(SEEDS - 1);
  });

  it('names the entry with no expectation, and only that one', () => {
    expect(listPrelimsEntriesWithoutExpectation(prelims, dual)).toStrictEqual([entryKey(swimmer(7))]);
  });

  it('the over/under lookup holds neither a 0 nor a missing expectation (no invented number)', () => {
    const lookup = buildPrelimsOverUnderByEntryKey([], rows);
    expect(lookup.has(entryKey(swimmer(7)))).toBe(false);
    expect(lookup.get(entryKey(swimmer(1)))?.expected).toBe(9);
  });

  it('the projected bundle carries the seed the table scores and not the seed it is silent on', () => {
    const workspace = {
      id: 'ws',
      name: 'ws',
      createdAt: 0,
      menResults: prelims,
      womenResults: [],
      scoringSettings: dual,
    } as unknown as Workspace;
    const bundle = buildPrelimsProjectedBundle({ workspace, gender: Gender.MEN });
    const names = bundle.allResults.map(r => r.name);
    expect(names).toContain('Swimmer 6');
    expect(names).not.toContain('Swimmer 7');
  });
});

describe('psych expected rows', () => {
  const rows = buildPsychExpectedRows(psych, dual);

  it('a seed the table scores 0 keeps its row, with 0 points', () => {
    const points = pointsByName(rows);
    expect(points.get('Swimmer 1')).toBe(9);
    expect(points.get('Swimmer 6')).toBe(0);
  });

  it('a seed past the end of the table has no row', () => {
    expect(rows.map(r => r.name)).not.toContain('Swimmer 7');
    expect(rows).toHaveLength(SEEDS - 1);
  });

  it('names the entry with no expectation', () => {
    expect(listPsychEntriesWithoutExpectation(psych, dual)).toStrictEqual([entryKey(swimmer(7))]);
  });
});
