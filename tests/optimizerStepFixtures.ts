/**
 * Shared workspace fixtures for the Phase 4 optimizer tests. Ported from
 * scripts/test_optimizer_never_loses.mjs: the meet workspace is one where the
 * optimizer really gains, the roster-only workspace is the recruit-driven shape.
 * Not a test file (no .test suffix), so vitest does not collect it.
 */
import { Gender, ClassYear, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS, mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults';
import { buildScoringBundle, type ScoringBundle } from '../packages/core/src/lib/scoringEngine';

export const HOME_TEAM = 'Henderson State University';
export const RIVAL_TEAM = 'Ouachita Baptist University';

function secondsToTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const ss = s.toFixed(2).padStart(5, '0');
  return m > 0 ? `${m}:${ss}` : ss;
}

const UNHELD_EVENT = '200 Breaststroke';
const MEET_EVENTS = ['50 Freestyle', '100 Freestyle', '200 Freestyle', '100 Butterfly'];

/**
 * A meet is loaded and HSU has faster history times than the meet shows, so the
 * optimizer genuinely gains. `seniors` marks that many HSU swimmers as SR so
 * "Drop seniors" changes the field.
 */
export function buildMeetWorkspace(
  options: { seniorIndexes?: number[]; unheldEvent?: boolean } = {}
): Workspace {
  const seniorIndexes = new Set(options.seniorIndexes ?? []);
  const menResults: SwimmerResult[] = [];
  let id = 0;
  for (const [e, event] of MEET_EVENTS.entries()) {
    const field: Array<{ team: string; i: number }> = [];
    for (let i = 0; i < 4; i++) {
      field.push({ team: HOME_TEAM, i });
      field.push({ team: RIVAL_TEAM, i });
    }
    field
      .map((entry, k) => ({
        ...entry,
        seconds: 21 + e * 22 + k * 0.4 + (entry.team === RIVAL_TEAM ? 0.15 : 0),
      }))
      .sort((a, b) => a.seconds - b.seconds)
      .forEach((entry, k) => {
        menResults.push({
          id: `pdf-${id++}`,
          rank: k + 1,
          name: `${entry.team === HOME_TEAM ? 'Hsu' : 'Obu'} Swimmer ${entry.i}`,
          classYear: entry.team === HOME_TEAM && seniorIndexes.has(entry.i) ? ClassYear.SR : ClassYear.SO,
          team: entry.team,
          time: secondsToTime(entry.seconds),
          finalsTime: secondsToTime(entry.seconds),
          roundSwam: 'A Final',
          points: 0,
          event,
          gender: Gender.MEN,
        } as SwimmerResult);
      });
  }
  const athleteHistory = [];
  for (let i = 0; i < 4; i++) {
    for (const [e, event] of MEET_EVENTS.entries()) {
      athleteHistory.push({
        name: `Hsu Swimmer ${i}`,
        team: HOME_TEAM,
        gender: Gender.MEN,
        event,
        time: secondsToTime(20.4 + e * 22 + i * 0.2),
        timeType: 'SCY',
        source: 'paste',
      });
    }
  }
  if (options.unheldEvent) {
    // An event no HSU swimmer swam at the meet but one has a strong history time
    // in: the optimizer may plan it, so it really gains. Ported from
    // scripts/test_optimizer_never_loses.mjs section 6.
    for (let i = 1; i < 4; i++) {
      menResults.push({
        id: `unheld-hsu-${i}`, rank: i * 2, name: `Hsu Swimmer ${i}`,
        classYear: seniorIndexes.has(i) ? ClassYear.SR : ClassYear.SO,
        team: HOME_TEAM, time: secondsToTime(121 + i), finalsTime: secondsToTime(121 + i),
        roundSwam: 'A Final', points: 0, event: UNHELD_EVENT, gender: Gender.MEN,
      } as SwimmerResult);
    }
    for (let i = 0; i < 4; i++) {
      menResults.push({
        id: `unheld-obu-${i}`, rank: i * 2 + 1, name: `Obu Swimmer ${i}`, classYear: ClassYear.SO,
        team: RIVAL_TEAM, time: secondsToTime(120 + i), finalsTime: secondsToTime(120 + i),
        roundSwam: 'A Final', points: 0, event: UNHELD_EVENT, gender: Gender.MEN,
      } as SwimmerResult);
    }
    athleteHistory.push({
      name: 'Hsu Swimmer 0', team: HOME_TEAM, gender: Gender.MEN, event: UNHELD_EVENT,
      time: secondsToTime(110), timeType: 'SCY', source: 'paste',
    });
  }
  return {
    id: 'ws-meet',
    name: 'Meet Workspace',
    createdAt: 1,
    conference: 'NSISC',
    menResults,
    womenResults: [],
    recruits: [],
    athleteHistory,
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    scorerRosterOverrides: [],
    meetEntryPlans: [],
    activeEntryIds: [],
  } as unknown as Workspace;
}

/** Recruit-only workspace with no meet: the shape where nothing beats the current lineup. */
export function buildRosterOnlyWorkspace(): Workspace {
  const recruits = [];
  for (let i = 0; i < 22; i++) {
    ['50 Freestyle', '100 Freestyle', '100 Backstroke'].forEach((event, e) => {
      recruits.push({
        id: `rec-${i}-${e}`,
        name: `Athlete ${String(i).padStart(2, '0')}`,
        team: HOME_TEAM,
        event,
        time: secondsToTime(21 + e * 25 + i * 0.31),
        gender: Gender.MEN,
        classYear: ClassYear.FR,
        timeType: 'SCY',
      });
    });
  }
  return {
    id: 'ws-roster-only',
    name: 'Roster Plan (no meet)',
    createdAt: 1,
    conference: 'NSISC',
    menResults: [],
    womenResults: [],
    recruits,
    athleteHistory: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    scorerRosterOverrides: [],
    meetEntryPlans: [
      {
        id: 'plan-keep-1',
        name: 'Athlete 00',
        team: HOME_TEAM,
        gender: Gender.MEN,
        classYear: ClassYear.FR,
        event: '200 Freestyle',
        time: '1:42.00',
        source: 'manual',
        active: true,
      },
    ],
    activeEntryIds: ['plan-keep-1'],
  } as unknown as Workspace;
}

/** The scoring settings the Manager hands every step: `useWorkspaceScoring`'s own merge. */
export function resolvedScoringSettings(workspace: Workspace) {
  return mergeScoringSettings(workspace.scoringSettings, {
    conference: workspace.conference,
    resultsForPdfHint: [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])],
  });
}

/** The scoring bundle the Manager hands the Lineup step. */
export function scoringBundleFor(workspace: Workspace, removeSeniors: boolean): ScoringBundle {
  return buildScoringBundle({
    workspace,
    gender: Gender.MEN,
    removeSeniors,
    applyWhatIf: true,
    scorerRosterOverrides: workspace.scorerRosterOverrides,
  });
}
