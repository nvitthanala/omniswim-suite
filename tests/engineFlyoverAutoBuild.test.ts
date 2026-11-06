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
import { autoBuild, builtinRulePreset, entryKey, requireComplete, scoreMeet } from '@omniswim/engine';
import type { AutoBuildRequest, Lineup, LineupEntry, MeetModel, MeetSwim, RelaySplit, RulePreset, ScorerTag, SourcingSettings } from '@omniswim/engine';
import { nodeMipSolve } from './helpers/nodeMipSolve';
import { set } from './engineTestPresets';

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

// A split timed final with a fast heat of one: with two relays entered, the heats follow the seeds, so `sessionLoad` resolves every relay seed.
const LOAD: NonNullable<AutoBuildRequest['load']> = {
  schedule: {
    payloadVersion: 1,
    provenance: { kind: 'engine-neutral', reason: 'F1.3a test schedule' },
    events: [
      {
        eventKey: FREE_RELAY,
        gender: 'both',
        format: {
          kind: 'timed-final-split',
          slowHeats: { day: 1, slot: 'morning' },
          fastHeat: { day: 1, slot: 'evening' },
          fastHeatSize: set(1),
          smallFieldSession: set({ day: 1, slot: 'evening' }),
        },
      },
    ],
  },
  preference: { mode: 'respect', maxRacesPerSession: set(2), diving: set('counts' as const) },
};

const request = (sourcing: SourcingSettings, load: AutoBuildRequest['load'] = null): AutoBuildRequest => ({
  model,
  lineup,
  rules,
  sourcing,
  tags,
  ownTeamId: 'A',
  genders: ['Men'],
  objective: { kind: 'max-own' },
  load,
  limits: { candidatesPerEvent: 8, maxCandidatesPerEvent: 8, relaySquadsPerEvent: 12, maxRelaySquadsPerEvent: 24, refineRounds: 2, timeLimitSeconds: 60 },
});

describe('autoBuild with the flyover (F1.3a)', () => {
  it('a rival relay with a leg 1 flyover estimate is carried quietly: no throw, no refusal, the violation only in the results (D5 2.1)', async () => {
    const bad: Extract<LineupEntry, { kind: 'relay' }> = {
      kind: 'relay',
      teamId: 'B',
      eventKey: FREE_RELAY,
      gender: 'Men',
      letter: 'B',
      legs: rivals.map((id, i) => ({ swimmerId: id, basis: i === 0 ? { kind: 'flyover-estimate' as const, swimId: `${id}:${FREE}` } : { kind: 'split' as const, splitId: `split-${id}` } })) as unknown as Extract<LineupEntry, { kind: 'relay' }>['legs'],
    };
    const req: AutoBuildRequest = { ...request(SET_30), lineup: { ...lineup, entries: [...lineup.entries, bad] } };
    const result = await autoBuild(req, nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    const flagged = (v: { kind: string }) => v.kind === 'relay_leg' && (v as { reason?: string }).reason === 'basis_position' && (v as { leg?: number }).leg === 1;
    expect(result.current.results.violations.some(flagged)).toBe(true);
    expect(result.proposal.evaluation.results.violations.some(flagged)).toBe(true);
    expect(result.proposal.newWarnings.some(flagged)).toBe(false);
    const rows = result.proposal.evaluation.results.events.find((e) => e.eventKey === FREE_RELAY)!.rows;
    expect(rows.find((r) => r.entryKey === entryKey(bad))?.notScoredReason).toBe('no_time');
  }, 120_000);

  it('builds the same flyover relay with a session-load rule: the gate, the space and sessionLoad all value the leg (MEDIUM-1)', async () => {
    const without = await autoBuild(request(SET_30), nodeMipSolve());
    const withLoad = await autoBuild(request(SET_30, LOAD), nodeMipSolve());
    expect(without.kind).toBe('improved');
    expect(withLoad.kind).toBe('improved');
    if (without.kind !== 'improved' || withLoad.kind !== 'improved') return;
    const relays = withLoad.proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A');
    expect(relays.length).toBeGreaterThan(0);
    expect(withLoad.proof.bestFound).toBeCloseTo(without.proof.bestFound as number, 9);
  }, 120_000);

  it('an own relay of the built event with a leg 1 flyover estimate is replaced, and the violation leaves the proposal', async () => {
    const bad: Extract<LineupEntry, { kind: 'relay' }> = {
      kind: 'relay',
      teamId: 'A',
      eventKey: FREE_RELAY,
      gender: 'Men',
      letter: 'Z',
      legs: own.slice(0, 4).map((id) => ({ swimmerId: id, basis: { kind: 'flyover-estimate', swimId: `${id}:${FREE}` } })) as unknown as Extract<LineupEntry, { kind: 'relay' }>['legs'],
    };
    const result = await autoBuild({ ...request(SET_30), tags: [...tags, ...own.slice(0, 4).map((id) => ({ teamId: 'A', swimmerId: id, role: 'scorer' as const }))], lineup: { ...lineup, entries: [...lineup.entries, bad] } }, nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    expect(result.current.results.violations.some((v) => v.kind === 'relay_leg' && v.reason === 'basis_position' && v.leg === 1)).toBe(true);
    expect(result.proposal.lineup.entries.some((e) => entryKey(e) === entryKey(bad))).toBe(false);
    expect(result.proposal.evaluation.results.violations.some((v) => v.kind === 'relay_leg' && v.reason === 'basis_position')).toBe(false);
  }, 120_000);

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
