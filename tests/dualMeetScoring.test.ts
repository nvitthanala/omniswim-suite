/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A dual meet, scored end to end through `calculatePoints`.
 *
 * Before 2026-09-20 the suite could not represent one. `ScoringSettings` carried
 * relay scoring as `relayMultiplier`, a scalar on the individual table — exactly
 * right for all six championship field sizes and structurally wrong everywhere
 * else. NCAA Rule 7-1-1 scores a six-lane dual 9-4-3-2-1-0 for individuals and
 * 11-4-2-0 for relays, and 11 is not twice 9. Diving in the same meet scores off
 * Rule 7-1-4's own table with its own per-team cap.
 *
 * Every number asserted here is read out of `NCAA_FORMAT_RULESETS` — the
 * transcription of the archived rulebook PDF — and then also written as a
 * literal, so an upstream edition change breaks this file rather than quietly
 * re-baselining it.
 *
 * The per-team cap is additionally cross-checked against `computeNcaaEventScoring`,
 * the independently-written Rule 7 engine in the same repo, which acts as an
 * oracle: two implementations, one answer.
 */
import { describe, expect, it } from 'vitest';
import { calculatePoints } from '@omniswim/core/lib/utils';
import {
  settingsForBuiltInScoringPreset,
  GENERIC_TOP16_SETTINGS,
} from '@omniswim/core/lib/scoringDefaults';
import {
  NCAA_FORMAT_RULESETS,
  computeNcaaEventScoring,
  type NcaaPointTable,
  type NcaaScoringEntry,
} from '@omniswim/core/lib/ncaaScoringRules';
import { Gender, type ScoringSettings, type SwimmerResult } from '@omniswim/core/types';

const DUAL_6 = 'ncaa-dual-six-lanes-or-more';
const DUAL_6_PLUS_DIVING_6 = 'ncaa-dual-six-lanes-or-more-plus-dual-diving-six-or-more';

const SWIM_EVENT = 'Event 1 Men 200 Yard Freestyle';
const RELAY_EVENT = 'Event 2 Men 200 Yard Freestyle Relay';
const DIVE_EVENT = 'Event 3 Men 1 mtr Diving';

let seq = 0;

/** One individual swim. `rank` is the finish place the meet recorded. */
function swim(team: string, rank: number, opts: Partial<SwimmerResult> = {}): SwimmerResult {
  seq += 1;
  const time = `1:4${String(rank).padStart(1, '0')}.00`;
  return {
    id: `swim-${seq}`,
    rank,
    name: opts.name ?? `${team} ${rank}`,
    classYear: 'SR',
    team,
    time,
    finalsTime: time,
    roundSwam: 'Finals',
    points: 0,
    event: SWIM_EVENT,
    gender: Gender.MEN,
    ...opts,
  };
}

/** One relay entry, expanded to its four leg rows the way the parsers deliver it. */
function relayEntry(team: string, rank: number, suffix: string): SwimmerResult[] {
  const teamTime = `1:2${rank}.00`;
  return [0, 1, 2, 3].map(leg => {
    seq += 1;
    return {
      id: `relay-${seq}`,
      rank,
      name: `${team} ${suffix} leg ${leg + 1}`,
      classYear: 'SR',
      team,
      time: teamTime,
      finalsTime: teamTime,
      relayTeamTime: teamTime,
      roundSwam: 'Finals',
      points: 0,
      event: RELAY_EVENT,
      gender: Gender.MEN,
      isRelay: true,
      relayLegIndex: leg,
    } satisfies SwimmerResult;
  });
}

function teamTotals(rows: SwimmerResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.team] = (out[r.team] ?? 0) + Number(r.points);
  // Kill float noise from relay-leg division without hiding a real fraction.
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 1e6) / 1e6;
  return out;
}

/** Points by finish place, for one event, in place order. */
function pointsByPlace(rows: SwimmerResult[], event: string): number[] {
  return rows
    .filter(r => r.event === event && !r.isRelay)
    .sort((a, b) => a.rank - b.rank)
    .map(r => Number(r.points));
}

/** Team points per relay ENTRY (the four legs summed), in place order. */
function relayTeamPointsByPlace(rows: SwimmerResult[]): number[] {
  const byEntry = new Map<string, { rank: number; points: number }>();
  for (const r of rows.filter(x => x.isRelay)) {
    const key = `${r.team}|${r.rank}`;
    const cur = byEntry.get(key) ?? { rank: r.rank, points: 0 };
    cur.points += Number(r.points);
    byEntry.set(key, cur);
  }
  return [...byEntry.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(e => Math.round(e.points * 1e6) / 1e6);
}

const dual6 = NCAA_FORMAT_RULESETS['dual-six-lanes-or-more'];
const dualIndividual = dual6.individual as NcaaPointTable;
const dualRelay = dual6.relay as NcaaPointTable;
const diving6 = NCAA_FORMAT_RULESETS['dual-diving-six-or-more'].individual as NcaaPointTable;

describe('NCAA Rule 7-1-1 dual meet, six lanes or more', () => {
  it('scores individual events 9-4-3-2-1-0, straight off the published table', () => {
    // The literal and the rulebook constant must agree; if they diverge, the
    // transcription changed and this test is the place that says so.
    expect([...dualIndividual.places]).toEqual([9, 4, 3, 2, 1, 0]);

    const settings = settingsForBuiltInScoringPreset(DUAL_6);
    const rows = [
      swim('HSU', 1),
      swim('OBU', 2),
      swim('HSU', 3),
      swim('OBU', 4),
      swim('HSU', 5),
      swim('OBU', 6),
    ];

    const scored = calculatePoints(rows, settings);

    expect(pointsByPlace(scored, SWIM_EVENT)).toEqual([9, 4, 3, 2, 1, 0]);
    expect(teamTotals(scored)).toEqual({ HSU: 13, OBU: 6 });
  });

  it('scores relays 11-4-2-0, which is not the individual table doubled', () => {
    expect([...dualRelay.places]).toEqual([11, 4, 2, 0]);

    const settings = settingsForBuiltInScoringPreset(DUAL_6);
    const rows = [
      ...relayEntry('HSU', 1, 'A'),
      ...relayEntry('OBU', 2, 'A'),
      ...relayEntry('HSU', 3, 'B'),
      ...relayEntry('OBU', 4, 'B'),
    ];

    const scored = calculatePoints(rows, settings);

    expect(relayTeamPointsByPlace(scored)).toEqual([11, 4, 2, 0]);
    expect(teamTotals(scored)).toEqual({ HSU: 13, OBU: 4 });

    // The defect this field exists to close: a scalar multiplier on the dual
    // individual table would have paid 18-8-6, which no rule publishes.
    const doubled = dualIndividual.places.map(p => p * 2);
    expect(relayTeamPointsByPlace(scored)).not.toEqual(doubled.slice(0, 4));
  });

  it('leaves the multiplier path untouched when no relay table is supplied', () => {
    // Every preset saved before relayPoints existed must score exactly as it did.
    const rows = [...relayEntry('HSU', 1, 'A'), ...relayEntry('OBU', 2, 'A')];
    const scored = calculatePoints(rows, GENERIC_TOP16_SETTINGS);
    const expected = [
      GENERIC_TOP16_SETTINGS.scoringPoints[0] * GENERIC_TOP16_SETTINGS.relayMultiplier,
      GENERIC_TOP16_SETTINGS.scoringPoints[1] * GENERIC_TOP16_SETTINGS.relayMultiplier,
    ];
    expect(relayTeamPointsByPlace(scored)).toEqual(expected);
    expect(expected).toEqual([40, 34]);
  });
});

// ---------------------------------------------------------------------------
// "with only the best three contestants from each team scoring"
// ---------------------------------------------------------------------------

/** HSU enters four, OBU two, in a six-lane dual — the case the cap exists for. */
function fourVersusTwoField(): SwimmerResult[] {
  return [
    swim('HSU', 1),
    swim('HSU', 2),
    swim('HSU', 3),
    swim('HSU', 4),
    swim('OBU', 5),
    swim('OBU', 6),
  ];
}

/** The same field, as entries for the independent Rule 7 engine. */
function fourVersusTwoEntries(): NcaaScoringEntry[] {
  return fourVersusTwoField().map(r => ({ id: r.id, team: r.team, finishRank: r.rank }));
}

function ncaaEngineTotals(
  overCapBehavior: 'holds-place' | 'removed-from-consideration'
): Record<string, number> {
  const score = computeNcaaEventScoring(
    'dual-six-lanes-or-more',
    'individual',
    fourVersusTwoEntries(),
    { overCapBehavior }
  );
  return Object.fromEntries(score.teamTotals.map(t => [t.team, t.points]));
}

describe('per-team place cap (NCAA Rule 7-1-1)', () => {
  it("caps a team's fourth contestant out of the points", () => {
    expect(dualIndividual.maxScorersPerTeam).toBe(3);

    const settings = settingsForBuiltInScoringPreset(DUAL_6);
    expect(settings.maxIndividualScorersPerTeamPerEvent).toBe(3);

    const scored = calculatePoints(fourVersusTwoField(), settings);

    // holds-place (the rulebook's literal reading, and the default): the fourth
    // HSU swimmer keeps fourth place and scores nothing. Nobody advances, and
    // fourth place's two points are lost from the meet.
    expect(pointsByPlace(scored, SWIM_EVENT)).toEqual([9, 4, 3, 0, 1, 0]);
    expect(teamTotals(scored)).toEqual({ HSU: 16, OBU: 1 });
  });

  it('shifts the field up when the over-cap finisher is removed from consideration', () => {
    const settings: ScoringSettings = {
      ...settingsForBuiltInScoringPreset(DUAL_6),
      overCapPlaceBehavior: 'removed-from-consideration',
    };

    const scored = calculatePoints(fourVersusTwoField(), settings);

    // OBU's two swimmers were 5th and 6th on the sheet. With HSU's fourth
    // contestant removed they score fourth and fifth: 2 and 1, not 1 and 0.
    const byPlace = pointsByPlace(scored, SWIM_EVENT);
    expect(byPlace).toEqual([9, 4, 3, 0, 2, 1]);
    expect(teamTotals(scored)).toEqual({ HSU: 16, OBU: 3 });

    // The recorded finish places are untouched — only the scoring changed.
    const obuRanks = scored
      .filter(r => r.team === 'OBU')
      .map(r => r.rank)
      .sort((a, b) => a - b);
    expect(obuRanks).toEqual([5, 6]);
  });

  it('agrees with computeNcaaEventScoring, the independent Rule 7 engine', () => {
    const base = settingsForBuiltInScoringPreset(DUAL_6);

    expect(teamTotals(calculatePoints(fourVersusTwoField(), base))).toEqual(
      ncaaEngineTotals('holds-place')
    );

    expect(
      teamTotals(
        calculatePoints(fourVersusTwoField(), {
          ...base,
          overCapPlaceBehavior: 'removed-from-consideration',
        })
      )
    ).toEqual(ncaaEngineTotals('removed-from-consideration'));
  });

  it('caps relays at the best two per team (Rule 7-1-1)', () => {
    expect(dualRelay.maxScorersPerTeam).toBe(2);

    const settings = settingsForBuiltInScoringPreset(DUAL_6);
    expect(settings.maxRelaysScoringPerTeam).toBe(2);

    const rows = [
      ...relayEntry('HSU', 1, 'A'),
      ...relayEntry('HSU', 2, 'B'),
      ...relayEntry('HSU', 3, 'C'),
      ...relayEntry('OBU', 4, 'A'),
    ];
    const scored = calculatePoints(rows, settings);

    // HSU's third relay is past the cap and scores nothing; OBU's entry keeps
    // the fourth place it finished in, worth 0 on this table.
    expect(relayTeamPointsByPlace(scored)).toEqual([11, 4, 0, 0]);
    expect(teamTotals(scored)).toEqual({ HSU: 15, OBU: 0 });
  });

  it('does nothing at all when the field is absent', () => {
    const { maxIndividualScorersPerTeamPerEvent: _drop, ...uncapped } =
      settingsForBuiltInScoringPreset(DUAL_6);
    const scored = calculatePoints(fourVersusTwoField(), uncapped as ScoringSettings);
    expect(pointsByPlace(scored, SWIM_EVENT)).toEqual([9, 4, 3, 2, 1, 0]);
    expect(teamTotals(scored)).toEqual({ HSU: 18, OBU: 1 });
  });

  it('refuses a cap value that is not a positive integer rather than scoring around it', () => {
    const settings: ScoringSettings = {
      ...settingsForBuiltInScoringPreset(DUAL_6),
      maxIndividualScorersPerTeamPerEvent: 0,
    };
    expect(() => calculatePoints(fourVersusTwoField(), settings)).toThrow(
      /maxIndividualScorersPerTeamPerEvent must be a positive integer/
    );
  });

  it('refuses to combine a per-event place cap with a meet-wide scorer pool', () => {
    const settings: ScoringSettings = {
      ...settingsForBuiltInScoringPreset(DUAL_6),
      maxIndividualScorersPerTeam: 18,
      scorerCapScope: 'meet',
    };
    expect(() => calculatePoints(fourVersusTwoField(), settings)).toThrow(
      /disagree about whether a contestant who takes a place but scores nothing/
    );
  });
});

// ---------------------------------------------------------------------------
// Diving scores off its own table, in the same meet (Rule 7-1-4)
// ---------------------------------------------------------------------------

function dive(team: string, rank: number): SwimmerResult {
  return swim(team, rank, { event: DIVE_EVENT, name: `${team} diver ${rank}` });
}

describe('NCAA Rule 7-1-4 diving inside a Rule 7-1-1 dual meet', () => {
  it('scores the diving event off the diving table and the swim off the swim table', () => {
    expect([...diving6.places]).toEqual([16, 13, 12, 11, 10, 9, 7, 5, 4, 3, 2, 1]);

    const settings = settingsForBuiltInScoringPreset(DUAL_6_PLUS_DIVING_6);
    expect(settings.divingPoints).toEqual([...diving6.places]);

    const rows = [
      swim('HSU', 1),
      swim('OBU', 2),
      swim('HSU', 3),
      dive('HSU', 1),
      dive('OBU', 2),
      dive('HSU', 3),
      dive('OBU', 4),
    ];
    const scored = calculatePoints(rows, settings);

    expect(pointsByPlace(scored, SWIM_EVENT)).toEqual([9, 4, 3]);
    expect(pointsByPlace(scored, DIVE_EVENT)).toEqual([16, 13, 12, 11]);
  });

  it("uses diving's own per-team cap, not the swimming meet's", () => {
    expect(diving6.maxScorersPerTeam).toBe(6);
    expect(dualIndividual.maxScorersPerTeam).toBe(3);

    const settings = settingsForBuiltInScoringPreset(DUAL_6_PLUS_DIVING_6);
    expect(settings.maxIndividualScorersPerTeamPerEvent).toBe(3);
    expect(settings.divingMaxScorersPerTeamPerEvent).toBe(6);

    // HSU enters seven divers. Six may score; the seventh may not.
    const rows = [
      ...[1, 2, 3, 4, 5, 6, 7].map(place => dive('HSU', place)),
      dive('OBU', 8),
    ];
    const scored = calculatePoints(rows, settings);

    // If the SWIMMING cap of three had leaked into the diving event, places
    // four, five and six would all be zero here.
    expect(pointsByPlace(scored, DIVE_EVENT)).toEqual([16, 13, 12, 11, 10, 9, 0, 5]);
    expect(teamTotals(scored)).toEqual({ HSU: 71, OBU: 5 });
  });
});
