/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tied relay entries split the points of every place the tie spans, through the
 * same helper tied individual swims use (user decision U1, 2026-10-12). And a
 * place past the end of a place-point table reads as ABSENT (`null`) at the
 * lookup, never as a silent 0 (user decision U5).
 *
 * Each case names the fix it pins. Reverting that fix must turn the case red:
 *  - tie count forced to 1                       -> the 2-way, 3-way and straddle cases
 *  - `tiedPlaceShare` truncated to one place     -> every case that compares a tie
 *  - `placePointAt` returns 0 instead of null    -> the null cases
 *  - `pointsForPlacementOrNull` returns 0 for a
 *    place the table has no row for              -> the pointsForPlacementOrNull cases
 *
 * Synthetic rows. The real 2026 NSISC results hold no relay dead heat, so these
 * cases do not read data/meets.json.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult } from '../packages/core/src/types';
import {
  calculatePoints,
  placePointAt,
  relayEntryGroupKey,
  pointsForPlacement,
  pointsForPlacementOrNull,
  relayTeamPointsForIndex,
  simulateRoster,
  tiedPlaceShare,
} from '../packages/core/src/lib/utils';
import {
  NSISC_PRESET_SETTINGS,
  settingsForBuiltInScoringPreset,
} from '../packages/core/src/lib/scoringDefaults';
import { computeNcaaEventScoring } from '../packages/core/src/lib/ncaaScoringRules';

const RELAY_EVENT = 'Event 2 Men 200 Yard Freestyle Relay';
const IND_EVENT = 'Event 3 Men 100 Yard Freestyle';

/** One relay entry as four leg rows, the way the HyTek parser stores it. */
function relayEntry(team: string, rank: number, clock: string): SwimmerResult[] {
  const legs = [0, 1, 2, 3].map(i => `${team} Leg ${i + 1}`);
  return legs.map((name, i) => ({
    id: `${team}-relay-${i}`,
    rank,
    name,
    classYear: 'JR',
    team,
    time: clock,
    finalsTime: clock,
    relayTeamTime: clock,
    roundSwam: 'A Final',
    points: 0,
    event: RELAY_EVENT,
    gender: Gender.MEN,
    isRelay: true,
    relayLegIndex: i,
    relayNames: legs.map(n => ({ name: n, year: 'JR' })),
  })) as SwimmerResult[];
}

function individual(team: string, rank: number, time: string): SwimmerResult {
  return {
    id: `${team}-ind`,
    rank,
    name: `${team} Swimmer`,
    classYear: 'JR',
    team,
    time,
    finalsTime: time,
    roundSwam: 'A Final',
    points: 0,
    event: IND_EVENT,
    gender: Gender.MEN,
  } as SwimmerResult;
}

type Field = Array<{ team: string; rank: number; clock: string }>;

/** Team points of the relay field: one entry's four legs summed. */
function relayTeamPoints(field: Field, settings: ScoringSettings): Record<string, number> {
  const rows = field.flatMap(f => relayEntry(f.team, f.rank, f.clock));
  const out: Record<string, number> = {};
  for (const r of calculatePoints(rows, settings)) out[r.team] = (out[r.team] ?? 0) + Number(r.points ?? 0);
  return out;
}

function individualPoints(field: Field, settings: ScoringSettings): Record<string, number> {
  const rows = field.map(f => individual(f.team, f.rank, f.clock));
  const out: Record<string, number> = {};
  for (const r of calculatePoints(rows, settings)) out[r.team] = (out[r.team] ?? 0) + Number(r.points ?? 0);
  return out;
}

const field = (...ranks: number[]): Field =>
  ranks.map((rank, i) => ({
    team: `Team${String.fromCharCode(65 + i)}`,
    rank,
    // Equal clocks for equal ranks, so a tie is a real dead heat; later ranks are slower.
    clock: `1:${String(20 + rank).padStart(2, '0')}.00`,
  }));

describe('the shared tie helper', () => {
  const table = [20, 17, 16];

  it('adds the places the tie spans and divides by the tied count', () => {
    expect(tiedPlaceShare(table, 0, 1)).toBe(20);
    expect(tiedPlaceShare(table, 0, 2)).toBe(18.5); // (20 + 17) / 2
    expect(tiedPlaceShare(table, 0, 3)).toBeCloseTo((20 + 17 + 16) / 3, 10);
    expect(tiedPlaceShare(table, 1, 2)).toBe(16.5); // (17 + 16) / 2
  });

  it('counts a place the table does not reach as 0 and keeps the divisor (the straddle)', () => {
    expect(tiedPlaceShare(table, 2, 2)).toBe(8); // (16 + nothing) / 2, not 16
    expect(tiedPlaceShare(table, 1, 3)).toBeCloseTo((17 + 16) / 3, 10);
  });

  it('is null, not 0 and not NaN, when no spanned place has a value', () => {
    expect(tiedPlaceShare(table, 3, 2)).toBeNull();
    expect(tiedPlaceShare([], 0, 1)).toBeNull();
    expect(tiedPlaceShare(table, 0, 0)).toBeNull();
    expect(tiedPlaceShare(table, 0, Number.NaN)).toBeNull();
  });

  it('treats a blank cell as no value, never as 0', () => {
    expect(placePointAt([11, null, 2], 1)).toBeNull();
    expect(placePointAt([11, 0, 2], 1)).toBe(0);
    expect(tiedPlaceShare([11, null, 2], 0, 2)).toBe(5.5); // (11 + nothing) / 2
  });
});

describe('a place past the end of a table is null at the lookup', () => {
  it('placePointAt: past the end is null, a real 0 cell is 0', () => {
    expect(placePointAt([11, 4, 2, 0], 3)).toBe(0);
    expect(placePointAt([11, 4, 2, 0], 4)).toBeNull();
    expect(placePointAt([11, 4, 2, 0], -1)).toBeNull();
    // typeof NaN is 'number'; a non-finite cell is not a value.
    expect(placePointAt([11, Number.NaN, Number.POSITIVE_INFINITY], 1)).toBeNull();
    expect(placePointAt([11, Number.NaN, Number.POSITIVE_INFINITY], 2)).toBeNull();
  });

  describe('individual table (pointsForPlacementOrNull)', () => {
    const dual = settingsForBuiltInScoringPreset('ncaa-dual-six-lanes-or-more'); // 9-4-3-2-1-0
    const EVENT = 'Event 5 Men 100 Yard Backstroke';

    it('6th place is a real 0; 7th place has no table row and is null', () => {
      expect(pointsForPlacementOrNull('A Final', 5, EVENT, dual)).toBe(1);
      expect(pointsForPlacementOrNull('A Final', 6, EVENT, dual)).toBe(0);
      expect(pointsForPlacementOrNull('A Final', 7, EVENT, dual)).toBeNull();
    });

    it('a place the rules score nothing for stays 0, not null', () => {
      expect(pointsForPlacementOrNull('A Final', 0, EVENT, dual)).toBe(0);
      expect(pointsForPlacementOrNull('C Final', 1, EVENT, dual)).toBe(0);
    });

    it('pointsForPlacement keeps its number contract: past the end is still 0', () => {
      expect(pointsForPlacement('A Final', 7, EVENT, dual)).toBe(0);
      expect(pointsForPlacement('A Final', 1, EVENT, dual)).toBe(9);
    });

    it('NSISC: 16th scores 1, 17th has no row', () => {
      expect(pointsForPlacementOrNull('A Final', 16, EVENT, NSISC_PRESET_SETTINGS)).toBe(1);
      expect(pointsForPlacementOrNull('A Final', 17, EVENT, NSISC_PRESET_SETTINGS)).toBeNull();
    });
  });

  describe('relay table (relayTeamPointsForIndex)', () => {
    it('explicit relayPoints 11-4-2-0: the 0 cell is 0, the next index is null', () => {
      const dual = settingsForBuiltInScoringPreset('ncaa-dual-six-lanes-or-more');
      expect(relayTeamPointsForIndex(dual, 0)).toBe(11);
      expect(relayTeamPointsForIndex(dual, 3)).toBe(0);
      expect(relayTeamPointsForIndex(dual, 4)).toBeNull();
    });

    it('multiplier path: scoringPoints x relayMultiplier, null past the individual table', () => {
      expect(relayTeamPointsForIndex(NSISC_PRESET_SETTINGS, 0)).toBe(40);
      expect(relayTeamPointsForIndex(NSISC_PRESET_SETTINGS, 15)).toBe(2);
      expect(relayTeamPointsForIndex(NSISC_PRESET_SETTINGS, 16)).toBeNull();
    });
  });

  it('a relay finishing past an explicit relay table scores no points, and no row reads null or NaN', () => {
    const dual = settingsForBuiltInScoringPreset('ncaa-dual-six-lanes-or-more'); // relay 11-4-2-0
    const rows = [
      ...relayEntry('TeamA', 1, '1:20.00'),
      ...relayEntry('TeamB', 4, '1:23.00'), // the 0 cell
      ...relayEntry('TeamC', 5, '1:24.00'), // past the table
    ];
    const scored = calculatePoints(rows, dual);
    for (const r of scored) expect(Number.isFinite(r.points)).toBe(true);
    const teamTotal = (team: string) => scored.filter(r => r.team === team).reduce((s, r) => s + (r.points as number), 0);
    expect(teamTotal('TeamA')).toBe(11);
    expect(teamTotal('TeamB')).toBe(0);
    expect(teamTotal('TeamC')).toBe(0);
  });
});

describe('tied relays split the places the tie spans', () => {
  it('two relays tied for 1st share 1st and 2nd: (40 + 34) / 2 = 37 each under the NSISC table', () => {
    const points = relayTeamPoints(field(1, 1, 3), NSISC_PRESET_SETTINGS);
    expect(points.TeamA).toBe(37);
    expect(points.TeamB).toBe(37);
    expect(points.TeamC).toBe(32); // third place, 2 x 16: the tie consumed places 1 and 2
  });

  it('three relays tied for 1st share 1st, 2nd and 3rd: (40 + 34 + 32) / 3 each', () => {
    const points = relayTeamPoints(field(1, 1, 1, 4), NSISC_PRESET_SETTINGS);
    const each = (40 + 34 + 32) / 3;
    expect(points.TeamA).toBeCloseTo(each, 10);
    expect(points.TeamB).toBeCloseTo(each, 10);
    expect(points.TeamC).toBeCloseTo(each, 10);
    expect(points.TeamD).toBe(30); // fourth place, 2 x 15
    // The event pays out exactly what its table holds for those four places.
    const paid = points.TeamA! + points.TeamB! + points.TeamC! + points.TeamD!;
    expect(paid).toBeCloseTo(40 + 34 + 32 + 30, 10);
  });

  it('a tie in the middle of the field splits only its own places', () => {
    const points = relayTeamPoints(field(1, 2, 2, 4), NSISC_PRESET_SETTINGS);
    expect(points.TeamA).toBe(40);
    expect(points.TeamB).toBe((34 + 32) / 2);
    expect(points.TeamC).toBe((34 + 32) / 2);
    expect(points.TeamD).toBe(30);
  });

  it('agrees with the repo Rule 7-8 model (computeNcaaEventScoring) on the real 16-place table', () => {
    const f = field(1, 2, 2, 4);
    const settings = settingsForBuiltInScoringPreset('ncaa-championship-16');
    const engine = relayTeamPoints(f, settings);
    const rule7 = computeNcaaEventScoring(
      'championship-16',
      'relay',
      f.map(x => ({ id: x.team, team: x.team, finishRank: x.rank, final: 'championship' as const }))
    );
    expect(engine).toEqual(Object.fromEntries(rule7.teamTotals.map(t => [t.team, t.points])));
  });

  it('a field with no tie is unchanged: each relay takes the full value of its place', () => {
    const points = relayTeamPoints(field(1, 2, 3), NSISC_PRESET_SETTINGS);
    expect(points).toEqual({ TeamA: 40, TeamB: 34, TeamC: 32 });
  });
});

describe('a tie that straddles the last scoring place', () => {
  it('two relays tied for 8th in an 8-place table: (pts8 + 0) / 2 each, never pts8 each', () => {
    const settings = settingsForBuiltInScoringPreset('ncaa-championship-8'); // relay ...,4,2
    const points = relayTeamPoints(field(1, 2, 3, 4, 5, 6, 7, 8, 8), settings);
    // Place 8 is worth 2; place 9 is not in the table. (2 + nothing) / 2 = 1 each.
    expect(points.TeamH).toBe(1);
    expect(points.TeamI).toBe(1);
    for (const v of Object.values(points)) expect(Number.isFinite(v)).toBe(true);
  });

  it('agrees with the repo Rule 7-8 model on the same straddle', () => {
    const f = field(1, 2, 3, 4, 5, 6, 7, 8, 8);
    const settings = settingsForBuiltInScoringPreset('ncaa-championship-8');
    const rule7 = computeNcaaEventScoring(
      'championship-8',
      'relay',
      f.map(x => ({ id: x.team, team: x.team, finishRank: x.rank, final: 'championship' as const }))
    );
    expect(relayTeamPoints(f, settings)).toEqual(Object.fromEntries(rule7.teamTotals.map(t => [t.team, t.points])));
  });

  it('two individuals tied for 8th in the same 8-place table also take (pts8 + 0) / 2 each', () => {
    const settings = settingsForBuiltInScoringPreset('ncaa-championship-8'); // individual ...,2,1
    const points = individualPoints(field(1, 2, 3, 4, 5, 6, 7, 8, 8), settings);
    expect(points.TeamH).toBe(0.5);
    expect(points.TeamI).toBe(0.5);
  });
});

describe('relays and individuals tie through one helper', () => {
  // NSISC relays pay relayMultiplier (2) x the individual table, so a relay tie
  // share must be exactly the multiplier times the individual tie share.
  const mult = NSISC_PRESET_SETTINGS.relayMultiplier;

  it.each([
    ['2-way tie for 1st', field(1, 1, 3)],
    ['3-way tie for 1st', field(1, 1, 1, 4)],
    ['2-way tie mid-field', field(1, 2, 2, 4)],
    ['2-way tie straddling the 16th place', field(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 16)],
  ] as Array<[string, Field]>)('%s', (_label, f) => {
    const rel = relayTeamPoints(f, NSISC_PRESET_SETTINGS);
    const ind = individualPoints(f, NSISC_PRESET_SETTINGS);
    expect(Object.keys(rel).sort()).toEqual(Object.keys(ind).sort());
    for (const team of Object.keys(ind)) expect(rel[team]).toBeCloseTo(ind[team]! * mult, 10);
  });

  it('pins the user-named example once: 1st and 2nd tied is (20 + 17) / 2 = 18.5 each for individuals, (40 + 34) / 2 = 37 each for relays', () => {
    expect(individualPoints(field(1, 1), NSISC_PRESET_SETTINGS)).toEqual({ TeamA: 18.5, TeamB: 18.5 });
    expect(relayTeamPoints(field(1, 1), NSISC_PRESET_SETTINGS)).toEqual({ TeamA: 37, TeamB: 37 });
  });
});

describe('a tie does not depend on whether a relay names its gender', () => {
  // SwimmerResult.gender is optional, and every caller of calculatePoints passes the rows of one
  // gender. A tie key that read gender would un-split a tie between a relay that names it and one
  // that does not: {A: 40, B: 40}, 6 points more than the two places hold.
  const withoutGender = (rows: SwimmerResult[]): SwimmerResult[] =>
    rows.map(r => ({ ...r, gender: undefined }));

  it('two tied relays, one with no gender: both score (40 + 34) / 2 = 37', () => {
    const rows = [...relayEntry('TeamA', 1, '1:20.00'), ...withoutGender(relayEntry('TeamB', 1, '1:20.00'))];
    const scored = calculatePoints(rows, NSISC_PRESET_SETTINGS);
    const total = (team: string) => scored.filter(r => r.team === team).reduce((sum, r) => sum + (r.points as number), 0);
    expect(total('TeamA')).toBe(37);
    expect(total('TeamB')).toBe(37);
  });
});

describe("one team's A and B relays on a dead heat stay two entries", () => {
  // The same team name on both (no relay letter is stored on a row), the same event, round, place
  // and clock. Only the four named swimmers tell them apart.
  const entryWith = (team: string, swimmers: string[], rank: number, clock: string): SwimmerResult[] =>
    swimmers.map((name, i) => ({
      id: `${team}-${swimmers[0]}-${i}`,
      rank,
      name,
      classYear: 'JR',
      team,
      time: clock,
      finalsTime: clock,
      relayTeamTime: clock,
      roundSwam: 'A Final',
      points: 0,
      event: RELAY_EVENT,
      gender: Gender.MEN,
      isRelay: true,
      relayLegIndex: i,
      relayNames: swimmers.map(n => ({ name: n, year: 'JR' })),
    })) as SwimmerResult[];

  const A = ['A1', 'A2', 'A3', 'A4'];
  const B = ['B1', 'B2', 'B3', 'B4'];
  const total = (rows: SwimmerResult[], team: string) =>
    rows.filter(r => r.team === team).reduce((sum, r) => sum + (r.points as number), 0);

  it('A and B tied for 2nd behind Z: each takes (34 + 32) / 2 = 33, the team 66, not 68', () => {
    const rows = [
      ...entryWith('Z', ['Z1', 'Z2', 'Z3', 'Z4'], 1, '1:20.00'),
      ...entryWith('Home', A, 2, '1:21.00'),
      ...entryWith('Home', B, 2, '1:21.00'),
    ];
    const scored = calculatePoints(rows, NSISC_PRESET_SETTINGS);
    expect(total(scored, 'Z')).toBe(40);
    expect(total(scored, 'Home')).toBe(66);
    // Eight legs, each a quarter of an entry's 33.
    expect(scored.filter(r => r.team === 'Home').every(r => r.points === 33 / 4)).toBe(true);
  });

  it('counts two entries against the per-team relay cap, not one', () => {
    // Cap of 1 scoring relay per team: A and B tied for 1st, only one may score.
    const rows = [...entryWith('Home', A, 1, '1:20.00'), ...entryWith('Home', B, 1, '1:20.00')];
    const capped = { ...NSISC_PRESET_SETTINGS, maxRelaysScoringPerTeam: 1 };
    const scored = calculatePoints(rows, capped);
    // One entry scores its share of 1st and 2nd (37); the other is over the cap and scores 0.
    expect(total(scored, 'Home')).toBe(37);
    expect(scored.filter(r => (r.points as number) > 0)).toHaveLength(4);
  });

  it('two A/B relays of one team that did not tie are unchanged', () => {
    const rows = [...entryWith('Home', A, 1, '1:20.00'), ...entryWith('Home', B, 2, '1:21.00')];
    expect(total(calculatePoints(rows, NSISC_PRESET_SETTINGS), 'Home')).toBe(40 + 34);
  });

  it('relayEntryGroupKey differs between the two entries and matches across one entry', () => {
    const a = entryWith('Home', A, 2, '1:21.00');
    const b = entryWith('Home', B, 2, '1:21.00');
    expect(new Set(a.map(relayEntryGroupKey)).size).toBe(1);
    expect(new Set(b.map(relayEntryGroupKey)).size).toBe(1);
    expect(relayEntryGroupKey(a[0]!)).not.toBe(relayEntryGroupKey(b[0]!));
  });

  it('a row that names no swimmers keeps the previous key', () => {
    const row = { ...entryWith('Home', A, 2, '1:21.00')[0]!, relayNames: undefined };
    expect(relayEntryGroupKey(row)).toBe(`${RELAY_EVENT}|Home|A Final|2|1:21.00`);
  });
});

describe("one team's A and B relays on a dead heat stay two entries in the roster simulation", () => {
  // `simulateRoster` groups relay legs by `relayGroupKey`. Without the named swimmers in the key the
  // two entries became one eight-leg group: the senior's removal vacated a leg of the merged group
  // and the B relay's legs were written back over the A relay's four.
  const legs = (swimmers: string[], years: string[], clock: string): SwimmerResult[] =>
    swimmers.map((name, i) => ({
      id: `${swimmers[0]}-${i}`,
      rank: 2,
      name,
      classYear: years[i],
      team: 'Home',
      time: clock,
      finalsTime: clock,
      relayTeamTime: clock,
      roundSwam: 'A Final',
      points: 0,
      event: RELAY_EVENT,
      gender: Gender.MEN,
      isRelay: true,
      relayLegIndex: i,
      relayLegSplit: '20.00',
      relayNames: swimmers.map((n, j) => ({ name: n, year: years[j] })),
    })) as SwimmerResult[];

  it('removing the A relay senior vacates that leg only; the B relay is returned untouched', () => {
    const a = legs(['A1', 'A2', 'A3', 'A4'], ['SR', 'FR', 'FR', 'FR'], '1:21.00');
    const b = legs(['B1', 'B2', 'B3', 'B4'], ['FR', 'FR', 'FR', 'FR'], '1:21.00');
    const out = simulateRoster([...a, ...b], [], true);
    expect(out).toHaveLength(8);
    const bOut = out.filter(r => r.name.startsWith('B'));
    expect(bOut.map(r => r.name)).toEqual(['B1', 'B2', 'B3', 'B4']);
    expect(bOut.every(r => r.time === '1:21.00' && !r.relayLegVacant)).toBe(true);
    // The A relay lost its senior: one vacant leg, and the clock moved off the B relay's.
    const aOut = out.filter(r => !r.name.startsWith('B'));
    expect(aOut).toHaveLength(4);
    expect(aOut.filter(r => r.relayLegVacant)).toHaveLength(1);
    expect(aOut.every(r => r.time !== '1:21.00')).toBe(true);
  });

  it('with nobody removed the simulation does not run and both entries pass through', () => {
    const a = legs(['A1', 'A2', 'A3', 'A4'], ['FR', 'FR', 'FR', 'FR'], '1:21.00');
    const b = legs(['B1', 'B2', 'B3', 'B4'], ['FR', 'FR', 'FR', 'FR'], '1:21.00');
    expect(simulateRoster([...a, ...b], [], false)).toHaveLength(8);
  });
});
