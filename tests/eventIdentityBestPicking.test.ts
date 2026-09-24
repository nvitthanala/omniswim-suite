/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One event, one best (plans/2026-09-22/01, P12 defect 2).
 *
 * The same swim reaches this app under several labels. The SwimCloud times
 * JSON writes `'50 Free SCY'`, a pasted profile writes `'50 Freestyle'`, a
 * HyTek meet writes `'Event 8 Men 50 Yard Freestyle'`, and a scoring theory
 * writes `'50 Freestyle'`. Best picking keyed on the raw label, so:
 *
 *  - one swimmer imported from both a paste and the JSON got two bests for one
 *    event, and `importHistoryToRoster` wrote two recruit rows for it;
 *  - `applyScoringTheory` keyed its history bests `'100 Back SCY'` while the
 *    theory asks for `'100 Backstroke'`, so a JSON-imported swimmer never
 *    got a theory entry.
 *
 * Best picking now keys on one event identity everywhere. The label a best is
 * shown under stays the label its swim was recorded with.
 *
 * Bartu Akin (HSU) is the real case: he is swimmer 2352628 in the JSON fixture
 * and a block in the HSU roster export `hsuroster26-27.txt`, lines 115-146.
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
  isSameSwimEvent,
  parseSwimCloudPasteDetailed,
  swimEventIdentity,
} from '../packages/core/src/lib/athleteHistory';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';
import { applyScoringTheory } from '../packages/core/src/lib/scoringTheory';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { createPlannedEntry } from '../packages/core/src/lib/whatIfProjection';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State';

function importFixture(swimmerId: string, file: string, name: string): HistoricalSwim[] {
  const raw = readFileSync(join(repoRoot, 'tests', 'fixtures', file), 'utf8');
  const parsed = parseSwimmerFastestTimesJson(raw, {
    sourceUrl: `https://www.swimcloud.com/api/swimmers/${swimmerId}/profile_fastest_times/`,
    retrievedAt: '2026-09-22T12:00:00.000Z',
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error(parsed.failure.message);
  const conversion = swimCloudSwimmerTimesToHistoricalSwims(
    { ...parsed.data, name },
    { team: HSU, gender: Gender.MEN }
  );
  if (!conversion.ok) throw new Error(conversion.message);
  return [...conversion.swims];
}

function workspaceWith(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-identity',
    name: 'Event identity',
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

/** `hsuroster26-27.txt` lines 115-116 and the SCY rows among 117-146, verbatim. */
const AKIN_PASTE = [
  'Bartu Akin',
  'Event\tTime\t\tMeet\tDate\tStamp Link',
  '1000 Free SCY\t9:30.37\t\tNew South Championships\tFeb 18, 2026\t',
  '1650 Free SCY\t16:00.67\t\tNew South Championships\tFeb 21, 2026\t',
  '500 Free SCY\t4:36.04\t\tNew South Championships\tFeb 20, 2026\t',
  '400 IM SCY\t3:58.72\t\tNew South Championships\tFeb 19, 2026\t',
  '200 Free SCY\t1:42.67\tR\tNew South Championships\tFeb 17, 2026\t',
  '100 Fly SCY\t54.91\tX\tNew South Championships\tFeb 19, 2026\t',
  '50 Free SCY\t22.65\t\tLittle Rock Fall Invite\tOct 10, 2025\t',
].join('\n');

describe('the event identity', () => {
  it('folds every label one event is written under', () => {
    const fifty = swimEventIdentity('50 Freestyle');
    for (const label of ['50 Free SCY', '50 Free', '50 freestyle', 'Event 8 Men 50 Yard Freestyle']) {
      expect(swimEventIdentity(label)).toBe(fifty);
    }
    expect(isSameSwimEvent('100 Back SCY', '100 Backstroke')).toBe(true);
    expect(isSameSwimEvent('200 IM SCY', '200 Individual Medley')).toBe(true);
    expect(isSameSwimEvent('50 Free SCY', '100 Free SCY')).toBe(false);
    expect(isSameSwimEvent('100 Back SCY', '100 Breast SCY')).toBe(false);
    // A time trial is swum at the meet but is not the program event.
    expect(isSameSwimEvent('Event 100 Men 100 Yard Breaststroke Time Trial', '100 Breaststroke')).toBe(false);
  });
});

describe('one swimmer, two sources, one best per event (Bartu Akin)', () => {
  const pasted = parseSwimCloudPasteDetailed(AKIN_PASTE, { team: HSU, gender: Gender.MEN }).swims;
  const fromJson = importFixture('2352628', 'profile_fastest_times-2352628-user-inputted.json', 'Bartu Akin');

  it('holds the same swims under two label families', () => {
    expect(pasted.find(s => s.time === '22.65')?.event).toBe('50 Freestyle');
    expect(fromJson.find(s => s.time === '22.65')?.event).toBe('50 Free SCY');
  });

  it('gives each event exactly one best', () => {
    const profile = categorizeBestEvents(
      [...pasted, ...fromJson],
      HSU,
      Gender.MEN,
      'Bartu Akin',
      NSISC_PRESET_SETTINGS
    );
    const keys = Object.keys(profile.bestByEvent);
    const identities = keys.map(swimEventIdentity);
    expect(new Set(identities).size).toBe(keys.length);
    const fifties = keys.filter(k => isSameSwimEvent(k, '50 Freestyle'));
    expect(fifties).toHaveLength(1);
    expect(profile.bestByEvent[fifties[0]].time).toBe('22.65');
    // The primary events are distinct events, not two labels of one.
    const primary = profile.primaryEvents.map(swimEventIdentity);
    expect(new Set(primary).size).toBe(primary.length);
  });

  it('keeps the recorded label of the swim that holds the best', () => {
    const profile = categorizeBestEvents(fromJson, HSU, Gender.MEN, 'Bartu Akin', NSISC_PRESET_SETTINGS);
    expect(profile.bestByEvent['50 Free SCY']?.time).toBe('22.65');
    expect(profile.bestByEvent['400 IM SCY']?.time).toBe('3:58.72');
  });

  it('writes one recruit row per event', () => {
    const fifties = [...pasted, ...fromJson].filter(s => s.time === '22.65');
    expect(fifties.map(s => s.event).sort()).toStrictEqual(['50 Free SCY', '50 Freestyle']);
    const result = importHistoryToRoster(workspaceWith(), fifties, { team: HSU, gender: Gender.MEN });
    expect(result.patch.recruits?.map(r => [r.event, r.time])).toHaveLength(1);
    expect(result.patch.recruits?.[0].time).toBe('22.65');
  });

  it('writes no second plan for an event the swimmer already has under another label', () => {
    const existing = createPlannedEntry({
      name: 'Bartu Akin',
      team: HSU,
      gender: Gender.MEN,
      classYear: 'SO',
      event: '50 Freestyle',
      time: '22.65',
      timeType: 'SCY',
      source: 'swimcloud',
      active: true,
    });
    const onRoster = workspaceWith({
      menResults: [
        {
          id: 'r1',
          rank: 1,
          name: 'Bartu Akin',
          classYear: 'SO',
          team: HSU,
          time: '1:42.67',
          points: 0,
          event: '200 Freestyle',
          gender: Gender.MEN,
        },
        // Another swimmer's 50 Free, so the loaded meet contests the event and
        // the candidate reaches the duplicate check at all.
        {
          id: 'r2',
          rank: 1,
          name: 'Other Swimmer',
          classYear: 'JR',
          team: 'Delta State University',
          time: '20.90',
          points: 0,
          event: 'Event 8 Men 50 Yard Freestyle',
          gender: Gender.MEN,
        },
      ],
      meetEntryPlans: [existing],
      activeEntryIds: [existing.id],
    });
    const json50 = fromJson.filter(s => s.event === '50 Free SCY');
    const result = importHistoryToRoster(onRoster, json50, { team: HSU, gender: Gender.MEN });
    const fifties = (result.patch.meetEntryPlans ?? []).filter(p => isSameSwimEvent(p.event, '50 Freestyle'));
    expect(fifties.map(p => p.event)).toStrictEqual(['50 Freestyle']);
    expect(result.summary.lineupEntriesAdded).toBe(0);
    // The preview agrees: nothing new to add for this swimmer.
    expect(result.summary.swimmers.map(s => s.action)).toStrictEqual(['history_matched']);
  });
});

describe('a theory event finds a best recorded under a SwimCloud label', () => {
  // Avery Henke (swimmer 1330318): 100 Back SCY 49.58, imported from the JSON.
  const history = importFixture('1330318', 'profile_fastest_times-1330318.json', 'Avery Henke');

  it('plans the theory entry on the JSON best', () => {
    expect(history.find(s => s.event === '100 Back SCY')?.time).toBe('49.58');
    const result = applyScoringTheory(
      workspaceWith({ athleteHistory: history }),
      { relays: [], swimmers: [{ rawName: 'Avery Henke', events: ['100 Backstroke'] }], others: [], warnings: [] },
      { team: HSU, gender: Gender.MEN }
    );
    expect(result.warnings.filter(w => /No history time/.test(w))).toStrictEqual([]);
    expect(result.summary.entriesAdded).toBe(1);
    const plan = result.patch.meetEntryPlans?.find(p => p.name === 'Avery Henke');
    expect(plan).toMatchObject({ event: '100 Backstroke', time: '49.58', timeType: 'SCY' });
  });

  it('does not add a second plan for an event already planned under the SwimCloud label', () => {
    const existing = createPlannedEntry({
      name: 'Avery Henke',
      team: HSU,
      gender: Gender.MEN,
      classYear: 'SR',
      event: '100 Back SCY',
      time: '49.58',
      timeType: 'SCY',
      source: 'swimcloud',
      active: true,
    });
    const result = applyScoringTheory(
      workspaceWith({ athleteHistory: history, meetEntryPlans: [existing], activeEntryIds: [existing.id] }),
      { relays: [], swimmers: [{ rawName: 'Avery Henke', events: ['100 Backstroke'] }], others: [], warnings: [] },
      { team: HSU, gender: Gender.MEN }
    );
    expect(result.summary.entriesAdded).toBe(0);
    expect(result.warnings).toContainEqual(expect.stringContaining('already has a plan for 100 Backstroke'));
  });
});

describe('a loaded-meet result still matches by label (unchanged)', () => {
  // Pinned on purpose. A plan in an event the swimmer swam at the loaded meet
  // overrides that result in the overlay projection and is the swimmer's only
  // entry in plan_sheet mode. Whether a HyTek-labelled result should block such
  // a plan is a lineup decision that the best-time fix does not make.
  const history = importFixture('1330318', 'profile_fastest_times-1330318.json', 'Avery Henke');
  const meetRow = {
    id: 'r-back',
    rank: 2,
    name: 'Avery Henke',
    classYear: 'SR',
    team: HSU,
    time: '49.90',
    points: 17,
    event: 'Event 24 Men 100 Yard Backstroke',
    gender: Gender.MEN,
  };

  it('does not stop a theory plan', () => {
    const result = applyScoringTheory(
      workspaceWith({ athleteHistory: history, menResults: [meetRow] }),
      { relays: [], swimmers: [{ rawName: 'Avery Henke', events: ['100 Backstroke'] }], others: [], warnings: [] },
      { team: HSU, gender: Gender.MEN }
    );
    expect(result.summary.entriesAdded).toBe(1);
  });

  it('does not stop an import plan', () => {
    const back = history.filter(s => s.event === '100 Back SCY');
    const result = importHistoryToRoster(workspaceWith({ menResults: [meetRow] }), back, {
      team: HSU,
      gender: Gender.MEN,
    });
    expect(result.patch.meetEntryPlans?.map(p => [p.event, p.time])).toStrictEqual([['100 Back SCY', '49.58']]);
  });
});
