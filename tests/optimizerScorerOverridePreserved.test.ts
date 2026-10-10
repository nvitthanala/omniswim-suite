/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The scorers stage must not lose a coach's OFF override, and the `overrides` it
 * returns must agree with the `rejected` list it returns.
 *
 * FIXED 2026-10-01. `optimizeScorersForTeam` dropped every override for the team,
 * then re-added one only where the optimizer's wish differed from
 * `lookup.isScorer(...)`. That lookup was built WITH the overrides just dropped, so
 * a coach's OFF on an athlete the optimizer also wants off compared equal and
 * nothing was written back. With the override gone the athlete reverted to
 * scorer, while `rejected` still listed them: the two outputs disagreed.
 */
import { describe, expect, it } from 'vitest';
import { ClassYear, Gender, type Recruit, type ScorerRosterOverride, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS, mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults';
import { buildScorerRosterLookup } from '../packages/core/src/lib/scorerRoster';
import { buildScoringBundle } from '../packages/core/src/lib/scoringEngine';
import { optimizeScorersForTeam } from '../packages/core/src/lib/rosterOptimizer';

const ALPHA = 'Alpha University';
const BRAVO = 'Bravo University';
const EVENT = 'Event 8 Men 50 Yard Freestyle';

function meetRow(id: string, name: string, team: string, rank: number, time: string): SwimmerResult {
  return {
    id,
    rank,
    name,
    classYear: 'JR',
    team,
    time,
    finalsTime: time,
    roundSwam: 'A Final',
    points: 0,
    event: EVENT,
    gender: Gender.MEN,
  } as SwimmerResult;
}

const MEET: SwimmerResult[] = [
  meetRow('m1', 'Bravo One', BRAVO, 1, '20.00'),
  meetRow('m2', 'Bravo Two', BRAVO, 2, '20.50'),
];

function recruit(id: string, name: string, time: string): Recruit {
  return { id, name, team: ALPHA, event: '50 Freestyle', time, gender: Gender.MEN, classYear: ClassYear.JR, timeType: 'SCY' };
}

function workspace(overrides: ScorerRosterOverride[], cap = 1): Workspace {
  return {
    id: 'ws-opt-override',
    name: 'optimizer override probe',
    createdAt: 0,
    menResults: MEET,
    womenResults: [],
    sourceMenResults: MEET,
    sourceWomenResults: [],
    recruits: [recruit('r1', 'Al Late', '20.90'), recruit('r2', 'Bo Quick', '20.10'), recruit('r3', 'Cy Mid', '20.30')],
    // No conference: a conference preset would lock the scorer cap.
    scoringSettings: { ...NSISC_PRESET_SETTINGS, scorerEligibilityMode: 'roster', maxIndividualScorersPerTeam: cap },
    meetEntryPlans: [],
    activeEntryIds: [],
    scorerRosterOverrides: overrides,
    relayLegOverrides: [],
    athleteHistory: [],
    athleteAliases: [],
  } as unknown as Workspace;
}

const OFF = (name: string): ScorerRosterOverride => ({ name, team: ALPHA, gender: Gender.MEN, isScorer: false });

function run(ws: Workspace) {
  const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
  const result = optimizeScorersForTeam(ws, Gender.MEN, ALPHA, false, settings);
  const bundle = buildScoringBundle({
    workspace: ws,
    gender: Gender.MEN,
    removeSeniors: false,
    applyWhatIf: true,
    scorerRosterOverrides: result.overrides,
  });
  const lookup = buildScorerRosterLookup(bundle.allResults, settings, result.overrides, Gender.MEN);
  return { result, lookup };
}

describe('optimizeScorersForTeam keeps overrides and rejected in agreement', () => {
  it("re-emits a coach's OFF override the optimizer also wants", () => {
    const { result, lookup } = run(workspace([OFF('Al Late')]));
    expect(result.rejected.map(r => r.name)).toContain('Al Late');
    expect(result.overrides).toContainEqual(OFF('Al Late'));
    expect(lookup.isScorer('Al Late', ALPHA, Gender.MEN)).toBe(false);
  });

  it('every rejected athlete is off, and every other roster row is on, under the returned overrides', () => {
    const { result, lookup } = run(workspace([OFF('Al Late')]));
    const rejected = new Set(result.rejected.map(r => r.name));
    const teamRows = lookup.rows.filter(r => r.team === ALPHA);
    expect(teamRows.length).toBeGreaterThan(1);
    for (const row of teamRows) {
      expect(lookup.isScorer(row.name, ALPHA, Gender.MEN)).toBe(!rejected.has(row.name));
    }
    // Cap 1: exactly one scorer remains.
    expect(teamRows.filter(r => lookup.isScorer(r.name, ALPHA, Gender.MEN))).toHaveLength(1);
  });

  it('with no existing override the result is unchanged in kind: the same invariant holds', () => {
    const { result, lookup } = run(workspace([]));
    const rejected = new Set(result.rejected.map(r => r.name));
    for (const row of lookup.rows.filter(r => r.team === ALPHA)) {
      expect(lookup.isScorer(row.name, ALPHA, Gender.MEN)).toBe(!rejected.has(row.name));
    }
  });

  it('an OFF override the optimizer overrules is not left listed as rejected', () => {
    // Cap 3 holds all three recruits, so the optimizer wants Al Late ON and writes no
    // override for him. He must then be a scorer under the returned overrides AND
    // absent from `rejected`: a stale OFF must not decide either answer.
    const { result, lookup } = run(workspace([OFF('Al Late')], 3));
    expect(lookup.isScorer('Al Late', ALPHA, Gender.MEN)).toBe(true);
    expect(result.rejected.map(r => r.name)).not.toContain('Al Late');
    const rejected = new Set(result.rejected.map(r => r.name));
    for (const row of lookup.rows.filter(r => r.team === ALPHA)) {
      expect(lookup.isScorer(row.name, ALPHA, Gender.MEN)).toBe(!rejected.has(row.name));
    }
  });
});
