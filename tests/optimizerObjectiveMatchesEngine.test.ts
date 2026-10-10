/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The roster optimizer maximises the same team total the app displays.
 *
 * `teamTotalForTeam` (rosterOptimizer.ts) is the optimizer's objective. The
 * total a coach sees is `buildScoringBundle` (scoringEngine.ts). Scored from
 * one workspace state, the two must agree to the point — otherwise the
 * optimizer ranks lineups by a number nobody is shown.
 *
 * FIXED 2026-10-01 (found the same day by the bug-hunter pass). The objective now
 * comes from `buildScoringBundle`; these cases pin that. The two causes below are
 * what the old, separate scoring call got wrong.
 *
 * `teamTotalsForState` builds its own `calculatePoints` call and leaves out two
 * things the engine does:
 *
 * 1. `scoredEventNumberMax: workspace.officialTeamScores?.eventThrough`. The
 *    2026 NSISC results score "Through Event 42" (results PDF page 76, see
 *    scripts/test_nsisc_team_totals.mjs) and print post-meet events 938/939
 *    after it. The engine leaves those out; the optimizer scores them. On the
 *    real results below, Delta State's objective is 20 points above its
 *    displayed total in both genders.
 * 2. Alias collapse. The engine renames linked spellings to one identity before
 *    scoring; the optimizer does not, so the two spellings are two swimmers
 *    (two scorer-pool slots, two placings, and a scorer override recorded
 *    under one spelling misses the other). On the local real workspace
 *    (`data/meets.json`, not committed) HSU men read 1150 displayed against
 *    1076 optimized; with names resolved before projecting, both read 1107.
 *
 * Case 1 uses the committed parser output of the real 2026 NSISC
 * Championships (`tests/test_nsisc_output.json`). Case 2 is synthetic.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClassYear, Gender, type Recruit, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS, mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults';
import { buildScoringBundle } from '../packages/core/src/lib/scoringEngine';
import { teamTotalForTeam } from '../packages/core/src/lib/rosterOptimizer';
import { parseEventNumber } from '../packages/core/src/lib/utils';

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
  relay_team_time: string | null;
};

const parserOut = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'test_nsisc_output.json'), 'utf8')
) as ParserRow[];

/** The real parser row, mapped onto the `SwimmerResult` shape the engine consumes. */
function toSwimmerResult(r: ParserRow, idx: number): SwimmerResult {
  const time = r.round_swam === 'Preliminaries' ? r.prelims_time ?? '' : r.finals_time ?? r.prelims_time ?? '';
  return {
    id: `nsisc-2026-${idx}`,
    rank: r.rank,
    name: r.name,
    classYear: r.year,
    team: r.team,
    time,
    finalsTime: r.finals_time ?? undefined,
    prelimsTime: r.prelims_time ?? undefined,
    roundSwam: r.round_swam,
    event: r.event,
    gender: r.gender === 'Women' ? Gender.WOMEN : Gender.MEN,
    isRelay: r.is_relay,
    ...(r.relay_team_time ? { relayTeamTime: r.relay_team_time } : {}),
    isExhibition: false,
    isTimeTrial: /time trial/i.test(r.event),
    points: 0,
  } as SwimmerResult;
}

const NSISC_ROWS = parserOut.map(toSwimmerResult);

/** Results PDF page 76: "Team Rankings - Through Event 42". */
const EVENT_THROUGH = 42;

function nsiscWorkspace(rows: SwimmerResult[], extra: Partial<Workspace> = {}): Workspace {
  const men = rows.filter(r => r.gender === Gender.MEN);
  const women = rows.filter(r => r.gender === Gender.WOMEN);
  return {
    id: 'ws-nsisc-2026',
    name: 'NSISC 2026 (committed parser output)',
    createdAt: 0,
    menResults: men,
    womenResults: women,
    sourceMenResults: men,
    sourceWomenResults: women,
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    officialTeamScores: { eventThrough: EVENT_THROUGH },
    meetEntryPlans: [],
    activeEntryIds: [],
    historySources: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    athleteHistory: [],
    ...extra,
  } as unknown as Workspace;
}

/** Displayed total and optimizer objective for every team, from one state. */
function displayedVsObjective(ws: Workspace, gender: Gender): Record<string, [number, number]> {
  const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
  const bundle = buildScoringBundle({
    workspace: ws,
    gender,
    removeSeniors: false,
    applyWhatIf: true,
    scorerRosterOverrides: ws.scorerRosterOverrides,
  });
  return Object.fromEntries(
    bundle.sortedTeams.map(t => [
      t.teamName,
      [t.totalPoints, teamTotalForTeam(ws, gender, false, settings, t.teamName, ws.scorerRosterOverrides ?? [])],
    ])
  );
}

function disagreements(table: Record<string, [number, number]>): string[] {
  return Object.entries(table)
    .filter(([, [shown, objective]]) => Math.abs(shown - objective) > 1e-9)
    .map(([team, [shown, objective]]) => `${team}: displayed ${shown}, optimizer ${objective}`);
}

const inScoredProgram = (r: SwimmerResult) => {
  const n = parseEventNumber(r.event);
  return n == null || n <= EVENT_THROUGH;
};

describe('optimizer objective equals the displayed total — real 2026 NSISC results', () => {
  it.each([Gender.MEN, Gender.WOMEN])('agree for every %s team when no event lies past the boundary (control)', gender => {
    const ws = nsiscWorkspace(NSISC_ROWS.filter(inScoredProgram));
    const table = displayedVsObjective(ws, gender);
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(3);
    expect(disagreements(table)).toEqual([]);
  });

  it.each([Gender.MEN, Gender.WOMEN])(
    'agree for every %s team with the post-meet events 938/939 loaded',
    gender => {
      expect(disagreements(displayedVsObjective(nsiscWorkspace(NSISC_ROWS), gender))).toEqual([]);
    }
  );
});

/**
 * The coach has turned the athlete off as a scorer under the canonical
 * spelling. The engine applies that to both spellings once it has collapsed
 * them; the optimizer, which never collapses them, still scores the recruit
 * row stored under the alias spelling.
 */
describe('optimizer objective equals the displayed total — alias-linked recruit, scorer turned off', () => {
  const ALPHA = 'Alpha University';
  const BRAVO = 'Bravo University';
  const EVENT = 'Event 8 Men 50 Yard Freestyle';
  const row = (id: string, name: string, team: string, rank: number, time: string): SwimmerResult =>
    ({
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
    }) as SwimmerResult;
  const meet = [
    row('m1', 'Bravo One', BRAVO, 1, '20.00'),
    row('m2', 'Oliver Pozvai', ALPHA, 2, '20.28'),
    row('m3', 'Bravo Three', BRAVO, 3, '20.40'),
  ];
  const recruit = (name: string): Recruit => ({
    id: 'rc1',
    name,
    team: ALPHA,
    event: '50 Freestyle',
    time: '20.22',
    gender: Gender.MEN,
    classYear: ClassYear.JR,
    timeType: 'SCY',
  });
  const ws = (recruitName: string) =>
    nsiscWorkspace([], {
      menResults: meet,
      sourceMenResults: meet,
      officialTeamScores: undefined,
      recruits: [recruit(recruitName)],
      scorerRosterOverrides: [{ name: 'Oliver Pozvai', team: ALPHA, gender: Gender.MEN, isScorer: false }],
      athleteAliases: [
        {
          id: 'link-1',
          gender: Gender.MEN,
          team: ALPHA,
          canonicalName: 'Oliver Pozvai',
          aliasName: 'Olivér Pózvai',
          source: 'manual',
          status: 'active',
        },
      ],
    } as Partial<Workspace>);

  it('agree when the recruit row carries the canonical spelling (control)', () => {
    expect(disagreements(displayedVsObjective(ws('Oliver Pozvai'), Gender.MEN))).toEqual([]);
  });

  it('agree when the recruit row carries the linked alias spelling', () => {
    expect(disagreements(displayedVsObjective(ws('Olivér Pózvai'), Gender.MEN))).toEqual([]);
  });
});
