/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * An athlete linked across two spellings must hold ONE entry per event in the
 * projection, and must score once.
 *
 * FIXED 2026-10-01 (found the same day by the bug-hunter pass). These cases pin
 * the corrected behaviour; the description below records the defect they guard.
 *
 * What goes wrong. `buildWhatIfProjection` (whatIfProjection.ts) drops a
 * lower-plane row when a higher plane holds the same entry, keyed by
 * `entryIdentityKey`, which folds the name with `canonicalSwimmerName` only. An
 * alias link is not consulted. A recruit row stored as "Olivér Pózvai" and a
 * meet row stored as "Oliver Pozvai" therefore both survive. `buildScoringBundle`
 * (scoringEngine.ts) then renames both rows to the canonical spelling and
 * scores them: one swimmer, two placed rows, two sets of points in one event,
 * and every slower swimmer pushed down a place.
 *
 * Measured on the local real workspace (`data/meets.json`, Blank Workspace 1,
 * men, not committed): five alias-linked HSU swimmers each scored twice in one
 * or two events, 57 extra points. Projected totals were HSU 1150, OBU 913,
 * DSU 742; with the stored names resolved before the projection they are
 * 1107, 923, 754.
 *
 * The fixture below is synthetic (invented teams, names and times) and has the
 * same shape: meet row under the canonical spelling, recruit row under the
 * alias spelling, an active link between them.
 */
import { describe, expect, it } from 'vitest';
import { ClassYear, Gender, type Recruit, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { buildScoringBundle } from '../packages/core/src/lib/scoringEngine';

const ALPHA = 'Alpha University';
const BRAVO = 'Bravo University';
const EVENT = 'Event 8 Men 50 Yard Freestyle';
const CANONICAL = 'Oliver Pozvai';
const ALIAS = 'Olivér Pózvai';

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
  meetRow('m2', CANONICAL, ALPHA, 2, '20.28'),
  meetRow('m3', 'Bravo Three', BRAVO, 3, '20.40'),
  meetRow('m4', 'Bravo Four', BRAVO, 4, '20.60'),
];

function recruit(name: string): Recruit {
  return {
    id: 'rc1',
    name,
    team: ALPHA,
    event: '50 Freestyle',
    time: '20.22',
    gender: Gender.MEN,
    classYear: ClassYear.JR,
    timeType: 'SCY',
  };
}

function workspace(recruitName: string): Workspace {
  return {
    id: 'ws-alias-split',
    name: 'alias split probe',
    createdAt: 0,
    menResults: MEET,
    womenResults: [],
    sourceMenResults: MEET,
    sourceWomenResults: [],
    recruits: [recruit(recruitName)],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    meetEntryPlans: [],
    activeEntryIds: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    athleteHistory: [],
    athleteAliases: [
      {
        id: 'link-1',
        gender: Gender.MEN,
        team: ALPHA,
        canonicalName: CANONICAL,
        aliasName: ALIAS,
        source: 'manual',
        status: 'active',
      },
    ],
  } as unknown as Workspace;
}

function project(ws: Workspace) {
  return buildScoringBundle({
    workspace: ws,
    gender: Gender.MEN,
    removeSeniors: false,
    applyWhatIf: true,
    scorerRosterOverrides: ws.scorerRosterOverrides,
  });
}

function rowsFor(scored: SwimmerResult[], name: string): SwimmerResult[] {
  return scored.filter(r => r.name === name && r.event === EVENT);
}

function teamTotals(ws: Workspace): Record<string, number> {
  return Object.fromEntries(project(ws).sortedTeams.map(t => [t.teamName, t.totalPoints]));
}

describe('an alias-linked athlete holds one entry per event in the projection', () => {
  it('a recruit row stored under the canonical spelling supersedes the meet row (control)', () => {
    const rows = rowsFor(project(workspace(CANONICAL)).allScored, CANONICAL);
    expect(rows).toHaveLength(1);
    // The recruit plane outranks the meet plane, so the recruit's time stands.
    expect(rows[0].time).toBe('20.22');
    expect(rows[0].points).toBeGreaterThan(0);
  });

  it('a recruit row stored under the alias spelling also collapses onto the meet row', () => {
    const rows = rowsFor(project(workspace(ALIAS)).allScored, CANONICAL);
    expect(rows.map(r => `${r.time} ${r.points}`)).toHaveLength(1);
  });

  it('renaming the recruit to the spelling it is linked to changes no team total', () => {
    expect(teamTotals(workspace(ALIAS))).toEqual(teamTotals(workspace(CANONICAL)));
  });
});

/**
 * Two rows on ONE plane for one linked athlete.
 *
 * FIXED 2026-10-01. `collapseCrossPlaneDuplicates` used to drop only a LOWER-plane
 * row, so two recruit rows (or two plan rows) for one athlete in one event both
 * survived — the athlete scored twice and pushed every slower swimmer down a
 * place. Now a recruit or plan plane keeps ONE row per athlete and event: the
 * faster time. The meet plane is never collapsed against itself: a prelims row and
 * a finals row for one athlete and event legitimately share a name there.
 */
const ATHLETE = 'Cam Mask';
const ATHLETE_ALIAS = 'Camden Mask';

function sameplaneRecruit(id: string, name: string, time: string): Recruit {
  return {
    id,
    name,
    team: ALPHA,
    event: '50 Freestyle',
    time,
    gender: Gender.MEN,
    classYear: ClassYear.JR,
    timeType: 'SCY',
  };
}

function planEntry(id: string, name: string, time: string) {
  return {
    id,
    name,
    team: ALPHA,
    gender: Gender.MEN,
    classYear: ClassYear.JR,
    event: EVENT,
    time,
    timeType: 'SCY' as const,
    source: 'manual' as const,
  };
}

function sameplaneWorkspace(opts: {
  meet: SwimmerResult[];
  recruits?: Recruit[];
  plans?: ReturnType<typeof planEntry>[];
}): Workspace {
  return {
    ...workspace(CANONICAL),
    id: 'ws-same-plane',
    menResults: opts.meet,
    sourceMenResults: opts.meet,
    recruits: opts.recruits ?? [],
    meetEntryPlans: opts.plans ?? [],
    activeEntryIds: (opts.plans ?? []).map(p => p.id),
    athleteAliases: [
      {
        id: 'link-2',
        gender: Gender.MEN,
        team: ALPHA,
        canonicalName: ATHLETE,
        aliasName: ATHLETE_ALIAS,
        source: 'manual',
        status: 'active',
      },
    ],
  } as unknown as Workspace;
}

const FIELD: SwimmerResult[] = [
  meetRow('f1', 'Bravo One', BRAVO, 1, '20.00'),
  meetRow('f2', 'Bravo Two', BRAVO, 2, '20.40'),
  meetRow('f3', 'Bravo Three', BRAVO, 3, '20.60'),
];

describe('two rows on one plane for one linked athlete hold one entry', () => {
  it('two recruit rows under both spellings score once, on the faster time', () => {
    const ws = sameplaneWorkspace({
      meet: FIELD,
      recruits: [sameplaneRecruit('rs1', ATHLETE, '20.10'), sameplaneRecruit('rs2', ATHLETE_ALIAS, '20.30')],
    });
    const scored = project(ws).allScored.filter(r => r.team === ALPHA && r.event === EVENT);
    expect(scored.map(r => `${r.name} ${r.time}`)).toEqual([`${ATHLETE} 20.10`]);
    // Control: the single-row projection of the faster time gives the same total.
    const single = sameplaneWorkspace({ meet: FIELD, recruits: [sameplaneRecruit('rs1', ATHLETE, '20.10')] });
    expect(teamTotals(ws)).toEqual(teamTotals(single));
  });

  it('keeps the faster time whichever row comes first', () => {
    const ws = sameplaneWorkspace({
      meet: FIELD,
      recruits: [sameplaneRecruit('rs1', ATHLETE_ALIAS, '20.30'), sameplaneRecruit('rs2', ATHLETE, '20.10')],
    });
    const scored = project(ws).allScored.filter(r => r.team === ALPHA && r.event === EVENT);
    expect(scored.map(r => r.time)).toEqual(['20.10']);
  });

  it('two plan entries under both spellings score once, on the faster time', () => {
    const ws = sameplaneWorkspace({
      meet: FIELD,
      plans: [planEntry('p1', ATHLETE_ALIAS, '20.30'), planEntry('p2', ATHLETE, '20.10')],
    });
    const scored = project(ws).allScored.filter(r => r.team === ALPHA && r.event === EVENT);
    expect(scored.map(r => r.time)).toEqual(['20.10']);
  });

  it('does not merge two different athletes on one plane', () => {
    const ws = sameplaneWorkspace({
      meet: FIELD,
      recruits: [sameplaneRecruit('rs1', ATHLETE, '20.10'), sameplaneRecruit('rs2', 'Dex Other', '20.30')],
    });
    const scored = project(ws).allScored.filter(r => r.team === ALPHA && r.event === EVENT);
    expect(scored.map(r => r.name).sort()).toEqual([ATHLETE, 'Dex Other'].sort());
  });

  it('control: a prelims row and a finals row for one meet athlete are both kept', () => {
    const prelim = { ...meetRow('mp', ATHLETE, ALPHA, 4, '20.50'), roundSwam: 'Preliminaries' } as SwimmerResult;
    const final = meetRow('mf', ATHLETE, ALPHA, 4, '20.45');
    // A recruit for a DIFFERENT athlete keeps the recruit plane non-empty, so the
    // collapse actually runs.
    const ws = sameplaneWorkspace({
      meet: [...FIELD, prelim, final],
      recruits: [sameplaneRecruit('rs1', 'Dex Other', '20.70')],
    });
    const rows = project(ws).allScored.filter(r => r.name === ATHLETE && r.event === EVENT);
    expect(rows.map(r => r.id).sort()).toEqual(['mf', 'mp']);
  });

  it('control: two pencil edits, one to a prelims row and one to a finals row, both stand', () => {
    const prelim = { ...meetRow('mp', ATHLETE, ALPHA, 4, '20.50'), roundSwam: 'Preliminaries' } as SwimmerResult;
    const final = meetRow('mf', ATHLETE, ALPHA, 4, '20.45');
    const ws = sameplaneWorkspace({
      meet: [...FIELD, prelim, final],
      plans: [
        { ...planEntry('p1', ATHLETE, '20.52'), replacesResultId: 'mp' },
        { ...planEntry('p2', ATHLETE, '20.47'), replacesResultId: 'mf' },
      ],
    });
    const rows = project(ws).allScored.filter(r => r.name === ATHLETE && r.event === EVENT);
    expect(rows.map(r => r.time).sort()).toEqual(['20.47', '20.52']);
  });
});
