/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A converted time stays marked as an estimate (plans/2026-09-22/01, P1b).
 *
 * ## The defect
 *
 * `importHistoryToRoster` restates each metric (LCM/SCM) swim in SCY and writes
 * the recruit row or planned entry with `timeType: 'SCY'`. That is right for
 * scoring: the row's time is in yards. But nothing else survived, so a recruit
 * built from a `100 Back LCM 56.28` read downstream as a real `100 Back SCY
 * 47.56`. Every cut-tag reader then judged it as a yards swim and badged it
 * `D2 B CUT` — a cut the NCAA says only a yards swim can earn.
 *
 * ## The fix
 *
 * The row keeps `timeType: 'SCY'` and its converted time (no score changes) and
 * gains `convertedFrom: ScyConversionProvenance` — the recorded course, event,
 * time and conversion basis. `cutlineSwimOfRecord(row)` hands a cut-tag builder
 * the metric swim, so the best such a row can reach is `converted_estimate`.
 *
 * Every case here uses real SwimCloud captures: swimmer 1330318 (the brief's
 * fixture) and swimmer 1401610, whose `100 Back LCM 56.28` converts to a time
 * under the D2 men's B standard and so separates the old reading from the new.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSwimmerFastestTimesJson } from '@omniswim/swimcloud';
import { swimCloudSwimmerTimesToHistoricalSwims } from '@omniswim/manager/lib/swimCloudImportBridge';
import { buildTeamRowCutlineTags } from '../packages/matrix/src/components/teamCardView';
import { ClassYear, Gender, type HistoricalSwim, type PlannedSwimEntry, type Recruit, type Workspace } from '../packages/core/src/types';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import {
  buildCutlineTagForTeam,
  convertedSwimOfRecord,
  cutlineSwimOfRecord,
  isCutlineTagConclusive,
} from '../packages/core/src/lib/cutlineTags';
import { buildWhatIfResults, planToResult } from '../packages/core/src/lib/whatIfProjection';
import { buildTeamLineupAudit } from '../packages/core/src/lib/rosterLineupAudit';
import { categorizeBestEvents } from '../packages/core/src/lib/athleteHistory';
import { updatePlannedEntry } from '../packages/core/src/lib/swimEditor';
import { applyScoringTheory } from '../packages/core/src/lib/scoringTheory';
import { buildCrossCourseTable } from '../packages/core/src/lib/crossCourseArbitrage';
import { effectiveBestIndex } from '../packages/core/src/lib/arbitrage/shared';
import { applyEntryAdd } from '../packages/core/src/lib/arbitrage/dropAdd';
import { buildStoredSwim } from '../packages/core/src/lib/rosterCatalog';
import { getAthleteCreditedSwims } from '../packages/core/src/lib/scorerRoster';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
/** The primary workspace. `Henderson State` is a registered alias of HSU (D2). */
const HSU = 'Henderson State';
const NAME = 'Fixture Swimmer';

function fixtureSwims(swimmerId: string, file: string): HistoricalSwim[] {
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

const paulk = () => fixtureSwims('1330318', 'profile_fastest_times-1330318.json');
const casey = () => fixtureSwims('1401610', 'profile_fastest_times-1401610-altitude.json');
const metricOnly = (swims: HistoricalSwim[]) => swims.filter((s) => (s.timeType ?? 'SCY') !== 'SCY');

function workspaceWith(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-provenance',
    name: 'Provenance',
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

function recruitsFrom(swims: HistoricalSwim[]): Recruit[] {
  const result = importHistoryToRoster(workspaceWith(), swims, { team: HSU, gender: Gender.MEN });
  return result.patch.recruits ?? [];
}

/** The cut tag every reader built before 2026-09-22: the row's own event and time. */
const naiveTag = (row: { event: string; time: string }) =>
  buildCutlineTagForTeam({ team: HSU, gender: Gender.MEN, event: row.event, time: row.time });

const recordTag = (row: Parameters<typeof cutlineSwimOfRecord>[0]) =>
  buildCutlineTagForTeam({ team: HSU, gender: Gender.MEN, ...cutlineSwimOfRecord(row) });

describe('recruit rows built from metric swims say so (swimmer 1330318)', () => {
  const recruits = recruitsFrom(metricOnly(paulk()));

  it('writes one recruit row per event, every one carrying its recorded swim', () => {
    expect(recruits.length).toBeGreaterThan(0);
    for (const r of recruits) {
      expect(r.timeType, r.event).toBe('SCY');
      expect(r.convertedFrom, r.event).toBeDefined();
      expect(r.convertedFrom!.sourceCourse).toBe('LCM');
      expect(r.convertedFrom!.scyTime).toBe(r.time);
      expect(r.convertedFrom!.basis.method).toBe('lcm_factor_table');
    }
  });

  it('records the fixture swim exactly: 50 Free LCM 24.20 -> 21.05', () => {
    const fifty = recruits.find((r) => r.event === '50 Free SCY');
    // The time that scores is unchanged by this fix.
    expect(fifty?.time).toBe('21.05');
    expect(fifty?.convertedFrom).toMatchObject({
      sourceCourse: 'LCM',
      sourceEvent: '50 Free LCM',
      sourceTime: '24.20',
      scyTime: '21.05',
      basis: { method: 'lcm_factor_table', factorEvent: '50 Freestyle' },
    });
  });

  it('hands the cut-tag builder the LCM swim, never the yards estimate', () => {
    const fifty = recruits.find((r) => r.event === '50 Free SCY')!;
    expect(cutlineSwimOfRecord(fifty)).toStrictEqual({
      event: '50 Free LCM',
      time: '24.20',
      swimCourse: 'LCM',
    });
    for (const r of recruits) {
      const tag = recordTag(r);
      expect(tag.swimCourse, r.event).toBe('LCM');
      expect(tag.state, r.event).not.toBe('tagged');
    }
  });

  it('leaves a row built from a real yards swim unmarked, and still badged', () => {
    // The full capture: every program event has an SCY swim, and here each one
    // is the fastest. Paulk's 100 Breast SCY 54.09 is a real D2 B cut.
    const full = recruitsFrom(paulk());
    expect(full.filter((r) => r.convertedFrom)).toStrictEqual([]);
    const breast = full.find((r) => r.event === '100 Breast SCY')!;
    expect(cutlineSwimOfRecord(breast)).toStrictEqual({
      event: '100 Breast SCY',
      time: '54.09',
      swimCourse: 'SCY',
    });
    expect(recordTag(breast)).toMatchObject({ state: 'tagged', tag: { label: 'D2 B CUT' } });
  });
});

describe('a converted recruit reads as an estimate, not a cut (swimmer 1401610)', () => {
  const recruits = recruitsFrom(metricOnly(casey()));
  const back = recruits.find((r) => r.event === '100 Back SCY')!;

  it('is the swim the old reading badged as a real cut', () => {
    expect(back.time).toBe('47.56');
    expect(back.convertedFrom).toMatchObject({ sourceEvent: '100 Back LCM', sourceTime: '56.28' });
    // The regression this file exists for: read as a yards swim, 47.56 clears
    // the D2 men's B standard and earns a badge nobody swam for.
    expect(naiveTag(back)).toMatchObject({ state: 'tagged', tag: { label: 'D2 B CUT' } });
  });

  it('yields converted_estimate through cutlineSwimOfRecord', () => {
    const tag = recordTag(back);
    expect(tag.state).toBe('converted_estimate');
    expect(tag.tag).toBeNull();
    expect(isCutlineTagConclusive(tag)).toBe(false);
    if (tag.state !== 'converted_estimate') throw new Error('unreachable');
    expect(tag.indicative).toMatchObject({
      label: 'D2 B CUT (CONVERTED)',
      recordedTime: '56.28',
      convertedTime: '47.56',
      swimCourse: 'LCM',
    });
  });

  const workspace = workspaceWith({ recruits });
  const rows = buildWhatIfResults({ workspace, gender: Gender.MEN, removeSeniors: false });
  const projected = rows.find((r) => r.event === '100 Back SCY')!;

  it('keeps the mark on the projected scoring row, at the same time', () => {
    expect(projected.time).toBe('47.56');
    expect(projected.convertedFrom).toStrictEqual(back.convertedFrom);
  });

  it('scores exactly as it did before the mark existed', () => {
    const unmarked = workspaceWith({
      recruits: recruits.map(({ convertedFrom: _drop, ...rest }) => rest),
    });
    const before = buildWhatIfResults({ workspace: unmarked, gender: Gender.MEN, removeSeniors: false });
    expect(rows.map((r) => [r.event, r.time])).toStrictEqual(before.map((r) => [r.event, r.time]));
  });

  it('reaches the team card as indicative, not a cut badge', () => {
    const view = buildTeamRowCutlineTags(projected, Gender.MEN, HSU, projected.time);
    expect(view.kind).toBe('single');
    if (view.kind !== 'single') throw new Error('unreachable');
    expect(view.result.state).toBe('converted_estimate');
  });

  it('reaches the credited-swims row with its mark', () => {
    const credited = getAthleteCreditedSwims(rows, HSU, NAME, Gender.MEN);
    const swim = credited.find((s) => s.event === '100 Back SCY')!;
    expect(swim.convertedFrom).toStrictEqual(back.convertedFrom);
    expect(recordTag(swim).state).toBe('converted_estimate');
  });

  it('is flagged by the lineup audit as resting on a converted estimate', () => {
    // Before the fix the audit read the row's SCY label and never saw it.
    const audit = buildTeamLineupAudit({
      workspace,
      gender: Gender.MEN,
      team: HSU,
      settings: NSISC_PRESET_SETTINGS,
      allResults: rows,
      allScored: rows,
      removeSeniors: false,
      detectDuplicates: false,
    });
    const flagged = audit.checklistItems.filter((i) => i.type === 'conversion_estimate');
    expect(flagged.map((i) => i.message)).toContainEqual(
      expect.stringContaining('56.28 LCM → 47.56 converted')
    );
  });
});

describe('planned entries carry the mark too', () => {
  it('marks the lineup entries an import adds for a rostered athlete', () => {
    // The swimmer holds one meet swim, so the import adds lineup entries rather
    // than recruit rows. A second team's row puts the 100 Back in the program.
    const meetRow = (id: string, name: string, team: string, event: string, time: string) => ({
      id,
      rank: 1,
      name,
      classYear: 'FR',
      team,
      time,
      points: 0,
      event,
      gender: Gender.MEN,
    });
    const onRoster = workspaceWith({
      menResults: [
        meetRow('meet-1', NAME, HSU, '200 Freestyle', '1:40.00'),
        meetRow('meet-2', 'Other Swimmer', 'University of Pittsburgh', '100 Backstroke', '48.00'),
      ],
    });
    const result = importHistoryToRoster(onRoster, metricOnly(casey()), { team: HSU, gender: Gender.MEN });
    const plans = result.patch.meetEntryPlans ?? [];
    const back = plans.find((p) => p.event === '100 Back SCY');
    expect(back?.convertedFrom).toMatchObject({ sourceEvent: '100 Back LCM', sourceTime: '56.28' });
    expect(back?.timeType).toBe('SCY');
    expect(planToResult(back!).convertedFrom).toStrictEqual(back!.convertedFrom);
    expect(recordTag(back!).state).toBe('converted_estimate');
  });

  it('marks a plan that stores the recorded metric time and converts on read', () => {
    // The athlete-drawer paste path stores the LCM time as recorded.
    const plan: PlannedSwimEntry = {
      id: 'p-lcm',
      name: NAME,
      team: HSU,
      gender: Gender.MEN,
      event: '100 Back LCM',
      time: '56.28',
      timeType: 'LCM',
      source: 'swimcloud',
    };
    const row = planToResult(plan);
    expect(row.time).toBe('47.56');
    expect(row.convertedFrom).toMatchObject({ sourceCourse: 'LCM', sourceTime: '56.28', scyTime: '47.56' });
    expect(cutlineSwimOfRecord(plan)).toStrictEqual({ event: '100 Back LCM', time: '56.28', swimCourse: 'LCM' });
  });

  it('drops the mark when a coach edits the time', () => {
    const plan: PlannedSwimEntry = {
      id: 'p-1',
      name: NAME,
      team: HSU,
      gender: Gender.MEN,
      event: '100 Back SCY',
      time: '47.56',
      timeType: 'SCY',
      source: 'swimcloud',
      convertedFrom: recruitsFrom(metricOnly(casey())).find((r) => r.event === '100 Back SCY')!
        .convertedFrom,
    };
    const edited = updatePlannedEntry(workspaceWith({ meetEntryPlans: [plan] }), 'p-1', { time: '47.00' })
      .patch.meetEntryPlans![0];
    expect(edited.time).toBe('47.00');
    expect(edited.convertedFrom).toBeUndefined();
    // Toggling active is not a restatement; the mark stays.
    const toggled = updatePlannedEntry(workspaceWith({ meetEntryPlans: [plan] }), 'p-1', { active: false })
      .patch.meetEntryPlans![0];
    expect(toggled.convertedFrom).toStrictEqual(plan.convertedFrom);
  });

  it('ignores a mark that no longer matches the row time', () => {
    const stale = { event: '100 Back SCY', time: '47.00', convertedFrom: planWithMark().convertedFrom };
    expect(convertedSwimOfRecord(stale)).toBeNull();
    expect(cutlineSwimOfRecord(stale)).toStrictEqual({ event: '100 Back SCY', time: '47.00' });
  });

  function planWithMark(): Recruit {
    return recruitsFrom(metricOnly(casey())).find((r) => r.event === '100 Back SCY')!;
  }

  it('marks a scoring-theory plan built from a converted history best', () => {
    const history: HistoricalSwim[] = [
      {
        name: NAME,
        team: HSU,
        gender: Gender.MEN,
        event: '100 Backstroke',
        time: '56.28',
        timeType: 'LCM',
        source: 'swimcloud',
      },
    ];
    const result = applyScoringTheory(
      workspaceWith({ athleteHistory: history }),
      { relays: [], swimmers: [{ rawName: NAME, events: ['100 Backstroke'] }], others: [], warnings: [] },
      { team: HSU, gender: Gender.MEN }
    );
    const plan = (result.patch.meetEntryPlans ?? []).find((p) => p.event === '100 Backstroke');
    expect(plan?.time).toBe('47.56');
    expect(plan?.convertedFrom).toMatchObject({ sourceCourse: 'LCM', sourceTime: '56.28' });
  });

  it('marks the best a profile holds, so optimizer plans inherit it', () => {
    const profile = categorizeBestEvents(metricOnly(casey()), HSU, Gender.MEN, NAME, NSISC_PRESET_SETTINGS);
    expect(profile.bestByEvent['100 Back SCY']?.convertedFrom).toMatchObject({ sourceTime: '56.28' });
  });

  it('marks a cross-course open-slot add when it is applied', () => {
    const workspace = workspaceWith({ athleteHistory: metricOnly(casey()) });
    const table = buildCrossCourseTable(workspace, { team: HSU, gender: Gender.MEN });
    const best = effectiveBestIndex(table).get('fixture swimmer')?.get('100 Backstroke');
    expect(best?.convertedFrom).toMatchObject({ sourceEvent: '100 Back LCM', sourceTime: '56.28', scyTime: '47.56' });
    const { patch } = applyEntryAdd(
      workspace,
      {
        athlete: NAME,
        addEvent: '100 Backstroke',
        addTime: best!.time,
        addTimeConverted: true,
        addTimeConvertedFrom: best!.convertedFrom,
        deltaPoints: 1,
        newTotal: 1,
        baseTotal: 0,
      },
      { team: HSU, gender: Gender.MEN }
    );
    const plan = patch.meetEntryPlans!.at(-1)!;
    expect(plan.convertedFrom).toStrictEqual(best!.convertedFrom);
    expect(recordTag(plan).state).toBe('converted_estimate');
  });
});

describe('the roster catalog never badges a converted time', () => {
  it('gives an LCM time no computedCut, and a yards time its real one', () => {
    const lcm = buildStoredSwim({
      athleteId: 'a1',
      event: '100 Back',
      timeText: '56.28',
      timeType: 'LCM',
      source: 'json',
      gender: Gender.MEN,
      division: 'D2',
    });
    // 56.28 LCM converts to 47.56, under the D2 men's B standard. Before the
    // fix this stamped 'B'.
    expect(lcm.timeSecondsScy).toBe(47.56);
    expect(lcm.computedCut).toBeNull();
    const scy = buildStoredSwim({
      athleteId: 'a1',
      event: '100 Breast',
      timeText: '54.09',
      timeType: 'SCY',
      source: 'json',
      gender: Gender.MEN,
      division: 'D2',
    });
    expect(scy.computedCut).toBe('B');
  });

  it('keeps ClassYear-typed recruit rows valid with the new optional fields', () => {
    const r: Recruit = {
      id: 'r',
      name: NAME,
      team: HSU,
      event: '50 Free SCY',
      time: '21.05',
      gender: Gender.MEN,
      classYear: ClassYear.HS,
      timeType: 'SCY',
    };
    expect(cutlineSwimOfRecord(r)).toStrictEqual({ event: '50 Free SCY', time: '21.05', swimCourse: 'SCY' });
  });
});
