/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Replace mode for a full SwimCloud reimport (plans/2026-09-24, item A1).
 *
 * The real case: on the HSU 2026-27 roster plan, Fabio Capocci holds a recruit
 * row and an optimizer plan for 100 Backstroke 48.15. Both are the SCY
 * conversion of a self-reported `100 Back LCM 56.98 U`, written by the import
 * before self-reported times stopped being bests. A merge reimport cannot
 * remove them; a replace must. `tests/fixtures/hsu-2026-27-replace-snapshot.json`
 * holds his stored rows verbatim, and Noel Kis's, whose SCM rows were
 * converted with the pre-2026-09-22 D1 factor.
 *
 * Merge mode must stay as it was. The two golden hashes below were taken from
 * the code before this change (HEAD 3cdaa21f) with `uuid` and `Date.now`
 * pinned. The only difference allowed is the new `Recruit.source` field.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseSwimmerFastestTimesJson } from '@omniswim/swimcloud';
import { swimCloudSwimmerTimesToHistoricalSwims } from '@omniswim/manager/lib/swimCloudImportBridge';
import {
  Gender,
  type HistoricalSwim,
  type PlannedSwimEntry,
  type Recruit,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import { parseSwimCloudPasteDetailed } from '../packages/core/src/lib/athleteHistory';
import {
  importHistoryToRoster,
  previewSwimCloudReplace,
  SwimCloudReplaceRefusedError,
  type HistoryImportRosterResult,
} from '../packages/core/src/lib/historyImportRoster';
import {
  applySwimCloudReplacePlan,
  isSwimCloudHistorySource,
  planSwimCloudReplace,
  SWIMCLOUD_HISTORY_SOURCES,
} from '../packages/core/src/lib/swimCloudReplace';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { convertSwimToSCYDetailed } from '../packages/core/src/lib/utils';

const ids = vi.hoisted(() => ({ n: 0 }));
vi.mock('uuid', () => ({ v4: () => `uuid-${String(++ids.n).padStart(4, '0')}` }));

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State University';

const CAPOCCI_PASTE = [
  'Fabio Capocci',
  'Event\tTime\t\tMeet\tDate\tStamp Link',
  '50 Free LCM\t23.06\t\tCampeonato Brasileiro Absoluto de natação\tApr 25, 2025\t',
  '100 Back LCM\t56.98\tU\tCampeonato brasileiro Júnior de verão\tDec 11, 2024\t',
  '50 Back LCM\t26.21\t\tCampeonato Brasileiro Absoluto de natação\tApr 24, 2025\t',
  '50 Free SCM\t22.58\t\tCampeonato Paulista Júnior e Sênior de Verão\tNov 16, 2024\t',
  '100 Free LCM\t52.58\t\tCampeonato Brasileiro Junior de Verao\tDec 11, 2024\t',
  '100 Back SCM\t54.44\t\tCampeonato Paulista Júnior e Sênior de Verão\tNov 16, 2024\t',
  '50 Back SCM\t25.09\t\tSP OPEN DE NATAÇÃO DE VERÃO\tNov 15, 2024\t',
  '100 Fly LCM\t56.30\t\tCampeonato Brasileiro Absoluto de Natação\tMay 30, 2023\t',
  '100 Free SCM\t51.19\t\tCampeonato Paulista Júnior e Sênior de Verão\tNov 14, 2024\t',
  '50 Fly SCM\t25.09\t\tCampeonato Paulista Júnior e Sênior de Verão\tNov 14, 2024\t',
  '50 Fly LCM\t27.43\tX\tPAULISTÃO FAP JUVENIL A SÊNIOR DE VERÃO\tDec 18, 2021\t',
].join('\n');

const NOEL_KIS_PASTE = [
  'Noel Kis',
  'Event\tTime\t\tMeet\tDate\tStamp Link',
  '100 Free LCM\t50.78\tR\tLEN European Junior Championships\tJul 5, 2023\t',
  '100 Free SCM\t48.99\t\tXXI Országos Bajnokság (25m)\tNov 5, 2025\t',
  '50 Free SCM\t22.10\t\tXXI Országos Bajnokság (25m)\tNov 6, 2025\t',
  '50 Free LCM\t23.32\t\tWorld Aquatics World Cup - Budapest\tOct 20, 2023\t',
  '50 Fly SCM\t24.20\t\tXXI Országos Bajnokság (25m)\tNov 7, 2025\t',
  '50 Fly LCM\t25.33\t\tWorld Aquatics World Cup - Budapest\tOct 22, 2023\t',
  '50 Back LCM\t27.04\t\tMultinations Junior Meet\tApr 7, 2024\t',
  '100 Back SCM\t56.44\t\tHajós Alfréd Kupa III. forduló\tSep 27, 2025\t',
  '50 Back SCM\t27.47\tX\tHajós Alfréd Kupa III. forduló\tSep 27, 2025\t',
  '200 Free SCM\t2:12.23\t\tHajós Alfréd Kupa III. forduló\tSep 27, 2025\t',
].join('\n');

const CURTIS_MALONE_PASTE = [
  'Curtis Malone',
  'Event\tTime\tDate',
  '200 Back LCM\t2:03.86\tJun 19, 2026',
  '100 Back LCM\t57.29\tJul 18, 2025',
  '200 Free SCY\t1:39.30\tMar 19, 2026',
  '100 Back SCY\t48.71\tFeb 20, 2026',
  '200 Back SCY\t1:46.36\tFeb 22, 2026',
  '1000 Free SCY\t9:44.27\tJan 18, 2026',
  '50 Back LCM\t26.86\tJul 19, 2025',
  '500 Free SCY\t4:36.51\tJan 16, 2026',
  '100 Free SCY\t45.50\tNov 21, 2025',
  '50 Back SCY\t22.97\tNov 21, 2025',
  '200 IM LCM\t2:10.74\tJul 20, 2025',
  '200 IM SCY\t1:50.74\tNov 8, 2025',
  '100 Free LCM\t53.49\tJun 21, 2026',
  '200 Free LCM\t1:57.59\tJul 27, 2025',
  '400 IM SCY\t4:01.83\tFeb 20, 2026',
  '400 Free LCM\t4:14.81\tJun 21, 2026',
  '800 Free LCM\t8:45.20\tJun 18, 2026',
  '400 IM LCM\t4:42.91\tJul 18, 2025',
  '50 Free LCM\t24.91\tJul 19, 2025',
].join('\n');

const AVERY_HENKE_PASTE = [
  'Avery Henke',
  'Event\tTime\t\tMeet\tDate\tStamp Link',
  '100 Breast SCY\t54.09\tD2 B\tNew South Championships\tFeb 20, 2026\t',
  '50 Breast SCY\t25.16\tX\tNew South Championships\tFeb 20, 2026\t',
  '50 Back SCY\t22.53\tR\tNew South Championships\tFeb 18, 2026\t',
  '200 IM SCY\t1:49.77\tWIN JRS\t2023 Louisiana Senior SC State Championships\tFeb 12, 2023\t',
  '50 Breast LCM\t29.29\t\tSE AUB Richard Quick Invitational\tJun 23, 2024\t',
  '200 Free SCY\t1:41.29\tR\t2023 Louisiana Senior SC State Championships\tFeb 9, 2023\t',
  '200 Breast SCY\t2:00.93\t\tFirst Chance Invite\tFeb 8, 2025\t',
  '100 Free SCY\t45.39\tR\t2023 Louisiana Senior SC State Championships\tFeb 10, 2023\t',
  '200 Back SCY\t1:49.63\t\t2021 MS Tupelo Top TYR Invitational\tMar 7, 2021\t',
  '100 Back SCY\t49.58\tR\tNew South Championships\tFeb 19, 2026\t',
  '100 Fly SCY\t49.29\t\tNew South Championships\tFeb 19, 2026\t',
].join('\n');

function pastedSwims(...blocks: string[]): HistoricalSwim[] {
  const parsed = parseSwimCloudPasteDetailed(blocks.join('\n\n'), { team: HSU, gender: Gender.MEN });
  return parsed.swims;
}

function jsonSwims(swimmerId: string, file: string, name: string): HistoricalSwim[] {
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

function allFixtureSwims(): HistoricalSwim[] {
  return [
    ...pastedSwims(CAPOCCI_PASTE, NOEL_KIS_PASTE, CURTIS_MALONE_PASTE, AVERY_HENKE_PASTE),
    ...jsonSwims('1330318', 'profile_fastest_times-1330318.json', 'Json Swimmer A'),
    ...jsonSwims('1401610', 'profile_fastest_times-1401610-altitude.json', 'Json Swimmer B'),
    ...jsonSwims('2352628', 'profile_fastest_times-2352628-user-inputted.json', 'Bartu Akin'),
    ...jsonSwims('2508045', 'profile_fastest_times-2508045-diver.json', 'Json Diver'),
  ];
}

/** A workspace with a loaded meet row, a manual recruit, a manual plan and PDF history. */
function goldenWorkspace(): Workspace {
  return {
    id: 'ws-replace-golden',
    name: 'HSU replace golden',
    createdAt: 0,
    conference: 'NSISC',
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    menResults: [
      {
        id: 'res-malone-100back',
        rank: 3,
        name: 'Curtis Malone',
        classYear: 'FR',
        team: HSU,
        time: '48.71',
        points: 16,
        event: 'Event 12 Men 100 Yard Backstroke',
        gender: Gender.MEN,
      },
    ],
    womenResults: [],
    recruits: [
      {
        id: 'rec-henke-manual',
        name: 'Avery Henke',
        team: HSU,
        event: '100 Breaststroke',
        time: '54.09',
        gender: Gender.MEN,
        classYear: 'SO',
        timeType: 'SCY',
      },
    ],
    meetEntryPlans: [
      {
        id: 'plan-malone-manual',
        name: 'Curtis Malone',
        team: HSU,
        gender: Gender.MEN,
        event: '200 Backstroke',
        time: '1:46.36',
        timeType: 'SCY',
        source: 'manual',
        active: true,
      },
    ],
    activeEntryIds: ['plan-malone-manual'],
    athleteHistory: [
      {
        name: 'Curtis Malone',
        team: HSU,
        gender: Gender.MEN,
        event: '100 Backstroke',
        time: '48.71',
        timeType: 'SCY',
        source: 'pdf',
        meetLabel: 'nsisc-2026.pdf',
      },
    ],
    athleteAliases: [],
  } as unknown as Workspace;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function goldenMergeResult(
  workspace: Workspace = goldenWorkspace(),
  mode?: 'merge'
): HistoryImportRosterResult {
  ids.n = 0;
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_788_000_000_000);
  try {
    return importHistoryToRoster(workspace, allFixtureSwims(), {
      team: HSU,
      gender: Gender.MEN,
      sourceType: 'swimcloud_paste',
      sourceLabel: 'golden',
      ...(mode ? { mode } : {}),
    });
  } finally {
    now.mockRestore();
  }
}

/** Taken from the code before this change (HEAD 3cdaa21f), same pins. */
const MERGE_GOLDEN_WITH_MEET = '811830d10e4c6be4038d1c18698fc3b9b5fdfdd115d2fca4aef0008eb17485ff';
const MERGE_GOLDEN_NO_MEET = '906b4c91855dc79177f4a9137554873b2d7428cac1f84c6051c411321c2699a9';

/** The result with `source` taken off every recruit row: the pre-change shape. */
function withoutRecruitSource(result: HistoryImportRosterResult): HistoryImportRosterResult {
  const recruits = result.patch.recruits?.map(r => {
    const copy: Partial<Recruit> = { ...r };
    delete copy.source;
    return copy as Recruit;
  });
  return { ...result, patch: { ...result.patch, ...(recruits ? { recruits } : {}) } };
}

const noMeetWorkspace = (): Workspace => ({ ...goldenWorkspace(), menResults: [] });

describe('merge mode is unchanged', () => {
  it('matches the pre-change output with a loaded meet, apart from Recruit.source', () => {
    const result = goldenMergeResult();
    expect(result.summary.newRecruits).toBe(4);
    expect(result.summary.lineupEntriesAdded).toBe(2);
    expect(sha256(withoutRecruitSource(result))).toBe(MERGE_GOLDEN_WITH_MEET);
  });

  it('matches the pre-change output with no meet loaded, apart from Recruit.source', () => {
    const result = goldenMergeResult(noMeetWorkspace());
    expect(result.summary.newRecruits).toBe(39);
    expect(result.summary.lineupEntriesAdded).toBe(6);
    expect(sha256(withoutRecruitSource(result))).toBe(MERGE_GOLDEN_NO_MEET);
  });

  it('treats mode "merge" as the default, and returns no replace plan', () => {
    const byDefault = goldenMergeResult(noMeetWorkspace());
    const explicit = goldenMergeResult(noMeetWorkspace(), 'merge');
    expect(sha256(explicit)).toBe(sha256(byDefault));
    expect(explicit).not.toHaveProperty('replaced');
  });

  it('records the source of the history swim on every recruit row it writes', () => {
    const recruits = goldenMergeResult(noMeetWorkspace()).patch.recruits ?? [];
    const written = recruits.filter(r => r.id.startsWith('uuid-'));
    expect(written).toHaveLength(39);
    const jsonNames = new Set(['Json Swimmer A', 'Json Swimmer B', 'Bartu Akin', 'Json Diver']);
    for (const r of written) {
      expect(r.source, `${r.name} ${r.event}`).toBe(jsonNames.has(r.name) ? 'swimcloud' : 'paste');
    }
    expect(new Set(written.map(r => r.source))).toStrictEqual(new Set(['paste', 'swimcloud']));
    // A row the import did not write keeps its shape: no source appears on it.
    expect(recruits.find(r => r.id === 'rec-henke-manual')).not.toHaveProperty('source');
  });
});

describe('what a replace treats as SwimCloud history', () => {
  it('is the bridge source and the paste parsers, nothing else', () => {
    expect([...SWIMCLOUD_HISTORY_SOURCES].sort()).toStrictEqual(['paste', 'swimcloud']);
    expect(isSwimCloudHistorySource('paste')).toBe(true);
    expect(isSwimCloudHistorySource('swimcloud')).toBe(true);
    for (const other of ['pdf', 'manual', 'csv', 'ocr', '', null, undefined]) {
      expect(isSwimCloudHistorySource(other)).toBe(false);
    }
  });

  it('agrees with the paste parsers: every pasted row is source paste', () => {
    const swims = pastedSwims(CAPOCCI_PASTE, NOEL_KIS_PASTE, CURTIS_MALONE_PASTE, AVERY_HENKE_PASTE);
    expect(swims.length).toBeGreaterThan(40);
    expect(new Set(swims.map(s => s.source))).toStrictEqual(new Set(['paste']));
  });
});

/* -------------------------------------------------------------------------- */
/* The stored HSU rows                                                         */
/* -------------------------------------------------------------------------- */

type Snapshot = {
  team: string;
  athleteHistory: HistoricalSwim[];
  recruits: Recruit[];
  meetEntryPlans: PlannedSwimEntry[];
  activeEntryIds: string[];
};

const SNAPSHOT: Snapshot = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'hsu-2026-27-replace-snapshot.json'), 'utf8')
);

type Extra = {
  history?: HistoricalSwim[];
  recruits?: Recruit[];
  plans?: PlannedSwimEntry[];
  menResults?: SwimmerResult[];
  over?: Partial<Workspace>;
};

/** The stored Capocci and Kis rows, plus any extra rows a test needs. */
function storedWorkspace(extra: Extra = {}): Workspace {
  const snap: Snapshot = structuredClone(SNAPSHOT);
  return {
    id: 'ws-hsu-snapshot',
    name: 'HSU 2026-27 Roster Plan (snapshot)',
    createdAt: 0,
    conference: 'NSISC',
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    menResults: extra.menResults ?? [],
    womenResults: [],
    athleteHistory: [...snap.athleteHistory, ...(extra.history ?? [])],
    recruits: [...snap.recruits, ...(extra.recruits ?? [])],
    meetEntryPlans: [...snap.meetEntryPlans, ...(extra.plans ?? [])],
    activeEntryIds: [...snap.activeEntryIds],
    athleteAliases: [],
    ...extra.over,
  } as Workspace;
}

const MEN = Gender.MEN;
const isCapocci = (row: { name: string }) => row.name === 'Fabio Capocci';
const isKis = (row: { name: string }) => row.name === 'Noel Kis';
const idsOf = (rows: { row: { id: string } }[]) => rows.map(r => r.row.id);

function stored<T extends { name: string; event: string }>(rows: T[], name: string, event: string): T {
  const hit = rows.find(r => r.name === name && r.event === event);
  if (!hit) throw new Error(`snapshot has no ${name} ${event} row`);
  return hit;
}
const storedRecruit = (name: string, event: string) => stored(SNAPSHOT.recruits, name, event);
const storedPlan = (name: string, event: string) => stored(SNAPSHOT.meetEntryPlans, name, event);

/** A coach's plan in the same event, at the same time, as the traced optimizer plan. */
const CAPOCCI_MANUAL_100_BACK: PlannedSwimEntry = {
  id: 'plan-capocci-manual-100back',
  name: 'Fabio Capocci',
  team: HSU,
  gender: MEN,
  classYear: 'FR',
  event: '100 Backstroke',
  time: '48.15',
  timeType: 'SCY',
  source: 'manual',
  active: true,
};

/** A loaded-meet swim kept as PDF history (Curtis Malone's own 100 Back SCY). */
const MALONE_PDF_ROW: HistoricalSwim = {
  name: 'Curtis Malone',
  team: HSU,
  gender: MEN,
  event: '100 Backstroke',
  time: '48.71',
  timeType: 'SCY',
  source: 'pdf',
  meetLabel: 'nsisc-2026.pdf',
};

describe('the Capocci case: rows built from a self-reported swim go, manual and PDF stay', () => {
  it('the snapshot holds the stored 48.15 rows and the U swim they came from', () => {
    const u = SNAPSHOT.athleteHistory.filter(h => isCapocci(h) && h.swimcloudBadge === 'user_input');
    expect(u.map(h => [h.event, h.time, h.timeType, h.source])).toStrictEqual([
      ['100 Backstroke', '56.98', 'LCM', 'paste'],
    ]);
    const back = (rows: { name: string; event: string; time: string }[]) =>
      rows.filter(r => isCapocci(r) && r.event === '100 Backstroke').map(r => r.time);
    expect(back(SNAPSHOT.recruits)).toStrictEqual(['48.15']);
    expect(back(SNAPSHOT.meetEntryPlans)).toStrictEqual(['48.15']);
    // 48.15 is today's LCM conversion of the U swim, so the rows trace to it.
    expect(convertSwimToSCYDetailed('100 Backstroke', '56.98', MEN, 'LCM', { team: HSU }).time).toBe('48.15');
  });

  it('plans to remove his pasted history, his recruit rows and his optimizer plans', () => {
    const ws = storedWorkspace({ plans: [CAPOCCI_MANUAL_100_BACK], history: [MALONE_PDF_ROW] });
    const plan = planSwimCloudReplace(ws, { team: HSU, gender: MEN });

    expect(plan.historyToRemove.filter(isCapocci)).toHaveLength(11);
    expect(plan.historyToRemove).not.toContain(ws.athleteHistory?.find(h => h.source === 'pdf'));
    expect(plan.keptCounts.history).toBe(1);

    const recruits = plan.recruitsToRemove.filter(r => isCapocci(r.row));
    expect(recruits).toHaveLength(4);
    expect(recruits.every(r => r.reason === 'traced_to_removed_swim')).toBe(true);
    const back = recruits.find(r => r.row.event === '100 Backstroke');
    expect(back?.row.time).toBe('48.15');
    expect(back?.tracedTo).toMatchObject({ event: '100 Backstroke', time: '56.98', swimcloudBadge: 'user_input' });

    const plans = plan.plansToRemove.filter(r => isCapocci(r.row));
    expect(plans.map(r => [r.row.event, r.row.time, r.reason])).toStrictEqual([
      ['50 Freestyle', '20.06', 'traced_to_removed_swim'],
      ['100 Butterfly', '49.43', 'traced_to_removed_swim'],
      ['100 Backstroke', '48.15', 'traced_to_removed_swim'],
      ['100 Freestyle', '45.90', 'traced_to_removed_swim'],
    ]);
    expect(idsOf(plan.plansToRemove)).not.toContain(CAPOCCI_MANUAL_100_BACK.id);
    expect(plan.keptCounts.plans).toBe(1);
    expect(plan.keptUntraced).toStrictEqual({ recruits: [], plans: [] });
    expect(plan.keptAmbiguous).toStrictEqual({ recruits: [], plans: [] });
  });

  it('a replace reimport rebuilds him from the fresh swims', () => {
    const ws = storedWorkspace({ plans: [CAPOCCI_MANUAL_100_BACK], history: [MALONE_PDF_ROW] });
    const result = importHistoryToRoster(ws, pastedSwims(CAPOCCI_PASTE, NOEL_KIS_PASTE), {
      team: HSU,
      gender: MEN,
      mode: 'replace',
    });
    expect(result.noop).toBe(false);
    expect(result.replaced?.recruitsToRemove).toHaveLength(8);
    expect(result.replaced?.plansToRemove).toHaveLength(7);

    const recruits = (result.patch.recruits ?? []).filter(isCapocci);
    expect(recruits.some(r => r.time === '48.15')).toBe(false);
    expect(SNAPSHOT.recruits.filter(isCapocci).every(old => !recruits.some(r => r.id === old.id))).toBe(true);
    expect(recruits.every(r => r.source === 'paste')).toBe(true);
    // The coach's manual plan still holds 100 Backstroke, so the import adds no row there.
    expect(recruits.map(r => r.event).sort()).toStrictEqual(['100 Butterfly', '100 Freestyle', '50 Freestyle']);

    const plans = result.patch.meetEntryPlans ?? [];
    expect(plans.filter(isCapocci)).toStrictEqual([CAPOCCI_MANUAL_100_BACK]);
    expect(plans.some(p => p.source === 'optimizer')).toBe(false);
    expect(result.patch.activeEntryIds).toStrictEqual([]);
    expect(result.patch.athleteHistory).toContainEqual(MALONE_PDF_ROW);
    const u = (result.patch.athleteHistory ?? []).filter(h => isCapocci(h) && h.time === '56.98');
    // The U swim is stored again, flagged this time, and written into no row.
    expect(u.map(h => [h.event, h.timeType, h.isUserInputted])).toStrictEqual([['100 Backstroke', 'LCM', true]]);
  });

  it('with no manual plan in the way, his 100 Back comes from the real SCM swim', () => {
    const result = importHistoryToRoster(storedWorkspace(), pastedSwims(CAPOCCI_PASTE, NOEL_KIS_PASTE), {
      team: HSU,
      gender: MEN,
      mode: 'replace',
    });
    const back = (result.patch.recruits ?? []).filter(r => isCapocci(r) && r.event === '100 Backstroke');
    const scm = convertSwimToSCYDetailed('100 Backstroke', '54.44', MEN, 'SCM', { team: HSU });
    expect(scm.time).not.toBe('48.15');
    expect(back.map(r => [r.time, r.source])).toStrictEqual([[scm.time, 'paste']]);
    expect(back[0].convertedFrom).toMatchObject({ sourceCourse: 'SCM', sourceEvent: '100 Backstroke', sourceTime: '54.44' });
  });

  it('a merge reimport leaves the 48.15 rows in place, which is why replace exists', () => {
    const result = importHistoryToRoster(storedWorkspace(), pastedSwims(CAPOCCI_PASTE), {
      team: HSU,
      gender: MEN,
    });
    const back = (result.patch.recruits ?? []).filter(r => isCapocci(r) && r.time === '48.15');
    expect(back).toHaveLength(1);
    expect(result.replaced).toBeUndefined();
  });
});

describe('rows the pre-2026-09-22 SCM conversion wrote', () => {
  it('today\'s conversion does not reproduce them', () => {
    expect(convertSwimToSCYDetailed('50 Freestyle', '22.10', MEN, 'SCM', { team: HSU }).time).not.toBe('20.02');
    expect(convertSwimToSCYDetailed('100 Backstroke', '56.44', MEN, 'SCM', { team: HSU }).time).not.toBe('51.13');
    expect(convertSwimToSCYDetailed('200 Freestyle', '2:12.23', MEN, 'SCM', { team: HSU }).time).not.toBe('1:59.80');
  });

  it('still trace to the SCM swims they came from', () => {
    const plan = planSwimCloudReplace(storedWorkspace(), { team: HSU, gender: MEN });
    const traced = plan.recruitsToRemove
      .filter(r => isKis(r.row))
      .map(r => [r.row.event, r.row.time, r.reason, r.tracedTo?.time, r.tracedTo?.timeType]);
    expect(traced).toStrictEqual([
      ['50 Freestyle', '20.02', 'traced_to_removed_swim', '22.10', 'SCM'],
      ['100 Freestyle', '44.33', 'traced_to_removed_swim', '50.78', 'LCM'],
      ['100 Backstroke', '51.13', 'traced_to_removed_swim', '56.44', 'SCM'],
      ['200 Freestyle', '1:59.80', 'traced_to_removed_swim', '2:12.23', 'SCM'],
    ]);
    expect(plan.plansToRemove.filter(r => isKis(r.row))).toHaveLength(3);
    expect(plan.keptUntraced).toStrictEqual({ recruits: [], plans: [] });
  });
});

describe('other teams and genders', () => {
  const OBU = 'Ouachita Baptist University';

  function mixedWorkspace() {
    const stored = storedWorkspace();
    const u = (stored.athleteHistory ?? []).find(h => isCapocci(h) && h.time === '56.98') as HistoricalSwim;
    const back = stored.recruits.find(r => isCapocci(r) && r.time === '48.15') as Recruit;
    const obuHistory: HistoricalSwim = { ...u, team: OBU };
    const womenHistory: HistoricalSwim = { ...u, gender: Gender.WOMEN };
    const obuRecruit: Recruit = { ...back, id: 'rec-obu', team: OBU };
    const womenRecruit: Recruit = { ...back, id: 'rec-women', gender: Gender.WOMEN };
    const womenPlan: PlannedSwimEntry = { ...CAPOCCI_MANUAL_100_BACK, id: 'plan-women', gender: Gender.WOMEN, source: 'swimcloud' };
    const obuPlan: PlannedSwimEntry = { ...CAPOCCI_MANUAL_100_BACK, id: 'plan-obu', team: OBU, source: 'swimcloud' };
    const ws = storedWorkspace({
      history: [obuHistory, womenHistory],
      recruits: [obuRecruit, womenRecruit],
      plans: [womenPlan, obuPlan],
    });
    return { ws, foreign: { obuHistory, womenHistory, obuRecruit, womenRecruit, womenPlan, obuPlan } };
  }

  it('plans nothing outside the team and gender', () => {
    const { ws, foreign } = mixedWorkspace();
    const plan = planSwimCloudReplace(ws, { team: HSU, gender: MEN });
    expect(plan.historyToRemove).not.toContainEqual(foreign.obuHistory);
    expect(plan.historyToRemove).not.toContainEqual(foreign.womenHistory);
    expect(plan.historyToRemove.every(h => h.team === HSU && h.gender === MEN)).toBe(true);
    expect(idsOf(plan.recruitsToRemove)).not.toContain('rec-obu');
    expect(idsOf(plan.recruitsToRemove)).not.toContain('rec-women');
    expect(idsOf(plan.plansToRemove)).toStrictEqual([
      ...SNAPSHOT.meetEntryPlans.map(p => p.id),
    ]);
  });

  it('a replace reimport keeps every foreign row as it was', () => {
    const { ws, foreign } = mixedWorkspace();
    const result = importHistoryToRoster(ws, pastedSwims(CAPOCCI_PASTE, NOEL_KIS_PASTE), {
      team: HSU,
      gender: MEN,
      mode: 'replace',
    });
    expect(result.patch.athleteHistory).toContainEqual(foreign.obuHistory);
    expect(result.patch.athleteHistory).toContainEqual(foreign.womenHistory);
    expect(result.patch.recruits).toContainEqual(foreign.obuRecruit);
    expect(result.patch.recruits).toContainEqual(foreign.womenRecruit);
    expect(result.patch.meetEntryPlans).toContainEqual(foreign.womenPlan);
    expect(result.patch.meetEntryPlans).toContainEqual(foreign.obuPlan);
  });

  it('matches the team on its trimmed name, as the import writes it', () => {
    const padded: Recruit = { ...storedRecruit('Fabio Capocci', '100 Backstroke'), id: 'rec-padded', team: `  ${HSU} ` };
    const plan = planSwimCloudReplace(storedWorkspace({ recruits: [padded] }), { team: ` ${HSU}`, gender: MEN });
    expect(plan.team).toBe(HSU);
    expect(idsOf(plan.recruitsToRemove)).toContain('rec-padded');
  });
});

describe('names are matched the way the import matches them', () => {
  it('traces "Last, First" history rows to "First Last" rows', () => {
    const ws = storedWorkspace();
    ws.athleteHistory = (ws.athleteHistory ?? []).map(h => (isCapocci(h) ? { ...h, name: 'Capocci, Fabio' } : h));
    const plan = planSwimCloudReplace(ws, { team: HSU, gender: MEN });
    expect(plan.recruitsToRemove.filter(r => isCapocci(r.row))).toHaveLength(4);
    expect(plan.plansToRemove.filter(r => isCapocci(r.row))).toHaveLength(4);
  });

  it('traces a linked spelling through the alias resolver, and only when linked', () => {
    const renamed = (ws: Workspace): Workspace => ({
      ...ws,
      athleteHistory: (ws.athleteHistory ?? []).map(h => (isCapocci(h) ? { ...h, name: 'Fabinho Capocci' } : h)),
    });
    const unlinked = renamed(storedWorkspace());
    const unlinkedPlan = planSwimCloudReplace(unlinked, { team: HSU, gender: MEN });
    expect(unlinkedPlan.recruitsToRemove.filter(r => isCapocci(r.row))).toHaveLength(0);

    const linked = renamed(
      storedWorkspace({
        over: {
          athleteAliases: [
            {
              id: 'alias-capocci',
              gender: MEN,
              team: HSU,
              aliasName: 'Fabinho Capocci',
              canonicalName: 'Fabio Capocci',
              source: 'manual',
            },
          ],
        },
      })
    );
    const linkedPlan = planSwimCloudReplace(linked, { team: HSU, gender: MEN });
    expect(linkedPlan.recruitsToRemove.filter(r => isCapocci(r.row))).toHaveLength(4);
  });
});

describe('optimizer plans are removed only when traced', () => {
  it('keeps an edited plan and an NT plan as untraced, and a plan also backed by kept data as ambiguous', () => {
    // A coach edited one traced plan's time; another plan never had a time.
    const capocci100Free = storedPlan('Fabio Capocci', '100 Freestyle');
    const edited: PlannedSwimEntry = { ...capocci100Free, id: 'plan-edited', time: '45.89' };
    const nt: PlannedSwimEntry = { ...capocci100Free, id: 'plan-nt', event: '200 Backstroke', time: 'NT' };
    // Noel Kis's stored 50 Free 20.02 also appears as a kept PDF swim.
    const kisPdf: HistoricalSwim = {
      name: 'Noel Kis',
      team: HSU,
      gender: MEN,
      event: '50 Freestyle',
      time: '20.02',
      timeType: 'SCY',
      source: 'pdf',
    };
    const ws = storedWorkspace({ plans: [edited, nt], history: [kisPdf] });
    const plan = planSwimCloudReplace(ws, { team: HSU, gender: MEN });

    expect(idsOf(plan.plansToRemove)).not.toContain('plan-edited');
    expect(idsOf(plan.plansToRemove)).not.toContain('plan-nt');
    expect(plan.keptUntraced.plans.map(p => p.id)).toStrictEqual(['plan-edited', 'plan-nt']);

    const kis50 = storedPlan('Noel Kis', '50 Freestyle');
    expect(idsOf(plan.plansToRemove)).not.toContain(kis50.id);
    expect(plan.keptAmbiguous.plans.map(p => p.id)).toStrictEqual([kis50.id]);
    expect(plan.keptAmbiguous.recruits.map(r => [r.name, r.event, r.time])).toStrictEqual([
      ['Noel Kis', '50 Freestyle', '20.02'],
    ]);
  });

  it('treats a loaded-meet result and a kept recruit row as kept data too', () => {
    const kis100 = storedPlan('Noel Kis', '100 Freestyle');
    const capBack = storedPlan('Fabio Capocci', '100 Backstroke');
    const meetRow: SwimmerResult = {
      id: 'res-kis-100free',
      rank: 1,
      name: 'Noel Kis',
      classYear: 'FR',
      team: HSU,
      time: kis100.time,
      points: 20,
      event: 'Event 20 Men 100 Yard Freestyle',
      gender: MEN,
    } as SwimmerResult;
    const manualRecruit: Recruit = {
      ...storedRecruit('Fabio Capocci', '100 Backstroke'),
      id: 'rec-capocci-manual',
      source: 'manual',
    };
    const plan = planSwimCloudReplace(storedWorkspace({ menResults: [meetRow], recruits: [manualRecruit] }), {
      team: HSU,
      gender: MEN,
    });
    expect(plan.keptAmbiguous.plans.map(p => p.id).sort()).toStrictEqual([kis100.id, capBack.id].sort());
    expect(idsOf(plan.recruitsToRemove)).not.toContain('rec-capocci-manual');
  });

  it('never removes a manual or PDF plan, and always removes a swimcloud plan', () => {
    const traced = storedPlan('Fabio Capocci', '100 Backstroke');
    const manual: PlannedSwimEntry = { ...traced, id: 'plan-manual', source: 'manual' };
    const pdf: PlannedSwimEntry = { ...traced, id: 'plan-pdf', source: 'pdf' };
    const swimcloud: PlannedSwimEntry = { ...traced, id: 'plan-swimcloud', time: '1:00.00', source: 'swimcloud' };
    const plan = planSwimCloudReplace(storedWorkspace({ plans: [manual, pdf, swimcloud] }), { team: HSU, gender: MEN });
    const removed = idsOf(plan.plansToRemove);
    expect(removed).toContain(traced.id);
    expect(removed).not.toContain('plan-manual');
    expect(removed).not.toContain('plan-pdf');
    expect(plan.plansToRemove.find(r => r.row.id === 'plan-swimcloud')?.reason).toBe('swimcloud_source');
  });

  it('drops removed plans from activeEntryIds and keeps every other id in order', () => {
    const manual: PlannedSwimEntry = { ...storedPlan('Fabio Capocci', '100 Backstroke'), id: 'plan-manual', source: 'manual' };
    const ws = storedWorkspace({ plans: [manual] });
    ws.activeEntryIds = ['keep-a', ...(ws.activeEntryIds ?? []), 'plan-manual', 'keep-b'];
    const patch = applySwimCloudReplacePlan(ws, planSwimCloudReplace(ws, { team: HSU, gender: MEN }));
    expect(patch.activeEntryIds).toStrictEqual(['keep-a', 'plan-manual', 'keep-b']);
    expect(patch.meetEntryPlans).toStrictEqual([manual]);
  });
});

describe('recruit rows with a recorded source', () => {
  it('are judged by the source, never by tracing', () => {
    const base = storedRecruit('Fabio Capocci', '100 Backstroke');
    const rows: Recruit[] = [
      { ...base, id: 'src-paste', time: '1:00.00', source: 'paste' },
      { ...base, id: 'src-swimcloud', time: '1:00.00', source: 'swimcloud' },
      { ...base, id: 'src-manual', source: 'manual' },
      { ...base, id: 'src-csv', source: 'csv' },
      { ...base, id: 'src-pdf', source: 'pdf' },
    ];
    const plan = planSwimCloudReplace(storedWorkspace({ recruits: rows }), { team: HSU, gender: MEN });
    const reasonOf = (id: string) => plan.recruitsToRemove.find(r => r.row.id === id)?.reason;
    expect(reasonOf('src-paste')).toBe('swimcloud_source');
    expect(reasonOf('src-swimcloud')).toBe('swimcloud_source');
    for (const id of ['src-manual', 'src-csv', 'src-pdf']) expect(reasonOf(id)).toBeUndefined();
    expect(plan.keptAmbiguous.recruits.map(r => r.id)).toStrictEqual([]);
  });

  it('a source-less row traces through convertedFrom when the table has changed since', () => {
    const scm = convertSwimToSCYDetailed('100 Backstroke', '56.44', MEN, 'SCM', { team: HSU });
    // A yards time no table in this repo produces from 56.44, standing for a
    // conversion made under a table that has since changed.
    const scyTime = '50.99';
    const convertedFrom = { sourceCourse: 'SCM' as const, sourceEvent: '100 Back SCM', sourceTime: '56.44', scyTime, basis: scm.basis };
    const kept: Recruit = { ...storedRecruit('Noel Kis', '100 Backstroke'), id: 'rec-cf', time: scyTime, convertedFrom };
    const edited: Recruit = { ...kept, id: 'rec-cf-edited', time: '50.98' };
    const plan = planSwimCloudReplace(storedWorkspace({ recruits: [kept, edited] }), { team: HSU, gender: MEN });
    expect(plan.recruitsToRemove.find(r => r.row.id === 'rec-cf')?.tracedTo).toMatchObject({ time: '56.44' });
    expect(idsOf(plan.recruitsToRemove)).not.toContain('rec-cf-edited');
    expect(plan.keptUntraced.recruits.map(r => r.id)).toStrictEqual(['rec-cf-edited']);
  });
});

describe('replace safety', () => {
  it('an empty import removes nothing', () => {
    const result = importHistoryToRoster(storedWorkspace(), [], { team: HSU, gender: MEN, mode: 'replace' });
    expect(result).toStrictEqual({
      noop: true,
      patch: {},
      summary: { swimsMerged: 0, newRecruits: 0, lineupEntriesAdded: 0, swimmers: [] },
    });
  });

  it('refuses an import with no swim for the team or the gender', () => {
    const obu = parseSwimCloudPasteDetailed(CAPOCCI_PASTE, { team: 'Ouachita Baptist University', gender: MEN }).swims;
    expect(() => importHistoryToRoster(storedWorkspace(), obu, { team: HSU, gender: MEN, mode: 'replace' })).toThrow(
      SwimCloudReplaceRefusedError
    );
    const women = parseSwimCloudPasteDetailed(CAPOCCI_PASTE, { team: HSU, gender: Gender.WOMEN }).swims;
    expect(() => importHistoryToRoster(storedWorkspace(), women, { team: HSU, gender: MEN, mode: 'replace' })).toThrow(
      /no swim for Henderson State University \(Men\)/
    );
  });

  it('refuses to apply a plan to another copy of the workspace', () => {
    const ws = storedWorkspace();
    const plan = planSwimCloudReplace(ws, { team: HSU, gender: MEN });
    expect(() => applySwimCloudReplacePlan(structuredClone(ws), plan)).toThrow(/does not match this workspace/);
  });

  it('plans nothing for a blank team', () => {
    const plan = planSwimCloudReplace(storedWorkspace(), { team: '   ', gender: MEN });
    expect(plan.historyToRemove).toStrictEqual([]);
    expect(plan.recruitsToRemove).toStrictEqual([]);
    expect(plan.plansToRemove).toStrictEqual([]);
  });

  it('does not change the workspace it plans or imports from', () => {
    const ws = storedWorkspace({ plans: [CAPOCCI_MANUAL_100_BACK] });
    const before = structuredClone(ws);
    planSwimCloudReplace(ws, { team: HSU, gender: MEN });
    importHistoryToRoster(ws, pastedSwims(CAPOCCI_PASTE), { team: HSU, gender: MEN, mode: 'replace' });
    expect(ws).toStrictEqual(before);
  });

  it('names athletes who lose data and are not in the new capture', () => {
    const ws = storedWorkspace();
    const onlyCapocci = previewSwimCloudReplace(ws, pastedSwims(CAPOCCI_PASTE), { team: HSU, gender: MEN });
    expect(onlyCapocci.athletesAbsentFromIncoming).toStrictEqual(['Noel Kis']);
    const both = previewSwimCloudReplace(ws, pastedSwims(CAPOCCI_PASTE, NOEL_KIS_PASTE), { team: HSU, gender: MEN });
    expect(both.athletesAbsentFromIncoming).toStrictEqual([]);
    const commaSpelled = pastedSwims(CAPOCCI_PASTE, NOEL_KIS_PASTE.replace('Noel Kis', 'Kis, Noel'));
    expect(commaSpelled.some(s => s.name === 'Kis, Noel')).toBe(true);
    expect(previewSwimCloudReplace(ws, commaSpelled, { team: HSU, gender: MEN }).athletesAbsentFromIncoming).toStrictEqual([]);
    const result = importHistoryToRoster(ws, pastedSwims(CAPOCCI_PASTE), { team: HSU, gender: MEN, mode: 'replace' });
    expect(result.replaced?.athletesAbsentFromIncoming).toStrictEqual(['Noel Kis']);
  });

  it('counts a name the import would match by containment as present', () => {
    // matchAthleteToRoster matches "Noel Kis Jr" to "Noel Kis" at its containment
    // tier, so the import would put this capture on him. No alias key matches.
    const suffixed = pastedSwims(CAPOCCI_PASTE, NOEL_KIS_PASTE.replace('Noel Kis', 'Noel Kis Jr'));
    expect(new Set(suffixed.map(s => s.name))).toStrictEqual(new Set(['Fabio Capocci', 'Noel Kis Jr']));
    const preview = previewSwimCloudReplace(storedWorkspace(), suffixed, { team: HSU, gender: MEN });
    expect(preview.athletesAbsentFromIncoming).toStrictEqual([]);
  });

  it('lists relay-leg overrides that named a removed recruit row, and leaves them in place', () => {
    const back = SNAPSHOT.recruits.find(r => isCapocci(r) && r.time === '48.15') as Recruit;
    const override = { relayEntryKey: 'relay-key', legIndex: 0, assigneeName: 'Fabio Capocci', recruitId: back.id };
    const ws = storedWorkspace({ over: { relayLegOverrides: [override] } });
    expect(planSwimCloudReplace(ws, { team: HSU, gender: MEN }).relayOverridesLosingRecruit).toStrictEqual([override]);
    const result = importHistoryToRoster(ws, pastedSwims(CAPOCCI_PASTE), { team: HSU, gender: MEN, mode: 'replace' });
    expect(result.patch).not.toHaveProperty('relayLegOverrides');
  });
});
