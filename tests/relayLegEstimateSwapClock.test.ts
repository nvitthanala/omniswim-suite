/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The relay swap holds the departed leg's clock the same way for three kinds of leg row (A7):
 *
 *   - `split`: a measured `relayLegSplit` on a real meet's row;
 *   - `legacy`: a theoretical meet's row saved before the estimate field, time in `relayLegSplit`;
 *   - `estimate`: a theoretical meet's row now, time in `relayLegEstimate`, no `relayLegSplit`.
 *
 * REAL data: the Henderson State 4x100 Free Relay (place 1) of the 2026 NSISC Championships, from
 * tests/fixtures/nsisc-2026-relay-followups-r1.json. Scott Doll's individual 100 Free is removed so the
 * clock cannot come from his individual swim and must come from the leg row. Remove the fallback in
 * `resolveClockHoldTime` and the `estimate` case loses its clock, so this file fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gender } from '../packages/core/src/types';
import type { SwimmerResult, Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { applyRelayLegSwap, rankRelayLegSwaps } from '../packages/core/src/lib/arbitrage/relayLegSwaps';
import { convertTimeToSeconds, normalizeSwimmerName, simulateRoster } from '../packages/core/src/lib/utils';
import { workspaceFixture } from './helpers/typedFixtures';

const HSU = 'Henderson State University';
const EVENT = 'Event 42 Men 4x100 Yard Freestyle Relay';
const OUT = 'Scott Doll';
const STRICT = {
  ...NSISC_PRESET_SETTINGS,
  scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules, includeRelayLegsInFinals: false },
};

type Row = SwimmerResult & Record<string, unknown>;
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')) as {
  menResults: Row[];
  womenResults: Row[];
};

const isTarget = (r: Row): boolean => r.isRelay === true && r.team === HSU && r.event === EVENT && r.rank === 1;
const withoutOutsIndividual100 = fixture.menResults.filter(r => !(r.isRelay !== true && r.name === OUT && /100 Yard Free/.test(r.event)));

function variant(kind: 'split' | 'legacy' | 'estimate'): Row[] {
  return withoutOutsIndividual100.map(r => {
    if (!isTarget(r)) return r;
    const { relayLegSplitDetail: _d, relayTeamSplits: _t, relayLegSplit, ...rest } = r;
    void _d;
    void _t;
    if (kind === 'split') return { ...rest, relayLegSplit } as Row;
    const id = `tmresrelay|ws-a7|Men|HSU|${EVENT}|leg${(r.relayLegIndex ?? 0) + 1}`;
    if (kind === 'legacy') return { ...rest, id, relayLegSplit } as Row;
    return { ...rest, id, relayLegEstimate: { time: convertTimeToSeconds(relayLegSplit as string), basis: 'best time' } } as Row;
  });
}

function workspaceOf(kind: 'split' | 'legacy' | 'estimate'): Workspace {
  return workspaceFixture({
    id: 'w',
    name: 'w',
    createdAt: 0,
    menResults: variant(kind),
    womenResults: fixture.womenResults,
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    conference: 'NSISC',
    scoringSettings: STRICT,
    scorerRosterOverrides: [{ name: OUT, team: HSU, gender: Gender.MEN, isScorer: false }],
  });
}

function swapsOf(kind: 'split' | 'legacy' | 'estimate') {
  const ws = workspaceOf(kind);
  const ranking = rankRelayLegSwaps(ws, { team: HSU, gender: Gender.MEN, settings: STRICT });
  const swaps = ranking.swaps.filter(s => s.relayEvent === EVENT);
  const first = swaps[0];
  expect(first, `${kind}: the target relay has a swap for the removed swimmer`).toBeDefined();
  // Enact the first swap and read the relay's team time back from the simulation.
  const { patch } = applyRelayLegSwap(ws, first!, { team: HSU, gender: Gender.MEN });
  const after = simulateRoster(
    ws.menResults,
    [],
    false,
    new Set(),
    patch.relayLegOverrides ?? [],
    new Set([normalizeSwimmerName(OUT)])
  );
  const teamTimes = [...new Set(after.filter(r => r.isRelay && r.team === HSU && r.event === EVENT && r.rank === 1).map(r => r.relayTeamTime))];
  return {
    swaps: swaps.map(s => ({
      leg: s.legIndex,
      out: s.outAthlete,
      outTime: s.outTime,
      in: s.inAthlete,
      clock: s.clockLegTime,
      delta: s.deltaPoints,
      newTotal: s.newTotal,
      baseTotal: s.baseTotal,
    })),
    outTimeEstimate: first!.outTimeEstimate,
    teamTimes,
  };
}

describe('relay swap clock for a measured split, a legacy theoretical row and an estimate row', () => {
  const split = swapsOf('split');
  const legacy = swapsOf('legacy');
  const estimate = swapsOf('estimate');

  it('has a real swap to compare (the measured case holds the departed leg clock)', () => {
    expect(split.swaps.length).toBeGreaterThan(0);
    expect(split.swaps[0]!.out).toBe(OUT);
    expect(split.swaps[0]!.clock).toBe('49.05');
    expect(split.swaps[0]!.delta).toBeGreaterThan(0);
    expect(split.outTimeEstimate).toBeUndefined();
  });

  it('gives the same swaps, clock, delta and totals for the legacy row as for the measured split', () => {
    expect(legacy.swaps).toEqual(split.swaps);
  });

  it('gives the same swaps, clock, delta and totals for the estimate row, from the estimate alone', () => {
    expect(estimate.swaps).toEqual(split.swaps);
    expect(estimate.swaps[0]!.clock).toBe('49.05');
  });

  it('re-scores to the same relay team time', () => {
    expect(split.teamTimes).toHaveLength(1);
    expect(estimate.teamTimes).toEqual(split.teamTimes);
    expect(legacy.teamTimes).toEqual(split.teamTimes);
  });

  it('labels the outgoing time as an estimate on a theoretical row only', () => {
    expect(estimate.outTimeEstimate).toBe(true);
    expect(legacy.outTimeEstimate).toBe(true);
  });
});
