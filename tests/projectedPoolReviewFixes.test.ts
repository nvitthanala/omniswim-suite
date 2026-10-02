/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Three defects found by the architect review of 2026-10-01 (second pass). Each case
 * below failed before its fix and pins it afterwards.
 *
 * 1. `importHistoryToRoster` counted a swimmer's entries over the raw meet rows, so a
 *    relay leg held only through `relayLegOverrides` was invisible, and an INACTIVE
 *    plan was charged. The lineup audit counts over the projected pool
 *    (`buildWhatIfResults`), so the import wrote entries the audit then flagged.
 * 2. `rankRelayLegSwaps` counted a candidate's entries over the raw meet rows, so
 *    plans, recruit rows and overrides were invisible. It offered a leg that put a
 *    swimmer over the total cap.
 * 3. A pencil edit (`replacesResultId` plan) rewrites a meet row in place. A SECOND,
 *    plan-built row for the same athlete and event used to survive beside it and the
 *    athlete scored twice. The explicit user edit now stands.
 *
 * Fixtures are synthetic: invented teams, names and times. The caps are NSISC's
 * (7 total) in cases 1; case 2 sets its own total cap in the settings object. Nothing
 * is keyed to a conference name.
 */
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type HistoricalSwim,
  type PlannedSwimEntry,
  type RelayLegOverride,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';
import { countSwimmerEntries } from '../packages/core/src/lib/swimmerEntryLimits';
import { buildWhatIfProjection, buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection';
import { buildAliasResolver } from '../packages/core/src/lib/athleteAliases';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits';
import { relayTemplateFromLeg } from '../packages/core/src/lib/relayLegMatching';
import { rankRelayLegSwaps } from '../packages/core/src/lib/arbitrage/relayLegSwaps';

const TEAM = 'Alpha University';
const RIVAL = 'Beta College';
const ANN = 'Ann Able';
const MATES = ['Bo Bee', 'Cy Cee', 'Di Dee', 'Ed Eff'];

function individual(
  id: string,
  name: string,
  event: string,
  time: string,
  extra: Partial<SwimmerResult> = {}
): SwimmerResult {
  return {
    id,
    rank: 1,
    name,
    classYear: 'JR',
    team: TEAM,
    time,
    finalsTime: time,
    points: 0,
    event,
    gender: Gender.MEN,
    roundSwam: 'A Final',
    ...extra,
  } as SwimmerResult;
}

function relayRows(prefix: string, event: string, clock: string, legs: string[]): SwimmerResult[] {
  return legs.map((name, i) => ({
    id: `${prefix}-${i}`,
    rank: 1,
    name,
    classYear: 'JR',
    team: TEAM,
    time: clock,
    finalsTime: clock,
    relayTeamTime: clock,
    relayLegSplit: '20.00',
    roundSwam: 'A Final',
    points: 0,
    event,
    gender: Gender.MEN,
    isRelay: true,
    relayLegIndex: i,
    relayNames: legs.map(n => ({ name: n, year: 'JR' })),
  })) as SwimmerResult[];
}

function legOverride(rows: SwimmerResult[], legIndex: number, name: string): RelayLegOverride {
  return {
    relayEntryKey: relayEntryKey(relayTemplateFromLeg(rows, rows[0])),
    legIndex,
    assigneeName: name,
    source: 'manual',
  };
}

function plan(id: string, name: string, event: string, time: string, extra: Partial<PlannedSwimEntry> = {}): PlannedSwimEntry {
  return {
    id,
    name,
    team: TEAM,
    gender: Gender.MEN,
    event,
    time,
    timeType: 'SCY',
    source: 'manual',
    active: true,
    ...extra,
  } as PlannedSwimEntry;
}

function swim(event: string, time: string, name = ANN): HistoricalSwim {
  return {
    name,
    team: TEAM,
    gender: Gender.MEN,
    event,
    time,
    timeType: 'SCY',
    source: 'swimcloud',
    meet: 'Synthetic Invite',
    date: '2026-01-01',
  } as HistoricalSwim;
}

function workspace(menResults: SwimmerResult[], extra: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-projected-pool',
    name: 'projected pool probe',
    createdAt: 0,
    menResults,
    womenResults: [],
    sourceMenResults: menResults,
    sourceWomenResults: [],
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    meetEntryPlans: [],
    activeEntryIds: [],
    historySources: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    athleteHistory: [],
    ...extra,
  } as unknown as Workspace;
}

/** What the lineup audit reports: `countSwimmerEntries` over the projected pool. */
function auditTotal(ws: Workspace, name = ANN): number {
  const pool = buildWhatIfResults({ workspace: ws, gender: Gender.MEN, removeSeniors: false });
  return countSwimmerEntries(pool, TEAM, Gender.MEN, name, buildAliasResolver(ws)).total ?? 0;
}

// ---------------------------------------------------------------------------
// 1. The history import's entry budget counts the projected pool
// ---------------------------------------------------------------------------

const ANN_FREE_SWIMS = [
  individual('i1', ANN, 'Event 4 Men 50 Yard Freestyle', '20.10'),
  individual('i2', ANN, 'Event 10 Men 100 Yard Freestyle', '45.10'),
  individual('i3', ANN, 'Event 16 Men 200 Yard Freestyle', '1:39.00'),
];
const R200 = relayRows('r200', 'Event 1 Men 200 Yard Freestyle Relay', '1:20.00', MATES);
const R400 = relayRows('r400', 'Event 3 Men 400 Yard Freestyle Relay', '2:58.00', MATES);
const R800 = relayRows('r800', 'Event 5 Men 800 Yard Freestyle Relay', '6:40.00', MATES);
/** The loaded meet contests the four events the import brings (a teammate swims each). */
const FIELD = [
  individual('f1', 'Bo Bee', 'Event 20 Men 500 Yard Freestyle', '4:40.00'),
  individual('f2', 'Bo Bee', 'Event 22 Men 100 Yard Butterfly', '50.00'),
  individual('f3', 'Bo Bee', 'Event 24 Men 200 Yard Individual Medley', '1:55.00'),
  individual('f4', 'Bo Bee', 'Event 26 Men 100 Yard Backstroke', '51.00'),
];
const FOUR_NEW = [
  swim('500 Freestyle', '4:30.00'),
  swim('100 Butterfly', '49.00'),
  swim('200 Individual Medley', '1:50.00'),
  swim('100 Backstroke', '50.00'),
];
/** An override applies only to a leg whose holder has left, so Ed Eff (leg 3 of every relay) is removed. */
const ED_LEFT = [{ name: 'Ed Eff', gender: Gender.MEN }];
const THREE_OVERRIDES = [legOverride(R200, 3, ANN), legOverride(R400, 3, ANN), legOverride(R800, 3, ANN)];

describe('fix 1: the history import budget counts what the lineup audit counts', () => {
  const overrideWorkspace = () =>
    workspace([...ANN_FREE_SWIMS, ...R200, ...R400, ...R800, ...FIELD], {
      relayLegOverrides: THREE_OVERRIDES,
      deletedSwimmers: ED_LEFT,
    });

  it('the fixture is at 6 of 7 by the audit, and 3 by the raw meet rows (control)', () => {
    const ws = overrideWorkspace();
    expect(auditTotal(ws)).toBe(6);
    expect(countSwimmerEntries(ws.menResults ?? [], TEAM, Gender.MEN, ANN).total).toBe(3);
  });

  it('adds one entry, not four, to a swimmer at 6 of 7 through relay-leg overrides', () => {
    const ws = overrideWorkspace();
    const res = importHistoryToRoster(ws, FOUR_NEW, { team: TEAM, gender: Gender.MEN });
    expect(res.summary.lineupEntriesAdded).toBe(1);
    expect(auditTotal({ ...ws, ...res.patch })).toBe(7);
  });

  it('charges the entries this run writes: a swimmer with room for two gets exactly two', () => {
    const ws = workspace([...ANN_FREE_SWIMS, ...R200, ...R400, ...FIELD], {
      relayLegOverrides: THREE_OVERRIDES.slice(0, 2),
      deletedSwimmers: ED_LEFT,
    });
    expect(auditTotal(ws)).toBe(5);
    const res = importHistoryToRoster(ws, FOUR_NEW, { team: TEAM, gender: Gender.MEN });
    expect(res.summary.lineupEntriesAdded).toBe(2);
    expect(auditTotal({ ...ws, ...res.patch })).toBe(7);
  });

  it('charges what an earlier group of the same run wrote for the same swimmer', () => {
    // Two spellings that fold to one roster name are two incoming groups, one swimmer, one cap.
    const ws = overrideWorkspace();
    const incoming = [swim('500 Freestyle', '4:30.00', ANN), swim('100 Butterfly', '49.00', 'Ãnn Able')];
    const res = importHistoryToRoster(ws, incoming, { team: TEAM, gender: Gender.MEN });
    expect(res.patch.meetEntryPlans?.map(p => p.name)).toEqual([ANN]);
    expect(res.summary.lineupEntriesAdded).toBe(1);
    expect(auditTotal({ ...ws, ...res.patch })).toBe(7);
  });

  it('an inactive plan does not spend an entry', () => {
    // 3 meet events + 4 inactive plans: the audit reads 3. The inactive plans' events stay
    // blocked (a plan exists there), so the import brings the other events.
    const inactive = ['200 Backstroke', '200 Butterfly', '200 Breaststroke', '1000 Freestyle'].map((event, i) =>
      plan(`inactive-${i}`, ANN, event, '1:00.00', { active: false })
    );
    const ws = workspace([...ANN_FREE_SWIMS, ...FIELD], { meetEntryPlans: inactive, activeEntryIds: [] });
    expect(auditTotal(ws)).toBe(3);
    const res = importHistoryToRoster(ws, FOUR_NEW, { team: TEAM, gender: Gender.MEN });
    expect(res.summary.lineupEntriesAdded).toBe(4);
    expect(auditTotal({ ...ws, ...res.patch })).toBe(7);
  });

  it('an active plan still spends an entry (control)', () => {
    const active = ['200 Backstroke', '200 Butterfly', '200 Breaststroke'].map((event, i) =>
      plan(`active-${i}`, ANN, event, '1:00.00')
    );
    // Listed explicitly: an EMPTY activeEntryIds means 'all active' to the projection, but the
    // import writes its new ids into that list, which would deactivate these (see the report).
    const ws = workspace([...ANN_FREE_SWIMS, ...FIELD], { meetEntryPlans: active, activeEntryIds: active.map(p => p.id) });
    expect(auditTotal(ws)).toBe(6);
    const res = importHistoryToRoster(ws, FOUR_NEW, { team: TEAM, gender: Gender.MEN });
    expect(res.summary.lineupEntriesAdded).toBe(1);
    expect(auditTotal({ ...ws, ...res.patch })).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 2. The relay-swap candidate check counts the projected pool
// ---------------------------------------------------------------------------

const ELIG_SETTINGS = {
  scoringPoints: [9, 7, 6, 5, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 18,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'meet',
  scorerEligibilityMode: 'roster',
  scorerAutoRules: {
    abFinalTiers: ['A', 'B'],
    includeRelayLegsInFinals: false,
    distanceFinalRequired: true,
    distanceEventPattern: ['1000', '1650', '1500'],
  },
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 999,
  maxRelayEntriesPerSwimmer: 999,
};
const FIVE = 'Alpha Five';

function swapWorkspace(totalCap: number, extra: Partial<Workspace> = {}): Workspace {
  const ind = (id: string, name: string, team: string, event: string, time: string, rank: number) =>
    individual(id, name, event, time, { team, rank });
  const menResults = [
    ind('a1', 'Alpha One', TEAM, '50 Freestyle', '20.00', 2),
    ind('a2', 'Alpha Two', TEAM, '50 Freestyle', '20.50', 3),
    ind('a3', 'Alpha Three', TEAM, '50 Freestyle', '21.00', 4),
    ind('a5', FIVE, TEAM, '50 Freestyle', '20.20', 5),
    ind('b1', 'Beta One', RIVAL, '50 Freestyle', '19.90', 1),
    ...relayRows('rel', '200 Yard Freestyle Relay', '1:22.00', ['Alpha One', 'Alpha Two', 'Alpha Three', 'Alpha Four']),
  ];
  return {
    id: 'ws-swap',
    name: 'swap probe',
    createdAt: 0,
    menResults,
    womenResults: [],
    recruits: [],
    scoringSettings: { ...ELIG_SETTINGS, maxTotalEntriesPerSwimmer: totalCap },
    conference: undefined,
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [
      { name: FIVE, team: TEAM, gender: Gender.MEN, event: '50 Freestyle', time: '20.20', timeType: 'SCY', source: 'paste' },
    ],
    historySources: [],
    scorerRosterOverrides: [{ name: 'Alpha Four', team: TEAM, gender: Gender.MEN, isScorer: false }],
    relayLegOverrides: [],
    deletedSwimmers: [],
    ...extra,
  } as unknown as Workspace;
}

describe('fix 2: the relay-swap candidate check counts plans, recruit rows and overrides', () => {
  const fiveIsOffered = (ws: Workspace) =>
    rankRelayLegSwaps(ws, { team: TEAM, gender: Gender.MEN, settings: ws.scoringSettings as never }).swaps.some(
      s => s.inAthlete === FIVE
    );
  const twoPlans = () => [plan('p-100', FIVE, '100 Freestyle', '45.00'), plan('p-200', FIVE, '200 Freestyle', '1:40.00')];

  it('offers a swimmer with room (control): 3 of 4', () => {
    const ws = swapWorkspace(4, { meetEntryPlans: twoPlans() });
    expect(auditTotal(ws, FIVE)).toBe(3);
    expect(fiveIsOffered(ws)).toBe(true);
  });

  it('does not offer a swimmer whose meet row and two active plans fill the cap: 3 of 3', () => {
    const ws = swapWorkspace(3, { meetEntryPlans: twoPlans() });
    expect(auditTotal(ws, FIVE)).toBe(3);
    expect(fiveIsOffered(ws)).toBe(false);
  });

  it('does not offer a swimmer whose recruit rows fill the cap', () => {
    const recruits = [
      { id: 'rc1', name: FIVE, team: TEAM, event: '100 Freestyle', time: '45.00', gender: Gender.MEN, classYear: 'JR', timeType: 'SCY' },
      { id: 'rc2', name: FIVE, team: TEAM, event: '200 Freestyle', time: '1:40.00', gender: Gender.MEN, classYear: 'JR', timeType: 'SCY' },
    ];
    const ws = swapWorkspace(3, { recruits: recruits as never });
    expect(auditTotal(ws, FIVE)).toBe(3);
    expect(fiveIsOffered(ws)).toBe(false);
  });

  it('still offers a swimmer whose plans are inactive (they are not entries)', () => {
    const inactive = twoPlans().map(p => ({ ...p, active: false }));
    const ws = swapWorkspace(3, { meetEntryPlans: inactive });
    expect(auditTotal(ws, FIVE)).toBe(1);
    expect(fiveIsOffered(ws)).toBe(true);
  });

  it('still offers a swimmer at the cap a leg on a relay event she already swims', () => {
    // 50 Free (meet) + 100 and 200 Free (plans) + the 200 Free Relay on squad B: 4 of 4.
    // A leg on squad A of the same relay adds no entry.
    const squadB = relayRows('relB', '200 Yard Freestyle Relay', '1:30.00', [FIVE, 'Alpha Six', 'Alpha Seven', 'Alpha Eight']).map(
      r => ({ ...r, rank: 2 })
    );
    const base = swapWorkspace(4, { meetEntryPlans: twoPlans() });
    const ws = { ...base, menResults: [...(base.menResults ?? []), ...squadB] } as Workspace;
    expect(auditTotal(ws, FIVE)).toBe(4);
    expect(fiveIsOffered(ws)).toBe(true);
  });

  it('does not offer a deleted swimmer as a relay-leg candidate, resolving deleted aliases', () => {
    expect(fiveIsOffered(swapWorkspace(4))).toBe(true);
    const ws = swapWorkspace(4, {
      deletedSwimmers: [{ name: 'Five, Alpha', gender: Gender.MEN }],
      athleteAliases: [{
        id: 'five-alias', gender: Gender.MEN, team: TEAM, canonicalName: FIVE,
        aliasName: 'Five, Alpha', source: 'manual',
      }],
    });
    expect(rankRelayLegSwaps(ws, { team: TEAM, gender: Gender.MEN, settings: ws.scoringSettings as never }).candidatesEvaluated).toBe(0);
    expect(fiveIsOffered(ws)).toBe(false);
  });

  it('offers a swimmer whose deleted alias does not exclude the canonical projected row', () => {
    const ws = swapWorkspace(4, {
      deletedSwimmers: [{ name: 'A. Five', gender: Gender.MEN }],
      athleteAliases: [{
        id: 'five-alias-repro', gender: Gender.MEN, team: TEAM, canonicalName: FIVE,
        aliasName: 'A. Five', source: 'manual',
      }],
    });
    expect(buildWhatIfResults({ workspace: ws, gender: Gender.MEN, removeSeniors: false }).some(r => r.name === FIVE)).toBe(true);
    expect(fiveIsOffered(ws)).toBe(true);
  });
});

describe('published meet rows always block history import by event identity', () => {
  const published = (event: string, flags: Partial<SwimmerResult> = {}) =>
    individual('published-1', ANN, event, '55.00', flags);
  const history = (event: string) => swim(event, '54.00');

  it.each([
    ['exhibition', { isExhibition: true }],
    ['DFS prelim', { roundSwam: 'Prelim', prelimsPlace: 'DFS' }],
    ['DQ prelim', { roundSwam: 'Prelim', prelimsPlace: 'DQ' }],
  ])('blocks a published %s even when its label differs', (_kind, flags) => {
    const row = published('Event 9 Men 100 Yard Backstroke', flags);
    for (const entryPlanMode of ['overlay', 'plan_sheet'] as const) {
      for (const entryCapCountsExhibition of [undefined, false]) {
        const ws = workspace([row], {
          entryPlanMode,
          scoringSettings: { ...NSISC_PRESET_SETTINGS, entryCapCountsExhibition },
        });
        const result = importHistoryToRoster(ws, [history('100 Backstroke')], { team: TEAM, gender: Gender.MEN });
        expect(result.summary.lineupEntriesAdded).toBe(entryPlanMode === 'overlay' ? 0 : 1);
      }
    }
  });

  it('does not block a program event for a time-trial meet row', () => {
    const row = published('Event 9 Men 100 Yard Backstroke', { isTimeTrial: true });
    const result = importHistoryToRoster(workspace([row]), [history('100 Backstroke')], { team: TEAM, gender: Gender.MEN });
    expect(result.summary.lineupEntriesAdded).toBe(1);
    expect(result.patch.meetEntryPlans?.some(p => p.event === '100 Backstroke')).toBe(true);
  });

  it('blocks a pencil-edited meet row at its current event identity', () => {
    const row = published('Event 9 Men 100 Yard Backstroke');
    const pencil = plan('p-edit', ANN, 'Event 9 Men 100 Yard Butterfly', '53.00', { replacesResultId: row.id });
    const ws = workspace([row], { meetEntryPlans: [pencil], activeEntryIds: ['p-edit'] });
    const result = importHistoryToRoster(ws, [history('100 Butterfly')], { team: TEAM, gender: Gender.MEN });
    expect(result.summary.lineupEntriesAdded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. A pencil edit and a plan for the same athlete and event are one entry
// ---------------------------------------------------------------------------

describe('fix 3: a pencil-edited meet row absorbs a plan-built row for the same event', () => {
  const MEET_LABEL = 'Event 4 Men 50 Yard Freestyle';
  const rowsFor = (ws: Workspace, name = ANN, label = MEET_LABEL) =>
    buildWhatIfResults({ workspace: ws, gender: Gender.MEN, removeSeniors: false }).filter(
      r => r.name === name && r.event === label && !r.isRelay
    );
  const pencil = (id: string, target: string, time: string) =>
    plan(id, ANN, MEET_LABEL, time, { replacesResultId: target, source: 'manual' });
  const field = [individual('b1', 'Bo Bee', MEET_LABEL, '21.00', { rank: 2 })];

  it('the pencil edit alone is one row at the edited time (control)', () => {
    const ws = workspace([individual('m1', ANN, MEET_LABEL, '20.50'), ...field], {
      meetEntryPlans: [pencil('p-edit', 'm1', '20.30')],
    });
    const rows = rowsFor(ws);
    expect(rows.map(r => [r.id, r.time])).toEqual([['m1', '20.30']]);
  });

  it('collapses a plan-built row onto the pencil-edited meet row: the edit stands', () => {
    const ws = workspace([individual('m1', ANN, MEET_LABEL, '20.50'), ...field], {
      meetEntryPlans: [pencil('p-edit', 'm1', '20.30'), plan('p-add', ANN, '50 Freestyle', '20.10')],
    });
    const rows = rowsFor(ws);
    expect(rows.map(r => [r.id, r.time])).toEqual([['m1', '20.30']]);
    expect(auditTotal(ws)).toBe(1);
  });

  it('the dropped plan row is reported in `collapsed`', () => {
    const ws = workspace([individual('m1', ANN, MEET_LABEL, '20.50'), ...field], {
      meetEntryPlans: [pencil('p-edit', 'm1', '20.30'), plan('p-add', ANN, '50 Freestyle', '20.10')],
    });
    const projected = buildWhatIfProjection({ workspace: ws, gender: Gender.MEN, removeSeniors: false });
    expect(projected.collapsed.map((r: SwimmerResult) => r.id)).toContain('p-add');
  });

  it('still lets a plan supersede an UNEDITED meet row (unchanged)', () => {
    const ws = workspace([individual('m1', ANN, MEET_LABEL, '20.50'), ...field], {
      meetEntryPlans: [plan('p-add', ANN, '50 Freestyle', '20.10')],
    });
    expect(rowsFor(ws).map(r => [r.id, r.time])).toEqual([['p-add', '20.10']]);
  });

  it('keeps two pencil edits to a prelims row and a finals row of one event (two swims)', () => {
    const ws = workspace(
      [
        individual('m1', ANN, MEET_LABEL, '20.50', { roundSwam: 'Preliminaries' }),
        individual('m2', ANN, MEET_LABEL, '20.40', { roundSwam: 'A Final' }),
        ...field,
      ],
      { meetEntryPlans: [pencil('e1', 'm1', '20.30'), pencil('e2', 'm2', '20.20')] }
    );
    expect(rowsFor(ws).map(r => r.id).sort()).toEqual(['m1', 'm2']);
  });

  it('does not touch a plan for a different event, or a different athlete', () => {
    const ws = workspace([individual('m1', ANN, MEET_LABEL, '20.50'), individual('m9', 'Cy Cee', MEET_LABEL, '22.00'), ...field], {
      meetEntryPlans: [
        pencil('p-edit', 'm1', '20.30'),
        plan('p-other-event', ANN, '100 Freestyle', '45.00'),
        plan('p-other-swimmer', 'Cy Cee', '100 Freestyle', '46.00'),
      ],
    });
    const pool = buildWhatIfResults({ workspace: ws, gender: Gender.MEN, removeSeniors: false });
    expect(pool.map(r => r.id).sort()).toEqual(['b1', 'm1', 'm9', 'p-other-event', 'p-other-swimmer']);
  });
});
