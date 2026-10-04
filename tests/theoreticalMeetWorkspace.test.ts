/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase U1b: `buildTheoreticalMeetWorkspace`
 * (packages/manager/src/lib/theoreticalMeetWorkspace.ts).
 *
 * The seeds are built by the real `buildTheoreticalMeetSeeds` from hand-made
 * swims (the times are constructed on purpose, so a tie and a bracket edge can
 * be placed exactly). Scoring is the real engine: `buildScoringSnapshot`, the
 * pure function behind `useWorkspaceScoring`. The same chain over real captured
 * data is `tests/theoreticalMeetGolden.test.ts`.
 *
 * Expected points are written from the published NCAA table (20, 17, 16, 15,
 * 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1), not read back from the engine.
 */
import { describe, expect, it } from 'vitest';

import { Gender } from '../packages/core/src/types';
import type { HistoricalSwim, ScoringSettings, SwimmerResult, Workspace } from '../packages/core/src/types';
import { GENERIC_TOP16_SETTINGS, mergeScoringSettings, resultsHavePdfPlacePoints } from '../packages/core/src/lib/scoringDefaults';
import { buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine';
import { prepareRecruitsForScoring } from '../packages/core/src/lib/utils';
import type { SwimCloudAthlete } from '../packages/swimcloud/src/entities';
import {
  buildTheoreticalMeetSeeds,
  type TheoreticalMeetSeeds,
  type TheoreticalMeetTeamInput,
} from '../packages/manager/src/lib/theoreticalMeetSeeds';
import {
  EVENT_ORDER_CAVEAT,
  THEORETICAL_MEET_LABEL,
  THEORETICAL_PLACES_CAVEAT,
  TheoreticalWorkspaceError,
  buildTheoreticalMeetWorkspace,
  defaultTheoreticalMeetName,
  isTheoreticalMeet,
  sanitizeWorkspaceName,
  theoreticalResultRowId,
  type TheoreticalMeetWorkspaceInput,
} from '../packages/manager/src/lib/theoreticalMeetWorkspace';

const NCAA_TABLE = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];

/* -------------------------------------------------------------------------- */
/* Constructed seeds                                                           */
/* -------------------------------------------------------------------------- */

type Entrant = { id: string; name: string; time: string; event?: string };

function teamOf(teamName: string, gender: Gender, entrants: Entrant[]): TheoreticalMeetTeamInput {
  return {
    teamName,
    gender,
    rosterStatus: 'parsed',
    rosterSeasonId: '30',
    athletes: entrants.map(e => {
      const athlete: SwimCloudAthlete = { swimCloudSwimmerId: e.id, name: e.name };
      const swim: HistoricalSwim = {
        name: e.name,
        team: teamName,
        gender,
        event: e.event ?? '50 Free SCY',
        time: e.time,
        timeType: 'SCY',
        source: 'swimcloud',
        seasonId: '30',
      };
      return { athlete, swims: [swim], captureId: `capture-${teamName}`, retrievedAt: '2026-10-04T12:00:00.000Z' };
    }),
  };
}

const WS = 'ws-test-1';
const CREATED = 1_760_000_000_000;

type Build = ReturnType<typeof buildTheoreticalMeetWorkspace>;

function seedsFor(teams: TheoreticalMeetTeamInput[], settings: ScoringSettings = GENERIC_TOP16_SETTINGS, conference?: string, meetId = WS): TheoreticalMeetSeeds {
  return buildTheoreticalMeetSeeds({ meetId, course: 'SCY', scoringSettings: settings, ...(conference === undefined ? {} : { conference }), teams });
}

type BuildOptions = { settings?: ScoringSettings; conference?: string; name?: string; seeds?: TheoreticalMeetSeeds };

function build(teams: TheoreticalMeetTeamInput[], over: BuildOptions = {}): Build {
  const settings = over.settings ?? GENERIC_TOP16_SETTINGS;
  const seeds = over.seeds ?? seedsFor(teams, settings, over.conference);
  return buildTheoreticalMeetWorkspace({
    workspaceId: WS,
    createdAt: CREATED,
    seeds,
    scoringSettings: settings,
    ...(over.conference === undefined ? {} : { conference: over.conference }),
    ...(over.name === undefined ? {} : { name: over.name }),
  });
}

/** Run a seed-shaped thing through the builder and return the error code, or `no-error`. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof TheoreticalWorkspaceError) return error.code;
    throw error;
  }
  return 'no-error';
}

const menField = (n: number, team = 'Alpha U', start = 1): Entrant[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${team}-${start + i}`, name: `${team} Swimmer ${start + i}`, time: (20 + (start + i) * 0.1).toFixed(2) }));

const snapshot = (b: Build, gender: Gender) => buildScoringSnapshot(b.payload as unknown as Workspace, gender, false);

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

describe('buildTheoreticalMeetWorkspace: places', () => {
  it('ranks by seed time, fastest first, and shares a place only on an exact tie (1, 2, 2, 4)', () => {
    const b = build([
      teamOf('Alpha U', Gender.MEN, [
        { id: 'a1', name: 'Al One', time: '20.00' },
        { id: 'a2', name: 'Al Two', time: '21.00' },
        { id: 'a3', name: 'Al Four', time: '22.00' },
      ]),
      teamOf('Beta U', Gender.MEN, [{ id: 'b1', name: 'Bo Two', time: '21.00' }]),
    ]);
    const rows = b.payload.menResults.map(r => [r.name, r.rank, r.points]);
    expect(rows).toEqual([
      ['Al One', 1, 20],
      ['Al Two', 2, 16.5],
      ['Bo Two', 2, 16.5],
      ['Al Four', 4, 15],
    ]);
  });

  it('puts the places where the app puts injected recruits (the same tie rule as prepareRecruitsForScoring)', () => {
    const times = ['20.00', '21.00', '21.00', '21.00', '22.50', '22.50', '25.00'];
    const entrants = times.map((time, i) => ({ id: `x${i}`, name: `Racer ${i}`, time }));
    const b = build([teamOf('Alpha U', Gender.MEN, entrants)]);
    const recruits: SwimmerResult[] = entrants.map(e => ({
      id: e.id,
      rank: 0,
      name: e.name,
      classYear: 'FR',
      team: 'Alpha U',
      time: e.time,
      points: 0,
      event: '50 Free SCY',
      gender: Gender.MEN,
      isRecruit: true,
    }));
    const placed = prepareRecruitsForScoring([], recruits);
    const appRankByName = new Map(placed.map(r => [r.name, r.rank]));
    for (const row of b.payload.menResults) expect(row.rank, row.name).toBe(appRankByName.get(row.name));
    expect(b.payload.menResults.map(r => r.rank)).toEqual([1, 2, 2, 2, 5, 5, 7]);
  });

  it('ranks each event and each gender on its own', () => {
    const b = build([
      teamOf('Alpha U', Gender.MEN, [
        { id: 'm1', name: 'Man One', time: '20.00', event: '50 Free SCY' },
        { id: 'm2', name: 'Man Two', time: '45.00', event: '100 Free SCY' },
      ]),
      teamOf('Alpha U', Gender.WOMEN, [{ id: 'w1', name: 'Woman One', time: '26.00', event: '50 Free SCY' }]),
    ]);
    expect(b.payload.menResults.map(r => [r.event, r.rank])).toEqual([
      ['50 Free SCY', 1],
      ['100 Free SCY', 1],
    ]);
    expect(b.payload.womenResults.map(r => [r.event, r.rank])).toEqual([['50 Free SCY', 1]]);
  });

  it('bands the rows the way the what-if projection does: A bracket, B bracket, then Preliminaries that score nothing', () => {
    const b = build([teamOf('Alpha U', Gender.MEN, menField(18))]);
    expect(b.aFinalBracketSize).toBe(8);
    const rows = b.payload.menResults;
    expect(rows.map(r => r.rank)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(rows.map(r => r.roundSwam)).toEqual([...Array(8).fill('A Final'), ...Array(8).fill('B Final'), 'Preliminaries', 'Preliminaries']);
    expect(rows.map(r => r.points)).toEqual([...NCAA_TABLE, 0, 0]);
  });

  it('a tie that crosses no band edge stays in one band; a tie at place 8 stays in the A bracket', () => {
    const entrants: Entrant[] = [
      ...menField(7),
      { id: 't1', name: 'Tie One', time: '30.00' },
      { id: 't2', name: 'Tie Two', time: '30.00' },
      { id: 't3', name: 'Slower', time: '31.00' },
    ];
    const b = build([teamOf('Alpha U', Gender.MEN, entrants)]);
    const tied = b.payload.menResults.filter(r => r.name.startsWith('Tie'));
    expect(tied.map(r => [r.rank, r.roundSwam])).toEqual([
      [8, 'A Final'],
      [8, 'A Final'],
    ]);
    // Places 8 and 9 share (11 + 9) / 2 = 10 each.
    expect(tied.map(r => r.points)).toEqual([10, 10]);
    expect(b.payload.menResults.find(r => r.name === 'Slower')).toMatchObject({ rank: 10, roundSwam: 'B Final', points: 7 });
  });

  it('orders rows by the standard program order, event by event, not by team or roster', () => {
    const b = build([
      teamOf('Alpha U', Gender.MEN, [
        { id: 'o1', name: 'One', time: '1:45.00', event: '200 Free SCY' },
        { id: 'o2', name: 'Two', time: '50.00', event: '100 Back SCY' },
        { id: 'o3', name: 'Three', time: '20.00', event: '50 Free SCY' },
      ]),
    ]);
    expect(b.payload.menResults.map(r => r.event)).toEqual(['50 Free SCY', '200 Free SCY', '100 Back SCY']);
  });
});

/* -------------------------------------------------------------------------- */
/* What the engine needs                                                       */
/* -------------------------------------------------------------------------- */

describe('buildTheoreticalMeetWorkspace: rows the scoring engine accepts as a meet', () => {
  const teams = () => [
    teamOf('Alpha U', Gender.MEN, menField(5, 'Alpha U')),
    teamOf('Beta U', Gender.MEN, menField(5, 'Beta U', 3)),
    teamOf('Alpha U', Gender.WOMEN, [{ id: 'w1', name: 'Woman One', time: '26.00' }]),
  ];

  it('rows are plain scored swims: no psych flag, no psych round, no pdfPoints, no recruit or exhibition flag', () => {
    const b = build(teams());
    for (const row of [...b.payload.menResults, ...b.payload.womenResults]) {
      expect(row.isPsychSheet).toBeUndefined();
      expect(row.roundSwam).not.toBe('Psych Sheet');
      expect(row.pdfPoints).toBeUndefined();
      expect(row.isRecruit).toBeUndefined();
      expect(row.isExhibition).toBeUndefined();
      expect(row.isTimeTrial).toBeUndefined();
      expect(row.isRelay).toBe(false);
      expect(Number.isInteger(row.rank) && row.rank > 0).toBe(true);
    }
    expect(resultsHavePdfPlacePoints([...b.payload.menResults, ...b.payload.womenResults])).toBe(false);
  });

  it('the stored points are the engine\'s own baseline points, row by row', () => {
    const b = build(teams());
    for (const gender of [Gender.MEN, Gender.WOMEN]) {
      const scored = new Map(snapshot(b, gender).baseline.allScored.map(r => [r.id, r.points]));
      const rows = gender === Gender.MEN ? b.payload.menResults : b.payload.womenResults;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.points, row.id).toBe(scored.get(row.id));
    }
  });

  it('baseline and projected scoring agree, and both see every team', () => {
    const b = build(teams());
    const snap = snapshot(b, Gender.MEN);
    expect(snap.baseline.sortedTeams.map(t => [t.teamName, t.totalPoints])).toEqual(snap.projected.sortedTeams.map(t => [t.teamName, t.totalPoints]));
    expect(snap.baseline.sortedTeams.map(t => t.teamName).sort()).toEqual(['Alpha U', 'Beta U']);
  });

  it('the event axis shows the events the meet has', () => {
    const b = build(teams());
    expect(snapshot(b, Gender.MEN).baseline.visibleEvents).toEqual(['50 Free SCY']);
  });

  it('the payload holds separate source copies, so a later edit of the working rows leaves the baseline alone', () => {
    const b = build(teams());
    expect(b.payload.sourceMenResults).toEqual(b.payload.menResults);
    expect(b.payload.sourceMenResults).not.toBe(b.payload.menResults);
    expect(b.payload.sourceMenResults[0]).not.toBe(b.payload.menResults[0]);
    expect(b.payload.sourceWomenResults).toEqual(b.payload.womenResults);
  });

  it('the payload is a valid Workspace patch and carries only Workspace fields', () => {
    const b = build(teams());
    const body: Partial<Workspace> = b.payload;
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'id', 'loadedMeet', 'menResults', 'name', 'recruits', 'scoringSettings', 'sourceMenResults', 'sourceWomenResults', 'womenResults']);
  });

  it('the same input gives the same output', () => {
    expect(build(teams())).toEqual(build(teams()));
  });
});

/* -------------------------------------------------------------------------- */
/* Ids and provenance                                                          */
/* -------------------------------------------------------------------------- */

describe('buildTheoreticalMeetWorkspace: ids and provenance', () => {
  const teams = () => [teamOf('Alpha U', Gender.MEN, menField(4)), teamOf('Alpha U', Gender.WOMEN, [{ id: 'w1', name: 'Woman One', time: '26.00' }])];

  it('result ids are the seed ids under tmres, scoped to the workspace, and unique', () => {
    const seeds = seedsFor(teams());
    const b = build(teams(), { seeds });
    const ids = [...b.payload.menResults, ...b.payload.womenResults].map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => id.startsWith(`tmres|${WS}|`))).toBe(true);
    for (const seed of seeds.rows) expect(b.resultIdBySeedId.get(seed.id)).toBe(theoreticalResultRowId(seed.id));
    expect(theoreticalResultRowId('tmseed|ws|Men|Team|sc:1|50%20Free%20SCY')).toBe('tmres|ws|Men|Team|sc:1|50%20Free%20SCY');
    expect(codeOf(() => theoreticalResultRowId('other|x'))).toBe('unexpected-seed-row');
  });

  it('ids differ for another workspace, so two theoretical meets never share a primary key', () => {
    const one = build(teams());
    const two = buildTheoreticalMeetWorkspace({ workspaceId: 'ws-other', createdAt: CREATED, seeds: seedsFor(teams(), GENERIC_TOP16_SETTINGS, undefined, 'ws-other'), scoringSettings: GENERIC_TOP16_SETTINGS });
    const first = new Set(one.payload.menResults.map(r => r.id));
    expect(two.payload.menResults.some(r => first.has(r.id))).toBe(false);
  });

  it('keeps one provenance record per meet row, the seed\'s own, keyed by result id', () => {
    const seeds = seedsFor(teams());
    const b = build(teams(), { seeds });
    const rows = [...b.payload.menResults, ...b.payload.womenResults];
    expect([...b.sources.keys()].sort()).toEqual(rows.map(r => r.id).sort());
    for (const seed of seeds.rows) expect(b.sources.get(theoreticalResultRowId(seed.id))).toBe(seeds.sources.get(seed.id));
    expect(b.sources.get(rows[0].id)).toMatchObject({ course: 'SCY', captureId: 'capture-Alpha U', seasonId: '30' });
  });
});

/* -------------------------------------------------------------------------- */
/* Label, name, conference                                                     */
/* -------------------------------------------------------------------------- */

describe('buildTheoreticalMeetWorkspace: the theoretical label, the name, the conference', () => {
  const teams = () => [teamOf('Alpha U', Gender.MEN, menField(3)), teamOf('Beta U', Gender.WOMEN, [{ id: 'w1', name: 'Woman One', time: '26.00' }])];

  it('marks the meet as theoretical, and isTheoreticalMeet reads it back', () => {
    const b = build(teams());
    expect(b.payload.loadedMeet).toEqual({ pdfFilename: THEORETICAL_MEET_LABEL, uploadedAt: CREATED, meetLabel: THEORETICAL_MEET_LABEL });
    expect(isTheoreticalMeet(b.payload)).toBe(true);
    expect(isTheoreticalMeet({ loadedMeet: { meetLabel: 'NSISC Championships 2026' } })).toBe(false);
    expect(isTheoreticalMeet({ loadedMeet: { meetLabel: `${THEORETICAL_MEET_LABEL} (copy)` } })).toBe(false);
    expect(isTheoreticalMeet({ loadedMeet: {} })).toBe(false);
    expect(isTheoreticalMeet({})).toBe(false);
    expect(isTheoreticalMeet(undefined)).toBe(false);
    expect(isTheoreticalMeet(null)).toBe(false);
  });

  it('names the workspace by its team count and team names, counting a two-gender team once', () => {
    expect(build(teams()).payload.name).toBe('Theoretical meet: 2 teams (Alpha U, Beta U)');
    expect(defaultTheoreticalMeetName(['A', 'A', 'a ', 'B'])).toBe('Theoretical meet: 2 teams (A, B)');
    expect(defaultTheoreticalMeetName(['Solo U'])).toBe('Theoretical meet: 1 team (Solo U)');
    expect(defaultTheoreticalMeetName([])).toBe('Theoretical meet: 0 teams');
  });

  it('sanitizes a name: control characters, angle brackets, runs of spaces, length', () => {
    expect(sanitizeWorkspaceName('  Big\u0000 <b>Meet</b>\n\tName  ')).toBe('Big b Meet /b Name');
    expect(sanitizeWorkspaceName('x'.repeat(300))).toHaveLength(120);
    expect(sanitizeWorkspaceName('x'.repeat(300)).endsWith('...')).toBe(true);
    expect(build(teams(), { name: ' My\u0007  meet ' }).payload.name).toBe('My meet');
    // A name that is empty after cleaning falls back to the default.
    expect(build(teams(), { name: ' \u0000 <> ' }).payload.name).toBe('Theoretical meet: 2 teams (Alpha U, Beta U)');
  });

  it('merges the scoring settings with the conference the way the builder does, and records the conference', () => {
    // Generic settings with one cap set. Only the conference override can make the NSISC rules apply.
    const raw: ScoringSettings = { ...GENERIC_TOP16_SETTINGS, maxIndividualEntriesPerSwimmer: 3 };
    const b = build(teams(), { settings: raw, conference: 'NSISC' });
    expect(b.payload.scoringSettings).toEqual(mergeScoringSettings(raw, { conference: 'NSISC' }));
    expect(b.payload.scoringSettings.maxTotalEntriesPerSwimmer).toBe(7);
    expect(b.payload.scoringSettings.scorerCapScope).toBe('meet');
    expect(b.payload.scoringSettings.scorerEligibilityMode).toBe('roster');
    expect(b.payload.conference).toBe('NSISC');
    expect(b.payload.loadedMeet.conference).toBe('NSISC');
    // Without a conference the generic settings stay generic and no conference is written.
    const plain = build(teams(), { settings: raw });
    expect(plain.payload.scoringSettings).toEqual(mergeScoringSettings(raw, {}));
    expect(plain.payload.scoringSettings.scorerCapScope).not.toBe('meet');
    expect('conference' in plain.payload).toBe(false);
    expect('conference' in plain.payload.loadedMeet).toBe(false);
  });

  it('scores a non-NSISC meet with its own settings, and an NSISC meet with the 18-scorer pool', () => {
    // One team, two events of 16 different swimmers each. Every one places 1 to 16 in their event.
    // Generic settings: all 32 score, 2 x 155 = 310. NSISC: the pool takes 18 swimmers meet-wide.
    // The first event (50 Free) admits 16. The second (100 Free) admits its 2 fastest: 20 + 17.
    const rows: Entrant[] = [
      ...menField(16, 'Alpha U'),
      ...menField(16, 'Alpha U', 101).map(e => ({ ...e, event: '100 Free SCY', time: (45 + Number(e.id.split('-')[1]) * 0.01).toFixed(2) })),
    ];
    const many = [teamOf('Alpha U', Gender.MEN, rows)];
    const full = NCAA_TABLE.reduce((a, b) => a + b, 0);
    expect(snapshot(build(many), Gender.MEN).baseline.sortedTeams[0].totalPoints).toBe(2 * full);
    expect(snapshot(build(many, { conference: 'NSISC' }), Gender.MEN).baseline.sortedTeams[0].totalPoints).toBe(full + 20 + 17);
  });

  it('adds its caveats after the seed caveats, once each', () => {
    const b = build(teams());
    expect(b.caveats.slice(-2)).toEqual([THEORETICAL_PLACES_CAVEAT, EVENT_ORDER_CAVEAT]);
    expect(new Set(b.caveats).size).toBe(b.caveats.length);
    expect(b.caveats).toEqual(expect.arrayContaining(b.report.caveats as string[]));
  });
});

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

describe('buildTheoreticalMeetWorkspace: fails loudly', () => {
  const seeds = () => seedsFor([teamOf('Alpha U', Gender.MEN, menField(3))]);
  const base = (over: Partial<TheoreticalMeetWorkspaceInput> = {}): TheoreticalMeetWorkspaceInput => ({
    workspaceId: WS,
    createdAt: CREATED,
    seeds: seeds(),
    scoringSettings: GENERIC_TOP16_SETTINGS,
    ...over,
  });
  const withRows = (map: (rows: readonly SwimmerResult[]) => SwimmerResult[]): TheoreticalMeetSeeds => {
    const s = seeds();
    return { ...s, rows: map(s.rows) };
  };

  it('rejects an empty workspace id and a createdAt that is not a number', () => {
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ workspaceId: '  ' })))).toBe('invalid-input');
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ createdAt: Number.NaN })))).toBe('invalid-input');
  });

  it('seeds with no row do not make a meet', () => {
    const empty = seedsFor([{ teamName: 'Alpha U', gender: Gender.MEN, rosterStatus: 'no_rosters_found', athletes: [] }]);
    expect(empty.rows).toHaveLength(0);
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ seeds: empty })))).toBe('no-seed-rows');
  });

  it('rows built for another workspace are refused', () => {
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ workspaceId: 'ws-other' })))).toBe('meet-id-mismatch');
  });

  it('a row that is not a plain individual psych seed is refused', () => {
    const relay = withRows(rows => rows.map((r, i) => (i === 0 ? { ...r, isRelay: true } : r)));
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ seeds: relay })))).toBe('unexpected-seed-row');
    const ranked = withRows(rows => rows.map((r, i) => (i === 0 ? { ...r, isPsychSheet: undefined } : r)));
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ seeds: ranked })))).toBe('unexpected-seed-row');
    const exhibition = withRows(rows => rows.map((r, i) => (i === 0 ? { ...r, isExhibition: true } : r)));
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ seeds: exhibition })))).toBe('unexpected-seed-row');
  });

  it('a seed with no provenance record is refused', () => {
    const s = seeds();
    const sources = new Map(s.sources);
    sources.delete(s.rows[0].id);
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ seeds: { ...s, sources } })))).toBe('unexpected-seed-row');
  });

  it('two labels for one event are refused, because scoring would split the field', () => {
    const split = withRows(rows => rows.map((r, i) => (i === 0 ? { ...r, event: '50 Free  SCY' } : r)));
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ seeds: split })))).toBe('event-label-conflict');
  });

  it('a time that is not a number is refused, never ranked last or first', () => {
    const bad = withRows(rows => rows.map((r, i) => (i === 0 ? { ...r, time: 'abc' } : r)));
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ seeds: bad })))).toBe('unrankable-time');
    const nt = withRows(rows => rows.map((r, i) => (i === 0 ? { ...r, time: 'NT' } : r)));
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ seeds: nt })))).toBe('unrankable-time');
  });

  it('a repeated row id is refused', () => {
    const dup = withRows(rows => [...rows, rows[0]]);
    expect(codeOf(() => buildTheoreticalMeetWorkspace(base({ seeds: dup })))).toBe('row-id-collision');
  });
});
