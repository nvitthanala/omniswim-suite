/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Theoretical meet relays (C2 Task 1): relay entries built from individual bests, labelled estimates.
 * Design: docs/reference/THEORETICAL_MEET_PLAN.md, "Relays from individual bests".
 *
 * ## Fixtures and their provenance
 *
 * - The relay PROGRAM is pinned to the real 2026 NSISC results: `tests/fixtures/nsisc-2026-relay-followups-r1.json`
 *   (men, Events 2, 11, 20, 31, 42). The women's events are read from the git-ignored `data/meets.json` when it
 *   is on this machine (the test skips otherwise).
 * - The hand-computed scenarios use CONSTRUCTED swims (a name, a team, an event and a time), because no real
 *   capture has the exact times a hand calculation needs. They are marked CONSTRUCTED where used. No
 *   competition standard is typed in except the published NCAA place table, copied from
 *   `packages/core/src/constants.ts` (`SCORING_POINTS`) as an independent check of the engine's output.
 * - The invariant tests run over the committed, trimmed real captures (`tests/fixtures/theoretical-meet/`).
 *
 * ## What is asserted (the gate for each claim)
 *
 * - With the flying-start setting OFF the relay total is the exact sum of four flat-start bests, and the relay
 *   is tagged estimated.
 * - A team total through the existing scoring path equals a hand sum: individual places from the NCAA table,
 *   plus relay places x relayMultiplier (2).
 * - Relays take entry capacity first: a relay pushes an individual event out, and nobody exceeds a cap.
 * - A swimmer is on a relay once. A team without four eligible swimmers gets no entry and a stated reason.
 * - Relays off: the output is byte-identical to a build that never knew about relays.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Gender } from '../packages/core/src/types';
import type { HistoricalSwim, SwimmerResult, Workspace } from '../packages/core/src/types';
import type { SwimCloudAthlete } from '../packages/swimcloud/src/entities';
import { NSISC_PRESET_SETTINGS, GENERIC_TOP16_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine';
import { parseRelayDistanceYards, relayKind } from '../packages/core/src/lib/relaySplits';
import { SCORING_POINTS } from '../packages/core/src/constants';
import {
  NSISC_RELAY_PROGRAM,
  RELAYS_ESTIMATED_CAVEAT,
  RELAYS_EXCLUDED_CAVEAT,
  RELAYS_NO_PROGRAM_CAVEAT,
  RELAY_CAP_CAVEAT,
  TOTAL_CAP_CAVEAT,
  relayLimitCaveat,
  TheoreticalMeetError,
  buildTheoreticalMeetSeeds,
  theoreticalRelayProgram,
  type TheoreticalMeetInput,
  type TheoreticalMeetSeeds,
  type TheoreticalMeetTeamInput,
  type TheoreticalProjectedRelay,
} from '../packages/manager/src/lib/theoreticalMeetSeeds';
import {
  buildTheoreticalMeetWorkspace,
  isEstimatedRelayRow,
  type TheoreticalMeetWorkspaceBuild,
} from '../packages/manager/src/lib/theoreticalMeetWorkspace';
import { buildMeet, readTeamCapture } from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetFlow';
import { describeAbsentRelay } from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetView';
import { CAPTURE_IDS, fakeCaptureApi, fixtureRecords } from './theoreticalMeetUiFixtures';

/* -------------------------------------------------------------------------- */
/* CONSTRUCTED inputs                                                          */
/* -------------------------------------------------------------------------- */

const swim = (name: string, team: string, event: string, time: string, extra: Partial<HistoricalSwim> = {}): HistoricalSwim => ({
  name,
  team,
  gender: Gender.MEN,
  event,
  time,
  timeType: 'SCY',
  source: 'swimcloud',
  ...extra,
});

const athlete = (name: string, id: string): SwimCloudAthlete => ({ name, swimCloudSwimmerId: id, classYear: 'JR', gender: 'Men' });

/** One team from `{ swimmer name: [[event, time], ...] }`. Ids are made from the name. */
function team(
  teamName: string,
  swimmers: Record<string, ReadonlyArray<readonly [string, string, Partial<HistoricalSwim>?]>>,
  gender: Gender = Gender.MEN
): TheoreticalMeetTeamInput {
  return {
    teamName,
    gender,
    rosterStatus: 'parsed',
    athletes: Object.entries(swimmers).map(([name, swims]) => ({
      athlete: { ...athlete(name, `${teamName}:${gender}:${name}`), gender: gender === Gender.MEN ? 'Men' : 'Women' },
      swims: swims.map(([event, time, extra]) => swim(name, teamName, event, time, { gender, ...extra })),
    })),
  };
}

const meet = (teams: TheoreticalMeetTeamInput[], over: Partial<TheoreticalMeetInput> = {}): TheoreticalMeetInput => ({
  meetId: 'ws-relay',
  course: 'SCY',
  scoringSettings: NSISC_PRESET_SETTINGS,
  conference: 'NSISC',
  includeRelays: true,
  teams,
  ...over,
});

const build = (teams: TheoreticalMeetTeamInput[], over: Partial<TheoreticalMeetInput> = {}): TheoreticalMeetSeeds => buildTheoreticalMeetSeeds(meet(teams, over));

const relayOf = (seeds: TheoreticalMeetSeeds, teamName: string, event: string): TheoreticalProjectedRelay | undefined =>
  seeds.relayEntries.find(r => r.team === teamName && r.event === event);

/** CONSTRUCTED: three teams of four, each swimmer with ONLY a 50 Free. Only the 200 Free Relay can be built. */
const FREE50: Record<string, Record<string, string>> = {
  'Alpha University': { A1: '20.00', A2: '20.50', A3: '21.00', A4: '21.50' },
  'Beta University': { B1: '20.20', B2: '20.70', B3: '21.20', B4: '21.70' },
  'Gamma University': { G1: '20.40', G2: '20.90', G3: '21.40', G4: '21.90' },
};
const freeOnlyTeams = (): TheoreticalMeetTeamInput[] =>
  Object.entries(FREE50).map(([name, swimmers]) => team(name, Object.fromEntries(Object.entries(swimmers).map(([n, t]) => [n, [['50 Free SCY', t]]]))));

/** CONSTRUCTED: five swimmers with all four 50-yard strokes and 100 Free, so medley and free relays can form. */
const DELTA = 'Delta University';
const deltaTeam = (gender: Gender = Gender.MEN): TheoreticalMeetTeamInput =>
  team(
    DELTA,
    {
    P: [['50 Back SCY', '24.00'], ['50 Breast SCY', '30.00'], ['50 Fly SCY', '23.00'], ['50 Free SCY', '20.00'], ['100 Free SCY', '44.00']],
    Q: [['50 Back SCY', '25.00'], ['50 Breast SCY', '28.00'], ['50 Fly SCY', '25.00'], ['50 Free SCY', '21.00'], ['100 Free SCY', '45.00']],
    R: [['50 Back SCY', '26.00'], ['50 Breast SCY', '29.00'], ['50 Fly SCY', '24.00'], ['50 Free SCY', '22.00'], ['100 Free SCY', '46.00']],
    S: [['50 Back SCY', '27.00'], ['50 Breast SCY', '27.00'], ['50 Fly SCY', '26.00'], ['50 Free SCY', '23.00'], ['100 Free SCY', '47.00']],
    T: [['50 Back SCY', '28.00'], ['50 Breast SCY', '31.00'], ['50 Fly SCY', '27.00'], ['50 Free SCY', '24.00'], ['100 Free SCY', '48.00']],
    },
    gender
  );

const names = (r: TheoreticalProjectedRelay): string[] => r.legs.map(l => l.name);

/* -------------------------------------------------------------------------- */
/* The relay program                                                           */
/* -------------------------------------------------------------------------- */

describe('the relay program', () => {
  const labelOf = (event: string): string => `${parseRelayDistanceYards(event)} ${relayKind(event) === 'medley' ? 'Medley' : 'Free'} Relay SCY`;

  it('is the five relays of the real 2026 NSISC results (men, committed fixture)', () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')) as { menResults: SwimmerResult[] };
    const real = [...new Set(fixture.menResults.filter(r => r.isRelay === true).map(r => labelOf(r.event)))];
    expect([...real].sort()).toEqual([...NSISC_RELAY_PROGRAM].sort());
  });

  it("is the same five relays in the women's real results (data/meets.json, local only)", () => {
    const path = resolve(import.meta.dirname, '..', 'data', 'meets.json');
    if (!existsSync(path)) return;
    const all = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === 'object') {
        const o = node as Record<string, unknown>;
        if (Array.isArray(o.womenResults)) {
          for (const r of o.womenResults as SwimmerResult[]) {
            // The meet also holds a relay time trial (Event 202). It is not part of the scored program.
            if (r.isRelay === true && !/time trial/i.test(r.event)) found.push(labelOf(r.event));
          }
        }
        Object.values(o).forEach(walk);
      }
    };
    walk(all);
    if (found.length === 0) return;
    expect([...new Set(found)].sort()).toEqual([...NSISC_RELAY_PROGRAM].sort());
  });

  it('exists for NSISC only: another conference has none on record, which is not an empty program', () => {
    expect(theoreticalRelayProgram('NSISC')).toEqual(NSISC_RELAY_PROGRAM);
    expect(theoreticalRelayProgram(undefined)).toBeNull();
    expect(theoreticalRelayProgram('SIAC')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Legs, totals, estimate tag                                                  */
/* -------------------------------------------------------------------------- */

describe('relay legs with the flying-start setting OFF', () => {
  const seeds = build(freeOnlyTeams());
  const alpha = relayOf(seeds, 'Alpha University', '200 Free Relay SCY') as TheoreticalProjectedRelay;

  it('takes the four fastest flat-start bests, in order, and sums them exactly', () => {
    expect(names(alpha)).toEqual(['A1', 'A2', 'A3', 'A4']);
    expect(alpha.legs.map(l => l.time)).toEqual(['20.00', '20.50', '21.00', '21.50']);
    expect(alpha.totalSec).toBe(83);
    expect(alpha.totalTime).toBe('1:23.00');
    expect(relayOf(seeds, 'Beta University', '200 Free Relay SCY')?.totalTime).toBe('1:23.80');
    expect(relayOf(seeds, 'Gamma University', '200 Free Relay SCY')?.totalTime).toBe('1:24.60');
  });

  it('tags the relay estimated, leg 1 as a flat-start best and legs 2 to 4 as estimates, with no adjustment', () => {
    expect(alpha.anyEstimated).toBe(true);
    expect(alpha.adjustmentApplied).toBe(false);
    expect(alpha.legs.map(l => l.basis)).toEqual(['flat-start-best', 'estimated-from-flat-start', 'estimated-from-flat-start', 'estimated-from-flat-start']);
    expect(alpha.legs.map(l => l.estimated)).toEqual([undefined, true, true, true]);
    expect(alpha.legs.every(l => l.startAdjustmentSec === undefined)).toBe(true);
    for (const leg of alpha.legs) expect(leg.time).toBe(leg.flatStartTime);
  });

  it('states the flying starts are not adjusted, and that the relays are estimates', () => {
    expect(seeds.report.caveats).toContain(RELAYS_ESTIMATED_CAVEAT);
    expect(seeds.report.caveats.join('\n')).toMatch(/Flying starts are not adjusted/);
    expect(seeds.report.caveats).not.toContain(RELAYS_EXCLUDED_CAVEAT);
    // The "relay slots are not reserved" line would be false now: relays are chosen first.
    expect(seeds.report.caveats).not.toContain(TOTAL_CAP_CAVEAT);
  });

  it('builds only the relays four swimmers can swim, and says why not the others', () => {
    expect(seeds.relayEntries.map(r => r.event)).toEqual(['200 Free Relay SCY', '200 Free Relay SCY', '200 Free Relay SCY']);
    const report = seeds.report.teams[0].relayReport!;
    expect(report.absent.map(a => a.event)).toEqual(['800 Free Relay SCY', '200 Medley Relay SCY', '400 Medley Relay SCY', '400 Free Relay SCY']);
    // Nobody has a 200 Free, a 50 Back, a 100 Back or a 100 Free best: nobody, not "zero".
    expect(report.absent[0].missingLegs.map(m => [m.position, m.legEvent, m.swimmersWithBest])).toEqual([
      [1, '200 Freestyle', 0],
      [2, '200 Freestyle', 0],
      [3, '200 Freestyle', 0],
      [4, '200 Freestyle', 0],
    ]);
    expect(seeds.report.relays).toMatchObject({ programKnown: true, relaysBuilt: 3, relaysAbsent: 12 });
  });
});

describe('the flying-start adjustment (a user setting, never a default)', () => {
  const adjusted = build([deltaTeam()], { relayFlyingStartAdjustmentSec: { 50: 0.3 } });
  const plain = build([deltaTeam()]);

  it('subtracts the seconds from legs 2 to 4 only, never leg 1', () => {
    const r = relayOf(adjusted, DELTA, '200 Free Relay SCY') as TheoreticalProjectedRelay;
    expect(r.legs.map(l => l.time)).toEqual(['20.00', '20.70', '21.70', '22.70']);
    expect(r.legs.map(l => l.startAdjustmentSec)).toEqual([undefined, 0.3, 0.3, 0.3]);
    expect(r.legs.map(l => l.flatStartTime)).toEqual(['20.00', '21.00', '22.00', '23.00']);
    expect(r.totalSec).toBe(85.1);
    expect(r.totalTime).toBe('1:25.10');
    expect(r.adjustmentApplied).toBe(true);
    expect(r.anyEstimated).toBe(true);
  });

  it('applies to medley legs too (hand sum 24.00 + 26.70 + 23.70 + 20.70)', () => {
    const r = relayOf(adjusted, DELTA, '200 Medley Relay SCY') as TheoreticalProjectedRelay;
    expect(r.totalSec).toBe(95.1);
    expect(r.totalTime).toBe('1:35.10');
  });

  it('gives no adjustment to a distance with no value, and says which', () => {
    const r = relayOf(adjusted, DELTA, '400 Free Relay SCY') as TheoreticalProjectedRelay;
    expect(r.legs.map(l => l.time)).toEqual(['44.00', '45.00', '46.00', '47.00']);
    expect(r.adjustmentApplied).toBe(false);
    expect(r.legs.every(l => l.startAdjustmentSec === undefined)).toBe(true);
    expect(adjusted.report.caveats.join('\n')).toMatch(/50 yd: 0\.3 s/);
    expect(adjusted.report.caveats.join('\n')).toMatch(/No adjustment for 100 yd, 200 yd legs/);
  });

  it('is off without the setting: the totals are the plain flat-start sums', () => {
    expect(relayOf(plain, DELTA, '200 Free Relay SCY')?.totalSec).toBe(86);
    expect(relayOf(plain, DELTA, '200 Medley Relay SCY')?.totalSec).toBe(96);
    expect(plain.report.relays?.flyingStartAdjustmentSec).toEqual({});
  });

  it('rejects a value that is not a number of 0 or more, an unknown distance, and a setting with no relays', () => {
    const code = (over: Partial<TheoreticalMeetInput>): string | undefined => {
      try {
        build([deltaTeam()], over);
      } catch (error) {
        return (error as TheoreticalMeetError).code;
      }
      return undefined;
    };
    expect(code({ relayFlyingStartAdjustmentSec: { 50: -0.1 } })).toBe('invalid-relay-settings');
    expect(code({ relayFlyingStartAdjustmentSec: { 50: Number.NaN } })).toBe('invalid-relay-settings');
    expect(code({ relayFlyingStartAdjustmentSec: { 75: 0.2 } as never })).toBe('invalid-relay-settings');
    expect(code({ includeRelays: false, relayFlyingStartAdjustmentSec: { 50: 0.2 } })).toBe('invalid-relay-settings');
    // A value that would take a leg to zero or below fails loudly; it is never clamped.
    expect(code({ relayFlyingStartAdjustmentSec: { 50: 21 } })).toBe('invalid-relay-settings');
    expect(code({ relayFlyingStartAdjustmentSec: { 50: 0 } })).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Scoring: a hand-computed team total                                         */
/* -------------------------------------------------------------------------- */

describe('team totals through the existing scoring path', () => {
  const seeds = build(freeOnlyTeams());
  const built: TheoreticalMeetWorkspaceBuild = buildTheoreticalMeetWorkspace({
    workspaceId: 'ws-relay',
    createdAt: 1,
    seeds,
    scoringSettings: NSISC_PRESET_SETTINGS,
    conference: 'NSISC',
  });
  const workspace = built.payload as unknown as Workspace;
  const totals = new Map(buildScoringSnapshot(workspace, Gender.MEN, false).baseline.sortedTeams.map(t => [t.teamName, t.totalPoints]));

  /**
   * Hand calculation. Individual 50 Free, twelve swimmers sorted by time:
   *   1 A1 20.00, 2 B1 20.20, 3 G1 20.40, 4 A2 20.50, 5 B2 20.70, 6 G2 20.90,
   *   7 A3 21.00, 8 B3 21.20, 9 G3 21.40, 10 A4 21.50, 11 B4 21.70, 12 G4 21.90.
   * The NCAA table (20 17 16 15 14 13 12 11 9 7 6 5 ...) pays Alpha 20+15+12+7 = 54, Beta 17+14+11+6 = 48,
   * Gamma 16+13+9+5 = 43.
   * 200 Free Relay, team times 83.00 / 83.80 / 84.60 are places 1, 2, 3. NSISC pays place x relayMultiplier (2):
   * 2 x 20 = 40, 2 x 17 = 34, 2 x 16 = 32 (each leg row carries a quarter).
   * Totals: Alpha 94, Beta 82, Gamma 75.
   */
  it('equals the hand sum of individual places and relay places x 2', () => {
    const table = SCORING_POINTS;
    expect(table.slice(0, 12)).toEqual([20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5]);
    expect(totals.get('Alpha University')).toBe(table[0] + table[3] + table[6] + table[9] + 2 * table[0]);
    expect(totals.get('Beta University')).toBe(table[1] + table[4] + table[7] + table[10] + 2 * table[1]);
    expect(totals.get('Gamma University')).toBe(table[2] + table[5] + table[8] + table[11] + 2 * table[2]);
    expect([totals.get('Alpha University'), totals.get('Beta University'), totals.get('Gamma University')]).toEqual([94, 82, 75]);
  });

  it('pays each relay once, as the preset says, split over the four legs', () => {
    const legs = built.payload.menResults.filter(r => r.isRelay === true);
    expect(legs).toHaveLength(12);
    const scored = buildScoringSnapshot(workspace, Gender.MEN, false).baseline.allScored.filter(r => r.isRelay === true);
    const byTeam = (team: string) => scored.filter(r => r.team === team);
    expect(byTeam('Alpha University').map(r => r.points)).toEqual([10, 10, 10, 10]);
    expect(byTeam('Beta University').map(r => r.points)).toEqual([8.5, 8.5, 8.5, 8.5]);
    expect(byTeam('Gamma University').map(r => r.points)).toEqual([8, 8, 8, 8]);
  });

  it('without relays the same teams score the individual points only', () => {
    const without = build(freeOnlyTeams(), { includeRelays: false });
    const b = buildTheoreticalMeetWorkspace({ workspaceId: 'ws-relay', createdAt: 1, seeds: without, scoringSettings: NSISC_PRESET_SETTINGS, conference: 'NSISC' });
    const t = new Map(buildScoringSnapshot(b.payload as unknown as Workspace, Gender.MEN, false).baseline.sortedTeams.map(x => [x.teamName, x.totalPoints]));
    expect([t.get('Alpha University'), t.get('Beta University'), t.get('Gamma University')]).toEqual([54, 48, 43]);
  });

  it('writes four rows per relay that share event, team, round, place and team time, with no PDF points', () => {
    const legs = built.payload.menResults.filter(r => r.isRelay === true && r.team === 'Alpha University');
    expect(legs.map(r => r.relayLegIndex)).toEqual([0, 1, 2, 3]);
    expect(legs.map(r => r.name)).toEqual(['A1', 'A2', 'A3', 'A4']);
    expect(new Set(legs.map(r => `${r.event}|${r.roundSwam}|${r.rank}|${r.time}|${r.finalsTime}|${r.relayTeamTime}`)).size).toBe(1);
    expect(legs[0]).toMatchObject({ event: '200 Free Relay SCY', roundSwam: 'A Final', rank: 1, time: '1:23.00', relayTeamTime: '1:23.00' });
    expect(legs.map(r => r.relayLegSplit)).toEqual(['20.00', '20.50', '21.00', '21.50']);
    expect(legs.every(r => r.pdfPoints === undefined && r.isPsychSheet === undefined && r.relayLegSplitDetail === undefined)).toBe(true);
    expect(legs[0].relayNames?.map(n => n.name)).toEqual(['A1', 'A2', 'A3', 'A4']);
    const ids = built.payload.menResults.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => id.includes('ws-relay'))).toBe(true);
    expect(built.relayResultIdsByEntryId.size).toBe(3);
  });

  it('ranks teams by estimated time with a shared place on an exact tie (1, 1, 3), pays each tied relay the full place points, and names the tie', () => {
    const tie = build([
      team('Alpha University', { A1: [['50 Free SCY', '20.00']], A2: [['50 Free SCY', '20.50']], A3: [['50 Free SCY', '21.00']], A4: [['50 Free SCY', '21.50']] }),
      team('Beta University', { B1: [['50 Free SCY', '20.00']], B2: [['50 Free SCY', '20.50']], B3: [['50 Free SCY', '21.00']], B4: [['50 Free SCY', '21.50']] }),
      team('Gamma University', { G1: [['50 Free SCY', '21.00']], G2: [['50 Free SCY', '21.00']], G3: [['50 Free SCY', '21.00']], G4: [['50 Free SCY', '21.00']] }),
    ]);
    const b = buildTheoreticalMeetWorkspace({ workspaceId: 'ws-relay', createdAt: 1, seeds: tie, scoringSettings: NSISC_PRESET_SETTINGS, conference: 'NSISC' });
    const places = new Map(b.payload.menResults.filter(r => r.isRelay === true && r.relayLegIndex === 0).map(r => [r.team, r.rank]));
    expect([places.get('Alpha University'), places.get('Beta University'), places.get('Gamma University')]).toEqual([1, 1, 3]);
    // Pinned current behaviour: core relay scoring does not split tied points. Each tied relay gets the full
    // place-1 points (2 x 20 = 40, a quarter per leg = 10). Place 3 follows with 2 x 16 = 32 (8 per leg).
    const scored = buildScoringSnapshot(b.payload as unknown as Workspace, Gender.MEN, false).baseline.allScored.filter(r => r.isRelay === true);
    const legPoints = (t: string): number[] => scored.filter(r => r.team === t).map(r => r.points as number);
    expect(legPoints('Alpha University')).toEqual([10, 10, 10, 10]);
    expect(legPoints('Beta University')).toEqual([10, 10, 10, 10]);
    expect(legPoints('Gamma University')).toEqual([8, 8, 8, 8]);
    // The meet names each tied relay and says it is not split.
    const note = b.caveats.find(c => c.startsWith('Tied estimated relays:')) as string;
    expect(note).toContain('200 Free Relay SCY');
    expect(note).toContain('Alpha University, Beta University');
    expect(note).toContain('place 1');
    expect(note).toContain('each tied relay receives the full place points');
    expect(b.caveats.filter(c => c.startsWith('Tied estimated relays:'))).toHaveLength(1);
  });

  it('is an estimate in the theoretical workspace and nowhere else', () => {
    const relayRow = built.payload.menResults.find(r => r.isRelay === true) as SwimmerResult;
    const individualRow = built.payload.menResults.find(r => r.isRelay !== true) as SwimmerResult;
    expect(isEstimatedRelayRow(workspace, relayRow)).toBe(true);
    expect(isEstimatedRelayRow(workspace, individualRow)).toBe(false);
    expect(isEstimatedRelayRow({ loadedMeet: { meetLabel: '2026 NSISC Championships' } }, relayRow)).toBe(false);
    expect(isEstimatedRelayRow(undefined, relayRow)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* A swimmer is on a relay once                                                */
/* -------------------------------------------------------------------------- */

describe('one swimmer, one leg', () => {
  const seeds = build([deltaTeam()]);

  /**
   * CONSTRUCTED. P is the fastest at back (24.00), fly (23.00) and free (20.00), and swims a 30.00 breast.
   * Legs are filled in order: back P 24.00; breast, not P: S 27.00; fly, not P or S: R 24.00; free, not P, S
   * or R: Q 21.00. P is on the relay once. Total 24 + 27 + 24 + 21 = 96.00.
   */
  it('puts a swimmer who is fastest in three strokes on the medley once', () => {
    const r = relayOf(seeds, DELTA, '200 Medley Relay SCY') as TheoreticalProjectedRelay;
    expect(names(r)).toEqual(['P', 'S', 'R', 'Q']);
    expect(r.legs.map(l => l.stroke)).toEqual(['back', 'breast', 'fly', 'free']);
    expect(r.legs.map(l => l.time)).toEqual(['24.00', '27.00', '24.00', '21.00']);
    expect(r.totalTime).toBe('1:36.00');
  });

  it('never lists a swimmer twice on any relay', () => {
    expect(seeds.relayEntries.length).toBeGreaterThan(0);
    for (const r of seeds.relayEntries) expect(new Set(names(r)).size).toBe(4);
  });

  it('keeps swimmers on the legs of their own gender and team only', () => {
    const both = build([deltaTeam(), deltaTeam(Gender.WOMEN)]);
    for (const r of both.relayEntries) expect(r.legs.every(l => l.team === r.team)).toBe(true);
    expect(both.relayEntries.filter(r => r.gender === Gender.WOMEN).length).toBe(both.relayEntries.filter(r => r.gender === Gender.MEN).length);
  });
});

/* -------------------------------------------------------------------------- */
/* Entry caps                                                                  */
/* -------------------------------------------------------------------------- */

describe('relays and the entry caps', () => {
  /**
   * CONSTRUCTED. Four swimmers, each with 50, 100 and 200 Free and eight individual events in the program
   * (500 Free, 100 Back, 100 Breast, 100 Fly, 200 IM as well). The NSISC cap is 7 entries in total.
   * Four relays can form (200, 400 and 800 Free, and the 400 Medley from the four 100-yard strokes), and all
   * four swimmers are on all four. The 200 Medley needs 50-yard strokes nobody has, so it is absent.
   */
  const ECHO = 'Echo University';
  const events = (n: number): Array<[string, string]> => [
    ['50 Free SCY', `${20 + n}.00`],
    ['100 Free SCY', `${44 + n}.00`],
    ['200 Free SCY', `1:${40 + n}.00`],
    ['500 Free SCY', `4:${40 + n}.00`],
    ['100 Back SCY', `${50 + n}.00`],
    ['100 Breast SCY', `${58 + n}.00`],
    ['100 Fly SCY', `${48 + n}.00`],
    ['200 IM SCY', `1:${50 + n}.00`],
  ];
  const echo = () => team(ECHO, { E1: events(0), E2: events(1), E3: events(2), E4: events(3) });
  const off = build([echo()], { includeRelays: false });
  const on = build([echo()]);
  const chosen = (s: TheoreticalMeetSeeds, name: string): string[] =>
    s.report.teams[0].eventsChosenPerSwimmer.find(x => x.name === name)!.events.filter(e => e.chosen).map(e => e.event);

  it('without relays a swimmer takes 7 individual events', () => {
    for (const name of ['E1', 'E2', 'E3', 'E4']) expect(chosen(off, name)).toHaveLength(7);
  });

  it('pushes the weakest individual events out: 4 relays leave 3 individual events, the first 3 of the same order', () => {
    expect(on.relayEntries.map(r => r.event)).toEqual(['800 Free Relay SCY', '400 Medley Relay SCY', '200 Free Relay SCY', '400 Free Relay SCY']);
    for (const name of ['E1', 'E2', 'E3', 'E4']) {
      expect(chosen(on, name)).toEqual(chosen(off, name).slice(0, 3));
      const swimmer = on.report.teams[0].eventsChosenPerSwimmer.find(x => x.name === name)!;
      const out = swimmer.events.filter(e => e.notChosenReason === 'entry_cap').map(e => e.event);
      // 8 events are offered. 3 are chosen. The other 5 are stopped by the cap, and they include the 4 that were chosen without relays.
      expect(out).toHaveLength(5);
      expect(out).toEqual(expect.arrayContaining(chosen(off, name).slice(3)));
      expect(out).toEqual(swimmer.events.slice(3).map(e => e.event));
    }
  });

  it('never lets a swimmer exceed the total cap: individual rows plus relays are 7', () => {
    for (const name of ['E1', 'E2', 'E3', 'E4']) {
      const individual = on.rows.filter(r => r.name === name).length;
      const relays = on.relayEntries.filter(r => names(r).includes(name)).length;
      expect(relays).toBe(4);
      expect(individual).toBe(3);
      expect(individual + relays).toBe(7);
    }
  });

  it('keeps a user removal working after the relays: the freed slot goes to the next offered event', () => {
    const order = chosen(off, 'E1');
    const swimmerKey = on.report.teams[0].eventsChosenPerSwimmer.find(x => x.name === 'E1')!.swimmerKey;
    const removed = build([echo()], { excludedEvents: [{ teamName: ECHO, gender: Gender.MEN, swimmerKey, event: order[1] }] });
    // Three slots after the relays: the first event stays, the second is gone, the fourth fills the slot.
    expect(chosen(removed, 'E1')).toEqual([order[0], order[2], order[3]]);
    expect(removed.relayEntries).toEqual(on.relayEntries);
    expect(removed.report.unmatchedExclusions).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Relays per swimmer: at most N                                               */
/* -------------------------------------------------------------------------- */

describe('"Relays per swimmer: at most N" (a user setting, unset by default)', () => {
  /** Same constructed Echo team as above: four swimmers, eight individual events each. */
  const ECHO = 'Echo University';
  const events = (n: number): Array<[string, string]> => [
    ['50 Free SCY', `${20 + n}.00`],
    ['100 Free SCY', `${44 + n}.00`],
    ['200 Free SCY', `1:${40 + n}.00`],
    ['500 Free SCY', `4:${40 + n}.00`],
    ['100 Back SCY', `${50 + n}.00`],
    ['100 Breast SCY', `${58 + n}.00`],
    ['100 Fly SCY', `${48 + n}.00`],
    ['200 IM SCY', `1:${50 + n}.00`],
  ];
  const four = () => team(ECHO, { E1: events(0), E2: events(1), E3: events(2), E4: events(3) });
  const five = () => team(ECHO, { E1: events(0), E2: events(1), E3: events(2), E4: events(3), E5: events(4) });
  const individualEvents = (s: TheoreticalMeetSeeds, name: string): string[] =>
    s.report.teams[0].eventsChosenPerSwimmer.find(x => x.name === name)!.events.filter(e => e.chosen).map(e => e.event);
  const relaysOf = (s: TheoreticalMeetSeeds, name: string): number => s.relayEntries.filter(r => names(r).includes(name)).length;

  const unlimited = build([four()]);
  const limited = build([four()], { maxRelaysPerSwimmer: 2 });

  it('is unset by default: the report says null and the output is the build from before', () => {
    expect(unlimited.report.relays?.maxRelaysPerSwimmer).toBeNull();
    expect(JSON.stringify(build([four()], { maxRelaysPerSwimmer: undefined }))).toBe(JSON.stringify(unlimited));
    expect(unlimited.report.caveats.some(c => c.startsWith('Relays per swimmer'))).toBe(false);
  });

  it('with N = 2 the fastest freestyler is on 2 relays and keeps 5 individual events, not 3', () => {
    expect(relaysOf(unlimited, 'E1')).toBe(4);
    expect(individualEvents(unlimited, 'E1')).toHaveLength(3);
    expect(relaysOf(limited, 'E1')).toBe(2);
    expect(individualEvents(limited, 'E1')).toHaveLength(5);
    // The cap stays total-only: relays plus individual events still come to 7.
    for (const name of ['E1', 'E2', 'E3', 'E4']) expect(relaysOf(limited, name) + individualEvents(limited, name).length).toBe(7);
    // The individual events kept are the first of the same strength order (more of them, none reordered).
    expect(individualEvents(limited, 'E1').slice(0, 3)).toEqual(individualEvents(unlimited, 'E1'));
  });

  it('builds the relays in program order until the limit stops the fill, and says why the others are absent', () => {
    expect(limited.relayEntries.map(r => r.event)).toEqual(['800 Free Relay SCY', '400 Medley Relay SCY']);
    const absent = limited.report.teams[0].relayReport?.absent ?? [];
    expect(absent.map(a => a.event)).toEqual(['200 Medley Relay SCY', '200 Free Relay SCY', '400 Free Relay SCY']);
    const freeAbsent = absent.find(a => a.event === '200 Free Relay SCY')!;
    for (const leg of freeAbsent.missingLegs) {
      expect(leg.swimmersWithBest).toBe(4);
      expect(leg.atRelayLimit).toBe(4);
      expect(leg.atEntryCap).toBe(0);
    }
    expect(describeAbsentRelay(freeAbsent).reasons[0]).toContain('4 already on the most relays you allowed');
  });

  it('with a slower fifth swimmer nobody is on more than 2 relays, and the fifth is offered a leg only when four are free', () => {
    const s = build([five()], { maxRelaysPerSwimmer: 2 });
    for (const name of ['E1', 'E2', 'E3', 'E4', 'E5']) {
      expect(relaysOf(s, name)).toBeLessThanOrEqual(2);
      expect(relaysOf(s, name) + individualEvents(s, name).length).toBeLessThanOrEqual(7);
    }
    const free = build([five()]);
    expect(relaysOf(free, 'E1')).toBeGreaterThan(2);
    expect(individualEvents(s, 'E1').length).toBeGreaterThan(individualEvents(free, 'E1').length);
    // The first two relays take E1 to E4. Those four are then at the limit, and E5 alone cannot fill a relay.
    expect(s.relayEntries.map(r => r.event)).toEqual(['800 Free Relay SCY', '400 Medley Relay SCY']);
    expect(relaysOf(s, 'E5')).toBe(0);
    const absent = s.report.teams[0].relayReport!.absent.find(a => a.event === '200 Free Relay SCY')!;
    expect(absent.missingLegs[0]).toMatchObject({ position: 2, swimmersWithBest: 5, atRelayLimit: 4, alreadyOnRelay: 1 });
  });

  it('says it in the meet line, the report and the corrected relays-first reason', () => {
    expect(limited.report.relays?.maxRelaysPerSwimmer).toBe(2);
    expect(limited.report.caveats).toContain(relayLimitCaveat(2));
    expect(relayLimitCaveat(2)).toBe('Relays per swimmer: at most 2. A swimmer already on 2 relays is not offered another leg. The entry cap itself stays total-only.');
    expect(relayLimitCaveat(1)).toContain('already on 1 relay is not offered');
    // The reason relays go first is the cap, not the points.
    expect(RELAY_CAP_CAVEAT).toContain('no relay could be built');
    expect(RELAY_CAP_CAVEAT).toContain('half what an individual swim at the same place pays');
    expect(RELAY_CAP_CAVEAT).not.toMatch(/double/i);
  });

  it('rejects a value that is not a whole number of 1 or more, and a limit with no relays', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => build([four()], { maxRelaysPerSwimmer: bad })).toThrowError(TheoreticalMeetError);
    }
    expect(() => build([four()], { maxRelaysPerSwimmer: '2' as unknown as number })).toThrowError(TheoreticalMeetError);
    expect(() => build([four()], { includeRelays: false, maxRelaysPerSwimmer: 2 })).toThrowError(/would have no effect/);
  });

  it('a limit of 1 builds one relay per swimmer pair set and leaves every swimmer 6 individual events', () => {
    const one = build([four()], { maxRelaysPerSwimmer: 1 });
    expect(one.relayEntries).toHaveLength(1);
    for (const name of ['E1', 'E2', 'E3', 'E4']) expect(individualEvents(one, name)).toHaveLength(6);
  });
});

/* -------------------------------------------------------------------------- */
/* Absent is not zero                                                          */
/* -------------------------------------------------------------------------- */

describe('a team without four eligible swimmers', () => {
  /** CONSTRUCTED: three swimmers, 50 Free only. */
  const FOX = 'Foxtrot University';
  const seeds = build([team(FOX, { F1: [['50 Free SCY', '20.00']], F2: [['50 Free SCY', '21.00']], F3: [['50 Free SCY', '22.00']] })]);

  it('gets no relay entry, and the reason names the leg and the count', () => {
    expect(seeds.relayEntries).toEqual([]);
    const absent = seeds.report.teams[0].relayReport!.absent.find(a => a.event === '200 Free Relay SCY')!;
    expect(absent.missingLegs).toEqual([{ position: 4, legEvent: '50 Freestyle', swimmersWithBest: 3, alreadyOnRelay: 3, atEntryCap: 0, atRelayLimit: 0 }]);
    expect(describeAbsentRelay(absent).reasons).toEqual(['Leg 4 (50 Freestyle): 3 swimmers have a best time (3 already on this relay), so nobody is left for the leg.']);
    const medley = seeds.report.teams[0].relayReport!.absent.find(a => a.event === '200 Medley Relay SCY')!;
    expect(describeAbsentRelay(medley).reasons[0]).toBe('Leg 1 (50 Backstroke): no swimmer on the team has a best time in this event.');
  });

  it('charges nobody for the relay it did not build, and keeps the individual rows', () => {
    expect(seeds.rows.map(r => r.name)).toEqual(['F1', 'F2', 'F3']);
    const noRelays = build([team(FOX, { F1: [['50 Free SCY', '20.00']], F2: [['50 Free SCY', '21.00']], F3: [['50 Free SCY', '22.00']] })], { includeRelays: false });
    expect(seeds.rows).toEqual(noRelays.rows);
  });

  it('builds no workspace relay rows, and the meet says the totals run low', () => {
    const b = buildTheoreticalMeetWorkspace({ workspaceId: 'ws-relay', createdAt: 1, seeds, scoringSettings: NSISC_PRESET_SETTINGS, conference: 'NSISC' });
    expect(b.payload.menResults.some(r => r.isRelay === true)).toBe(false);
    expect(seeds.report.caveats).toContain(RELAYS_EXCLUDED_CAVEAT);
    expect(seeds.report.caveats.join('\n')).toMatch(/could not be built/);
  });
});

/* -------------------------------------------------------------------------- */
/* Only real flat-start results in the meet course                             */
/* -------------------------------------------------------------------------- */

describe('which swims can be a leg', () => {
  const GOLF = 'Golf University';
  const four = (g1: Array<[string, string, Partial<HistoricalSwim>?]>, g2: Array<[string, string, Partial<HistoricalSwim>?]> = [['50 Free SCY', '21.00']]) =>
    team(GOLF, { G1: g1, G2: g2, G3: [['50 Free SCY', '22.00']], G4: [['50 Free SCY', '23.00']] });

  it('uses the meet course only: a faster long-course swim is not converted or used', () => {
    const seeds = build([four([['50 Free LCM', '19.00', { timeType: 'LCM' }], ['50 Free SCY', '20.00']])]);
    expect(relayOf(seeds, GOLF, '200 Free Relay SCY')?.legs[0].time).toBe('20.00');
  });

  it('never uses a time extracted from a longer swim', () => {
    const seeds = build([four([['50 Free SCY', '20.00']], [['50 Free SCY', '19.50', { isExtractedSplit: true }], ['50 Back SCY', '30.00']])]);
    // G2 has no real 50 Free: only three swimmers have a result, so the relay is absent. The extracted 19.50 is not a leg.
    expect(relayOf(seeds, GOLF, '200 Free Relay SCY')).toBeUndefined();
    expect(seeds.report.teams[0].relayReport!.absent.find(a => a.event === '200 Free Relay SCY')!.missingLegs[0].swimmersWithBest).toBe(3);
  });

  it('labels an exhibition leg, and drops it when exhibition seeds are excluded (no slower time is used instead)', () => {
    const swimmers = four([['50 Free SCY', '19.90', { isExhibition: true }]]);
    const included = build([swimmers]);
    const leg = relayOf(included, GOLF, '200 Free Relay SCY')!.legs[0];
    expect(leg).toMatchObject({ name: 'G1', time: '19.90', isExhibition: true });
    const excluded = build([swimmers], { exhibitionSeeds: 'exclude' });
    expect(relayOf(excluded, GOLF, '200 Free Relay SCY')).toBeUndefined();
  });

  it('fails loudly on a leg-event time that is not a time', () => {
    expect(() => build([four([['50 Free SCY', 'abc']])])).toThrowError(TheoreticalMeetError);
  });
});

/* -------------------------------------------------------------------------- */
/* Other presets, and relays off                                               */
/* -------------------------------------------------------------------------- */

describe('relays not requested, or no program on record', () => {
  it('a preset with no relay program builds none and says so (no program is guessed)', () => {
    const seeds = build([deltaTeam()], { scoringSettings: GENERIC_TOP16_SETTINGS, conference: undefined });
    expect(seeds.relayEntries).toEqual([]);
    expect(seeds.report.relays).toMatchObject({ programKnown: false, program: [], relaysBuilt: 0 });
    expect(seeds.report.caveats).toContain(RELAYS_NO_PROGRAM_CAVEAT);
    expect(seeds.report.caveats).toContain(RELAYS_EXCLUDED_CAVEAT);
    const none = build([deltaTeam()], { scoringSettings: GENERIC_TOP16_SETTINGS, conference: undefined, includeRelays: false });
    expect(seeds.rows).toEqual(none.rows);
  });

  it('keeps the total-cap line when relays are asked for but the conference has no program (GLIAC, NSISC cap of 7)', () => {
    const seeds = build([deltaTeam()], { conference: 'GLIAC' });
    expect(seeds.relayEntries).toEqual([]);
    expect(seeds.report.relays?.programKnown).toBe(false);
    // The 7-entry total cap is in force and no relay slot was reserved, so both the team and the meet say so.
    expect(seeds.report.teams[0].caveats).toContain(TOTAL_CAP_CAVEAT);
    expect(seeds.report.caveats).toContain(TOTAL_CAP_CAVEAT);
  });

  it('drops the total-cap line only when relays were really built (NSISC)', () => {
    const seeds = build([deltaTeam()]);
    expect(seeds.relayEntries.length).toBeGreaterThan(0);
    expect(seeds.report.teams[0].caveats).not.toContain(TOTAL_CAP_CAVEAT);
    expect(seeds.report.caveats).not.toContain(TOTAL_CAP_CAVEAT);
  });

  it('not requested: no relay key anywhere, and the same output as a build that never knew about relays', () => {
    const asked = build([deltaTeam()], { includeRelays: false });
    const never = buildTheoreticalMeetSeeds({ meetId: 'ws-relay', course: 'SCY', scoringSettings: NSISC_PRESET_SETTINGS, conference: 'NSISC', teams: [deltaTeam()] });
    expect(JSON.stringify([asked.rows, asked.report])).toBe(JSON.stringify([never.rows, never.report]));
    expect(never.relayEntries).toEqual([]);
    expect(never.report.relays).toBeUndefined();
    expect(never.report.teams[0].relayReport).toBeUndefined();
    expect(never.report.caveats).toContain(RELAYS_EXCLUDED_CAVEAT);
    expect(never.report.caveats).toContain(TOTAL_CAP_CAVEAT);
  });
});

/* -------------------------------------------------------------------------- */
/* Invariants over the committed real captures                                 */
/* -------------------------------------------------------------------------- */

describe('three real captured teams (committed, trimmed fixtures)', async () => {
  const api = fakeCaptureApi();
  const records = await fixtureRecords();
  const results: Record<string, Awaited<ReturnType<typeof readTeamCapture>>> = {};
  for (const id of CAPTURE_IDS) results[id] = await readTeamCapture(api, id, records);
  const args = { captureIds: [...CAPTURE_IDS], resultsByCaptureId: results, scoringChoiceId: 'nsisc' };
  const withRelays = buildMeet({ ...args, includeRelays: true }, 'ws-real-relays', 1_760_000_000_000);
  const without = buildMeet(args, 'ws-real-relays', 1_760_000_000_000);

  it('builds relays, in the NSISC program only', () => {
    expect(withRelays.seeds.relayEntries.length).toBeGreaterThan(0);
    for (const r of withRelays.seeds.relayEntries) expect(NSISC_RELAY_PROGRAM).toContain(r.event);
  });

  it('puts no swimmer on a relay twice, and every relay is tagged estimated with four swimmers of its own team', () => {
    for (const r of withRelays.seeds.relayEntries) {
      expect(r.legs).toHaveLength(4);
      expect(new Set(names(r)).size).toBe(4);
      expect(r.anyEstimated).toBe(true);
      expect(r.legs.every(l => l.team === r.team)).toBe(true);
      expect(r.legs[0].basis).toBe('flat-start-best');
      expect(r.legs.slice(1).every(l => l.basis === 'estimated-from-flat-start' && l.estimated === true)).toBe(true);
    }
  });

  it('traces every leg to a captured SCY swim of that swimmer, time for time', () => {
    const swimsOf = new Map<string, readonly HistoricalSwim[]>();
    for (const t of withRelays.captures.teams) for (const a of t.athletes) if (a.swims) swimsOf.set(`${t.teamName}|${t.gender}|${a.athlete.name}`, a.swims);
    for (const r of withRelays.seeds.relayEntries) {
      for (const leg of r.legs) {
        const swims = swimsOf.get(`${r.team}|${r.gender}|${leg.name}`) ?? [];
        const match = swims.find(s => s.event === leg.legEvent && s.time === leg.flatStartTime && s.timeType === 'SCY');
        expect(match, `${leg.name} ${leg.legEvent} ${leg.flatStartTime}`).toBeDefined();
      }
      expect(r.totalSec).toBe(Math.round(r.legs.reduce((sum, l) => sum + l.timeSec, 0) * 100) / 100);
    }
  });

  it('keeps every swimmer inside the total cap of 7 across individual rows and relays', () => {
    const entries = new Map<string, number>();
    const bump = (team: string, gender: string, name: string) => entries.set(`${team}|${gender}|${name}`, (entries.get(`${team}|${gender}|${name}`) ?? 0) + 1);
    for (const row of withRelays.seeds.rows) bump(row.team, row.gender as string, row.name);
    for (const r of withRelays.seeds.relayEntries) for (const l of r.legs) bump(r.team, r.gender, l.name);
    expect(entries.size).toBeGreaterThan(0);
    for (const [key, n] of entries) expect(n, key).toBeLessThanOrEqual(7);
    // Relays took capacity: some swimmer is at the cap.
    expect([...entries.values()].some(n => n === 7)).toBe(true);
  });

  it('adds relay rows to the workspace and leaves the individual rows of a build without relays alone', () => {
    const relayRows = [...withRelays.build.payload.menResults, ...withRelays.build.payload.womenResults].filter(r => r.isRelay === true);
    expect(relayRows).toHaveLength(withRelays.seeds.relayEntries.length * 4);
    expect(without.build.payload.menResults.some(r => r.isRelay === true)).toBe(false);
    expect(without.seeds.relayEntries).toEqual([]);
  });
});
