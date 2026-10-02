import { describe, expect, it } from 'vitest';
import { Gender, type HistoricalSwim, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { optimizeEventLineupForTeam, optimizeRosterForTeam, teamTotalForTeam } from '../packages/core/src/lib/rosterOptimizer';
import { previewHistoryImportActions } from '../packages/core/src/lib/historyImportRoster';

const A = 'Alpha University';
const B = 'Beta College';
const ANN = 'Ann Able';
const BACK = 'Event 9 Men 100 Yard Backstroke';
const FLY = 'Event 10 Men 100 Yard Butterfly';
function row(id: string, name: string, team: string, event: string, time: string, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  return { id, rank: 1, name, classYear: 'JR', team, time, finalsTime: time, points: 0, event, gender: Gender.MEN, roundSwam: 'A Final', ...extra } as SwimmerResult;
}
function history(name: string, team: string, event: string, time: string, extra: Partial<HistoricalSwim> = {}): HistoricalSwim {
  return { name, team, gender: Gender.MEN, event, time, timeType: 'SCY', source: 'paste', ...extra } as HistoricalSwim;
}
function ws(menResults: SwimmerResult[], extra: Partial<Workspace> = {}): Workspace {
  return { id: 'regression', name: 'regression', createdAt: 0, menResults, womenResults: [], sourceMenResults: menResults, sourceWomenResults: [], recruits: [], scoringSettings: { ...NSISC_PRESET_SETTINGS, maxIndividualEntriesPerSwimmer: 999, maxTotalEntriesPerSwimmer: 7 }, meetEntryPlans: [], activeEntryIds: [], athleteHistory: [], historySources: [], scorerRosterOverrides: [], relayLegOverrides: [], ...extra } as unknown as Workspace;
}

describe('optimizer preserves published entries and the caller’s team state', () => {
  it('does not plan over a published event even when recruit and history times are faster, while still planning a free event', () => {
    const workspace = ws([
      row('held', ANN, A, BACK, '55.00'),
      row('r-back', 'Rival Back', B, BACK, '50.00'),
      row('r-fly', 'Rival Fly', B, FLY, '50.00'),
    ], {
      recruits: [{ id: 'recruit-ann', name: ANN, team: A, gender: Gender.MEN, classYear: 'JR', event: '100 Backstroke', time: '54.50', timeType: 'SCY' }] as never,
      athleteHistory: [history(ANN, A, '100 Backstroke', '50.00'), history(ANN, A, '100 Butterfly', '49.00')],
    });
    const { plans } = optimizeEventLineupForTeam(workspace, Gender.MEN, A, workspace.scoringSettings!);
    expect(plans.some(p => p.team === A && p.name === ANN && /100\s+Yard\s+Backstroke|100 Backstroke/i.test(p.event))).toBe(false);
    expect(plans.some(p => p.team === A && p.name === ANN && /100\s+Yard\s+Butterfly|100 Butterfly/i.test(p.event))).toBe(true);
  });

  it('keeps plan_sheet exempt from the published-event hold rule', () => {
    const workspace = ws([row('held', ANN, A, BACK, '55.00'), row('rival', 'Rival', B, BACK, '50.00')], {
      entryPlanMode: 'plan_sheet',
      athleteHistory: [history(ANN, A, '100 Backstroke', '50.00')],
    });
    const { plans } = optimizeEventLineupForTeam(workspace, Gender.MEN, A, workspace.scoringSettings!);
    expect(plans.some(p => p.team === A && p.name === ANN && /100 Backstroke/i.test(p.event))).toBe(true);
  });


});

describe('history import filters published rows by normalized team and optional gender', () => {
  it.each([
    ['trailing whitespace in team', `${A} `, Gender.MEN],
    ['missing gender', A, undefined],
  ])('includes a published row with %s in roster matching', (_label, publishedTeam, publishedGender) => {
    const published = row('published', ANN, publishedTeam as string, BACK, '55.00', { gender: publishedGender as Gender | undefined });
    const workspace = ws([published]);
    const actions = previewHistoryImportActions(workspace, [history(ANN, A, '100 Backstroke', '54.00')], { team: A, gender: Gender.MEN });
    expect(actions[0]?.matchedRosterName).toBe(ANN);
  });
});

describe('optimizeRosterForTeam keeps other teams plans active when the list starts empty', () => {
  it("returns an explicit active list that keeps other teams' plans (F5)", () => {
    const planA = { id: 'plan-a', name: 'Al Two', team: A, gender: Gender.MEN, event: '100 Backstroke', time: '50.00', timeType: 'SCY', source: 'manual', active: true };
    const workspace = ws([
      row('a', 'Al Two', A, FLY, '56.00'), row('b', 'Bo Bee', B, BACK, '54.00'),
      row('a-rival', 'A Rival', A, BACK, '53.00'), row('b-rival', 'B Rival', B, FLY, '52.00'),
    ], {
      meetEntryPlans: [planA] as never,
      activeEntryIds: [],
      athleteHistory: [history('Bo Bee', B, '100 Butterfly', '50.00')],
    });
    const result = optimizeRosterForTeam(workspace, Gender.MEN, B, false, workspace.scoringSettings!, 'events');
    // Precondition: team B really did write a plan, otherwise the empty list stays empty and the test proves nothing.
    expect(result.meetEntryPlans.some(p => p.team === B)).toBe(true);
    // The returned list must name team A's plan explicitly. A list holding only B's new ids would
    // read as "only these are active" and silently switch A's plan off.
    expect(result.activeEntryIds).toContain('plan-a');
    const withA = teamTotalForTeam({ ...workspace, meetEntryPlans: result.meetEntryPlans, activeEntryIds: result.activeEntryIds }, Gender.MEN, false, workspace.scoringSettings!, A);
    const withoutA = teamTotalForTeam({ ...workspace, meetEntryPlans: result.meetEntryPlans, activeEntryIds: result.activeEntryIds.filter(id => id !== 'plan-a') }, Gender.MEN, false, workspace.scoringSettings!, A);
    expect(withA).toBeGreaterThan(withoutA);
  });
});
