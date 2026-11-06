/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.3a end to end: `autoBuild` with the flyover (plans/2026-10-25/D7-DATA-SOURCING.md section 5). The squads,
 * the gate and the explanations all read relay legs, so one full run proves a flyover-estimate leg
 * survives them. The fixture is synthetic: no time, point value or standard here is a competition value.
 * This file stays out of `tests/fixtures/lp-baseline`: a new `buildLp` call there would move that baseline.
 */
import { describe, expect, it } from 'vitest';
import { autoBuild, builtinRulePreset, requireComplete, scoreMeet } from '@omniswim/engine';
import type { AutoBuildRequest, Lineup, LineupEntry, MeetModel, MeetSwim, RelaySplit, RulePreset, ScorerTag, SourcingSettings } from '@omniswim/engine';
import { nodeMipSolve } from './helpers/nodeMipSolve';

const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic F1.3a' } as const;
const FREE = '100 Freestyle';
const FREE_RELAY = '400 Freestyle Relay';
const UNSET: SourcingSettings = { includeConvertedSwims: false, lcmToScy: null, flyover: { state: 'unset' } };
const SET_30: SourcingSettings = { ...UNSET, flyover: { state: 'set', hundredths: 30 } };

const swim = (id: string, hundredths: number): MeetSwim => ({
  swimId: `${id}:${FREE}`,
  swimmerId: id,
  eventKey: FREE,
  recordedCourse: 'SCY',
  recordedTime: { text: (hundredths / 100).toFixed(2), hundredths },
  date: null,
  seasonId: null,
  flags: {},
  scy: { kind: 'recorded-scy' },
  origin: ORIGIN,
});
const split = (id: string, hundredths: number): RelaySplit => ({
  splitId: `split-${id}`,
  swimmerId: id,
  relayEventKey: null,
  legPosition: null,
  start: 'flying',
  legEventKey: FREE,
  split: { text: (hundredths / 100).toFixed(2), hundredths },
  course: 'SCY',
  date: null,
  origin: ORIGIN,
});

// Team A has a flat 100 free per swimmer and no relay split. Team B has both and one entered relay.
const own = ['o1', 'o2', 'o3', 'o4', 'o5'];
const rivals = ['b1', 'b2', 'b3', 'b4'];
const model: MeetModel = {
  payloadVersion: 1,
  meetKey: 'synthetic F1.3a',
  teams: ['A', 'B'].map((teamId) => ({ teamId, division: { state: 'unknown', reason: 'unmapped_team' } })),
  swimmers: [...own.map((id) => ({ id, teamId: 'A' })), ...rivals.map((id) => ({ id, teamId: 'B' }))].map((s) => ({
    swimmerId: s.id,
    teamId: s.teamId,
    gender: 'Men' as const,
    classYear: null,
    roster: 'member' as const,
  })),
  events: [{ eventKey: FREE_RELAY, gender: 'Men', kind: 'relay', distanceYards: 400, relayKind: 'freestyle' }],
  swims: [...own.map((id, i) => swim(id, 5000 + i * 10)), ...rivals.map((id, i) => swim(id, 5600 + i * 10))],
  relaySplits: rivals.map((id, i) => split(id, 5400 + i * 10)),
  recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
  extendedWindow: false,
  observedScores: null,
};
const lineup: Lineup = {
  payloadVersion: 1,
  meetKey: 'synthetic F1.3a',
  entries: [
    {
      kind: 'relay',
      teamId: 'B',
      eventKey: FREE_RELAY,
      gender: 'Men',
      letter: 'A',
      legs: rivals.map((id, i) => ({ swimmerId: id, basis: i === 0 ? { kind: 'flat-start-swim' as const, swimId: `${id}:${FREE}` } : { kind: 'split' as const, splitId: `split-${id}` } })) as unknown as Extract<LineupEntry, { kind: 'relay' }>['legs'],
    },
  ],
};
const tags: ScorerTag[] = rivals.map((id) => ({ teamId: 'B', swimmerId: id, role: 'scorer' }));
const rules = requireComplete(builtinRulePreset('nsisc', 4) as RulePreset);

const request = (sourcing: SourcingSettings): AutoBuildRequest => ({
  model,
  lineup,
  rules,
  sourcing,
  tags,
  ownTeamId: 'A',
  genders: ['Men'],
  objective: { kind: 'max-own' },
  load: null,
  limits: { candidatesPerEvent: 8, maxCandidatesPerEvent: 8, relaySquadsPerEvent: 12, maxRelaySquadsPerEvent: 24, refineRounds: 2, timeLimitSeconds: 60 },
});

describe('autoBuild with the flyover (F1.3a)', () => {
  it('builds no relay from swimmers with no flying split while the flyover is unset', async () => {
    const result = await autoBuild(request(UNSET), nodeMipSolve());
    expect(result.kind).not.toBe('improved');
  }, 120_000);

  it('builds a relay with flyover-estimate legs once it is set, and the proposal scores to what the search proved', async () => {
    const result = await autoBuild(request(SET_30), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    const relays = result.proposal.lineup.entries.filter((e): e is Extract<LineupEntry, { kind: 'relay' }> => e.kind === 'relay' && e.teamId === 'A');
    expect(relays.length).toBeGreaterThan(0);
    for (const relay of relays) {
      expect(relay.legs[0].basis.kind).toBe('flat-start-swim');
      expect(relay.legs.slice(1).map((l) => l.basis.kind)).toEqual(['flyover-estimate', 'flyover-estimate', 'flyover-estimate']);
    }
    const results = scoreMeet(model, result.proposal.lineup, result.proposal.tagsForScoring, rules, SET_30);
    expect((results.teams.find((t) => t.teamId === 'A') as { points: number }).points).toBeCloseTo(result.proof.bestFound as number, 9);
    expect(results.violations.filter((v) => v.kind === 'relay_leg' && v.reason !== 'off_scoring_roster')).toEqual([]);
    // The same proposal under an unset flyover has no relay time at all: the setting, not the data, makes the points.
    const unset = scoreMeet(model, result.proposal.lineup, result.proposal.tagsForScoring, rules, UNSET);
    expect((unset.teams.find((t) => t.teamId === 'A') as { points: number }).points).toBe(0);
  }, 120_000);
});
