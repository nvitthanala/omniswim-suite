/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The projection takes a non-scorer off a relay under the same scoring rules
 * the engine scores with — including rules the conference imposes.
 *
 * FIXED 2026-10-01 (found the same day by the bug-hunter pass). These cases pin
 * the corrected behaviour; the description below records the defect they guard.
 *
 * `buildWhatIfProjection` (whatIfProjection.ts) calls
 * `computeVacateRelayLegNames(..., mergeScoringSettings(workspace.scoringSettings), ...)`
 * WITHOUT `{ conference }`. Every other scoring step merges with the
 * conference. For an NSISC workspace whose stored settings are the generic
 * default — the real HSU and OBU roster workspaces store `scoringSettings: {}`
 * with conference NSISC — the engine scores in roster mode, but the vacate
 * step sees non-roster settings and vacates nothing. A swimmer the coach turned
 * off as a scorer stays on the relay and scores, while the lineup audit (which
 * receives conference-merged settings) tells the coach the leg needs a
 * replacement.
 *
 * Fixture is synthetic: invented team, names and times.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { buildScoringBundle } from '../packages/core/src/lib/scoringEngine';

const TEAM = 'Alpha University';
const OFF = 'Cam Mask';

function rows(): SwimmerResult[] {
  const ind = (id: string, name: string, rank: number, time: string) =>
    ({
      id,
      rank,
      name,
      classYear: 'JR',
      team: TEAM,
      time,
      finalsTime: time,
      points: 0,
      event: 'Event 4 Men 50 Yard Freestyle',
      gender: Gender.MEN,
      roundSwam: 'A Final',
    }) as SwimmerResult;
  const legs = [OFF, 'Bo Bee', 'Cy Cee', 'Di Dee'];
  const relay = legs.map(
    (name, i) =>
      ({
        id: `r-${i}`,
        rank: 1,
        name,
        classYear: 'JR',
        team: TEAM,
        time: '1:20.00',
        finalsTime: '1:20.00',
        relayTeamTime: '1:20.00',
        roundSwam: 'A Final',
        points: 0,
        event: 'Event 1 Men 200 Yard Freestyle Relay',
        gender: Gender.MEN,
        isRelay: true,
        relayLegIndex: i,
        relayNames: legs.map(n => ({ name: n, year: 'JR' })),
      }) as SwimmerResult
  );
  return [ind('i1', OFF, 1, '20.10'), ind('i2', 'Bo Bee', 2, '20.50'), ...relay];
}

/** Does the non-scorer still hold relay leg 1 in the projection? */
function nonScorerStillOnRelay(stored: Partial<ScoringSettings>): boolean {
  const menResults = rows();
  const workspace = {
    id: 'ws-vacate-conference',
    name: 'vacate conference probe',
    createdAt: 0,
    menResults,
    womenResults: [],
    sourceMenResults: menResults,
    sourceWomenResults: [],
    recruits: [],
    scoringSettings: stored,
    conference: 'NSISC',
    meetEntryPlans: [],
    activeEntryIds: [],
    historySources: [],
    relayLegOverrides: [],
    athleteHistory: [],
    athleteAliases: [],
    scorerRosterOverrides: [{ name: OFF, team: TEAM, gender: Gender.MEN, isScorer: false }],
  } as unknown as Workspace;
  const bundle = buildScoringBundle({
    workspace,
    gender: Gender.MEN,
    removeSeniors: false,
    applyWhatIf: true,
    scorerRosterOverrides: workspace.scorerRosterOverrides,
  });
  return bundle.allScored.some(r => r.isRelay && r.name === OFF);
}

describe('an NSISC non-scorer is taken off the relay in the projection', () => {
  it('when the stored settings say roster mode (control)', () => {
    expect(nonScorerStillOnRelay({ scorerEligibilityMode: 'roster' })).toBe(false);
  });

  it('when only the conference makes it roster mode (stored settings empty)', () => {
    expect(nonScorerStillOnRelay({})).toBe(false);
  });
});
