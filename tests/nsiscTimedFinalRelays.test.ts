/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression: under the NSISC preset in computed mode (`usePdfPlacePoints:
 * false`, roster-gated) a relay swum as a timed final scored 0. A relay has no
 * A or B heat, so its round is "Timed Finals" (SwimCloud) or "Finals" (HyTek),
 * tier `FIN`. The scorer roster counted only A and B tiers, so no relay leg was
 * a scorer and every relay entry was zeroed. Found on SwimCloud meet 356467,
 * where the published relay points were 652 (men) and 950 (women).
 */
import { describe, expect, it } from 'vitest';
import { Gender, type SwimmerResult } from '../packages/core/src/types';
import { calculatePoints } from '../packages/core/src/lib/calculatePoints';
import { settingsForBuiltInScoringPreset } from '../packages/core/src/lib/scoringDefaults';
import { buildScorerRosterLookup, relayEntryRosterEligible, rowSuggestsScorer } from '../packages/core/src/lib/scorerRoster';
import { computeVacateRelayLegNames } from '../packages/core/src/lib/rosterLineupAudit';

const RELAY = '200 Medley Relay';

function leg(team: string, rank: number, name: string, round: string, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  return {
    id: `${team}-${rank}-${name}`,
    rank,
    name,
    team,
    classYear: 'unknown',
    time: `1:${30 + rank}.00`,
    event: RELAY,
    gender: Gender.MEN,
    roundSwam: round,
    isRelay: true,
    points: 0,
    ...extra,
  } as SwimmerResult;
}

function entry(team: string, rank: number, round = 'Timed Finals'): SwimmerResult[] {
  return ['A', 'B', 'C', 'D'].map(n => leg(team, rank, `${team} ${n}`, round));
}

const computed = () => ({
  ...settingsForBuiltInScoringPreset('nsisc'),
  usePdfPlacePoints: false,
});

describe('NSISC relays swum as a timed final', () => {
  it('score in computed mode: 40 and 34 team points, split over four legs', () => {
    const rows = [...entry('Alpha', 1), ...entry('Beta', 2)];
    const scored = calculatePoints(rows, computed());
    const total = (team: string) =>
      scored.filter(r => r.team === team).reduce((a, r) => a + Number(r.points ?? 0), 0);
    expect(total('Alpha')).toBe(40);
    expect(total('Beta')).toBe(34);
    for (const r of scored) expect(r.points).toBe(r.team === 'Alpha' ? 10 : 8.5);
  });

  it('also score when the round label is a bare "Finals"', () => {
    const scored = calculatePoints(entry('Alpha', 1, 'Finals'), computed());
    expect(scored.reduce((a, r) => a + Number(r.points ?? 0), 0)).toBe(40);
  });

  it('a timed-final relay is roster-eligible without a lookup, unless relay legs are switched off', () => {
    const s = computed();
    expect(relayEntryRosterEligible(entry('Alpha', 1), s)).toBe(true);
    const off = { ...s, scorerAutoRules: { ...s.scorerAutoRules, includeRelayLegsInFinals: false } };
    expect(relayEntryRosterEligible(entry('Alpha', 1), off)).toBe(false);
  });

  it('a prelim relay row still does not mark scorers', () => {
    expect(relayEntryRosterEligible(entry('Alpha', 1, 'Preliminaries'), computed())).toBe(false);
  });
});

describe('HyTek-shaped "Finals" relay: legs of a timed-final relay are scorers', () => {
  const LEGS = ['Ann Lee', 'Bo Kim', 'Cy Roe', 'Di Fox'];
  const FREE = '100 Yard Freestyle';
  /** Per-leg relay rows (HyTek prints a relay as one row per swimmer) plus Ann's individual A final. */
  const meet = (): SwimmerResult[] => [
    ...LEGS.map((n, i) =>
      leg('Alpha', 1, n, 'Finals', { id: `Alpha-${n}`, relayLegIndex: i, time: '1:30.00' })
    ),
    leg('Alpha', 1, 'Ann Lee', 'A Final', { id: 'Alpha-Ann-ind', isRelay: false, event: FREE, time: '45.00' }),
  ];
  const pointsOf = (rows: SwimmerResult[]) =>
    rows.filter(r => r.isRelay).reduce((a, r) => a + Number(r.points ?? 0), 0);

  it('only Ann swam an A final, yet Bo, Cy and Di are not vacated', () => {
    const vacated = computeVacateRelayLegNames(meet(), Gender.MEN, computed(), []);
    expect([...vacated]).toEqual([]);
  });

  it('the relay scores, so the projection and the scorer agree', () => {
    const scored = calculatePoints(meet(), computed());
    expect(pointsOf(scored)).toBe(40);
    expect(scored.filter(r => r.isRelay).map(r => r.points)).toEqual([10, 10, 10, 10]);
  });

  it('a leg marked a non-scorer by hand: the relay still scores, as an A or B final relay does', () => {
    const bo = [{ name: 'Bo Kim', team: 'Alpha', gender: Gender.MEN, isScorer: false }];
    const scored = calculatePoints(meet(), computed(), { scorerRosterOverrides: bo });
    expect(pointsOf(scored)).toBe(40);

    const aFinal = meet().map(r => (r.isRelay ? { ...r, roundSwam: 'A Final' } : r));
    expect(pointsOf(calculatePoints(aFinal, computed(), { scorerRosterOverrides: bo }))).toBe(40);

    // The projection still vacates Bo's leg: the manual flag wins on the roster, and the
    // relay's score does not depend on it. The same holds for an A or B final relay.
    expect([...computeVacateRelayLegNames(meet(), Gender.MEN, computed(), bo)]).toEqual(['bo kim']);
    expect([...computeVacateRelayLegNames(aFinal, Gender.MEN, computed(), bo)]).toEqual(['bo kim']);
  });

  it('a relay-only leg of a timed-final relay is an auto-scorer; an individual timed final is not', () => {
    const rules = computed().scorerAutoRules;
    expect(rowSuggestsScorer(leg('Alpha', 1, 'Bo Kim', 'Finals'), rules)).toBe(true);
    expect(rowSuggestsScorer(leg('Alpha', 1, 'Bo Kim', 'Timed Finals'), rules)).toBe(true);
    const mile = leg('Alpha', 1, 'Bo Kim', 'Timed Finals', { isRelay: false, event: '1650 Yard Freestyle' });
    expect(rowSuggestsScorer(mile, rules)).toBe(false);
    expect(rowSuggestsScorer(leg('Alpha', 1, 'Bo Kim', 'Preliminaries'), rules)).toBe(false);
  });
});

describe('SwimCloud-shaped entry rows (one row per entry, legs in relayNames)', () => {
  const legs = [{ name: 'Ann Lee', year: '' }, { name: 'Bo Kim', year: '' }];
  const entryRow = (round: string) =>
    leg('Alpha', 1, 'Alpha (A)', round, { relayNames: legs });

  it('a timed-final entry row marks no auto-scorer', () => {
    const rules = computed().scorerAutoRules;
    expect(rowSuggestsScorer(entryRow('Timed Finals'), rules)).toBe(false);
    const lookup = buildScorerRosterLookup([entryRow('Timed Finals')], computed());
    expect(lookup.isScorer('Alpha (A)', 'Alpha', Gender.MEN)).toBe(false);
    expect(lookup.rows.filter(r => r.isScorer)).toEqual([]);
  });

  it('an A or B final entry row is untouched: it still marks a scorer, as before', () => {
    const rules = computed().scorerAutoRules;
    expect(rowSuggestsScorer(entryRow('A Final'), rules)).toBe(true);
    expect(rowSuggestsScorer(entryRow('B Final'), rules)).toBe(true);
  });

  it('the entry still scores in computed mode', () => {
    const scored = calculatePoints([entryRow('Timed Finals')], computed());
    expect(scored.reduce((a, r) => a + Number(r.points ?? 0), 0)).toBe(40);
  });
});

