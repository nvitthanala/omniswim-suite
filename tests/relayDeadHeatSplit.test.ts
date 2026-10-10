/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A relay dead heat divides the tied places' points, the same as an individual
 * one (NCAA Rule 7-8).
 *
 * KNOWN DEFECT, found 2026-10-01 by the bug-hunter pass. The `it.fails` cases
 * assert the correct behaviour and currently fail. When the defect is fixed,
 * vitest reports them as failing ("expected to fail") — change `it.fails` to
 * `it` at that point.
 *
 * What goes wrong. `scoreRelaysInEvent` (utils.ts) keys a relay entry by
 * event|team|round|rank|clock, so two teams tied for a place are two groups,
 * and each group takes the FULL value of that place from
 * `relayTeamPointsForIndex`. Two relays tied for 2nd under a 16-place
 * championship table each score 34 (2nd place) instead of 33 ((34 + 32) / 2).
 * The event pays out 2 points more than its table holds. Individual events do
 * split (`resolveIndividualGroupLadderShare`); relays never do.
 *
 * The second derivation is the repo's own Rule 7-8 model,
 * `computeNcaaEventScoring` (ncaaScoringRules.ts), fed the same field. The
 * relay rows are synthetic. The real 2026 NSISC results hold no relay dead
 * heat, so this is latent on stored data, not on a meet that has one.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult } from '../packages/core/src/types';
import { calculatePoints } from '../packages/core/src/lib/utils';
import {
  NSISC_PRESET_SETTINGS,
  settingsForBuiltInScoringPreset,
} from '../packages/core/src/lib/scoringDefaults';
import { computeNcaaEventScoring } from '../packages/core/src/lib/ncaaScoringRules';

const EVENT = 'Event 2 Men 200 Yard Freestyle Relay';

/** One relay entry as four leg rows, the way the HyTek parser stores it. */
function relayEntry(team: string, rank: number, clock: string): SwimmerResult[] {
  const legs = [0, 1, 2, 3].map(i => `${team} Leg ${i + 1}`);
  return legs.map((name, i) => ({
    id: `${team}-${i}`,
    rank,
    name,
    classYear: 'JR',
    team,
    time: clock,
    finalsTime: clock,
    relayTeamTime: clock,
    roundSwam: 'A Final',
    points: 0,
    event: EVENT,
    gender: Gender.MEN,
    isRelay: true,
    relayLegIndex: i,
    relayNames: legs.map(n => ({ name: n, year: 'JR' })),
  })) as SwimmerResult[];
}

type Field = Array<{ team: string; rank: number; clock: string }>;

function engineTeamPoints(field: Field, settings: ScoringSettings): Record<string, number> {
  const rows = field.flatMap(f => relayEntry(f.team, f.rank, f.clock));
  const out: Record<string, number> = {};
  for (const r of calculatePoints(rows, settings)) out[r.team] = (out[r.team] ?? 0) + Number(r.points ?? 0);
  return out;
}

function rule7TeamPoints(field: Field): Record<string, number> {
  const scored = computeNcaaEventScoring(
    'championship-16',
    'relay',
    field.map(f => ({ id: f.team, team: f.team, finishRank: f.rank, final: 'championship' as const }))
  );
  return Object.fromEntries(scored.teamTotals.map(t => [t.team, t.points]));
}

const NO_TIE: Field = [
  { team: 'Alpha', rank: 1, clock: '1:20.00' },
  { team: 'Bravo', rank: 2, clock: '1:21.00' },
  { team: 'Charlie', rank: 3, clock: '1:21.50' },
  { team: 'Delta', rank: 4, clock: '1:22.00' },
];

const TIE_FOR_SECOND: Field = [
  { team: 'Alpha', rank: 1, clock: '1:20.00' },
  { team: 'Bravo', rank: 2, clock: '1:21.00' },
  { team: 'Charlie', rank: 2, clock: '1:21.00' },
  { team: 'Delta', rank: 4, clock: '1:22.00' },
];

const PRESETS: Array<[string, ScoringSettings]> = [
  ['NSISC (16 places, relay multiplier 2)', NSISC_PRESET_SETTINGS],
  ['ncaa-championship-16 (explicit relay table)', settingsForBuiltInScoringPreset('ncaa-championship-16')],
];

describe.each(PRESETS)('relay places under %s', (_label, settings) => {
  it('a field with no tie scores exactly as Rule 7 tables it (control)', () => {
    expect(engineTeamPoints(NO_TIE, settings)).toEqual(rule7TeamPoints(NO_TIE));
  });

  it.fails('KNOWN DEFECT: two relays tied for 2nd split the 2nd and 3rd place points (Rule 7-8)', () => {
    expect(engineTeamPoints(TIE_FOR_SECOND, settings)).toEqual(rule7TeamPoints(TIE_FOR_SECOND));
  });
});
