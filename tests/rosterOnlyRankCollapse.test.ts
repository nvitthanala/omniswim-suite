/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D8: a roster-only workspace (no meet rows, so no comparators) must not
 * collapse every row onto rank 1.
 *
 * ## Why this test exists
 *
 * `plans/2026-08-14/12-optimizer-destroys-score.md` section 2: with no meet PDF
 * `prepareRecruitsForScoring` found no comparators and gave all 281 rows of the
 * HSU roster plan (214 recruit rows and 67 planned entries) rank 1, round
 * "A Final". One event became one N-way tie group, the scorer-roster gate
 * `uniqueNames.every(...)` zeroed it as soon as one member was off, and a
 * 1277-point projection read 0.00. The fix landed 2026-09-02 (recruits are
 * placed against each other) and the report was never closed with a test that
 * names the case. This is that test.
 *
 * ## What it pins
 *
 * The inputs are CONSTRUCTED to the same shape as the real case: one men's
 * team, 14 events, 214 recruit rows plus 67 planned entries, every row without
 * a rank, every time distinct inside its event. Because the times are distinct
 * there is no real dead heat, so any shared rank is a fabricated tie.
 *
 * The same checks run over the real `HSU 2026-27 Roster Plan` when the
 * git-ignored `data/meets.json` is on this machine (skipped otherwise).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gender, type PlannedSwimEntry, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { GENERIC_TOP16_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { buildScoringBundle } from '../packages/core/src/lib/scoringEngine';
import { buildWhatIfProjection } from '../packages/core/src/lib/whatIfProjection';
import { calculatePoints, convertTimeToSeconds, prepareRecruitsForScoring } from '../packages/core/src/lib/utils';
import { SCORING_POINTS } from '../packages/core/src/constants';

const TEAM = 'Henderson State University';
const EVENTS = [
  '50 Freestyle', '100 Freestyle', '200 Freestyle', '500 Freestyle', '1000 Freestyle', '100 Backstroke', '200 Backstroke',
  '100 Breaststroke', '200 Breaststroke', '100 Butterfly', '200 Butterfly', '200 Individual Medley', '400 Individual Medley',
  '1650 Freestyle',
] as const;
const RECRUIT_ROWS = 214;
const PLAN_ROWS = 67;
const ATHLETES = 32;

const athleteName = (i: number): string => `Athlete ${String(i).padStart(2, '0')}`;
/** Distinct inside an event: slot `j` is 0.37 s slower than slot `j - 1`. */
const timeOf = (eventIndex: number, slot: number): string => {
  const seconds = 20 + eventIndex * 3 + slot * 0.37;
  return seconds.toFixed(2);
};

/** CONSTRUCTED roster-only men's workspace: 214 recruit rows, 67 planned entries, no meet rows. */
/** `recruitRows` is the same array as `workspace.recruits`, typed as the scored rows the engine reads. */
function constructedWorkspace(): { workspace: Workspace; rows: number; recruitRows: SwimmerResult[] } {
  const recruits: SwimmerResult[] = [];
  const plans: PlannedSwimEntry[] = [];
  let slotsLeftForRecruits = RECRUIT_ROWS;
  let slotsLeftForPlans = PLAN_ROWS;
  EVENTS.forEach((event, e) => {
    // Per event: 15 or 16 recruit slots, then 4 or 5 plan slots. Slots are distinct athletes.
    const recruitSlots = e < RECRUIT_ROWS - 14 * 15 ? 16 : 15;
    const planSlots = e < PLAN_ROWS - 14 * 4 ? 5 : 4;
    for (let j = 0; j < recruitSlots; j += 1) {
      const athlete = (e * 7 + j) % ATHLETES;
      recruits.push({
        id: `recruit-${e}-${j}`,
        rank: 0,
        name: athleteName(athlete),
        classYear: 'FR',
        team: TEAM,
        time: timeOf(e, j),
        points: 0,
        event,
        gender: Gender.MEN,
        isRecruit: true,
      } as SwimmerResult);
      slotsLeftForRecruits -= 1;
    }
    for (let j = 0; j < planSlots; j += 1) {
      const slot = recruitSlots + j;
      const athlete = (e * 7 + slot) % ATHLETES;
      plans.push({
        id: `plan-${e}-${j}`,
        name: athleteName(athlete),
        team: TEAM,
        gender: Gender.MEN,
        classYear: 'FR',
        event,
        time: timeOf(e, slot),
        timeType: 'SCY',
        source: 'optimizer',
        active: true,
      });
      slotsLeftForPlans -= 1;
    }
  });
  expect(slotsLeftForRecruits).toBe(0);
  expect(slotsLeftForPlans).toBe(0);
  const workspace = {
    id: 'ws-roster-only',
    name: 'Roster-only (constructed)',
    createdAt: 0,
    menResults: [],
    womenResults: [],
    recruits,
    meetEntryPlans: plans,
    activeEntryIds: plans.map(p => p.id),
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    scoringSettings: { ...GENERIC_TOP16_SETTINGS, maxIndividualScorersPerTeam: 999, maxIndividualEntriesPerSwimmer: 99 },
  } as unknown as Workspace;
  return { workspace, rows: RECRUIT_ROWS + PLAN_ROWS, recruitRows: recruits };
}

/** Rows grouped by the key the scoring engine ties on: event, round, rank. */
function tieGroups(rows: SwimmerResult[]): Map<string, SwimmerResult[]> {
  const groups = new Map<string, SwimmerResult[]>();
  for (const row of rows) {
    if (row.isRelay) continue;
    const key = `${row.event}|${row.roundSwam ?? ''}|${row.rank}`;
    const held = groups.get(key);
    if (held) held.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function expectNoFabricatedTie(rows: SwimmerResult[], eventCount: number): void {
  const groups = tieGroups(rows);
  for (const [key, members] of groups) {
    const times = new Set(members.map(m => convertTimeToSeconds(m.time)));
    expect(times.size, `a tie group of ${members.length} holds ${times.size} distinct times: ${key}`).toBe(1);
  }
  // The collapse made one group of every row: rank 1 for all 281.
  const rankOne = rows.filter(r => !r.isRelay && r.rank === 1);
  expect(rankOne.length).toBeLessThanOrEqual(eventCount * 2);
  expect(rankOne.length).toBeLessThan(rows.length / 4);
}

describe('D8 a real dead heat that straddles the scoring roster', () => {
  it('pays the scorer their tie share and the non-scorer nothing', () => {
    const rows = ['A', 'B', 'C'].map((initial, i) => ({
      id: `heat-${initial}`,
      rank: 0,
      name: `Heat ${initial}`,
      classYear: 'FR',
      team: TEAM,
      time: i < 2 ? '20.00' : '21.00',
      points: 0,
      event: '50 Freestyle',
      gender: Gender.MEN,
      isRecruit: true,
    })) as SwimmerResult[];
    const settings = {
      ...GENERIC_TOP16_SETTINGS,
      scorerEligibilityMode: 'roster' as const,
      maxIndividualScorersPerTeam: 999,
      maxIndividualEntriesPerSwimmer: 99,
    };
    const scored = calculatePoints(rows, settings, {
      scorerRosterOverrides: [{ name: 'Heat B', team: TEAM, gender: Gender.MEN, isScorer: false }],
    });
    const points = (name: string) => Number(scored.find(r => r.name === name)?.points);
    // A and B tie for 1st and 2nd: the shared place table, halved. B is off the roster, so B's half is forfeited.
    expect(points('Heat A')).toBe((SCORING_POINTS[0]! + SCORING_POINTS[1]!) / 2);
    expect(points('Heat B')).toBe(0);
    expect(points('Heat C')).toBe(SCORING_POINTS[2]);
  });
});

describe('D8 roster-only rank collapse', () => {
  it('places 281 unranked rows event by event, never as one tie', () => {
    const { workspace, rows, recruitRows } = constructedWorkspace();
    const unplaced = [
      ...recruitRows,
      ...(workspace.meetEntryPlans ?? []).map(
        p =>
          ({
            id: p.id,
            rank: 0,
            name: p.name,
            classYear: String(p.classYear),
            team: p.team,
            time: p.time,
            points: 0,
            event: p.event,
            gender: p.gender,
            isRecruit: true,
          }) as SwimmerResult
      ),
    ];
    expect(unplaced).toHaveLength(rows);
    expect(rows).toBe(281);
    const placed = prepareRecruitsForScoring([], unplaced);
    expect(placed).toHaveLength(281);

    const byEvent = new Map<string, SwimmerResult[]>();
    for (const row of placed) {
      const held = byEvent.get(row.event);
      if (held) held.push(row);
      else byEvent.set(row.event, [row]);
    }
    expect(byEvent.size).toBe(EVENTS.length);
    for (const [event, field] of byEvent) {
      const ranks = field.map(r => Number(r.rank)).sort((a, b) => a - b);
      // Distinct times: places are exactly 1..n, one row each.
      expect(ranks, event).toStrictEqual(field.map((_, i) => i + 1));
    }
    expect(placed.filter(r => r.rank === 1)).toHaveLength(EVENTS.length);
  });

  it('scores unranked recruit rows place by place without a projection in front', () => {
    // `calculatePoints` places an unranked recruit itself. The what-if
    // projection re-places every row before it, so only this path would still
    // show the collapse if `prepareRecruitsForScoring` regressed.
    const { workspace, recruitRows: recruits } = constructedWorkspace();
    const scored = calculatePoints(recruits, workspace.scoringSettings);
    const total = scored.reduce((sum, r) => sum + Number(r.points || 0), 0);
    // Each event pays the place table down to its last row, to 16 places at most.
    const rowsPerEvent = new Map<string, number>();
    for (const r of recruits) rowsPerEvent.set(r.event, (rowsPerEvent.get(r.event) ?? 0) + 1);
    let expected = 0;
    for (const count of rowsPerEvent.values()) {
      expected += SCORING_POINTS.slice(0, Math.min(count, 16)).reduce((a, b) => a + b, 0);
    }
    expect(rowsPerEvent.size).toBe(EVENTS.length);
    expect(total).toBe(expected);
    // No row holds a fractional share of a place: every award is a table value.
    const table = new Set(SCORING_POINTS.slice(0, 16));
    for (const row of scored) {
      const points = Number(row.points || 0);
      expect(points === 0 || table.has(points), `${row.event} ${row.name} scored ${points}`).toBe(true);
    }
  });

  it('keeps the projected field out of tie groups', () => {
    const { workspace } = constructedWorkspace();
    const rows = buildWhatIfProjection({ workspace, gender: Gender.MEN, removeSeniors: false }).rows;
    expect(rows).toHaveLength(281);
    expectNoFabricatedTie(rows, EVENTS.length);
  });

  it('scores the field place by place, with no event paying a shared share', () => {
    const { workspace } = constructedWorkspace();
    const bundle = buildScoringBundle({
      workspace,
      gender: Gender.MEN,
      removeSeniors: false,
      applyWhatIf: true,
      scorerRosterOverrides: [],
    });
    const team = bundle.sortedTeams.find(t => t.teamName === TEAM);
    // Independent expectation: the NCAA place table, copied from `constants.ts`,
    // paid to the top 16 of each of the 14 events.
    const perEvent = SCORING_POINTS.slice(0, 16).reduce((a, b) => a + b, 0);
    expect(team?.totalPoints).toBe(perEvent * EVENTS.length);
  });

  it('a non-scorer costs only their own points, not their events', () => {
    const { workspace } = constructedWorkspace();
    const settings = { ...workspace.scoringSettings!, scorerEligibilityMode: 'roster' as const };
    const off = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(i => ({
      name: athleteName(i),
      team: TEAM,
      gender: Gender.MEN,
      isScorer: false,
    }));
    const score = (overrides: typeof off) =>
      buildScoringBundle({
        workspace: { ...workspace, scoringSettings: settings },
        gender: Gender.MEN,
        removeSeniors: false,
        applyWhatIf: true,
        scorerRosterOverrides: overrides,
      });
    const allOn = score([]).sortedTeams.find(t => t.teamName === TEAM)?.totalPoints ?? 0;
    const bundle = score(off);
    const withOff = bundle.sortedTeams.find(t => t.teamName === TEAM)?.totalPoints ?? 0;
    // 1277 -> 0 was the failure. 14 of 32 off must leave most of the points.
    expect(allOn).toBeGreaterThan(0);
    expect(withOff).toBeGreaterThan(0);
    expect(withOff).toBeLessThan(allOn);
    // Every event that still has a scorer in its top 16 still pays.
    const offNames = new Set(off.map(o => o.name));
    const scoredEvents = new Set(
      bundle.allScored.filter(r => !r.isRelay && Number(r.points) > 0 && !offNames.has(r.name)).map(r => r.event)
    );
    expect(scoredEvents.size).toBe(EVENTS.length);
    // A non-scorer's own row scores nothing.
    expect(bundle.allScored.filter(r => !r.isRelay && offNames.has(r.name)).every(r => Number(r.points) === 0)).toBe(true);
  });
});

const localMeets = resolve(__dirname, '..', 'data', 'meets.json');
const hasLocalMeets = existsSync(localMeets);

describe.skipIf(!hasLocalMeets)('D8 on the real HSU 2026-27 Roster Plan (local data/meets.json)', () => {
  it('has no fabricated tie group', () => {
    const all = JSON.parse(readFileSync(join(localMeets), 'utf8')) as Workspace[];
    const workspace = all.find(w => w.name === 'HSU 2026-27 Roster Plan');
    expect(workspace, 'HSU 2026-27 Roster Plan is missing from data/meets.json').toBeDefined();
    expect(workspace!.menResults ?? []).toHaveLength(0);
    // 214 recruit rows + 67 planned entries = the 281 rows of the report.
    expect((workspace!.recruits ?? []).length + (workspace!.meetEntryPlans ?? []).length).toBe(281);
    const rows = buildWhatIfProjection({ workspace: workspace!, gender: Gender.MEN, removeSeniors: false }).rows;
    expect(rows.length).toBeGreaterThan(200);
    const events = new Set(rows.filter(r => !r.isRelay).map(r => r.event));
    expectNoFabricatedTie(rows, events.size);
    const team = buildScoringBundle({
      workspace: workspace!,
      gender: Gender.MEN,
      removeSeniors: false,
      applyWhatIf: true,
      scorerRosterOverrides: workspace!.scorerRosterOverrides,
    }).sortedTeams.find(t => t.teamName === TEAM);
    expect(team?.totalPoints ?? 0).toBeGreaterThan(0);
  });
});
