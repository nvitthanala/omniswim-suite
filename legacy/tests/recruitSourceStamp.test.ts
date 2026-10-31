/**
 * E7 (2026-10-16): every recruit row an import writes carries a `source`.
 *
 * `Recruit.source` absent means "origin unknown", and opponent scouting leaves
 * an unknown-origin row out (`unknown_source`). So a writer that forgets the
 * field hides its own rows. `appendRecruitRow` used to spread `source` only
 * when the swim had one. It now stamps it from the swim, and raises when the
 * swim has none, so the parser that built the swim is the thing that gets fixed.
 *
 * One test per import path, each through the real parser of that path:
 *  - SwimCloud import: `swimCloudSwimmerTimesToHistoricalSwims`  → 'swimcloud'
 *  - paste import:      `parseSwimCloudPasteDetailed`             → 'paste'
 *  - roster wizard CSV: `parseCsvHistory`                         → 'csv'
 *  - roster wizard SwimCloud paste: same parser as the paste import
 *  - manual add:        `withManualSource`                        → 'manual'
 *
 * Legacy rows (written before 2026-09-25) stay unstamped; nothing here, or in
 * the importer, backfills them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClassYear, Gender, type HistoricalSwim, type Recruit, type Workspace } from '../../packages/core/src/types';
import { importHistoryToRoster } from '../../packages/core/src/lib/historyImportRoster';
import { parseSwimCloudPasteDetailed } from '../../packages/core/src/lib/athleteHistory';
import { parseCsvHistory } from '../../packages/core/src/lib/csvImport';
import { NSISC_PRESET_SETTINGS } from '../../packages/core/src/lib/scoringDefaults';
import { parseSwimmerFastestTimesJson } from '@omniswim/swimcloud/swimmerFastestTimes';
import { swimCloudSwimmerTimesToHistoricalSwims } from '@omniswim/manager/lib/swimCloudImportBridge';
import { withManualSource } from '@omniswim/manager/lib/swimCloudReplaceFlow';
import { unknownSourceRowIds } from '../packages/manager/src/components/scoutOpponentView';

const HSU = 'Henderson State University';
const repoRoot = join(__dirname, '../..');

function workspaceWith(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-recruit-source',
    name: 'Recruit source',
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

function recruitsFrom(swims: HistoricalSwim[], sourceType?: string): Recruit[] {
  const result = importHistoryToRoster(workspaceWith(), swims, {
    team: HSU,
    gender: Gender.MEN,
    ...(sourceType === undefined ? {} : { sourceType }),
  });
  return result.patch.recruits ?? [];
}

describe('every import path stamps the recruit rows it writes', () => {
  it('SwimCloud import writes source: swimcloud', () => {
    const raw = readFileSync(join(repoRoot, 'tests', 'fixtures', 'profile_fastest_times-1330318.json'), 'utf8');
    const parsed = parseSwimmerFastestTimesJson(raw, {
      sourceUrl: 'https://www.swimcloud.com/api/swimmers/1330318/profile_fastest_times/',
      retrievedAt: '2026-09-22T12:00:00.000Z',
      track: 'browser-extension',
    });
    if (!parsed.ok) throw new Error(parsed.failure.message);
    const conversion = swimCloudSwimmerTimesToHistoricalSwims(
      { ...parsed.data, name: 'Pat Example' },
      { team: HSU, gender: Gender.MEN }
    );
    if (!conversion.ok) throw new Error(conversion.message);
    const recruits = recruitsFrom([...conversion.swims]);
    expect(recruits.length).toBeGreaterThan(0);
    expect(recruits.map(r => r.source)).toEqual(recruits.map(() => 'swimcloud'));
  });

  it('paste import writes source: paste', () => {
    const parsed = parseSwimCloudPasteDetailed(
      'Test Swimmer\nEvent\tTime\t\tMeet\tDate\tStamp Link\n100 Free SCY\t50.00\t\tTest Meet\tFeb 20, 2026\t',
      { team: HSU, gender: Gender.MEN, swimmerName: 'Test Swimmer', format: 'personal_bests' }
    );
    expect(parsed.swims).toHaveLength(1);
    const recruits = recruitsFrom(parsed.swims, 'paste');
    expect(recruits).toHaveLength(1);
    expect(recruits[0]!.source).toBe('paste');
  });

  it('roster wizard CSV writes source: csv', () => {
    const parsed = parseCsvHistory('name,event,time\nCsv Swimmer,100 Freestyle,49.50\n', { team: HSU, gender: Gender.MEN });
    expect(parsed.swims).toHaveLength(1);
    const recruits = recruitsFrom(parsed.swims, 'csv_import');
    expect(recruits).toHaveLength(1);
    expect(recruits[0]!.source).toBe('csv');
  });

  it('roster wizard SwimCloud paste writes source: paste', () => {
    const parsed = parseSwimCloudPasteDetailed(
      'Wizard Swimmer\nEvent\tTime\t\tMeet\tDate\tStamp Link\n200 Free SCY\t1:45.00\t\tTest Meet\tFeb 20, 2026\t',
      { team: HSU, gender: Gender.MEN, swimmerName: 'Wizard Swimmer', format: 'personal_bests' }
    );
    const recruits = recruitsFrom(parsed.swims, 'swimcloud_paste');
    expect(recruits).toHaveLength(1);
    expect(recruits[0]!.source).toBe('paste');
  });

  it('a manual add is stamped manual, and an already-stamped row keeps its source', () => {
    const typed: Recruit = {
      id: 'r1',
      name: 'Typed By Hand',
      team: HSU,
      event: '100 Freestyle',
      time: '50.00',
      gender: Gender.MEN,
      classYear: ClassYear.FR,
      timeType: 'SCY',
    };
    expect(withManualSource(typed).source).toBe('manual');
    expect(withManualSource({ ...typed, source: 'paste' }).source).toBe('paste');
  });
});

describe('a swim with no source is a defect, not an unstamped row', () => {
  const sourceless = {
    name: 'No Origin',
    team: HSU,
    gender: Gender.MEN,
    event: '100 Freestyle',
    time: '50.00',
  } as unknown as HistoricalSwim;

  it('raises and names the swim', () => {
    expect(() => recruitsFrom([sourceless])).toThrow(/no source/);
    expect(() => recruitsFrom([sourceless])).toThrow(/No Origin/);
  });

  it('leaves the workspace untouched when it raises', () => {
    const ws = workspaceWith();
    expect(() => importHistoryToRoster(ws, [sourceless], { team: HSU, gender: Gender.MEN })).toThrow();
    expect(ws.recruits).toEqual([]);
  });
});

describe('scouting reads a stamped row and still leaves a legacy row out', () => {
  it('lists only the unstamped recruit rows as unknown-source', () => {
    const stamped = recruitsFrom(
      parseCsvHistory('name,event,time\nStamped One,100 Freestyle,49.50\n', { team: HSU, gender: Gender.MEN }).swims,
      'csv_import'
    );
    const legacy: Recruit = { ...stamped[0]!, id: 'legacy-1', name: 'Legacy Row' };
    delete (legacy as { source?: unknown }).source;
    expect([...unknownSourceRowIds({ recruits: [...stamped, legacy] }, Gender.MEN, HSU)]).toEqual(['legacy-1']);
  });
});
