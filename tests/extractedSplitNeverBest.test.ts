/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * An extracted split is never a best (plans/2026-09-22/01, P12 defect 1).
 *
 * SwimCloud marks a time it took out of a longer swim's splits with chip `X` /
 * `title="Extracted"`. The rule (see `HistoricalSwim.isExtractedSplit`): it is
 * never a best, so it is never ranked, cut-tagged, entered or projected. It is
 * kept in `extractedByEvent`, where it may stand in for a relay leg only when
 * the swimmer has no standalone time at that distance.
 *
 * `categorizeBestEvents` obeyed the rule. Five other readers did not:
 *
 *  - `importHistoryToRoster` wrote recruit rows and plans from extracted splits;
 *  - `buildCrossCourseTable` offered one as the swimmer's SCY best;
 *  - `applyScoringTheory` planned theory entries on one;
 *  - `mergeHistoryIndex` let a faster extracted split evict a slower real swim
 *    of the same event and course from the stored history;
 *  - `buildSeasonTrends` drew one as a point on a progression.
 *
 * A pasted SwimCloud row carries the same fact as `swimcloudBadge: 'extracted'`
 * with no `isExtractedSplit` flag. Every workspace in `data/meets.json` holds
 * rows in exactly that shape (75 on the HSU 2026-27 roster plan), so the badge
 * alone must also keep a swim out of every best.
 *
 * Swimmer 2352628 (Bartu Akin, HSU) is the real case: his only 100 Fly SCY is
 * the extracted 54.91, the first half of a 200 Fly, and 100 Fly is a program
 * event.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSwimmerFastestTimesJson } from '@omniswim/swimcloud';
import { swimCloudSwimmerTimesToHistoricalSwims } from '@omniswim/manager/lib/swimCloudImportBridge';
import { Gender, type HistoricalSwim, type Workspace } from '../packages/core/src/types';
import {
  categorizeBestEvents,
  isExtractedSplitSwim,
  isRankableSwim,
  mergeHistoryIndex,
  parseSwimCloudPasteDetailed,
} from '../packages/core/src/lib/athleteHistory';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';
import { buildCrossCourseTable, rankRelayLegSwaps } from '../packages/core/src/lib/crossCourseArbitrage';
import { applyScoringTheory } from '../packages/core/src/lib/scoringTheory';
import { buildSeasonTrends } from '../packages/core/src/lib/seasonAnalytics';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import {
  buildCutlineTagForTeam,
  cutlineTagRenderMode,
  isCutlineTagConclusive,
} from '../packages/core/src/lib/cutlineTags';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State';
const NAME = 'Bartu Akin';

function importFixture(swimmerId: string, file: string): HistoricalSwim[] {
  const raw = readFileSync(join(repoRoot, 'tests', 'fixtures', file), 'utf8');
  const parsed = parseSwimmerFastestTimesJson(raw, {
    sourceUrl: `https://www.swimcloud.com/api/swimmers/${swimmerId}/profile_fastest_times/`,
    retrievedAt: '2026-09-22T12:00:00.000Z',
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error(parsed.failure.message);
  const conversion = swimCloudSwimmerTimesToHistoricalSwims(
    { ...parsed.data, name: NAME },
    { team: HSU, gender: Gender.MEN }
  );
  if (!conversion.ok) throw new Error(conversion.message);
  return [...conversion.swims];
}

const AKIN = ['2352628', 'profile_fastest_times-2352628-user-inputted.json'] as const;

function workspaceWith(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-extracted',
    name: 'Extracted splits',
    createdAt: 0,
    menResults: [],
    womenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    athleteHistory: [],
    ...over,
  } as Workspace;
}

/**
 * Steven Balistreri's block from the HSU roster export `hsuroster26-27.txt`,
 * lines 332-336 and 345, verbatim. His only 1000 Free SCY is an `X` row: the
 * 1000 split of a 1650.
 */
const BALISTRERI_PASTE = [
  'Steven Balistreri',
  'Event\tTime\t\tMeet\tDate\tStamp Link',
  '100 Fly SCY\t49.20\t\tNew South Championships\tFeb 19, 2026\t',
  '100 Free LCM\t54.03\t\tSouthern Senior Zone Championships\tJul 28, 2021\t',
  '1000 Free SCY\t10:07.97\tX\tNew South Championships\tFeb 21, 2026\t',
].join('\n');

/** The shape every stored pasted row has today: the badge, and no flag. */
function asStoredBeforeTheFlag(swim: HistoricalSwim): HistoricalSwim {
  const { isExtractedSplit: _flag, ...rest } = swim;
  void _flag;
  return rest;
}

describe('the one predicate', () => {
  it('reads the flag and the pasted badge alike', () => {
    const base: HistoricalSwim = {
      name: NAME,
      team: HSU,
      gender: Gender.MEN,
      event: '100 Butterfly',
      time: '54.91',
      source: 'paste',
    };
    expect(isRankableSwim(base)).toBe(true);
    expect(isExtractedSplitSwim({ ...base, isExtractedSplit: true })).toBe(true);
    expect(isRankableSwim({ ...base, isExtractedSplit: true })).toBe(false);
    expect(isExtractedSplitSwim({ ...base, swimcloudBadge: 'extracted' })).toBe(true);
    expect(isRankableSwim({ ...base, swimcloudBadge: 'extracted' })).toBe(false);
    expect(isRankableSwim({ ...base, isUserInputted: true })).toBe(false);
    expect(isRankableSwim({ ...base, swimcloudBadge: 'user_input' })).toBe(false);
    // An altitude-adjusted time is still a best.
    expect(isRankableSwim({ ...base, isAltitudeAdjusted: true })).toBe(true);
    expect(isRankableSwim({ ...base, swimcloudBadge: 'd1_b' })).toBe(true);
  });
});

describe('an extracted split is never entered (swimmer 2352628)', () => {
  const swims = importFixture(...AKIN);
  const extracted = swims.filter(s => s.isExtractedSplit === true);

  it('writes no recruit row or plan from an extracted split, but stores it', () => {
    expect(extracted.map(s => [s.event, s.time])).toStrictEqual([
      ['50 Breast LCM', '33.42'],
      ['50 Fly LCM', '28.40'],
      ['100 Fly SCY', '54.91'],
      ['100 Fly LCM', '1:03.02'],
    ]);
    const result = importHistoryToRoster(workspaceWith(), extracted, { team: HSU, gender: Gender.MEN });
    expect(result.patch.recruits).toStrictEqual([]);
    expect(result.patch.meetEntryPlans).toStrictEqual([]);
    expect(result.patch.athleteHistory?.map(s => s.event)).toStrictEqual(extracted.map(s => s.event));
  });

  it('enters a slower real swim rather than a faster extracted one', () => {
    // Constructed: the fixture holds no real 100 Fly for this swimmer. The
    // real row is slower on purpose, so only the rule can pick it.
    const real: HistoricalSwim = {
      name: NAME,
      team: HSU,
      gender: Gender.MEN,
      event: '100 Fly SCY',
      time: '55.40',
      timeType: 'SCY',
      source: 'swimcloud',
    };
    const result = importHistoryToRoster(workspaceWith(), [...extracted, real], {
      team: HSU,
      gender: Gender.MEN,
    });
    expect(result.patch.recruits?.map(r => [r.event, r.time])).toStrictEqual([['100 Fly SCY', '55.40']]);
  });

  it('is kept apart from bests in the profile, as a relay-leg stand-in', () => {
    const profile = categorizeBestEvents(swims, HSU, Gender.MEN, NAME, NSISC_PRESET_SETTINGS);
    expect(profile.bestByEvent['100 Fly SCY']).toBeUndefined();
    expect(profile.extractedByEvent['100 Fly SCY']?.time).toBe('54.91');
  });
});

describe('an extracted split is never a cross-course best', () => {
  it('leaves no 100 Butterfly row when the only 100 Fly swims are extracted', () => {
    const table = buildCrossCourseTable(workspaceWith({ athleteHistory: importFixture(...AKIN) }), {
      team: HSU,
      gender: Gender.MEN,
    });
    expect(table.rows.find(r => r.event === '100 Butterfly')).toBeUndefined();
    // Real swims still project exactly as before.
    expect(table.rows.find(r => r.event === '400 Individual Medley')?.scyBest?.time).toBe('3:58.72');
  });
});

describe('an extracted split is never a theory history best', () => {
  const theory = { relays: [], swimmers: [{ rawName: NAME, events: ['100 Butterfly'] }], others: [], warnings: [] };

  it('refuses a flagged row', () => {
    const history: HistoricalSwim[] = [
      {
        name: NAME,
        team: HSU,
        gender: Gender.MEN,
        event: '100 Butterfly',
        time: '54.91',
        timeType: 'SCY',
        source: 'swimcloud',
        isExtractedSplit: true,
      },
    ];
    const result = applyScoringTheory(workspaceWith({ athleteHistory: history }), theory, {
      team: HSU,
      gender: Gender.MEN,
    });
    expect(result.summary.entriesAdded).toBe(0);
    expect(result.warnings).toContainEqual(expect.stringContaining('No history time'));
  });

  it('refuses a stored pasted row that carries only the badge', () => {
    // The row as data/meets.json stores it today (HSU line 143).
    const history: HistoricalSwim[] = [
      {
        name: NAME,
        team: HSU,
        gender: Gender.MEN,
        event: '100 Butterfly',
        time: '54.91',
        timeType: 'SCY',
        source: 'paste',
        swimcloudBadge: 'extracted',
      },
    ];
    const result = applyScoringTheory(workspaceWith({ athleteHistory: history }), theory, {
      team: HSU,
      gender: Gender.MEN,
    });
    expect(result.summary.entriesAdded).toBe(0);
  });
});

describe('mergeHistoryIndex keeps an extracted split in its own lane', () => {
  it('does not let a faster extracted split evict a slower real swim', () => {
    const extracted = importFixture(...AKIN).find(s => s.event === '100 Fly SCY')!;
    expect(extracted).toMatchObject({ time: '54.91', isExtractedSplit: true });
    const real: HistoricalSwim = {
      name: NAME,
      team: HSU,
      gender: Gender.MEN,
      event: '100 Fly SCY',
      time: '55.40',
      timeType: 'SCY',
      source: 'swimcloud',
    };
    const merged = mergeHistoryIndex([real], [extracted]);
    expect(merged.map(s => [s.time, isExtractedSplitSwim(s)]).sort()).toStrictEqual([
      ['54.91', true],
      ['55.40', false],
    ]);
    // Two real swims still fold to the faster one.
    expect(mergeHistoryIndex([real], [{ ...real, time: '55.00' }]).map(s => s.time)).toStrictEqual(['55.00']);
  });

  it('keeps a stored badge-only row out of the real lane too', () => {
    const real: HistoricalSwim = {
      name: NAME,
      team: HSU,
      gender: Gender.MEN,
      event: '100 Butterfly',
      time: '55.40',
      timeType: 'SCY',
      source: 'paste',
    };
    const stored: HistoricalSwim = { ...real, time: '54.91', swimcloudBadge: 'extracted' };
    expect(mergeHistoryIndex([real], [stored]).map(s => s.time).sort()).toStrictEqual(['54.91', '55.40']);
  });
});

describe('a pasted extracted row is not a best (HSU roster export)', () => {
  const parsed = parseSwimCloudPasteDetailed(BALISTRERI_PASTE, { team: HSU, gender: Gender.MEN }).swims;

  it('parses the three rows', () => {
    expect(parsed.map(s => [s.event, s.time, s.swimcloudBadge])).toStrictEqual([
      ['100 Butterfly', '49.20', 'none'],
      ['100 Freestyle', '54.03', 'none'],
      ['1000 Freestyle', '10:07.97', 'extracted'],
    ]);
  });

  for (const [label, rows] of [
    ['as parsed now', parsed],
    ['as stored before the flag existed', parsed.map(asStoredBeforeTheFlag)],
  ] as const) {
    it(`keeps the 1000 split out of bestByEvent ${label}`, () => {
      const profile = categorizeBestEvents(rows, HSU, Gender.MEN, 'Steven Balistreri', NSISC_PRESET_SETTINGS);
      expect(profile.bestByEvent['1000 Freestyle']).toBeUndefined();
      expect(profile.extractedByEvent['1000 Freestyle']?.time).toBe('10:07.97');
      expect(profile.primaryEvents).not.toContain('1000 Freestyle');
      expect(profile.bestByEvent['100 Butterfly']?.time).toBe('49.20');
    });

    it(`writes no 1000 Free recruit row ${label}`, () => {
      const result = importHistoryToRoster(workspaceWith(), rows, { team: HSU, gender: Gender.MEN });
      expect(result.patch.recruits?.map(r => r.event).sort()).toStrictEqual(['100 Butterfly', '100 Freestyle']);
    });
  }
});

describe('an extracted split is no point on a season progression', () => {
  it('leaves the real swim as the best', () => {
    const history: HistoricalSwim[] = [
      { name: NAME, team: HSU, gender: Gender.MEN, event: '100 Butterfly', time: '54.91', source: 'swimcloud', isExtractedSplit: true },
      { name: NAME, team: HSU, gender: Gender.MEN, event: '100 Butterfly', time: '55.40', source: 'swimcloud' },
    ];
    const trends = buildSeasonTrends([workspaceWith({ athleteHistory: history })]);
    expect(trends.swimmerTrends.find(t => t.event === '100 Butterfly')).toMatchObject({
      bestTime: '55.40',
      meetCount: 1,
    });
  });
});

describe('an extracted split is never cut-tagged', () => {
  it('refuses the tag the time would otherwise earn', () => {
    // Avery Henke's real 100 Breast SCY 54.09 (swimmer 1330318), a D2 B cut.
    // His extracted 50 Breast SCY 25.16 is the first half of this swim.
    // Flagged here only to prove the gate: the same time as an extracted split
    // must not be judged.
    const real = importFixture('1330318', 'profile_fastest_times-1330318.json').find(
      s => s.event === '100 Breast SCY'
    )!;
    expect(real).toMatchObject({ time: '54.09' });
    expect(real.isExtractedSplit).toBeUndefined();
    const base = { team: HSU, gender: Gender.MEN, event: real.event, time: real.time, swimCourse: 'SCY' as const };
    expect(buildCutlineTagForTeam(base)).toMatchObject({ state: 'tagged', tag: { label: 'D2 B CUT' } });

    const refused = buildCutlineTagForTeam({ ...base, extractedSplit: true });
    expect(refused.state).toBe('extracted_split');
    expect(refused.tag).toBeNull();
    expect(refused.nextTier).toBeNull();
    expect(cutlineTagRenderMode(refused)).toBe('unknown');
    expect(isCutlineTagConclusive(refused)).toBe(false);
    expect(refused.reason).toMatch(/Extracted/);
  });

  it('gives a pasted extracted row no computed cut', () => {
    // The same real time laid out as a pasted row, once with an X chip.
    const paste = [
      'Avery Henke',
      'Event\tTime\t\tMeet\tDate\tStamp Link',
      '100 Breast SCY\t54.09\tX\tNew South Championships\tFeb 20, 2026\t',
      '100 Breast SCY\t54.09\t\tNew South Championships\tFeb 20, 2026\t',
    ].join('\n');
    const rows = parseSwimCloudPasteDetailed(paste, { team: HSU, gender: Gender.MEN }).swims;
    expect(rows.map(s => [s.swimcloudBadge, s.computedCut])).toStrictEqual([
      ['extracted', null],
      ['none', 'B'],
    ]);
  });
});

describe('an extracted split fills a relay leg only when no standalone time exists', () => {
  // The free-relay scenario from scripts/test_relay_swaps.mjs: Alpha Four is not
  // a scorer, so leg 3 is vacated and the relay is ineligible until refilled.
  // Alpha Five is the one candidate, and the leg time shown is his history best.
  const TEAM = 'Alpha';
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
    maxIndividualEntriesPerSwimmer: 3,
    maxRelayEntriesPerSwimmer: 4,
  } as never;

  const ind = (id: string, name: string, team: string, time: string, rank: number) => ({
    id, rank, name, classYear: 'JR', team, time, points: 0, event: '50 Freestyle', gender: Gender.MEN, isRelay: false, roundSwam: 'A Final',
  });
  const legNames = ['Alpha One', 'Alpha Two', 'Alpha Three', 'Alpha Four'];
  const legs = legNames.map((nm, i) => ({
    id: `rel-${i}`,
    rank: 1,
    name: nm,
    classYear: 'JR',
    team: TEAM,
    time: '1:22.00',
    finalsTime: '1:22.00',
    relayTeamTime: '1:22.00',
    relayLegSplit: '20.5',
    relayLegIndex: i,
    relayNames: legNames.map(n => ({ name: n, year: 'JR' })),
    points: 0,
    event: '200 Yard Freestyle Relay',
    gender: Gender.MEN,
    isRelay: true,
    roundSwam: 'A Final',
  }));

  function rankWith(history: HistoricalSwim[]) {
    const ws = workspaceWith({
      menResults: [
        ind('a1', 'Alpha One', TEAM, '20.00', 2),
        ind('a2', 'Alpha Two', TEAM, '20.50', 3),
        ind('a3', 'Alpha Three', TEAM, '21.00', 4),
        ind('a5', 'Alpha Five', TEAM, '20.60', 5),
        ind('b1', 'Beta One', 'Beta', '19.90', 1),
        ...legs,
      ] as never,
      scoringSettings: ELIG_SETTINGS,
      athleteHistory: history,
      scorerRosterOverrides: [{ name: 'Alpha Four', team: TEAM, gender: Gender.MEN, isScorer: false }],
    });
    const ranking = rankRelayLegSwaps(ws, { team: TEAM, gender: Gender.MEN, settings: ELIG_SETTINGS });
    expect(ranking.swaps).toHaveLength(1);
    return ranking.swaps[0];
  }

  const swim = (time: string, extra: Partial<HistoricalSwim> = {}): HistoricalSwim => ({
    name: 'Alpha Five',
    team: TEAM,
    gender: Gender.MEN,
    event: '50 Freestyle',
    time,
    timeType: 'SCY',
    source: 'paste',
    ...extra,
  });

  it('uses a slower standalone swim over a faster extracted split', () => {
    const swap = rankWith([swim('20.40'), swim('20.10', { isExtractedSplit: true })]);
    expect(swap.inAthlete).toBe('Alpha Five');
    expect(swap.inTime).toBe('20.40');
    expect(swap.inTimeExtractedSplit).toBeUndefined();
  });

  it('falls back on the extracted split, marked, when it is all there is', () => {
    const swap = rankWith([swim('20.10', { swimcloudBadge: 'extracted' })]);
    expect(swap.inTime).toBe('20.10');
    expect(swap.inTimeExtractedSplit).toBe(true);
  });
});
