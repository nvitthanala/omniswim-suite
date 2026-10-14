/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C7 follow-up 2 (architect review 2026-10-13; user decision U5: core returns
 * null past the end of a place-point table). A seed past the table has no
 * expectation and no row. Before this change a team whose every seed was past
 * the table had no row at all, so it dropped out of the prelims/psych bundle's
 * `sortedTeams` and out of the per-team maps, and its line vanished from the
 * screen. A team with some seeds past the table showed a partial sum with no
 * marker.
 *
 * Now the bundle keeps the team: `expected: null` and no `totalPoints` when
 * every seed lacks an expectation, or its sum plus `withoutExpectation` /
 * `withoutExpectationCount` when only some do.
 *
 * The dual-meet preset scores 9-4-3-2-1-0 with an A-final bracket of 6: seed 6
 * is a scored 0 and seed 7 onward is past the table.
 *
 * Mutation map (revert the change, the named case turns red):
 *  - buildProjectionBundle drops the unscored-team append  -> "a team with every seed past the table stays ..."
 *  - `expected` reads 0 for a team with no rows             -> same case (expected must be null)
 *  - gap count not added to the signature                   -> "the signature changes when only the count changes"
 *  - projectionTeamExpectations puts a null team in the map -> "the per-team maps ..."
 *  - the gap `row` of a team is mis-keyed                   -> "a team with some seeds past the table ..."
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import {
  buildPrelimsProjectedBundle,
  buildPrelimsExpectedRows,
  entryKey,
  listPrelimsEntriesWithoutExpectation,
} from '../packages/core/src/lib/prelimsProjection';
import {
  buildPsychProjectedBundle,
  buildPsychExpectedRows,
  listPsychEntriesWithoutExpectation,
} from '../packages/core/src/lib/psychProjection';
import {
  buildProjectedScoringBundle,
  projectionTeamExpectations,
} from '../packages/core/src/lib/scoringBundleAggregation';
import { buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine';
import { settingsForBuiltInScoringPreset } from '../packages/core/src/lib/scoringDefaults';

const EVENT = 'Event 5 Men 100 Yard Backstroke';
const dual = settingsForBuiltInScoringPreset('ncaa-dual-six-lanes-or-more') as ScoringSettings;

const ALPHA = 'Alpha U';
const BETA = 'Beta U';
const GAMMA = 'Gamma U';

/** One swimmer per row; `rank` is the seed. */
const swim = (team: string, name: string, rank: number, psych = false): SwimmerResult =>
  ({
    id: `${team}-${name}${psych ? '-p' : ''}`,
    rank,
    name,
    classYear: 'JR',
    team,
    time: `${50 + rank}.00`,
    points: 0,
    event: EVENT,
    gender: Gender.MEN,
    roundSwam: psych ? 'Psych Sheet' : 'Preliminaries',
    ...(psych ? { isPsychSheet: true } : {}),
  }) as SwimmerResult;

/**
 * Alpha: seeds 1 and 2 (9 + 4 = 13), nothing past the table.
 * Gamma: seed 3 (3 points) and seed 9 (past the table): a partial team.
 * Beta: seeds 7 and 8, both past the table: no expectation at all.
 */
function field(psych: boolean): SwimmerResult[] {
  return [
    swim(ALPHA, 'Ann Alpha', 1, psych),
    swim(ALPHA, 'Amy Alpha', 2, psych),
    swim(GAMMA, 'Gus Gamma', 3, psych),
    swim(BETA, 'Bea Beta', 7, psych),
    swim(BETA, 'Bo Beta', 8, psych),
    swim(GAMMA, 'Gil Gamma', 9, psych),
  ];
}

function prelimsWorkspace(rows = field(false)): Workspace {
  return {
    id: 'ws',
    name: 'ws',
    createdAt: 0,
    menResults: rows,
    womenResults: [],
    scoringSettings: dual,
  } as unknown as Workspace;
}

function psychWorkspace(rows = field(true)): Workspace {
  return {
    id: 'ws',
    name: 'ws',
    createdAt: 0,
    menResults: [],
    womenResults: [],
    psychMenResults: rows,
    psychWomenResults: [],
    scoringSettings: dual,
  } as unknown as Workspace;
}

const byName = <T extends { teamName: string }>(teams: T[], name: string): T => {
  const found = teams.find(t => t.teamName === name);
  if (!found) throw new Error(`team ${name} is not in the bundle`);
  return found;
};

describe.each([
  ['prelims', () => buildPrelimsProjectedBundle({ workspace: prelimsWorkspace(), gender: Gender.MEN })],
  ['psych', () => buildPsychProjectedBundle({ workspace: psychWorkspace(), gender: Gender.MEN })],
])('the %s projection bundle', (_label, build) => {
  const bundle = build();

  it('a team with every seed past the table stays in sortedTeams with expected null and a count', () => {
    const beta = byName(bundle.sortedTeams, BETA);
    expect(beta.expected).toBeNull();
    expect(beta.withoutExpectationCount).toBe(2);
    expect(beta.withoutExpectation).toHaveLength(2);
    // No figure to read as a number: the property is absent, not 0.
    expect('totalPoints' in beta).toBe(false);
    expect(beta.swimmers).toEqual([]);
  });

  it('names the entries by their entry key', () => {
    const beta = byName(bundle.sortedTeams, BETA);
    const keys = [swim(BETA, 'Bea Beta', 7), swim(BETA, 'Bo Beta', 8)].map(entryKey);
    expect([...beta.withoutExpectation].sort()).toEqual([...keys].sort());
  });

  it('a team with some seeds past the table keeps its sum and counts the rest', () => {
    const gamma = byName(bundle.sortedTeams, GAMMA);
    expect(gamma.expected).toBe(3);
    expect(gamma.withoutExpectationCount).toBe(1);
    expect(gamma.withoutExpectation).toEqual([entryKey(swim(GAMMA, 'Gil Gamma', 9))]);
    expect(gamma.swimmers).toHaveLength(1);
  });

  it('a team with no seed past the table has an empty list and a count of 0', () => {
    const alpha = byName(bundle.sortedTeams, ALPHA);
    expect(alpha.expected).toBe(13);
    expect(alpha.withoutExpectation).toEqual([]);
    expect(alpha.withoutExpectationCount).toBe(0);
  });

  it('lists scored teams by points, then the teams with no expectation', () => {
    expect(bundle.sortedTeams.map(t => t.teamName)).toEqual([ALPHA, GAMMA, BETA]);
  });

  it('keeps the entries the table has no row for out of the scored rows', () => {
    const names = bundle.allResults.map(r => r.name);
    expect(names).not.toContain('Bea Beta');
    expect(names).not.toContain('Gil Gamma');
    expect(names).toContain('Gus Gamma');
  });

  it('crosses the worker boundary by structured clone, intact', () => {
    const clone = structuredClone(bundle);
    expect(clone).toStrictEqual(bundle);
    expect(byName(clone.sortedTeams, BETA).expected).toBeNull();
  });
});

describe('the list functions and the bundle agree', () => {
  it('prelims: the bundle names exactly the entries the list function names', () => {
    const rows = field(false);
    const listed = listPrelimsEntriesWithoutExpectation(rows, dual).sort();
    const bundle = buildPrelimsProjectedBundle({ workspace: prelimsWorkspace(rows), gender: Gender.MEN });
    const fromBundle = bundle.sortedTeams.flatMap(t => t.withoutExpectation).sort();
    expect(fromBundle).toEqual(listed);
    expect(listed).toHaveLength(3);
  });

  it('psych: the bundle names exactly the entries the list function names', () => {
    const rows = field(true);
    const listed = listPsychEntriesWithoutExpectation(rows, dual).sort();
    const bundle = buildPsychProjectedBundle({ workspace: psychWorkspace(rows), gender: Gender.MEN });
    const fromBundle = bundle.sortedTeams.flatMap(t => t.withoutExpectation).sort();
    expect(fromBundle).toEqual(listed);
    expect(listed).toHaveLength(3);
  });
});

describe('a seed the table scores 0 is a real 0, not an absent expectation', () => {
  it('a team whose only seed is rank 6 has expected 0 and a count of 0', () => {
    const rows = [swim(ALPHA, 'Ann Alpha', 1), swim('Delta U', 'Dee Delta', 6)];
    const bundle = buildPrelimsProjectedBundle({ workspace: prelimsWorkspace(rows), gender: Gender.MEN });
    const delta = byName(bundle.sortedTeams, 'Delta U');
    expect(delta.expected).toBe(0);
    expect(delta.withoutExpectationCount).toBe(0);
    expect('totalPoints' in delta).toBe(true);
  });
});

describe('a bundle with no seed past the table is unchanged', () => {
  const rows = [swim(ALPHA, 'Ann Alpha', 1), swim(ALPHA, 'Amy Alpha', 2), swim(GAMMA, 'Gus Gamma', 3)];

  it('every team total and the style signature match the pre-change aggregation', () => {
    const bundle = buildPrelimsProjectedBundle({ workspace: prelimsWorkspace(rows), gender: Gender.MEN });
    const expectedRows = buildPrelimsExpectedRows(rows, dual);
    const legacy = buildProjectedScoringBundle(expectedRows, expectedRows);
    expect(bundle.sortedTeams.map(t => [t.teamName, t.expected, t.color])).toEqual(
      legacy.sortedTeams.map(t => [t.teamName, t.totalPoints, t.color])
    );
    expect(bundle.teamStyleSignature).toBe(legacy.teamStyleSignature);
    expect(bundle.timelineData).toEqual(legacy.timelineData);
    expect(bundle.events).toEqual(legacy.events);
    expect(bundle.visibleEvents).toEqual(legacy.visibleEvents);
    // Runtime still carries the old field for a team that has a number.
    expect(bundle.sortedTeams.map(t => (t as unknown as { totalPoints: number }).totalPoints)).toEqual(
      legacy.sortedTeams.map(t => t.totalPoints)
    );
    expect(bundle.sortedTeams.every(t => t.withoutExpectationCount === 0)).toBe(true);
  });

  it('psych matches too', () => {
    const psychRows = rows.map(r => ({ ...r, roundSwam: 'Psych Sheet', isPsychSheet: true }) as SwimmerResult);
    const bundle = buildPsychProjectedBundle({ workspace: psychWorkspace(psychRows), gender: Gender.MEN });
    const expectedRows = buildPsychExpectedRows(psychRows, dual);
    const legacy = buildProjectedScoringBundle(expectedRows, expectedRows);
    expect(bundle.teamStyleSignature).toBe(legacy.teamStyleSignature);
    expect(bundle.sortedTeams.map(t => t.expected)).toEqual(legacy.sortedTeams.map(t => t.totalPoints));
  });
});

describe('the style signature', () => {
  const sig = (rows: SwimmerResult[]) =>
    buildPrelimsProjectedBundle({ workspace: prelimsWorkspace(rows), gender: Gender.MEN }).teamStyleSignature;

  it('changes when only the count changes and the sum stays put', () => {
    const oneGap = [swim(ALPHA, 'Ann Alpha', 1), swim(BETA, 'Bea Beta', 7)];
    const twoGaps = [swim(ALPHA, 'Ann Alpha', 1), swim(BETA, 'Bea Beta', 7), swim(BETA, 'Bo Beta', 8)];
    expect(sig(oneGap)).not.toBe(sig(twoGaps));
    expect(sig(oneGap)).toContain(':gap1');
    expect(sig(twoGaps)).toContain(':gap2');
  });

  it('carries no gap marker when no seed is past the table', () => {
    expect(sig([swim(ALPHA, 'Ann Alpha', 1)])).not.toContain('gap');
  });
});

describe('the per-team maps', () => {
  it('hold a number only for a team that has one, and a count for each team with a gap', () => {
    const bundle = buildPrelimsProjectedBundle({ workspace: prelimsWorkspace(), gender: Gender.MEN });
    const { expectedByTeam, withoutExpectationByTeam } = projectionTeamExpectations(bundle.sortedTeams);
    expect([...expectedByTeam.entries()].sort()).toEqual([
      [ALPHA, 13],
      [GAMMA, 3],
    ]);
    expect(expectedByTeam.has(BETA)).toBe(false);
    expect([...withoutExpectationByTeam.entries()].sort()).toEqual([
      [BETA, 2],
      [GAMMA, 1],
    ]);
  });
});

describe('the scoring snapshot (the worker payload)', () => {
  it('carries the team with no expectation, and structured-clones', () => {
    const snap = buildScoringSnapshot(prelimsWorkspace(), Gender.MEN, false);
    expect(byName(snap.prelimsProjected.sortedTeams, BETA).expected).toBeNull();
    const clone = structuredClone(snap);
    expect(byName(clone.prelimsProjected.sortedTeams, BETA).withoutExpectationCount).toBe(2);
  });
});
