/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * User-inputted times (plans/2026-09-22/01, P4).
 *
 * SwimCloud marks a time the swimmer or a coach typed in with chip `U` /
 * `title="User Inputted"`. It is not a meet result. User ruling (2026-09-22):
 * import it and badge it, but never treat it as a best.
 *
 * So the bridge sets `HistoricalSwim.isUserInputted`, and every reader that
 * picks a best skips it: `categorizeBestEvents` (it lands in
 * `userInputtedByEvent` instead), `importHistoryToRoster` entry candidates,
 * cross-course arbitrage and relay-leg times (`convertedHistorySwims`), theory
 * entry plans and season analytics. A cut tag given `userInputted: true`
 * refuses with `state: 'user_inputted'`. The swim itself stays stored.
 *
 * The real captures: swimmer 2352628 has three `U` rows, all SCM; swimmer
 * 1401610 has three `U` rows in SCY, one of which (`400 IM SCY 3:58.24`)
 * would otherwise be badged a D2 B cut.
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
  isUserInputtedSwim,
  mergeHistoryIndex,
} from '../packages/core/src/lib/athleteHistory';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';
import { convertedHistorySwims } from '../packages/core/src/lib/arbitrage/shared';
import { buildCrossCourseTable } from '../packages/core/src/lib/crossCourseArbitrage';
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
const NAME = 'Fixture Swimmer';

function parseFixture(swimmerId: string, file: string) {
  const raw = readFileSync(join(repoRoot, 'tests', 'fixtures', file), 'utf8');
  const parsed = parseSwimmerFastestTimesJson(raw, {
    sourceUrl: `https://www.swimcloud.com/api/swimmers/${swimmerId}/profile_fastest_times/`,
    retrievedAt: '2026-09-22T12:00:00.000Z',
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error(parsed.failure.message);
  return parsed.data;
}

function importFixture(swimmerId: string, file: string): HistoricalSwim[] {
  const conversion = swimCloudSwimmerTimesToHistoricalSwims(
    { ...parseFixture(swimmerId, file), name: NAME },
    { team: HSU, gender: Gender.MEN }
  );
  if (!conversion.ok) throw new Error(conversion.message);
  return [...conversion.swims];
}

const U_FIXTURE = ['2352628', 'profile_fastest_times-2352628-user-inputted.json'] as const;
const ALT_FIXTURE = ['1401610', 'profile_fastest_times-1401610-altitude.json'] as const;

function workspaceWith(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-user-inputted',
    name: 'User inputted',
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

describe('the bridge flags exactly the rows SwimCloud marks User Inputted', () => {
  const swims = importFixture(...U_FIXTURE);

  it('flags the three U rows of swimmer 2352628, and keeps them', () => {
    const flagged = swims.filter(isUserInputtedSwim);
    expect(flagged.map((s) => [s.event, s.time, s.timeType])).toStrictEqual([
      ['100 Free SCM', '54.49', 'SCM'],
      ['400 Free SCM', '4:01.80', 'SCM'],
      ['100 Breast SCM', '1:08.56', 'SCM'],
    ]);
    const marked = parseFixture(...U_FIXTURE)
      .personalBests.filter((b) => b.tags.some((t) => t.title === 'User Inputted'))
      .map((b) => b.eventLabel);
    expect(flagged.map((s) => s.event)).toStrictEqual(marked);
  });

  it('leaves extracted splits exactly as they were', () => {
    expect(swims.filter((s) => s.isExtractedSplit === true).map((s) => s.event)).toStrictEqual([
      '50 Breast LCM',
      '50 Fly LCM',
      '100 Fly SCY',
      '100 Fly LCM',
    ]);
    expect(swims.filter((s) => s.isExtractedSplit && s.isUserInputted)).toStrictEqual([]);
  });

  it('matches the tooltip, never the visible letter', () => {
    const importOnce = (tags: { code: string; title?: string }[]) => {
      const result = swimCloudSwimmerTimesToHistoricalSwims(
        {
          swimCloudSwimmerId: '1',
          name: NAME,
          personalBests: [
            { swimKey: 'k', eventId: 'e', eventLabel: '100 Free SCY', time: '45.00', course: 'SCY', tags, relayLeadoff: false },
          ],
        } as never,
        { team: HSU, gender: Gender.MEN }
      );
      if (!result.ok) throw new Error('refused');
      return result.swims[0];
    };
    expect(importOnce([{ code: 'U', title: 'User Inputted' }]).isUserInputted).toBe(true);
    expect(importOnce([{ code: 'U', title: 'Unattached' }]).isUserInputted).toBeUndefined();
    expect(importOnce([{ code: 'M', title: 'User Inputted' }]).isUserInputted).toBe(true);
    expect(importOnce([]).isUserInputted).toBeUndefined();
  });
});

describe('a user-inputted time is never a best', () => {
  const swims = importFixture(...U_FIXTURE);
  const profile = categorizeBestEvents(swims, HSU, Gender.MEN, NAME, NSISC_PRESET_SETTINGS);

  it('stays out of bestByEvent and is listed in userInputtedByEvent', () => {
    // The 100 Free exists only as a U swim, so the swimmer has no 100 Free best.
    expect(profile.bestByEvent['100 Free SCY']).toBeUndefined();
    expect(profile.userInputtedByEvent).toStrictEqual({
      // 54.49 SCM x 0.896 (D2, truncated) = 48.82
      '100 Free SCY': { time: '48.82', timeSec: 48.82, source: 'swimcloud' },
      '500 Free SCY': { time: '4:36.37', timeSec: 276.37, source: 'swimcloud' },
      '100 Breast SCY': { time: '1:01.42', timeSec: 61.42, source: 'swimcloud' },
    });
    expect(profile.primaryEvents).not.toContain('100 Free SCY');
  });

  it('never beats a slower real swim', () => {
    // U 100 Breast SCM 1:08.56 converts to 1:01.42; the real 100 Breast LCM
    // 1:11.13 converts to 1:01.60. The real, slower swim holds the best.
    expect(profile.bestByEvent['100 Breast SCY']).toMatchObject({
      time: '1:01.60',
      convertedFrom: { sourceEvent: '100 Breast LCM', sourceTime: '1:11.13' },
    });
  });

  it('does not stand in for a relay leg the way an extracted split does', () => {
    expect(profile.extractedByEvent['100 Free SCY']).toBeUndefined();
    expect(profile.extractedByEvent['100 Fly SCY']?.time).toBe('54.91');
  });

  it('keeps its own lane in the stored history', () => {
    const real: HistoricalSwim = {
      name: NAME,
      team: HSU,
      gender: Gender.MEN,
      event: '100 Free SCM',
      time: '55.10',
      timeType: 'SCM',
      source: 'swimcloud',
    };
    const merged = mergeHistoryIndex([real], swims);
    const hundreds = merged.filter((s) => s.event === '100 Free SCM');
    // The faster U 54.49 neither evicts the real 55.10 nor is evicted by it.
    expect(hundreds.map((s) => [s.time, s.isUserInputted === true]).sort()).toStrictEqual([
      ['54.49', true],
      ['55.10', false],
    ]);
    // Two real swims still fold to the faster one, as before.
    const folded = mergeHistoryIndex([real], [{ ...real, time: '54.00' }]);
    expect(folded.map((s) => s.time)).toStrictEqual(['54.00']);
  });
});

describe('a user-inputted time is never entered', () => {
  const swims = importFixture(...U_FIXTURE);

  it('writes no recruit row or plan from a U swim, but stores it', () => {
    const onlyU = swims.filter(isUserInputtedSwim);
    const result = importHistoryToRoster(workspaceWith(), onlyU, { team: HSU, gender: Gender.MEN });
    expect(result.patch.recruits).toStrictEqual([]);
    expect(result.patch.meetEntryPlans).toStrictEqual([]);
    expect(result.patch.athleteHistory?.map((s) => s.event)).toStrictEqual([
      '100 Free SCM',
      '400 Free SCM',
      '100 Breast SCM',
    ]);
  });

  it('enters the real swim when a faster U swim shares its event', () => {
    const breast = swims.filter((s) => s.event === '100 Breast SCM' || s.event === '100 Breast LCM');
    expect(breast).toHaveLength(2);
    const result = importHistoryToRoster(workspaceWith(), breast, { team: HSU, gender: Gender.MEN });
    expect(result.patch.recruits?.map((r) => [r.event, r.time])).toStrictEqual([['100 Breast SCY', '1:01.60']]);
  });

  it('gives a theory entry no time from a U swim', () => {
    const history: HistoricalSwim[] = [
      {
        name: NAME,
        team: HSU,
        gender: Gender.MEN,
        event: '400 Individual Medley',
        time: '3:58.24',
        timeType: 'SCY',
        source: 'swimcloud',
        isUserInputted: true,
      },
    ];
    const result = applyScoringTheory(
      workspaceWith({ athleteHistory: history }),
      { relays: [], swimmers: [{ rawName: NAME, events: ['400 Individual Medley'] }], others: [], warnings: [] },
      { team: HSU, gender: Gender.MEN }
    );
    expect(result.summary.entriesAdded).toBe(0);
    expect(result.warnings).toContainEqual(expect.stringContaining('No history time'));
  });

  it('is no point in the season progression', () => {
    const history: HistoricalSwim[] = [
      { name: NAME, team: HSU, gender: Gender.MEN, event: '100 Freestyle', time: '44.00', source: 'swimcloud', isUserInputted: true },
      { name: NAME, team: HSU, gender: Gender.MEN, event: '100 Freestyle', time: '46.00', source: 'swimcloud' },
    ];
    const trends = buildSeasonTrends([workspaceWith({ athleteHistory: history })]);
    const trend = trends.swimmerTrends.find((t) => t.event === '100 Freestyle');
    expect(trend).toMatchObject({ bestTime: '46.00', meetCount: 1 });
  });
});

describe('a user-inputted time is never projected or cut-tagged (swimmer 1401610)', () => {
  const swims = importFixture(...ALT_FIXTURE);

  it('flags the three SCY U rows', () => {
    expect(swims.filter(isUserInputtedSwim).map((s) => [s.event, s.time])).toStrictEqual([
      ['500 Free SCY', '4:33.53'],
      ['100 Fly SCY', '49.75'],
      ['400 IM SCY', '3:58.24'],
    ]);
  });

  it('refuses the cut tag the time would otherwise earn', () => {
    const im = swims.find((s) => s.event === '400 IM SCY')!;
    const base = { team: HSU, gender: Gender.MEN, event: im.event, time: im.time, swimCourse: 'SCY' as const };
    // The regression: judged as a result, a self-reported 3:58.24 earns a badge.
    expect(buildCutlineTagForTeam(base)).toMatchObject({ state: 'tagged', tag: { label: 'D2 B CUT' } });
    const refused = buildCutlineTagForTeam({ ...base, userInputted: im.isUserInputted === true });
    expect(refused.state).toBe('user_inputted');
    expect(refused.tag).toBeNull();
    expect(refused.nextTier).toBeNull();
    expect(cutlineTagRenderMode(refused)).toBe('unknown');
    expect(isCutlineTagConclusive(refused)).toBe(false);
    expect(refused.reason).toMatch(/User Inputted/);
  });

  it('never reaches the cross-course projection or the relay-leg times', () => {
    expect([...convertedHistorySwims(swims)].filter((p) => p.swim.isUserInputted)).toStrictEqual([]);
    const table = buildCrossCourseTable(workspaceWith({ athleteHistory: swims }), { team: HSU, gender: Gender.MEN });
    // The 400 IM exists only as a U swim.
    expect(table.rows.find((r) => r.event === '400 Individual Medley')).toBeUndefined();
    // The U 500 Free SCY 4:33.53 would have been the yards best; none remains,
    // and the converted A swim is the only candidate.
    const five = table.rows.find((r) => r.event === '500 Freestyle');
    expect(five?.scyBest).toBeUndefined();
    expect(five?.convertedBest?.time).toBe('4:35.53');
  });
});
