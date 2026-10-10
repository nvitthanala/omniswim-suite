import { describe, expect, it } from 'vitest';
import { Gender, type HistoricalSwim, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { optimizeEventLineupForTeam } from '../packages/core/src/lib/rosterOptimizer';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection';
import { countSwimmerEntries } from '../packages/core/src/lib/swimmerEntryLimits';

const TEAM = 'Alpha University';
const ANN = 'Ann Able';
const EVENTS = [
  '50 Freestyle', '100 Freestyle', '200 Freestyle', '500 Freestyle', '1000 Freestyle',
  '1650 Freestyle', '100 Butterfly', '200 Butterfly', '100 Backstroke', '200 Backstroke',
  '100 Breaststroke', '200 Breaststroke',
];

function result(id: string, event: string, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  return {
    id, rank: 1, name: ANN, classYear: 'JR', team: TEAM, time: '45.00', finalsTime: '45.00',
    points: 0, event: `Event ${id} Men ${event}`, gender: Gender.MEN, roundSwam: 'A Final', ...extra,
  } as SwimmerResult;
}

function history(event: string): HistoricalSwim {
  return { name: ANN, team: TEAM, gender: Gender.MEN, event, time: '45.00', timeType: 'SCY', source: 'paste' } as HistoricalSwim;
}

function makeWorkspace(extraRows: SwimmerResult[] = []): Workspace {
  return {
    id: 'optimizer-total-cap', name: 'optimizer total cap', createdAt: 0,
    menResults: extraRows,
    womenResults: [],
    recruits: [{ id: 'recruit-ann', name: ANN, team: TEAM, gender: Gender.MEN, classYear: 'JR', event: '50 Freestyle', time: '20.00', timeType: 'SCY' }],
    scoringSettings: { ...NSISC_PRESET_SETTINGS, maxIndividualEntriesPerSwimmer: 999, maxTotalEntriesPerSwimmer: 7 },
    conference: undefined, meetEntryPlans: [], activeEntryIds: [], scorerRosterOverrides: [], relayLegOverrides: [],
    historySources: [], athleteHistory: EVENTS.map(history),
  } as unknown as Workspace;
}

describe('optimizeEventLineupForTeam respects the total entry cap', () => {
  it('stops adding primary events when projected entries reach the total cap', () => {
    const ws = makeWorkspace();
    const settings = { ...NSISC_PRESET_SETTINGS, maxIndividualEntriesPerSwimmer: 999, maxTotalEntriesPerSwimmer: 7 };
    const { plans, activeEntryIds } = optimizeEventLineupForTeam(ws, Gender.MEN, TEAM, settings);
    const projected = buildWhatIfResults({ workspace: { ...ws, meetEntryPlans: plans, activeEntryIds }, gender: Gender.MEN, removeSeniors: false });
    expect(countSwimmerEntries(projected, TEAM, Gender.MEN, ANN, undefined, settings).total).toBe(7);
    expect(activeEntryIds).toHaveLength(6);
  });

  it('does not plan over the published exhibition event when time-trial cap policy changes', () => {
    const rows = [
      result('tt', '400 Yard Individual Medley', { isTimeTrial: true, roundSwam: 'Time Trial' }),
      result('ex', '200 Yard Individual Medley', { isExhibition: true }),
    ];
    const ws = makeWorkspace(rows);
    const settings = {
      ...NSISC_PRESET_SETTINGS, maxIndividualEntriesPerSwimmer: 999, maxTotalEntriesPerSwimmer: 2,
      entryCapCountsTimeTrials: true, entryCapCountsExhibition: false,
    };
    const { plans, activeEntryIds } = optimizeEventLineupForTeam(ws, Gender.MEN, TEAM, settings);
    const projected = buildWhatIfResults({ workspace: { ...ws, meetEntryPlans: plans, activeEntryIds }, gender: Gender.MEN, removeSeniors: false });
    expect(countSwimmerEntries(projected, TEAM, Gender.MEN, ANN, undefined, settings).total).toBe(2);
    expect(activeEntryIds).toHaveLength(0);
    const timeTrialsDoNotCount = { ...settings, entryCapCountsTimeTrials: false };
    const withoutTrialCharge = optimizeEventLineupForTeam(ws, Gender.MEN, TEAM, timeTrialsDoNotCount);
    expect(withoutTrialCharge.activeEntryIds).toHaveLength(0);
  });
});
