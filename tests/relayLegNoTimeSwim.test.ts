/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A swim with no time fills no relay leg (improvement plan 2026-10-10,
 * follow-up from the advisor review of 2026-10-13).
 *
 * ## Why this test exists
 *
 * `swimmerMatchesRelayLeg` read only the swim's event and its time-trial flag.
 * A disqualified swim (`time: 'DQ'`) of the leg's event matched, so the leg
 * candidate list offered it. The case the fixture models, which came up on a
 * real meet: a swimmer is `DQ` in the Event 25 100 Breast prelims, and she was listed for leg 1 (the 100
 * Breast) of the 4x100 medley relay, ranked last because `DQ` sorts as
 * `Infinity`. A name override on a swimmer with `DFS` resolved onto the swim
 * and put `NaN` in the relay clock.
 *
 * Synthetic rows: `tests/fixtures/nsisc-2026-dq-relay-leg.json` holds invented
 * swimmers ("Test Swimmer A1"), invented teams ("Test Team A") and invented
 * times in the shape of a parsed meet row (see its `_provenance`). It is not a
 * published result. A test that needs a shape the fixture does not hold says
 * so and names the rows it varies.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type RelayLegOverride,
  type SwimmerResult,
} from '../packages/core/src/types';
import { simulateRoster } from '../packages/core/src/lib/utils';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits';
import {
  hasRelayLegTime,
  listEligibleRelayLegCandidates,
  resolveOverrideAssignee,
  swimmerMatchesRelayLeg,
} from '../packages/core/src/lib/relayLegMatching';
import { relayLegHistoryCandidates } from '../packages/core/src/lib/relayLegHistoryCandidates';
import { historicalSwimFromResult } from '../packages/core/src/lib/athleteHistory';
import { workspaceFixture } from './helpers/typedFixtures';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-dq-relay-leg.json'), 'utf8')
) as { womenResults: SwimmerResult[] };
const womenResults = fixture.womenResults;

const DSU = 'Test Team A';
const HSU = 'Test Team B';
const W_400MR = 'Event 19 Women 4x100 Yard Medley Relay';
const W_400FR = 'Event 41 Women 4x100 Yard Freestyle Relay';
const BREAST_LEG = 1;
const FREE_LEG = 2;
const OFF = { relayLegsAllowTimeTrials: false, scoredEventNumberMax: 42 };
const ON = { relayLegsAllowTimeTrials: true, scoredEventNumberMax: 42 };

const row = (name: string, event: string, round?: string): SwimmerResult =>
  womenResults.find(
    r => !r.isRelay && r.name === name && r.event === event && (!round || r.roundSwam === round)
  ) as SwimmerResult;

const dqBreast = row('Test Swimmer A1', 'Event 25 Women 100 Yard Breaststroke');
const breastTimeTrial = row('Test Swimmer A1', 'Event 400 Women 100 Yard Breaststroke Time Trial');
const cloete = row('Test Swimmer A2', 'Event 25 Women 100 Yard Breaststroke');
const dqFree = row('Test Swimmer B1', 'Event 34 Women 100 Yard Freestyle');
const dfsFree = row('Test Swimmer B2', 'Event 34 Women 100 Yard Freestyle');

const individuals = womenResults.filter(r => !r.isRelay);

describe('the fixture rows say what the fixture is for', () => {
  it('Test Swimmer A1 is DQ with no other 100 Breast but a time trial', () => {
    expect(dqBreast.time).toBe('DQ');
    expect(breastTimeTrial.time).toBe('1:03.41R');
    expect(breastTimeTrial.isTimeTrial).toBe(true);
  });

  it('Test Swimmer B1 has a legal prelims time under a DQ clock; Test Swimmer B2 is DFS', () => {
    expect([dqFree.time, dqFree.prelimsTime]).toStrictEqual(['DQ', '57.42']);
    expect(dfsFree.time).toBe('DFS');
  });
});

describe('hasRelayLegTime', () => {
  it('is false for every code that is not a time', () => {
    for (const time of ['DQ', 'DFS', 'SCR', 'NS', 'NT', 'DNF', 'DNS', 'DSQ', '', '   ', 'N/A', '---', '0.00']) {
      expect(hasRelayLegTime({ time }), JSON.stringify(time)).toBe(false);
    }
  });

  it('is true for a finished swim, with or without a record flag', () => {
    for (const time of ['22.04', '1:03.41R', '1:40.07', '16:12.50']) {
      expect(hasRelayLegTime({ time }), time).toBe(true);
    }
  });

  it('reads the row clock, not the prelims clock', () => {
    expect(hasRelayLegTime(dqFree)).toBe(false);
  });
});

describe('a swim with no time matches no leg', () => {
  it('the DQ row is the leg event and still matches no leg, with the time-trial setting on or off', () => {
    expect(swimmerMatchesRelayLeg(dqBreast, W_400MR, BREAST_LEG, OFF)).toBe(false);
    expect(swimmerMatchesRelayLeg(dqBreast, W_400MR, BREAST_LEG, ON)).toBe(false);
    expect(swimmerMatchesRelayLeg(cloete, W_400MR, BREAST_LEG, OFF)).toBe(true);
  });

  it('the candidate list for the breast leg leaves out the DQ, setting off', () => {
    const list = listEligibleRelayLegCandidates(individuals, W_400MR, BREAST_LEG, new Set(), DSU, undefined, OFF);
    expect(list.map(s => `${s.name} ${s.time}`)).toStrictEqual([
      'Test Swimmer A2 1:04.27',
      'Test Swimmer A3 1:05.58',
      'Test Swimmer A4 1:06.30',
    ]);
  });

  it('with the setting on, Test Swimmer A1 is offered by her time trial, never by the DQ', () => {
    const list = listEligibleRelayLegCandidates(individuals, W_400MR, BREAST_LEG, new Set(), DSU, undefined, ON);
    expect(list.map(s => `${s.name} ${s.time}`)).toStrictEqual([
      'Test Swimmer A1 1:03.41R',
      'Test Swimmer A2 1:04.27',
      'Test Swimmer A3 1:05.58',
      'Test Swimmer A2 1:06.02',
      'Test Swimmer A4 1:06.30',
    ]);
    expect(list[0]!.relayLegTimeTrial).toBe(true);
    expect(list.some(s => s.time === 'DQ')).toBe(false);
  });

  it('a DQ clock over a legal prelims time is a DQ, and a DFS is not a candidate (Test Team B 100 Free)', () => {
    for (const settings of [OFF, ON]) {
      const list = listEligibleRelayLegCandidates(individuals, W_400FR, FREE_LEG, new Set(), HSU, undefined, settings);
      expect(list).toStrictEqual([]);
    }
  });
});

describe('an override cannot fill a leg with a swim that has no time', () => {
  const entryKeyOf = (event: string, team: string, round: string): string => {
    const leg = womenResults.find(r => r.isRelay && r.event === event && r.team === team && r.roundSwam === round)!;
    return relayEntryKey(leg);
  };
  const FREE_A_KEY = entryKeyOf(W_400FR, HSU, 'A Final');
  const MEDLEY_A_KEY = entryKeyOf(W_400MR, DSU, 'A Final');

  const legOf = (
    event: string,
    team: string,
    round: string,
    legIndex: number,
    overrides: RelayLegOverride[],
    leaving: string
  ): SwimmerResult =>
    simulateRoster(womenResults, [], false, new Set([leaving]), overrides, undefined, undefined, OFF).find(
      r => r.isRelay === true && r.team === team && r.event === event && r.roundSwam === round && r.relayLegIndex === legIndex
    ) as SwimmerResult;

  const freeLeg = (o: Partial<RelayLegOverride>): SwimmerResult =>
    legOf(W_400FR, HSU, 'A Final', FREE_LEG, [
      { relayEntryKey: FREE_A_KEY, legIndex: FREE_LEG, source: 'manual', ...o },
    ], 'test swimmer b5');

  it('by name: a DFS swimmer leaves the leg vacant, and the relay clock stays a time', () => {
    const leg = freeLeg({ assigneeName: 'Test Swimmer B2' });
    expect(leg.relayLegVacant).toBe(true);
    expect(leg.relayMissingLeg?.reason).toBe('vacant');
    expect(leg.relayTeamTime).toMatch(/^\d+:\d\d\.\d\d$/);
  });

  it('by name: a swimmer DQ at the leg event leaves the leg vacant', () => {
    const leg = freeLeg({ assigneeName: 'Test Swimmer B1' });
    expect(leg.relayLegVacant).toBe(true);
    expect(leg.relayMissingLeg?.reason).toBe('vacant');
  });

  it('by recruit id: the DQ row itself is not a swimmer for the leg', () => {
    const leg = freeLeg({ recruitId: dqFree.id });
    expect(leg.relayLegVacant).toBe(true);
    expect(leg.relayMissingLeg?.reason).toBe('vacant');
    expect(
      resolveOverrideAssignee(
        { relayEntryKey: FREE_A_KEY, legIndex: FREE_LEG, source: 'manual', recruitId: dqFree.id },
        individuals,
        HSU,
        W_400FR,
        FREE_LEG,
        Gender.WOMEN,
        OFF
      )
    ).toBeNull();
  });

  it('a swimmer with a time at the leg event still fills it (Test Swimmer A2, 1:04.27)', () => {
    const leg = legOf(
      W_400MR,
      DSU,
      'A Final',
      BREAST_LEG,
      [{ relayEntryKey: MEDLEY_A_KEY, legIndex: BREAST_LEG, source: 'manual', assigneeName: 'Test Swimmer A2' }],
      'test swimmer a3'
    );
    expect(leg.relayLegVacant).toBeFalsy();
    expect(leg.name).toBe('Test Swimmer A2');
  });

  it('Test Swimmer A1 by name resolves onto her time trial only when the setting is on', () => {
    const named: RelayLegOverride = {
      relayEntryKey: MEDLEY_A_KEY,
      legIndex: BREAST_LEG,
      source: 'manual',
      assigneeName: 'Test Swimmer A1',
    };
    const off = resolveOverrideAssignee(named, individuals, DSU, W_400MR, BREAST_LEG, Gender.WOMEN, OFF);
    expect(off).toBeNull();
    const on = resolveOverrideAssignee(named, individuals, DSU, W_400MR, BREAST_LEG, Gender.WOMEN, ON);
    expect(on?.time).toBe('1:03.41R');
    expect(on?.relayLegTimeTrial).toBe(true);
  });
});

describe('a row with no time hides no history swim (history rule 3)', () => {
  // Test Swimmer B1's prelims 100 Free (57.42), as a loaded meet stores
  // it in history: `historicalSwimFromResult`, the Vitor Sa precedent of R1.
  const prelim = historicalSwimFromResult(
    { ...dqFree, time: dqFree.prelimsTime as string },
    'NSISC 2026 prelims'
  )!;
  const workspace = workspaceFixture({ womenResults, athleteHistory: [prelim] });
  const hsuPool = individuals.filter(r => r.team === HSU);

  it('the DQ row at the 100 Free does not count as her swim there', () => {
    const out = relayLegHistoryCandidates(workspace, hsuPool, Gender.WOMEN);
    const fills = out.filter(r => r.name === 'Test Swimmer B1');
    expect(fills.map(r => [r.event, r.time])).toStrictEqual([['100 Freestyle', '57.42']]);
  });

  it('a row with a time still hides it: her meet 100 Fly is not replaced by her faster prelims swim', () => {
    const fly = row('Test Swimmer B1', 'Event 12 Women 100 Yard Butterfly');
    expect([fly.time, fly.prelimsTime]).toStrictEqual(['1:03.08', '1:02.44']);
    const prelimFly = historicalSwimFromResult({ ...fly, time: fly.prelimsTime as string }, 'NSISC 2026 prelims')!;
    const ws = workspaceFixture({ womenResults, athleteHistory: [prelimFly] });
    const out = relayLegHistoryCandidates(ws, hsuPool, Gender.WOMEN);
    expect(out.filter(r => r.name === 'Test Swimmer B1')).toStrictEqual([]);
  });
});
